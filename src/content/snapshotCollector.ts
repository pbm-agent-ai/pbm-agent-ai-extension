import type { InteractiveElement, OptionGroup, PageSnapshot } from '../shared/types';
import { dismissPopups } from './popupDismisser';

const MAX_INTERACTIVE_ELEMENTS = 160;
const MAX_VISIBLE_TEXT_LENGTH = 1000;

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function isVisible(element: Element): boolean {
  const htmlElement = element as HTMLElement;
  const style = window.getComputedStyle(htmlElement);
  const rect = htmlElement.getBoundingClientRect();

  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function buildNodeId(element: Element, index: number): string {
  const htmlElement = element as HTMLElement;
  const preferred = htmlElement.getAttribute('data-pbm-node-id');

  if (preferred) {
    return preferred;
  }

  const path = [element.tagName.toLowerCase()];
  if (htmlElement.id) {
    path.push(`id:${htmlElement.id}`);
  }
  if (htmlElement.getAttribute('aria-label')) {
    path.push(`aria:${htmlElement.getAttribute('aria-label')}`);
  }

  return `node-${index}-${path.join('|')}`;
}

/** 헤더/nav/footer 안에 있는 요소인지 확인 (UI 크롬 링크 → 상품 탐색에 불필요) */
function isInNavigationArea(element: Element): boolean {
  let parent = element.parentElement;
  while (parent) {
    const tag = parent.tagName.toLowerCase();
    if (tag === 'header' || tag === 'nav' || tag === 'footer') {
      return true;
    }
    const role = parent.getAttribute('role');
    if (role === 'navigation' || role === 'banner') {
      return true;
    }
    parent = parent.parentElement;
  }
  return false;
}

function collectInteractiveElements(): InteractiveElement[] {
  const all = Array.from(
    document.querySelectorAll('button, a, input:not([type="password"]), select, textarea, [role="button"], [role="option"]')
  ).filter(isVisible);

  // 헤더/nav/footer 링크 제외한 컨텐츠 요소 우선, 나머지 뒤에 붙임
  const contentElements = all.filter(el => !isInNavigationArea(el));
  const navElements = all.filter(el => isInNavigationArea(el));
  const candidates = [...contentElements, ...navElements];
  const purchaseLikeBeforeSlice = candidates
    .map((element, index) => {
      const html = element as HTMLElement;
      const label =
        html.innerText?.trim() ||
        html.textContent?.trim() ||
        html.getAttribute('aria-label') ||
        html.getAttribute('value') ||
        '';
      return {
        index,
        tag: element.tagName.toLowerCase(),
        role: html.getAttribute('role'),
        label,
        id: html.id || null,
        className: html.className || null
      };
    })
    .filter((item) =>
      item.label.includes('구매하기') ||
      item.label.includes('바로구매') ||
      item.label.includes('장바구니') ||
      item.label.toLowerCase().includes('buy now') ||
      item.label.toLowerCase().includes('add to cart')
    );

  const productLikeBeforeSlice = candidates
    .map((element, index) => {
      const html = element as HTMLAnchorElement;
      const label =
        html.innerText?.trim() ||
        html.textContent?.trim() ||
        html.getAttribute('aria-label') ||
        html.getAttribute('value') ||
        '';
      return {
        index,
        tag: element.tagName.toLowerCase(),
        label,
        href: element.tagName.toLowerCase() === 'a' ? html.href || '' : '',
        dataShpContentsId: (element as HTMLElement).getAttribute('data-shp-contents-id') || null
      };
    })
    .filter((item) =>
      item.href.includes('/catalog/') ||
      item.href.includes('nvMid=') ||
      item.href.includes('cr.shopping.naver.com/adcr') ||
      item.dataShpContentsId !== null
    );

  console.info('[snapshotCollector] interactiveElements 원본 개수', {
    all: all.length,
    content: contentElements.length,
    nav: navElements.length,
    candidates: candidates.length,
    max: MAX_INTERACTIVE_ELEMENTS
  });
  console.info('[snapshotCollector] 상품 후보 (slice 전)', productLikeBeforeSlice.slice(0, 20));
  console.info('[snapshotCollector] 구매 버튼 후보 (slice 전)', purchaseLikeBeforeSlice.slice(0, 10));

  const sliced = candidates.slice(0, MAX_INTERACTIVE_ELEMENTS);
  const purchaseLikeAfterSlice = sliced
    .map((element, index) => {
      const html = element as HTMLElement;
      const label =
        html.innerText?.trim() ||
        html.textContent?.trim() ||
        html.getAttribute('aria-label') ||
        html.getAttribute('value') ||
        '';
      return {
        index,
        tag: element.tagName.toLowerCase(),
        role: html.getAttribute('role'),
        label
      };
    })
    .filter((item) =>
      item.label.includes('구매하기') ||
      item.label.includes('바로구매') ||
      item.label.includes('장바구니') ||
      item.label.toLowerCase().includes('buy now') ||
      item.label.toLowerCase().includes('add to cart')
    );

  const productLikeAfterSlice = sliced
    .map((element, index) => {
      const html = element as HTMLAnchorElement;
      const label =
        html.innerText?.trim() ||
        html.textContent?.trim() ||
        html.getAttribute('aria-label') ||
        html.getAttribute('value') ||
        '';
      return {
        index,
        tag: element.tagName.toLowerCase(),
        label,
        href: element.tagName.toLowerCase() === 'a' ? html.href || '' : '',
        dataShpContentsId: (element as HTMLElement).getAttribute('data-shp-contents-id') || null
      };
    })
    .filter((item) =>
      item.href.includes('/catalog/') ||
      item.href.includes('nvMid=') ||
      item.href.includes('cr.shopping.naver.com/adcr') ||
      item.dataShpContentsId !== null
    );

  console.info('[snapshotCollector] 상품 후보 (slice 후)', productLikeAfterSlice.slice(0, 20));
  console.info('[snapshotCollector] 구매 버튼 후보 (slice 후)', purchaseLikeAfterSlice.slice(0, 10));

  return sliced.map((element, index) => {
    const htmlElement = element as HTMLElement;
    const labelText = truncate(
      htmlElement.innerText?.trim() ||
        htmlElement.textContent?.trim() ||  // .blind 등 CSS로 숨긴 텍스트도 캡처
        htmlElement.getAttribute('aria-label') ||
        htmlElement.getAttribute('placeholder') ||
        htmlElement.getAttribute('value') ||
        '',
      150  // 상품명+가격 충분히 담기도록 100→150
    );

    // <a> 태그의 href 수집 (상품 URL productId 매칭에 사용)
    const href = element.tagName.toLowerCase() === 'a'
      ? (element as HTMLAnchorElement).href || undefined
      : undefined;

    return {
      nodeId: buildNodeId(element, index),
      role: htmlElement.getAttribute('role') || element.tagName.toLowerCase(),
      labelText,
      selector: htmlElement.id ? `#${htmlElement.id}` : undefined,
      href,
      isVisible: true,
      disabled:
        htmlElement.hasAttribute('disabled') ||
        htmlElement.getAttribute('aria-disabled') === 'true'
    };
  });
}

function collectVisibleTextSummary(): string {
  const text = document.body?.innerText?.replace(/\s+/g, ' ').trim() || '';
  return truncate(text, MAX_VISIBLE_TEXT_LENGTH);
}

function isSmartstoreProductDetailPage(url: string): boolean {
  const lower = url.toLowerCase();
  const host = (() => {
    try {
      return new URL(lower).host;
    } catch {
      return '';
    }
  })();

  return (
    host.includes('smartstore.naver.com') &&
    (lower.includes('/products/') || lower.includes('/p/') || lower.includes('/products?') || lower.includes('/products#'))
  );
}

function collectOptionGroups(): OptionGroup[] {
  const currentUrl = window.location.href || '';

  if (!isSmartstoreProductDetailPage(currentUrl)) {
    console.info('[snapshotCollector] SMARTSTORE PRODUCT_DETAIL 아님 → optionGroups 수집 생략', {
      currentUrl
    });
    return [];
  }

  // 1) 스마트스토어 라디오 버튼형 옵션 수집
  const radioGroups = collectSmartstoreRadioOptionGroups();

  // 2) 스마트스토어 토글/드롭다운형 옵션 수집
  const toggleGroups = collectSmartstoreToggleOptionGroups();

  return [...radioGroups, ...toggleGroups];
}

/** 스마트스토어 버튼형( role=radio ) 옵션 수집 */
function collectSmartstoreRadioOptionGroups(): OptionGroup[] {
  const radios = Array.from(document.querySelectorAll('button[role="radio"][data-shp-contents-grp="form"]')).slice(0, 30);
  const grouped = new Map<string, { groupName: string; nodeId: string; selector?: string; options: string[]; selectedOption?: string }>();

  radios.forEach((radio, index) => {
    const htmlRadio = radio as HTMLButtonElement;
    const groupName = htmlRadio.getAttribute('data-shp-contents-type')?.trim() || '옵션';
    const optionName = htmlRadio.getAttribute('data-shp-contents-id')?.trim()
      || htmlRadio.textContent?.replace(/\s+/g, ' ').trim()
      || `option-${index}`;
    const nodeId = htmlRadio.getAttribute('data-pbm-node-id')
      || `smartstore-radio-${index}-${groupName.replace(/\s+/g, '-').toLowerCase()}`;
    htmlRadio.setAttribute('data-pbm-node-id', nodeId);

    const key = `${groupName}`;
    const current = grouped.get(key) ?? {
      groupName: truncate(groupName, 80),
      nodeId,
      selector: undefined,
      options: [],
      selectedOption: undefined
    };
    if (!current.options.includes(optionName)) {
      current.options.push(optionName);
    }
    if (htmlRadio.getAttribute('aria-checked') === 'true') {
      current.selectedOption = optionName;
      current.selector = current.selector ?? `button[role="radio"][data-shp-contents-type="${groupName}"]`;
    }
    grouped.set(key, current);
  });

  return Array.from(grouped.values())
    .filter((group) => group.options.length > 1 || group.selectedOption != null);
}

/** 스마트스토어 토글/드롭다운형 옵션 수집 */
function collectSmartstoreToggleOptionGroups(): OptionGroup[] {
  const toggles = Array.from(
    document.querySelectorAll('.option [role="button"][aria-haspopup="listbox"], .option a[role="button"][aria-haspopup="listbox"]')
  ).slice(0, 30);

  return toggles.map((toggle, index) => {
    const htmlToggle = toggle as HTMLAnchorElement;
    const groupName = htmlToggle.getAttribute('data-shp-contents-type')?.trim()
      || (htmlToggle.textContent?.split('/')[0]?.trim() || '옵션');

    const fullLabel = htmlToggle.textContent?.replace(/\s+/g, ' ').trim() || '';
    const currentSelected = htmlToggle.getAttribute('data-shp-contents-id')?.trim()
      || (fullLabel.includes('/') ? fullLabel.split('/').slice(1).join('/').trim() : undefined)
      || undefined;

    const listbox = htmlToggle.parentElement?.querySelector('[role="listbox"]');
    const options = Array.from(listbox?.querySelectorAll('[role="option"]') ?? [])
      .map((item) => item.textContent?.replace(/\s+/g, ' ').trim() || '')
      .filter(Boolean)
      .slice(0, 20);

    const nodeId = htmlToggle.getAttribute('data-pbm-node-id')
      || `smartstore-toggle-${index}-${groupName.replace(/\s+/g, '-').toLowerCase()}`;
    htmlToggle.setAttribute('data-pbm-node-id', nodeId);

    return {
      groupName: truncate(groupName, 80),
      nodeId,
      selector: htmlToggle.id ? `#${htmlToggle.id}` : undefined,
      options,
      selectedOption: currentSelected
    };
  }).filter((group) => group.options.length > 0 || group.selectedOption != null);
}

const MAX_RAW_HTML_LENGTH = 80000;

/**
 * 불필요한 태그(script, style, svg, noscript, iframe, link[rel=stylesheet])를 제거하여
 * AI가 분석할 실제 콘텐츠 HTML만 추출한다.
 *
 * 배경: 네이버 카탈로그 페이지 등은 <script>, <style>, <svg> 태그가 HTML 앞쪽에
 * 대량 포함되어 있어 80KB 제한 시 판매처 행의 adcr 링크가 잘리는 문제가 있었다.
 * 불필요한 태그를 제거하면 실제 콘텐츠(판매처 행 + adcr 링크)가 80KB 안에 들어온다.
 */
function collectRawHtml(): string {
  // DOM을 복제해서 원본 페이지에 영향 없이 정리
  const cloned = document.documentElement?.cloneNode(true) as HTMLElement;
  if (!cloned) return '';

  // AI 분석에 불필요한 태그들을 제거 (콘텐츠 용량 확보)
  const removeTags = ['script', 'style', 'svg', 'noscript', 'iframe', 'link[rel="stylesheet"]', 'link[rel="preload"]', 'meta'];
  for (const selector of removeTags) {
    cloned.querySelectorAll(selector).forEach(el => el.remove());
  }

  // 네이버 헤더/네비게이션/푸터 제거 — 검색 결과 콘텐츠만 남겨 용량 확보
  cloned.querySelectorAll('header, nav, footer, [role="navigation"], [role="banner"]').forEach(el => el.remove());

  // 네이버 검색 결과 광고 상품 영역 제거 — 일반 상품 영역에 80KB 용량 확보
  // ★ data-shp-* 속성 제거보다 먼저 실행해야 함 (속성이 있어야 광고 판별 가능)
  // 광고 상품은 data-shp-contents-grp="ad" 속성으로 식별
  let adRemovedCount = 0;
  cloned.querySelectorAll('[data-shp-contents-grp="ad"]').forEach(el => {
    const card = el.closest('li') || el.closest('[class*="product_item"]') || el;
    card.remove();
    adRemovedCount++;
  });
  if (adRemovedCount > 0) {
    console.info('[snapshotCollector] 광고 상품 제거', { 제거수: adRemovedCount });
  }

  // data-* 속성 중 AI에 불필요한 대용량 인라인 데이터 제거
  // data-shp-* 속성은 네이버 쇼핑 추적/분석용으로 상품당 수KB를 차지하므로 제거
  // 단, data-shp-contents-id(productId)는 AI 상품 매칭에 필수이므로 보존
  cloned.querySelectorAll('*').forEach(el => {
    const attrs = Array.from(el.attributes);
    for (const attr of attrs) {
      if (attr.name === 'data-shp-contents-id') continue; // productId 보존
      if (attr.name.startsWith('data-shp-')
          || attr.name === 'data-react-props'
          || attr.name === 'data-state'
          || attr.name === 'data-initial-state'
          || attr.name.startsWith('data-nlog')
          || attr.name.startsWith('data-log')) {
        el.removeAttribute(attr.name);
      }
    }
  });

  // adcr 리다이렉트 URL 단축 — 원본 1KB+ → nvMid 파라미터만 보존
  // AI는 href의 존재와 nvMid(productId)만 필요하고 추적 파라미터는 불필요
  cloned.querySelectorAll('a[href*="cr.shopping.naver.com/adcr"]').forEach(el => {
    const href = el.getAttribute('href') || '';
    const nvMidMatch = href.match(/nvMid=(\d+)/);
    if (nvMidMatch) {
      el.setAttribute('href', `https://cr.shopping.naver.com/adcr?nvMid=${nvMidMatch[1]}`);
    }
  });

  // ader.naver.com 광고 리다이렉트 URL 단축 — 원본 수KB → 최소화
  // (광고 상품은 위에서 대부분 제거되지만, 남은 것이 있을 경우 용량 절약)
  cloned.querySelectorAll('a[href*="ader.naver.com"]').forEach(el => {
    el.setAttribute('href', 'https://ader.naver.com/ad');
  });

  // HTML 주석 제거
  const html = cloned.outerHTML.replace(/<!--[\s\S]*?-->/g, '');

  // 연속 공백/줄바꿈 압축 (가독성보다 용량 절약 우선)
  const compacted = html.replace(/\s{2,}/g, ' ');

  const originalLength = document.documentElement?.outerHTML?.length || 0;
  const cleanedLength = compacted.length;
  console.info('[snapshotCollector] rawHtml 정리 결과', {
    원본크기: originalLength,
    정리후크기: cleanedLength,
    절약률: `${Math.round((1 - cleanedLength / originalLength) * 100)}%`,
    잘림여부: cleanedLength > MAX_RAW_HTML_LENGTH
  });

  return compacted.length > MAX_RAW_HTML_LENGTH
    ? compacted.slice(0, MAX_RAW_HTML_LENGTH) + '...(truncated)'
    : compacted;
}

function collectPriceCandidates(): string[] {
  const text = document.body?.innerText || '';
  const matches = text.match(/(?:US\s?\$|\$|₩|KRW\s?)[\d,.]+/g) ?? [];
  return Array.from(new Set(matches)).slice(0, 10);
}

function collectCurrencyCandidates(priceCandidates: string[]): string[] {
  const currencies = new Set<string>();

  priceCandidates.forEach((candidate) => {
    if (candidate.includes('₩') || candidate.includes('KRW')) {
      currencies.add('KRW');
    }
    if (candidate.includes('$') || candidate.includes('US')) {
      currencies.add('USD');
    }
  });

  return Array.from(currencies);
}

export async function collectSnapshot(): Promise<PageSnapshot> {
  // 스냅샷 수집 전 팝업/모달 자동 닫기 (백엔드가 팝업 없는 깨끗한 페이지를 보도록)
  const dismissedCount = await dismissPopups();
  if (dismissedCount > 0) {
    console.info(`[snapshotCollector] 팝업 ${dismissedCount}개 닫음`);
  }

  const interactiveElements = collectInteractiveElements();
  const priceCandidates = collectPriceCandidates();

  return {
    currentUrl: window.location.href,
    title: document.head?.getAttribute('title') || document.title,
    visibleTextSummary: collectVisibleTextSummary(),
    interactiveElements,
    optionGroups: collectOptionGroups(),
    priceCandidates,
    currencyCandidates: collectCurrencyCandidates(priceCandidates),
    rawHtml: collectRawHtml(),
    capturedAt: new Date().toISOString()
  };
}
