import type { InteractiveElement, LoginFormSnapshot, OptionGroup, PageSnapshot } from '../shared/types';
import { dismissPopups } from './popupDismisser';

const MAX_INTERACTIVE_ELEMENTS = 160;
const MAX_VISIBLE_TEXT_LENGTH = 1000;
const ALIEXPRESS_INIT_DATA_CACHE_KEY = '__pbmAliExpressSearchResultIds';

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

function isAliExpressProductDetailPage(url: string): boolean {
  const lower = url.toLowerCase();
  const host = (() => {
    try {
      return new URL(lower).host;
    } catch {
      return '';
    }
  })();

  return host.includes('aliexpress.com') && (lower.includes('/item/') || lower.includes('/i/'));
}

function isAliExpressSearchResultsPage(url: string): boolean {
  const lower = url.toLowerCase();
  const host = (() => {
    try {
      return new URL(lower).host;
    } catch {
      return '';
    }
  })();

  return host.includes('aliexpress.com')
    && (lower.includes('/w/wholesale-') || lower.includes('searchtext=') || lower.includes('keyword=') || lower.includes('q='));
}

function extractAliExpressProductIdFromHref(url: string): string | null {
  const pathMatch = url.match(/\/(?:item|i)\/(\d+)(?:\.html)?/i);
  if (pathMatch) {
    return pathMatch[1];
  }

  try {
    const parsed = new URL(url, window.location.href);
    const productId = parsed.searchParams.get('productId')
      ?? parsed.searchParams.get('productIds')
      ?? parsed.searchParams.get('id');
    if (productId && /^\d+$/.test(productId)) {
      return productId;
    }
  } catch {
    // ignore
  }

  const encodedMatch = url.match(/(?:productIds=|x_object_id%3A)(\d+)/i);
  return encodedMatch?.[1] ?? null;
}

