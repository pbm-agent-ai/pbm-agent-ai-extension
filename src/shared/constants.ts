export const HEARTBEAT_ALARM_NAME = 'pbm-heartbeat';
export const HEARTBEAT_PERIOD_MINUTES = 0.25; // 15초
export const STATUS_LOG_LIMIT = 20;
export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
export const STEP_REQUEST_MAX_RETRIES = 3;
export const ACTION_EXECUTION_MAX_RETRIES = 2;
export const HEARTBEAT_MAX_FAILURES = 3;
export const OPTION_SELECTION_POLL_INTERVAL_MS = 7_000;  // 옵션 선택 대기 중 7초 간격 폴링
export const OPTION_SELECTION_TIMEOUT_MS = 3 * 60 * 1000; // 옵션 선택 타임아웃 3분

import type { ExtensionStorage } from './types';

export const DEFAULT_EXTENSION_STORAGE: ExtensionStorage = {
  deviceId: null,
  deviceToken: null,
  agentToken: null,
  activeRunId: null,
  backendRunStatus: null,
  stepIndex: 0,
  failureCount: 0,
  extensionStatus: 'IDLE',
  lastError: null,
  approvalRequestedAt: null,
  approvalType: null,
  lastAction: null,
  lastToolResult: null,
  targetTabId: null,
  targetUrl: null,
  lastSnapshot: null,
  lastHeartbeatAt: null,
  lastInstruction: null,
  // 백엔드 조회 실패 시 폴백용 최소 기본값
  // naver.com: smartstore.naver.com, nid.naver.com, cr.shopping.naver.com 등 모든 네이버 서브도메인 포함
  supportedDomains: ['aliexpress.com', 'naver.com'],
  updatedAt: ''
} as const;
