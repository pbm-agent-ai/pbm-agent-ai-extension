/**
 * URL 직접 입력 모니터링 매니저.
 *
 * 역할: heartbeat 응답에 포함된 urlMonitoringTasks를 순서대로 처리한다.
 *       각 URL에 대해:
 *       1. 이미 열려 있는 탭 재사용 또는 백그라운드 탭 생성
 *       2. 페이지 로드 대기
 *       3. 상품 가격 추출 (JSON-LD → CSS 클래스 순으로 시도)
 *       4. 서버에 가격 보고 (subscriptionId가 있는 경우에만)
 *
 * 가격 추출 전략 (우선순위 순):
 *   1. application/ld+json 스크립트의 Schema.org Product offers.price
 *      → 쇼핑몰이 표준 구조화 데이터를 제공하면 가장 정확한 현재 판매가를 얻을 수 있다.
 *   2. CSS 클래스 패턴 매칭 [class*="currentWrap"] span 또는 [class*="--current--"]
 *      → 알리익스프레스 등 JSON-LD를 제공하지 않는 사이트의 현재가 요소를 직접 선택한다.
 *
 * 참고:
 *   - AgentRun과 달리 탭을 active: false (백그라운드)로 열어 사용자 화면을 침범하지 않는다.
 *   - subscriptionId가 null이면 price-service 구독이 아직 없는 것이므로 스킵한다.
 */

import { apiClient } from '../shared/apiClient';
import { pushLog } from '../shared/logger';
import { getStorage } from '../shared/storageManager';
import type { UrlMonitoringTask } from '../shared/types';

const URL_TAB_LOAD_TIMEOUT_MS = 20_000;
const PRICE_INJECT_TIMEOUT_MS = 5_000;


/** URL이 이미 열려 있는 탭 ID를 반환한다. 없으면 undefined. */
async function findExistingTab(url: string): Promise<number | undefined> {
  try {
    const exact = await chrome.tabs.query({ url });
    if (exact.length > 0 && exact[0].id != null) {
      return exact[0].id;
    }
  } catch {
    // chrome.tabs.query가 특수 URL 패턴에서 실패할 수 있으므로 무시
  }
  return undefined;
}

/** 탭이 complete 상태가 될 때까지 대기한다. */
async function waitForTabLoad(tabId: number, timeoutMs = URL_TAB_LOAD_TIMEOUT_MS): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return true;
    } catch {
      return false;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * 페이지에서 상품 현재 판매가를 추출한다.
 *
 * 전략 1: application/ld+json 스크립트에서 Schema.org Product의 offers.price 추출.
 *          알리익스프레스는 "price":"128620." 형태로 현재 판매가만 정확히 제공한다.
 * 전략 2: CSS 클래스 패턴으로 현재가 요소를 직접 선택.
 *          알리익스프레스의 [class*="currentWrap"] 내부 span을 타깃으로 한다.
 *          클래스명에 해시가 붙어도 부분 문자열 매칭으로 찾을 수 있다.
 */
async function extractProductPrice(
  tabId: number
): Promise<{ price: number; currency: string } | null> {
  try {
    const results = await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId },
        func: (): { price: number; currency: string } | null => {

          // ── 전략 1: JSON-LD Schema.org Product ──────────────────────────────
          const ldScripts = document.querySelectorAll<HTMLScriptElement>(
            'script[type="application/ld+json"]'
          );
          for (const script of ldScripts) {
            try {
              const parsed = JSON.parse(script.textContent ?? '');
              const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
              for (const item of items) {
                if (
                  item &&
                  typeof item === 'object' &&
                  (item as Record<string, unknown>)['@type'] === 'Product'
                ) {
                  const offers = (item as Record<string, unknown>).offers;
                  if (offers && typeof offers === 'object') {
                    const o = offers as Record<string, unknown>;
                    const rawPrice = String(o.price ?? '').replace(/,/g, '').trim();
                    const currency = String(o.priceCurrency ?? 'KRW').trim();
                    const price = parseFloat(rawPrice);
                    if (price > 0) return { price, currency };
                  }
                }
              }
            } catch {
              // JSON 파싱 실패 시 다음 스크립트로
            }
          }

          // ── 전략 2: CSS 클래스 패턴 [class*="currentWrap"] span ─────────────
          // 알리익스프레스: price-kr--currentWrap--{hash} 내부의 span
          const wrapEl = document.querySelector('[class*="currentWrap"] span');
          if (wrapEl?.textContent) {
            const text = wrapEl.textContent.trim().replace(/,/g, '');
            const krw = text.match(/₩([\d.]+)/);
            if (krw) return { price: parseFloat(krw[1]), currency: 'KRW' };
            const usd = text.match(/(?:US\s?\$|\$)([\d.]+)/);
            if (usd) return { price: parseFloat(usd[1]), currency: 'USD' };
          }

          // ── 전략 2-b: [class*="--current--"] 패턴 ─────────────────────────
          const currentEl = document.querySelector('[class*="--current--"]');
          if (currentEl?.textContent) {
            const text = currentEl.textContent.trim().replace(/,/g, '');
            const krw = text.match(/₩([\d.]+)/);
            if (krw) return { price: parseFloat(krw[1]), currency: 'KRW' };
            const usd = text.match(/(?:US\s?\$|\$)([\d.]+)/);
            if (usd) return { price: parseFloat(usd[1]), currency: 'USD' };
          }

          return null;
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('가격 추출 타임아웃')), PRICE_INJECT_TIMEOUT_MS)
      ),
    ]) as chrome.scripting.InjectionResult[];

    return (results?.[0]?.result as { price: number; currency: string } | null) ?? null;
  } catch (e) {
    pushLog({
      runId: null, deviceId: null, stepIndex: null, action: null,
      status: 'URL_MONITOR_PRICE_ERROR',
      message: `tabId=${tabId} 가격 추출 실패: ${e instanceof Error ? e.message : String(e)}`,
    });
    return null;
  }
}