function collectAliExpressSearchResultIdsFromInitData(): string[] {
  const cached = (window as Window & {
    [ALIEXPRESS_INIT_DATA_CACHE_KEY]?: string[];
  })[ALIEXPRESS_INIT_DATA_CACHE_KEY];
  if (cached) {
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
      // ignore stringify error
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

function isAliExpressSkuOptionElement(element: Element): element is HTMLElement {
  return element instanceof HTMLElement && element.hasAttribute('data-sku-col');
}

function isAliExpressSearchResultAnchor(element: Element): element is HTMLAnchorElement {
  if (!(element instanceof HTMLAnchorElement) || !element.href) {
    return false;
  }

  const href = element.href.toLowerCase();
  const initDataProductIds = collectAliExpressSearchResultIdsFromInitData();
  const productId = extractAliExpressProductIdFromHref(element.href);

  if (initDataProductIds.length > 0 && (!productId || !initDataProductIds.includes(productId))) {
    return false;
  }

  return href.includes('aliexpress.com')
    && (
      href.includes('/item/')
      || href.includes('/i/')
      || (href.includes('/ssr/') && href.includes('productids='))
    );
}

function normalizeAliExpressText(value: string | null | undefined): string {
  return value?.replace(/\s+/g, ' ').trim() ?? '';
}

function extractAliExpressOptionRawLabel(element: HTMLElement): string {
  const directLabel = normalizeAliExpressText(
    element.getAttribute('data-pbm-option-label')
    || element.getAttribute('aria-label')
    || element.getAttribute('title')
    || element.querySelector('img[alt]')?.getAttribute('alt')
    || element.textContent
  );

  return directLabel || element.getAttribute('data-sku-col') || '옵션';
}

function longestCommonPrefix(values: string[]): string {
  if (values.length === 0) {
    return '';
  }

  let prefix = values[0];
  for (let index = 1; index < values.length; index += 1) {
    while (prefix && !values[index].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
    if (!prefix) {
      return '';
    }
  }

  return prefix;
}

function simplifyAliExpressOptionLabels(rawLabels: string[]): string[] {
  const cleaned = rawLabels.map((label) => normalizeAliExpressText(label));
  const nonEmpty = cleaned.filter(Boolean);
  if (nonEmpty.length < 2) {
    return cleaned;
  }

  let prefix = longestCommonPrefix(nonEmpty);
  if (prefix) {
    // 공통 접두사가 단어 중간에서 끊긴 경우 마지막 토큰을 제거한다.
    prefix = prefix.replace(/[^\s\-_/()[\]:]+$/, '').trimEnd();
  }

  if (!prefix || prefix.length < 3) {
    return cleaned;
  }

  const simplified = cleaned.map((label) => {
    if (!label.startsWith(prefix)) {
      return label;
    }
    const stripped = label.slice(prefix.length).replace(/^[-:/|)\]]+\s*/, '').trim();
    return stripped || label;
  });

  const uniqueCount = new Set(simplified.filter(Boolean)).size;
  return uniqueCount >= 2 ? simplified : cleaned;
}

function extractAliExpressOptionLabel(element: HTMLElement): string {
  const row = element.closest('[data-sku-row]');
  if (!row) {
    return extractAliExpressOptionRawLabel(element);
  }

  const optionElements = Array.from(row.querySelectorAll('[data-sku-col]'))
    .filter((candidate): candidate is HTMLElement => candidate instanceof HTMLElement);
  const rawLabels = optionElements.map(extractAliExpressOptionRawLabel);
  const simplifiedLabels = simplifyAliExpressOptionLabels(rawLabels);
  const index = optionElements.indexOf(element);
  const label = index >= 0 ? simplifiedLabels[index] : '';

  return normalizeAliExpressText(label) || extractAliExpressOptionRawLabel(element);
}

function inferAliExpressOptionGroupName(row: HTMLElement, index: number): string {
  const wrapper = row.parentElement;
  const candidateTexts: string[] = [];

  let previousSibling = row.previousElementSibling as HTMLElement | null;
  while (previousSibling && candidateTexts.length < 3) {
    const text = normalizeAliExpressText(previousSibling.textContent);
    if (text && text.length <= 40) {
      candidateTexts.push(text);
    }
    previousSibling = previousSibling.previousElementSibling as HTMLElement | null;
  }

  if (wrapper) {
    const titled = Array.from(wrapper.querySelectorAll<HTMLElement>(
      '[class*="sku-item--title"], [class*="sku-item--name"], [class*="sku-title"], [class*="title"]'
    ))
      .map((element) => normalizeAliExpressText(element.textContent))
      .filter((text) => text && text.length <= 40);
    candidateTexts.push(...titled);
  }

  const best = candidateTexts.find(Boolean);
  return best?.replace(/[:：]\s*$/, '') || `옵션 ${index + 1}`;
}

function collectAliExpressOptionGroups(): OptionGroup[] {
  const rows = Array.from(document.querySelectorAll('[data-sku-row]'))
    .filter((row): row is HTMLElement => row instanceof HTMLElement)
    .slice(0, 20);

  return rows.map((row, index) => {
    const optionElements = Array.from(row.querySelectorAll('[data-sku-col]'))
      .filter((element): element is HTMLElement => element instanceof HTMLElement);

    const rawLabels = optionElements.map(extractAliExpressOptionRawLabel);
    const normalizedOptionLabels = simplifyAliExpressOptionLabels(rawLabels)
      .map((label) => normalizeAliExpressText(label));

    const selectedIndex = optionElements.findIndex((element) => /selected/i.test(element.className));
    const selectedOption = selectedIndex >= 0 ? normalizedOptionLabels[selectedIndex] : undefined;
    const anyEnabled = optionElements.some((element) => !/disabled/i.test(element.className) && element.getAttribute('aria-disabled') !== 'true');

    return {
      groupName: truncate(inferAliExpressOptionGroupName(row, index), 80),
      options: Array.from(new Set(normalizedOptionLabels.filter(Boolean))),
      selectedOption,
      disabled: anyEnabled ? undefined : true
    };
  }).filter((group) =>
    group.options.length > 1 || group.selectedOption != null || group.disabled === true
  );
}

function extractInteractiveLabel(element: HTMLElement): string {
  if (element.hasAttribute('data-sku-col')) {
    return extractAliExpressOptionLabel(element);
  }

  return normalizeAliExpressText(
    element.innerText
      || element.textContent
      || element.getAttribute('aria-label')
      || element.getAttribute('placeholder')
      || element.getAttribute('value')
  );
}

function buildInteractiveSelector(element: HTMLElement, nodeId: string): string | undefined {
  if (element.id) {
    return `#${element.id}`;
  }
  if (element.hasAttribute('data-sku-col')) {
    const skuRow = element.closest('[data-sku-row]')?.getAttribute('data-sku-row');
    const skuCol = element.getAttribute('data-sku-col');
    if (skuRow && skuCol) {
      return `[data-sku-row="${skuRow}"] [data-sku-col="${skuCol}"]`;
    }
    if (skuCol) {
      return `[data-sku-col="${skuCol}"]`;
    }
    return `[data-pbm-node-id="${nodeId}"]`;
  }
  return undefined;
}

function inferInteractiveRole(element: HTMLElement): string {
  if (element.hasAttribute('data-sku-col')) {
    return 'button';
  }

  return element.getAttribute('role') || element.tagName.toLowerCase();
}

function collectInteractiveElements(): InteractiveElement[] {
  const aliExpressDetail = isAliExpressProductDetailPage(window.location.href);
  const aliExpressSearchResults = isAliExpressSearchResultsPage(window.location.href);
  const aliExpressSearchResultIds = aliExpressSearchResults ? collectAliExpressSearchResultIdsFromInitData() : [];
  const selector = aliExpressDetail
    ? 'button, a, input:not([type="password"]), select, textarea, [role="button"], [role="option"], [data-sku-col]'
    : 'button, a, input:not([type="password"]), select, textarea, [role="button"], [role="option"]';
  const all = Array.from(
    document.querySelectorAll(selector)
  ).filter(isVisible);

  // 헤더/nav/footer 링크 제외한 컨텐츠 요소 우선, 나머지 뒤에 붙임
  const aliExpressOptionElements = aliExpressDetail
    ? all.filter((element) => isAliExpressSkuOptionElement(element))
    : [];
  const nonOptionElements = aliExpressDetail
    ? all.filter((element) => !isAliExpressSkuOptionElement(element))
    : all;
  const aliExpressSearchAnchors = aliExpressSearchResults
    ? nonOptionElements.filter((element) => isAliExpressSearchResultAnchor(element))
    : [];
  const orderedAliExpressSearchAnchors = aliExpressSearchResults && aliExpressSearchResultIds.length > 0
    ? aliExpressSearchResultIds
        .map((productId) => aliExpressSearchAnchors.find((element) =>
          extractAliExpressProductIdFromHref((element as HTMLAnchorElement).href || '') === productId
        ))
        .filter((element): element is HTMLAnchorElement => element instanceof HTMLAnchorElement)
    : aliExpressSearchAnchors;
  const residualElements = aliExpressSearchResults
    ? nonOptionElements.filter((element) => !isAliExpressSearchResultAnchor(element))
    : nonOptionElements;
  const contentElements = residualElements.filter(el => !isInNavigationArea(el));
  const navElements = residualElements.filter(el => isInNavigationArea(el));
  const candidates = [...aliExpressOptionElements, ...orderedAliExpressSearchAnchors, ...contentElements, ...navElements];
  const purchaseLikeBeforeSlice = candidates
    .map((element, index) => {
      const html = element as HTMLElement;
      const label = extractInteractiveLabel(html);
      return {
        index,
        tag: element.tagName.toLowerCase(),
        role: inferInteractiveRole(html),
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
    aliExpressOptionElements: aliExpressOptionElements.length,
    aliExpressSearchAnchors: orderedAliExpressSearchAnchors.length,
    aliExpressInitDataIds: aliExpressSearchResultIds.length,
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
      const label = extractInteractiveLabel(html);
      return {
        index,
        tag: element.tagName.toLowerCase(),
        role: inferInteractiveRole(html),
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
    const nodeId = buildNodeId(element, index);
    htmlElement.setAttribute('data-pbm-node-id', nodeId);
    const labelText = truncate(
      extractInteractiveLabel(htmlElement),
      150  // 상품명+가격 충분히 담기도록 100→150
    );

    // <a> 태그의 href 수집 (상품 URL productId 매칭에 사용)
    const href = element.tagName.toLowerCase() === 'a'
      ? (element as HTMLAnchorElement).href || undefined
      : undefined;

    return {
      nodeId,
      role: inferInteractiveRole(htmlElement),
      labelText,
      selector: buildInteractiveSelector(htmlElement, nodeId),
      href,
      isVisible: true,
      disabled:
        htmlElement.hasAttribute('disabled') ||
        htmlElement.getAttribute('aria-disabled') === 'true' ||
        (isAliExpressSkuOptionElement(htmlElement) && /disabled/i.test(htmlElement.className))
    };
  });
}

function collectVisibleTextSummary(): string {
  const text = document.body?.innerText?.replace(/\s+/g, ' ').trim() || '';
  return truncate(text, MAX_VISIBLE_TEXT_LENGTH);
}

function isLoginLikePage(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.includes('nid.naver.com/nidlogin')
    || lower.includes('/login')
    || lower.includes('signin')
    || lower.includes('sign-in');
}

function isVisibleInputElement(element: HTMLInputElement | HTMLTextAreaElement): boolean {
  return isVisible(element) && !(element as HTMLInputElement).disabled;
}

function normalizeLoginLabel(text: string | null | undefined): string {
  return text?.replace(/\s+/g, ' ').trim().toLowerCase() ?? '';
}

function assignLoginSelector(
  element: HTMLElement,
  attributeName: 'data-pbm-login-field' | 'data-pbm-login-button',
  attributeValue: string
): string {
  element.setAttribute(attributeName, attributeValue);
  return `[${attributeName}="${attributeValue}"]`;
}

function findBestUsernameField(): HTMLInputElement | HTMLTextAreaElement | null {
  const candidates = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    'input:not([type="hidden"]):not([type="password"]), textarea'
  )).filter(isVisibleInputElement);

  const scored = candidates
    .map((element) => {
      const label = normalizeLoginLabel(
        element.getAttribute('placeholder')
          || element.getAttribute('aria-label')
          || element.getAttribute('name')
          || element.getAttribute('id')
      );
      let score = 0;
      if (element instanceof HTMLInputElement && (element.type === 'email' || element.autocomplete === 'username')) {
        score += 5;
      }
      if (label.includes('아이디') || label.includes('email') || label.includes('e-mail')) {
        score += 4;
      }
      if (label.includes('username') || label.includes('login') || label.includes('user')) {
        score += 3;
      }
      if (element instanceof HTMLInputElement && (element.name === 'id' || element.id === 'id')) {
        score += 2;
      }
      return { element, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0]?.element ?? null;
}

function findBestPasswordField(): HTMLInputElement | null {
  const candidates = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]'))
    .filter(isVisibleInputElement);
  return candidates[0] ?? null;
}

function findBestLoginButton(): HTMLElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('button, input[type="submit"], a[role="button"], [role="button"]')
  ).filter(isVisible);

  return candidates.find((element) => {
    const label = normalizeLoginLabel(
      element.innerText
      || element.textContent
      || element.getAttribute('aria-label')
      || (element instanceof HTMLInputElement ? element.value : '')
    );
    return label.includes('로그인') || label.includes('login') || label.includes('sign in') || label.includes('signin');
  }) ?? null;
}

