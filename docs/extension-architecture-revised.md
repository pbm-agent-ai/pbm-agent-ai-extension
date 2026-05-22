# Extension 동작 구조 - 수정된 아키텍처 가이드

> 작성일: 2026-05-16
> 상태: 설계 확정 (구현 기준선)
> 대상: `pbm-agent-ai-extension` 구현 담당 엔지니어

---

## 1. 왜 구조를 수정했는가

### 기존 방식의 문제점

초기 설계에서는 **웹앱이 확장프로그램에 직접 `START_RUN` 메시지를 보내서 실행을 트리거**하는 구조를 검토했다.

```
[기존 방식]
웹앱 → (START_RUN 직접 전송) → 확장프로그램 Service Worker
```

이 방식의 문제:

| 문제 | 설명 |
|---|---|
| MV3 Service Worker 수명 | SW는 언제든 종료될 수 있다. START_RUN을 받는 순간 SW가 죽어있으면 메시지가 유실된다. |
| 복구 불가 | 브라우저를 닫았다 다시 열면 진행 중이던 실행 정보가 사라진다. |
| 상태 비일관 | 웹앱과 확장프로그램 양쪽에 "실행 중" 상태가 분리되어 동기화가 어렵다. |
| 보안 취약점 | 웹앱에서 직접 extension으로 명령을 보내는 채널이 외부에 노출될 위험이 있다. |

### 수정된 방식

**백엔드가 실행(Run)의 단일 진실 공급원(Single Source of Truth)** 이 된다.  
확장프로그램은 백엔드를 주기적으로 확인하여 **자신에게 할당된 작업을 스스로 가져온다 (Pull 방식)**.

```
[수정된 방식]
웹앱 → 백엔드에 Run 생성/시작 요청
확장프로그램 → (heartbeat/polling) → 백엔드에서 할당된 Run 확인 → 실행
```

핵심 원칙:
- 웹앱은 백엔드에만 말한다. 확장프로그램에 직접 명령하지 않는다.
- 확장프로그램은 백엔드를 신뢰한다. 웹앱의 직접 메시지는 무시한다.
- Service Worker가 죽어도 알람(chrome.alarms)이 되살린다.
- 브라우저를 닫았다 열어도 storage에 Run 상태가 남아있어 복구된다.

---

## 2. 전체 개념 요약

```
┌──────────┐      Run 생성/시작      ┌──────────────────┐
│  웹앱    │ ──────────────────────► │   Spring 백엔드  │
└──────────┘                         │                  │
                                      │  - Run 상태 관리  │
                                      │  - Step 목록      │
                                      │  - Agent 할당     │
                                      └────────┬─────────┘
                                               │
                              heartbeat/polling │ (30초마다)
                                               │
                               ┌───────────────▼──────────────┐
                               │     Chrome Extension (MV3)   │
                               │                              │
                               │  Service Worker              │
                               │  ├─ heartbeat (alarms)       │
                               │  ├─ Run 상태 동기화           │
                               │  └─ Step 오케스트레이션       │
                               │                              │
                               │  Content Script (AliExpress) │
                               │  ├─ DOM/AX 스냅샷 수집        │
                               │  └─ 액션 실행                │
                               │                              │
                               │  Side Panel                  │
                               │  ├─ 진행 상황 표시            │
                               │  └─ 승인 요청 UI              │
                               └──────────────────────────────┘
```

**중요한 역할 분담:**

| 컴포넌트 | 하는 일 | 하지 않는 일 |
|---|---|---|
| 웹앱 | Run 생성, 모니터링 조건 설정, 진행 상황 조회 | 확장프로그램 직접 제어 |
| 백엔드 | Run 상태 관리, Step 계획, 자연어 파싱, 가격 조건 판단 | 브라우저 직접 제어 |
| 확장프로그램 | AliExpress 탭 제어, DOM/AX 수집, 액션 실행, 승인 게이트 | 자연어 파싱, 가격 판단, 결제 자동화 |

---

## 3. 사용자 기준 흐름

### 설치부터 첫 실행까지

