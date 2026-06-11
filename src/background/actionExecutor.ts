import { pushLog } from '../shared/logger';
import { broadcastStatusSnapshot } from '../shared/messageRouter';
import { getStorage, setLastAction, updateStorage } from '../shared/storageManager';
import type {
  ActionInstruction,
  ActionResult,
  ContentToBackgroundActionResultMessage,
  ContentToBackgroundElementRectResultMessage,
  PageSnapshot
} from '../shared/types';
import { collectSnapshotFromActiveTab } from './contentBridge';
import { executeToolInstruction } from './toolExecutor';

/**
 * 페이지 이동 후 사람처럼 보이도록 1,000ms ~ 3,000ms 사이 랜덤 대기.
 * 봇 감지 우회 목적.
 */
function randomNavigationDelay(): Promise<void> {
  const ms = 1000 + Math.random() * 2000;
  console.info(`[actionExecutor] 페이지 이동 후 랜덤 대기 ${Math.round(ms)}ms`);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * CDP(Chrome DevTools Protocol)로 사람처럼 마우스 클릭을 시뮬레이션한다.
 *
 * chrome.debugger를 사용하므로 진짜 OS 레벨 입력으로 인식된다.
 * → User Activation 토큰 발급 → window.open(), target="_blank" 등 정상 동작
 * 단, 디버거 연결 중 브라우저에 잠깐 배너가 표시된다.
 */
async function cdpHumanizedClick(tabId: number, x: number, y: number): Promise<void> {
  await chrome.debugger.attach({ tabId }, '1.3');
  console.info(`[actionExecutor] CDP 클릭 시작 - tabId=${tabId}, x=${x}, y=${y}`);

  try {
    const moveEvent = { type: 'mouseMoved', x, y, modifiers: 0, button: 'none', buttons: 0, clickCount: 0 };
    const pressEvent = { type: 'mousePressed', x, y, modifiers: 0, button: 'left', buttons: 1, clickCount: 1 };
    const releaseEvent = { type: 'mouseReleased', x, y, modifiers: 0, button: 'left', buttons: 0, clickCount: 1 };

    // 마우스 이동 (hover)
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', moveEvent);
    // hover 대기 (사람 반응 속도: 1.5~3초)
    await new Promise((resolve) => setTimeout(resolve, 1500 + Math.random() * 1500));
    // 클릭 다운
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', pressEvent);
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 80));
    // 클릭 업
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', releaseEvent);
  } finally {
    // 클릭 직후 바로 detach → 배너 최소화
    await chrome.debugger.detach({ tabId });
    console.info(`[actionExecutor] CDP 클릭 완료, 디버거 분리`);
  }
}

/**
 * Naver Shopping 도메인에서 동작 중인 탭인지 확인한다.
 */
async function isNaverShoppingTab(tabId: number): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url ?? '';
    return url.includes('search.shopping.naver.com');
  } catch {
    return false;
  }
}

/**
 * URL에서 `query` 파라미터를 추출한다.
 * query가 없거나 비어있거나 공백만 있으면 null 반환.
 */
function extractValidQueryParam(url: string): string | null {
  try {
    const query = new URL(url).searchParams.get('query');
    return query && query.trim() ? query.trim() : null;
  } catch {
    return null;
  }
}

/**
 * INPUT 후 URL 변경이 실제 검색 성공을 의미하는지 확인한다.
 *
 * - Naver Shopping: query 파라미터가 실제로 채워져 있고 의도한 검색어와 대략 일치해야 성공
 * - 그 외 사이트: URL 변경만으로 성공 (기존 동작 유지, regressions 방지)
 *
 * @returns true면 유효한 검색 URL로 인정하여 SUCCESS 처리
 */
async function isSearchNavigationSuccess(
  tabId: number,
  urlBefore: string,
  urlAfter: string,
  intendedQuery: string
): Promise<boolean> {
  if (urlAfter === urlBefore) return false;

  // ── Naver Shopping: 엄격 검증 ──
  if (await isNaverShoppingTab(tabId)) {
    const actualQuery = extractValidQueryParam(urlAfter);
    if (!actualQuery) {
      console.warn('[actionExecutor] [nav-query] URL 변경됐으나 query 파라미터 비어있음 → 성X, 폴백 필요', {
        urlAfter,
        intended: intendedQuery
      });
      return false;
    }

    // 대략 일치 여부 확인 (Naver가 검색어를 일부 변환할 수 있으므로 느슨하게)
    const normActual = actualQuery.toLowerCase();
    const normIntended = intendedQuery.trim().toLowerCase();

    if (normIntended.length >= 3 &&
        normActual !== normIntended &&
        !normActual.includes(normIntended) &&
        !normIntended.includes(normActual)) {
      console.warn('[actionExecutor] [nav-query] query가 의도 검색어와 전혀 다름 → 성X, 폴백 필요', {
        intended: intendedQuery,
        actual: actualQuery
      });
      return false;
    }

    console.info('[actionExecutor] [nav-query] query 파라미터 유효 → 성공', {
      query: actualQuery,
      intended: intendedQuery
    });
    return true;
  }

  // ── Non-Naver: URL 변경만으로 성공 (기존 동작 유지) ──
  return true;
}