function collectLoginFormSnapshot(): LoginFormSnapshot | undefined {
  const currentUrl = window.location.href || '';
  const usernameField = findBestUsernameField();
  const passwordField = findBestPasswordField();
  const loginButton = findBestLoginButton();

  const detected = Boolean(passwordField || (isLoginLikePage(currentUrl) && (usernameField || loginButton)));
  if (!detected) {
    return undefined;
  }

  const usernameSelector = usernameField
    ? assignLoginSelector(usernameField, 'data-pbm-login-field', 'username')
    : undefined;
  const passwordSelector = passwordField
    ? assignLoginSelector(passwordField, 'data-pbm-login-field', 'password')
    : undefined;
  const loginButtonSelector = loginButton
    ? assignLoginSelector(loginButton, 'data-pbm-login-button', 'true')
    : undefined;

  const snapshot: LoginFormSnapshot = {
    detected: true,
    usernameFilled: Boolean(usernameField?.value?.trim()),
    passwordFilled: Boolean(passwordField?.value?.trim()),
    usernameSelector,
    passwordSelector,
    loginButtonSelector,
    usernameLabel: truncate(
      usernameField?.getAttribute('placeholder')
        || usernameField?.getAttribute('aria-label')
        || usernameField?.getAttribute('name')
        || usernameField?.id
        || '',
      80
    ) || undefined,
    passwordLabel: truncate(
      passwordField?.getAttribute('placeholder')
        || passwordField?.getAttribute('aria-label')
        || passwordField?.getAttribute('name')
        || passwordField?.id
        || '',
      80
    ) || undefined,
    loginButtonLabel: truncate(
      loginButton?.innerText
        || loginButton?.textContent
        || loginButton?.getAttribute('aria-label')
        || (loginButton instanceof HTMLInputElement ? loginButton.value : '')
        || '',
      80
    ) || undefined
  };

  console.info('[snapshotCollector] loginForm 수집 결과', {
    currentUrl,
    detected: snapshot.detected,
    usernameFilled: snapshot.usernameFilled,
    passwordFilled: snapshot.passwordFilled,
    usernameSelector: snapshot.usernameSelector,
    passwordSelector: snapshot.passwordSelector,
    loginButtonSelector: snapshot.loginButtonSelector,
    usernameLabel: snapshot.usernameLabel,
    passwordLabel: snapshot.passwordLabel,
    loginButtonLabel: snapshot.loginButtonLabel
  });

  return snapshot;
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

  if (isSmartstoreProductDetailPage(currentUrl)) {
    // 1) 스마트스토어 라디오 버튼형 옵션 수집
    const radioGroups = collectSmartstoreRadioOptionGroups();

    // 2) 스마트스토어 토글/드롭다운형 옵션 수집
    const toggleGroups = collectSmartstoreToggleOptionGroups();

    // groupName 기준 중복 제거 (라디오와 토글이 같은 그룹을 수집할 수 있음)
    // 옵션 목록이 더 많은 쪽을 우선 채택
    const deduped = new Map<string, OptionGroup>();
    for (const group of [...radioGroups, ...toggleGroups]) {
      const existing = deduped.get(group.groupName);
      if (!existing || group.options.length > existing.options.length) {
        deduped.set(group.groupName, group);
      }
    }
    const mergedGroups = Array.from(deduped.values());

    console.info('[snapshotCollector] smartstore optionGroups 수집 결과', {
      currentUrl,
      radioCount: radioGroups.length,
      toggleCount: toggleGroups.length,
      mergedCount: mergedGroups.length,
      radioGroups: summarizeOptionGroupsForDebug(radioGroups),
      toggleGroups: summarizeOptionGroupsForDebug(toggleGroups),
      mergedGroups: summarizeOptionGroupsForDebug(mergedGroups)
    });

    return mergedGroups;
  }

  if (isAliExpressProductDetailPage(currentUrl)) {
    const aliExpressGroups = collectAliExpressOptionGroups();
    console.info('[snapshotCollector] aliexpress optionGroups 수집 결과', {
      currentUrl,
      groupCount: aliExpressGroups.length,
      groups: summarizeOptionGroupsForDebug(aliExpressGroups)
    });
    return aliExpressGroups;
  }

  console.info('[snapshotCollector] 옵션 수집 대상 페이지 아님 → optionGroups 수집 생략', {
    currentUrl
  });
  return [];
}

