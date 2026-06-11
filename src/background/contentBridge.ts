import { pushLog } from '../shared/logger';
import { broadcastStatusSnapshot } from '../shared/messageRouter';
import { getStorage, setLastSnapshot } from '../shared/storageManager';
import type { ContentToBackgroundSnapshotResultMessage, PageSnapshot } from '../shared/types';

/**
 * content script가 응답하지 않을 때 수동으로 주입한다.
 * 탭 재사용 시 content script가 죽어있거나 SPA 네비게이션으로 무효화된 경우 복구한다.
 */
async function ensureContentScriptInjected(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
    // content script 초기화 대기 (listener 등록까지)
    await new Promise((resolve) => setTimeout(resolve, 500));
    console.info(`[contentBridge] content script 수동 주입 완료 - tabId=${tabId}`);
  } catch (err) {
    console.warn(`[contentBridge] content script 수동 주입 실패 - tabId=${tabId}:`, err);
  }
}

export async function collectSnapshotFromActiveTab(): Promise<PageSnapshot> {
  const storage = await getStorage();

  if (!storage.targetTabId) {
    throw new Error('snapshot 수집 대상 탭이 없음');
  }

  // content script의 initialize()가 async(chrome.storage.local.get)이므로
  // 탭 로드 완료 직후 메시지를 보내면 아직 listener가 등록되지 않아 실패할 수 있다.
  // 최대 5회 재시도 (간격: 400ms → 800ms → 1200ms → 1600ms)
  // 3회 연속 실패 시 content script를 수동 주입해서 복구를 시도한다.
  const MAX_RETRIES = 5;
  const INJECT_AFTER_ATTEMPT = 3; // 이 횟수 실패 후 수동 주입 시도
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delayMs = attempt * 400;
      console.info(`[contentBridge] COLLECT_SNAPSHOT 재시도 ${attempt}/${MAX_RETRIES - 1} (${delayMs}ms 대기)`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    // 3회 실패 후 content script 수동 주입 시도
    if (attempt === INJECT_AFTER_ATTEMPT) {
      console.info(`[contentBridge] ${INJECT_AFTER_ATTEMPT}회 실패 → content script 수동 주입 시도`);
      await ensureContentScriptInjected(storage.targetTabId);
    }

    try {
      const response = (await chrome.tabs.sendMessage(storage.targetTabId, {
        type: 'COLLECT_SNAPSHOT'
      })) as ContentToBackgroundSnapshotResultMessage;

      if (!response || !response.payload.ok) {
        const errorMessage = response && !response.payload.ok ? response.payload.error : 'snapshot 응답이 비정상적임';
        throw new Error(errorMessage);
      }

      await setLastSnapshot(response.payload.snapshot);

      pushLog({
        runId: storage.activeRunId,
        deviceId: storage.deviceId,
        stepIndex: storage.stepIndex,
        action: null,
        status: 'SNAPSHOT_COLLECTED',
        message: `interactiveElements=${response.payload.snapshot.interactiveElements.length} 개를 포함한 snapshot 수집 완료 (attempt=${attempt + 1})`
      });

      await broadcastStatusSnapshot();

      return response.payload.snapshot;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[contentBridge] COLLECT_SNAPSHOT 시도 ${attempt + 1}/${MAX_RETRIES} 실패:`, lastError.message);
    }
  }

  throw lastError ?? new Error('snapshot 수집 실패 (재시도 모두 소진)');
}