```
1. 사용자가 확장프로그램 설치
      ↓
2. Side Panel 열기 → 로그인 or 장치 등록 진행
      ↓
3. 백엔드에서 deviceId + agentToken 발급
      ↓
4. 확장프로그램이 heartbeat 시작 (30초 주기 알람 등록)
      ↓
5. 사용자가 웹앱에서 "AliExpress 모니터링 시작" 설정
   (상품명, 목표가격, 수량 등)
      ↓
6. 백엔드가 Run 생성 + 해당 장치에 할당
      ↓
7. 확장프로그램 heartbeat에서 할당된 Run 감지
      ↓
8. AliExpress 탭 열기 → 단계별 실행 시작
      ↓
9. 최종 주문 직전 → 사용자에게 승인 요청 표시
      ↓
10. 사용자 승인 → 백엔드에 승인 완료 전달 → 주문 실행
       ↓
11. 완료 또는 실패 결과 백엔드에 보고
```

### 브라우저 재시작 후 복구 흐름

```
1. 조건 충족 → 백엔드가 Run을 ASSIGNED 상태로 전환
      ↓
2. (브라우저 종료됨 - 확장프로그램 중단)
      ↓
3. 사용자가 브라우저 재시작
      ↓
4. Service Worker 시작 → chrome.alarms 재등록
      ↓
5. chrome.storage.local에 저장된 runId 확인
      ↓
6. 백엔드에 해당 runId 상태 조회
      ↓
7. ASSIGNED / IN_PROGRESS 상태 확인 → 이어서 실행
      ↓
8. 이미 완료된 stepIndex부터 이어서 진행 (멱등성 보장)
```

---

## 4. Extension 내부 기준 흐름

### 4-1. 초기화 (Service Worker 시작)

```
Service Worker onInstalled / onStartup
  │
  ├── chrome.storage.local에서 deviceId, agentToken 로드
  │
  ├── heartbeat 알람 등록 (없으면 새로 등록)
  │   chrome.alarms.create('heartbeat', { periodInMinutes: 0.5 })
  │
  └── 진행 중인 runId가 있으면 → activeRun 복구 시도
```

### 4-2. Heartbeat 주기 실행

```
chrome.alarms.onAlarm (name === 'heartbeat')
  │
  ├── [인증 상태 확인]
  │   deviceId / agentToken 없음 → skip (로그인 필요 알림)
  │
  ├── POST /api/agent/heartbeat
  │   body: { deviceId, currentRunId (있으면) }
  │
  ├── 응답 분석
  │   ├── assignedRun 있음 → activeRun 시작 흐름 진입
  │   ├── currentRun 상태 IN_PROGRESS → 이미 실행 중 확인
  │   └── 없음 → idle 유지
  │
  └── storage.local 업데이트 (lastHeartbeatAt 갱신)
```

### 4-3. Run 실행 루프

```
startRun(runId)
  │
  ├── storage.local에 { activeRunId: runId, runStatus: 'IN_PROGRESS' } 저장
  │
  ├── AliExpress 탭 확보 (기존 탭 찾기 or 새 탭 열기)
  │
  └── stepLoop(runId, stepIndex)
        │
        ├── GET /api/agent/runs/{runId}/next-step?from={stepIndex}
        │
        ├── step.type에 따라 분기
        │   ├── NAVIGATE   → content script에 URL 이동 요청
        │   ├── CLICK      → content script에 selector/role 기반 클릭 요청
        │   ├── INPUT      → content script에 입력 요청 (민감정보 제외)
        │   ├── SNAPSHOT   → content script에서 DOM/AX 스냅샷 수집
        │   ├── WAIT       → 일정 시간 대기
        │   └── APPROVAL   → 사용자 승인 대기 (아래 4-4 참조)
        │
        ├── 액션 실행 결과를 백엔드에 보고
        │   POST /api/agent/runs/{runId}/steps/{stepIndex}/result
        │
        ├── stepIndex += 1, storage 갱신
        │
        ├── step.isLast === true → completeRun()
        │
        └── 다음 step 반복
```

### 4-4. 승인 게이트

```
APPROVAL 타입 step 도착
  │
  ├── storage.local에 runStatus: 'WAITING_APPROVAL' 저장
  │
  ├── Side Panel에 메시지 전송
  │   { type: 'SHOW_APPROVAL', summary: '..., total: '₩12,500', items: [...] }
  │
  ├── 사용자 응답 대기 (polling 또는 메시지 이벤트)
  │
  ├── 승인 시
  │   ├── POST /api/agent/runs/{runId}/approve
  │   └── stepLoop 재개
  │
  └── 거절 시
      ├── POST /api/agent/runs/{runId}/abort { reason: 'USER_REJECTED' }
      └── activeRun 클리어
```

