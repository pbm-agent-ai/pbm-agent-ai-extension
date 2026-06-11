import { useCallback, useEffect, useRef, useState } from 'react';

import { apiClient } from '../shared/apiClient';
import type { BackgroundToSidePanelMessage, RunDetailResponse, RuntimeMessage } from '../shared/types';

export function useStatusSnapshot() {
  const [snapshot, setSnapshot] = useState<BackgroundToSidePanelMessage['payload'] | null>(null);

  const requestSnapshot = useCallback(() => {
    const message: RuntimeMessage = { type: 'REQUEST_STATUS_SNAPSHOT' };
    console.info('[sidepanel-debug] requestSnapshot: 전송');
    chrome.runtime.sendMessage(message, (response: BackgroundToSidePanelMessage | undefined) => {
      if (chrome.runtime.lastError || !response || response.type !== 'STATUS_SNAPSHOT') {
        console.warn('[sidepanel-debug] requestSnapshot: 실패/무효 응답', {
          lastError: chrome.runtime.lastError?.message,
          hasResponse: !!response,
          responseType: response?.type
        });
        return;
      }
      console.info('[sidepanel-debug] requestSnapshot: 응답 수신', {
        deviceId: response.payload.deviceId ? response.payload.deviceId.slice(0, 12) + '…' : null,
        deviceTokenExists: response.payload.deviceTokenExists,
        extensionStatus: response.payload.extensionStatus,
        activeRunId: response.payload.activeRunId ? response.payload.activeRunId.slice(0, 12) + '…' : null
      });
      setSnapshot(response.payload);
    });
  }, []);

  useEffect(() => {
    // 초기 스냅샷 요청
    requestSnapshot();

    // 브로드캐스트(STATUS_SNAPSHOT) 수신
    const messageListener = (message: unknown) => {
      const response = message as BackgroundToSidePanelMessage | undefined;
      if (response?.type === 'STATUS_SNAPSHOT') {
        console.info('[sidepanel-debug] runtime.onMessage: STATUS_SNAPSHOT 수신', {
          deviceId: response.payload.deviceId ? response.payload.deviceId.slice(0, 12) + '…' : null,
          deviceTokenExists: response.payload.deviceTokenExists,
          extensionStatus: response.payload.extensionStatus,
          activeRunId: response.payload.activeRunId ? response.payload.activeRunId.slice(0, 12) + '…' : null
        });
        setSnapshot(response.payload);
      }
    };
    chrome.runtime.onMessage.addListener(messageListener);

    // storage 변경 감지 → 브로드캐스트가 누락된 경우에도 상태 동기화
    const storageListener = (changes: Record<string, chrome.storage.StorageChange>) => {
      const relevantKeys = ['deviceId', 'deviceToken', 'extensionStatus', 'activeRunId'];
      const changed = relevantKeys.filter((key) => key in changes);
      if (changed.length > 0) {
        console.info('[sidepanel-debug] storage.onChanged: 관련 키 변경 감지 → requestSnapshot', {
          changedKeys: changed,
          newValues: Object.fromEntries(
            changed.map((k) => [
              k,
              k === 'deviceId' || k === 'activeRunId'
                ? (changes[k].newValue?.toString().slice(0, 12) ?? '') + '…'
                : changes[k].newValue
            ])
          )
        });
        requestSnapshot();
      }
    };
    chrome.storage.onChanged.addListener(storageListener);

    return () => {
      chrome.runtime.onMessage.removeListener(messageListener);
      chrome.storage.onChanged.removeListener(storageListener);
    };
  }, [requestSnapshot]);

  return snapshot;
}

/** chrome.storage에서 deviceId, deviceToken을 직접 읽어오는 훅 */
export function useDeviceCredentials() {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [deviceToken, setDeviceToken] = useState<string | null>(null);

  useEffect(() => {
    chrome.storage.local.get(['deviceId', 'deviceToken'], (result) => {
      setDeviceId(result.deviceId ?? null);
      setDeviceToken(result.deviceToken ?? null);
    });

    const listener = () => {
      chrome.storage.local.get(['deviceId', 'deviceToken'], (result) => {
        setDeviceId(result.deviceId ?? null);
        setDeviceToken(result.deviceToken ?? null);
      });
    };

    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  return { deviceId, deviceToken };
}

/** 디바이스에 할당된 활성 run 목록을 조회하고 abort 기능을 제공하는 훅 */
export function useDeviceRuns() {
  const { deviceId, deviceToken } = useDeviceCredentials();
  const [runs, setRuns] = useState<RunDetailResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchRuns = useCallback(async () => {
    if (!deviceId || !deviceToken) return;
    try {
      setError(null);
      const data = await apiClient.getDeviceRuns(deviceId, deviceToken);
      setRuns(data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : '조회 실패');
    }
  }, [deviceId, deviceToken]);

  // 마운트 시 즉시 조회 + 10초마다 자동 갱신
  useEffect(() => {
    if (!deviceId || !deviceToken) return;
    setLoading(true);
    fetchRuns().finally(() => setLoading(false));
    intervalRef.current = setInterval(fetchRuns, 10_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [deviceId, deviceToken, fetchRuns]);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      await fetchRuns();
    } finally {
      setLoading(false);
    }
  }, [fetchRuns]);

  const abortRun = useCallback(async (runId: string) => {
    if (!deviceToken) return;
    try {
      await apiClient.abortRun(runId, deviceToken, { reason: 'USER_CANCELLED' });
      await refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : '중단 실패');
    }
  }, [deviceToken, refetch]);

  return { runs, setRuns, loading, error, refetch, abortRun };
}
