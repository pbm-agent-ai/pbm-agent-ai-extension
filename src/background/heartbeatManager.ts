import { apiClient } from '../shared/apiClient';
import { HEARTBEAT_ALARM_NAME, HEARTBEAT_PERIOD_MINUTES } from '../shared/constants';
import { pushLog } from '../shared/logger';
import { broadcastStatusSnapshot } from '../shared/messageRouter';
import { getStorage, updateStorage } from '../shared/storageManager';
import type { ExtensionStatus } from '../shared/types';
import { processBrowserSearchTasks } from './browserSearchTaskManager';
import { resumeApprovalRunIfPossible } from './recoveryManager';
import { startAssignedRun } from './runManager';
import { processUrlMonitoringTasks } from './urlMonitoringManager';

const HEARTBEAT_ELIGIBLE_STATUSES: ExtensionStatus[] = [
  'PAIRED',           // 디바이스 등록 완료
  'ONLINE_STANDBY',   // 대기 중
  'EXECUTING',        // 실행 중
  'AWAITING_APPROVAL',// 승인 대기
  'AWAITING_OPTION_SELECTION', // 옵션 선택 대기
  'AWAITING_LOGIN_CREDENTIALS', // 로그인 자격증명 대기
  'RECOVERING',       // 복구 중
  'ERROR',            // 에러 후 자동 복구 대기 → heartbeat로 ONLINE_STANDBY로 전환
  'ABORTED',          // 중단 후 자동 복구 대기 → heartbeat로 ONLINE_STANDBY로 전환
  'COMPLETED'         // 완료 후 다음 run 대기 → heartbeat로 ONLINE_STANDBY로 전환
];

// heartbeat 보낼 수 있는지 확인
// ONLINE_STANDBY -> true, UNPAIRED -> false
function canRunHeartbeat(status: ExtensionStatus): boolean {
  return HEARTBEAT_ELIGIBLE_STATUSES.includes(status);
}

function resolveNextStatus(status: ExtensionStatus, activeRunId: string | null): ExtensionStatus {
  if (activeRunId) {  // 진행중인 run 있을 경우
    return status;    // 상태 그대로 유지
  }

  // run이 없으면 → 대기 가능한 상태로 전환
  // PAIRED / ONLINE_STANDBY: 정상 대기 상태
  // ERROR / ABORTED / COMPLETED: run 종료 후 자동으로 ONLINE_STANDBY로 복구
  if (
    status === 'PAIRED' ||
    status === 'ONLINE_STANDBY' ||
    status === 'ERROR' ||
    status === 'ABORTED' ||
    status === 'COMPLETED'
  ) {
    return 'ONLINE_STANDBY';
  }

  return status;
}

// async & await -> 비동기 작업을 동기처럼 순차 진행
// chrome.alarms -> 크롬 익스텐션 전용 API, 주기적으로 이벤트 발생
// Promise<void> -> 반환값 없는 비동기 함수
// 이미 알람이 있으면 중복 방지
export async function ensureHeartbeatAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(HEARTBEAT_ALARM_NAME);

  if (!existing) {
    chrome.alarms.create(HEARTBEAT_ALARM_NAME, {
      periodInMinutes: HEARTBEAT_PERIOD_MINUTES
    });
  }
}