### 4-5. 실패 / 중단 처리

```
액션 실행 실패 (DOM 못 찾음, 네트워크 오류 등)
  │
  ├── 재시도 가능 여부 판단 (최대 3회)
  │   ├── 재시도 → 동일 step 재실행
  │   └── 재시도 초과 → 실패 처리
  │
  ├── POST /api/agent/runs/{runId}/fail
  │   body: { stepIndex, errorCode, message }
  │
  ├── storage.local에 runStatus: 'FAILED' 저장
  │
  └── Side Panel에 실패 알림 전송
```

---

## 5. 예시 시나리오: 가격 모니터링 → 브라우저 재시작 → 승인 후 구매

### 배경

> 사용자가 웹앱에서 "AliExpress에서 블루투스 이어폰, 목표가 15,000원 이하이면 1개 구매" 모니터링을 설정했다.

### 전체 타임라인

```
[오전 10:00] 사용자가 웹앱에서 모니터링 설정 → 백엔드가 Run#42 생성 (PENDING 상태)

[오전 10:05] 확장프로그램 heartbeat → Run#42 PENDING 확인 → 아직 조건 미충족 → 대기

[오전 11:30] 백엔드 가격 체크 로직 → 목표 가격 충족 감지
             → Run#42 상태를 ASSIGNED로 전환
             → 해당 deviceId에 할당

[오전 11:30] 사용자 브라우저 종료됨 (확장프로그램 비활성)

[오후 2:00]  사용자 브라우저 재시작

[오후 2:00]  Service Worker 시작
             → chrome.alarms 재등록
             → storage.local 확인 → 이전 runId 없음 (브라우저 닫기 전 실행 전이었음)

[오후 2:00]  첫 heartbeat 실행
             → POST /api/agent/heartbeat
             → 응답: { assignedRun: { runId: 42, status: 'ASSIGNED' } }
             → Run#42 실행 시작

[오후 2:01]  AliExpress 탭 열기
             → 검색 페이지 이동 (NAVIGATE step)
             → 상품 클릭 (CLICK step)
             → 옵션 선택 (CLICK step)
             → 장바구니 추가 (CLICK step)
             → 주문 페이지 이동 (NAVIGATE step)
             → 배송지 확인 (SNAPSHOT step)

[오후 2:03]  APPROVAL step 도착
             → Side Panel에 승인 카드 표시:
               ┌─────────────────────────────────────┐
               │ 주문 확인 요청                        │
               │ 상품: 블루투스 이어폰 (화이트)        │
               │ 수량: 1개                             │
               │ 금액: ₩14,800                        │
               │ 배송지: 홍길동 / 서울시 강남구...     │
               │                                      │
               │   [승인하기]     [취소]               │
               └─────────────────────────────────────┘

[오후 2:03]  사용자 [승인하기] 클릭
             → POST /api/agent/runs/42/approve
             → 최종 주문 버튼 클릭 (CLICK step 재개)

[오후 2:04]  주문 완료 페이지 감지
             → POST /api/agent/runs/42/complete
             → storage.local activeRunId 클리어
             → Side Panel: "주문 완료" 표시
```

### 만약 브라우저가 실행 도중 다시 꺼졌다면

```
[오후 2:02]  탭 제어 도중 브라우저 강제 종료

[오후 3:00]  사용자 브라우저 재시작

[오후 3:00]  Service Worker 시작
             → storage.local 확인
               { activeRunId: 42, runStatus: 'IN_PROGRESS', stepIndex: 3 }

             → 백엔드에 GET /api/agent/runs/42 조회
             → 상태: IN_PROGRESS, lastCompletedStep: 2
             → stepIndex 3부터 재개 (이미 완료된 step 재실행 방지)

[오후 3:01]  이어서 진행 → 승인 게이트 → 완료
```

---

## 6. 상태 모델

### Run 상태 (백엔드 기준)

```
PENDING → ASSIGNED → IN_PROGRESS → WAITING_APPROVAL → COMPLETED
                                                      → ABORTED
                         ↓
                       FAILED
                         ↓
                    INTERRUPTED (브라우저 강제 종료 등)
```

