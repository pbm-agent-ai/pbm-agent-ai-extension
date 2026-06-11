import { useState } from 'react';
import type { ActionInstruction, BackendRunStatus, BackgroundToSidePanelMessage, ExtensionStatus, RunDetailResponse, StructuredLog } from '../shared/types';
import { useDeviceCredentials, useDeviceRuns, useStatusSnapshot } from './hooks';

const fallbackBackendRunStatus: BackendRunStatus = 'QUEUED';

function StatusBadge({ label, value }: { label: string; value: string }) {
  return (
    <div className="status-badge">
      <span className="status-badge__label">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

/** Extension 상태 한글 레이블 변환 */
function getExtensionStatusLabel(status: ExtensionStatus): string {
  const map: Record<ExtensionStatus, string> = {
    IDLE: '유휴',
    PAIRED: '페어링됨',
    ONLINE_STANDBY: '온라인 대기',
    EXECUTING: '실행 중',
    AWAITING_APPROVAL: '승인 대기',
    AWAITING_OPTION_SELECTION: '옵션 선택 대기',
    INTERRUPTED: '중단됨',
    RECOVERING: '복구 중',
    ERROR: '오류',
    ABORTED: '중단됨',
    COMPLETED: '완료'
  };
  return map[status] ?? status;
}

/** Backend Run 상태 한글 레이블 변환 */
function getBackendRunStatusLabel(status: BackendRunStatus): string {
  const map: Record<BackendRunStatus, string> = {
    QUEUED: '대기 중',
    ASSIGNED: '할당됨',
    RUNNING: '실행 중',
    AWAITING_APPROVAL: '승인 대기',
    AWAITING_OPTION_SELECTION: '옵션 선택 대기',
    APPROVAL_EXPIRED: '승인 만료',
    INTERRUPTED: '중단됨',
    RECOVERING: '복구 중',
    COMPLETED: '완료',
    FAILED: '실패',
    ABORTED: '중단됨'
  };
  return map[status] ?? status;
}

/** Run 상태에 따른 배지 색상 */
function RunStatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    QUEUED: '#f59e0b',
    ASSIGNED: '#3b82f6',
    RUNNING: '#10b981',
    AWAITING_APPROVAL: '#8b5cf6',
    AWAITING_OPTION_SELECTION: '#8b5cf6',
    INTERRUPTED: '#ef4444',
    RECOVERING: '#f97316',
  };
  const color = colorMap[status] ?? '#6b7280';
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: '9999px',
      fontSize: '11px',
      fontWeight: 700,
      color: '#fff',
      background: color,
      letterSpacing: '0.03em'
    }}>
      {status}
    </span>
  );
}

/** Action 타입별 색상 + 한국어 레이블 */
const ACTION_META: Record<string, { color: string; label: string; emoji: string }> = {
  NAVIGATE:       { color: '#3b82f6', label: '페이지 이동',    emoji: '🌐' },
  CLICK:          { color: '#10b981', label: '버튼 클릭',      emoji: '👆' },
  INPUT:          { color: '#8b5cf6', label: '텍스트 입력',    emoji: '⌨️' },
  SELECT:         { color: '#f59e0b', label: '옵션 선택',      emoji: '📋' },
  SCROLL:         { color: '#6b7280', label: '스크롤',         emoji: '📜' },
  WAIT:           { color: '#6b7280', label: '대기 중',        emoji: '⏳' },
  USE_TOOL:       { color: '#f97316', label: '도구 사용',      emoji: '🔧' },
  AWAIT_APPROVAL: { color: '#ef4444', label: '승인 대기',      emoji: '⚠️' },
  COMPLETE:       { color: '#10b981', label: '완료',           emoji: '✅' },
  ABORT:          { color: '#ef4444', label: '중단',           emoji: '🛑' },
};