/**
 * CDP로 검색어 입력 + Enter 전송을 수행한다.
 *
 * React controlled input은 DOM .value만 바꿔서는 내부 state가 갱신되지 않으므로,
 * nativeInputValueSetter + input/change 이벤트 dispatch로 React onChange를 강제 트리거한다.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cdpTypeTextAndEnter(tabId: number, text: string): Promise<void> {
  console.info(`[actionExecutor] [cdp-type] CDP 입력 + Enter 시작 - tabId=${tabId}, text="${text}"`);
  await chrome.debugger.attach({ tabId }, '1.3');
  try {
    // ── 0단계: attach 후 포커스 복원 ──
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: `(function() {
          const selectors = [
            'input[name="query"]', 'input[type="search"]',
            'input._searchInput_search_text', 'input[class*="search_text"]',
            'input.input_text', 'input[placeholder*="검색"]'
          ];
          for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) { el.focus(); return sel; }
          }
          return null;
        })()`,
        returnByValue: true
      });
      await sleep(100);
    } catch { /* ignore */ }

    // ── 1단계: 기존 텍스트 비우기 ──
    // 검색창이 이전 검색어를 들고 있을 수 있으므로 먼저 clear 한 뒤 한 글자씩 타이핑한다.
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `(function() {
        const selectors = [
          'input[name="query"]', 'input[type="search"]',
          'input._searchInput_search_text', 'input[class*="search_text"]',
          'input.input_text', 'input[placeholder*="검색"]'
        ];
        let input = null;
        for (const sel of selectors) {
          input = document.querySelector(sel);
          if (input) break;
        }
        if (!input) return { ok: false, reason: 'input not found' };

        // React 내부 state를 갱신하는 핵심 트릭:
        // HTMLInputElement.prototype.value의 native setter를 직접 호출하면
        // React의 input tracking이 "값이 바뀌었다"고 인식한다.
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        )?.set;
        if (nativeSetter) {
          nativeSetter.call(input, '');
        } else {
          input.value = '';
        }

        // input + change 이벤트를 bubbling으로 dispatch → React synthetic onChange 트리거
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));

        return { ok: true, value: input.value, cleared: true };
      })()`,
      returnByValue: true
    });
    await sleep(150);

    // ── 2단계: 한 번에 전체 문자열 입력 ──
    // Naver 검색창은 글자 단위 입력보다 전체 문자열을 한 번에 넣는 쪽이
    // controlled state / submit 타이밍이 더 안정적이다.
    await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text });
    await sleep(200);

    // ── 2.5단계: React state 강제 동기화 + input 재포커스 ──
    // Input.insertText는 DOM value를 변경하지만 React _valueTracker가 갱신되지 않아
    // React state가 빈 문자열로 남을 수 있다 ("검색어를 입력하세요" 팝업 원인).
    // native setter로 현재 값을 다시 설정해 React의 onChange를 트리거한다.
    try {
      const syncResult = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: `(function() {
          var selectors = [
            'input[name="query"]', 'input[type="search"]',
            'input._searchInput_search_text', 'input[class*="search_text"]',
            'input.input_text', 'input[placeholder*="검색"]'
          ];
          var input = null;
          for (var i = 0; i < selectors.length; i++) {
            input = document.querySelector(selectors[i]);
            if (input) break;
          }
          if (!input) return JSON.stringify({ ok: false, reason: 'input not found' });

          var currentValue = input.value;
          var nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          );
          if (nativeSetter && nativeSetter.set) {
            nativeSetter.set.call(input, currentValue);
          }
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));

          // Enter 키 수신을 위해 input에 포커스 확보
          input.focus();
          return JSON.stringify({ ok: true, syncedValue: currentValue });
        })()`,
        returnByValue: true
      });
      const resultValue = (syncResult as { result?: { value?: string } })?.result?.value;
      console.info('[actionExecutor] [cdp-type] React 동기화 결과:', resultValue);
    } catch (syncErr) {
      console.warn('[actionExecutor] [cdp-type] React 동기화 실패 (무시):', syncErr);
    }

    await sleep(150);

    // ── 3단계: CDP Enter 키로 검색 제출 (isTrusted=true) ──
    // React state가 동기화된 상태이므로 Enter 키만으로 정상 검색이 실행된다.
    console.info('[actionExecutor] [cdp-type] CDP Enter 키로 검색 제출');
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Enter', code: 'Enter',
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      text: '\r', unmodifiedText: '\r', modifiers: 0
    });
    await sleep(30);
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'char', key: 'Enter', code: 'Enter',
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      text: '\r', unmodifiedText: '\r', modifiers: 0
    });
    await sleep(30);
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Enter', code: 'Enter',
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 0
    });

    // 검색 네비게이션 시작 대기
    await sleep(700);
  } finally {
    await chrome.debugger.detach({ tabId });
    console.info('[actionExecutor] [cdp-type] CDP 입력 + Enter 완료');
  }
}

