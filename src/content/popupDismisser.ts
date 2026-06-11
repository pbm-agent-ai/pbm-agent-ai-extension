/**
 * 팝업/모달 자동 닫기 모듈.
 *
 * 역할: 스냅샷 수집 또는 액션 실행 직전에 화면을 가리는 팝업/모달/광고를 자동으로 닫는다.
 * 동작: 알리익스프레스, 네이버 쇼핑 등 지원 플랫폼의 공통 팝업 패턴을 감지하고
 *       닫기 버튼 클릭 → Escape 키 → 오버레이 클릭 순으로 시도한다.
 * 주의: 구매 확인 모달 등 의도된 UI는 건드리지 않도록 보수적으로 감지한다.
 */

/** 팝업/모달 컨테이너로 판단하는 CSS 선택자 목록 (우선순위 순) */
const MODAL_SELECTORS = [
  'dialog[open]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  // AliExpress
  '.comet-modal-wrap',
  '.next-overlay-wrapper',
  '[class*="comet-dialog"]',
  '[class*="comet-modal"]',
  // 일반 패턴
  '[class*="modal--"]',
  '[class*="popup--"]',
  '[class*="-modal"]',
  '[class*="-popup"]',
  '[class*="Popup"]',
  '[class*="Modal"]',
  '[class*="Dialog"]',
  // 최후 수단: 반투명 오버레이 (z-index로 판단)
];

/** 닫기 버튼으로 판단하는 CSS 선택자 목록 (우선순위 순) */
const CLOSE_BUTTON_SELECTORS = [
  // ARIA label
  '[aria-label="Close"]',
  '[aria-label="close"]',
  '[aria-label="닫기"]',
  '[aria-label="dismiss"]',
  '[aria-label="Dismiss"]',
  // 데이터 속성
  '[data-close]',
  '[data-dismiss]',
  '[data-testid="close-button"]',
  // AliExpress 전용
  '.comet-modal-close',
  '.next-dialog-close',
  '.next-overlay-close',
  // 일반 클래스
  '.modal-close',
  '.popup-close',
  '.dialog-close',
  '.btn-close',
  '.close-btn',
  '.close-button',
  // ×/✕ 텍스트 버튼 (광범위하게)
  'button[class*="close" i]',
  'button[class*="Close"]',
  'button[class*="dismiss" i]',
  'span[class*="close" i]',
  'i[class*="close" i]',
];

/** 요소가 실제로 화면에 보이는지 확인 */
function isVisibleElement(element: Element): boolean {
  const el = element as HTMLElement;
  const style = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.opacity !== '0' &&
    rect.width > 0 &&
    rect.height > 0
  );
}

/** 모달이 페이지의 상당 부분을 덮고 있는지 확인 (의도치 않은 요소 오클릭 방지) */
function isOverlayLike(element: Element): boolean {
  const el = element as HTMLElement;
  const rect = el.getBoundingClientRect();
  const viewportArea = window.innerWidth * window.innerHeight;
  const elementArea = rect.width * rect.height;
  // 뷰포트의 10% 이상을 덮는 경우에만 오버레이로 인정
  return elementArea > viewportArea * 0.1;
}

/**
 * 요소 내부 또는 전역에서 닫기 버튼을 찾아 반환한다.
 * @param container 탐색 범위 (null이면 document 전체)
 */
function findCloseButton(container: Element | Document): HTMLElement | null {
  for (const selector of CLOSE_BUTTON_SELECTORS) {
    const el = container.querySelector<HTMLElement>(selector);
    if (el && isVisibleElement(el)) {
      return el;
    }
  }

  // 텍스트가 ×, ✕, X인 버튼을 추가로 탐색 (텍스트 기반)
  const buttons = Array.from(container.querySelectorAll<HTMLElement>('button, [role="button"], span, i, svg'));
  for (const btn of buttons) {
    const text = btn.textContent?.trim() ?? '';
    const ariaLabel = btn.getAttribute('aria-label') ?? '';
    if ((text === '×' || text === '✕' || text === '✖' || text === 'X' || text === '✗') && isVisibleElement(btn)) {
      return btn;
    }
    if (ariaLabel.toLowerCase().includes('close') || ariaLabel.includes('닫기')) {
      if (isVisibleElement(btn)) return btn;
    }
  }

  return null;
}

/**
 * 현재 페이지의 팝업/모달을 감지하고 닫는다.
 * 최대 3개의 팝업을 순서대로 처리하며, 각 닫기 후 350ms 대기한다.
 *
 * @returns 닫은 팝업 수
 */
export async function dismissPopups(): Promise<number> {
  let dismissedCount = 0;
  const MAX_DISMISSALS = 3;

  for (let attempt = 0; attempt < MAX_DISMISSALS; attempt++) {
    const dismissed = await attemptDismiss();
    if (!dismissed) break;
    dismissedCount++;
    // 다음 팝업이 렌더링될 시간 확보
    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  return dismissedCount;
}

async function attemptDismiss(): Promise<boolean> {
  // 1단계: 알려진 모달 컨테이너 내부에서 닫기 버튼 탐색
  for (const modalSelector of MODAL_SELECTORS) {
    const modals = Array.from(document.querySelectorAll<Element>(modalSelector))
      .filter(isVisibleElement)
      .filter(isOverlayLike);

    for (const modal of modals) {
      const closeBtn = findCloseButton(modal);
      if (closeBtn) {
        console.info('[popupDismisser] 모달 닫기 버튼 클릭:', modalSelector, closeBtn.outerHTML.slice(0, 80));
        closeBtn.click();
        return true;
      }
    }
  }

  // 2단계: 전역에서 닫기 버튼 탐색 (모달 컨테이너를 못 찾은 경우)
  const globalCloseBtn = findCloseButton(document);
  if (globalCloseBtn) {
    // 닫기 버튼이 오버레이 위에 있는지 확인 (일반 UI 오클릭 방지)
    const rect = globalCloseBtn.getBoundingClientRect();
    const zIndex = parseInt(window.getComputedStyle(globalCloseBtn).zIndex || '0', 10);
    if (zIndex > 100 || rect.top < 80 || (rect.right > window.innerWidth - 80)) {
      // 높은 z-index이거나 우상단 모서리에 있으면 팝업 닫기 버튼으로 간주
      console.info('[popupDismisser] 전역 닫기 버튼 클릭:', globalCloseBtn.outerHTML.slice(0, 80));
      globalCloseBtn.click();
      return true;
    }
  }

  // 3단계: Escape 키 (dialog[open] 등 네이티브 모달에 효과적)
  const openDialog = document.querySelector('dialog[open]');
  if (openDialog && isVisibleElement(openDialog)) {
    console.info('[popupDismisser] Escape 키로 dialog 닫기 시도');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    return true;
  }

  return false;
}
