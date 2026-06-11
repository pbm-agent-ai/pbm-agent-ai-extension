import { apiClient } from '../shared/apiClient';
import { pushLog } from '../shared/logger';
import { broadcastStatusSnapshot } from '../shared/messageRouter';
import { getStorage, updateStorage } from '../shared/storageManager';
import type { AssignedRun } from '../shared/types';
import { collectSnapshotFromActiveTab } from './contentBridge';
import { finalizeRun } from './runLifecycle';
import { runStepLoop } from './stepLoopManager';
import { ensureRunTab } from './tabManager';

// 서버에 할당된 run을 실제로 시작하고, 대기 중인 run을 가져오는 코드
type RunStartSource = 'heartbeat' | 'pending' | 'recovery';

function resolveInitialUrlByPlatform(platform?: string | null): string {
  const p = (platform ?? '').toUpperCase();

  if (p === 'ALIEXPRESS' || p === 'ALI') {
    return 'https://www.aliexpress.com/';
  }

  if (p === 'COUPANG') {
    return 'https://www.coupang.com/';
  }

  if (p === '11ST' || p === 'SSG') {
    return 'https://www.11st.co.kr/';
  }

  // NAVER 또는 미지정(null/빈값) → 네이버 쇼핑을 기본으로 사용한다.
  // 네이버 쇼핑이 한국 사용자 기준 메인 플랫폼이므로 default로 적합하다.
  return 'https://search.shopping.naver.com/home';
}

// 현재 진행중인 run과 새로 들어온 Run이 같은 run인지 확인
function isDuplicateRun(activeRunId: string | null, runId: string): boolean {
  return activeRunId === runId;
}

export async function startAssignedRun(
  assignedRun: AssignedRun,   // 서버에 할당된 run 정보
   source: RunStartSource     // 'heartbeat' | 'pending' | 'recovery'  어디서 호출됐는지 추적용
  ): Promise<void> {
  const storage = await getStorage();

  if (storage.activeRunId && !isDuplicateRun(storage.activeRunId, assignedRun.runId)) {
    // heartbeat 경유로 새 run이 할당된 경우: 백엔드가 기존 run을 abort하고 새 run을 만든 것
    // → 기존 run 상태를 초기화하고 새 run으로 교체한다
    if (source === 'heartbeat') {
      pushLog({
        runId: storage.activeRunId,
        deviceId: storage.deviceId,
        stepIndex: storage.stepIndex,
        action: null,
        status: 'RUN_SUPERSEDED',
        message: `heartbeat로 새 run ${assignedRun.runId} 할당 감지 → 기존 run ${storage.activeRunId} 를 교체함`
      });
      await updateStorage({ activeRunId: null, agentToken: null, extensionStatus: 'IDLE' });
    } else {
      pushLog({
        runId: storage.activeRunId,
        deviceId: storage.deviceId,
        stepIndex: storage.stepIndex,
        action: null,
        status: 'RUN_SKIPPED',
        message: `이미 activeRunId=${storage.activeRunId} 가 있어 새 run ${assignedRun.runId} 는 무시함`
      });
      await broadcastStatusSnapshot();
      return;
    }
  }

  const startRunResponse = await apiClient.startRun(assignedRun.runId, assignedRun.agentToken);

  await updateStorage({
    agentToken: assignedRun.agentToken,
    activeRunId: assignedRun.runId,
    backendRunStatus: startRunResponse.status,
    extensionStatus: 'EXECUTING',
    stepIndex: startRunResponse.currentStepIndex,
    failureCount: 0,
    lastError: null,
    approvalRequestedAt: null,
    targetUrl: null
  });

  pushLog({
    runId: assignedRun.runId,
    deviceId: storage.deviceId,
    stepIndex: 0,
    action: null,
    status: 'RUN_ASSIGNED',
    message: `${source} 경로로 run ${assignedRun.runId} 실행 준비 상태로 전환함`
  });

  await broadcastStatusSnapshot();

  const initialUrl = resolveInitialUrlByPlatform(assignedRun.platform);

  pushLog({
    runId: assignedRun.runId,
    deviceId: storage.deviceId,
    stepIndex: 0,
    action: null,
    status: 'RUN_TAB_INIT',
    message: `초기 탭 도메인 결정: ${initialUrl} (platform=${assignedRun.platform ?? 'UNKNOWN'})`
  });

  await ensureRunTab(initialUrl);

  try {
    await collectSnapshotFromActiveTab();
    await runStepLoop();
  } catch (error) {
    await finalizeRun('ERROR', {
      backendRunStatus: 'FAILED',
      errorMessage: error instanceof Error ? error.message : 'run 처리 중 알 수 없는 오류'
    });
  }
}

export async function syncPendingRuns(): Promise<void> {
  const storage = await getStorage();

  // 토큰 검증
  if (!storage.deviceToken) {
    return;
  }

  // 이미 다른 run이 있으면 새 run을 받지 않고 기존 Run을 진행
  if (storage.activeRunId) {
    pushLog({
      runId: storage.activeRunId,
      deviceId: storage.deviceId,
      stepIndex: storage.stepIndex,
      action: null,
      status: 'PENDING_SKIPPED',
      message: '이미 active run 이 있어 pending 조회 결과를 적용하지 않음'
    });
    await broadcastStatusSnapshot();
    return;
  }

  // AgentRunService로 HTTP 요청을 보내서 할 일(Pending Run)이 있는지 확인
  const nextRun = await apiClient.getPendingRuns(storage.deviceToken);

  // 없으면 대기
  if (!nextRun) {
    pushLog({
      runId: null,
      deviceId: storage.deviceId,
      stepIndex: storage.stepIndex,
      action: null,
      status: 'PENDING_EMPTY',
      message: 'pending run 없음'
    });
    await broadcastStatusSnapshot();
    return;
  }

  // 할 일이 있으면 진행
  await startAssignedRun(nextRun, 'pending');
}
