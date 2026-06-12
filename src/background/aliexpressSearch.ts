import { pushLog } from '../shared/logger';
import type { AliExpressSearchProduct } from '../shared/types';

const SEARCH_RESULT_PATH_PREFIX = 'https://ko.aliexpress.com/w/wholesale-';

function buildSearchUrl(keyword: string): string {
  return `${SEARCH_RESULT_PATH_PREFIX}${encodeURIComponent(keyword)}.html?spm=a2g0o.home.search.0`;
}

async function waitForTabComplete(tabId: number, timeoutMs = 25000): Promise<chrome.tabs.Tab> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') {
      return tab;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  throw new Error(`AliExpress 검색 탭 로드 타임아웃 (${timeoutMs}ms)`);
}

async function findReusableSearchTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ url: 'https://*.aliexpress.com/*' });
  return tabs.find((tab) => (tab.url ?? '').includes('/w/wholesale-'));
}

/**
 * AliExpress 검색 탭을 확보한다.
 *
 * 백그라운드 탭(active: false)에서는 Chrome이 렌더링/JS 실행을 쓰로틀링하여
 * SPA 상품 카드가 로드되지 않는 문제가 있다.
 * → 탭을 잠시 active로 전환하여 정상 렌더링을 유도한 뒤, 크롤링이 끝나면 복구한다.
 */
async function ensureSearchTab(keyword: string, searchUrl?: string): Promise<number> {
  const targetUrl = searchUrl?.trim() ? searchUrl : buildSearchUrl(keyword);
  const reusable = await findReusableSearchTab();

  let tabId: number;
  if (reusable?.id) {
    await chrome.tabs.update(reusable.id, { url: targetUrl });
    const updated = await waitForTabComplete(reusable.id);
    if (!updated.id) {
      throw new Error('AliExpress 검색 탭 갱신에 실패했습니다.');
    }
    tabId = updated.id;
  } else {
    // 백그라운드 탭으로 생성하여 사용자 화면을 방해하지 않는다.
    // chrome.scripting.executeScript는 비활성 탭에서도 DOM 접근이 가능하다.
    const created = await chrome.tabs.create({ url: targetUrl, active: false });
    if (!created.id) {
      throw new Error('AliExpress 검색 탭 생성에 실패했습니다.');
    }
    await waitForTabComplete(created.id);
    tabId = created.id;
  }

  return tabId;
}

/**
 * chrome.scripting.executeScript로 AliExpress 검색 결과를 직접 수집한다.
 *
 * content script 메시징(chrome.tabs.sendMessage) 방식은 AliExpress SPA의
 * 클라이언트 사이드 리다이렉트/재렌더링으로 content script가 파괴되거나
 * 주입 타이밍 문제로 "Receiving end does not exist" 에러가 빈번하게 발생한다.
 *
 * 대신 chrome.scripting.executeScript로 스크래핑 함수를 직접 주입·실행하여
 * content script 리스너에 의존하지 않는다.
 */
