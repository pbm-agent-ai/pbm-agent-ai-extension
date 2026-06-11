import type {
  ActionErrorCode,
  ActionInstruction,
  ActionResultStatus,
  ContentToBackgroundActionResultMessage
} from '../shared/types';

type LocatedElementResult = {
  element: HTMLElement;
  strategy: 'nodeId' | 'selectorOrLabel' | 'viewport';
};

type ElementDebugInfo = {
  strategy: 'nodeId' | 'selectorOrLabel' | 'viewport';
  requestedViewportX?: number | null;
  requestedViewportY?: number | null;
  requestedSelector?: string | null;
  requestedLabelText?: string | null;
  requestedNodeId?: string | null;
  elementTag: string;
  elementId?: string;
  elementClass?: string;
  elementRole?: string;
  elementText?: string;
  elementAriaLabel?: string;
  closestClickableTag?: string;
  closestClickableId?: string;
  closestClickableClass?: string;
  closestClickableRole?: string;
  closestClickableText?: string;
  closestClickableAriaLabel?: string;
  rect: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
};

function truncateDebugText(value: string | null | undefined, maxLength = 120): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return undefined;
  }

  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

function pickClickableAncestor(element: HTMLElement): HTMLElement {
  return element.closest<HTMLElement>('button, a, [role="button"], [role="option"], input[type="button"], input[type="submit"]') ?? element;
}

function buildElementDebugInfo(
  instruction: ActionInstruction,
  element: HTMLElement,
  strategy: 'nodeId' | 'selectorOrLabel' | 'viewport'
): ElementDebugInfo {
  const clickable = pickClickableAncestor(element);
  const rect = clickable.getBoundingClientRect();

  return {
    strategy,
    requestedViewportX: instruction.target?.viewportX ?? null,
    requestedViewportY: instruction.target?.viewportY ?? null,
    requestedSelector: instruction.target?.selector ?? null,
    requestedLabelText: instruction.target?.labelText ?? null,
    requestedNodeId: instruction.target?.nodeId ?? null,
    elementTag: element.tagName.toLowerCase(),
    elementId: element.id || undefined,
    elementClass: truncateDebugText(element.className),
    elementRole: element.getAttribute('role') || undefined,
    elementText: truncateDebugText(element.innerText || element.textContent),
    elementAriaLabel: truncateDebugText(element.getAttribute('aria-label')),
    closestClickableTag: clickable.tagName.toLowerCase(),
    closestClickableId: clickable.id || undefined,
    closestClickableClass: truncateDebugText(clickable.className),
    closestClickableRole: clickable.getAttribute('role') || undefined,
    closestClickableText: truncateDebugText(clickable.innerText || clickable.textContent),
    closestClickableAriaLabel: truncateDebugText(clickable.getAttribute('aria-label')),
    rect: {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }
  };
}

function resolveTargetElement(instruction: ActionInstruction): LocatedElementResult | null {
  if (instruction.target?.nodeId) {
    const byNodeId = locateByNodeId(instruction.target.nodeId);
    if (byNodeId) {
      return { element: byNodeId, strategy: 'nodeId' };
    }
  }

  const bySelectorOrLabel = locateByFallback(instruction);
  if (bySelectorOrLabel) {
    return { element: bySelectorOrLabel, strategy: 'selectorOrLabel' };
  }

  const byViewport = locateByViewport(instruction);
  if (byViewport) {
    return { element: byViewport, strategy: 'viewport' };
  }

  return null;
}

// 서버에서 지정해준 고유 NodeId 찾음
function locateByNodeId(nodeId: string): HTMLElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('button, a, input:not([type="password"]), select, textarea, [role="button"], [role="option"]')
  );

  for (const [index, element] of candidates.entries()) {
    const generated = `node-${index}-${[
      element.tagName.toLowerCase(),
      element.id ? `id:${element.id}` : null,
      element.getAttribute('aria-label') ? `aria:${element.getAttribute('aria-label')}` : null
    ]
      .filter(Boolean)
      .join('|')}`;

    if (generated === nodeId || element.getAttribute('data-pbm-node-id') === nodeId) {
      return element;
    }
  }

  return null;
}

