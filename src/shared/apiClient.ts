import { getConfig } from './config';
import type {
  ApiResponse,
  AbortRunRequest,
  HeartbeatRequest,
  HeartbeatResponse,
  PendingRunsResponse,
  RegisterDeviceRequest,
  RegisterDeviceResponse,
  RecoverRunResponse,
  RunDetailResponse,
  StepRequest,
  StepResponse,
  StartRunResponse,
  UrlPriceReport
} from './types';

interface RequestOptions extends RequestInit {
  token?: string;
}

export { request };

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { backendBaseUrl } = getConfig();
  const headers = new Headers(options.headers ?? {});

  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }

  if (options.token) {
    headers.set('Authorization', `Bearer ${options.token}`);
  }

  const response = await fetch(`${backendBaseUrl}${path}`, {
    ...options,
    headers
  });

  if (!response.ok) {
    throw new Error(`API request failed (${response.status}) for ${path}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function requestApiResponse<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await request<ApiResponse<T>>(path, options);
  return response.data;
}

export { requestApiResponse };

export const apiClient = {
  registerDevice(payload: RegisterDeviceRequest) {
    return requestApiResponse<RegisterDeviceResponse>('/api/v1/devices/register', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  heartbeat(deviceId: string, deviceToken: string, payload: HeartbeatRequest) {
    return requestApiResponse<HeartbeatResponse>(`/api/v1/devices/${deviceId}/heartbeat`, {
      method: 'POST',
      token: deviceToken
    });
  },

  getPendingRuns(deviceToken: string) {
    return requestApiResponse<PendingRunsResponse>('/api/v1/runs/pending', {
      method: 'GET',
      token: deviceToken
    });
  },

  startRun(runId: string, agentToken: string) {
    return requestApiResponse<StartRunResponse>(`/api/v1/runs/${runId}/start`, {
      method: 'POST',
      token: agentToken
    });
  },

  getRun(runId: string, token: string) {
    return requestApiResponse<RunDetailResponse>(`/api/v1/runs/${runId}`, {
      method: 'GET',
      token
    });
  },

  recoverRun(runId: string, deviceToken: string) {
    return requestApiResponse<RecoverRunResponse>(`/api/v1/runs/${runId}/recover`, {
      method: 'POST',
      token: deviceToken
    });
  },

  postStep(runId: string, agentToken: string, payload: StepRequest) {
    return requestApiResponse<StepResponse>(`/api/v1/runs/${runId}/steps`, {
      method: 'POST',
      token: agentToken,
      body: JSON.stringify(payload)
    });
  },

  abortRun(runId: string, token: string, payload: AbortRunRequest) {
    return requestApiResponse<void>(`/api/v1/runs/${runId}/abort`, {
      method: 'POST',
      token,
      body: JSON.stringify(payload)
    });
  },

  /**
   * 현재 디바이스에 할당된 모든 활성 run 목록을 조회한다.
   * 사이드패널의 Run 현황 화면에서 사용한다.
   */
  getDeviceRuns(deviceId: string, deviceToken: string) {
    return requestApiResponse<RunDetailResponse[]>('/api/v1/devices/runs', {
      method: 'GET',
      headers: { 'X-Device-Id': deviceId },
      token: deviceToken
    });
  },

  /**
   * 익스텐션이 진입할 수 있는 허용 도메인 목록을 백엔드 DB에서 조회한다.
   * 예: ["aliexpress.com", "shopping.naver.com"]
   * 시작 시 chrome.storage에 캐싱해두고 재사용한다.
   */
  getSupportedDomains(): Promise<string[]> {
    return requestApiResponse<string[]>('/api/v1/platforms/supported-domains', {
      method: 'GET'
    });
  },

  /**
   * URL 모니터링: 페이지에서 수집한 가격을 서버에 보고한다.
   * price-service가 목표가와 비교하여 조건 충족 시 구매/알림 처리한다.
   */
  reportUrlPrice(payload: UrlPriceReport, deviceToken: string): Promise<void> {
    return requestApiResponse<void>('/api/v1/url-monitoring/price-report', {
      method: 'POST',
      token: deviceToken,
      body: JSON.stringify(payload)
    });
  },
};
