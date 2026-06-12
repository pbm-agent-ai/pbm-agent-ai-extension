import { pushLog, clearLogs } from '../shared/logger';
import { broadcastStatusSnapshot, handleRuntimeMessage } from '../shared/messageRouter';
import { getStorage, updateStorage, initializeStorage } from '../shared/storageManager';
import { syncSupportedDomains, isSupportedUrl } from './platformManager';
import type { RuntimeMessage, RuntimeResponse } from '../shared/types';
import { pairDevice } from './deviceManager';
import { ensureHeartbeatAlarm, runHeartbeat } from './heartbeatManager';
import { recoverInterruptedRun, resumeApprovalRunIfPossible } from './recoveryManager';
import { syncPendingRuns } from './runManager';
import { revalidateRunTabOrAbort } from './tabManager';
import { collectSnapshotFromActiveTab } from './contentBridge';
import { searchAliExpressProducts } from './aliexpressSearch';

chrome.runtime.onInstalled.addListener(() => {
  void initializeStorage().then(() => broadcastStatusSnapshot());
  void ensureHeartbeatAlarm();
  // 설치 시 허용 도메인 목록을 백엔드에서 가져와 캐싱
  void syncSupportedDomains();

  pushLog({
    runId: null,
    deviceId: null,
    stepIndex: null,
    action: null,
    status: 'INSTALLED',
    message: 'PBM Agent AI extension installed'
  });

  void broadcastStatusSnapshot();

  if (chrome.sidePanel?.setPanelBehavior) {
    void chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((error) => {
        console.warn('[background] Failed to set side panel behavior', error);
      });
  }
});

chrome.runtime.onStartup.addListener(() => {
  void initializeStorage().then(() => broadcastStatusSnapshot());
  void ensureHeartbeatAlarm();
  // 브라우저 재시작 시에도 최신 허용 도메인 목록 갱신
  void syncSupportedDomains();
  void recoverInterruptedRun().catch(() => undefined);
  void resumeApprovalRunIfPossible().catch(() => undefined);
  void syncPendingRuns().catch((error: unknown) => {
    pushLog({
      runId: null,
      deviceId: null,
      stepIndex: null,
      action: null,
      status: 'PENDING_ERROR',
      message: error instanceof Error ? error.message : '알 수 없는 pending 조회 오류'
    });
  });
  void runHeartbeat('startup').catch((error: unknown) => {
    pushLog({
      runId: null,
      deviceId: null,
      stepIndex: null,
      action: null,
      status: 'HEARTBEAT_ERROR',
      message: error instanceof Error ? error.message : '알 수 없는 heartbeat 오류'
    });
  });

  pushLog({
    runId: null,
    deviceId: null,
    stepIndex: null,
    action: null,
    status: 'STARTUP',
    message: 'Service worker started'
  });

  void broadcastStatusSnapshot();
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !chrome.sidePanel?.open) {
    return;
  }

  await chrome.sidePanel.open({ tabId: tab.id });
});

