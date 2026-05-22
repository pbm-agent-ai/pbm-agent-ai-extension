# Extension 구현 진행 현황

> 최종 갱신: 2026-05-16
> 대상: pbm-agent-ai-extension 프로젝트 팀
> 계약 기준: [`docs/browser-agent-contract.md`](./browser-agent-contract.md)

---

## 목적

이 문서는 Chrome MV3 Extension 프로젝트에서 **현재까지 실제로 코드로 구현된 내용**을 팀 전체가 빠르게 파악할 수 있도록 정리한 진행 현황 스냅샷이다.

아키텍처 설계나 계약 명세를 재설명하는 문서가 아니다. 어떤 파일이 존재하는지, 어떤 동작이 가능한지, 어떤 것이 아직 미완성인지를 실용적으로 정리한다.

> 구현 내용에 대해 모호한 부분이 있으면 [`docs/browser-agent-contract.md`](./browser-agent-contract.md)를 기준으로 판단한다.

---

## 현재 구현 범위 요약

| 구분 | 상태 |
|------|------|
| MV3 shell / 빌드 설정 | ✅ 완료 |
| 공통 인프라 모듈 (shared/) | ✅ 완료 |
| 페어링 / 디바이스 등록 흐름 | ✅ 완료 |
| Heartbeat / ONLINE_STANDBY 전환 | ✅ 완료 |
| Run 감지 / 활성 Run 1개 정책 / Run 시작 | ✅ 완료 |
| AliExpress 탭 재사용 / 생성 / 이동 | ✅ 완료 |
| Content script → Snapshot 수집 | ✅ 완료 |
| Content script → Action 실행 (6종) | ✅ 완료 |
| `/steps` 루프 오케스트레이션 | ✅ 완료 |
| Run 종료 / cleanup (finish · abort · error) | ✅ 완료 |
| AWAIT_APPROVAL 상태 전환 뼈대 | ✅ 완료 |
| 승인 재개 체크 (backend 상태 polling) | ✅ 완료 (뼈대) |
| 재시작 시 복구 / resume 뼈대 | ✅ 완료 (뼈대) |
| Retry / timeout / abort 정책 기초 | ✅ 완료 |
| Tab drift 감지 / revalidation | ✅ 완료 |
| 사이드패널 운영 상태 필드 확장 | ✅ 완료 |
| `agentToken` 메모리 전용 보관 정책 완전 준수 | ⚠️ 미완 (storage에 임시 저장 후 cleanup) |
| 승인 재개 후 step loop 자동 재진입 | ⚠️ 미완 |
| 복구 3회 재시도 정책 | ⚠️ 미완 |
| Backend 실제 DTO 정합성 end-to-end 검증 | ⚠️ 미검증 |
| `config.ts` 실제 환경 URL 교체 | ⚠️ 플레이스홀더 |

---

## 완료된 구현 단계

### Step 1 — MV3 Shell / 빌드 설정

Chrome MV3 Extension의 기본 구조와 빌드 파이프라인을 구성했다.

- `manifest.json`: MV3 형식, 필요한 권한(`storage`, `alarms`, `tabs`, `sidePanel`, `notifications`, `scripting`) 및 host permissions 선언
- Vite + TypeScript 기반 멀티 엔트리 빌드 구성 (`background`, `content`, `sidepanel`, `webapp-bridge` 각각 독립 번들)
- React 18 + react-dom 사이드패널 렌더링 기반 마련

### Step 2 — 공통 인프라 모듈 (src/shared/)

모든 Entry point가 공유하는 핵심 모듈들을 구현했다.

- **타입 정의** (`types.ts`): `ExtensionStatus`, `BackendRunStatus`, `ActionType`, `AbortReason`, `PageSnapshot`, `ActionResult`, `StepRequest/Response`, `RunDetailResponse`, `RecoverRunResponse`, 각종 메시지 타입 전체 정의
- **상수** (`constants.ts`): heartbeat 알람명, 주기(0.5분), `APPROVAL_TIMEOUT_MS`(10분), `STEP_REQUEST_MAX_RETRIES`(3), `ACTION_EXECUTION_MAX_RETRIES`(2), `HEARTBEAT_MAX_FAILURES`(3), storage 기본값
- **config** (`config.ts`): 백엔드 / 웹앱 base URL 설정 (현재 플레이스홀더)
- **storageManager** (`storageManager.ts`): `chrome.storage.local` 읽기/쓰기 추상화, 초기화, patch, `resetRunState`, `setLastSnapshot`, `setLastAction`
- **logger** (`logger.ts`): 구조화 로그 in-memory 관리, 최근 20개 FIFO, `StructuredLog` 스키마
- **apiClient** (`apiClient.ts`): MVP API 엔드포인트 전체 래퍼 — `registerDevice`, `heartbeat`, `getPendingRuns`, `startRun`, `getRun`, `recoverRun`, `postStep`, `abortRun`
- **messageRouter** (`messageRouter.ts`): `STATUS_SNAPSHOT` 메시지 생성 / 브로드캐스트, `REQUEST_STATUS_SNAPSHOT` 처리

