# Browser Agent Contract (MVP Draft)

> 버전: 0.1 (MVP 초안) | 작성일: 2026-05-16
> 대상: Extension 엔지니어 + Backend 엔지니어
> 상태: Browser Agent MVP 구현의 단일 기준 문서(Single Source of Truth)

---

## 배경 / 이 문서의 목적

Phase 1 코드로 전체 흐름의 대략적인 형태(shape)가 검증되었다. 하지만 Phase 2 구현에 들어가기 전에 **양쪽이 합의한 계약(contract)**이 없으면 interface 불일치, 상태 충돌, 인증 방식 혼선으로 재작업이 발생한다.

이 문서는 Chrome MV3 Extension과 Spring Backend가 MVP 범위 내에서 **구현 가능한 수준의 계약**을 맺기 위해 작성된 0단계 초안이다. 두 팀이 이 문서를 기준으로 구현을 시작하고, 이후 변경 시 이 문서를 먼저 업데이트한다.

---

## 범위 (Scope)

### 이 문서가 다루는 것

| 대상 | 설명 |
|------|------|
| Chrome MV3 Extension | Service Worker 기반 브라우저 자동화 실행 주체 |
| Spring Backend | Run 상태 관리, 명령 결정, 결과 저장 |
| AliExpress 브라우저 자동화 | MVP 대상 사이트 |
| Backend-centered pull model | Extension이 Backend에서 작업을 가져오는 구조 |

### 이 문서가 다루지 않는 것

- 자연어 파싱 / LLM 프롬프트 설계 세부사항
- 완전 무인 최종 결제 자동 승인
- CDP(Chrome DevTools Protocol) fallback 세부 구현
- 멀티 디바이스 수동 선택 UI

> MVP는 **결제 승인 직전 또는 주문 제출 직전까지를 기본 범위로 하되, 최종 주문 제출은 사용자 승인 후에만 허용한다.**

---

## 1. 핵심 원칙

1. **웹 앱이 의도(intent)를 시작하고, Backend가 결정하고, Extension이 실행한다.**
2. **Backend가 Run 상태의 단일 진실 공급원(source of truth)이다.** Extension 로컬 상태는 캐시로 취급한다.
3. **Extension은 Backend에서 작업을 pull한다.** Backend가 Extension으로 push하지 않는다 (SSE/WebSocket은 후속 단계).
4. **최종 주문 제출은 웹 앱에서 사용자 승인이 필요하다.** Extension은 승인 전까지 자동으로 주문을 완료하지 않는다.
5. **MVP에서 사용자당 동시에 하나의 활성 Run만 허용한다.**
6. **전체 원시 DOM 덤프를 Backend로 전송하지 않는다.** 요약된 snapshot만 허용한다.
7. **비밀번호, 카드번호, OTP 자동화는 금지한다.**

---

## 2. 인증 모델

### 3-토큰 모델

| 토큰 | 목적 | 발급자 | 유효기간 | 사용 위치 |
|------|------|--------|----------|-----------|
| `pairingToken` | 웹 로그인 상태와 브라우저/디바이스 초기 연결 | Web App (로그인 세션 기반) | 단기 (5~10분) | Extension → Backend `/devices/register` 1회 |
| `deviceToken` | 디바이스 식별 및 heartbeat / pending 조회 | Backend (register 응답) | 장기 (30일 이상) | Extension storage에 저장, 모든 device API 호출 |
| `agentToken` | 특정 Run 실행 API 호출 | Backend (run assign 시) | 단기 (run 기간 + 여유분) | Run 실행 중에만 사용, run 완료 시 삭제 |

### 페어링 흐름 예시

```
1. 사용자가 웹 앱에 로그인 → 웹 앱이 pairingToken 발급
2. 웹 앱이 extension에 pairingToken 전달 (chrome.runtime.sendMessage 또는 storage)
3. Extension → POST /api/v1/devices/register  { pairingToken, browserInfo }
4. Backend 응답 → { deviceId, deviceToken }
5. Extension이 deviceToken을 chrome.storage.local에 저장
6. 이후 모든 heartbeat, pending 조회에 deviceToken 사용
7. Run assign 시 Backend가 agentToken 발급 → Extension이 메모리에만 보관
8. Run 완료 / 실패 후 agentToken 삭제
```

