// ─── Enums ───────────────────────────────────────────────────────────────────
// DecisionEventType, EventSourceType SSOT: @cronozen/dp-schema-public
// SDK는 string union으로 재정의하여 dp-schema-public 의존 없이도 사용 가능

export type DecisionEventType =
  // AI-originated
  | 'agent_execution'
  | 'workflow_step'
  | 'human_approval'
  | 'ai_recommendation'
  | 'automated_action'
  | 'policy_decision'
  | 'escalation'
  // Harness-originated
  | 'file_change'
  | 'approval'
  | 'access'
  | 'import'
  | 'export'
  | 'integration'
  // Universal
  | 'system'
  | 'custom';

export type EventSourceType = 'ai' | 'harness' | 'manual' | 'system';

export type DecisionEventStatus =
  | 'recorded'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'sealed';

export type EvidenceStatus = 'pending' | 'sealed' | 'verified';

export type ApprovalResult = 'approved' | 'rejected';

export type ActorType = 'human' | 'ai_agent' | 'system' | 'service';

export type ApproverType = 'human' | 'system';

// ─── Core Objects ────────────────────────────────────────────────────────────

export interface DecisionActor {
  id: string;
  type: ActorType;
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface DecisionAction {
  type: string;
  description?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface AIContext {
  model?: string;
  provider?: string;
  confidence?: number;
  promptHash?: string;
  reasoning?: string;
  tokens?: { input?: number; output?: number };
  metadata?: Record<string, unknown>;
}

export interface ApprovalActor {
  id: string;
  type: ApproverType;
  name?: string;
}

// ─── Request Types ───────────────────────────────────────────────────────────

export interface RecordDecisionRequest {
  type: DecisionEventType;
  sourceType?: EventSourceType;
  actor: DecisionActor;
  action: DecisionAction;
  occurredAt?: string;
  aiContext?: AIContext;
  metadata?: Record<string, unknown>;
  tags?: string[];
  idempotencyKey?: string;
}

export interface ApproveDecisionRequest {
  approver: ApprovalActor;
  result: ApprovalResult;
  reason?: string;
  approvedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface ListDecisionOptions {
  limit?: number;
  offset?: number;
  type?: DecisionEventType;
  status?: DecisionEventStatus;
  tag?: string;
}

// ─── Response Types ──────────────────────────────────────────────────────────

export interface DecisionEventResponse {
  id: string;
  decisionId: string;
  type: DecisionEventType;
  sourceType?: EventSourceType;
  status: DecisionEventStatus;
  actor: DecisionActor;
  action: DecisionAction;
  occurredAt: string;
  aiContext?: AIContext;
  metadata?: Record<string, unknown>;
  tags: string[];
  evidence?: {
    id: string;
    status: EvidenceStatus;
    chainHash?: string;
    chainIndex?: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface DecisionEventListResponse {
  data: DecisionEventResponse[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

export interface ApprovalResponse {
  approvalId: string;
  decisionId: string;
  approver: ApprovalActor;
  result: ApprovalResult;
  reason?: string;
  evidenceLevel: string;
  sealedHash?: string;
  sealedAt?: string;
  createdAt: string;
}

export interface EvidenceResponse {
  id: string;
  decisionId: string;
  status: EvidenceStatus;
  evidenceLevel: string;
  event: {
    type: DecisionEventType;
    actor: DecisionActor;
    action: DecisionAction;
    occurredAt: string;
    aiContext?: AIContext;
  };
  approval?: {
    approver: ApprovalActor;
    result: ApprovalResult;
    reason?: string;
    approvedAt: string;
  };
  chain: {
    hash: string;
    index: number;
    previousHash: string | null;
    domain: string;
  };
  sealedAt?: string;
  createdAt: string;
}

export interface EvidenceExportResponse {
  '@context': string;
  '@type': string;
  version: string;
  exportedAt: string;
  evidence: EvidenceResponse;
  verification: {
    hashAlgorithm: string;
    chainDomain: string;
    chainIndex: number;
    chainHash: string;
    previousHash: string | null;
    verifyUrl: string;
  };
}

// ─── Verification ────────────────────────────────────────────────────────────

export type SignatureStatus =
  | 'valid'
  | 'invalid'
  | 'missing'
  | 'not_configured'
  | 'not_applicable';

export interface VerificationCheck {
  ok: boolean;
  detail?: string;
}

/**
 * 공개 검증 응답.
 *
 * 응답 필드는 서버의 공개 화이트리스트를 따른다 — 도메인·행위 내용·행위자는 들어 있지 않다.
 * 검증자에게 필요한 건 "이 해시가 맞느냐"이지 "무슨 일이 있었느냐"가 아니기 때문이다.
 */
export interface VerificationResponse {
  verified: boolean;
  checks: {
    /**
     * 해시 재계산 결과.
     *
     * 🔴 `contentBound: false`(레거시 v2 레코드)면 `verified: true`라도 해시가
     *    이벤트 타입·액션 타입·행위자 3개만 덮는다. 산출물·AI 근거·승인 결과는
     *    결속되어 있지 않다. 감사 용도로 쓰기 전에 이 값을 반드시 확인할 것.
     */
    chainHash: VerificationCheck & {
      /** 저장된 라벨이 아니라 **실제로 일치한** 계산 스킴. */
      matchedScheme: 'v2' | 'v3' | null;
      contentBound: boolean | null;
    };
    chainLink: VerificationCheck;
    seal: VerificationCheck;
    serverSignature: { status: SignatureStatus; keyId?: string; alg?: string; detail?: string };
    trustedTimestamp: { status: 'not_implemented'; detail: string };
  };
  failures: string[];
  evidence: {
    id: string;
    evidenceLevel: string | null;
    hashAlgorithm: string;
    chainPayloadVersion: number;
    chain: { hash: string | null; index: number; previousHash: string | null };
    sealHash: string | null;
    sealedAt: string | null;
  };
  coverage: {
    totalEvents: number;
    verifiedEvents: number;
    truncated?: boolean;
    scanned?: number;
    note?: string;
  };
  /** 이 검증이 증명하지 **못하는** 범위. 과신을 막기 위해 서버가 함께 내보낸다. */
  limitations: string[];
}

export interface ChainVerificationOptions {
  fromIndex?: number;
  toIndex?: number;
  limit?: number;
}

export interface ChainVerificationResponse {
  domain: string;
  verified: boolean;
  totalEvents: number;
  scanned: number;
  verifiedEvents: number;
  /** 처음으로 깨진 체인 인덱스. 전부 정상이면 null. */
  firstBrokenIndex: number | null;
  /** 통째로 사라진 레코드의 인덱스 목록. */
  missingIndexes: number[];
  records: {
    chainIndex: number;
    evidenceId: string | null;
    verified: boolean;
    failures: string[];
  }[];
  truncated: boolean;
}

export interface PublicKeyResponse {
  status: 'active' | 'not_configured';
  keyId?: string;
  alg?: string;
  publicKeyPem?: string;
  detail?: string;
}

// ─── Error Types ─────────────────────────────────────────────────────────────

export interface ProofAPIErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

// ─── Client Config ───────────────────────────────────────────────────────────

export interface CronozenConfig {
  apiKey: string;
  baseUrl: string;
  /** Custom fetch implementation (defaults to global fetch) */
  fetch?: typeof globalThis.fetch;
  /** Request timeout in milliseconds (default: 10000) */
  timeout?: number;
}
