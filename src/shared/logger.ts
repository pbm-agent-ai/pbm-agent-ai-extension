import { STATUS_LOG_LIMIT } from './constants';
import type { StructuredLog } from './types';

const logs: StructuredLog[] = [];

export function createLog(entry: Omit<StructuredLog, 'at'> & { at?: string }): StructuredLog {
  return {
    ...entry,
    at: entry.at ?? new Date().toISOString()
  };
}

export function pushLog(entry: Omit<StructuredLog, 'at'> & { at?: string }): StructuredLog {
  const next = createLog(entry);
  logs.unshift(next);

  if (logs.length > STATUS_LOG_LIMIT) {
    logs.length = STATUS_LOG_LIMIT;
  }

  const prefix = `[${next.status}]`;
  console.info(prefix, next.message, {
    runId: next.runId,
    deviceId: next.deviceId,
    stepIndex: next.stepIndex,
    action: next.action
  });

  return next;
}

export function getLogs(): StructuredLog[] {
  return [...logs];
}

export function clearLogs(): void {
  logs.length = 0;
}