### 주의사항

- **사용자 JWT(User JWT)를 Extension storage에 저장하지 않는다.**
- Phase 1에서 userId 헤더나 user JWT를 직접 사용하던 방식은 이 계약으로 대체된다.
- `agentToken`은 run 완료 후 Extension에서 즉시 삭제한다.

---

## 3. 상태 모델

### A) Extension 내부 상태

| 상태 | 설명 |
|------|------|
| `IDLE` | 페어링 전 또는 초기화 직후 |
| `PAIRED` | deviceToken 보유, heartbeat 미시작 |
| `ONLINE_STANDBY` | heartbeat 활성, 작업 대기 중 |
| `EXECUTING` | Run을 실행 중 |
| `AWAITING_APPROVAL` | 사용자 승인 대기 중 (주문 확인 등) |
| `INTERRUPTED` | 예상치 못한 중단 (탭 닫힘, 네트워크 오류 등) |
| `RECOVERING` | 재시작 후 이전 Run 복구 시도 중 |
| `ERROR` | 복구 불가 오류 상태 |
| `ABORTED` | Run이 중단됨 (사용자 취소, 정책에 의한 중단 등) |
| `COMPLETED` | Run 정상 완료 |

### B) Backend Run 상태

| 상태 | 설명 |
|------|------|
| `QUEUED` | Run 생성됨, 아직 디바이스에 할당 안 됨 |
| `ASSIGNED` | 특정 디바이스에 할당됨, 아직 실행 시작 전 |
| `RUNNING` | 실행 중 |
| `AWAITING_APPROVAL` | 사용자 승인 대기 중 |
| `APPROVAL_EXPIRED` | 승인 대기 시간 초과 |
| `INTERRUPTED` | heartbeat stale로 Backend가 중단 감지 |
| `RECOVERING` | Extension 복구 시도 중 |
| `COMPLETED` | 정상 완료 |
| `FAILED` | 실패 (복구 불가) |
| `ABORTED` | 중단됨 |

### Extension ↔ Backend 상태 매핑

| Extension 상태 | Backend Run 상태 | 비고 |
|----------------|-----------------|------|
| `ONLINE_STANDBY` | `QUEUED` / `ASSIGNED` | Extension은 대기, Backend는 할당 준비 |
| `EXECUTING` | `RUNNING` | 실행 중 |
| `AWAITING_APPROVAL` | `AWAITING_APPROVAL` | 양쪽 동기화 필요 |
| `INTERRUPTED` | `INTERRUPTED` | heartbeat stale 90초 초과 시 Backend가 먼저 전환 |
| `RECOVERING` | `RECOVERING` | Extension 재시작 후 복구 요청 |
| `COMPLETED` | `COMPLETED` | |
| `ABORTED` | `ABORTED` / `FAILED` | 이유에 따라 구분 |

> 상태 이름이 양쪽에서 동일할 필요는 없다. 단, **전환(transition)이 예측 가능해야 한다.** Backend 상태가 바뀌면 다음 heartbeat 또는 step 응답에서 Extension이 감지할 수 있어야 한다.

---

## 4. Run 할당 정책

### 규칙

- MVP에서는 **사용자당 동시에 하나의 활성 Run**만 허용한다.
- 가장 최근에 온라인인 디바이스에 Run을 `ASSIGNED`한다.
- 같은 사용자의 다른 디바이스가 이미 `ASSIGNED` 또는 `RUNNING` 상태이면 새 할당을 하지 않는다.
- Backend는 `assignedDeviceId`, `assignedAt` 필드를 Run에 저장한다.
- Run 트리거 시점에 디바이스가 오프라인이면 → Run을 `QUEUED` 유지, 웹 또는 Telegram으로 알림.

### Backend Run 필드 (최소)