// ID값이 변경됐을 경우 글자 기반으로 찾음
function locateByFallback(instruction: ActionInstruction): HTMLElement | null {
  const { target } = instruction;

  if (!target) {
    return null;
  }

  // CSS selector가 있으면 최우선으로 사용
  // nodeId는 DOM 위치 기반이라 동적 로딩 시 밀릴 수 있지만,
  // selector(예: a[href*="57981069328"])는 고유값 기반이라 항상 정확하다
  // AI가 Playwright 전용(:has-text 등) 또는 잘못된 selector를 반환할 경우
  // document.querySelector가 SyntaxError를 던지므로 try-catch로 방어
  if (target.selector) {
    // 단독 태그명만 있는 범용 selector는 거부 (예: "button", "a", "span")
    // → 페이지 첫 번째 버튼 등 엉뚱한 요소를 클릭하는 것을 방지
    const GENERIC_SELECTORS = new Set(['button', 'a', 'span', 'div', 'input', 'li', 'p']);
    const isGeneric = target.selector
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .every((s) => GENERIC_SELECTORS.has(s));

    if (isGeneric) {
      console.warn('[actionExecutor] 범용 selector 거부 (너무 포괄적):', target.selector);
    } else {
      try {
        const bySelector = document.querySelector<HTMLElement>(target.selector);
        if (bySelector) {
          return bySelector;
        }
      } catch (e) {
        console.warn('[actionExecutor] 유효하지 않은 CSS selector, fallback으로 전환:', target.selector, e);
      }
    }
  }

  // role과 labelText가 둘 다 없으면 매칭 기준이 없으므로 바로 null 반환
  // (기준 없이 탐색하면 페이지의 첫 번째 버튼을 반환해 엉뚱한 요소를 클릭하게 됨)
  if (!target.role && !target.labelText) {
    return null;
  }

  const candidates = Array.from(document.querySelectorAll<HTMLElement>('button, a, input, select, textarea, [role="button"], [role="option"]'));

  const byRoleLabel = candidates.find((element) => {
    const role = element.getAttribute('role') || element.tagName.toLowerCase();
    const label = element.innerText?.trim() || element.getAttribute('aria-label') || element.getAttribute('placeholder') || '';

    return (!target.role || role === target.role) && (!target.labelText || label.includes(target.labelText));
  });

  return byRoleLabel ?? null;
}

// 스크린샷 기반 좌표 추출
// viewportX/Y는 0~1 정규화된 비율 (Python 서비스에서 이미지 크기로 나눠서 정규화됨)
// window.innerWidth/Height를 곱해 CSS 픽셀 좌표로 변환한다.
// 이 방식은 뷰포트 크기나 Retina DPR에 무관하게 동작한다.
function locateByViewport(instruction: ActionInstruction): HTMLElement | null {
  const target = instruction.target;
  if (!target || target.viewportX == null || target.viewportY == null) {
    return null;
  }

  const x = Math.round(window.innerWidth * target.viewportX);
  const y = Math.round(window.innerHeight * target.viewportY);
  return document.elementFromPoint(x, y) as HTMLElement | null;
}

// ── Naver Shopping 전용 검색 제출 버튼 탐색 ──

/** Naver Shopping 도메인 여부 (search.shopping.naver.com) */
function isNaverShopping(): boolean {
  const host = window.location.hostname;
  return host === 'search.shopping.naver.com' || host.endsWith('.shopping.naver.com');
}

/**
 * 입력 요소 기준 Naver Shopping 검색 제출 버튼을 찾는다.
 * 우선순위:
 *   1. 입력 요소와 같은 부모 컨테이너 내 검색 버튼 (React controlled UI 구조 대응)
 *   2. 입력 요소의 직계 sibling
 *   3. 문서 전체 검색 버튼
 */