| 상태 | 의미 | 확장프로그램 동작 |
|---|---|---|
| PENDING | 조건 미충족, 대기 중 | heartbeat에서 확인만 |
| ASSIGNED | 조건 충족, 실행 대상 장치 지정됨 | Run 실행 시작 |
| IN_PROGRESS | 확장프로그램이 실행 중 | Step 루프 진행 |
| WAITING_APPROVAL | 사용자 승인 대기 | 승인 게이트 표시 |
| INTERRUPTED | 비정상 종료 감지됨 | 재시작 시 복구 시도 |
| COMPLETED | 성공 완료 | activeRun 클리어 |
| ABORTED | 사용자 취소 or 시스템 중단 | activeRun 클리어 |
| FAILED | 실행 오류로 종료 | 실패 알림, 클리어 |

### storage.local 필드 정의

```typescript
interface ExtensionStorage {
  // 장치 인증
  deviceId: string;           // 등록 시 발급, 영구 유지
  agentToken: string;         // per-run 발급, Run 종료 시 무효화

  // 활성 Run 상태
  activeRunId: number | null;
  runStatus: RunStatus | null;
  stepIndex: number;          // 마지막으로 완료된 stepIndex
  aliexpressTabId: number | null;

  // 메타
  lastHeartbeatAt: string;    // ISO 8601
  lastError: string | null;
}
```

> **주의**: `agentToken`은 per-run 단기 토큰이다. Run이 끝나면 즉시 폐기하고, 다음 Run 시작 시 백엔드에서 새로 발급받는다.

### 확장프로그램 내부 상태 전이

```
[IDLE]
  │ heartbeat에서 assignedRun 감지
  ▼
[STARTING]
  │ 탭 확보 완료
  ▼
[RUNNING]
  │ APPROVAL step 도착
  ▼
[WAITING_APPROVAL]
  │ 사용자 승인
  ▼
[RUNNING]
  │ isLast step 완료
  ▼
[DONE]

모든 상태에서 오류 발생 시 → [FAILED]
모든 상태에서 사용자 취소 시 → [ABORTED]
```

---

## 7. 구현 방식 제안

### 7-1. 모듈 책임 분리

#### Service Worker (`src/background/`)

| 파일 | 책임 |
|---|---|
| `index.ts` | SW 진입점, 알람/메시지 이벤트 등록 |
| `heartbeat.ts` | heartbeat 주기 실행, 백엔드 응답 해석 |
| `runOrchestrator.ts` | Run 시작/재개/중단 로직, stepLoop 진행 |
| `stepExecutor.ts` | step type별 실행 디스패치 |
| `storageManager.ts` | storage.local read/write 래퍼 |
| `apiClient.ts` | 백엔드 API 호출 모음 (fetch 래퍼) |

#### Content Script (`src/content/`)

| 파일 | 책임 |
|---|---|
| `index.ts` | CS 진입점, SW 메시지 수신 등록 |
| `domController.ts` | aria, data-*, role 기반 DOM 탐색 + 클릭/입력 실행 |
| `snapshotCollector.ts` | DOM/AX 스냅샷 수집 (민감 영역 제외) |
| `pageObserver.ts` | URL 변화, 페이지 상태 감지 |

#### Side Panel (`src/sidepanel/`)

| 파일 | 책임 |
|---|---|
| `App.tsx` | 패널 루트, SW 메시지 구독 |
| `ApprovalCard.tsx` | 승인 요청 카드 (상품명/금액/배송지 표시 + 버튼) |
| `StepLog.tsx` | 진행 단계 로그 리스트 |
| `StatusBadge.tsx` | 현재 Run 상태 뱃지 표시 |

### 7-2. heartbeat 구현 예시

```typescript
// background/heartbeat.ts

chrome.alarms.create('heartbeat', { periodInMinutes: 0.5 }); // 30초

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'heartbeat') return;

  const { deviceId, agentToken, activeRunId } = await storageManager.load();
  if (!deviceId || !agentToken) return; // 로그인 안 된 상태

  const response = await apiClient.heartbeat({ deviceId, currentRunId: activeRunId });

  if (response.assignedRun && !activeRunId) {
    // 새로 할당된 Run 발견 → 실행 시작
    await runOrchestrator.start(response.assignedRun.runId);
  }
});
```

