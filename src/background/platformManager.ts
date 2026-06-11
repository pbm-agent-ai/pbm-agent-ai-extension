import { apiClient } from '../shared/apiClient';
import { updateStorage, getStorage } from '../shared/storageManager';
import { pushLog } from '../shared/logger';

const STATIC_SUPPORTED_DOMAINS = [
  'aliexpress.com',
  'naver.com',
  'coupang.com',
  'auction.co.kr',
  'gmarket.co.kr',
  '11st.co.kr',
  'tmon.co.kr',
  'wemakeprice.com'
] as const;

/**
 * 백엔드에서 허용 도메인 목록을 조회하여 chrome.storage에 캐싱한다.
 *
 * 역할: 하드코딩된 도메인 목록(aliexpress.com)을 DB 기반으로 교체한다.
 *       시작 시(onInstalled, onStartup) 한 번 호출되어 최신 목록을 저장한다.
 * 동작: 백엔드 /api/v1/platforms/supported-domains API를 호출하고
 *       결과를 storage.supportedDomains에 저장한다.
 *       실패 시 기존 캐시(또는 기본값 ['aliexpress.com'])를 유지한다.
 */
export async function syncSupportedDomains(): Promise<void> {
  try {
    const domains = await apiClient.getSupportedDomains();
    const mergedDomains = Array.from(new Set([...STATIC_SUPPORTED_DOMAINS, ...domains]));

    if (!Array.isArray(domains) || mergedDomains.length === 0) {
      pushLog({
        runId: null,
        deviceId: null,
        stepIndex: null,
        action: null,
        status: 'PLATFORM_SYNC_WARN',
        message: '백엔드에서 빈 도메인 목록을 반환했습니다. 기존 캐시를 유지합니다.'
      });
      return;
    }

    await updateStorage({ supportedDomains: mergedDomains });

    pushLog({
      runId: null,
      deviceId: null,
      stepIndex: null,
      action: null,
      status: 'PLATFORM_SYNC_OK',
      message: `허용 도메인 목록 갱신 완료: [${mergedDomains.join(', ')}]`
    });
  } catch (error) {
    await updateStorage({ supportedDomains: [...STATIC_SUPPORTED_DOMAINS] });
    pushLog({
      runId: null,
      deviceId: null,
      stepIndex: null,
      action: null,
      status: 'PLATFORM_SYNC_ERROR',
      message: `허용 도메인 조회 실패, 기존 캐시 유지. error=${error instanceof Error ? error.message : String(error)}`
    });
  }
}

/**
 * 주어진 URL이 허용된 도메인에 해당하는지 확인한다.
 * chrome.storage에 캐싱된 도메인 목록을 사용한다.
 */
export async function isSupportedUrl(url: string | undefined | null): Promise<boolean> {
  if (!url) return false;

  try {
    const hostname = new URL(url).hostname;
    const storage = await getStorage();
    const supportedDomains = storage.supportedDomains.length > 0
      ? Array.from(new Set([...STATIC_SUPPORTED_DOMAINS, ...storage.supportedDomains]))
      : [...STATIC_SUPPORTED_DOMAINS];
    return supportedDomains.some((domain) => hostname.endsWith(domain));
  } catch {
    return false;
  }
}

/**
 * chrome.storage에 캐싱된 허용 도메인 목록을 반환한다.
 */
export async function getSupportedDomains(): Promise<string[]> {
  const storage = await getStorage();
  return storage.supportedDomains;
}
