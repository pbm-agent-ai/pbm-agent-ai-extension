import { apiClient } from '../shared/apiClient';
import { pushLog } from '../shared/logger';
import { broadcastStatusSnapshot } from '../shared/messageRouter';
import { getStorage, resetRunState, updateStorage } from '../shared/storageManager';
import type { AbortReason, BackendRunStatus, ExtensionStatus } from '../shared/types';

export async function finalizeRun(
  extensionStatus: Extract<ExtensionStatus, 'COMPLETED' | 'ABORTED' | 'INTERRUPTED' | 'ERROR'>,
  options?: {
    backendRunStatus?: BackendRunStatus | null;
    errorMessage?: string | null;
    keepRunContext?: boolean;
  }
): Promise<void> {
  const storage = await getStorage();

  await updateStorage({
    extensionStatus,
    backendRunStatus: options?.backendRunStatus ?? storage.backendRunStatus ?? null,
    lastError: options?.errorMessage ?? null
  });

  pushLog({
    runId: storage.activeRunId,
    deviceId: storage.deviceId,
    stepIndex: storage.stepIndex,
    action: null,
    status: `RUN_${extensionStatus}`,
    message: options?.errorMessage ?? `run 상태를 ${extensionStatus} 로 전환함`
  });

  await broadcastStatusSnapshot();

  if (!options?.keepRunContext) {
    await resetRunState();
    await updateStorage({ extensionStatus, backendRunStatus: options?.backendRunStatus ?? null });
    await broadcastStatusSnapshot();
  }
}

export async function abortActiveRun(reason: AbortReason, message?: string): Promise<void> {
  const storage = await getStorage();

  if (storage.activeRunId) {
    const token = storage.agentToken ?? storage.deviceToken;

    if (token) {
      await apiClient.abortRun(storage.activeRunId, token, { reason });
    }
  }

  await finalizeRun('ABORTED', {
    backendRunStatus: 'ABORTED',
    errorMessage: message ?? `run 중단: ${reason}`
  });
}