> **setInterval 사용 금지**: MV3 Service Worker는 수명이 짧아서 `setInterval`이 SW 종료 시 함께 사라진다. `chrome.alarms`는 SW가 죽어있어도 알람이 울리면 SW를 다시 깨운다.

### 7-3. Step 루프 멱등성 보장

```typescript
// background/runOrchestrator.ts

async function stepLoop(runId: number, fromStepIndex: number) {
  let stepIndex = fromStepIndex;

  while (true) {
    // 1. 백엔드에서 다음 step 가져오기 (이미 완료된 것은 skip)
    const step = await apiClient.getNextStep(runId, stepIndex);

    if (!step) break; // 더 이상 step 없음 → 완료

    // 2. step 실행
    const result = await stepExecutor.execute(step);

    // 3. 결과 보고 (실패해도 보고는 반드시 시도)
    await apiClient.reportStepResult(runId, stepIndex, result);

    // 4. stepIndex 갱신 + storage 저장
    stepIndex = step.index + 1;
    await storageManager.update({ stepIndex });

    // 5. 완료 확인
    if (step.isLast) {
      await completeRun(runId);
      break;
    }
  }
}
```

핵심: `stepIndex`는 "다음에 실행할 index"가 아니라 **"마지막으로 완료한 index + 1"** 을 가리킨다.  
재시작 시 `storage.local`의 `stepIndex`를 그대로 사용하면 이미 완료된 step을 다시 실행하지 않는다.

### 7-4. 스냅샷 수집 원칙

```typescript
// content/snapshotCollector.ts

function collectSnapshot(): PageSnapshot {
  return {
    url: location.href,
    title: document.title,
    // 전체 DOM dump 금지 - 필요한 영역만 수집
    interactiveElements: collectInteractiveElements(),
    // 민감 영역은 수집하지 않음
  };
}

function collectInteractiveElements() {
  return Array.from(
    document.querySelectorAll('button, [role="button"], input:not([type="password"]), select, a')
  ).map(el => ({
    tag: el.tagName,
    role: el.getAttribute('role'),
    ariaLabel: el.getAttribute('aria-label'),
    text: el.textContent?.trim().slice(0, 100), // 텍스트는 100자 제한
    dataAttrs: collectDataAttrs(el),
  }));
}

// 절대 수집하지 않는 것:
// - input[type="password"] 값
// - input[type="tel"], input[autocomplete*="cc-"] (카드번호)
// - DOM 전체 innerHTML dump
// - 쿠키, localStorage 값
```

---

## 8. API 연동 포인트

| 호출 시점 | 메서드 | 경로 | 설명 |
|---|---|---|---|
| 확장 설치 / 로그인 | POST | `/api/agent/devices/register` | deviceId 발급 |
| heartbeat (30초) | POST | `/api/agent/heartbeat` | 상태 전달 + 할당 Run 확인 |
| Run 실행 시작 | POST | `/api/agent/runs/{runId}/start` | agentToken 수령, 실행 시작 신호 |
| 다음 step 요청 | GET | `/api/agent/runs/{runId}/next-step?from={idx}` | 다음 실행할 step 가져오기 |
| step 결과 보고 | POST | `/api/agent/runs/{runId}/steps/{idx}/result` | 성공/실패 결과 전달 |
| 스냅샷 전송 | POST | `/api/agent/runs/{runId}/snapshot` | DOM/AX 스냅샷 → 백엔드가 다음 step 계획 |
| 승인 요청 확인 | POST | `/api/agent/runs/{runId}/approve` | 사용자 승인 결과 전달 |
| Run 완료 보고 | POST | `/api/agent/runs/{runId}/complete` | 정상 완료 |
| Run 실패 보고 | POST | `/api/agent/runs/{runId}/fail` | 오류 내용 포함 |
| Run 중단 보고 | POST | `/api/agent/runs/{runId}/abort` | 사용자 취소 or 강제 중단 |

### agentToken 사용 방법

```
Authorization: Bearer {agentToken}
```

- agentToken은 Run 시작 시 발급되며, Run 하나에만 유효하다.
- Run 종료(완료/실패/중단) 시 백엔드에서 무효화된다.
- storage.local에 저장하지만, Run 종료 즉시 클리어한다.
- heartbeat는 deviceId 기반 별도 토큰을 사용한다 (agentToken 아님).

---

## 9. 주의사항 / MVP 가드레일