// 캡챠 자동 재개: 탭 URL이 지원 도메인으로 변경되면 step loop를 재개한다.
// 네이버 캡챠 페이지(ncpt.naver.com)를 사용자가 직접 해결하면 Naver가 쇼핑 페이지로 리다이렉트한다.
// 이 리다이렉트를 감지해 AWAITING_APPROVAL(CAPTCHA) 상태를 자동으로 해제한다.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete' || !changeInfo.url) return;

  const storage = await getStorage();

  if (
    storage.extensionStatus !== 'AWAITING_APPROVAL' ||
    storage.approvalType !== 'CAPTCHA' ||
    !storage.activeRunId ||
    tabId !== storage.targetTabId
  ) return;

  const resolved = await isSupportedUrl(changeInfo.url);
  if (!resolved) return;

  pushLog({
    runId: storage.activeRunId,
    deviceId: storage.deviceId,
    stepIndex: storage.stepIndex,
    action: null,
    status: 'CAPTCHA_RESOLVED',
    message: `캡챠 해결 감지 → step loop 자동 재개. url=${changeInfo.url}`
  });

  await updateStorage({
    extensionStatus: 'EXECUTING',
    backendRunStatus: 'RUNNING',
    approvalRequestedAt: null,
    approvalType: null,
    targetUrl: changeInfo.url
  });

  await broadcastStatusSnapshot();

  await collectSnapshotFromActiveTab();

  const { runStepLoop } = await import('./stepLoopManager');
  await runStepLoop().catch(async (error) => {
    pushLog({
      runId: storage.activeRunId,
      deviceId: storage.deviceId,
      stepIndex: storage.stepIndex,
      action: null,
      status: 'CAPTCHA_RESUME_ERROR',
      message: `캡챠 재개 후 step loop 실패: ${error instanceof Error ? error.message : String(error)}`
    });
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'pbm-heartbeat') {
    return;
  }

  void revalidateRunTabOrAbort().then((isValid) => {
    if (!isValid) {
      pushLog({
        runId: null,
        deviceId: null,
        stepIndex: null,
        action: null,
        status: 'TAB_INVALID',
        message: '현재 run tab 이 없거나 지원 도메인 조건을 만족하지 않음'
      });
    }
  });

  void runHeartbeat('alarm').catch((error: unknown) => {
    pushLog({
      runId: null,
      deviceId: null,
      stepIndex: null,
      action: null,
      status: 'HEARTBEAT_ERROR',
      message: error instanceof Error ? error.message : '알 수 없는 heartbeat 오류'
    });
  });
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message.type === 'PAIR_DEVICE') {
    void pairDevice(message.payload).then((response) => {
      sendResponse(response);
    });

    return true;
  }

  if (message.type === 'SEARCH_ALIEXPRESS_PRODUCTS') {
    void searchAliExpressProducts(message.payload.keyword, message.payload.maxResults)
      .then((products) => {
        sendResponse({
          type: 'SEARCH_ALIEXPRESS_PRODUCTS_RESULT',
          payload: { ok: true, products }
        });
      })
      .catch((error: unknown) => {
        sendResponse({
          type: 'SEARCH_ALIEXPRESS_PRODUCTS_RESULT',
          payload: {
            ok: false,
            error: error instanceof Error ? error.message : 'AliExpress 검색 실패'
          }
        });
      });
    return true;
  }

  if (message.type === 'REQUEST_STATUS_SNAPSHOT') {
    void handleRuntimeMessage(message, sendResponse as (response?: RuntimeResponse) => void);
    return true;
  }

  // 사이드패널 "Run 상태 초기화" 버튼 → deviceId/deviceToken 유지하고 run 상태만 리셋
  if (message.type === 'RESET_RUN_STATE') {
    void (async () => {
      const { resetRunState } = await import('../shared/storageManager');
      await resetRunState();
      await broadcastStatusSnapshot();
      pushLog({
        runId: null, deviceId: null, stepIndex: null, action: null,
        status: 'STATE_RESET', message: '사용자 요청으로 Run 상태 초기화 완료 (deviceId/Token 유지)'
      });
      sendResponse({ ok: true });
    })();
    return true;
  }

  // 사이드패널 "캡챠 완료" 버튼 → 수동으로 step loop 재개
  if (message.type === 'CAPTCHA_MANUALLY_RESOLVED') {
    void (async () => {
      const storage = await getStorage();

      if (storage.extensionStatus !== 'AWAITING_APPROVAL' || storage.approvalType !== 'CAPTCHA') {
        sendResponse({ ok: false, error: '현재 캡챠 대기 상태가 아닙니다.' });
        return;
      }

      pushLog({
        runId: storage.activeRunId,
        deviceId: storage.deviceId,
        stepIndex: storage.stepIndex,
        action: null,
        status: 'CAPTCHA_RESOLVED',
        message: '사용자가 수동으로 캡챠 완료 버튼 클릭 → step loop 재개'
      });

      await updateStorage({
        extensionStatus: 'EXECUTING',
        backendRunStatus: 'RUNNING',
        approvalRequestedAt: null,
        approvalType: null
      });

      await broadcastStatusSnapshot();

      await collectSnapshotFromActiveTab();
      const { runStepLoop } = await import('./stepLoopManager');
      runStepLoop().catch(async (error) => {
        pushLog({
          runId: storage.activeRunId,
          deviceId: storage.deviceId,
          stepIndex: storage.stepIndex,
          action: null,
          status: 'CAPTCHA_RESUME_ERROR',
          message: `캡챠 수동 재개 후 step loop 실패: ${error instanceof Error ? error.message : String(error)}`
        });
      });

      sendResponse({ ok: true });
    })();
    return true;
  }

  // 사이드패널 "사용자 리셋" 버튼 → device/run 자격 증명 전체 초기화 (supportedDomains 유지)
  if (message.type === 'RESET_USER_SESSION') {
    void (async () => {
      const { resetAllStorage } = await import('../shared/storageManager');
      await resetAllStorage();
      await broadcastStatusSnapshot();
      pushLog({
        runId: null, deviceId: null, stepIndex: null, action: null,
        status: 'SESSION_RESET', message: '사용자 요청으로 디바이스 연결 및 run 상태 전체 초기화 완료'
      });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === 'CLEAR_LOGS') {
    clearLogs();
    void broadcastStatusSnapshot();
    sendResponse({ ok: true });
    return true;
  }

  return false;
});