### Step 3 — 페어링 / 디바이스 등록 흐름

웹 앱과 Extension 간 pairing token 기반 디바이스 등록 흐름을 구현했다.

- **webapp-bridge** (`src/webapp-bridge/index.ts`): `pbm-ext-ready` CustomEvent 발행, `PBM_EXTENSION_PAIR_REQUEST` 수신 후 background에 `PAIR_DEVICE` 전달, 결과를 `PBM_EXTENSION_PAIR_RESULT`로 응답
- **deviceManager** (`src/background/deviceManager.ts`): `pairDevice()` — `POST /api/v1/devices/register` 호출, 성공 시 `deviceId` / `deviceToken` storage 저장, 상태를 `PAIRED`로 전환, 즉시 heartbeat 1회 실행

### Step 4 — Heartbeat / ONLINE_STANDBY 전환

Chrome Alarms 기반 30초 주기 heartbeat 루프를 구현했다.

- **heartbeatManager** (`src/background/heartbeatManager.ts`): 중복 생성 방지, heartbeat 가능 상태 확인, `POST /api/v1/devices/{deviceId}/heartbeat` 호출, `PAIRED` → `ONLINE_STANDBY` 자동 전환, `assignedRun` 감지 시 `startAssignedRun()` 호출, `AWAITING_APPROVAL` 상태에서 `resumeApprovalRunIfPossible()` polling
- **background/index.ts**: `onInstalled`, `onStartup`, `chrome.alarms.onAlarm`, `chrome.runtime.onMessage` 핸들러. `onStartup` 시 복구/pending sync/heartbeat 병렬 실행. alarm 마다 `revalidateRunTabOrAbort()` 선행 실행

### Step 5 — Run 감지 / 활성 Run 1개 정책 / Run 시작

heartbeat 응답에서 Run을 감지하고 실행을 시작하는 전체 흐름을 구현했다.

- **runManager** (`src/background/runManager.ts`):
  - `startAssignedRun()` — 활성 Run 1개 정책 검사, `POST /runs/{runId}/start` 호출, storage에 run 컨텍스트 저장, `ensureRunTab()` → `collectSnapshotFromActiveTab()` → `runStepLoop()` 순차 진입, 오류 시 `finalizeRun('ERROR')` 처리
  - `syncPendingRuns()` — `GET /runs/pending` 조회 후 첫 번째 pending run을 `startAssignedRun()`으로 진입

### Step 6 — AliExpress 탭 관리

AliExpress 탭 재사용/생성/이동 및 drift 감지를 구현했다.

- **tabManager** (`src/background/tabManager.ts`):
  - `ensureRunTab(targetUrl)` — 기존 AliExpress 탭 재사용 우선, 없으면 신규 생성, `targetTabId` storage 저장, 탭 로드 완료(status=complete) 대기(15초 타임아웃)
  - `validateRunTab()` — 저장된 tabId의 현재 URL이 AliExpress 도메인인지 확인
  - `revalidateRunTabOrAbort()` — URL 이탈 감지 시 1회 재네비게이션 시도, 재시도 실패 시 `abortActiveRun('UNSUPPORTED_PAGE_STATE')` 호출. heartbeat alarm마다 선행 실행됨

### Step 7 — Snapshot 수집

Content script에서 DOM을 파싱해 `PageSnapshot` 구조로 수집하는 로직을 구현했다.

