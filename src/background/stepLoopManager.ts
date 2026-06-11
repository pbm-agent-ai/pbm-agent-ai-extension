import { apiClient } from '../shared/apiClient';
import {
  ACTION_EXECUTION_MAX_RETRIES,
  APPROVAL_TIMEOUT_MS,
  OPTION_SELECTION_POLL_INTERVAL_MS,
  OPTION_SELECTION_TIMEOUT_MS,
  STEP_REQUEST_MAX_RETRIES
} from '../shared/constants';
import { pushLog } from '../shared/logger';
import { broadcastStatusSnapshot } from '../shared/messageRouter';
import { getStorage, updateStorage } from '../shared/storageManager';
import type { ActionInstruction, ActionResult, StepResponse } from '../shared/types';
import { executeInstructionInTab } from './actionExecutor';
import { abortActiveRun, finalizeRun } from './runLifecycle';

// 동시에 여러 루프가 실행되는 것을 방지하는 플래그
// 새 run 생성 시 이전 루프가 아직 살아있으면 즉시 종료하고 새 루프에게 양보한다
let activeLoopRunId: string | null = null;

// 서버 통신이나 버튼 클릭이 실패했을 때 바로 에러를 내는게 아니라 정해진 횟수(maxRetries)만큼 재시도
async function withRetries<T>(maxRetries: number, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries - 1) {
        // 시도할떄마다 2초, 4초, 8초 이런식으로 시간을 2배씩 늘려가며 재시도를 함. 일시적인 네크워크 장애가 서버 복구로 이어질 시간을 벌어줌.
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('retry 실패');
}

async function getStepContext() {
  const storage = await getStorage();

  if (!storage.activeRunId || !storage.agentToken || !storage.lastSnapshot) {
    throw new Error('step loop 시작에 필요한 run/token/snapshot 이 부족함');
  }

  return storage;
}

// 직전 행동의 결과(previousActionResult)와 현재 화면 사진(snapshot)을 묶어서 서버에 전송하고, 지시를 받아오는 함수
async function requestNextInstruction(previousActionResult: ActionResult | null): Promise<StepResponse> {
  const storage = await getStepContext();
  const snapshot = previousActionResult?.snapshot ?? storage.lastSnapshot;

  if (!snapshot) {
    throw new Error('step 요청에 필요한 snapshot 이 없음');
  }

  return apiClient.postStep(storage.activeRunId!, storage.agentToken!, {
    stepIndex: storage.stepIndex,
    previousActionResult,
    snapshot
  });
}