function findNaverSearchSubmitButton(inputEl: HTMLElement): HTMLElement | null {
  // Naver Shopping 검색 버튼으로 흔히 사용되는 선택자들
  const NAVER_BTN_SELECTORS = [
    'button._searchInput_button_submit',
    'a._searchInput_button_submit',
    'button[class*="btn_search"]',
    'button[class*="search_submit"]',
    'button[aria-label*="검색"]',
    'a[aria-label*="검색"]',
    'button[aria-label*="search"]',
  ].join(', ');

  // 1순위: 입력 요소 주변 컨테이너에서 탐색
  const container = inputEl.closest<HTMLElement>(
    'div.search_input, div._searchInput, div.search_cont, ' +
    'div[class*="search"], form, header, section'
  );
  if (container) {
    const nearby = container.querySelector<HTMLElement>(NAVER_BTN_SELECTORS);
    if (nearby) return nearby;
  }

  // 2순위: 입력 요소의 형제/부모 내 버튼
  const parent = inputEl.parentElement;
  if (parent) {
    const sibling = parent.querySelector<HTMLElement>(
      'button, a[role="button"], [role="button"]'
    );
    if (sibling) return sibling;
  }

  // 3순위: 문서 전체
  return document.querySelector<HTMLElement>(NAVER_BTN_SELECTORS);
}

/**
 * Naver Shopping 검색 입력 요소를 컨테이너 기반으로 정확히 찾는다.
 * 
 * 우선순위:
 *   1. Naver 전용 검색 컨테이너(div._searchInput 등) 내 input
 *   2. 문서 전체 Naver 특정 클래스 패턴
 *   3. generic fallback (input[name="query"] 등)
 * 
 * @returns 찾은 요소와 진단 정보
 */
function findNaverSearchInput(): {
  element: HTMLInputElement | HTMLTextAreaElement | null;
  tag: string;
  name: string;
  className: string;
  placeholder: string;
  container: string;
} {
  const result = {
    element: null as HTMLInputElement | HTMLTextAreaElement | null,
    tag: '',
    name: '',
    className: '',
    placeholder: '',
    container: ''
  };

  // 1순위: Naver Shopping 전용 검색 컨테이너 내 input
  const searchContainers = [
    'div._searchInput',
    'div.search_input',
    'div.search_cont',
    'div[class*="search_input"]',
    'div[class*="schSearch"]',
  ];

  for (const containerSel of searchContainers) {
    const container = document.querySelector<HTMLElement>(containerSel);
    if (!container) continue;
    const input = container.querySelector<HTMLInputElement>(
      'input[name="query"], input[type="search"], input[class*="search"]'
    );
    if (input) {
      result.element = input;
      result.tag = input.tagName.toLowerCase();
      result.name = input.name || '';
      result.className = input.className || '';
      result.placeholder = input.placeholder || '';
      result.container = containerSel;
      return result;
    }
  }

  // 2순위: 문서 전체 Naver 특정 클래스
  const naverInput = document.querySelector<HTMLInputElement>(
    'input._searchInput_search_text, ' +
    'input[class*="search_text"], ' +
    'input[class*="search_input"], ' +
    'input[name="query"]'
  );
  if (naverInput) {
    result.element = naverInput;
    result.tag = naverInput.tagName.toLowerCase();
    result.name = naverInput.name || '';
    result.className = naverInput.className || '';
    result.placeholder = naverInput.placeholder || '';
    result.container = 'document-naver';
    return result;
  }

  // 3순위: generic fallback
  const generic = document.querySelector<HTMLInputElement>(
    'input[name="query"], input[type="search"], input.input_text, input[placeholder*="검색"]'
  );
  if (generic) {
    result.element = generic;
    result.tag = generic.tagName.toLowerCase();
    result.name = generic.name || '';
    result.className = generic.className || '';
    result.placeholder = generic.placeholder || '';
    result.container = 'generic-fallback';
  }

  return result;
}

/**
 * 입력 요소의 현재 값을 로그로 남기고 의도한 값과 비교한다 (디버깅용).
 */