### chrome.alarms vs setInterval

```
✅ 사용: chrome.alarms.create('heartbeat', { periodInMinutes: 0.5 })
❌ 금지: setInterval(() => heartbeat(), 30000)
```

이유: MV3 Service Worker는 유휴 상태에서 30초~수 분 내에 종료된다. `setInterval`은 SW가 종료되면 같이 사라진다. `chrome.alarms`는 SW 종료와 무관하게 예약이 유지되고, 알람이 울릴 때 SW를 자동으로 깨운다.

### storage 영속성

```
✅ 사용: chrome.storage.local (영속, SW 재시작해도 유지)
❌ 금지: 전역 변수 (SW 종료 시 초기화됨)

예시:
// 틀린 방법
let activeRunId = null; // SW 재시작 시 null로 초기화됨

// 올바른 방법
const { activeRunId } = await chrome.storage.local.get('activeRunId');
```

### MVP: Run 하나만 허용

- 동시에 여러 Run을 실행하지 않는다.
- `activeRunId`가 이미 존재하면 새 Run 시작을 거부한다.
- heartbeat 응답에 여러 assigned Run이 오더라도 첫 번째만 처리한다.

```typescript
const { activeRunId } = await storageManager.load();
if (activeRunId !== null) {
  console.warn('[heartbeat] 이미 진행 중인 Run 있음, 새 Run 무시:', response.assignedRun?.runId);
  return;
}
```

### 민감정보 절대 전송 금지

확장프로그램이 백엔드 또는 LLM으로 **절대 전송하지 않는 것**:

- 비밀번호 필드 값
- 카드번호, CVC, 유효기간
- SMS/이메일 인증번호
- 브라우저 쿠키 전체
- `input[type="password"]` 포함 DOM 영역

### DOM dump 금지

```
❌ 금지: document.body.innerHTML 전체 전송
✅ 사용: 필요한 interactive element만 선택적 수집 (snapshotCollector.ts 참조)
```

전체 DOM dump는 민감 정보를 포함할 수 있고, 크기가 과도하게 크다.

### 재시도 / 타임아웃

| 상황 | 재시도 | 최대 대기 |
|---|---|---|
| 네트워크 오류 | 3회, 지수 백오프 | 30초 |
| DOM 요소 없음 | 3회, 1초 간격 | 5초 |
| 페이지 로드 대기 | - | 15초 |
| 승인 대기 | - | 10분 (이후 자동 ABORTED) |
| 전체 Run 타임아웃 | - | 30분 (이후 INTERRUPTED로 전환) |

### 자동화 절대 금지 항목

확장프로그램이 자동으로 실행하지 않는 것:

- 최종 주문 제출 버튼 클릭 (반드시 사용자 승인 후)
- 결제 수단 선택/변경
- OTP 입력
- 비밀번호 입력

---

## 10. 마무리 요약

### 핵심 원칙 3가지

1. **백엔드 중심 Pull 방식**: 확장프로그램은 명령을 받는 게 아니라, 할 일을 스스로 가져온다.
2. **chrome.alarms 기반 생존**: Service Worker는 언제든 죽을 수 있다. 알람으로 되살리고, storage로 상태를 복구한다.
3. **승인 게이트는 선택이 아님**: 최종 주문 전 사용자 확인은 코드 레벨에서 강제된다.

### 구현 우선순위 (MVP 기준)

```
1순위: 장치 등록 + heartbeat 루프 (기반)
2순위: Run 발견 + AliExpress 탭 열기
3순위: Step 루프 + DOM 제어 (CLICK / NAVIGATE)
4순위: 스냅샷 수집 + 백엔드 전달
5순위: 승인 게이트 UI (Side Panel)
6순위: 복구 흐름 (storage → 재시작 시 이어받기)
```

### 이 문서에서 다루지 않은 것 (별도 문서 참조)

- 백엔드 Run/Step API 상세 명세 → `backend/docs/agent-api.md`
- AliExpress DOM 구조 분석 → `docs/aliexpress-dom-analysis.md` (작성 예정)
- 비전 폴백(스크린샷 기반 클릭) → 안정화 단계 이후 별도 문서화

---

*이 문서는 구현 기준선이다. AliExpress DOM 분석 결과나 백엔드 API 설계 변경에 따라 세부 사항은 업데이트될 수 있다.*