/** 페이지에서 상품명과 대표 이미지를 추출한다. */
async function extractPageInfo(
  tabId: number
): Promise<{ productName: string | null; imageUrl: string | null }> {
  try {
    const results = await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          // 상품명: og:title → <title> → <h1> 순으로 시도
          const ogTitle = document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content?.trim();
          const pageTitle = document.title?.trim();
          const h1Text = document.querySelector('h1')?.textContent?.trim();
          const productName = ogTitle || pageTitle || h1Text || null;

          // 대표 이미지: og:image 우선
          const ogImage = document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content?.trim();
          const imageUrl = ogImage || null;

          return { productName: productName ?? null, imageUrl: imageUrl ?? null };
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('페이지 정보 추출 타임아웃')), PRICE_INJECT_TIMEOUT_MS)
      ),
    ]) as chrome.scripting.InjectionResult[];

    return (
      (results?.[0]?.result as { productName: string | null; imageUrl: string | null }) ??
      { productName: null, imageUrl: null }
    );
  } catch {
    return { productName: null, imageUrl: null };
  }
}

/** 단일 URL 모니터링 태스크를 처리한다. */
async function checkUrlPrice(task: UrlMonitoringTask, deviceToken: string): Promise<void> {
  // subscriptionId가 없으면 price-service 구독이 아직 생성 중 → 스킵
  if (task.subscriptionId == null) {
    pushLog({
      runId: null, deviceId: null, stepIndex: null, action: null,
      status: 'URL_MONITOR_SKIP',
      message: `subscriptionId 없음, 스킵 - url: ${task.productUrl}`,
    });
    return;
  }

  pushLog({
    runId: null, deviceId: null, stepIndex: null, action: null,
    status: 'URL_MONITOR_START',
    message: `가격 수집 시작 - url: ${task.productUrl}, target: ${task.targetPrice} ${task.currency}`,
  });

  let tabId: number | undefined;
  let createdNewTab = false;

  try {
    // 1. 이미 열려 있는 탭 재사용
    tabId = await findExistingTab(task.productUrl);

    if (tabId != null) {
      pushLog({
        runId: null, deviceId: null, stepIndex: null, action: null,
        status: 'URL_MONITOR_TAB_REUSED',
        message: `기존 탭 재사용 - tabId: ${tabId}, url: ${task.productUrl}`,
      });
    } else {
      // 2. 새 탭을 백그라운드(active: false)로 열기
      const tab = await chrome.tabs.create({ url: task.productUrl, active: false });
      if (tab.id == null) throw new Error('탭 생성 실패');
      tabId = tab.id;
      createdNewTab = true;

      pushLog({
        runId: null, deviceId: null, stepIndex: null, action: null,
        status: 'URL_MONITOR_TAB_CREATED',
        message: `백그라운드 탭 생성 - tabId: ${tabId}, url: ${task.productUrl}`,
      });
    }

    // 3. 페이지 로드 대기
    const loaded = await waitForTabLoad(tabId);
    if (!loaded) {
      throw new Error(`페이지 로드 타임아웃 - tabId: ${tabId}`);
    }

    // 4. 가격 + 상품 정보 병렬 추출
    const [extracted, pageInfo] = await Promise.all([
      extractProductPrice(tabId),
      extractPageInfo(tabId),
    ]);

    if (extracted == null) {
      pushLog({
        runId: null, deviceId: null, stepIndex: null, action: null,
        status: 'URL_MONITOR_NO_PRICE',
        message: `가격을 추출할 수 없음 - url: ${task.productUrl}`,
      });
      return;
    }

    pushLog({
      runId: null, deviceId: null, stepIndex: null, action: null,
      status: 'URL_MONITOR_PRICE_EXTRACTED',
      message: `가격 추출 완료 - price: ${extracted.price} ${extracted.currency}, 상품명: ${pageInfo.productName}`,
    });

    // 5. 서버에 가격 + 상품 정보 보고
    await apiClient.reportUrlPrice(
      {
        subscriptionId: task.subscriptionId,
        currentPrice: extracted.price,
        currency: extracted.currency,
        productName: pageInfo.productName ?? undefined,
        imageUrl: pageInfo.imageUrl ?? undefined,
      },
      deviceToken
    );

    pushLog({
      runId: null, deviceId: null, stepIndex: null, action: null,
      status: 'URL_MONITOR_REPORTED',
      message: `가격 보고 완료 - subscriptionId: ${task.subscriptionId}, price: ${extracted.price} ${extracted.currency}`,
    });
  } catch (e) {
    pushLog({
      runId: null, deviceId: null, stepIndex: null, action: null,
      status: 'URL_MONITOR_ERROR',
      message: `처리 실패 - url: ${task.productUrl}: ${e instanceof Error ? e.message : String(e)}`,
    });
  } finally {
    // 새로 열었던 탭만 닫는다 (재사용 탭은 닫지 않음)
    if (createdNewTab && tabId != null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        // 탭이 이미 닫혀있을 수 있으므로 무시
      }
    }
  }
}

/**
 * heartbeat 응답에 포함된 URL 모니터링 태스크 전체를 순서대로 처리한다.
 * AgentRun과 달리 순차 처리하여 탭 수를 제한한다.
 */
export async function processUrlMonitoringTasks(tasks: UrlMonitoringTask[]): Promise<void> {
  if (tasks.length === 0) return;

  const storage = await getStorage();
  const deviceToken = storage.deviceToken;
  if (!deviceToken) {
    pushLog({
      runId: null, deviceId: null, stepIndex: null, action: null,
      status: 'URL_MONITOR_SKIP',
      message: 'deviceToken 없음, URL 모니터링 스킵',
    });
    return;
  }

  pushLog({
    runId: null, deviceId: null, stepIndex: null, action: null,
    status: 'URL_MONITOR_BATCH_START',
    message: `URL 모니터링 배치 시작 - taskCount: ${tasks.length}`,
  });

  for (const task of tasks) {
    await checkUrlPrice(task, deviceToken);
  }

  pushLog({
    runId: null, deviceId: null, stepIndex: null, action: null,
    status: 'URL_MONITOR_BATCH_DONE',
    message: `URL 모니터링 배치 완료 - taskCount: ${tasks.length}`,
  });
}