```json
{
  "runId": "run_abc123",
  "userId": "user_xyz",
  "assignedDeviceId": "dev_001",
  "assignedAt": "2026-05-16T10:00:00Z",
  "status": "ASSIGNED"
}
```

### 할당 예시

```
상황: 사용자 A의 디바이스 dev_001이 ONLINE_STANDBY, dev_002는 오프라인
→ 새 Run 생성 시 dev_001에 ASSIGNED
→ dev_001이 다음 heartbeat / pending 조회에서 Run 감지 후 실행 시작

상황: dev_001이 이미 RUNNING 중
→ 새 Run 요청 → Backend가 거부(409) 또는 QUEUED 대기
```

---

## 5. Heartbeat 및 온/오프라인 규칙

### 규칙

| 항목 | 값 |
|------|----|
| Heartbeat 주기 | 30초 |
| Stale 임계값 | 90초 (마지막 heartbeat 이후) |
| 오프라인 판정 | 90초 초과 시 Backend가 디바이스를 오프라인으로 표시 |
| Extension 구현 | `chrome.alarms` 사용 (`setInterval` 사용 금지 — Service Worker 수명 주기 문제) |

### Heartbeat 요청

```http
POST /api/v1/devices/{deviceId}/heartbeat
Authorization: Bearer {deviceToken}

{
  "deviceId": "dev_001",
  "extensionStatus": "ONLINE_STANDBY",
  "activeRunId": null,
  "stepIndex": null,
  "at": "2026-05-16T10:00:30Z"
}
```

### Heartbeat 응답 예시 (작업 있음)

```json
{
  "status": "ok",
  "assignedRun": {
    "runId": "run_abc123",
    "agentToken": "agt_xxxxx",
    "commandId": "cmd_001"
  }
}
```

### Heartbeat 응답 예시 (작업 없음)

```json
{
  "status": "ok",
  "assignedRun": null
}
```

---

## 6. Extension 영구 저장소 계약

### 최소 필드 (chrome.storage.local)

```typescript
interface ExtensionStorage {
  // 디바이스 식별
  deviceId: string;
  deviceToken: string;           // 장기 보관

  // 실행 상태
  activeRunId: string | null;
  stepIndex: number;             // 다음 실행할 step 번호
  extensionStatus: ExtensionStatus;
  lastAction: LastAction | null;

  // 탭 제어
  targetTabId: number | null;
  targetUrl: string | null;

  // 메타
  updatedAt: string;             // ISO 8601
}

interface LastAction {
  type: ActionType;
  stepIndex: number;
  at: string;                    // ISO 8601
  result?: 'SUCCESS' | 'FAILURE';
}
```

### 보안 주의사항

- **User JWT를 저장하지 않는다.**
- `agentToken`은 메모리(변수)에만 보관하고, 불가피하게 저장 시 Run 완료 후 즉시 삭제한다.
- `deviceToken`만 장기 저장 허용.

---

## 7. stepIndex 정의

### 의미

> `stepIndex` = **다음에 실행할 step 번호** (0-based 또는 1-based는 팀 합의, MVP에서는 **0-based** 사용)

### 예시

```
stepIndex = 0  →  아직 아무 step도 실행 안 함, step 0부터 시작
stepIndex = 3  →  step 0, 1, 2 완료됨, step 3부터 재개
```

### 왜 중요한가

- **재개(resume)**: Extension 재시작 후 어디서부터 다시 시작할지 결정한다.
- **멱등성(idempotency)**: 동일 stepIndex를 두 번 실행하는 것을 Backend가 감지할 수 있다.
- **로깅/디버깅**: 어느 step에서 실패했는지 정확히 추적할 수 있다.
- **Backend와 Extension 양쪽이 동일한 stepIndex를 기준으로 복구 협상을 한다.**

---

## 8. Step / Action 계약

### Action 타입 Enum