- **content/snapshotCollector.ts**: `collectSnapshot()` — interactive elements(최대 50개), visibleTextSummary(500자), optionGroups(select 기반), priceCandidates, currencyCandidates 수집. `buildNodeId()`로 요소별 고유 nodeId 생성
- **contentBridge** (`src/background/contentBridge.ts`): `collectSnapshotFromActiveTab()` — background에서 content script로 `COLLECT_SNAPSHOT` 메시지 발송, 응답 수신 후 storage에 `lastSnapshot` 저장
- **content/index.ts**: `COLLECT_SNAPSHOT` / `EXECUTE_ACTION` 메시지 수신 → 각 처리기로 라우팅

### Step 8 — Action 실행

Content script에서 6종 action을 DOM에 실행하는 로직을 구현했다.

- **content/actionExecutor.ts**: `executeInstruction()` — `NAVIGATE`, `CLICK`, `INPUT`, `SELECT`, `SCROLL`, `WAIT` 실행. nodeId 기반 요소 탐색 우선, `role+labelText` fallback, `selector` 최후 수단. disabled 요소 거부. 실행 결과를 `ContentToBackgroundActionResultMessage` 형태로 반환
- **background/actionExecutor.ts**: `executeInstructionInTab()` — background가 `EXECUTE_ACTION` 메시지를 content script로 전달, 응답 수신 후 snapshot 재수집, `ActionResult` 조립, `setLastAction()` 기록

### Step 9 — Step 루프 오케스트레이션

`/steps` API 왕복을 반복하는 step 루프와 종료 조건을 구현했다.

- **stepLoopManager** (`src/background/stepLoopManager.ts`): `runStepLoop()` — `previousActionResult: null`로 첫 호출 시작. 매 반복마다 `POST /runs/{runId}/steps` 요청, 응답 instruction에 따라:
  - `AWAIT_APPROVAL` → storage 상태 전환 후 루프 종료(승인 대기)
  - `COMPLETE` → `finalizeRun('COMPLETED')`
  - `ABORT` → `finalizeRun('ABORTED')`
  - `null` instruction → `finalizeRun('COMPLETED')`
  - 그 외 → `executeInstructionInTab()` 실행, failureCount 누적 관리
  - step 요청 exponential backoff 재시도(최대 3회), action 실행 재시도(최대 2회), `APPROVAL_TIMEOUT_MS` 초과 시 abort, `REPEATED_FAILURE`/`UNSUPPORTED_PAGE_STATE` 정책 적용

### Step 10 — 운영 강화 (Lifecycle / Recovery / Approval)

- **runLifecycle** (`src/background/runLifecycle.ts`):
  - `finalizeRun()` — run 상태를 COMPLETED/ABORTED/INTERRUPTED/ERROR 중 하나로 전환 후 `resetRunState()` 실행, 사이드패널 broadcast
  - `abortActiveRun()` — `POST /runs/{runId}/abort` 호출 후 `finalizeRun('ABORTED')` 처리
- **recoveryManager** (`src/background/recoveryManager.ts`):
  - `resumeApprovalRunIfPossible()` — `AWAITING_APPROVAL` 상태에서 heartbeat 시 `GET /runs/{runId}` 호출, backend status가 `RUNNING`이면 storage를 `EXECUTING`으로 전환 + tab/snapshot 재확보. `APPROVAL_EXPIRED`/`ABORTED`/`FAILED`이면 abort 처리
  - `recoverInterruptedRun()` — startup 시 `activeRunId`가 남아 있으면 `GET /runs/{runId}` 확인, `INTERRUPTED`/`RECOVERING` 상태면 `POST /runs/{runId}/recover` → 새 `agentToken` 수령 후 `startAssignedRun(..., 'recovery')` 재진입
- **사이드패널 운영 상태 필드**: `App.tsx`에 `activeRunId`, `backendRunStatus`, `failureCount`, `lastError`, `targetTabId`, `targetUrl`, `agentTokenLoaded`, `approvalRequestedAt`, `lastSnapshot` 표시 추가

---

## 파일별 구현 현황

### Root 파일

| 파일 | 역할 | 상태 |
|------|------|------|
| `manifest.json` | MV3 Extension 선언 | 완료 |
| `package.json` | 의존성 정의 및 빌드 스크립트 | 완료 |
| `tsconfig.json` | TypeScript strict 모드, ES2022 | 완료 |
| `vite.config.ts` | 4개 엔트리 멀티 빌드, `dist/` 출력 | 완료 |
| `sidepanel.html` | 사이드패널 HTML 진입점 | 완료 |

### src/background

