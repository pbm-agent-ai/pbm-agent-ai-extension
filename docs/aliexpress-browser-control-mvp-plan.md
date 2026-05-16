# AliExpress 브라우저 제어형 AI 구매 확장프로그램 - MVP 설계 문서

> 작성일: 2026-05-16  
> 상태: 초안 (이슈 생성 전 팀 리뷰용)  
> 대상 레포: `pbm-agent-ai-extension`

---

## 1. 문서 목적

이 문서는 `pbm-agent-ai-extension` 레포를 처음 세팅하는 시점에, 팀이 공통된 방향으로 작업을 시작할 수 있도록 작성한 기획/설계 초안이다.

- 이슈를 만들기 전에 참고하는 설계 기준선 역할을 한다.
- 기술적 선택의 이유와 제약 조건을 명시한다.
- MVP 범위를 명확히 잡아서 초기부터 과도한 확장을 방지한다.

---

## 2. 범위

### 이번 단계에서 하는 것 (MVP)

- [ ] AliExpress 사이트 전용 브라우저 제어 구현
- [ ] 상품 검색 결과 탐색 및 상품 페이지 이동
- [ ] 상품 옵션(색상, 사이즈 등) 선택
- [ ] 장바구니 추가
- [ ] 구매 진행 흐름 단계별 제어 (배송지 선택까지)
- [ ] 최종 결제 직전 단계에서 사용자 승인 대기
- [ ] Side Panel UI에서 AI 지시 입력 및 진행 상황 표시
- [ ] MV3 기반 확장프로그램 기본 구조 세팅

### 이번 단계에서 하지 않는 것

- AliExpress 외 다른 쇼핑몰 지원 (Taobao, Amazon, Coupang 등)
- 실제 결제 자동 실행 (사용자 승인 게이트 이후 자동화 금지)
- 비밀번호, 카드번호 등 민감정보 입력 자동화
- 이미지 인식 기반 비전 클릭 (MVP에서는 폴백으로만 존재)
- 멀티 탭 동시 제어
- 구매 이력 저장/분석 기능
- 백엔드 payment-service 연동 (별도 단계에서 진행)

---

## 3. 왜 AliExpress부터 시작하는가

- **DOM 구조가 비교적 일관적**: 상품 목록, 옵션 선택, 장바구니 흐름이 정형화되어 있어 초기 제어 로직 개발에 적합하다.
- **구매 흐름이 단순함**: 게스트 구매 지원, 단계별 페이지 분리가 명확하다.
- **Accessibility 속성 사용**: 일부 요소에 `aria-label`, `data-*` 속성이 있어 DOM 기반 탐색 가능성이 높다.
- **초기 검증 대상**: PBM 결제 시스템과 연동 전, 브라우저 제어 패턴 자체를 먼저 검증하기 위한 최소 타겟으로 적합하다.
- **쇼핑몰 하나를 깊게 검증한 뒤** 패턴을 추상화해서 다른 사이트로 확장하는 전략을 취한다.

---

## 4. 권장 브라우저 제어 방식 및 우선순위

브라우저 제어는 아래 순서로 시도하며, 상위 방식이 동작하면 하위 방식은 사용하지 않는다.

| 우선순위 | 방식 | 설명 | 사용 조건 |
|---|---|---|---|
| 1순위 | **DOM / Accessibility 기반** | `querySelector`, `aria-label`, `data-*`, role 속성으로 요소 탐색 후 `.click()` / `.dispatchEvent()` | 가장 먼저 시도. 안정적이고 유지보수 쉬움 |
| 2순위 | **JS 실행 기반** | `chrome.scripting.executeScript`로 직접 JS 인젝션, 폼 값 변경, 이벤트 트리거 | DOM 탐색으로 접근 불가한 경우 |
| 3순위 | **chrome.debugger + CDP** | Chrome DevTools Protocol을 통한 실제 Input 이벤트 발생 (`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`) | 리액트/뷰 등 가상 DOM 처리 이슈가 있을 때 |
| 4순위 (폴백) | **비전 + 좌표 클릭** | 스크린샷 캡처 후 LLM 비전으로 좌표 추정, CDP로 클릭 | 위 3가지가 모두 실패한 경우에만 |

> **주의**: 4순위(비전 클릭)는 좌표 기반이라 AliExpress 레이아웃 변경에 매우 취약하다. 의존도를 최소화한다.

---

## 5. MV3 확장 기본 구조 제안

Manifest V3 기준으로 구성한다.

```
manifest.json (MV3)
├── background (Service Worker)
│   - AI 오케스트레이션 로직
│   - 메시지 라우팅 (side panel ↔ content script)
│   - chrome.debugger 세션 관리
│   - 외부 API 호출 (백엔드, LLM)
│
├── content script (AliExpress 전용)
│   - DOM 탐색 및 조작
│   - 페이지 상태 감지 및 리포팅
│   - 사용자 승인 게이트 UI 삽입
│
├── side panel (UI)
│   - 사용자 지시 입력창
│   - AI 작업 진행 상황 표시
│   - 승인 요청 카드 표시
│   - 에러/중단 제어
│
└── (optional) debugger bridge
    - CDP 명령 추상화 래퍼
    - 실제 마우스/키보드 이벤트 발생
```