```typescript
type ActionType =
  | 'NAVIGATE'         // URL 이동
  | 'CLICK'            // 요소 클릭
  | 'INPUT'            // 텍스트 입력
  | 'SELECT'           // 드롭다운 선택
  | 'SCROLL'           // 스크롤
  | 'WAIT'             // 대기 (시간 또는 조건)
  | 'AWAIT_APPROVAL'   // 사용자 승인 대기
  | 'COMPLETE'         // Run 완료 선언
  | 'ABORT';           // Run 중단 선언
```

### Action 지시 스키마 (Backend → Extension)

```typescript
interface ActionInstruction {
  stepIndex: number;
  actionId: string;
  action: ActionType;
  target?: ActionTarget;
  value?: string;             // INPUT, SELECT 등에 사용
  waitMs?: number;            // WAIT에 사용
  timeoutMs?: number;
  approvalContext?: ApprovalContext; // AWAIT_APPROVAL에 사용 (웹 앱 승인 기준)
}

interface ActionTarget {
  nodeId: string;             // snapshot.interactiveElements[].nodeId 와 대응
  role?: string;
  labelText?: string;
  selector?: string;          // 선택적, 최후 수단
}
```

> **MVP에서는 Backend가 snapshot의 `nodeId`를 기준으로 타겟을 지시한다.** selector는 최후 수단으로만 optional 하게 포함한다.

### nodeId 계약 추가 규칙

- `nodeId`는 **Extension이 snapshot 수집 시 생성**한다. Backend는 `nodeId`를 생성하지 않는다.
- `nodeId`는 **해당 snapshot 시점의 페이지 상태에서만 유효**하다.
- `NAVIGATE`, 리로드, 주요 DOM 재구성 이후에는 기존 `nodeId`를 모두 무효로 간주한다.
- Extension은 `nodeId`를 기준으로 실제 DOM 요소를 찾고 실행하는 책임을 가진다.
- Backend는 Extension이 보낸 snapshot의 `nodeId`를 신뢰하여 action을 생성한다.

### Action 결과 스키마 (Extension → Backend)

```typescript
interface ActionResult {
  runId: string;
  stepIndex: number;
  actionId: string;
  action: ActionType;
  status: 'SUCCESS' | 'FAILURE' | 'SKIPPED';
  errorCode?: ActionErrorCode;
  errorMessage?: string;
  snapshot?: PageSnapshot;
  completedAt: string;
}
```

### 첫 `/steps` 요청 규칙

- Extension은 run을 처음 시작할 때 `stepIndex: 0`으로 `/steps`를 호출한다.
- 첫 요청에서는 아직 이전 action 실행 결과가 없으므로 `previousActionResult`는 반드시 `null`이다.
- 첫 요청이라도 Backend가 바로 planning할 수 있도록 **현재 snapshot은 반드시 포함**한다.

```json
{
  "stepIndex": 0,
  "previousActionResult": null,
  "snapshot": {
    "currentUrl": "https://www.aliexpress.com/",
    "title": "AliExpress",
    "visibleTextSummary": "...",
    "interactiveElements": [],
    "capturedAt": "2026-05-16T10:01:00Z"
  }
}
```

### Error Code Enum

```typescript
type ActionErrorCode =
  | 'ELEMENT_NOT_FOUND'
  | 'ELEMENT_NOT_CLICKABLE'
  | 'NAVIGATION_TIMEOUT'
  | 'NAVIGATION_FAILED'
  | 'UNSUPPORTED_PAGE_STATE'
  | 'APPROVAL_REJECTED'
  | 'APPROVAL_EXPIRED'
  | 'NETWORK_ERROR'
  | 'UNEXPECTED_ERROR';
```

### 예시 1 — NAVIGATE

```json
{
  "stepIndex": 0,
  "action": "NAVIGATE",
  "value": "https://www.aliexpress.com/item/1234567890.html",
  "timeoutMs": 15000
}
```

### 예시 2 — CLICK (nodeId 기반 target)

```json
{
  "stepIndex": 2,
  "actionId": "act_002",
  "action": "CLICK",
  "target": {
    "nodeId": "ax-node-42",
    "role": "button",
    "labelText": "장바구니에 추가"
  }
}
```

### 예시 3 — AWAIT_APPROVAL

