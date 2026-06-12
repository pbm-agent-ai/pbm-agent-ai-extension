import type { AliExpressSearchProduct } from '../shared/types';

/** DOM 폴링 대기 상수 */
const POLL_INTERVAL_MS = 500;
const MAX_POLL_DURATION_MS = 12_000;
const ALIEXPRESS_INIT_DATA_CACHE_KEY = '__pbmAliExpressSearchResultIds';

function isVisible(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();

  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && rect.width > 0
    && rect.height > 0;
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url, window.location.href);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

function extractProductId(url: string): string | null {
  // /item/123.html, /i/123.html, 또는 productId 쿼리 파라미터
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

function buildCanonicalProductUrl(productId: string, fallbackUrl: string): string {
  try {
    const fallback = new URL(fallbackUrl, window.location.href);
    return `${fallback.protocol}//${fallback.host}/item/${productId}.html`;
  } catch {
    return `https://ko.aliexpress.com/item/${productId}.html`;
  }
}

function findCardRoot(anchor: HTMLAnchorElement): HTMLElement {
  let current: HTMLElement | null = anchor;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    const text = current.innerText?.trim() ?? '';
    const hasImage = !!current.querySelector('img');
    // 상품 카드: 이미지 + 최소한의 텍스트(제목+가격) 포함
    if (hasImage && text.length >= 10) {
      return current;
    }
    current = current.parentElement;
  }
  return anchor;
}