### 주요 메시지 흐름

```
사용자 입력 (side panel)
  → Service Worker (AI 판단, 단계 분해)
    → Content Script (DOM 제어, 상태 리포팅)
      → Service Worker (다음 단계 판단)
        → Side Panel (진행 상황 표시)
```

---

## 6. 초기 폴더 구조 제안

```
pbm-agent-ai-extension/
├── manifest.json
├── docs/
│   └── aliexpress-browser-control-mvp-plan.md
├── src/
│   ├── background/
│   │   ├── index.ts              # Service Worker 진입점
│   │   ├── orchestrator.ts       # AI 스텝 오케스트레이션
│   │   ├── messageRouter.ts      # 메시지 라우팅
│   │   └── debuggerBridge.ts     # CDP 래퍼 (optional)
│   ├── content/
│   │   ├── index.ts              # Content Script 진입점
│   │   ├── domController.ts      # DOM 탐색/조작
│   │   ├── pageObserver.ts       # 페이지 상태 감지
│   │   └── approvalGate.ts       # 승인 게이트 UI
│   ├── sidepanel/
│   │   ├── index.html
│   │   ├── App.tsx               # Side Panel 루트
│   │   ├── components/
│   │   │   ├── CommandInput.tsx  # 사용자 지시 입력
│   │   │   ├── StepLog.tsx       # 진행 로그
│   │   │   └── ApprovalCard.tsx  # 승인 요청 카드
│   │   └── store/                # 상태 관리
│   ├── shared/
│   │   ├── types.ts              # 공통 타입 정의
│   │   ├── constants.ts          # 상수 (AliExpress 도메인 등)
│   │   └── utils.ts              # 공통 유틸
│   └── assets/
│       └── icons/
├── tests/
│   ├── content/
│   └── background/
├── .env.example
├── package.json
├── tsconfig.json
├── vite.config.ts (또는 webpack.config.ts)
└── README.md
```

---

## 7. 데이터/보안 원칙

아래 원칙은 예외 없이 적용한다.

### 절대 LLM/서버로 보내지 않는 정보

- [ ] 로그인 비밀번호
- [ ] 신용카드/직불카드 번호, CVC, 유효기간
- [ ] SMS/이메일 인증번호 (OTP)
- [ ] 브라우저 쿠키 전체
- [ ] 세션 토큰, access token

### 허용되는 전송 데이터

- 상품명, 가격, 옵션명 등 공개된 페이지 텍스트
- 현재 페이지 URL
- AI가 수행한 단계 요약 텍스트
- 사용자가 명시적으로 입력한 지시 내용

### 로컬 저장소 사용 원칙

- `chrome.storage.local`은 비민감 설정값만 저장
- 민감정보는 어디에도 저장하지 않음 (세션 내 메모리에만 유지)
- 스크린샷 캡처 시 민감 영역(카드번호 입력 폼 등)은 마스킹 처리

---

## 8. 사용자 승인 게이트 정책

고위험 액션은 자동 실행하지 않고 반드시 사용자 확인 후 진행한다.

### 승인 게이트가 필요한 액션

| 액션 | 위험도 | 처리 방식 |
|---|---|---|
| 최종 주문 제출 (Place Order) | 🔴 HIGH | 반드시 사용자 승인 후 진행 |
| 결제 수단 선택/변경 | 🔴 HIGH | 반드시 사용자 승인 후 진행 |
| 배송지 신규 추가 | 🟡 MEDIUM | 사용자 확인 권장 |
| 장바구니 전체 삭제 | 🟡 MEDIUM | 사용자 확인 권장 |
| 장바구니 추가 | 🟢 LOW | 자동 실행 가능 (로그만 남김) |
| 상품 탐색/클릭 | 🟢 LOW | 자동 실행 |

### 승인 게이트 UI 동작

1. AI가 고위험 액션 직전에 실행을 **일시 중단**한다.
2. Side Panel에 `ApprovalCard` 컴포넌트가 표시된다.
3. 카드에는 "수행하려는 액션 요약 + 예상 결과"가 명시된다.
4. 사용자가 **승인** 또는 **취소**를 선택한다.
5. 승인 시 해당 단계를 실행하고 이후 흐름을 재개한다.
6. 취소 시 전체 작업을 중단하고 사유를 로그에 기록한다.

---

## 9. MVP 구현 단계

### Phase 1 - 기반 세팅 (1~2주)

- [ ] `manifest.json` MV3 기본 세팅 (permissions, host_permissions, side_panel)
- [ ] TypeScript + Vite(또는 Webpack) 빌드 환경 구성
- [ ] Service Worker 기본 메시지 라우팅 구현
- [ ] Content Script 기본 로더 구현 (AliExpress 도메인 한정)
- [ ] Side Panel 기본 UI 뼈대 구현
- [ ] `shared/types.ts` 공통 메시지 타입 정의

### Phase 2 - DOM 제어 핵심 기능 (2~3주)

