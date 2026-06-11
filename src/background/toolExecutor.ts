import { apiClient } from '../shared/apiClient';
import { pushLog } from '../shared/logger';
import { broadcastStatusSnapshot } from '../shared/messageRouter';
import { getStorage, setLastToolResult } from '../shared/storageManager';
import type { ActionInstruction, CaptureVisibleTabInput, ScreenshotArtifact, ToolResult } from '../shared/types';

function inferMimeType(format: CaptureVisibleTabInput['format']): string {
  return format === 'jpeg' ? 'image/jpeg' : 'image/png';
}

function dataUrlByteLength(dataUrl: string): number {
  const base64 = dataUrl.split(',')[1] ?? '';
  return Math.floor((base64.length * 3) / 4);
}

async function captureVisibleTab(input?: CaptureVisibleTabInput): Promise<ScreenshotArtifact> {
  const currentWindow = await chrome.windows.getCurrent();
  const dataUrl = await chrome.tabs.captureVisibleTab(currentWindow.id!, {
    format: input?.format ?? 'png',
    quality: input?.format === 'jpeg' ? input?.quality ?? 80 : undefined
  });

  return {
    dataUrl,
    mimeType: inferMimeType(input?.format),
    byteLength: dataUrlByteLength(dataUrl)
  };
}

export async function executeToolInstruction(instruction: ActionInstruction): Promise<ToolResult> {
  const storage = await getStorage();

  if (!instruction.toolRequest) {
    throw new Error('toolRequest 가 없음');
  }

  if (instruction.toolRequest.name !== 'CAPTURE_VISIBLE_TAB') {
    throw new Error(`지원하지 않는 tool: ${instruction.toolRequest.name}`);
  }

  const screenshot = await captureVisibleTab(instruction.toolRequest.input);

  const result: ToolResult = {
    name: instruction.toolRequest.name,
    success: true,
    screenshot
  };

  await setLastToolResult(result);

  pushLog({
    runId: storage.activeRunId,
    deviceId: storage.deviceId,
    stepIndex: storage.stepIndex,
    action: instruction.action,
    status: 'TOOL_EXECUTED',
    message: `${instruction.toolRequest.name} 실행 완료 (${screenshot.byteLength} bytes)`
  });

  await broadcastStatusSnapshot();

  return result;
}