/**
 * content script에 요소 좌표를 요청한다.
 * 요소를 찾지 못하면 null 반환.
 */
async function getElementRect(
  tabId: number,
  instruction: ActionInstruction
): Promise<{ x: number; y: number } | null> {
  const response = (await chrome.tabs.sendMessage(tabId, {
    type: 'GET_ELEMENT_RECT',
    payload: { instruction }
  })) as ContentToBackgroundElementRectResultMessage;

  if (!response.payload.ok) {
    return null;
  }

  return { x: response.payload.x, y: response.payload.y };
}

/**
 * NAVIGATE 후 탭 로드 완료를 기다린다.
 * window.location.href 는 즉시 반환되므로 새 페이지 로드를 기다리지 않으면
 * 구 페이지 스냅샷을 수집해 서버에 보내고 무한루프가 발생한다.
 */
async function waitForTabLoad(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(); // 타임아웃 시 그냥 진행
    }, timeoutMs);

    function listener(updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

export async function executeInstructionInTab(instruction: ActionInstruction): Promise<ActionResult> {
  const storage = await getStorage();

  if (instruction.action === 'USE_TOOL') {
    const toolResult = await executeToolInstruction(instruction);
    const snapshot: PageSnapshot = await collectSnapshotFromActiveTab();

    const result: ActionResult = {
      runId: storage.activeRunId ?? 'unknown-run',
      stepIndex: instruction.stepIndex,
      actionId: instruction.actionId,
      action: instruction.action,
      status: toolResult.success ? 'SUCCESS' : 'FAILURE',
      toolResult,
      snapshot,
      completedAt: new Date().toISOString()
    };

    await setLastAction({
      type: result.action,
      stepIndex: result.stepIndex,
      at: result.completedAt,
      result: result.status
    });

    await broadcastStatusSnapshot();
    return result;
  }

  if (!storage.targetTabId || !storage.activeRunId) {
    throw new Error('실행할 active run 또는 targetTabId 가 없음');
  }

  let response: ContentToBackgroundActionResultMessage | null = null;
  let navigationTriggeredByAction = false;
  let newTabId: number | null = null;
  let snapshotBeforeClick: PageSnapshot | null = null;

  // ─────────────────────────────────────────────
  // CLICK: CDP(chrome.debugger)로 처리
  // → OS 레벨 마우스 이벤트 → User Activation 발급
  // → window.open(), target="_blank" 등 정상 동작
  // ─────────────────────────────────────────────
  // ─────────────────────────────────────────────
  // adcr URL NAVIGATE: 직접 이동 대신 해당 <a> 요소를 CDP로 클릭
  // window.location.href나 chrome.tabs.update로 adcr URL에 접근하면
  // 네이버 서버가 세션/referer 검증 실패로 shopping home으로 튕겨냄.
  // 해결: 실제 <a> 요소를 찾아 부모 기준 좌표로 CDP 휴먼 클릭 → target="_blank" 정상 동작
  // ─────────────────────────────────────────────
  if (instruction.action === 'NAVIGATE' && instruction.value?.includes('cr.shopping.naver.com/adcr')) {
    const adcrUrlValue = instruction.value;
    const newTabListener = (tab: chrome.tabs.Tab) => {
      if (tab.id) {
        console.info('[actionExecutor] adcr 새 탭 감지 - tabId:', tab.id, 'url:', tab.url);
        newTabId = tab.id;
      }
    };
    chrome.tabs.onCreated.addListener(newTabListener);

    try {
      // adcr <a> 요소를 뷰포트 안으로 스크롤한 뒤 중심 좌표를 가져온다
      const scriptResult = await chrome.scripting.executeScript({
        target: { tabId: storage.targetTabId },
        func: (adcrUrl: string) => {
          // 전달받은 adcr URL로 정확히 매칭, 없으면 첫 번째 adcr 링크
          const allAdcr = Array.from(
            document.querySelectorAll('a[href*="cr.shopping.naver.com/adcr"]')
          ) as HTMLAnchorElement[];
          const decodedAdcrUrl = adcrUrl.replace(/&amp;/g, '&');
          const domHrefs = allAdcr.map(a => a.href);
          console.warn('[actionExecutor] adcr URL match diagnostic', {
            targetFromAI: adcrUrl,
            decodedTargetFromAI: decodedAdcrUrl,
            domHrefCount: domHrefs.length,
            domHrefs,
            exactMatchFound: domHrefs.some(href => href === adcrUrl),
            decodedMatchFound: domHrefs.some(href => href === decodedAdcrUrl)
          });
          const el: HTMLElement | null = allAdcr.find(a => a.href === adcrUrl)
            ?? allAdcr.find(a => a.href === decodedAdcrUrl)
            ?? allAdcr[0]
            ?? null;
          console.warn('[actionExecutor] adcr URL selected element', {
            targetFromAI: adcrUrl,
            decodedTargetFromAI: decodedAdcrUrl,
            selectedHref: el instanceof HTMLAnchorElement ? el.href : null,
            fallbackToFirst: !!el && el instanceof HTMLAnchorElement && el.href !== adcrUrl && el.href !== decodedAdcrUrl
          });
          if (!el) return null;

          // 요소 자체가 zero-size면 visible한 조상까지 올라가서 스크롤 대상 결정
          let target: HTMLElement = el;
          let rect = target.getBoundingClientRect();
          while ((rect.width === 0 || rect.height === 0) && target.parentElement) {
            target = target.parentElement;
            rect = target.getBoundingClientRect();
          }
          if (rect.width === 0 || rect.height === 0) return null;

          // 뷰포트 밖에 있으면 즉시 스크롤 (behavior: 'instant' → getBoundingClientRect 즉시 반영)
          const vh = window.innerHeight;
          if (rect.top < 0 || rect.bottom > vh) {
            target.scrollIntoView({ behavior: 'instant' as ScrollBehavior, block: 'center' });
            rect = target.getBoundingClientRect();
          }

          return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2)
          };
        },
        args: [adcrUrlValue]
      });

      const coord = scriptResult?.[0]?.result as { x: number; y: number } | null;
      if (coord) {
        console.info(`[actionExecutor] adcr CDP 클릭 - x=${coord.x}, y=${coord.y}`);
        await cdpHumanizedClick(storage.targetTabId, coord.x, coord.y);
        await new Promise((resolve) => setTimeout(resolve, 2500));
      } else {
        // 요소 좌표를 못 찾으면 fallback: window.location.href (content script 경유)
        console.warn('[actionExecutor] adcr 요소 좌표 없음 → window.location.href fallback');
        await chrome.scripting.executeScript({
          target: { tabId: storage.targetTabId },
          func: (url: string) => { window.location.href = url; },
          args: [adcrUrlValue]
        });
        navigationTriggeredByAction = true;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('message channel closed') || errMsg.includes('Could not establish connection')) {
        navigationTriggeredByAction = true;
      } else {
        console.warn('[actionExecutor] adcr 처리 실패:', errMsg);
        navigationTriggeredByAction = true;
      }
    } finally {
      chrome.tabs.onCreated.removeListener(newTabListener);
      console.info('[actionExecutor] adcr 처리 완료 - newTabId:', newTabId, 'navigationTriggered:', navigationTriggeredByAction);
    }
  } else if (instruction.action === 'CLICK') {
    // 새 탭 감지 리스너 먼저 등록 (CDP 클릭이 새 탭을 열 수 있으므로)
    snapshotBeforeClick = await collectSnapshotFromActiveTab();
    const newTabListener = (tab: chrome.tabs.Tab) => {
      if (tab.id) {
        console.info('[actionExecutor] 새 탭 감지 - tabId:', tab.id, 'url:', tab.url);
        newTabId = tab.id;
      }
    };
    chrome.tabs.onCreated.addListener(newTabListener);

    try {
      // content script에서 요소 위치 좌표 획득
      const rect = await getElementRect(storage.targetTabId, instruction);

      if (!rect) {
        // 요소 못 찾음 → FAILURE 결과 즉시 반환
        chrome.tabs.onCreated.removeListener(newTabListener);
        const failResult: ActionResult = {
          runId: storage.activeRunId,
          stepIndex: instruction.stepIndex,
          actionId: instruction.actionId,
          action: instruction.action,
          status: 'FAILURE',
          errorCode: 'ELEMENT_NOT_FOUND',
          errorMessage: 'CDP 클릭 대상 요소를 찾지 못함',
          snapshot: await collectSnapshotFromActiveTab(),
          completedAt: new Date().toISOString()
        };
        await setLastAction({ type: failResult.action, stepIndex: failResult.stepIndex, at: failResult.completedAt, result: failResult.status });
        await broadcastStatusSnapshot();
        return failResult;
      }

      if ('debug' in rect && rect.debug) {
        console.info('[actionExecutor] CDP 클릭 대상 상세', rect.debug);
      }

      // CDP로 사람처럼 클릭
      console.info(`[actionExecutor] CDP 클릭 좌표 - x=${rect.x}, y=${rect.y}, viewport=${JSON.stringify({ w: 'unknown', h: 'unknown' })}`);
      await cdpHumanizedClick(storage.targetTabId, rect.x, rect.y);

      // 클릭 후 새 탭 또는 현재 탭 이동 감지를 위해 잠시 대기
      await new Promise((resolve) => setTimeout(resolve, 2500));
      console.info(`[actionExecutor] 2500ms 대기 완료 - newTabId=${newTabId}, navigationTriggered=${navigationTriggeredByAction}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // 클릭이 현재 탭 이동을 유발해 채널이 끊긴 경우 → 성공으로 처리
      const isChannelClosed =
        errMsg.includes('message channel closed') ||
        errMsg.includes('message port closed') ||
        errMsg.includes('Could not establish connection');
      if (!isChannelClosed) {
        chrome.tabs.onCreated.removeListener(newTabListener);
        throw err;
      }
      navigationTriggeredByAction = true;
    } finally {
      chrome.tabs.onCreated.removeListener(newTabListener);
      console.info('[actionExecutor] CDP CLICK 완료 - newTabId:', newTabId, 'navigationTriggered:', navigationTriggeredByAction);
    }
  } else if (instruction.action === 'INPUT' && instruction.value?.endsWith('\n')) {
    // ─────────────────────────────────────────────
    // 검색 제출 INPUT: content script 방식 제거, CDP typing 직접 사용
    //
    // content script의 isTrusted=false 이벤트는 React controlled input에서 무시되어
    // 화면에 글자가 보여도 React state는 빈 문자열 → "검색어를 입력하세요." 팝업 발생.
    // CDP Input.insertText는 isTrusted=true로 React onChange를 정상 트리거한다.
    // ─────────────────────────────────────────────
    const urlBefore = (await chrome.tabs.get(storage.targetTabId)).url ?? '';
    const intendedQuery = instruction.value.slice(0, -1); // trailing \n 제거

    // ── [DEBUG] 현재 상태 전체 출력 ──
    console.info('[cdp-type][DEBUG] 시작', {
      urlBefore,
      intendedQuery,
      tabId: storage.targetTabId
    });

    // ── 사전 체크: 이미 해당 검색어 결과 페이지에 있는지 확인 ──
    // Naver Shopping SPA는 현재 URL의 query 파라미터와 동일한 검색어로 Enter를 눌러도
    // 재네비게이션하지 않는다 → urlBefore === urlAfter → FAILURE 오판 발생.
    // 이미 올바른 검색 결과 페이지에 있으면 CDP type을 건너뛰고 즉시 성공 처리한다.
    const existingQuery = extractValidQueryParam(urlBefore);
    console.info('[cdp-type][DEBUG] 사전체크', {
      existingQuery,
      intendedQuery,
      hasExisting: !!existingQuery
    });
    if (existingQuery) {
      const normExisting = existingQuery.trim().toLowerCase();
      const normIntended  = intendedQuery.trim().toLowerCase();
      const alreadyOnResultsPage =
        normExisting === normIntended ||
        normExisting.includes(normIntended) ||
        normIntended.includes(normExisting);

      console.info('[cdp-type][DEBUG] 사전체크 매칭', {
        normExisting,
        normIntended,
        alreadyOnResultsPage
      });

      if (alreadyOnResultsPage) {
        console.info(
          '[actionExecutor] [cdp-type] 이미 올바른 검색 결과 페이지 → CDP type 불필요, 성공 처리',
          { existing: existingQuery, intended: intendedQuery }
        );
        return {
          runId: storage.activeRunId,
          stepIndex: instruction.stepIndex,
          actionId: instruction.actionId,
          action: instruction.action,
          status: 'SUCCESS',
          snapshot: await collectSnapshotFromActiveTab(),
          completedAt: new Date().toISOString()
        };
      }
    }

    // 검색창 포커스 (Naver 컨테이너 우선 + generic fallback)
    try {
      const focusResult = await chrome.scripting.executeScript({
        target: { tabId: storage.targetTabId },
        func: (selector: string, expected: string) => {
          function findInput(): { el: HTMLElement | null; via: string } {
            const containers = [
              'div._searchInput', 'div.search_input', 'div.search_cont',
              'div[class*="search_input"]', 'div[class*="schSearch"]'
            ];
            for (const sel of containers) {
              const c = document.querySelector<HTMLElement>(sel);
              if (c) {
                const inp = c.querySelector<HTMLInputElement>(
                  'input[name="query"], input[type="search"], input[class*="search"]'
                );
                if (inp) return { el: inp, via: sel };
              }
            }
            const bySel = selector ? document.querySelector<HTMLElement>(selector) : null;
            if (bySel) return { el: bySel, via: 'selector' };
            const generic = document.querySelector<HTMLInputElement>(
              'input[name="query"], input[type="search"], input._searchInput_search_text, ' +
              'input[class*="search_text"], input.input_text, input[placeholder*="검색"]'
            );
            if (generic) return { el: generic, via: 'generic' };
            return { el: null, via: '' };
          }
          const found = findInput();
          if (!found.el) return { found: false, value: '', via: '' };
          const input = found.el as HTMLInputElement;
          input.focus();
          input.select();
          const currentValue = input.value;
          console.info(`[cdp-type-focus] via=${found.via}, value="${currentValue}" expected="${expected}"`);
          return { found: true, value: currentValue, via: found.via };
        },
        args: [instruction.target?.selector ?? '', intendedQuery]
      });
      const focusInfo = focusResult?.[0]?.result as { found: boolean; value: string; via: string } | undefined;
      if (focusInfo?.found) {
        console.info(`[actionExecutor] [cdp-type] 포커스 완료: via=${focusInfo.via}, value="${focusInfo.value}"`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    } catch (focusErr) {
      console.warn('[actionExecutor] [cdp-type] 포커스 스크립트 실패 (무시):', focusErr);
    }

    // CDP로 Ctrl+A → Delete → insertText → Enter (isTrusted=true)
    let cdpTypeSucceeded = false;
    try {
      await cdpTypeTextAndEnter(storage.targetTabId, intendedQuery);
      // 300ms는 cdpTypeTextAndEnter 내부에서 Enter 처리 대기로 이미 사용됨.
      // 여기서는 네비게이션이 실제로 시작/완료될 때까지 추가 대기한다.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const tabAfterCdpType = await chrome.tabs.get(storage.targetTabId);
      const urlAfterCdpType = tabAfterCdpType.url ?? '';

      // ── [DEBUG] CDP 타이핑 후 탭 상태 전체 출력 ──
      console.info('[cdp-type][DEBUG] 타이핑 후 탭 상태', {
        status: tabAfterCdpType.status,
        urlBefore,
        urlAfter: urlAfterCdpType,
        urlChanged: urlBefore !== urlAfterCdpType
      });

      if (tabAfterCdpType.status === 'loading') {
        console.info('[actionExecutor] [cdp-type] CDP 타이핑 후 탭 로딩 중 → 이동 성공');
        navigationTriggeredByAction = true;
        cdpTypeSucceeded = true;
      } else if (await isSearchNavigationSuccess(storage.targetTabId, urlBefore, urlAfterCdpType, intendedQuery)) {
        console.info('[actionExecutor] [cdp-type] CDP 타이핑 후 URL 변경 + 검증 통과 → 성공 처리', { urlBefore, urlAfter: urlAfterCdpType });
        navigationTriggeredByAction = true;
        cdpTypeSucceeded = true;
      } else {
        console.warn('[actionExecutor] [cdp-type] CDP 타이핑 후에도 탭 미이동 → FAILURE', {
          reason: urlBefore === urlAfterCdpType ? 'URL_NOT_CHANGED' : 'NAVER_QUERY_MISMATCH',
          urlBefore,
          urlAfter: urlAfterCdpType
        });
      }
    } catch (cdpTypeErr) {
      const errMsg = cdpTypeErr instanceof Error ? cdpTypeErr.message : String(cdpTypeErr);
      const isChannelClosed =
        errMsg.includes('message channel closed') ||
        errMsg.includes('message port closed') ||
        errMsg.includes('Could not establish connection');
      if (isChannelClosed) {
        console.info('[actionExecutor] [cdp-type] CDP 타이핑이 navigation을 유발 → 성공');
        navigationTriggeredByAction = true;
        cdpTypeSucceeded = true;
      } else {
        console.warn('[actionExecutor] [cdp-type] CDP 타이핑 실패:', errMsg);
      }
    }

    if (!cdpTypeSucceeded) {
      const snapshot: PageSnapshot = await collectSnapshotFromActiveTab();
      const failResult: ActionResult = {
        runId: storage.activeRunId,
        stepIndex: instruction.stepIndex,
        actionId: instruction.actionId,
        action: instruction.action,
        status: 'FAILURE',
        errorCode: 'NAVIGATION_FAILED',
        errorMessage: 'CDP 타이핑 후 페이지 이동 실패',
        snapshot,
        completedAt: new Date().toISOString()
      };
      await setLastAction({ type: failResult.action, stepIndex: failResult.stepIndex, at: failResult.completedAt, result: failResult.status });
      pushLog({
        runId: storage.activeRunId,
        deviceId: storage.deviceId,
        stepIndex: instruction.stepIndex,
        action: instruction.action,
        status: 'ACTION_FAILURE',
        message: failResult.errorMessage ?? '검색 제출 실패'
      });
      await broadcastStatusSnapshot();
      return failResult;
    }
  } else {
    // ─────────────────────────────────────────────
    // 검색 제출 외 액션(NAVIGATE, SELECT, SCROLL, WAIT, '\n' 없는 INPUT):
    // content script에 EXECUTE_ACTION 전송
    // ─────────────────────────────────────────────
    try {
      response = (await chrome.tabs.sendMessage(storage.targetTabId, {
        type: 'EXECUTE_ACTION',
        payload: { instruction }
      })) as ContentToBackgroundActionResultMessage;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isChannelClosed =
        errMsg.includes('message channel closed') ||
        errMsg.includes('message port closed') ||
        errMsg.includes('Could not establish connection');

      if (!isChannelClosed) throw err;
      navigationTriggeredByAction = true;
    }

    if (!navigationTriggeredByAction && (!response || !response.payload.ok)) {
      throw new Error(response && !response.payload.ok ? response.payload.error : 'action 실행 응답이 비정상적임');
    }
  }

  // CLICK이 새 탭을 열었으면 그 탭으로 targetTabId를 교체하고 로드 대기
  if (newTabId !== null) {
    const timeoutMs = instruction.timeoutMs ?? 15000;

    // 1차 로드 대기 (cr.shopping.naver.com 등 중간 리다이렉트 포함)
    await waitForTabLoad(newTabId, timeoutMs);

    // cr.shopping.naver.com/adcr 같은 JS 리다이렉트 페이지는 status=complete 후에도
    // JavaScript가 실행되어 최종 목적지로 이동할 수 있음 → 이동이 시작되면 다시 대기
    await new Promise((resolve) => setTimeout(resolve, 500));
    const tabAfterFirstLoad = await chrome.tabs.get(newTabId);
    if (tabAfterFirstLoad.status === 'loading') {
      console.info(`[actionExecutor] 새 탭 추가 이동 감지 → 다시 대기 - url=${tabAfterFirstLoad.url}`);
      await waitForTabLoad(newTabId, timeoutMs);
    }

    await randomNavigationDelay();
    await chrome.tabs.update(newTabId, { active: true });
    // 외부 사이트(쿠팡, 옥션 등)에서 content script가 document_idle 시점까지
    // 주입되지 않는 문제를 해결하기 위해 수동으로 주입
    try {
      await chrome.scripting.executeScript({
        target: { tabId: newTabId },
        files: ['content.js']
      });
      console.info('[actionExecutor] content script 수동 주입 완료 - tabId:', newTabId);
    } catch (err) {
      // 이미 주입된 경우 에러 무시
      console.warn('[actionExecutor] content script 수동 주입 실패 (이미 주입되었을 수 있음):', err);
    }

    const finalTab = await chrome.tabs.get(newTabId);
    await updateStorage({
      targetTabId: newTabId,
      targetUrl: finalTab.url ?? null
    });
    console.info(`[actionExecutor] TAB_SWITCHED 완료 - tabId=${newTabId}, finalUrl=${finalTab.url}`);
    pushLog({
      runId: storage.activeRunId,
      deviceId: storage.deviceId,
      stepIndex: instruction.stepIndex,
      action: instruction.action,
      status: 'TAB_SWITCHED',
      message: `CLICK이 새 탭(tabId=${newTabId})을 열어 targetTabId를 교체함. 최종 URL: ${finalTab.url}`
    });
  }

  // NAVIGATE 또는 현재 탭에서 페이지 이동이 발생한 경우 로드 대기 (새 탭이 아닌 경우만)
  if ((instruction.action === 'NAVIGATE' || navigationTriggeredByAction) && newTabId === null) {
    const timeoutMs = instruction.timeoutMs ?? 15000;
    await waitForTabLoad(storage.targetTabId, timeoutMs);
    // content script가 새 페이지에 주입되기까지 랜덤 대기 (봇 감지 우회)
    await randomNavigationDelay();
  }

  // CLICK이 에러 없이 SUCCESS를 반환했지만 현재 탭에서 조용히 페이지 이동을 유발한 경우
  // (예: 로그인 페이지로 리다이렉트) → 탭이 로딩 중이면 완료될 때까지 기다린다
  if (instruction.action === 'CLICK' && !navigationTriggeredByAction && newTabId === null) {
    const currentTab = await chrome.tabs.get(storage.targetTabId);
    if (currentTab.status === 'loading') {
      console.info('[actionExecutor] CLICK 후 탭이 로딩 중 감지 → 완료 대기');
      await waitForTabLoad(storage.targetTabId, instruction.timeoutMs ?? 15000);
      await randomNavigationDelay();
    }
  }

  const snapshot: PageSnapshot = await collectSnapshotFromActiveTab();
  await updateStorage({ targetUrl: snapshot.currentUrl });

  if (instruction.action === 'CLICK' && snapshotBeforeClick && !navigationTriggeredByAction && newTabId === null) {
    const noUrlChange = snapshotBeforeClick.currentUrl === snapshot.currentUrl;
    const sameVisibleText = snapshotBeforeClick.visibleTextSummary === snapshot.visibleTextSummary;
    const beforeHasPurchase = (snapshotBeforeClick.visibleTextSummary ?? '').includes('구매하기');
    const afterHasPurchase = (snapshot.visibleTextSummary ?? '').includes('구매하기');

    if (noUrlChange && sameVisibleText && beforeHasPurchase && afterHasPurchase) {
      console.warn('[actionExecutor] CLICK 후 화면 상태 변화 없음 → FAILURE 처리', {
        currentUrl: snapshot.currentUrl,
        beforeText: snapshotBeforeClick.visibleTextSummary,
        afterText: snapshot.visibleTextSummary
      });

      const failResult: ActionResult = {
        runId: storage.activeRunId,
        stepIndex: instruction.stepIndex,
        actionId: instruction.actionId,
        action: instruction.action,
        status: 'FAILURE',
        errorCode: 'ELEMENT_NOT_CLICKABLE',
        errorMessage: '클릭 후 화면 상태 변화 없음',
        snapshot,
        completedAt: new Date().toISOString()
      };

      await setLastAction({
        type: failResult.action,
        stepIndex: failResult.stepIndex,
        at: failResult.completedAt,
        result: failResult.status
      });
      pushLog({
        runId: failResult.runId,
        deviceId: storage.deviceId,
        stepIndex: failResult.stepIndex,
        action: failResult.action,
        status: 'ACTION_FAILURE',
        message: failResult.errorMessage ?? '클릭 후 화면 상태 변화 없음'
      });
      await broadcastStatusSnapshot();
      return failResult;
    }
  }

  // navigationTriggeredByAction이면 response가 없으므로 직접 SUCCESS 결과를 구성한다.
  const resultCore = response?.payload.ok
    ? response.payload.result
    : {
        stepIndex: instruction.stepIndex,
        actionId: instruction.actionId,
        action: instruction.action,
        status: 'SUCCESS' as const
      };

  const result: ActionResult = {
    runId: storage.activeRunId,
    ...resultCore,
    snapshot,
    completedAt: new Date().toISOString()
  };

  await setLastAction({
    type: result.action,
    stepIndex: result.stepIndex,
    at: result.completedAt,
    result: result.status
  });

  pushLog({
    runId: result.runId,
    deviceId: storage.deviceId,
    stepIndex: result.stepIndex,
    action: result.action,
    status: `ACTION_${result.status}`,
    message: `${result.action} 실행 결과: ${result.status}`
  });

  await broadcastStatusSnapshot();

  return result;
}