```json
{
  "stepIndex": 5,
  "actionId": "act_005",
  "action": "AWAIT_APPROVAL",
  "approvalContext": {
    "summaryText": "웹 앱에서 승인 후 주문을 진행할 수 있습니다.",
    "timeoutMs": 600000
  }
}
```

### Action 계약 원칙

- **MVP에서는 1 step = 1 action instruction** 으로 고정한다.
- `actionId`는 같은 step 재전송/재시도 시 중복 실행을 방지하기 위한 식별자다.
- `stepIndex`는 **다음 실행할 step 번호**다.
- `AWAIT_APPROVAL`은 Extension이 승인 버튼을 직접 처리하는 의미가 아니라,
  **웹 앱 승인 대기 상태로 전환되었음을 표시하는 액션**이다.
- Extension은 `AWAIT_APPROVAL` 수신 후 Side Panel/알림으로 상태를 표시할 수 있지만,
  실제 승인 API 호출 주체는 웹 앱이다.
- Backend의 멱등성 판단 기준은 `runId + stepIndex`이며, `actionId`는 로그/추적 식별자로 사용한다.
- Extension은 ActionResult 보고 시 반드시 동일한 `actionId`를 포함한다.

---

## 9. Snapshot 계약

### 포함 허용 필드

```typescript
interface PageSnapshot {
  currentUrl: string;
  title: string;
  visibleTextSummary: string;       // 페이지 핵심 텍스트 요약 (500자 이내 권장)
  interactiveElements: InteractiveElement[];
  optionGroups?: OptionGroup[];     // 색상, 사이즈 등 선택 옵션
  priceCandidates?: string[];       // 감지된 가격 후보 텍스트
  currencyCandidates?: string[];    // 감지된 통화 후보
  capturedAt: string;
}

interface InteractiveElement {
  nodeId: string;         // Backend가 target.nodeId로 지시할 때 사용하는 식별자
  role: string;           // 버튼, 입력, 선택 등
  labelText: string;
  selector?: string;      // 선택적, 짧게
  isVisible: boolean;
  disabled?: boolean;
}

interface OptionGroup {
  groupName: string;
  options: string[];
  selectedOption?: string;
}
```

### Snapshot 제출 규칙

- Extension은 `POST /api/v1/runs/{runId}/steps` 요청 시 **현재 페이지 snapshot을 항상 포함**한다.
- 특히 `NAVIGATE` action 성공 후에는 **새 페이지 snapshot을 다시 수집한 뒤** 다음 step 요청에 포함해야 한다.
- `NAVIGATE` 이후에는 이전 snapshot의 모든 `nodeId`를 무효로 간주하고 재사용하지 않는다.
- `interactiveElements`는 기본적으로 **현재 화면에서 보이는 요소만 포함**하며, MVP에서는 최대 **50개**를 상한으로 한다.
- snapshot은 Backend가 다음 action을 계획하는 기준 데이터이므로, 이전 step의 snapshot을 그대로 재사용하지 않는다.

### Snapshot 예시

```json
{
  "currentUrl": "https://www.aliexpress.com/item/1234567890.html",
  "title": "Wireless Earbuds Bluetooth 5.3",
  "visibleTextSummary": "무선 이어버드 블루투스 5.3, 색상: 검정/흰색, 가격: $12.99",
  "interactiveElements": [
    { "nodeId": "ax-node-42", "role": "button", "labelText": "장바구니에 추가", "isVisible": true, "disabled": false },
    { "nodeId": "ax-node-43", "role": "button", "labelText": "지금 구매", "isVisible": true, "disabled": false }
  ],
  "optionGroups": [
    { "groupName": "Color", "options": ["Black", "White"], "selectedOption": "Black" }
  ],
  "priceCandidates": ["$12.99", "US $12.99"],
  "currencyCandidates": ["USD", "US $"],
  "capturedAt": "2026-05-16T10:01:00Z"
}
```

### 금지 사항 (명시적)