/** 서버에서 받은 instruction을 보기 좋게 표시하는 카드 */
function InstructionCard({ instruction }: { instruction: ActionInstruction | null }) {
  if (!instruction) {
    return (
      <div style={{ padding: '12px', borderRadius: '8px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', textAlign: 'center' }}>
        <span style={{ fontSize: '12px', opacity: 0.4 }}>대기 중 — 아직 수신된 지시 없음</span>
      </div>
    );
  }

  const meta = ACTION_META[instruction.action] ?? { color: '#6b7280', label: instruction.action, emoji: '❓' };

  // 사람이 읽기 좋은 설명 생성
  const description = (() => {
    switch (instruction.action) {
      case 'NAVIGATE':
        return instruction.value ?? '-';
      case 'CLICK':
        return instruction.target?.labelText
          ? `"${instruction.target.labelText}" 클릭`
          : instruction.target?.role
            ? `[${instruction.target.role}] 요소 클릭`
            : '요소 클릭';
      case 'INPUT':
        const rawVal = instruction.value ?? '';
        const displayVal = rawVal.endsWith('\n') ? rawVal.slice(0, -1) + ' + Enter' : rawVal;
        const target = instruction.target?.labelText ? ` → "${instruction.target.labelText}"` : '';
        return `${displayVal}${target}`;
      case 'SELECT':
        return `"${instruction.value}" 선택 → ${instruction.target?.labelText ?? ''}`;
      case 'SCROLL':
        return `${instruction.value ?? 400}px 스크롤`;
      case 'WAIT':
        return `${instruction.waitMs ?? 1000}ms 대기`;
      case 'USE_TOOL':
        return instruction.toolRequest?.name ?? '-';
      case 'AWAIT_APPROVAL':
        return instruction.approvalContext?.summaryText ?? '승인 대기 중';
      default:
        return '-';
    }
  })();

  return (
    <div style={{
      padding: '12px',
      borderRadius: '8px',
      background: 'rgba(255,255,255,0.04)',
      border: `1px solid ${meta.color}44`,
      borderLeft: `3px solid ${meta.color}`
    }}>
      {/* Action 타입 배지 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <span style={{ fontSize: '16px' }}>{meta.emoji}</span>
        <span style={{
          fontSize: '11px', fontWeight: 700, color: meta.color,
          background: `${meta.color}22`, padding: '2px 8px',
          borderRadius: '9999px', letterSpacing: '0.05em'
        }}>
          {meta.label}
        </span>
        <span style={{ fontSize: '11px', opacity: 0.4, marginLeft: 'auto' }}>
          Step {instruction.stepIndex}
        </span>
      </div>

      {/* 설명 */}
      <p style={{
        margin: 0, fontSize: '12px', opacity: 0.85,
        wordBreak: 'break-all', lineHeight: '1.5',
        padding: '6px 8px',
        background: 'rgba(0,0,0,0.2)',
        borderRadius: '4px',
        fontFamily: instruction.action === 'NAVIGATE' ? 'monospace' : 'inherit'
      }}>
        {description}
      </p>

      {/* 대상 요소 상세 (CLICK / INPUT일 때) */}
      {instruction.target?.nodeId && (
        <p style={{ margin: '6px 0 0', fontSize: '10px', opacity: 0.35, fontFamily: 'monospace' }}>
          nodeId: {instruction.target.nodeId}
        </p>
      )}
    </div>
  );
}

