import { apiClient } from '../shared/apiClient';
import { pushLog } from '../shared/logger';
import { getStorage } from '../shared/storageManager';
import type { BrowserSearchTask } from '../shared/types';
import { searchAliExpressProducts } from './aliexpressSearch';

/**
 * 이미 처리(성공 또는 실패 보고)된 태스크 ID를 추적한다.
 * heartbeat 응답에서 같은 태스크가 반복 전달되는 것을 방지한다.
 * (서버 COMPLETED/FAILED 반영에 약간의 지연이 있을 수 있으므로 클라이언트에서도 필터링)
 */
const processedTaskIds = new Set<number>();

async function processTask(task: BrowserSearchTask, deviceToken: string): Promise<void> {
  // 이미 처리된 태스크는 무시
  if (processedTaskIds.has(task.taskId)) {
    pushLog({
      runId: null,
      deviceId: null,
      stepIndex: null,
      action: null,
      status: 'BROWSER_SEARCH_SKIP',
      message: `이미 처리된 태스크 스킵 - taskId=${task.taskId}`
    });
    return;
  }

  pushLog({
    runId: null,
    deviceId: null,
    stepIndex: null,
    action: null,
    status: 'BROWSER_SEARCH_START',
    message: `브라우저 검색 태스크 시작 - taskId=${task.taskId}, keyword="${task.keyword}"`
  });

  try {
    const products = await searchAliExpressProducts(task.keyword, task.maxResults, task.searchUrl);

    await apiClient.reportBrowserSearchResults(
      {
        taskId: task.taskId,
        candidates: products,
      },
      deviceToken
    );

    // 성공 → 재디스패치 방지를 위해 로컬 추적
    processedTaskIds.add(task.taskId);

    pushLog({
      runId: null,
      deviceId: null,
      stepIndex: null,
      action: null,
      status: 'BROWSER_SEARCH_REPORTED',
      message: `브라우저 검색 결과 보고 완료 - taskId=${task.taskId}, count=${products.length}`
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    pushLog({
      runId: null,
      deviceId: null,
      stepIndex: null,
      action: null,
      status: 'BROWSER_SEARCH_FAILED',
      message: `브라우저 검색 실패 → 서버에 실패 보고 - taskId=${task.taskId}, reason=${reason}`
    });

    // 실패를 서버에 보고하여 FAILED로 마킹 → 재디스패치 중단
    try {
      await apiClient.reportBrowserSearchFailure(
        { taskId: task.taskId, reason },
        deviceToken
      );
    } catch (reportError) {
      console.warn('[browserSearchTaskManager] 실패 보고 전송 오류:', reportError);
    }

    // 실패도 로컬 추적하여 동일 heartbeat 주기 내 재시도 방지
    processedTaskIds.add(task.taskId);
  }
}

export async function processBrowserSearchTasks(tasks: BrowserSearchTask[]): Promise<void> {
  if (tasks.length === 0) return;

  const storage = await getStorage();
  const deviceToken = storage.deviceToken;
  if (!deviceToken) {
    pushLog({
      runId: null,
      deviceId: null,
      stepIndex: null,
      action: null,
      status: 'BROWSER_SEARCH_SKIP',
      message: 'deviceToken 없음, 브라우저 검색 태스크 스킵'
    });
    return;
  }

  // 이미 처리된 태스크 필터링
  const pendingTasks = tasks.filter((task) => !processedTaskIds.has(task.taskId));
  if (pendingTasks.length === 0) {
    return;
  }

  pushLog({
    runId: null,
    deviceId: null,
    stepIndex: null,
    action: null,
    status: 'BROWSER_SEARCH_BATCH_START',
    message: `브라우저 검색 배치 시작 - taskCount=${pendingTasks.length} (filtered from ${tasks.length})`
  });

  for (const task of pendingTasks) {
    await processTask(task, deviceToken);
  }

  pushLog({
    runId: null,
    deviceId: null,
    stepIndex: null,
    action: null,
    status: 'BROWSER_SEARCH_BATCH_DONE',
    message: `브라우저 검색 배치 완료 - taskCount=${pendingTasks.length}`
  });
}
