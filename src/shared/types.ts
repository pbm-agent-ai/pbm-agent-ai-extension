export type ExtensionStatus =
  | 'IDLE'
  | 'PAIRED'
  | 'ONLINE_STANDBY'
  | 'EXECUTING'
  | 'AWAITING_APPROVAL'
  | 'AWAITING_OPTION_SELECTION'
  | 'AWAITING_LOGIN_CREDENTIALS'
  | 'INTERRUPTED'
  | 'RECOVERING'
  | 'ERROR'
  | 'ABORTED'
  | 'COMPLETED';

export type BackendRunStatus =
  | 'QUEUED'
  | 'ASSIGNED'
  | 'RUNNING'
  | 'AWAITING_APPROVAL'
  | 'AWAITING_OPTION_SELECTION'
  | 'AWAITING_LOGIN_CREDENTIALS'
  | 'APPROVAL_EXPIRED'
  | 'INTERRUPTED'
  | 'RECOVERING'
  | 'COMPLETED'
  | 'FAILED'
  | 'ABORTED';

export type ActionType =
  | 'NAVIGATE'
  | 'CLICK'
  | 'INPUT'
  | 'SELECT'
  | 'SCROLL'
  | 'WAIT'
  | 'USE_TOOL'
  | 'AWAIT_APPROVAL'
  | 'COMPLETE'
  | 'ABORT';

export type ToolName = 'CAPTURE_VISIBLE_TAB';

export interface CaptureVisibleTabInput {
  format?: 'png' | 'jpeg';
  quality?: number;
}

export interface ToolRequest {
  name: ToolName;
  input?: CaptureVisibleTabInput;
}

export interface ScreenshotArtifact {
  dataUrl: string;
  mimeType: string;
  byteLength: number;
}

export interface ToolResult {
  name: ToolName;
  success: boolean;
  screenshot?: ScreenshotArtifact;
  errorMessage?: string;
}

export type AbortReason =
  | 'USER_CANCELLED'
  | 'REPEATED_FAILURE'
  | 'TIMEOUT'
  | 'APPROVAL_REJECTED'
  | 'APPROVAL_EXPIRED'
  | 'RECOVERY_FAILED'
  | 'DEVICE_OFFLINE'
  | 'UNSUPPORTED_PAGE_STATE'
  | 'OPTION_SELECTION_TIMEOUT';

export interface ActionTarget {
  nodeId?: string | null;
  role?: string;
  labelText?: string;
  selector?: string;
  viewportX?: number | null;
  viewportY?: number | null;
}

export interface ApprovalContext {
  summaryText: string;
  timeoutMs: number;
}

export interface ActionInstruction {
  stepIndex: number;
  actionId: string;
  action: ActionType;
  target?: ActionTarget;
  toolRequest?: ToolRequest;
  value?: string;
  waitMs?: number;
  timeoutMs?: number;
  approvalContext?: ApprovalContext;
}

export type ActionResultStatus = 'SUCCESS' | 'FAILURE' | 'SKIPPED';

export type ActionErrorCode =
  | 'ELEMENT_NOT_FOUND'
  | 'ELEMENT_NOT_CLICKABLE'
  | 'NAVIGATION_TIMEOUT'
  | 'NAVIGATION_FAILED'
  | 'UNSUPPORTED_PAGE_STATE'
  | 'VISION_FALLBACK_REQUESTED'
  | 'AI_PLAN_UNAVAILABLE'
  | 'APPROVAL_REJECTED'
  | 'APPROVAL_EXPIRED'
  | 'NETWORK_ERROR'
  | 'UNEXPECTED_ERROR';

export interface InteractiveElement {
  nodeId: string;
  role: string;
  labelText: string;
  selector?: string;
  href?: string;       // <a> 태그의 href (상품 URL 매칭에 사용)
  isVisible: boolean;
  disabled?: boolean;
}