function logInputValue(
  input: HTMLInputElement | HTMLTextAreaElement,
  label: string,
  expected?: string
): void {
  const actual = input.value;
  const excerpt = actual.length > 80 ? actual.slice(0, 80) + '…' : actual;
  const matchStr = expected !== undefined
    ? (actual === expected ? '✅ 일치' : '❌ 불일치')
    : 'N/A';
  console.info(`[actionExecutor] [input-value] ${label}: "${excerpt}" (expected="${expected ?? '?'}") ${matchStr}`);
  console.info(`[actionExecutor] [input-value] element: <${input.tagName.toLowerCase()}` +
    ` name="${input.name}" class="${input.className}"` +
    ` placeholder="${input.placeholder}" disabled=${input.disabled}>`);
}

// 검색 제출: Naver 검색 버튼 → Enter 키 → 폼 submit 버튼 클릭 → form.requestSubmit() 순으로 시도
// 핵심: form.requestSubmit() / form.submit()은 이벤트 핸들러를 우회하여 반드시 네비게이션을 발생시킴
// humanizedClick(isTrusted=false)이 Naver 등 봇 감지 사이트에서 무시되더라도,
// 최종 form.requestSubmit()이 확실하게 검색 결과 페이지로 이동시킨다.
async function submitSearch(element: HTMLInputElement | HTMLTextAreaElement): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 300));

  // 검색 제출 전 입력값 검증
  logInputValue(element, 'submitSearch 진입 시');

  // ── Phase A: Naver Shopping 전용 검색 버튼 클릭 ──
  // Naver Shopping (search.shopping.naver.com)은 React controlled UI로
  // Enter 키나 form.requestSubmit()에 반응하지 않는 경우가 자주 발생한다.
  // 우선순위: 검색 버튼을 찾아 native element.click() (isTrusted=true)으로
  // React 핸들러가 확실하게 동작하도록 유도한다.
  if (isNaverShopping()) {
    // Naver Shopping: 입력값이 비어있으면 더 정확한 입력 요소로 재시도
    let activeElement = element;
    if (element.value === '' || element.value !== element.value /* NaN trick */) {
      const better = findNaverSearchInput();
      if (better.element && better.element.value !== '') {
        console.info('[actionExecutor] [nav-input] submitSearch에서 입력 요소 교체 (값 없음 → 발견됨):', {
          from: element.value ? 'has value' : 'empty',
          to: better.element.value ? 'has value' : 'empty',
          via: better.container
        });
        activeElement = better.element;
      }
    }

    const naverBtn = findNaverSearchSubmitButton(activeElement);
    if (naverBtn) {
      logInputValue(activeElement, '검색 버튼 클릭 전');
      console.info('[actionExecutor] [submitPath=naver-btn-click] Naver 검색 버튼 발견 → humanizedClick');
      await humanizedClick(naverBtn);
      // element.click() (isTrusted=true)이 navigation을 유발했으면
      // content script가 파괴되어 아래 코드는 실행되지 않는다.
      console.warn('[actionExecutor] [submitPath=naver-btn-click] 검색 버튼 클릭 후 navigation 없음 → 폴백');
    } else {
      console.warn('[actionExecutor] [submitPath=naver-btn-miss] Naver 검색 버튼 미발견 → Enter/submit 경로');
    }
    // activeElement를 element에 반영 (form lookup 등에서 사용)
    element = activeElement;
  }

  // ── Phase B: Enter 키 이벤트 (isTrusted=false → React 앱에서 무시될 수 있으나 일부 사이트엔 유효) ──
  element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));

  // ── Phase C: 폼 내 submit 버튼 클릭 시도 + form.requestSubmit() 최종 보루 ──
  const form = element.closest('form');
  if (form) {
    await new Promise((resolve) => setTimeout(resolve, 300 + Math.random() * 200));
    const submitBtn = form.querySelector<HTMLElement>(
      'button[type="submit"], input[type="submit"], button.btn_submit, ' +
      'button[class*="submit"], button[class*="search_btn"], button[class*="btn_search"]'
    );
    if (submitBtn) {
      console.info('[actionExecutor] [submitPath=form-submit-btn] 폼 내 submit 버튼 클릭');
      await humanizedClick(submitBtn);
    }
    // form.requestSubmit() / form.submit()은 브라우저가 직접 폼을 제출하므로
    // isTrusted 검사를 우회해 반드시 네비게이션을 발생시킨다.
    // humanizedClick이 이미 네비게이션을 유발했으면 content script가 파괴돼
    // 이 코드는 실행되지 않으므로 중복 제출 걱정 없음.
    const formEl = form as HTMLFormElement;
    if (typeof formEl.requestSubmit === 'function') {
      console.info('[actionExecutor] [submitPath=form-requestSubmit] form.requestSubmit() 호출');
      formEl.requestSubmit();
    } else {
      console.info('[actionExecutor] [submitPath=form-submit] form.submit() 호출');
      formEl.submit();
    }
  } else {
    console.info('[actionExecutor] [submitPath=no-form] 입력 요소가 <form> 내부에 없음');
  }
}