| 파일 | 역할 | 현재 구현 |
|------|------|-----------|
| `index.ts` | Service Worker 진입점. 이벤트 핸들러 등록, startup 복구/pending sync/heartbeat 실행 | 완료 |
| `deviceManager.ts` | `pairDevice()` — 등록 API 호출 → storage 저장 → `PAIRED` 전환 → 즉시 heartbeat | 완료 |
| `heartbeatManager.ts` | `ensureHeartbeatAlarm()`, `runHeartbeat()` — 상태 확인 → API 호출 → `ONLINE_STANDBY` 전환 → `assignedRun` 감지 시 `startAssignedRun()` 호출 → `AWAITING_APPROVAL` 상태 polling | 완료 |
| `runManager.ts` | `startAssignedRun()` — 1개 정책 · run start API · tab 확보 · snapshot · step loop 진입 / `syncPendingRuns()` — pending 조회 후 run 시작 | 완료 |
| `tabManager.ts` | `ensureRunTab()` — AliExpress 탭 재사용/생성/이동 / `validateRunTab()` / `revalidateRunTabOrAbort()` — drift 감지 후 1회 재네비, 실패 시 abort | 완료 |
| `contentBridge.ts` | `collectSnapshotFromActiveTab()` — `COLLECT_SNAPSHOT` 메시지 전송 → snapshot 수신 → storage 저장 | 완료 |
| `actionExecutor.ts` | `executeInstructionInTab()` — `EXECUTE_ACTION` 메시지 전달 → 결과 수신 → snapshot 재수집 → `ActionResult` 조립 | 완료 |
| `stepLoopManager.ts` | `runStepLoop()` — `/steps` 왕복 루프, retry, COMPLETE/ABORT/AWAIT_APPROVAL 처리, failureCount 정책 | 완료 |
| `runLifecycle.ts` | `finalizeRun()` — run 상태 전환 + cleanup / `abortActiveRun()` — abort API 호출 + cleanup | 완료 |
| `recoveryManager.ts` | `resumeApprovalRunIfPossible()` — heartbeat 시 승인 완료 polling / `recoverInterruptedRun()` — startup 복구 진입 | 완료 (뼈대) |

### src/shared

| 파일 | 역할 | 현재 구현 |
|------|------|-----------|
| `types.ts` | 프로젝트 전체 TypeScript 타입. 계약 기반 전체 정의 | 완료 |
| `constants.ts` | heartbeat 알람명, 주기, APPROVAL_TIMEOUT_MS, STEP_REQUEST_MAX_RETRIES, ACTION_EXECUTION_MAX_RETRIES, HEARTBEAT_MAX_FAILURES, storage 기본값 | 완료 |
| `config.ts` | `getConfig()` — 백엔드/웹앱 URL 반환 (플레이스홀더) | 완료 (URL 교체 필요) |
| `logger.ts` | in-memory 구조화 로그, 최대 20개 FIFO, `console.info` 병행 | 완료 |
| `storageManager.ts` | `getStorage`, `initializeStorage`, `updateStorage`, `setExtensionStatus`, `setLastAction`, `setLastSnapshot`, `resetRunState` | 완료 |
| `apiClient.ts` | MVP API 전체 래퍼: `registerDevice`, `heartbeat`, `getPendingRuns`, `startRun`, `getRun`, `recoverRun`, `postStep`, `abortRun` | 완료 |
| `messageRouter.ts` | `STATUS_SNAPSHOT` 브로드캐스트, `REQUEST_STATUS_SNAPSHOT` 처리 | 완료 |

### src/content

| 파일 | 역할 | 현재 구현 |
|------|------|-----------|
| `index.ts` | AliExpress 페이지 content script. `COLLECT_SNAPSHOT` / `EXECUTE_ACTION` 메시지 수신 후 라우팅 | 완료 |
| `snapshotCollector.ts` | `collectSnapshot()` — interactiveElements(50개), visibleTextSummary(500자), optionGroups, priceCandidates, currencyCandidates, nodeId 생성 | 완료 |
| `actionExecutor.ts` | `executeInstruction()` — NAVIGATE / CLICK / INPUT / SELECT / SCROLL / WAIT / AWAIT_APPROVAL / COMPLETE / ABORT. nodeId → role+label → selector fallback 순서 | 완료 |

### src/sidepanel

