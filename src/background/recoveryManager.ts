import { apiClient } from '../shared/apiClient';
import { pushLog } from '../shared/logger';
import { broadcastStatusSnapshot } from '../shared/messageRouter';
import { getStorage, updateStorage } from '../shared/storageManager';
import { collectSnapshotFromActiveTab } from './contentBridge';
import { startAssignedRun } from './runManager';
import { ensureRunTab } from './tabManager';

export async function resumeApprovalRunIfPossible(): Promise<boolean> {
  const storage = await getStorage();

  if (
    storage.extensionStatus !== 'AWAITING_APPROVAL' ||
    !storage.activeRunId ||
    !storage.deviceToken
  ) {
    return false;
  }

  const run = await apiClient.getRun(storage.activeRunId, storage.deviceToken);

  if (run.status === 'RUNNING') {
    await updateStorage({
      extensionStatus: 'EXECUTING',
      backendRunStatus: 'RUNNING',
      stepIndex: run.currentStepIndex,
      approvalRequestedAt: null,
      lastError: null
    });

    await ensureRunTab(storage.targetUrl ?? 'https://search.shopping.naver.com/home');
    await collectSnapshotFromActiveTab();

    pushLog({
        runId: storage.activeRunId,
        deviceId: storage.deviceId,
        stepIndex: run.currentStepIndex,
        action: null,
        status: 'APPROVAL_RESUMED',
        message: '웹앱 승인 완료를 감지해 step loop 재개 가능 상태로 전환함'
      });

      await broadcastStatusSnapshot();
      const { runStepLoop } = await import('./stepLoopManager');
      await runStepLoop();
      return true;
    }

  if (run.status === 'APPROVAL_EXPIRED' || run.status === 'ABORTED' || run.status === 'FAILED') {
    await updateStorage({
      extensionStatus: run.status === 'APPROVAL_EXPIRED' ? 'ABORTED' : 'ABORTED',
      backendRunStatus: run.status,
      lastError: `승인 재개 실패: backend status=${run.status}`
    });
    await broadcastStatusSnapshot();
  }

  return false;
}

export async function recoverInterruptedRun(): Promise<boolean> {
  const storage = await getStorage();

  if (!storage.activeRunId || !storage.deviceToken) {
    return false;
  }

  const run = await apiClient.getRun(storage.activeRunId, storage.deviceToken);

  if (run.status !== 'INTERRUPTED' && run.status !== 'RECOVERING') {
    return false;
  }

  await updateStorage({
    extensionStatus: 'RECOVERING',
    backendRunStatus: run.status,
    lastError: null
  });

  const recovered = await apiClient.recoverRun(storage.activeRunId, storage.deviceToken);

  await startAssignedRun(
    {
      runId: storage.activeRunId,
      agentToken: recovered.agentToken,
      commandId: undefined
    },
    'recovery'
  );

  return true;
}