/**
 * React controlled input 호환 네이티브 값 설정.
 *
 * element.value = x 로 직접 할당하면 React의 internal state가 갱신되지 않아
 * Enter 키나 submit 이벤트 시 React 핸들러가 빈 문자열로 인식한다.
 * HTMLInputElement.prototype의 native value setter를 통해 강제로 React state를 갱신한다.
 */
function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = element instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (nativeSetter) {
    nativeSetter.call(element, value);
  } else {
    // native setter를 못 찾으면 직접 할당 (fallback)
    element.value = value;
  }
}

// 사람처럼 타이핑: 한 글자씩 랜덤 딜레이로 입력
// 마지막 글자가 '\n' 이면 Enter 키를 눌러 폼을 제출한다 (검색창 검색에 사용)
async function humanizedType(element: HTMLInputElement | HTMLTextAreaElement, rawValue: string): Promise<void> {
  const submitAfter = rawValue.endsWith('\n');
  const text = submitAfter ? rawValue.slice(0, -1) : rawValue;

  // ── Naver Shopping: 더 정확한 검색 입력 요소로 보정 ──
  let activeElement = element;
  if (isNaverShopping()) {
    const better = findNaverSearchInput();
    if (better.element && better.element !== element) {
      console.info('[actionExecutor] [nav-input] 입력 요소 교체:', {
        from: `<${element.tagName.toLowerCase()} name="${(element as HTMLInputElement).name}">`,
        to: `<${better.tag} name="${better.name}" class="${better.className}">`,
        via: better.container
      });
      activeElement = better.element;
    } else if (better.element) {
      console.info('[actionExecutor] [nav-input] 현재 입력 요소 사용:', {
        tag: better.tag,
        name: better.name,
        class: better.className,
        placeholder: better.placeholder,
        value: better.element.value
      });
    } else {
      console.warn('[actionExecutor] [nav-input] Naver 검색 입력 요소를 찾지 못함 (혹은 element와 동일)');
    }
  }

  // 이미 올바른 값이 입력돼 있으면 재입력 생략 → 바로 검색 실행 (무한 루프 방지)
  if (activeElement.value === text && text.length > 0) {
    logInputValue(activeElement, '재입력 생략 (값 이미 존재)', text);
    if (submitAfter) await submitSearch(activeElement);
    return;
  }

  activeElement.focus();

  // 기존 값 초기화 전 로그
  logInputValue(activeElement, '초기화 전', text);

  // 기존 값 초기화 (React state도 함께 갱신)
  setNativeValue(activeElement, '');
  activeElement.dispatchEvent(new Event('input', { bubbles: true }));

  // 한 글자씩 입력 (Array.from으로 한글 등 멀티바이트 문자 정상 처리)
  // React controlled input을 위해 매 글자마다 native setter로 갱신
  let currentValue = '';
  for (const char of Array.from(text)) {
    activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true, cancelable: true }));
    currentValue += char;
    setNativeValue(activeElement, currentValue);
    activeElement.dispatchEvent(new InputEvent('input', { bubbles: true, data: char }));
    activeElement.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
    // 사람 타이핑 속도: 60~200ms 사이 무작위
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 140));
  }

  // 전체 텍스트를 한 번 더 native setter로 확정 (React state 동기화 보장)
  setNativeValue(activeElement, text);
  activeElement.dispatchEvent(new Event('change', { bubbles: true }));

  // 입력 완료 후 값 검증
  logInputValue(activeElement, '타이핑 완료 후', text);

  // '\n'이 붙어 있으면 검색 제출 (Enter 키 + submit 버튼 폴백)
  if (submitAfter) {
    await submitSearch(activeElement);
  }
}