| 파일 | 역할 | 현재 구현 |
|------|------|-----------|
| `main.tsx` | React 앱 마운트 진입점 | 완료 |
| `App.tsx` | 운영 상태 표시 UI — extensionStatus, backendRunStatus, deviceId, activeRunId, failureCount, lastError, targetTabId, targetUrl, agentTokenLoaded, approvalRequestedAt, lastSnapshot, lastHeartbeatAt, logs | 완료 (읽기 전용) |
| `hooks.ts` | `useStatusSnapshot()` — `REQUEST_STATUS_SNAPSHOT` 요청 + `STATUS_SNAPSHOT` 수신 구독 | 완료 |
| `styles.css` | 다크 테마 사이드패널 스타일 | 완료 |

### src/webapp-bridge

| 파일 | 역할 | 현재 구현 |
|------|------|-----------|
| `index.ts` | 웹 앱 페이지 content script. ready 이벤트 발행 + pairing 메시지 중계 | 완료 |

---

## 현재 동작 가능한 흐름

### 1. 웹 앱 readiness 이벤트

```
webapp-bridge.js 로드
  → window.dispatchEvent('pbm-ext-ready', { installed: true, version: '0.1.0' })
```

### 2. Pairing token 흐름

```
웹 앱 → window.postMessage({ type: 'PBM_EXTENSION_PAIR_REQUEST', pairingToken: '...' })
  → webapp-bridge.js 수신
  → chrome.runtime.sendMessage({ type: 'PAIR_DEVICE', ... })
  → deviceManager.pairDevice()
  → POST /api/v1/devices/register
  → 결과를 PBM_EXTENSION_PAIR_RESULT로 응답
```

### 3. Register → PAIRED 전환

```
POST /api/v1/devices/register 성공
  → chrome.storage.local에 deviceId, deviceToken 저장
  → extensionStatus = 'PAIRED'
  → ensureHeartbeatAlarm() → runHeartbeat('pairing') 즉시 실행
```

### 4. Heartbeat → ONLINE_STANDBY 전환

```
chrome.alarms.create('pbm-heartbeat', { periodInMinutes: 0.5 })
  → 매 30초마다 onAlarm 발화
  → revalidateRunTabOrAbort() 선행 실행 (run tab drift 감지)
  → runHeartbeat('alarm') 실행
  → POST /api/v1/devices/{deviceId}/heartbeat 성공
  → activeRunId 없으면 extensionStatus = 'ONLINE_STANDBY'
```

### 5. Assigned run 감지 / Pending run 감지 → Run 시작

```
heartbeat 응답에서 assignedRun != null
  → startAssignedRun(assignedRun, 'heartbeat')
  → 활성 Run 1개 정책 검사 (이미 activeRunId 있으면 skip)
  → POST /api/v1/runs/{runId}/start  (ASSIGNED → RUNNING 확정)
  → extensionStatus = 'EXECUTING', backendRunStatus = 'RUNNING', stepIndex = 0

또는 onStartup 시
  → syncPendingRuns() → GET /api/v1/runs/pending
  → 동일 경로로 startAssignedRun(nextRun, 'pending')
```

### 6. AliExpress 탭 확보 / targetUrl 이동

```
startAssignedRun() 중 assignedRun.targetUrl이 있으면
  → ensureRunTab(targetUrl)
  → 기존 AliExpress 탭 재사용 우선 (targetUrl 정확 일치 → AliExpress active 탭 → 첫 번째 탭)
  → 없으면 chrome.tabs.create({ url: targetUrl })
  → 탭 status=complete 대기 (최대 15초)
  → targetTabId, targetUrl storage 저장
```

### 7. Snapshot 수집

```
ensureRunTab() 완료 후
  → collectSnapshotFromActiveTab()
  → chrome.tabs.sendMessage(targetTabId, { type: 'COLLECT_SNAPSHOT' })
  → content/snapshotCollector.collectSnapshot() 실행
  → interactiveElements(최대 50개), visibleTextSummary(500자), optionGroups, priceCandidates 수집
  → storage.lastSnapshot 저장
```

### 8. 첫 번째 /steps 요청 (previousActionResult: null)

```
runStepLoop() 진입
  → POST /api/v1/runs/{runId}/steps
    { stepIndex: 0, previousActionResult: null, snapshot: <현재 snapshot> }
  → 응답 instruction 수신
```

### 9. Action 실행 루프

