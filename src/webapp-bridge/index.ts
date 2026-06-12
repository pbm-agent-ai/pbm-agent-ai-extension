/**
 * webapp-bridge content script — Isolated World(기본값)에서 실행된다.
 *
 * 통신 방식:
 *   페이지 → window.postMessage(PING) → 콘텐츠 스크립트
 *   콘텐츠 스크립트 → window.postMessage(READY) → 페이지
 *
 *   CustomEvent 대신 postMessage를 사용하는 이유:
 *   window.postMessage는 Isolated World ↔ MAIN World 간 양방향 통신이 보장된다.
 *   CustomEvent는 Isolated World에서 발행 시 MAIN World 리스너에 전달되지 않는다.
 */

import type {
  PairDeviceMessage,
  PairDeviceResultMessage,
  SearchAliExpressProductsMessage,
  SearchAliExpressProductsResultMessage
} from '../shared/types';

const READY_MESSAGE_TYPE = 'PBM_EXT_READY';
const PAIR_REQUEST_TYPE = 'PBM_EXTENSION_PAIR_REQUEST';
const PAIR_RESULT_TYPE = 'PBM_EXTENSION_PAIR_RESULT';
const PING_TYPE = 'PBM_EXTENSION_PING';
const ALIEXPRESS_SEARCH_REQUEST_TYPE = 'PBM_ALIEXPRESS_SEARCH_REQUEST';
const ALIEXPRESS_SEARCH_RESULT_TYPE = 'PBM_ALIEXPRESS_SEARCH_RESULT';

console.log('[PBM] webapp-bridge loaded');

/**
 * extension context가 살아있는지 확인한다.
 */
function isContextValid(): boolean {
  try {
    return typeof chrome?.runtime?.id === 'string';
  } catch {
    return false;
  }
}

function sendReadyMessage() {
  window.postMessage(
    {
      type: READY_MESSAGE_TYPE,
      payload: { installed: true, version: chrome.runtime.getManifest().version }
    },
    '*'
  );
}

function getBrowserInfo() {
  return JSON.stringify({
    userAgent: navigator.userAgent,
    language: navigator.language,
    platform: navigator.platform
  });
}

window.addEventListener('message', async (event) => {
  if (event.source !== window) {
    return;
  }

  const data = event.data as { type?: string; pairingToken?: string } | undefined;

  // 프론트가 설치 여부 ping 요청 → 즉시 ready 메시지로 응답
  if (data?.type === PING_TYPE) {
    sendReadyMessage();
    return;
  }

  if (data?.type === ALIEXPRESS_SEARCH_REQUEST_TYPE) {
    if (!isContextValid()) {
      window.postMessage(
        {
          type: ALIEXPRESS_SEARCH_RESULT_TYPE,
          payload: {
            ok: false,
            error: 'Extension이 재로드됐습니다. 페이지를 새로고침한 뒤 다시 시도해주세요.'
          }
        },
        '*'
      );
      return;
    }

    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'SEARCH_ALIEXPRESS_PRODUCTS',
        payload: {
          keyword: String((event.data as { payload?: { keyword?: string } })?.payload?.keyword ?? ''),
          maxResults: 20
        }
      } satisfies SearchAliExpressProductsMessage)) as SearchAliExpressProductsResultMessage | undefined;

      window.postMessage(
        {
          type: ALIEXPRESS_SEARCH_RESULT_TYPE,
          payload: response?.payload ?? { ok: false, error: 'AliExpress 검색 응답을 받지 못했습니다.' }
        },
        '*'
      );
    } catch (error) {
      window.postMessage(
        {
          type: ALIEXPRESS_SEARCH_RESULT_TYPE,
          payload: {
            ok: false,
            error: error instanceof Error ? error.message : 'AliExpress 검색 요청 실패'
          }
        },
        '*'
      );
    }
    return;
  }

  if (data?.type !== PAIR_REQUEST_TYPE || !data.pairingToken) {
    return;
  }

  console.info('[pair-debug] webapp-bridge: PAIR_REQUEST 수신', {
    tokenPrefix: data.pairingToken.slice(0, 6) + '…',
    tokenLength: data.pairingToken.length
  });

  // extension context가 무효화된 경우
  if (!isContextValid()) {
    console.warn('[pair-debug] webapp-bridge: extension context 무효화됨');
    window.postMessage(
      {
        type: PAIR_RESULT_TYPE,
        payload: {
          ok: false,
          error: 'Extension이 재로드됐습니다. 페이지를 새로고침한 뒤 다시 시도해주세요.'
        }
      },
      '*'
    );
    return;
  }

  try {
    const message: PairDeviceMessage = {
      type: 'PAIR_DEVICE',
      payload: {
        pairingToken: data.pairingToken,
        deviceId: null,
        platform: navigator.platform,
        extensionVersion: chrome.runtime.getManifest().version,
        browserInfo: getBrowserInfo()
      }
    };

    console.info('[pair-debug] webapp-bridge → background: PAIR_DEVICE 전송', {
      tokenPrefix: data.pairingToken.slice(0, 6) + '…',
      deviceId: null,
      platform: navigator.platform
    });

    const response = (await chrome.runtime.sendMessage(message)) as PairDeviceResultMessage | undefined;

    console.info('[pair-debug] webapp-bridge: background 응답 수신', {
      ok: response?.payload && 'ok' in response.payload ? response.payload.ok : null,
      deviceId: response?.payload && 'deviceId' in (response.payload as object) ? (response.payload as Record<string, unknown>).deviceId : null,
      extensionStatus: response?.payload && 'extensionStatus' in (response.payload as object) ? (response.payload as Record<string, unknown>).extensionStatus : null,
      havePayload: !!response?.payload
    });

    window.postMessage(
      {
        type: PAIR_RESULT_TYPE,
        payload: response?.payload ?? {
          ok: false,
          error: 'extension pairing 응답을 받지 못함'
        }
      },
      '*'
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isInvalidated = message.includes('Extension context invalidated');

    console.error('[pair-debug] webapp-bridge: PAIR_DEVICE 예외', {
      isInvalidated,
      errorMessage: message.slice(0, 120)
    });

    window.postMessage(
      {
        type: PAIR_RESULT_TYPE,
        payload: {
          ok: false,
          error: isInvalidated
            ? 'Extension이 재로드됐습니다. 페이지를 새로고침한 뒤 다시 시도해주세요.'
            : `Extension 연결 실패: ${message}`
        }
      },
      '*'
    );
  }
});

// 스크립트 로드 시점에 즉시 ready 메시지 발행 (PING 없이도 감지 가능)
sendReadyMessage();