function extractTitle(anchor: HTMLAnchorElement, card: HTMLElement): string {
  const candidates = [
    anchor.getAttribute('title'),
    anchor.getAttribute('aria-label'),
    // h3/h2 등 제목 태그 우선
    card.querySelector('h1, h2, h3, h4')?.textContent,
    card.querySelector('[title]')?.getAttribute('title'),
    card.querySelector('img[alt]')?.getAttribute('alt'),
    anchor.textContent,
    card.innerText
  ];

  return (candidates.find((value) => value != null && value.trim().length > 4) ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function extractPrice(card: HTMLElement): { price: string; currency: string } | null {
  const text = card.innerText?.replace(/\s+/g, ' ').trim() ?? '';

  // 원화 가격 (₩12,345 또는 ￦12,345)
  const krwMatch = text.match(/[₩￦]\s*([\d,.]+)/);
  if (krwMatch) {
    return { price: krwMatch[1].replace(/[^\d]/g, ''), currency: 'KRW' };
  }

  // USD 가격
  const usdMatch = text.match(/(?:US\s?\$|\$)\s*([\d,.]+)/i);
  if (usdMatch) {
    return { price: usdMatch[1].replace(/[^\d]/g, ''), currency: 'USD' };
  }

  // 숫자만 있는 가격 패턴 (3자리 이상, 쉼표 또는 공백 구분)
  const genericMatch = text.match(/\b([\d]{1,3}(?:[,\s][\d]{3})+)\b/);
  if (genericMatch) {
    return { price: genericMatch[1].replace(/[^\d]/g, ''), currency: 'KRW' };
  }

  return null;
}

function extractImageUrl(card: HTMLElement): string | undefined {
  const image = card.querySelector('img');
  if (!(image instanceof HTMLImageElement)) {
    return undefined;
  }

  return image.currentSrc
    || image.src
    || image.getAttribute('data-src')
    || image.getAttribute('src')
    || undefined;
}

function readAliExpressInitDataObject(): unknown {
  const globalConfig = (window as Window & {
    _dida_config_?: { _init_data_?: unknown };
  })._dida_config_;
  return globalConfig?._init_data_ ?? null;
}

function extractAliExpressSearchResultIdsFromInitData(): string[] {
  const cached = (window as Window & {
    [ALIEXPRESS_INIT_DATA_CACHE_KEY]?: string[];
  })[ALIEXPRESS_INIT_DATA_CACHE_KEY];
  if (cached) {
    return cached;
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  const sources: string[] = [];
  const initData = readAliExpressInitDataObject();
  if (initData != null) {
    try {
      sources.push(JSON.stringify(initData));
    } catch {
      // ignore stringify failure and fall through to script scan
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

  (window as Window & {
    [ALIEXPRESS_INIT_DATA_CACHE_KEY]?: string[];
  })[ALIEXPRESS_INIT_DATA_CACHE_KEY] = ids;

  return ids;
}

function isCaptchaBlocked(): boolean {
  const text = document.body?.innerText?.toLowerCase() ?? '';
  return text.includes('captcha')
    || text.includes('sorry, we have detected unusual traffic')
    || text.includes('security check');
}

/**
 * 페이지에서 상품 링크(<a>) 목록을 찾는다.
 * AliExpress가 프론트엔드를 변경해도 대응할 수 있도록 다중 셀렉터 전략 사용.
 */
function findProductAnchors(): HTMLAnchorElement[] {
  const initDataProductIds = extractAliExpressSearchResultIdsFromInitData();
  const allowedProductIds = new Set(initDataProductIds);

  // 전략 1: 기존 URL 패턴 매칭
  const primary = Array.from(
    document.querySelectorAll('a[href*="/item/"], a[href*="/i/"], a[href*="productIds="], a[href*="x_object_id%3A"]')
  ).filter((el): el is HTMLAnchorElement =>
    el instanceof HTMLAnchorElement && isVisible(el) && !!el.href
  );
  const filterByInitData = (anchors: HTMLAnchorElement[]): HTMLAnchorElement[] => {
    if (allowedProductIds.size === 0) {
      return anchors;
    }

    const grouped = new Map<string, HTMLAnchorElement>();
    for (const anchor of anchors) {
      const productId = extractProductId(anchor.href);
      if (!productId || !allowedProductIds.has(productId) || grouped.has(productId)) {
        continue;
      }
      grouped.set(productId, anchor);
    }

    return initDataProductIds
      .map((productId) => grouped.get(productId))
      .filter((anchor): anchor is HTMLAnchorElement => anchor instanceof HTMLAnchorElement);
  };

  const filteredPrimary = filterByInitData(primary);
  if (filteredPrimary.length > 0) return filteredPrimary;
  if (primary.length > 0 && allowedProductIds.size === 0) return primary;

  // 전략 2: productId 쿼리 파라미터가 있는 링크
  const withProductId = Array.from(
    document.querySelectorAll('a[href*="productId="], a[href*="productIds="]')
  ).filter((el): el is HTMLAnchorElement =>
    el instanceof HTMLAnchorElement && isVisible(el) && !!el.href
  );
  const filteredWithProductId = filterByInitData(withProductId);
  if (filteredWithProductId.length > 0) return filteredWithProductId;
  if (withProductId.length > 0 && allowedProductIds.size === 0) return withProductId;

  // 전략 3: aliexpress.com 도메인 내 숫자 ID 패턴 링크
  const allLinks = Array.from(document.querySelectorAll('a[href]'))
    .filter((el): el is HTMLAnchorElement => {
      if (!(el instanceof HTMLAnchorElement) || !isVisible(el)) return false;
      const href = el.href;
      return href.includes('aliexpress.com')
        && (/\/\d{8,}/.test(href) || href.includes('productIds=') || href.includes('x_object_id%3A'));
    });
  const filteredAllLinks = filterByInitData(allLinks);
  if (filteredAllLinks.length > 0) return filteredAllLinks;
  return allowedProductIds.size === 0 ? allLinks : [];
}

/**
 * 현재 DOM에서 즉시 상품 목록을 추출한다 (동기).
 */
function extractProductsNow(keyword: string, maxResults: number): AliExpressSearchProduct[] {
  const anchors = findProductAnchors();
  const initDataProductIds = extractAliExpressSearchResultIdsFromInitData();
  const desiredOrder = new Map(initDataProductIds.map((productId, index) => [productId, index]));

  const seen = new Set<string>();
  const products: AliExpressSearchProduct[] = [];

  for (const anchor of anchors) {
    const productUrl = normalizeUrl(anchor.href);
    const productId = extractProductId(productUrl);
    if (!productId || seen.has(productId)) {
      continue;
    }

    const card = findCardRoot(anchor);
    const title = extractTitle(anchor, card);
    const priceInfo = extractPrice(card);

    // 제목만 있으면 가격 없어도 일단 수집 (가격은 null-safe)
    if (!title) {
      continue;
    }

    seen.add(productId);
    products.push({
      productId,
      title,
      lprice: priceInfo?.price ?? '0',
      mallName: 'AliExpress',
      productUrl: buildCanonicalProductUrl(productId, productUrl),
      imageUrl: extractImageUrl(card),
      currency: priceInfo?.currency ?? 'KRW',
      platform: 'ALIEXPRESS',
      searchKeyword: keyword
    });
  }

  products.sort((left, right) => {
    const leftOrder = desiredOrder.get(left.productId) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = desiredOrder.get(right.productId) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder;
  });

  return products.slice(0, maxResults);
}

/**
 * 스크롤을 수행하여 lazy-loading 상품 카드를 트리거한다.
 */
function triggerLazyLoading(): void {
  const scrollStep = Math.floor(window.innerHeight * 0.7);
  const maxScroll = document.body.scrollHeight;
  // 3단계로 스크롤 다운 후 맨 위로 복귀
  for (let y = 0; y < Math.min(maxScroll, scrollStep * 3); y += scrollStep) {
    window.scrollTo(0, y);
  }
  window.scrollTo(0, 0);
}

/**
 * AliExpress 검색 결과를 비동기로 수집한다.
 *
 * SPA 동적 렌더링에 대응하기 위해 DOM을 폴링하며 상품 링크가 나타날 때까지 대기한다.
 * 백그라운드 탭에서도 lazy-loading을 트리거하기 위해 스크롤을 수행한다.
 */
export async function collectAliExpressSearchResults(
  keyword: string,
  maxResults = 20
): Promise<AliExpressSearchProduct[]> {
  if (isCaptchaBlocked()) {
    throw new Error('AliExpress 검색 페이지에서 CAPTCHA 또는 보안 확인이 감지되었습니다.');
  }

  // 1차 스크롤로 lazy-loading 트리거
  triggerLazyLoading();

  const startedAt = Date.now();
  let lastProducts: AliExpressSearchProduct[] = [];

  // DOM 폴링: 상품이 렌더링될 때까지 반복 시도
  while (Date.now() - startedAt < MAX_POLL_DURATION_MS) {
    lastProducts = extractProductsNow(keyword, maxResults);

    if (lastProducts.length > 0) {
      console.info('[aliexpressSearchCollector] 상품 수집 완료', {
        count: lastProducts.length,
        elapsedMs: Date.now() - startedAt,
        initDataIds: extractAliExpressSearchResultIdsFromInitData().slice(0, maxResults),
        firstProducts: lastProducts.slice(0, 5).map((product) => ({
          productId: product.productId,
          title: product.title,
          price: product.lprice,
          productUrl: product.productUrl
        }))
      });
      return lastProducts;
    }

    // 중간 스크롤 재시도 (3초마다)
    if ((Date.now() - startedAt) % 3000 < POLL_INTERVAL_MS) {
      triggerLazyLoading();
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  // 마지막 시도
  lastProducts = extractProductsNow(keyword, maxResults);
  if (lastProducts.length > 0) {
    return lastProducts;
  }

  // 디버그 정보 포함 에러
  const anchorCount = document.querySelectorAll('a').length;
  const bodyTextLen = document.body?.innerText?.length ?? 0;
  throw new Error(
    `AliExpress 검색 결과에서 상품 후보를 찾지 못했습니다. ` +
    `(url=${window.location.href}, anchors=${anchorCount}, bodyText=${bodyTextLen}자, ` +
    `elapsed=${Date.now() - startedAt}ms)`
  );
}