// 사람처럼 클릭: 마우스 이동 → hover → mousedown → mouseup → click 순서 준수
async function humanizedClick(element: HTMLElement): Promise<void> {
  const rect = element.getBoundingClientRect();
  // 요소 내부 랜덤 좌표 (가장자리 5px 제외)
  const x = rect.left + 5 + Math.random() * Math.max(rect.width - 10, 1);
  const y = rect.top + 5 + Math.random() * Math.max(rect.height - 10, 1);

  const mouseEventInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    view: window
  };

  element.dispatchEvent(new MouseEvent('mouseover', mouseEventInit));
  element.dispatchEvent(new MouseEvent('mouseenter', { ...mouseEventInit, bubbles: false }));

  // hover 후 잠깐 머무름 (사람 반응 시간: 1.5~4초)
  await new Promise((resolve) => setTimeout(resolve, 1500 + Math.random() * 2500));

  element.dispatchEvent(new MouseEvent('mousedown', { ...mouseEventInit, button: 0, buttons: 1 }));
  await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 80));
  element.dispatchEvent(new MouseEvent('mouseup', { ...mouseEventInit, button: 0 }));

  // dispatchEvent(click)은 isTrusted=false로 마킹되어 target="_blank" 새 탭 열기 등이
  // 브라우저에 의해 차단될 수 있다. 네이티브 element.click()을 사용해 신뢰된 클릭을 보낸다.
  element.click();
}

function successPayload(instruction: ActionInstruction): ContentToBackgroundActionResultMessage {
  return {
    type: 'ACTION_RESULT',
    payload: {
      ok: true,
      result: {
        stepIndex: instruction.stepIndex,
        actionId: instruction.actionId,
        action: instruction.action,
        status: 'SUCCESS'
      }
    }
  };
}

function failurePayload(
  instruction: ActionInstruction,
  status: ActionResultStatus,
  errorCode: ActionErrorCode,
  errorMessage: string
): ContentToBackgroundActionResultMessage {
  return {
    type: 'ACTION_RESULT',
    payload: {
      ok: true,
      result: {
        stepIndex: instruction.stepIndex,
        actionId: instruction.actionId,
        action: instruction.action,
        status,
        errorCode,
        errorMessage
      }
    }
  };
}

/**
 * CLICK 대상 요소를 찾아 viewport 기준 중심 좌표를 반환한다.
 * background가 CDP Input.dispatchMouseEvent 호출 시 사용한다.
 * 요소를 찾지 못하면 null 반환.
 */
export function locateElementCenter(instruction: ActionInstruction): {
  x: number;
  y: number;
  debug: ElementDebugInfo;
} | null {
  const located = resolveTargetElement(instruction);

  if (!located) {
    return null;
  }

  const clickable = pickClickableAncestor(located.element);
  const debug = buildElementDebugInfo(instruction, located.element, located.strategy);

  console.info('[actionExecutor] CLICK target resolved', debug);

  // 요소가 뷰포트 밖에 있으면 스크롤해서 중앙으로 이동 (instant로 즉시 완료)
  clickable.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });

  const rect = clickable.getBoundingClientRect();

  // 요소가 실제로 보이지 않는 경우 (hidden, zero-size 등) null 반환
  if (rect.width === 0 || rect.height === 0) {
    return null;
  }

  // 요소 내부 랜덤 좌표 (가장자리 5px 제외, humanizedClick과 동일한 패턴)
  const x = Math.round(rect.left + 5 + Math.random() * Math.max(rect.width - 10, 1));
  const y = Math.round(rect.top + 5 + Math.random() * Math.max(rect.height - 10, 1));

  return { x, y, debug };
}