function summarizeOptionGroupsForDebug(groups: OptionGroup[]): Array<{
  groupName: string;
  optionCount: number;
  options: string[];
  selectedOption?: string;
  disabled?: boolean;
  nodeId?: string;
}> {
  return groups.map((group) => ({
    groupName: group.groupName,
    optionCount: group.options.length,
    options: group.options,
    selectedOption: group.selectedOption,
    disabled: group.disabled,
    nodeId: group.nodeId
  }));
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

/**
 * 스마트스토어 토글/드롭다운형 옵션 수집.
 *
 * 네이버 스마트스토어의 종속 옵션(cascading options) 구조를 처리한다.
 * 예: 색상 → 성별 → 사이즈 순서로 이전 옵션을 선택해야 다음 옵션이 활성화됨.
 * aria-disabled="true"인 그룹도 disabled=true로 표시하여 백엔드에 전달한다.
 */
function collectSmartstoreToggleOptionGroups(): OptionGroup[] {
  // 셀렉터: data-shp-contents-type 속성이 있는 토글 버튼 (옵션 그룹 식별)
  // .option 클래스가 없는 레이아웃도 지원
  const toggles = Array.from(
    document.querySelectorAll(
      'a[role="button"][aria-haspopup="listbox"][data-shp-contents-type],' +
      '.option [role="button"][aria-haspopup="listbox"],' +
      '.option a[role="button"][aria-haspopup="listbox"]'
    )
  ).slice(0, 30);

  // 중복 제거 (같은 요소가 여러 셀렉터에 매칭될 수 있음)
  const uniqueToggles = Array.from(new Set(toggles));

  return uniqueToggles.map((toggle, index) => {
    const htmlToggle = toggle as HTMLAnchorElement;
    const groupName = htmlToggle.getAttribute('data-shp-contents-type')?.trim()
      || (htmlToggle.textContent?.split('/')[0]?.trim() || '옵션');

    const isDisabled = htmlToggle.getAttribute('aria-disabled') === 'true';

    const fullLabel = htmlToggle.textContent?.replace(/\s+/g, ' ').trim() || '';

    // 선택된 옵션 감지 (3가지 전략)
    // 1) 토글 버튼의 data-shp-contents-id (선택 후 설정됨)
    // 2) 토글 텍스트에 "/" 구분자 (예: "색상 / [1]올검(블랙)")
    // 3) listbox 내 aria-selected="true"인 옵션 항목
    const listbox = htmlToggle.parentElement?.querySelector('[role="listbox"]');
    const selectedByAria = listbox?.querySelector('[role="option"][aria-selected="true"]');
    const selectedByAriaValue = selectedByAria
      ? ((selectedByAria as HTMLElement).getAttribute('data-shp-contents-id')?.trim()
        || selectedByAria.textContent?.replace(/\s+/g, ' ').trim()
        || undefined)
      : undefined;

    const currentSelected = htmlToggle.getAttribute('data-shp-contents-id')?.trim()
      || (fullLabel.includes('/') ? fullLabel.split('/').slice(1).join('/').trim() : undefined)
      || selectedByAriaValue
      || undefined;

    const options = Array.from(listbox?.querySelectorAll('[role="option"]') ?? [])
      .map((item) => {
        // data-shp-contents-id에서 옵션명 추출 (텍스트보다 정확)
        const contentsId = (item as HTMLElement).getAttribute('data-shp-contents-id')?.trim();
        return contentsId || item.textContent?.replace(/\s+/g, ' ').trim() || '';
      })
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
      selectedOption: currentSelected,
      disabled: isDisabled || undefined
    };
  }).filter((group) =>
    // 옵션이 있거나, 선택된 것이 있거나, 비활성(종속 옵션)인 경우 모두 포함
    group.options.length > 0 || group.selectedOption != null || group.disabled === true
  );
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
    loginForm: collectLoginFormSnapshot(),
    priceCandidates,
    currencyCandidates: collectCurrencyCandidates(priceCandidates),
    rawHtml: collectRawHtml(),
    capturedAt: new Date().toISOString()
  };
}