```
instruction 수신 후 action에 따라:
  AWAIT_APPROVAL → extensionStatus = 'AWAITING_APPROVAL', 루프 종료
  COMPLETE       → finalizeRun('COMPLETED'), cleanup
  ABORT          → finalizeRun('ABORTED'), cleanup
  null           → finalizeRun('COMPLETED'), cleanup
  그 외 action   →
    executeInstructionInTab(instruction)
    → chrome.tabs.sendMessage(targetTabId, { type: 'EXECUTE_ACTION', ... })
    → content/actionExecutor.executeInstruction() 실행
      - NAVIGATE: window.location.href = url
      - CLICK:    요소 찾기 → element.click()
      - INPUT:    요소 찾기 → element.value = value + input/change 이벤트
      - SELECT:   select.value = value + change 이벤트
      - SCROLL:   window.scrollBy(...)
      - WAIT:     setTimeout(waitMs)
    → snapshot 재수집
    → ActionResult 조립 후 다음 루프에서 previousActionResult로 전달
```

### 10. AWAIT_APPROVAL / 승인 재개 groundwork

```
instruction.action === 'AWAIT_APPROVAL'
  → storage: extensionStatus='AWAITING_APPROVAL', approvalRequestedAt=now
  → step 루프 종료 (루프 밖에서 대기)

이후 heartbeat alarm 마다
  → resumeApprovalRunIfPossible() 호출
  → GET /api/v1/runs/{runId} → status 확인
  → 'RUNNING'이면: storage를 EXECUTING으로 전환, tab/snapshot 재확보
    (주의: step loop 자동 재진입은 현재 미구현 — 하단 '미완 항목' 참조)
  → 'APPROVAL_EXPIRED' / 'ABORTED' / 'FAILED'이면: ABORTED로 처리
  → 승인 대기 10분 초과 시 APPROVAL_EXPIRED abort

```

### 11. Cleanup / 복구 groundwork

```
run 종료(완료/중단/오류) 시
  → finalizeRun() → extensionStatus 전환 → resetRunState()
    (agentToken, activeRunId, stepIndex, failureCount, lastSnapshot, targetTabId 등 초기화)
  → broadcastStatusSnapshot()

onStartup 시
  → recoverInterruptedRun()
    → storage.activeRunId 있으면 GET /runs/{runId}
    → INTERRUPTED/RECOVERING이면 POST /runs/{runId}/recover → 새 agentToken
    → startAssignedRun(..., 'recovery')
```

---

## 미완 항목 / 실제로 남은 갭

아래 항목들은 계약에 명세되어 있거나 정상 동작에 필요하지만 **현재 불완전하거나 검증이 부족한** 항목들이다.

| 항목 | 현재 상태 | 우선도 |
|------|-----------|--------|
| **승인 재개 후 step loop 자동 재진입** | `resumeApprovalRunIfPossible()`이 storage를 EXECUTING으로 전환하지만, `runStepLoop()`를 다시 호출하지 않음. 실질적 승인 재개가 동작하지 않음 | 높음 |
| **복구 3회 재시도 정책** | `recoverInterruptedRun()`은 1회 시도만 하고, 계약의 "3회 실패 후 ABORTED" 정책이 구현되어 있지 않음 | 중간 |
| **`agentToken` 메모리 전용 보관** | 현재 `chrome.storage.local`에 임시 저장 후 `resetRunState()`로 삭제. 계약상 storage 저장 금지이나, Service Worker 수명 주기 특성상 불가피한 절충안임. run 완료 시 삭제는 되지만 계약 엄밀 준수는 아님 | 중간 |
| **Backend 실제 DTO 정합성** | `types.ts`의 타입 정의와 실제 backend 응답 JSON 필드명/구조가 정확히 일치하는지 end-to-end 검증이 수행된 적 없음. 특히 `StepResponse.instruction`, `RecoverRunResponse`, `HeartbeatResponse.assignedRun.targetUrl` 등 | 높음 |
| **nodeId 안정성** | `buildNodeId()`는 DOM 인덱스 기반으로 생성하므로 DOM 변동 시 같은 요소에 대해 다른 nodeId가 생성될 수 있음. AliExpress 같은 SPA에서는 특히 취약 | 중간 |
| **NAVIGATE 후 content script 연속성** | `window.location.href` 변경은 페이지 리로드를 유발하므로, 이동 후 새 content script가 로드될 때까지 background가 snapshot 재요청을 대기해야 함. 현재 탭 로드 완료(status=complete) 대기는 있으나, 이동 직후 `COLLECT_SNAPSHOT` 응답 실패 시의 처리 경로가 검증되지 않음 | 중간 |
| **Retry/abort 숫자의 시나리오 검증** | `STEP_REQUEST_MAX_RETRIES=3`, `ACTION_EXECUTION_MAX_RETRIES=2` 등의 상수는 정의되어 있으나 실제 네트워크 오류 / DOM 오류 시나리오에서 동작이 검증된 적 없음 | 낮음 |
| **`config.ts` URL 실제값 교체** | `your-backend-api.com`, `your-web-app.com` 플레이스홀더 그대로 | 즉시 가능 |
| **사용자 취소(USER_CANCELLED) 트리거** | `AbortReason.USER_CANCELLED`가 타입으로 정의되어 있으나 사이드패널에서 사용자가 실제로 취소를 발생시키는 UI가 없음 | 낮음 |
| **`agentToken` null 확인 누락 가능성** | `runManager.ts`에서 `agentToken`을 storage에서 읽어 사용하는 시점에 null 체크가 일부 경로에서 `!` assertion 처리됨. 실제 오류 시 메시지가 불명확할 수 있음 | 낮음 |

