import { collectSnapshot } from './snapshotCollector';
import { executeInstruction, locateElementCenter } from './actionExecutor';
import { collectAliExpressSearchResults } from './aliexpressSearchCollector';

/**
 * content script 진입점.
 *
 * 역할: 현재 페이지에서 스냅샷 수집 및 DOM 조작 메시지를 처리한다.
 * 동작: manifest.json의 matches 필드가 이미 지원 도메인을 제한하므로
 *       content script는 항상 활성화된다.
 *       메시지 리스너를 동기적으로 즉시 등록해 background의 COLLECT_SNAPSHOT
 *       메시지를 항상 수신할 수 있도록 한다.
 * 주의: 이전에 chrome.storage.local.get(supportedDomains)를 비동기로 읽은 뒤
 *       리스너를 등록하는 방식을 사용했으나, 탭 로드 직후 background가 메시지를
 *       보내면 아직 async 초기화가 완료되지 않아 "Could not establish connection"
 *       에러가 발생하는 race condition이 있었다. → 리스너를 항상 동기적으로 등록.
 * 연관: platformManager(background), snapshotCollector, actionExecutor.
 */
function initialize() {
  console.info('[content] PBM Agent AI content script loaded', {
    url: window.location.href,
    title: document.title
  });

  // 메시지 리스너를 동기적으로 즉시 등록 (async 대기 없음)
  // → background의 COLLECT_SNAPSHOT 메시지를 언제든 수신 가능
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'COLLECT_SNAPSHOT') {
      collectSnapshot()
        .then((snapshot) => {
          sendResponse({
            type: 'SNAPSHOT_RESULT',
            payload: { ok: true, snapshot }
          });
        })
        .catch((error) => {
          sendResponse({
            type: 'SNAPSHOT_RESULT',
            payload: {
              ok: false,
              error: error instanceof Error ? error.message : 'snapshot 수집 실패'
            }
          });
        });
      return true; // sendResponse를 비동기로 사용함을 Chrome에 알림
    }

    if (message?.type === 'GET_ELEMENT_RECT') {
      const instruction = message.payload.instruction;
      const result = locateElementCenter(instruction);
      if (result) {
        sendResponse({
          type: 'ELEMENT_RECT_RESULT',
          payload: { ok: true, x: result.x, y: result.y, debug: result.debug }
        });
      } else {
        sendResponse({ type: 'ELEMENT_RECT_RESULT', payload: { ok: false, error: '대상 요소를 찾지 못함', errorCode: 'ELEMENT_NOT_FOUND' } });
      }
      return false;
    }

    if (message?.type === 'COLLECT_ALIEXPRESS_SEARCH_RESULTS') {
      // collectAliExpressSearchResults가 비동기(DOM 폴링)이므로 sendResponse를 비동기로 사용
      collectAliExpressSearchResults(
        message.payload.keyword,
        message.payload.maxResults
      )
        .then((products) => {
          sendResponse({
            type: 'ALIEXPRESS_SEARCH_RESULTS',
            payload: { ok: true, products }
          });
        })
        .catch((error) => {
          sendResponse({
            type: 'ALIEXPRESS_SEARCH_RESULTS',
            payload: {
              ok: false,
              error: error instanceof Error ? error.message : 'AliExpress 검색 결과 수집 실패'
            }
          });
        });
      return true; // sendResponse를 비동기로 사용함을 Chrome에 알림
    }

    if (message?.type === 'EXECUTE_ACTION') {
      const instruction = message.payload.instruction;

      // NAVIGATE는 window.location.href 변경 → 페이지 이동 → content script 파괴 순으로 진행됨
      // .then(sendResponse)가 실행되기 전에 채널이 끊겨 "message channel closed" 에러 발생
      // → 응답을 먼저 보내고 이동하는 방식으로 해결
      if (instruction.action === 'NAVIGATE') {
        sendResponse({
          type: 'ACTION_RESULT',
          payload: {
            ok: true,
            result: {
              stepIndex: instruction.stepIndex,
              actionId: instruction.actionId,
              action: 'NAVIGATE',
              status: 'SUCCESS'
            }
          }
        });
        // 응답 전송 후 이동 (setTimeout으로 sendResponse가 완전히 전달된 뒤 실행)
        setTimeout(() => {
          window.location.href = instruction.value ?? '';
        }, 0);
        return false; // sendResponse 이미 호출
      }

      void executeInstruction(instruction).then(sendResponse);
      return true;
    }

    return false;
  });
}

initialize();
