import { DEFAULT_EXTENSION_STORAGE } from './constants';
import type { ExtensionStatus, ExtensionStorage, LastAction } from './types';
import { clearLogs } from './logger';

type StoragePatch = Partial<ExtensionStorage>;

function withTimestamp(patch: StoragePatch): StoragePatch {
  return {
    ...patch,
    updatedAt: new Date().toISOString()
  };
}

export async function getStorage(): Promise<ExtensionStorage> {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_EXTENSION_STORAGE));

  return {
    ...DEFAULT_EXTENSION_STORAGE,
    ...stored
  } as ExtensionStorage;
}

export async function initializeStorage(): Promise<ExtensionStorage> {
  const current = await getStorage();

  if (!current.updatedAt) {
    const initialized = withTimestamp(current);
    await chrome.storage.local.set(initialized);
    return initialized as ExtensionStorage;
  }

  return current;
}

export async function updateStorage(patch: StoragePatch): Promise<ExtensionStorage> {
  const next = withTimestamp(patch);
  await chrome.storage.local.set(next);

  return getStorage();
}

export async function setExtensionStatus(extensionStatus: ExtensionStatus): Promise<ExtensionStorage> {
  return updateStorage({ extensionStatus });
}

export async function setLastAction(lastAction: LastAction | null): Promise<ExtensionStorage> {
  return updateStorage({ lastAction });
}

export async function setLastToolResult(lastToolResult: ExtensionStorage['lastToolResult']): Promise<ExtensionStorage> {
  return updateStorage({ lastToolResult });
}

export async function setLastHeartbeatAt(lastHeartbeatAt: string | null): Promise<ExtensionStorage> {
  return updateStorage({ lastHeartbeatAt });
}

export async function setLastSnapshot(lastSnapshot: ExtensionStorage['lastSnapshot']): Promise<ExtensionStorage> {
  return updateStorage({ lastSnapshot });
}

export async function resetRunState(): Promise<ExtensionStorage> {
  return updateStorage({
    agentToken: null,
    activeRunId: null,
    backendRunStatus: null,
    stepIndex: 0,
    failureCount: 0,
    lastError: null,
    approvalRequestedAt: null,
    approvalType: null,
    lastAction: null,
    lastToolResult: null,
    targetTabId: null,
    targetUrl: null,
    lastSnapshot: null,
    lastInstruction: null
  });
}

/**
 * 디바이스/세션/run 자격 증명 및 런타임 상태를 안전하게 초기화합니다.
 * supportedDomains 등 앱 안전 필드는 유지합니다.
 * 로그도 함께 초기화합니다.
 */
export async function resetAllStorage(): Promise<ExtensionStorage> {
  const current = await getStorage();
  // supportedDomains 등 앱 안전 필드는 보존하고 나머지는 기본값으로 리셋
  const safeFields = {
    supportedDomains: current.supportedDomains
  };
  const reset = {
    ...DEFAULT_EXTENSION_STORAGE,
    ...safeFields,
    updatedAt: new Date().toISOString()
  };
  await chrome.storage.local.set(reset);
  clearLogs();
  return reset as ExtensionStorage;
}