export interface OptionGroup {
  groupName: string;
  nodeId?: string;
  selector?: string;
  options: string[];
  selectedOption?: string;
  /** 비활성 상태 (이전 옵션 선택 필요) */
  disabled?: boolean;
}

export interface LoginFormSnapshot {
  detected: boolean;
  usernameFilled: boolean;
  passwordFilled: boolean;
  usernameSelector?: string;
  passwordSelector?: string;
  loginButtonSelector?: string;
  usernameLabel?: string;
  passwordLabel?: string;
  loginButtonLabel?: string;
}

export interface PageSnapshot {
  currentUrl: string;
  title: string;
  visibleTextSummary: string;
  interactiveElements: InteractiveElement[];
  optionGroups?: OptionGroup[];
  loginForm?: LoginFormSnapshot;
  priceCandidates?: string[];
  currencyCandidates?: string[];
  /** 전체 페이지 HTML (전처리 없이 AI에게 직접 전달용, 최대 80KB) */
  rawHtml?: string;
  capturedAt: string;
}

export interface ActionResult {
  runId: string;
  stepIndex: number;
  actionId: string;
  action: ActionType;
  status: ActionResultStatus;
  errorCode?: ActionErrorCode;
  errorMessage?: string;
  toolResult?: ToolResult;
  snapshot?: PageSnapshot;
  completedAt: string;
}

export interface ActionResultCore {
  stepIndex: number;
  actionId: string;
  action: ActionType;
  status: ActionResultStatus;
  errorCode?: ActionErrorCode;
  errorMessage?: string;
  toolResult?: ToolResult;
}

export interface StepRequest {
  stepIndex: number;
  previousActionResult: ActionResult | null;
  snapshot: PageSnapshot;
}

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message: string;
}

export interface StepResponse {
  runId: string;
  status: BackendRunStatus;
  currentStepIndex: number;
  instruction: ActionInstruction | null;
}