| 항목 | 이유 |
|------|------|
| 전체 원시 DOM 덤프 | 데이터 과다, 민감 정보 노출 위험 |
| `document.cookie` | 보안 |
| `localStorage` / `sessionStorage` 내용 | 보안 |
| 비밀번호 필드 값 | 보안 |
| 카드번호, CVV | 보안 |
| OTP, 인증 코드 | 보안 |

---

## 10.1 nodeId mismatch / stale 처리 규칙

### 처리 순서

1. Extension은 `target.nodeId`로 요소 탐색을 먼저 시도한다.
2. 실패하면 `target.role + target.labelText` 조합으로 1회 fallback 탐색을 시도한다.
3. 그래도 실패하면 `target.selector`가 있을 때만 1회 추가 시도한다.
4. 모두 실패하면 `ELEMENT_NOT_FOUND`로 처리하고, **새 snapshot을 포함한 ActionResult**를 Backend에 보고한다.
5. Backend는 동일 `stepIndex` 기준으로 새 snapshot을 바탕으로 action을 재계획한다.

### 추가 규칙

- 동일 `stepIndex`에서 `ELEMENT_NOT_FOUND`가 반복되면 `REPEATED_FAILURE` 또는 `UNSUPPORTED_PAGE_STATE`로 종료할 수 있다.
- Extension은 stale `nodeId`를 임의로 성공 처리하지 않는다.
- Backend는 새 snapshot이 도착하기 전까지 이전 snapshot의 `nodeId`를 기준으로 다음 action을 강제하지 않는다.

---

## 10. 복구 규칙

### 누가 언제 무엇을 변경하는가

| 주체 | 조건 | 동작 |
|------|------|------|
| Backend | heartbeat stale 90초 초과 + Run이 `ASSIGNED`/`RUNNING`/`AWAITING_APPROVAL` | Run 상태 → `INTERRUPTED` |
| Extension | Service Worker 재시작 시 `activeRunId` 감지 | Backend에 Run 상태 조회 |
| Extension | Backend Run 상태가 `INTERRUPTED` 또는 `RECOVERING` | `POST /api/v1/runs/{runId}/recover` 호출 → 복구 시작 |
| Extension | 복구 성공 | `RUNNING` / `EXECUTING` 재개, stepIndex는 Backend와 합의 |
| Extension | 복구 실패 (3회 시도 후) | `ABORTED`, reason: `RECOVERY_FAILED` |

### 복구 시 stepIndex 합의

```
Extension 로컬 stepIndex = 3
Backend 서버 stepIndex = 3  →  step 3부터 재개

Extension 로컬 stepIndex = 3
Backend 서버 stepIndex = 2  →  Backend 기준 step 2부터 재개 (서버 우선)
```

### 재시작 시나리오 예시

```
1. Extension이 step 3 실행 중 Service Worker 종료
2. Extension 재시작 → storage에서 activeRunId = "run_abc123" 감지
3. GET /api/v1/runs/run_abc123 → 상태: INTERRUPTED, stepIndex: 3
4. Extension: RECOVERING 상태로 전환
5. POST /api/v1/runs/run_abc123/recover
6. Backend: RECOVERING → RUNNING으로 전환, agentToken 재발급
7. Extension: step 3부터 실행 재개
```

---

## 11. 탭 제어 정책

### 규칙

1. **기존 AliExpress 탭이 열려 있고 Run 대상 URL과 도메인이 일치하면 재사용한다.**
2. 적합한 탭이 없으면 새 탭을 생성한다.
3. 실행 중 탭의 URL이 예상 도메인(`*.aliexpress.com`)에서 벗어나면 **1회 재 네비게이션을 시도**한다.
4. 재시도 후에도 여전히 불일치하면 → `UNSUPPORTED_PAGE_STATE` 오류로 처리하고 abort 정책에 따라 Run 중단.
5. `targetTabId`를 storage에 저장하고 heartbeat 및 step 사이에서 탭이 닫히지 않았는지 확인한다.

### 탭 선택 의사결정

```
chrome.tabs.query({ url: "https://*.aliexpress.com/*" })
  → 결과 있음 → 가장 최근 활성 탭 재사용
  → 결과 없음 → chrome.tabs.create({ url: targetUrl })
```