---

## 검증 현황

| 항목 | 결과 |
|------|------|
| `npm install` | 완료 |
| `npm run typecheck` (tsc --noEmit) | **통과** |
| `npm run build` (vite build + cp manifest.json) | **통과** |
| backend 실제 연동 end-to-end 테스트 | **미수행** |
| AliExpress 실제 페이지 동작 테스트 | **미수행** |

빌드 결과물은 `dist/` 디렉터리에 생성되며, Chrome 확장 프로그램 개발자 모드에서 `dist/` 폴더를 직접 로드할 수 있다.

---

## 다음 단계 권장 사항

기본 아키텍처 구현은 완성 단계에 가깝다. 다음 단계의 초점은 **통합 강화 / backend 계약 정합성 검증 / 시나리오 테스트**다.

### 1. Backend 계약 정합성 검증 (우선)

실제 backend와 연동해 API 요청/응답 형식을 확인한다.

- `POST /runs/{runId}/steps` 응답에서 `instruction`이 null인 경우와 값이 있는 경우 각각 확인
- `GET /runs/{runId}` 응답의 `stepIndex`, `status` 필드 확인
- `POST /runs/{runId}/recover` 응답의 `agentToken`, `targetUrl` 필드 확인
- Heartbeat 응답의 `assignedRun.targetUrl` 포함 여부 확인
- `config.ts`의 플레이스홀더 URL을 실제 환경 URL로 교체

### 2. 승인 재개 step loop 자동 재진입 완성

현재 `resumeApprovalRunIfPossible()`은 storage 상태만 전환하고 step loop를 재시작하지 않는다.

- `resumeApprovalRunIfPossible()`이 `true`를 반환할 때 `runStepLoop()`를 다시 호출하는 경로 추가
- 재진입 시 이전 `previousActionResult`는 null로 초기화하고 현재 snapshot으로 재시작하는 것이 안전함

### 3. 복구 재시도 정책 완성

`recoverInterruptedRun()`에 계약 명세의 "3회 실패 후 ABORTED" 정책을 추가한다.

- `recoverRun()` API 호출 실패 시 backoff 재시도(최대 3회)
- 3회 모두 실패 시 `abortActiveRun('RECOVERY_FAILED')` 처리

### 4. 실제 AliExpress 페이지 동작 검증

- NAVIGATE 이후 content script 재로드 타이밍에서 snapshot 수집이 정상 동작하는지 확인
- nodeId 기반 요소 탐색이 실제 AliExpress DOM 구조에서 안정적으로 동작하는지 확인
- `CLICK`, `INPUT`, `SELECT` action이 AliExpress의 React/custom 이벤트 핸들러와 호환되는지 확인

### 5. 사용자 취소 트리거 (Optional)

사이드패널에 "Run 취소" 버튼을 추가해 `USER_CANCELLED` abort 경로를 실제로 사용할 수 있게 한다.

---

> 이 문서는 구현이 진행될 때마다 현재 상태를 반영해 갱신한다.
> 계약 기준에 대한 질문은 항상 [`docs/browser-agent-contract.md`](./browser-agent-contract.md)를 먼저 확인한다.