export interface RunDetailResponse {
  runId: string;
  status: BackendRunStatus;
  currentStepIndex: number;
  assignedDeviceId?: string;
  assignedAt?: string;
  approvalRequestedAt?: string | null;
  abortReason?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface RecoverRunResponse {
  agentToken: string;
}

export interface AbortRunRequest {
  reason: AbortReason;
}

export interface LastAction {
  type: ActionType;
  stepIndex: number;
  at: string;
  result?: ActionResultStatus;
}

export interface ExtensionStorage {
  deviceId: string | null;
  deviceToken: string | null;
  agentToken: string | null;
  activeRunId: string | null;
  backendRunStatus: BackendRunStatus | null;
  stepIndex: number;
  failureCount: number;
  extensionStatus: ExtensionStatus;
  lastError: string | null;
  approvalRequestedAt: string | null;
  /** 현재 AWAITING_APPROVAL의 유형. PURCHASE=구매 승인 대기, CAPTCHA=봇 차단 해제 대기 */
  approvalType: 'PURCHASE' | 'CAPTCHA' | null;
  lastAction: LastAction | null;
  lastToolResult: ToolResult | null;
  targetTabId: number | null;
  targetUrl: string | null;
  lastSnapshot: PageSnapshot | null;
  lastHeartbeatAt: string | null;
  /** 백엔드로부터 가장 최근에 수신한 instruction (사이드패널 디버깅용) */
  lastInstruction: ActionInstruction | null;
  /** 백엔드 DB에서 조회한 허용 도메인 목록. 시작 시 캐싱. 예: ["aliexpress.com", "shopping.naver.com"] */
  supportedDomains: string[];
  updatedAt: string;
}

export interface StructuredLog {
  runId: string | null;
  deviceId: string | null;
  stepIndex: number | null;
  action: ActionType | null;
  status: string;
  message: string;
  at: string;
}

export interface AssignedRun {
  runId: string;
  agentToken: string;
  commandId?: string;
  platform?: string | null;
}

export interface HeartbeatRequest {
  deviceId: string;
  extensionStatus: ExtensionStatus;
  activeRunId: string | null;
  stepIndex: number | null;
  at: string;
}

export interface HeartbeatResponse {
  deviceId: string;
  deviceStatus: string;
  lastSeenAt: string;
  assignedRun: AssignedRun | null;
  /** URL 직접 입력 모니터링 태스크 목록 (없으면 빈 배열) */
  urlMonitoringTasks: UrlMonitoringTask[];
  /** 브라우저 검색 태스크 목록 (없으면 빈 배열) */
  browserSearchTasks: BrowserSearchTask[];
}

/** 서버 → 익스텐션: heartbeat 응답에 포함되는 URL 모니터링 태스크 */
export interface UrlMonitoringTask {
  taskId: number;
  subscriptionId: number | null;
  productUrl: string;
  targetPrice: number;
  currency: string;
  condition: 'ALL' | 'ANY';
  intent: string;
  commandId: string;
}

/** 익스텐션 → 서버: URL 페이지에서 수집한 가격/상품 정보 보고 */
export interface UrlPriceReport {
  subscriptionId: number;
  currentPrice: number;
  currency: string;
  /** og:title 또는 h1에서 추출한 상품명 (최초 크롤링 시 전달, 이후 null 허용) */
  productName?: string;
  /** og:image에서 추출한 대표 이미지 URL (null 허용) */
  imageUrl?: string;
}

export interface BrowserSearchTask {
  taskId: number;
  commandId: string;
  platform: string;
  keyword: string;
  searchUrl: string;
  maxResults: number;
}

export interface BrowserSearchResultReport {
  taskId: number;
  candidates: AliExpressSearchProduct[];
}

/** 익스텐션 → 서버: 브라우저 검색 태스크 실패 보고 */
export interface BrowserSearchFailureReport {
  taskId: number;
  reason: string;
}

export type PendingRunsResponse = AssignedRun | null;

export interface StartRunResponse {
  runId: string;
  status: BackendRunStatus;
  currentStepIndex: number;
}

export interface RegisterDeviceRequest {
  pairingToken: string;
  deviceId?: string | null;
  platform: string;
  extensionVersion: string;
  browserInfo: string;
}

export interface RegisterDeviceResponse {
  deviceId: string;
  deviceToken: string;
  deviceStatus?: string;
  lastSeenAt?: string;
}

export interface AliExpressSearchProduct {
  productId: string;
  title: string;
  lprice: string;
  mallName: string;
  productUrl: string;
  imageUrl?: string;
  currency: string;
  platform: 'ALIEXPRESS';
  searchKeyword: string;
}

export interface BackgroundToSidePanelMessage {
  type: 'STATUS_SNAPSHOT';
  payload: {
    deviceId: string | null;
    deviceTokenExists: boolean;
    agentTokenLoaded: boolean;
    extensionStatus: ExtensionStatus;
    activeRunId: string | null;
    backendRunStatus: BackendRunStatus | null;
    stepIndex: number;
    failureCount: number;
    lastError: string | null;
    approvalRequestedAt: string | null;
    approvalType: 'PURCHASE' | 'CAPTCHA' | null;
    lastToolResult: ToolResult | null;
    targetTabId: number | null;
    targetUrl: string | null;
    lastSnapshot: PageSnapshot | null;
    lastHeartbeatAt: string | null;
    lastInstruction: ActionInstruction | null;
    logs: StructuredLog[];
  };
}

export type SidePanelToBackgroundMessage =
  | { type: 'REQUEST_STATUS_SNAPSHOT' }
  | { type: 'CAPTCHA_MANUALLY_RESOLVED' }
  | { type: 'RESET_RUN_STATE' }
  | { type: 'RESET_USER_SESSION' }
  | { type: 'CLEAR_LOGS' };

export interface BackgroundToContentCollectSnapshotMessage {
  type: 'COLLECT_SNAPSHOT';
}

export interface BackgroundToContentCollectAliExpressSearchResultsMessage {
  type: 'COLLECT_ALIEXPRESS_SEARCH_RESULTS';
  payload: {
    keyword: string;
    maxResults?: number;
  };
}

export interface BackgroundToContentExecuteActionMessage {
  type: 'EXECUTE_ACTION';
  payload: {
    instruction: ActionInstruction;
  };
}

/** background → content: CLICK 대상 요소의 viewport 좌표 요청 (CDP 클릭용) */
export interface BackgroundToContentGetElementRectMessage {
  type: 'GET_ELEMENT_RECT';
  payload: {
    instruction: ActionInstruction;
  };
}

/** content → background: 요소 중심 좌표 응답 */
export interface ContentToBackgroundElementRectResultMessage {
  type: 'ELEMENT_RECT_RESULT';
  payload:
    | {
        ok: true;
        x: number;
        y: number;
        debug?: {
          strategy: 'nodeId' | 'selectorOrLabel' | 'viewport';
          requestedViewportX?: number | null;
          requestedViewportY?: number | null;
          requestedSelector?: string | null;
          requestedLabelText?: string | null;
          requestedNodeId?: string | null;
          elementTag: string;
          elementId?: string;
          elementClass?: string;
          elementRole?: string;
          elementText?: string;
          elementAriaLabel?: string;
          closestClickableTag?: string;
          closestClickableId?: string;
          closestClickableClass?: string;
          closestClickableRole?: string;
          closestClickableText?: string;
          closestClickableAriaLabel?: string;
          rect: {
            left: number;
            top: number;
            width: number;
            height: number;
          };
        };
      }
    | { ok: false; error: string; errorCode: string };
}

export interface ContentToBackgroundSnapshotResultMessage {
  type: 'SNAPSHOT_RESULT';
  payload:
    | {
        ok: true;
        snapshot: PageSnapshot;
      }
    | {
        ok: false;
        error: string;
      };
}

export interface ContentToBackgroundAliExpressSearchResultsMessage {
  type: 'ALIEXPRESS_SEARCH_RESULTS';
  payload:
    | {
        ok: true;
        products: AliExpressSearchProduct[];
      }
    | {
        ok: false;
        error: string;
      };
}

export interface ContentToBackgroundActionResultMessage {
  type: 'ACTION_RESULT';
  payload:
    | {
        ok: true;
        result: ActionResultCore;
      }
    | {
        ok: false;
        error: string;
      };
}

export interface PairDeviceMessage {
  type: 'PAIR_DEVICE';
  payload: RegisterDeviceRequest;
}

export interface PairDeviceResultMessage {
  type: 'PAIR_DEVICE_RESULT';
  payload:
    | {
        ok: true;
        deviceId: string;
        extensionStatus: ExtensionStatus;
      }
    | {
        ok: false;
        error: string;
      };
}

export interface SearchAliExpressProductsMessage {
  type: 'SEARCH_ALIEXPRESS_PRODUCTS';
  payload: {
    keyword: string;
    maxResults?: number;
  };
}

export interface SearchAliExpressProductsResultMessage {
  type: 'SEARCH_ALIEXPRESS_PRODUCTS_RESULT';
  payload:
    | {
        ok: true;
        products: AliExpressSearchProduct[];
      }
    | {
        ok: false;
        error: string;
      };
}

export type RuntimeMessage =
  | BackgroundToSidePanelMessage
  | SidePanelToBackgroundMessage
  | PairDeviceMessage
  | SearchAliExpressProductsMessage
  | BackgroundToContentCollectSnapshotMessage
  | BackgroundToContentExecuteActionMessage
  | BackgroundToContentGetElementRectMessage
  | BackgroundToContentCollectAliExpressSearchResultsMessage;

export type RuntimeResponse =
  | BackgroundToSidePanelMessage
  | PairDeviceResultMessage
  | SearchAliExpressProductsResultMessage
  | ContentToBackgroundSnapshotResultMessage
  | ContentToBackgroundActionResultMessage
  | ContentToBackgroundElementRectResultMessage
  | ContentToBackgroundAliExpressSearchResultsMessage;