- [ ] AliExpress 상품 목록 페이지 DOM 구조 분석 및 문서화
- [ ] 상품 상세 페이지 DOM 구조 분석 및 문서화
- [ ] `domController.ts` - 요소 탐색 유틸 구현 (aria, data-*, role 기반)
- [ ] 상품 옵션(색상/사이즈) 선택 제어 구현
- [ ] 장바구니 추가 제어 구현
- [ ] `pageObserver.ts` - 페이지 전환 및 상태 변화 감지 구현

### Phase 3 - AI 오케스트레이션 (2~3주)

- [ ] `orchestrator.ts` - 단계별 태스크 분해 로직 구현
- [ ] LLM API 연동 (단계 판단 및 다음 액션 결정)
- [ ] 백엔드 `command-service` 연동 (자연어 → 구조화 지시)
- [ ] 에러 핸들링 및 재시도 로직 구현
- [ ] 단계 실패 시 폴백 방식 전환 로직 구현

### Phase 4 - 승인 게이트 & 안정화 (1~2주)

- [ ] `approvalGate.ts` - 승인 요청 UI 삽입 구현
- [ ] `ApprovalCard.tsx` - Side Panel 승인 카드 UI 구현
- [ ] 고위험 액션 탐지 및 자동 중단 로직 구현
- [ ] 전체 흐름 E2E 테스트 (검색 → 옵션 선택 → 장바구니 → 구매 직전)
- [ ] 보안 원칙 준수 여부 코드 리뷰

---

## 10. 이후 확장 단계

MVP 안정화 이후에 아래 순서로 확장한다.

### 안정화 단계

- CDP 기반 실제 입력 이벤트 구현 (`debuggerBridge.ts` 완성)
- 비전 폴백 구현 (스크린샷 → LLM 비전 → 좌표 클릭)
- AliExpress 레이아웃 변경 감지 및 알림 체계 구축
- 단위 테스트 및 E2E 테스트 커버리지 확대

### 고도화 단계

- 두 번째 쇼핑몰 지원 (패턴 추상화 후 확장)
- `payment-service` 연동 (PBM 결제 트리거)
- 구매 이력 저장 및 조회
- 멀티 탭 제어 지원
- 사용자 선호 설정 (자동 승인 레벨 조정 등)

---

## 11. 초기에 만들 이슈 예시 목록

아래는 Phase 1~2 기준으로 바로 생성할 수 있는 이슈 예시다.

### 세팅 이슈

- `[chore] MV3 manifest.json 기본 구성 및 permissions 설정`
- `[chore] TypeScript + Vite 빌드 환경 세팅`
- `[chore] ESLint / Prettier 설정`
- `[chore] 공통 타입 정의 (shared/types.ts)`

### 기능 이슈

- `[feat] Service Worker 기본 메시지 라우터 구현`
- `[feat] Content Script 기본 로더 구현 (AliExpress 한정)`
- `[feat] Side Panel 기본 UI 뼈대 구현 (CommandInput, StepLog)`
- `[feat] AliExpress 상품 목록 DOM 구조 분석 및 탐색 유틸 구현`
- `[feat] AliExpress 상품 상세 페이지 옵션 선택 제어 구현`
- `[feat] 장바구니 추가 DOM 제어 구현`
- `[feat] 페이지 상태 감지 (pageObserver) 구현`
- `[feat] 사용자 승인 게이트 UI 및 로직 구현`

### 분석/문서 이슈

- `[docs] AliExpress 상품 목록 페이지 DOM 구조 분석 정리`
- `[docs] AliExpress 구매 흐름 단계별 페이지 URL 및 DOM 패턴 문서화`

---

## 권장 첫 이슈 순서

이슈를 처음 만들 때 아래 순서로 진행하면 블로커 없이 병렬 작업이 가능하다.

```
1. [chore] MV3 manifest.json 기본 구성
2. [chore] TypeScript + Vite 빌드 환경 세팅
3. [chore] 공통 타입 정의 (shared/types.ts)
     ↓ 위 3개 완료 후
4. [feat] Service Worker 메시지 라우터 구현
5. [feat] Content Script 기본 로더 구현
6. [feat] Side Panel 기본 UI 뼈대 구현
     ↓ 위 3개 완료 후
7. [docs] AliExpress DOM 구조 분석 정리
     ↓ 분석 완료 후
8. [feat] DOM 탐색 유틸 구현
9. [feat] 옵션 선택 / 장바구니 제어 구현
10. [feat] 승인 게이트 구현
```

---

## 브랜치 전략

- `main`: 배포 브랜치
- `develop`: 개발 통합 브랜치
- `feature/{기능명}`: 기능 개발
- `fix/{버그명}`: 버그 수정

> 이 확장프로그램 레포(`pbm-agent-ai-extension`)는 백엔드 레포(`pbm-agent-ai-backend`)와 별도 레포로 관리한다.

---

*이 문서는 초기 설계 초안이며, 구현 과정에서 AliExpress DOM 분석 결과에 따라 세부 내용이 변경될 수 있다.*
