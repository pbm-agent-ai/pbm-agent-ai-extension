import { pushLog } from '../shared/logger';
import { broadcastStatusSnapshot } from '../shared/messageRouter';
import { getStorage, updateStorage } from '../shared/storageManager';
import { abortActiveRun } from './runLifecycle';
import { isSupportedUrl, getSupportedDomains } from './platformManager';

// 캡챠 페이지 URL 패턴: ncpt.naver.com 등
function isCaptchaUrl(url: string | undefined): boolean {
  if (!url) return false;
  return url.includes('ncpt.naver.com') || url.includes('/captcha');
}

async function waitForTabComplete(tabId: number, timeoutMs = 15000): Promise<chrome.tabs.Tab> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);

    if (tab.status === 'complete') {
      return tab;
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error(`탭 로드 타임아웃 (${timeoutMs}ms)`);
}

/**
 * 현재 열려 있는 탭 중 지원 도메인에 해당하는 탭을 재사용 후보로 찾는다.
 * chrome.tabs.query의 url 패턴은 동적으로 생성한다.
 */
async function findReusableSupportedTab(targetUrl: string): Promise<chrome.tabs.Tab | undefined> {
  const targetHostname = new URL(targetUrl).hostname;
  const domains = await getSupportedDomains();
  const matchedDomain = domains.find((domain) => targetHostname.endsWith(domain));

  if (!matchedDomain) return undefined;

  // targetUrl과 같은 플랫폼 도메인의 탭만 재사용 후보로 본다.
  const allTabs = await chrome.tabs.query({ url: `https://*.${matchedDomain}/*` });

  if (allTabs.length === 0) return undefined;

  // 정확히 targetUrl과 같은 탭 우선, 그 다음 활성 탭, 그 다음 아무 탭
  return (
    allTabs.find((tab) => tab.url === targetUrl) ??
    allTabs.find((tab) => tab.active) ??
    allTabs[0]
  );
}

async function navigateTab(tabId: number, targetUrl: string): Promise<chrome.tabs.Tab> {
  await chrome.tabs.update(tabId, { url: targetUrl, active: true });
  return waitForTabComplete(tabId);
}

export async function ensureRunTab(targetUrl: string): Promise<number> {
  const storage = await getStorage();

  // 하드코딩 대신 DB에서 가져온 허용 도메인으로 체크
  const supported = await isSupportedUrl(targetUrl);
  if (!supported) {
    throw new Error(`UNSUPPORTED_PAGE_STATE: 지원하지 않는 도메인입니다. url=${targetUrl}`);
  }

  const reusable = await findReusableSupportedTab(targetUrl);
  let tab: chrome.tabs.Tab;

  if (reusable?.id) {
    tab = reusable.url === targetUrl
      ? await waitForTabComplete(reusable.id)
      : await navigateTab(reusable.id, targetUrl);

    pushLog({
      runId: storage.activeRunId,
      deviceId: storage.deviceId,
      stepIndex: storage.stepIndex,
      action: null,
      status: 'TAB_REUSED',
      message: `기존 탭(tabId=${reusable.id})을 재사용함. url=${targetUrl}`
    });
  } else {
    const created = await chrome.tabs.create({ url: targetUrl, active: true });

    if (!created.id) {
      throw new Error('탭 생성 실패');
    }

    tab = await waitForTabComplete(created.id);

    pushLog({
      runId: storage.activeRunId,
      deviceId: storage.deviceId,
      stepIndex: storage.stepIndex,
      action: null,
      status: 'TAB_CREATED',
      message: `새 탭(tabId=${created.id})을 생성함. url=${targetUrl}`
    });
  }

  if (!tab.id || !(await isSupportedUrl(tab.url))) {
    throw new Error(`UNSUPPORTED_PAGE_STATE: 확보된 탭 URL이 지원 도메인이 아님. url=${tab.url}`);
  }

  await updateStorage({
    targetTabId: tab.id,
    targetUrl: tab.url ?? targetUrl
  });

  await broadcastStatusSnapshot();

  return tab.id;
}

export async function validateRunTab(): Promise<boolean> {
  const storage = await getStorage();

  if (!storage.targetTabId) {
    return false;
  }

  try {
    const tab = await chrome.tabs.get(storage.targetTabId);
    return isSupportedUrl(tab.url);
  } catch {
    return false;
  }
}

export async function revalidateRunTabOrAbort(): Promise<boolean> {
  const storage = await getStorage();

  if (!storage.targetTabId || !storage.targetUrl) {
    return false;
  }

  // 옵션 선택 대기 중에는 사용자가 확인 중인 외부 스토어 페이지를 절대 강제로 복구하지 않는다.
  if (storage.extensionStatus === 'AWAITING_OPTION_SELECTION' || storage.extensionStatus === 'AWAITING_LOGIN_CREDENTIALS') {
    return true;
  }

  // 캡챠 해결 대기 중에는 탭이 ncpt.naver.com에 있을 수 있으므로 검증을 건너뜀.
  // 캡챠 자동 재개는 tabs.onUpdated 리스너에서 별도 처리한다.
  if (storage.approvalType === 'CAPTCHA') {
    return true;
  }

  try {
    const tab = await chrome.tabs.get(storage.targetTabId);

    if (await isSupportedUrl(tab.url)) {
      return true;
    }

    await navigateTab(storage.targetTabId, storage.targetUrl);
    const retried = await chrome.tabs.get(storage.targetTabId);

    if (await isSupportedUrl(retried.url)) {
      pushLog({
        runId: storage.activeRunId,
        deviceId: storage.deviceId,
        stepIndex: storage.stepIndex,
        action: null,
        status: 'TAB_RESTORED',
        message: 'run tab 이탈을 감지하고 1회 재네비게이션으로 복구함'
      });
      await broadcastStatusSnapshot();
      return true;
    }
  } catch {
    // noop
  }

  await abortActiveRun('UNSUPPORTED_PAGE_STATE', 'run tab 이탈 후 복구 실패');
  return false;
}
