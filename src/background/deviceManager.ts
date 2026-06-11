import { apiClient } from '../shared/apiClient';
import { pushLog } from '../shared/logger';
import { broadcastStatusSnapshot } from '../shared/messageRouter';
import { getStorage, updateStorage } from '../shared/storageManager';
import type { PairDeviceResultMessage, RegisterDeviceRequest } from '../shared/types';
import { ensureHeartbeatAlarm, runHeartbeat } from './heartbeatManager';
import { syncPendingRuns } from './runManager';

export async function pairDevice(payload: RegisterDeviceRequest): Promise<PairDeviceResultMessage> {
  try {
    const response = await apiClient.registerDevice(payload);
    const current = await getStorage();

    console.info('[pair-debug] background: registerDevice 응답', {
      deviceIdPresent: !!response.deviceId,
      tokenPresent: !!response.deviceToken,
      deviceStatus: 'deviceStatus' in response
        ? (response as unknown as { deviceStatus?: string }).deviceStatus
        : undefined
    });

    console.info('[pair-debug] background: storage BEFORE update', {
      deviceId: current.deviceId ? current.deviceId.slice(0, 12) + '…' : null,
      tokenPresent: !!current.deviceToken,
      extensionStatus: current.extensionStatus
    });

    await updateStorage({
      deviceId: response.deviceId,
      deviceToken: response.deviceToken,
      extensionStatus: 'PAIRED'
    });

    const afterUpdate = await getStorage();
    console.info('[pair-debug] background: storage AFTER updateStorage', {
      deviceId: afterUpdate.deviceId ? afterUpdate.deviceId.slice(0, 12) + '…' : null,
      tokenPresent: !!afterUpdate.deviceToken,
      extensionStatus: afterUpdate.extensionStatus
    });

    pushLog({
      runId: current.activeRunId,
      deviceId: response.deviceId,
      stepIndex: current.stepIndex,
      action: null,
      status: 'PAIRED',
      message: 'device register 성공, extension 상태를 PAIRED로 전환함'
    });

    await ensureHeartbeatAlarm();
    await runHeartbeat('pairing');
    await syncPendingRuns();
    const updated = await getStorage();

    console.info('[pair-debug] background: storage AFTER heartbeat/syncPendingRuns', {
      deviceId: updated.deviceId ? updated.deviceId.slice(0, 12) + '…' : null,
      tokenPresent: !!updated.deviceToken,
      extensionStatus: updated.extensionStatus,
      activeRunId: updated.activeRunId ? updated.activeRunId.slice(0, 12) + '…' : null
    });

    await broadcastStatusSnapshot();

    return {
      type: 'PAIR_DEVICE_RESULT',
      payload: {
        ok: true,
        deviceId: response.deviceId,
        extensionStatus: updated.extensionStatus
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '알 수 없는 register 오류';
    const current = await getStorage();

    console.error('[pair-debug] background: registerDevice 실패', {
      errorMessage: message.slice(0, 120),
      storageDeviceId: current.deviceId ? current.deviceId.slice(0, 12) + '…' : null,
      storageExtStatus: current.extensionStatus
    });

    await updateStorage({ extensionStatus: 'ERROR' });

    pushLog({
      runId: current.activeRunId,
      deviceId: current.deviceId,
      stepIndex: current.stepIndex,
      action: null,
      status: 'PAIRING_ERROR',
      message
    });

    await broadcastStatusSnapshot();

    return {
      type: 'PAIR_DEVICE_RESULT',
      payload: {
        ok: false,
        error: message
      }
    };
  }
}