async function executeSearchCollection(
  tabId: number,
  keyword: string,
  maxResults: number
): Promise<AliExpressSearchProduct[]> {
  // SPA 초기 렌더링 대기 — document 'complete' 이후 추가 JS 실행 시간 확보
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    // eslint-disable-next-line @typescript-eslint/no-shadow
    func: async (kw: string, max: number) => {
      /* ─── 자립형(self-contained) AliExpress 상품 수집 로직 ──────────── */
      const POLL_INTERVAL = 500;
      const MAX_POLL_DURATION = 15_000;
      const INIT_DATA_CACHE_KEY = '__pbmAliExpressSearchResultIds';
      type CachedWindow = Window & {
        [INIT_DATA_CACHE_KEY]?: string[];
      };

      function isElemVisible(el: Element | null): el is HTMLElement {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && rect.width > 0
          && rect.height > 0;
      }

      function normalizeHref(url: string): string {
        try {
          const parsed = new URL(url, window.location.href);
          parsed.hash = '';
          return parsed.toString();
        } catch { return url; }
      }

      function extractPid(url: string): string | null {
        const pathMatch = url.match(/\/(?:item|i)\/(\d+)(?:\.html)?/i);
        if (pathMatch) return pathMatch[1];
        try {
          const parsed = new URL(url);
          const pid = parsed.searchParams.get('productId')
            ?? parsed.searchParams.get('productIds')
            ?? parsed.searchParams.get('id');
          if (pid && /^\d+$/.test(pid)) return pid;
        } catch { /* 무시 */ }

        const encodedMatch = url.match(/(?:productIds=|x_object_id%3A)(\d+)/i);
        if (encodedMatch) {
          return encodedMatch[1];
        }

        return null;
      }

      function buildCanonicalUrl(productId: string, fallbackUrl: string): string {
        try {
          const parsed = new URL(fallbackUrl, window.location.href);
          return `${parsed.protocol}//${parsed.host}/item/${productId}.html`;
        } catch {
          return `https://ko.aliexpress.com/item/${productId}.html`;
        }
      }

      function collectInitDataProductIds(): string[] {
        const cachedWindow = window as CachedWindow;
        const cached = cachedWindow[INIT_DATA_CACHE_KEY];
        if (Array.isArray(cached)) {
          return cached;
        }

        const ids: string[] = [];
        const seen = new Set<string>();
        const dida = (window as Window & {
          _dida_config_?: { _init_data_?: unknown };
        })._dida_config_?._init_data_;

        const sources: string[] = [];
        if (dida != null) {
          try {
            sources.push(JSON.stringify(dida));
          } catch {
            // ignore
          }
        }

        if (sources.length === 0) {
          const scriptText = Array.from(document.scripts)
            .map((script) => script.textContent ?? '')
            .find((text) => text.includes('window._dida_config_._init_data_'));
          if (scriptText) {
            sources.push(scriptText);
          }
        }

        for (const source of sources) {
          for (const match of source.matchAll(/productIds=(\d+)/g)) {
            const productId = match[1];
            if (!seen.has(productId)) {
              seen.add(productId);
              ids.push(productId);
            }
          }
        }

        cachedWindow[INIT_DATA_CACHE_KEY] = ids;
        return ids;
      }

      /**
       * AliExpress 검색 결과에서 상품 제목을 추출한다.
       * 셀렉터 우선순위: div.lk_z[title] → h3.lk_kx → anchor title/aria-label
       */
      function extractTitle(anchor: HTMLAnchorElement): string {
        // 전략 1: div.lk_z의 title 속성 (가장 정확, 전체 제목)
        const titleDiv = anchor.querySelector('div[class*="lk_z"][title]') as HTMLElement | null;
        if (titleDiv) {
          const t = titleDiv.getAttribute('title')?.trim();
          if (t && t.length > 2) return t.slice(0, 300);
        }
        // 전략 2: h3.lk_kx 텍스트
        const h3 = anchor.querySelector('h3') as HTMLElement | null;
        if (h3) {
          const t = h3.textContent?.trim();
          if (t && t.length > 2) return t.slice(0, 300);
        }
        // 전략 3: anchor 자체 title/aria-label
        const fallback = anchor.getAttribute('title') || anchor.getAttribute('aria-label');
        return fallback ? fallback.trim().slice(0, 300) : '';
      }

      /**
       * AliExpress 검색 결과에서 상품 가격을 추출한다.
       * 셀렉터: div.lk_gm[aria-label] → 가격 텍스트 파싱
       */
      function extractPriceInfo(anchor: HTMLAnchorElement): { price: string; currency: string } | null {
        // 전략 1: div.lk_gm의 aria-label (예: "₩128,400" — 가장 깨끗한 가격)
        const priceDiv = anchor.querySelector('div[aria-label][class*="lk_g"]') as HTMLElement | null;
        if (priceDiv) {
          const ariaLabel = priceDiv.getAttribute('aria-label') ?? '';
          // 원화 파싱
          const krwMatch = ariaLabel.match(/[₩￦]\s*([\d,.\s]+)/);
          if (krwMatch) {
            const raw = krwMatch[1].replace(/[^\d]/g, '');
            if (raw && parseInt(raw, 10) > 0) return { price: raw, currency: 'KRW' };
          }
          // USD 파싱
          const usdMatch = ariaLabel.match(/(?:US\s?\$|\$)\s*([\d,.]+)/i);
          if (usdMatch) {
            const raw = usdMatch[1].replace(/[^\d]/g, '');
            if (raw && parseInt(raw, 10) > 0) return { price: raw, currency: 'USD' };
          }
        }

        // 전략 2: div.lk_lg 내 span 텍스트 조합 (표시용 가격)
        const priceSpanContainer = anchor.querySelector('div[class*="lk_lg"], div[class*="lk_l"]') as HTMLElement | null;
        if (priceSpanContainer) {
          const spans = priceSpanContainer.querySelectorAll('span');
          const combined = Array.from(spans).map((s) => s.textContent ?? '').join('');
          const krwMatch = combined.match(/[₩￦]\s*([\d,.\s]+)/);
          if (krwMatch) {
            const raw = krwMatch[1].replace(/[^\d]/g, '');
            if (raw && parseInt(raw, 10) > 0) return { price: raw, currency: 'KRW' };
          }
          const usdMatch = combined.match(/(?:US\s?\$|\$)\s*([\d,.]+)/i);
          if (usdMatch) {
            const raw = usdMatch[1].replace(/[^\d]/g, '');
            if (raw && parseInt(raw, 10) > 0) return { price: raw, currency: 'USD' };
          }
        }

        // 전략 3: anchor 내 전체 텍스트에서 가격 패턴 검색 (최후 수단)
        const text = anchor.innerText ?? '';
        const krwMatch = text.match(/[₩￦]\s*([\d,]+)/);
        if (krwMatch) {
          const raw = krwMatch[1].replace(/[^\d]/g, '');
          if (raw && parseInt(raw, 10) > 0) return { price: raw, currency: 'KRW' };
        }

        return null;
      }

      /**
       * AliExpress 검색 결과에서 상품 이미지 URL을 추출한다.
       * 셀렉터: 첫 번째 img (nk_ac 클래스 또는 일반 img)
       */
      function extractImg(anchor: HTMLAnchorElement): string | undefined {
        const img = anchor.querySelector('img') as HTMLImageElement | null;
        if (!img) return undefined;
        return img.currentSrc || img.src || img.getAttribute('data-src') || undefined;
      }

      /**
       * AliExpress 검색 결과 카드 앵커를 찾는다.
       * 셀렉터: a.search-card-item[href*="/item/"] → a[href*="/item/"]
       */
      function findAnchors(): HTMLAnchorElement[] {
        const initDataProductIds = collectInitDataProductIds();
        const allowedProductIds = new Set(initDataProductIds);

        function filterByInitData(anchors: HTMLAnchorElement[]): HTMLAnchorElement[] {
          if (allowedProductIds.size === 0) {
            return anchors;
          }

          const grouped = new Map<string, HTMLAnchorElement>();
          for (const anchor of anchors) {
            const productId = extractPid(anchor.href);
            if (!productId || !allowedProductIds.has(productId) || grouped.has(productId)) {
              continue;
            }
            grouped.set(productId, anchor);
          }

          return initDataProductIds
            .map((productId) => grouped.get(productId))
            .filter((anchor): anchor is HTMLAnchorElement => anchor instanceof HTMLAnchorElement);
        }

        // 전략 1: search-card-item 클래스 (AliExpress 검색 결과 전용)
        const searchCards = Array.from(document.querySelectorAll(
          'a.search-card-item[href*="/item/"], a.search-card-item[href*="/i/"], a.search-card-item[href*="productIds="]'
        ))
          .filter((el): el is HTMLAnchorElement => el instanceof HTMLAnchorElement && !!el.href);
        const filteredSearchCards = filterByInitData(searchCards);
        if (filteredSearchCards.length > 0) return filteredSearchCards;
        if (searchCards.length > 0 && allowedProductIds.size === 0) return searchCards;
        // 전략 2: /item/ 패턴 링크 (일반)
        const primary = Array.from(document.querySelectorAll(
          'a[href*="/item/"], a[href*="/i/"], a[href*="productIds="], a[href*="x_object_id%3A"]'
        ))
          .filter((el): el is HTMLAnchorElement => el instanceof HTMLAnchorElement && isElemVisible(el) && !!el.href);
        const filteredPrimary = filterByInitData(primary);
        if (filteredPrimary.length > 0) return filteredPrimary;
        if (primary.length > 0 && allowedProductIds.size === 0) return primary;
        // 전략 3: aliexpress.com 도메인 내 8자리 이상 숫자 패턴
        const allLinks = Array.from(document.querySelectorAll('a[href]'))
          .filter((el): el is HTMLAnchorElement =>
            el instanceof HTMLAnchorElement && isElemVisible(el)
            && el.href.includes('aliexpress.com')
            && (/\/\d{8,}/.test(el.href) || el.href.includes('productIds=') || el.href.includes('x_object_id%3A'))
          );
        const filteredAllLinks = filterByInitData(allLinks);
        if (filteredAllLinks.length > 0) return filteredAllLinks;
        return allowedProductIds.size === 0 ? allLinks : [];
      }

      function collectNow(): Array<{
        productId: string; title: string; lprice: string; mallName: string;
        productUrl: string; imageUrl?: string; currency: string;
        platform: string; searchKeyword: string;
      }> {
        const anchors = findAnchors();
        const initDataProductIds = collectInitDataProductIds();
        const desiredOrder = new Map(initDataProductIds.map((productId, index) => [productId, index]));
        const seen = new Set<string>();
        const items: Array<{
          productId: string; title: string; lprice: string; mallName: string;
          productUrl: string; imageUrl?: string; currency: string;
          platform: string; searchKeyword: string;
        }> = [];

        for (const a of anchors) {
          const url = normalizeHref(a.href);
          const pid = extractPid(url);
          if (!pid || seen.has(pid)) continue;
          const title = extractTitle(a);
          if (!title) continue;
          const priceInfo = extractPriceInfo(a);
          seen.add(pid);
          items.push({
            productId: pid,
            title,
            lprice: priceInfo?.price ?? '0',
            mallName: 'AliExpress',
            productUrl: buildCanonicalUrl(pid, url),
            imageUrl: extractImg(a),
            currency: priceInfo?.currency ?? 'KRW',
            platform: 'ALIEXPRESS',
            searchKeyword: kw
          });
        }
        items.sort((left, right) => {
          const leftOrder = desiredOrder.get(left.productId) ?? Number.MAX_SAFE_INTEGER;
          const rightOrder = desiredOrder.get(right.productId) ?? Number.MAX_SAFE_INTEGER;
          return leftOrder - rightOrder;
        });
        return items.slice(0, max);
      }

      function scrollForLazyLoad(): void {
        const step = Math.floor(window.innerHeight * 0.7);
        const maxY = document.body.scrollHeight;
        for (let y = 0; y < Math.min(maxY, step * 3); y += step) {
          window.scrollTo(0, y);
        }
        window.scrollTo(0, 0);
      }

      // CAPTCHA 체크
      const bodyText = document.body?.innerText?.toLowerCase() ?? '';
      if (bodyText.includes('captcha') || bodyText.includes('unusual traffic') || bodyText.includes('security check')) {
        return { ok: false as const, error: 'CAPTCHA 또는 보안 확인이 감지되었습니다.' };
      }

      // 1차 스크롤로 lazy-loading 트리거
      scrollForLazyLoad();

      // DOM 폴링: 상품이 렌더링될 때까지 반복 시도
      const started = Date.now();
      while (Date.now() - started < MAX_POLL_DURATION) {
        const products = collectNow();
        if (products.length > 0) {
          return { ok: true as const, products };
        }
        // 3초마다 스크롤 재시도
        if ((Date.now() - started) % 3000 < POLL_INTERVAL) {
          scrollForLazyLoad();
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL));
      }

      // 마지막 시도
      const last = collectNow();
      if (last.length > 0) {
        return { ok: true as const, products: last };
      }

      const anchorCnt = document.querySelectorAll('a').length;
      const bodyLen = document.body?.innerText?.length ?? 0;
      return {
        ok: false as const,
        error: `상품 후보를 찾지 못했습니다. (url=${window.location.href}, anchors=${anchorCnt}, bodyText=${bodyLen}자, elapsed=${Date.now() - started}ms)`
      };
    },
    args: [keyword, maxResults]
  });

  const payload = results[0]?.result;
  if (!payload) {
    throw new Error('AliExpress 검색 스크립트 실행 결과가 비어 있습니다.');
  }
  if (!payload.ok) {
    throw new Error(payload.error);
  }
  return payload.products as AliExpressSearchProduct[];
}