---

## 12. 재시도 / 타임아웃 / Abort 정책

### 재시도 설정

| 항목 | 정책 |
|------|------|
| Heartbeat 실패 | 최대 3회 재시도, 이후 INTERRUPTED로 전환 |
| Step API 실패 (5xx, 네트워크) | Exponential backoff, 최대 3회 (1s → 2s → 4s) |
| DOM 요소 미발견 | 2~3초 대기 후 2회 재시도 |
| 네비게이션 타임아웃 | 15초 |
| 승인 대기 타임아웃 | 10분 → `APPROVAL_EXPIRED` |

### Abort 사유 Enum

| 사유 | 설명 |
|------|------|
| `USER_CANCELLED` | 사용자가 명시적으로 취소 |
| `REPEATED_FAILURE` | 동일 step 반복 실패 |
| `TIMEOUT` | 전체 Run 타임아웃 |
| `APPROVAL_REJECTED` | 사용자가 승인 거부 |
| `APPROVAL_EXPIRED` | 승인 대기 시간 초과 |
| `RECOVERY_FAILED` | 복구 시도 실패 |
| `DEVICE_OFFLINE` | 디바이스 오프라인으로 Run 진행 불가 |
| `UNSUPPORTED_PAGE_STATE` | 지원하지 않는 페이지 상태 |

---

## 13. API 엔드포인트 (MVP)

| 메서드 | 경로 | 인증 | 목적 |
|--------|------|------|------|
| `POST` | `/api/v1/devices/register` | `pairingToken` (Body 또는 Bearer) | 디바이스 등록, `deviceToken` 발급 |
| `POST` | `/api/v1/devices/{deviceId}/heartbeat` | `deviceToken` | 온라인 상태 보고, 할당된 Run 수신 |
| `POST` | `/api/v1/commands/{commandId}/runs` | User JWT (웹 앱 → Backend) | 웹 앱이 새 Run 생성 요청 |
| `GET` | `/api/v1/runs/pending` | `deviceToken` | 현재 디바이스에 할당된 대기 Run 조회 |
| `GET` | `/api/v1/runs/{runId}` | `deviceToken` 또는 `agentToken` | Run 상세 상태 및 stepIndex 조회 |
| `POST` | `/api/v1/runs/{runId}/recover` | `deviceToken` | 중단된 Run 복구 시작 및 agentToken 재발급 |
| `POST` | `/api/v1/runs/{runId}/start` | `agentToken` | Extension이 할당된 Run을 실제 실행 시작 상태로 전환 |
| `POST` | `/api/v1/runs/{runId}/steps` | `agentToken` | Step 실행 결과 보고 및 다음 지시 수신 |
| `POST` | `/api/v1/runs/{runId}/approve` | User JWT (웹 앱 → Backend) | 웹 앱이 사용자 승인 결과 전달 |
| `POST` | `/api/v1/runs/{runId}/abort` | `agentToken` 또는 `deviceToken` | Run 강제 중단 |

### 주요 참고사항

- `POST /runs/{runId}/steps`는 요청에 이전 step 결과를 포함하고, 응답에 다음 step 지시를 포함한다 (단일 왕복).
- `GET /runs/pending`은 heartbeat 외에 Extension 재시작 시 빠른 확인 용도로도 사용한다.
- `POST /runs/{runId}/start`는 Extension이 `assignedRun.agentToken`을 받은 직후 1회 호출해 `ASSIGNED -> RUNNING` 전환을 확정한다.
- `POST /commands/{commandId}/runs`는 Extension이 호출하지 않는다. 웹 앱 전용 엔드포인트.
- `POST /runs/{runId}/approve`는 Extension이 호출하지 않는다. 웹 앱 전용 엔드포인트.
- `POST /runs/{runId}/recover`는 중단된 Run을 복구할 때 새로운 `agentToken`을 재발급하는 공식 엔드포인트다.

---

## 14. 권한 (Extension)

