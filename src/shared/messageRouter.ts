import { getLogs } from './logger';
import { getStorage } from './storageManager';
import type { BackgroundToSidePanelMessage, RuntimeResponse, SidePanelToBackgroundMessage } from './types';

export async function createStatusSnapshotMessage(): Promise<BackgroundToSidePanelMessage> {
  const storage = await getStorage();

  console.info('[snapshot-debug] createStatusSnapshotMessage', {
    deviceId: storage.deviceId ? storage.deviceId.slice(0, 12) + '…' : null,
    deviceTokenExists: storage.deviceToken !== null,
    extensionStatus: storage.extensionStatus,
    activeRunId: storage.activeRunId ? storage.activeRunId.slice(0, 12) + '…' : null,
    backendRunStatus: storage.backendRunStatus,
    storageKeys: Object.keys(storage).filter((k) => storage[k as keyof typeof storage] != null).join(',')
  });

  return {
    type: 'STATUS_SNAPSHOT',
    payload: {
      deviceId: storage.deviceId,
      deviceTokenExists: storage.deviceToken !== null,
      agentTokenLoaded: storage.agentToken !== null,
      extensionStatus: storage.extensionStatus,
      activeRunId: storage.activeRunId,
      backendRunStatus: storage.backendRunStatus,
      stepIndex: storage.stepIndex,
      failureCount: storage.failureCount,
      lastError: storage.lastError,
      approvalRequestedAt: storage.approvalRequestedAt,
      approvalType: storage.approvalType ?? null,
      lastToolResult: storage.lastToolResult,
      targetTabId: storage.targetTabId,
      targetUrl: storage.targetUrl,
      lastSnapshot: storage.lastSnapshot,
      lastHeartbeatAt: storage.lastHeartbeatAt,
      lastInstruction: storage.lastInstruction ?? null,
      logs: getLogs()
    }
  };
}

export async function handleRuntimeMessage(
  message: SidePanelToBackgroundMessage,
  sendResponse: (response?: RuntimeResponse) => void
): Promise<boolean> {
  if (message.type === 'REQUEST_STATUS_SNAPSHOT') {
    console.info('[snapshot-debug] handleRuntimeMessage: REQUEST_STATUS_SNAPSHOT 수신');
    const snapshot = await createStatusSnapshotMessage();
    sendResponse(snapshot);
    return true;
  }

  return false;
}

export async function broadcastStatusSnapshot(): Promise<void> {
  console.info('[snapshot-debug] broadcastStatusSnapshot 시작');
  const snapshot = await createStatusSnapshotMessage();

  try {
    await chrome.runtime.sendMessage(snapshot);
    console.info('[snapshot-debug] broadcastStatusSnapshot: chrome.runtime.sendMessage 완료');
  } catch (err) {
    console.warn('[snapshot-debug] broadcastStatusSnapshot: chrome.runtime.sendMessage 실패', {
      error: String(err).slice(0, 120)
    });
  }
}