// AWAIT_APPROVAL(승인 대기), COMPLETE(수행 완료), ABORT(작전 취소), 일반 행동(클릭, 타이핑)
export async function runStepLoop(): Promise<void> {
  // 현재 실행 중인 run의 ID를 확인하고 루프 소유권을 획득
  const storage0 = await getStorage();
  const myRunId = storage0.activeRunId ?? null;

  if (!myRunId) {
    return; // activeRunId 없으면 실행 불필요
  }

  // 이미 같은 run에 대한 루프가 돌고 있으면 중복 실행 방지
  if (activeLoopRunId === myRunId) {
    console.warn(`[stepLoopManager] runId=${myRunId} 루프가 이미 실행 중 → 중복 실행 무시`);
    return;
  }

  // 다른 run의 루프가 살아있으면 덮어씀 (새 run이 우선)
  activeLoopRunId = myRunId;

  let previousActionResult: ActionResult | null = null;

  try {
    while (true) {
      const storage = await getStepContext();

      // 현재 run이 바뀌었으면 이 루프는 종료 (새 run의 루프에게 양보)
      if (storage.activeRunId !== myRunId) {
        console.info(`[stepLoopManager] run 변경 감지 (${myRunId} → ${storage.activeRunId}) → 루프 종료`);
        return;
      }

      if (
        storage.extensionStatus === 'AWAITING_APPROVAL' &&
        storage.approvalRequestedAt &&
        Date.now() - new Date(storage.approvalRequestedAt).getTime() > APPROVAL_TIMEOUT_MS
      ) {
        await abortActiveRun('APPROVAL_EXPIRED', '승인 대기 시간이 초과됨');
        return;
      }

      const stepResponse = await withRetries(STEP_REQUEST_MAX_RETRIES, () => requestNextInstruction(previousActionResult));
      const instruction = stepResponse.instruction;

      if (!instruction) {
        // 옵션 선택 대기 상태: 텔레그램 응답이 올 때까지 폴링
        if (stepResponse.status === 'AWAITING_OPTION_SELECTION') {
          console.info(`[stepLoopManager] 옵션 선택 대기 → 폴링 시작 - runId=${myRunId}`);
          await updateStorage({
            extensionStatus: 'AWAITING_OPTION_SELECTION',
            backendRunStatus: 'AWAITING_OPTION_SELECTION'
          });
          await broadcastStatusSnapshot();

          const pollStartTime = Date.now();
          while (Date.now() - pollStartTime < OPTION_SELECTION_TIMEOUT_MS) {
            await new Promise((resolve) => setTimeout(resolve, OPTION_SELECTION_POLL_INTERVAL_MS));

            // run이 바뀌었으면 루프 종료
            const currentStorage = await getStorage();
            if (currentStorage.activeRunId !== myRunId) {
              console.info(`[stepLoopManager] 옵션 폴링 중 run 변경 감지 → 종료`);
              return;
            }

            const pollResponse = await withRetries(STEP_REQUEST_MAX_RETRIES, () => requestNextInstruction(null));

            // 서버가 RUNNING으로 전환 + instruction 반환 → step loop 재개
            if (pollResponse.instruction) {
              console.info(`[stepLoopManager] 옵션 선택 완료 → step loop 재개 - runId=${myRunId}`);
              await updateStorage({
                extensionStatus: 'EXECUTING',
                backendRunStatus: 'RUNNING'
              });
              await broadcastStatusSnapshot();
              // 폴링에서 받은 instruction을 다음 while iteration에서 처리하기 위해 break
              // instruction은 const라 재할당 불가 → 전체 while에서 다시 requestNextInstruction 호출
              previousActionResult = null;
              break;
            }

            // 서버가 종료 상태를 반환한 경우 (ABORTED 등 - 타임아웃)
            if (['COMPLETED', 'ABORTED', 'FAILED'].includes(pollResponse.status)) {
              const finalStatus = pollResponse.status === 'COMPLETED' ? 'COMPLETED' : 'ABORTED';
              await finalizeRun(finalStatus, { backendRunStatus: pollResponse.status });
              return;
            }

            // 아직 대기 중 → 계속 폴링
            console.debug(`[stepLoopManager] 옵션 선택 대기 중... (${Math.round((Date.now() - pollStartTime) / 1000)}초 경과)`);
          }

          // 폴링 루프가 break로 끝났으면 step loop 재개, timeout이면 abort
          if (Date.now() - pollStartTime >= OPTION_SELECTION_TIMEOUT_MS) {
            await abortActiveRun('OPTION_SELECTION_TIMEOUT', '옵션 선택 시간 초과 (3분)');
            return;
          }

          continue; // step loop의 다음 iteration으로 (새 instruction 요청)
        }

        // 그 외 상태에서 instruction null → 완료
        await finalizeRun('COMPLETED', { backendRunStatus: 'COMPLETED' });
        return;
      }

      pushLog({
        runId: storage.activeRunId,
        deviceId: storage.deviceId,
        stepIndex: instruction.stepIndex,
        action: instruction.action,
        status: 'STEP_RECEIVED',
        message: `instruction 수신: ${instruction.action}`
      });

      // 사이드패널에서 현재 처리 중인 instruction을 실시간으로 볼 수 있도록 저장
      await updateStorage({ lastInstruction: instruction });
      await broadcastStatusSnapshot();

      if (instruction.action === 'AWAIT_APPROVAL') {
        // summaryText에 '캡챠'가 포함되면 봇 차단 해제 대기, 아니면 구매 승인 대기
        const isCaptcha = instruction.approvalContext?.summaryText?.includes('캡챠') ?? false;
        await updateStorage({
          extensionStatus: 'AWAITING_APPROVAL',
          backendRunStatus: 'AWAITING_APPROVAL',
          approvalRequestedAt: new Date().toISOString(),
          approvalType: isCaptcha ? 'CAPTCHA' : 'PURCHASE'
        });
        await broadcastStatusSnapshot();
        return;
      }

      if (instruction.action === 'COMPLETE') {
        await finalizeRun('COMPLETED', { backendRunStatus: 'COMPLETED' });
        return;
      }

      if (instruction.action === 'ABORT') {
        await finalizeRun('ABORTED', {
          backendRunStatus: 'ABORTED',
          errorMessage: 'backend가 ABORT instruction 반환'
        });
        return;
      }

      // 위 3가지가 상태가 아니라면 실제로 웹페이지 버튼을 누르거나 글자를 입력함
      previousActionResult = await withRetries(ACTION_EXECUTION_MAX_RETRIES, () => executeInstructionInTab(instruction));

      // 버튼을 누르려고 하는데, 화면 로딩이 덜 돼서 버튼이 없거나 구조가 바뀐 경우 실패카운트 1 올림
      const failureCount = previousActionResult.status === 'FAILURE' ? storage.failureCount + 1 : 0;

      if (failureCount >= ACTION_EXECUTION_MAX_RETRIES) {
        await abortActiveRun(
          previousActionResult.errorCode === 'UNSUPPORTED_PAGE_STATE' ? 'UNSUPPORTED_PAGE_STATE' : 'REPEATED_FAILURE',
          previousActionResult.errorMessage ?? '동일 step 반복 실패'
        );
        return;
      }

      // FAILURE 시 backend는 currentStepIndex를 증가시키지 않으므로 extension도 그대로 유지
      // SUCCESS/SKIPPED 시에만 +1 전진 (backend의 applyPreviousActionResult 로직과 동기화)
      const nextStepIndex =
        previousActionResult.status === 'SUCCESS'
          ? instruction.stepIndex + 1
          : instruction.stepIndex;

      await updateStorage({
        extensionStatus: 'EXECUTING',
        backendRunStatus: 'RUNNING',
        stepIndex: nextStepIndex,
        failureCount,
        lastError: previousActionResult.status === 'FAILURE' ? previousActionResult.errorMessage ?? null : null
      });
    }
  } catch (error) {
    await finalizeRun('ERROR', {
      backendRunStatus: 'FAILED',
      errorMessage: error instanceof Error ? error.message : 'step loop 처리 중 알 수 없는 오류'
    });
  } finally {
    // 이 루프가 소유권을 갖고 있던 경우에만 해제
    if (activeLoopRunId === myRunId) {
      activeLoopRunId = null;
    }
  }
}
