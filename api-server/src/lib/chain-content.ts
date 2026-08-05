/**
 * Chain Content — 체인 해시가 덮는 범위 (v3)
 *
 * ## 왜 이 파일이 생겼나 (2026-08-05)
 *
 * v2까지 체인 해시가 덮는 필드는 **3개뿐**이었다:
 *   computeChainHash({ type, action_type, actor_id }, previousHash, timestamp)
 *
 * 즉 `action_output`(산출물), `ai_reasoning`(AI가 왜 그렇게 판단했는지),
 * `approval_result`(누가 승인했는지), `evidence_level`이 **체인 밖**에 있었다.
 * 해시 재계산 검증을 붙여도 이 값들을 통째로 바꾼 뒤 통과시킬 수 있다는 뜻이고,
 * 감사에서 문제되는 값이 정확히 그 바깥에 있었다.
 *
 * v3은 레코드의 모든 실질 필드를 덮는다. 큰 JSON 블롭(action_input/output 등)은
 * **저장된 문자열 그대로**를 SHA-256 해서 넣는다 — 값을 다시 직렬화하지 않으므로
 * 기록 시점과 검증 시점의 입력이 바이트 단위로 같음이 보장된다.
 *
 * ## 대칭성 규칙 (이 파일의 존재 이유)
 *
 * 기록 경로와 검증 경로가 **같은 함수**를 통과해야 한다.
 * 기록할 때 컬럼값 객체를 먼저 만들고 → 그 객체로 해시를 계산하고 → 그 객체를 INSERT 한다.
 * 검증할 때는 DB 행을 같은 함수에 넣는다. 두 입력이 같은 모양이므로 드리프트가 생길 수 없다.
 *
 * 🔴 이 파일의 필드 목록을 바꾸면 기존 행의 해시가 전부 무효가 된다.
 *    바꿔야 한다면 버전을 올리고(v4) 기존 버전 빌더를 남겨라. 조용히 고치지 말 것.
 */

import { computeContentHash } from '@cronozen/dpu-core';

/** 현재 기록에 쓰는 체인 페이로드 버전. 새 행은 전부 이 값으로 저장된다. */
export const CHAIN_PAYLOAD_VERSION = 3;

/**
 * decision_events 테이블의 컬럼값 — 기록/검증 양쪽이 공유하는 단일 모양.
 *
 * 컬럼명과 1:1로 대응한다(snake_case 유지). 매핑 계층을 두지 않는 것이 의도다 —
 * 계층이 하나 생기면 거기서 기록/검증이 갈라진다.
 */
export interface ChainColumns {
  decision_id: string;
  evidence_id: string | null;
  tenant_id: string;
  chain_domain: string;
  chain_index: number;

  type: string;
  source_type: string;

  actor_id: string;
  actor_type: string;
  actor_name: string | null;
  actor_metadata: string | null;

  action_type: string;
  action_description: string | null;
  action_input: string | null;
  action_output: string | null;
  action_metadata: string | null;

  ai_model: string | null;
  ai_provider: string | null;
  ai_confidence: number | null;
  ai_prompt_hash: string | null;
  ai_reasoning: string | null;
  ai_tokens_input: number | null;
  ai_tokens_output: number | null;
  ai_metadata: string | null;

  occurred_at: string;
  tags: string | null;
  metadata: string | null;
}

/** 저장된 문자열을 그대로 해시한다. null은 null로 유지 — 빈 문자열과 구분되어야 한다. */
function sha256OrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return computeContentHash(value);
}

/**
 * v3 체인 콘텐츠 — 해시에 들어가는 실제 페이로드.
 *
 * 값이 없으면 반드시 `null`을 넣는다. `undefined`는 JSON.stringify에서 키째 사라지므로
 * 같은 레코드가 두 개의 다른 해시를 만들 수 있다.
 */
export function buildChainContentV3(cols: ChainColumns): Record<string, unknown> {
  return {
    v: CHAIN_PAYLOAD_VERSION,

    decisionId: cols.decision_id,
    evidenceId: cols.evidence_id ?? null,
    tenantId: cols.tenant_id,
    chainDomain: cols.chain_domain,
    chainIndex: cols.chain_index,

    type: cols.type,
    sourceType: cols.source_type,

    actorId: cols.actor_id,
    actorType: cols.actor_type,
    actorName: cols.actor_name ?? null,
    actorMetadataSha256: sha256OrNull(cols.actor_metadata),

    actionType: cols.action_type,
    actionDescription: cols.action_description ?? null,
    actionInputSha256: sha256OrNull(cols.action_input),
    actionOutputSha256: sha256OrNull(cols.action_output),
    actionMetadataSha256: sha256OrNull(cols.action_metadata),

    aiModel: cols.ai_model ?? null,
    aiProvider: cols.ai_provider ?? null,
    aiConfidence: cols.ai_confidence ?? null,
    aiPromptHash: cols.ai_prompt_hash ?? null,
    aiReasoningSha256: sha256OrNull(cols.ai_reasoning),
    aiTokensInput: cols.ai_tokens_input ?? null,
    aiTokensOutput: cols.ai_tokens_output ?? null,
    aiMetadataSha256: sha256OrNull(cols.ai_metadata),

    occurredAt: cols.occurred_at,
    tagsSha256: sha256OrNull(cols.tags),
    metadataSha256: sha256OrNull(cols.metadata),
  };
}

/**
 * v2 레거시 콘텐츠 — 2026-08-05 이전에 기록된 행을 검증하기 위해서만 존재한다.
 *
 * 이 버전이 덮는 범위가 3개 필드뿐이라는 것이 v3을 만든 이유다.
 * 새 기록에 쓰지 말 것.
 *
 * @deprecated 검증 전용
 */
export function buildChainContentV2(
  cols: Pick<ChainColumns, 'type' | 'action_type' | 'actor_id'>,
  fileHash?: string | null,
): Record<string, unknown> {
  const content: Record<string, unknown> = {
    type: cols.type,
    action_type: cols.action_type,
    actor_id: cols.actor_id,
  };
  // file_change 이벤트는 file_hash를 추가로 넣었다 (routes/files.ts, services/google-drive.ts)
  if (fileHash) content.file_hash = fileHash;
  return content;
}

/**
 * 봉인(승인) 내용의 해시.
 *
 * 승인은 레코드 생성 **이후**에 일어나므로 chain_hash가 덮을 수 없다.
 * 그래서 chain_hash를 입력으로 받아 승인 필드와 함께 묶는다 —
 * 이 값이 있어야 "누가 승인했는지"가 위조 불가능해진다.
 */
export function buildSealContent(input: {
  chain_hash: string;
  decision_id: string;
  evidence_id: string | null;
  status: string;
  evidence_level: string | null;
  approver_id: string | null;
  approver_type: string | null;
  approver_name: string | null;
  approval_result: string | null;
  approval_reason: string | null;
  approved_at: string | null;
  sealed_at: string | null;
}): Record<string, unknown> {
  return {
    v: CHAIN_PAYLOAD_VERSION,
    chainHash: input.chain_hash,
    decisionId: input.decision_id,
    evidenceId: input.evidence_id ?? null,
    status: input.status,
    evidenceLevel: input.evidence_level ?? null,
    approverId: input.approver_id ?? null,
    approverType: input.approver_type ?? null,
    approverName: input.approver_name ?? null,
    approvalResult: input.approval_result ?? null,
    approvalReasonSha256: sha256OrNull(input.approval_reason),
    approvedAt: input.approved_at ?? null,
    sealedAt: input.sealed_at ?? null,
  };
}