// 'startup' | 'alarm' | 'pairing' -> 이 세 값중 하나만 가능
export async function runHeartbeat(reason: 'startup' | 'alarm' | 'pairing' = 'alarm'): Promise<void> {
  const storage = await getStorage();

  // Heartbeat 가능한 상태인지
  if (!canRunHeartbeat(storage.extensionStatus)) {
    return;   // 불가능하면 즉시 종료
  }

  // deviceId, deviceToken 있는지 확인
  if (!storage.deviceId || !storage.deviceToken) {
    pushLog({
      runId: storage.activeRunId,
      deviceId: storage.deviceId,
      stepIndex: storage.stepIndex,
      action: null,
      status: 'HEARTBEAT_SKIPPED',
      message: 'deviceId 또는 deviceToken이 없어 heartbeat를 건너뜀'
    });
    await broadcastStatusSnapshot();
    return;
  }

  const now = new Date().toISOString();
  const response = await apiClient.heartbeat(storage.deviceId, storage.deviceToken, {
    deviceId: storage.deviceId,
    extensionStatus: storage.extensionStatus,
    activeRunId: storage.activeRunId,
    stepIndex: storage.activeRunId ? storage.stepIndex : null,    // run 있으면 stepIndex 보내고 없으면 Null
    at: now
  });

  const nextStatus = resolveNextStatus(storage.extensionStatus, storage.activeRunId);
  await updateStorage({
    backendRunStatus: storage.activeRunId
      ? storage.extensionStatus === 'AWAITING_APPROVAL'
        ? 'AWAITING_APPROVAL'
        : storage.extensionStatus === 'AWAITING_OPTION_SELECTION'
          ? 'AWAITING_OPTION_SELECTION'
          : storage.extensionStatus === 'AWAITING_LOGIN_CREDENTIALS'
            ? 'AWAITING_LOGIN_CREDENTIALS'
          : 'RUNNING'
      : null,
    extensionStatus: nextStatus,
    lastHeartbeatAt: now
  });

  pushLog({
    runId: storage.activeRunId,
    deviceId: storage.deviceId,
    stepIndex: storage.stepIndex,
    action: null,
    status: 'HEARTBEAT_OK',
    message:
      response.assignedRun === null
        ? `heartbeat 성공 (${reason}), 현재 ${nextStatus} 유지`
        : `heartbeat 성공 (${reason}), assignedRun=${response.assignedRun.runId} 감지`
  });

  // URL 모니터링 태스크가 있으면 백그라운드에서 가격 수집 (AgentRun과 별개로 처리)
  if (response.urlMonitoringTasks && response.urlMonitoringTasks.length > 0) {
    // 비동기로 실행 (heartbeat 흐름을 블로킹하지 않음)
    processUrlMonitoringTasks(response.urlMonitoringTasks).catch((e) => {
      pushLog({
        runId: storage.activeRunId,
        deviceId: storage.deviceId,
        stepIndex: storage.stepIndex,
        action: null,
        status: 'URL_MONITOR_FATAL',
        message: `URL 모니터링 처리 중 오류: ${e instanceof Error ? e.message : String(e)}`
      });
    });
  }

  if (response.browserSearchTasks && response.browserSearchTasks.length > 0) {
    processBrowserSearchTasks(response.browserSearchTasks).catch((e) => {
      pushLog({
        runId: storage.activeRunId,
        deviceId: storage.deviceId,
        stepIndex: storage.stepIndex,
        action: null,
        status: 'BROWSER_SEARCH_FATAL',
        message: `브라우저 검색 처리 중 오류: ${e instanceof Error ? e.message : String(e)}`
      });
    });
  }

  // 서버가 새 run을 할당한 경우
  if (response.assignedRun) {
    const isNewRun = response.assignedRun.runId !== storage.activeRunId;

    // 현재 run이 없거나, 백엔드가 다른 run을 할당한 경우 시작
    // AWAITING_APPROVAL 중에 백엔드가 기존 run을 abort하고 새 run을 만든 경우를 처리
    if (!storage.activeRunId || isNewRun) {
      await startAssignedRun(response.assignedRun, 'heartbeat');
      return;
    }
  }

  // 승인대기중이면
  if (storage.extensionStatus === 'AWAITING_APPROVAL') {
    const resumed = await resumeApprovalRunIfPossible();

    if (resumed) {
      return; // 재개 성공하면 종료
    }
  }

  // 위 케이스 아니면 상태만 브로드캐스트
  await broadcastStatusSnapshot();
}