### manifest.json permissions (MVP 최소)

```json
{
  "permissions": [
    "storage",
    "alarms",
    "tabs",
    "sidePanel",
    "notifications",
    "scripting"
  ],
  "host_permissions": [
    "https://*.aliexpress.com/*",
    "https://your-web-app.com/*",
    "https://your-backend-api.com/*"
  ]
}
```

### 권한 설명

| 권한 | 이유 |
|------|------|
| `storage` | deviceToken, 실행 상태 저장 |
| `alarms` | Heartbeat 타이머 (Service Worker 수명 주기 안전) |
| `tabs` | 탭 조회, 생성, 활성화 |
| `sidePanel` | 상태 표시, 복구 진행 상황 및 로그 노출 |
| `notifications` | 웹 앱 승인 필요, 오류 알림 |
| `scripting` | content script 주입, DOM 조작 |

> `debugger` 권한은 MVP 기준선에서 제외한다. CDP fallback 필요 시 별도 논의.

---

## 15. 로깅 / 디버깅 계약

### 최소 구조화 로그 필드

모든 Extension 로그에 다음 필드를 포함한다:

```typescript
interface StructuredLog {
  runId: string | null;
  deviceId: string;
  stepIndex: number | null;
  action: ActionType | null;
  status: string;
  message: string;
  at: string;         // ISO 8601
}
```

### lastAction 권장 형태

```typescript
// storage의 lastAction 필드
{
  type: 'CLICK',
  stepIndex: 2,
  at: '2026-05-16T10:01:05Z',
  result: 'SUCCESS'
}
```

### 디버깅 권장 사항

- Extension Service Worker에서 `console.debug` 대신 구조화된 로그를 사용한다.
- Backend는 `runId` + `stepIndex` 조합으로 모든 Step 이력을 조회할 수 있어야 한다.
- 민감 필드(`agentToken`, `pairingToken`)는 로그에 절대 출력하지 않는다.

---

## 16. 이전 방식 vs. 이 계약

| 항목 | Phase 1 (이전 방식) | 이 계약 (MVP) |
|------|---------------------|---------------|
| 인증 | User JWT 또는 userId 헤더 직접 사용 | 3-토큰 모델 (pairing → device → agent) |
| Run 시작 | 웹 앱이 Extension에 직접 `START_RUN` 메시지 | 웹 앱 → Backend Run 생성, Extension이 pull |
| 상태 관리 | Extension 로컬 상태 위주 | Backend가 source of truth, Extension은 캐시 |
| DOM 전송 | 전체 DOM 또는 대량 HTML 전송 가능성 | 요약 snapshot만 허용 |
| 복구 | 재시작 시 복구 로직 미정의 | stepIndex 기반 복구 프로토콜 명시 |
| 탭 제어 | 미정의 | 재사용 우선, 벗어남 감지 시 재네비게이션 1회 |
| 승인 주체 | Extension 또는 로컬 UI 중심 가정 가능 | 웹 앱이 승인 API 호출, Extension은 승인 대기 상태만 표시 |

---

## 17. 미결 사항 / 후속 단계

다음 항목은 MVP 범위 밖이거나 추가 논의가 필요하다:

| 항목 | 상태 |
|------|------|
| Vision fallback (스크린샷 업로드 정책) | 후속 단계 논의 필요 |
| 멀티 디바이스 수동 선택 UI | MVP 이후 |
| CDP fallback 상세 구현 | MVP 이후 (debugger 권한 필요) |
| SSE / WebSocket 기반 push 모델 | MVP 이후 (현재 pull 모델) |
| agentToken 장기 갱신(refresh) 정책 | 현재는 `/recover` 재발급으로 충분, 장기 실행 시나리오에서 추가 논의 |
| Snapshot 압축 / 크기 제한 정책 | 실 운영 시 결정 |
| Rate limiting 정책 (heartbeat, step) | Backend 구현 시 확정 |

---

*이 문서는 살아있는 초안입니다. 변경이 필요하면 PR을 통해 양쪽 팀이 합의 후 업데이트합니다.*