/** 개별 Run 카드 */
function RunCard({
  run,
  isActive,
  onAbort
}: {
  run: RunDetailResponse;
  isActive: boolean;
  onAbort: (runId: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const shortId = run.runId.slice(0, 8) + '…';
  const createdAt = run.createdAt ? new Date(run.createdAt).toLocaleString() : '-';

  return (
    <li style={{
      padding: '10px 12px',
      borderRadius: '8px',
      background: isActive ? 'rgba(16,185,129,0.08)' : 'rgba(255,255,255,0.04)',
      border: `1px solid ${isActive ? '#10b981' : 'rgba(255,255,255,0.1)'}`,
      marginBottom: '8px',
      listStyle: 'none'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            {isActive && <span style={{ fontSize: '10px', fontWeight: 700, color: '#10b981' }}>● 현재 실행 중</span>}
            <code style={{ fontSize: '12px', opacity: 0.7 }}>{shortId}</code>
          </div>
          <RunStatusBadge status={run.status} />
          <span style={{ fontSize: '11px', opacity: 0.5, marginLeft: 8 }}>Step {run.currentStepIndex}</span>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: '11px', opacity: 0.5, marginBottom: 4 }}>{createdAt}</div>
          {confirming ? (
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                onClick={() => { onAbort(run.runId); setConfirming(false); }}
                style={{ fontSize: '11px', padding: '3px 8px', background: '#ef4444', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}
              >
                확인
              </button>
              <button
                onClick={() => setConfirming(false)}
                style={{ fontSize: '11px', padding: '3px 8px', background: 'rgba(255,255,255,0.1)', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}
              >
                취소
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              style={{ fontSize: '11px', padding: '3px 10px', background: 'rgba(239,68,68,0.15)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 4, cursor: 'pointer' }}
            >
              중단
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

/** 캡챠 수동 완료 버튼 — CAPTCHA 대기 상태일 때만 표시 */
function CaptchaResolvedButton() {
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const handleClick = () => {
    setLoading(true);
    chrome.runtime.sendMessage({ type: 'CAPTCHA_MANUALLY_RESOLVED' }, () => {
      setLoading(false);
      setDone(true);
      setTimeout(() => setDone(false), 3000);
    });
  };

  return (
    <button
      onClick={handleClick}
      disabled={loading || done}
      style={{
        width: '100%',
        padding: '12px',
        marginTop: '12px',
        background: done ? 'rgba(16,185,129,0.15)' : 'rgba(139,92,246,0.15)',
        color: done ? '#10b981' : '#a78bfa',
        border: `1px solid ${done ? 'rgba(16,185,129,0.4)' : 'rgba(139,92,246,0.4)'}`,
        borderRadius: '8px',
        cursor: loading || done ? 'default' : 'pointer',
        fontSize: '13px',
        fontWeight: 700,
        letterSpacing: '0.02em'
      }}
    >
      {done ? '✓ 재개 중...' : loading ? '처리 중...' : '✅ 캡챠 인증 완료 — 자동화 재개'}
    </button>
  );
}

/** Run 상태만 초기화 (deviceId/Token 유지) */
function ResetRunStateButton({ onDone }: { onDone?: () => void }) {
  const [done, setDone] = useState(false);

  const handleReset = () => {
    chrome.runtime.sendMessage({ type: 'RESET_RUN_STATE' }, () => {
      setDone(true);
      onDone?.();
      setTimeout(() => setDone(false), 3000);
    });
  };

  return (
    <button
      onClick={handleReset}
      style={{
        width: '100%',
        padding: '8px',
        marginTop: '8px',
        background: done ? 'rgba(16,185,129,0.15)' : 'rgba(251,191,36,0.1)',
        color: done ? '#10b981' : '#fbbf24',
        border: `1px solid ${done ? 'rgba(16,185,129,0.3)' : 'rgba(251,191,36,0.25)'}`,
        borderRadius: '6px',
        cursor: 'pointer',
        fontSize: '12px',
        fontWeight: 600
      }}
    >
      {done ? '✓ Run 상태 초기화 완료' : '⚠️ Run 상태만 초기화 (페어링 유지)'}
    </button>
  );
}

/** 사용자 리셋 / 다른 사용자로 전환 섹션 */
function UserResetSection({
  snapshot,
  activeRunCount
}: {
  snapshot: BackgroundToSidePanelMessage['payload'] | null;
  activeRunCount: number;
}) {
  const [step, setStep] = useState<'idle' | 'confirm' | 'done'>('idle');
  const { deviceId: storageDeviceId, deviceToken: storageDeviceToken } = useDeviceCredentials();

  // 설명: snapshot 브로드캐스트가 잠깐 stale일 수 있어 연결 상태 표시는 storage 값을 우선 사용한다.
  const deviceId = storageDeviceId ?? snapshot?.deviceId ?? null;
  const deviceTokenExists = storageDeviceToken != null || (snapshot?.deviceTokenExists ?? false);
  const isConnected = deviceId != null && deviceTokenExists;

  // Debug: 현재 연결 상태 결정에 사용된 입력값 로깅
  console.info('[sidepanel-debug] UserResetSection 렌더', {
    snapshotDeviceId: snapshot?.deviceId ? snapshot.deviceId.slice(0, 12) + '…' : null,
    snapshotDeviceTokenExists: snapshot?.deviceTokenExists ?? null,
    storageDeviceId: storageDeviceId ? storageDeviceId.slice(0, 12) + '…' : null,
    storageDeviceTokenExists: storageDeviceToken != null,
    finalDeviceId: deviceId ? deviceId.slice(0, 12) + '…' : null,
    finalDeviceTokenExists: deviceTokenExists,
    finalIsConnected: isConnected,
    step,
    activeRunCount
  });

  const handleReset = () => {
    setStep('confirm');
  };

  const handleConfirm = () => {
    chrome.runtime.sendMessage({ type: 'RESET_USER_SESSION' }, () => {
      setStep('done');
      setTimeout(() => setStep('idle'), 3000);
    });
  };

  const handleCancel = () => {
    setStep('idle');
  };

  // 페어링 상태 표시
  const pairStatusColor = isConnected ? '#10b981' : '#6b7280';
  const pairStatusText = isConnected ? '연결됨' : '미연결';

  return (
    <section className="panel-card" style={{ border: '1px solid rgba(239,68,68,0.25)', background: 'rgba(239,68,68,0.04)' }}>
      <h2 style={{ color: '#ef4444', marginBottom: '10px' }}>🔄 사용자 리셋</h2>

      {/* 페어링 상태 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '10px 12px', marginBottom: '12px',
        borderRadius: '8px', background: 'rgba(30,41,59,0.6)',
        border: '1px solid rgba(148,163,184,0.12)'
      }}>
        <span style={{
          width: '10px', height: '10px', borderRadius: '50%',
          background: pairStatusColor, flexShrink: 0,
          boxShadow: `0 0 6px ${pairStatusColor}66`
        }} />
        <div>
          <div style={{ fontSize: '13px', fontWeight: 600 }}>연결 상태: {pairStatusText}</div>
          {isConnected && (
            <div style={{ fontSize: '11px', opacity: 0.6, marginTop: '2px' }}>
              Device ID: <code style={{ fontSize: '10px' }}>{deviceId}</code>
              <span style={{ margin: '0 6px' }}>·</span>
              Token: {deviceTokenExists
                ? <span style={{ color: '#10b981' }}>있음</span>
                : <span style={{ color: '#ef4444' }}>없음</span>}
            </div>
          )}
        </div>
      </div>

      {/* 경고 문구 */}
      <div style={{
        padding: '10px 12px', marginBottom: '12px',
        borderRadius: '8px', background: 'rgba(251,191,36,0.08)',
        border: '1px solid rgba(251,191,36,0.2)',
        fontSize: '12px', lineHeight: '1.6', color: '#fbbf24'
      }}>
        <p style={{ margin: '0 0 4px', fontWeight: 600 }}>⚠️ 리셋 전 확인사항</p>
        <ul style={{ margin: '0', paddingLeft: '16px', opacity: 0.85 }}>
          <li>현재 디바이스 연결만 해제됩니다.</li>
          <li>기존 모니터링 데이터는 서버에 유지됩니다.</li>
          <li>다른 사용자로 다시 페어링하려면 리셋 후 웹에서 연결하세요.</li>
        </ul>
      </div>

      {/* 버튼 / 확인 단계 */}
      {step === 'done' ? (
        <div style={{
          padding: '12px', textAlign: 'center',
          background: 'rgba(16,185,129,0.12)',
          borderRadius: '8px', color: '#10b981',
          fontSize: '13px', fontWeight: 700
        }}>
          ✓ 사용자 리셋 완료 — 디바이스 연결이 해제되었습니다
        </div>
      ) : step === 'confirm' ? (
        <div>
          {activeRunCount > 0 && (
            <div style={{
              padding: '10px 12px', marginBottom: '12px',
              borderRadius: '8px', background: 'rgba(239,68,68,0.1)',
              border: '1px solid rgba(239,68,68,0.3)',
              fontSize: '12px', color: '#ef4444', lineHeight: '1.5'
            }}>
              ⚠️ 현재 <strong>{activeRunCount}개의 활성 Run</strong>이 있습니다.
              리셋하면 진행 중인 작업이 중단됩니다.
            </div>
          )}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={handleConfirm}
              style={{
                flex: 1, padding: '10px',
                background: '#ef4444', color: '#fff',
                border: 'none', borderRadius: '8px',
                cursor: 'pointer', fontSize: '13px', fontWeight: 700
              }}
            >
              확인 — 연결 해제
            </button>
            <button
              onClick={handleCancel}
              style={{
                flex: 1, padding: '10px',
                background: 'rgba(255,255,255,0.08)', color: '#e2e8f0',
                border: '1px solid rgba(255,255,255,0.15)', borderRadius: '8px',
                cursor: 'pointer', fontSize: '13px', fontWeight: 600
              }}
            >
              취소
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={handleReset}
          disabled={!isConnected}
          style={{
            width: '100%', padding: '12px',
            background: isConnected ? 'rgba(239,68,68,0.12)' : 'rgba(239,68,68,0.05)',
            color: isConnected ? '#ef4444' : 'rgba(239,68,68,0.4)',
            border: `1px solid ${isConnected ? 'rgba(239,68,68,0.3)' : 'rgba(239,68,68,0.1)'}`,
            borderRadius: '8px',
            cursor: isConnected ? 'pointer' : 'not-allowed',
            fontSize: '13px', fontWeight: 700
          }}
        >
          {isConnected ? '🔄 다른 사용자로 전환 (연결 해제)' : '연결 해제 (이미 미연결 상태)'}
        </button>
      )}
    </section>
  );
}

export function App() {
  const snapshot = useStatusSnapshot();
  const extensionStatus: ExtensionStatus = snapshot?.extensionStatus ?? 'IDLE';
  const backendRunStatus: BackendRunStatus = snapshot?.backendRunStatus ?? (snapshot?.activeRunId ? 'ASSIGNED' : fallbackBackendRunStatus);
  const logs: StructuredLog[] = snapshot?.logs ?? [];
  const deviceId = snapshot?.deviceId ?? null;

  const lastHeartbeatAt = snapshot?.lastHeartbeatAt;
  const activeRunId = snapshot?.activeRunId ?? null;
  const failureCount = snapshot?.failureCount ?? 0;
  const lastError = snapshot?.lastError ?? '없음';
  const approvalRequestedAt = snapshot?.approvalRequestedAt;
  const lastToolResult = snapshot?.lastToolResult;
  const targetTabId = snapshot?.targetTabId ?? '없음';
  const targetUrl = snapshot?.targetUrl ?? '없음';
  const agentTokenLoaded = snapshot?.agentTokenLoaded ? 'yes' : 'no';
  const lastSnapshot = snapshot?.lastSnapshot;
  const lastInstruction = snapshot?.lastInstruction ?? null;
  const isCaptchaWaiting = extensionStatus === 'AWAITING_APPROVAL' && snapshot?.approvalType === 'CAPTCHA';

  const { runs, setRuns, loading, error: runsError, refetch, abortRun } = useDeviceRuns();

  return (
    <main className="app-shell">
      <header className="panel-card panel-card--hero">
        <p className="eyebrow">PBM Agent AI</p>
        <h1>확장프로그램 현황</h1>
      </header>

      {/* 현재 상태 */}
      <section className="panel-card">
        <h2>현재 상태</h2>
        <div className="status-grid">
          <StatusBadge label="Extension" value={getExtensionStatusLabel(extensionStatus)} />
          <StatusBadge label="Backend Run" value={getBackendRunStatusLabel(backendRunStatus)} />
        </div>
        <p className="device-meta">Device ID: {deviceId ?? '미등록'}</p>
        <p className="device-meta">Active Run: {activeRunId ?? '없음'}</p>
        <p className="device-meta">Failure Count: {failureCount}</p>
        <p className="device-meta">Target Tab ID: {targetTabId}</p>
        <p className="device-meta">Target URL: {targetUrl}</p>
        <p className="device-meta">
          Last heartbeat: {lastHeartbeatAt ? new Date(lastHeartbeatAt).toLocaleString() : '없음'}
        </p>
      </section>

      {/* 캡챠 대기 중일 때만 표시 — 수동 재개 버튼 */}
      {isCaptchaWaiting && (
        <section className="panel-card" style={{ border: '1px solid rgba(139,92,246,0.4)', background: 'rgba(139,92,246,0.06)' }}>
          <h2 style={{ color: '#a78bfa', marginBottom: '8px' }}>⚠️ 캡챠 인증 필요</h2>
          <p style={{ fontSize: '12px', opacity: 0.7, margin: '0 0 4px' }}>
            브라우저에서 직접 캡챠를 해결한 뒤 아래 버튼을 눌러주세요.
          </p>
          <CaptchaResolvedButton />
        </section>
      )}

      {/* 현재 처리 중인 지시 */}
      <section className="panel-card">
        <h2 style={{ marginBottom: '10px' }}>현재 처리 중</h2>
        <InstructionCard instruction={lastInstruction} />
      </section>

      {/* Run 현황 */}
      <section className="panel-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <h2 style={{ margin: 0 }}>Run 현황</h2>
          <button
            onClick={refetch}
            disabled={loading}
            style={{
              fontSize: '11px',
              padding: '3px 10px',
              background: 'rgba(255,255,255,0.07)',
              color: 'rgba(255,255,255,0.6)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: '4px',
              cursor: loading ? 'default' : 'pointer'
            }}
          >
            {loading ? '조회 중…' : '새로고침'}
          </button>
        </div>

        {runsError && (
          <p style={{ color: '#ef4444', fontSize: '12px', marginBottom: '8px' }}>오류: {runsError}</p>
        )}

        {runs.length === 0 && !loading ? (
          <p style={{ opacity: 0.4, fontSize: '13px', textAlign: 'center', padding: '16px 0' }}>
            활성 Run이 없습니다
          </p>
        ) : (
          <ul style={{ padding: 0, margin: 0 }}>
            {runs.map((run) => (
              <RunCard
                key={run.runId}
                run={run}
                isActive={run.runId === activeRunId}
                onAbort={abortRun}
              />
            ))}
          </ul>
        )}

        <ResetRunStateButton onDone={refetch} />
      </section>

      {/* 사용자 리셋 — 디바이스 연결 해제 + 세션 초기화 */}
      <UserResetSection
        snapshot={snapshot}
        activeRunCount={runs.length}
      />

      {/* 최근 로그 */}
      <section className="panel-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <h2 style={{ margin: 0 }}>최근 로그</h2>
          <button
            onClick={() => chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' })}
            style={{
              fontSize: '11px',
              padding: '3px 10px',
              background: 'rgba(255,255,255,0.07)',
              color: 'rgba(255,255,255,0.6)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            🗑️ 로그 지우기
          </button>
        </div>
        <ul className="log-list" style={{ marginTop: 0 }}>
          {logs.length === 0 ? (
            <li className="log-item">
              <div className="log-item__meta">
                <span>EMPTY</span>
                <time>-</time>
              </div>
              <p>아직 수집된 로그가 없어.</p>
            </li>
          ) : (
            logs.filter(log => 
              log.status !== 'HEARTBEAT_OK' && 
              log.status !== 'HEARTBEAT_SKIPPED' && 
              log.status !== 'TAB_INVALID'
            ).map((log) => (
              <li key={`${log.status}-${log.at}`} className="log-item">
                <div className="log-item__meta">
                  <span>{log.status}</span>
                  <time>{new Date(log.at).toLocaleTimeString()}</time>
                </div>
                <p>{log.message}</p>
              </li>
            ))
          )}
        </ul>
      </section>
    </main>
  );
}