export async function executeInstruction(
  instruction: ActionInstruction
): Promise<ContentToBackgroundActionResultMessage> {
  try {
    switch (instruction.action) {
      case 'NAVIGATE': {
        if (!instruction.value) {
          return failurePayload(instruction, 'FAILURE', 'NAVIGATION_FAILED', 'target url 이 없음');
        }

        window.location.href = instruction.value;
        return successPayload(instruction);
      }

      case 'CLICK': {
        const located = resolveTargetElement(instruction);
        const element = located?.element ?? null;

        if (!element) {
          return failurePayload(instruction, 'FAILURE', 'ELEMENT_NOT_FOUND', '대상 요소를 찾지 못함');
        }

        console.info('[actionExecutor] CLICK fallback execution target', buildElementDebugInfo(
          instruction,
          element,
          located?.strategy ?? 'selectorOrLabel'
        ));

        if ((element as HTMLButtonElement).disabled || element.getAttribute('aria-disabled') === 'true') {
          return failurePayload(instruction, 'FAILURE', 'ELEMENT_NOT_CLICKABLE', '대상 요소가 비활성화됨');
        }

        // CLICK은 background가 CDP로 처리하므로 content script에서는 실행하지 않는다.
        // (이 분기는 CDP 미지원 fallback용으로만 남겨둠)
        if (element.tagName.toLowerCase() === 'a') {
          const anchor = element as HTMLAnchorElement;
          if (anchor.target === '_blank') {
            anchor.target = '_self';
          }
        }

        await humanizedClick(element);
        return successPayload(instruction);
      }

      case 'INPUT': {
        const element = (instruction.target?.nodeId && locateByNodeId(instruction.target.nodeId)) || locateByFallback(instruction);

        if (!element || !(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
          return failurePayload(instruction, 'FAILURE', 'ELEMENT_NOT_FOUND', '입력 가능한 요소를 찾지 못함');
        }

        if (element.disabled) {
          return failurePayload(instruction, 'FAILURE', 'ELEMENT_NOT_CLICKABLE', '입력 요소가 비활성화됨');
        }

        await humanizedType(element, instruction.value ?? '');
        return successPayload(instruction);
      }

      case 'SELECT': {
        const element = (instruction.target?.nodeId && locateByNodeId(instruction.target.nodeId)) || locateByFallback(instruction);

        if (!element || !(element instanceof HTMLSelectElement)) {
          return failurePayload(instruction, 'FAILURE', 'ELEMENT_NOT_FOUND', 'select 요소를 찾지 못함');
        }

        if (element.disabled) {
          return failurePayload(instruction, 'FAILURE', 'ELEMENT_NOT_CLICKABLE', 'select 요소가 비활성화됨');
        }

        element.value = instruction.value ?? '';
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return successPayload(instruction);
      }

      case 'SCROLL': {
        const delta = Number(instruction.value ?? 400);
        const beforeY = window.scrollY;
        const beforeX = window.scrollX;
        console.info('[content/actionExecutor] SCROLL 시작', {
          delta,
          beforeX,
          beforeY,
          viewportHeight: window.innerHeight,
          documentHeight: document.documentElement?.scrollHeight ?? null
        });
        window.scrollBy({ top: delta, behavior: 'instant' });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await new Promise((resolve) => setTimeout(resolve, 150));
        console.info('[content/actionExecutor] SCROLL 완료', {
          afterX: window.scrollX,
          afterY: window.scrollY,
          deltaApplied: window.scrollY - beforeY
        });
        return successPayload(instruction);
      }

      case 'WAIT': {
        await new Promise((resolve) => setTimeout(resolve, instruction.waitMs ?? 1000));
        return successPayload(instruction);
      }

      case 'AWAIT_APPROVAL':
      case 'COMPLETE':
      case 'ABORT':
        return successPayload(instruction);

      default:
        return failurePayload(instruction, 'FAILURE', 'UNEXPECTED_ERROR', '지원하지 않는 action');
    }
  } catch (error) {
    return {
      type: 'ACTION_RESULT',
      payload: {
        ok: false,
        error: error instanceof Error ? error.message : '알 수 없는 action 실행 오류'
      }
    };
  }
}