export async function searchAliExpressProducts(
  keyword: string,
  maxResults = 20,
  searchUrl?: string
): Promise<AliExpressSearchProduct[]> {
  const normalizedKeyword = keyword.trim();
  if (!normalizedKeyword) {
    throw new Error('검색 키워드가 비어 있습니다.');
  }

  const tabId = await ensureSearchTab(normalizedKeyword, searchUrl);

  pushLog({
    runId: null,
    deviceId: null,
    stepIndex: null,
    action: null,
    status: 'ALIEXPRESS_SEARCH_STARTED',
    message: `브라우저 검색 시작 - keyword="${normalizedKeyword}", tabId=${tabId}`
  });

  try {
    const products = await executeSearchCollection(tabId, normalizedKeyword, maxResults);

    pushLog({
      runId: null,
      deviceId: null,
      stepIndex: null,
      action: null,
      status: 'ALIEXPRESS_SEARCH_DONE',
      message: `브라우저 검색 완료 - keyword="${normalizedKeyword}", count=${products.length}`
    });

    // 크롤링 완료 후 탭 닫기
    try {
      await chrome.tabs.remove(tabId);
    } catch { /* 탭이 이미 닫혔을 수 있음 */ }

    return products;
  } catch (error) {
    // 크롤링 실패 시에도 탭 닫기 시도
    try {
      await chrome.tabs.remove(tabId);
    } catch { /* 무시 */ }
    throw error;
  }
}
