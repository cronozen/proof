/**
 * 🔍 Verification Engine
 *
 * ## 왜 이 파일이 생겼나 (2026-08-05)
 *
 * `/verify/:id`는 다음 한 줄이 전부였다:
 *
 *   verified: !!row.sealed_at
 *
 * 봉인 시각 컬럼이 비었는지만 봤다. 해시를 다시 계산하지 않았고, previous_hash 연결도
 * 확인하지 않았다. DB에서 chain_hash를 아무 값으로 바꿔놔도 `verified: true`가 나왔다.
 * "부인할 수 없게 기록한다"고 적어둔 채 기록만 하고 부인 가능했던 셈이다.
 *
 * ## 이 엔진이 실제로 확인하는 것
 *
 *   ① chainHash  — 저장된 레코드로 해시를 **다시 계산**해서 대조 (내용 변조 탐지)
 *   ② chainLink  — previous_hash가 실제 앞 레코드의 chain_hash와 같은지 + 인덱스 연속성 (행 삭제·삽입 탐지)
 *   ③ seal       — 승인 내용(누가·언제·결과)이 봉인 해시와 맞는지 (승인 위조 탐지)
 *   ④ signature  — 서버 Ed25519 서명 (DB 쓰기 권한만으로는 위조 불가)
 *
 * ## 아직 하지 않는 것 — 적어둔다
 *
 *   ⑤ trustedTimestamp (RFC 3161) — **미구현**. naive 구현(요청만 보내고 TSA 인증서·서명체인·
 *      nonce를 검증하지 않는 것)은 false-assurance라 이 조직에서 이미 금지 판정했다.
 *      그러므로 여기서는 구현한 척하지 않고 `not_implemented`를 응답에 명시한다.
 *   ⑥ externalAnchor — 우리 DB를 우리가 읽고 "맞다"고 답하는 한 제3자 검증은 성립하지 않는다.
 *      ①~④는 "우리가 준 데이터가 우리 기록과 일치한다"까지를 증명한다. 그 이상은 앵커가 필요하다.
 *      이 한계를 응답의 `limitations`에 적어 내보낸다 — 검증자가 과신하지 않도록.
 */

import type { Database } from 'better-sqlite3';
import {
  computeChainHash,
  computeObjectHash,
  evaluateVerification,
  type ChainHashCandidate,
  type ChainHashVerdict,
  type Check,
  type LinkState,
} from '@cronozen/dpu-core';
import {
  CHAIN_PAYLOAD_VERSION,
  buildChainContentV2,
  buildChainContentV3,
  buildSealContent,
  type ChainColumns,
} from './chain-content.js';
import { verifyRecordSignature, type SignatureCheck } from './signing.js';

/** Coverage 계산 시 한 번에 훑을 최대 레코드 수. 넘으면 truncated를 응답에 표시한다(조용히 자르지 않는다). */
export const COVERAGE_SCAN_LIMIT = 1000;

export interface DecisionEventRow extends ChainColumns {
  id: string;
  status: string;
  evidence_level: string | null;
  chain_hash: string | null;
  previous_hash: string | null;
  chain_payload_version: number | null;
  seal_hash: string | null;
  signature: string | null;
  signature_alg: string | null;
  signature_key_id: string | null;
  approver_id: string | null;
  approver_type: string | null;
  approver_name: string | null;
  approval_result: string | null;
  approval_reason: string | null;
  approved_at: string | null;
  sealed_at: string | null;
  created_at: string;
  seals_decision_id: string | null;
}

export type { Check };

export type ChainScheme = 'v2' | 'v3';

/**
 * 승인이 무엇에 결속돼 있는가.
 *   'chain' — 체인 안의 봉인 레코드 (앵커가 덮는다·롤백이 잡힌다)
 *   'row'   — 행의 seal_hash 뿐 (체인 밖이라 앵커가 못 덮는다)
 *   'none'  — 미봉인이거나 결속 없음
 */
export type SealBinding = 'chain' | 'row' | 'none';

/**
 * 해시 검사 결과.
 *
 * 🔑 **라벨이 아니라 실제로 맞은 계산이 진실이다.** (thearound-ops 가 2026-07-31 codex
 *    독립검증에서 얻은 규칙 — 저장된 버전 라벨만 보고 "내용까지 결속됨"이라 보고했다가
 *    거짓 통과를 냈다. 검증이 없는 것보다 나쁜 상태다.)
 *    그래서 `matchedScheme`은 저장된 `chain_payload_version`이 아니라 **실제로 일치한 빌더**다.
 */
export type ChainHashCheck = ChainHashVerdict;

export interface VerificationResult {
  verified: boolean;
  checks: {
    chainHash: ChainHashCheck;
    /**
     * 해시가 **내용까지 덮는가** — chainHash 와 별개의 사실이다.
     * 둘을 한 칸에 뭉치면, 실패 사유가 어느 검사에도 안 붙어
     * `verified:false` 인데 checks 는 전부 초록인 응답이 나온다.
     */
    contentCoverage: Check & { contentBound: boolean | null; legacyAccepted: boolean };
    chainLink: Check;
    seal: Check & { binding: SealBinding };
    serverSignature: SignatureCheck;
    trustedTimestamp: { status: 'not_implemented'; detail: string };
  };
  chainPayloadVersion: number;
  /** 판정 실패 사유. verified=true면 빈 배열. */
  failures: string[];
}

/**
 * 이 행이 **구 google-drive 동기화 경로**로 기록됐는가.
 *
 * 그 경로에만 두 개의 기록 결함이 있었고(아래), 폴백은 여기에만 적용한다.
 * v2 행 전체에 폴백을 열면 폴백 자체가 변조 통로가 된다 —
 * 예컨대 타임스탬프 폴백을 모든 v2 행에 열면, occurred_at 을 마음대로 바꿔도
 * created_at 후보가 맞아버려 통과한다. 좁히는 것이 곧 조이는 것이다.
 */
function isLegacyDriveRow(row: DecisionEventRow): boolean {
  return (row.chain_payload_version ?? 2) < 3
    && row.type === 'file_change'
    && row.source_type === 'harness';
}

/**
 * 구 google-drive 경로의 기록 결함 2종 — 폴백으로 구제한다.
 *
 * 🔴 결함 A (타임스탬프): 해시는 `now` 로 계산하면서 occurred_at 에는
 *    `file.modifiedTime` 을 저장했다. 두 값이 다르면 재계산이 불가능하다.
 *    당시의 `now` 는 created_at 에 남아 있으므로 그것도 시도한다.
 *
 * 🔴 결함 B (행위자): 해시에는 `actor_id: tenantId` 를 넣고, 저장은
 *    `actor_id = lastModifyingUser.emailAddress || tenantId` 로 했다.
 *    수정자 이메일이 있는 행은 저장값으로 재계산하면 **반드시 어긋난다.**
 *    변조가 아닌데 변조로 보고하게 되므로 tenant_id 도 후보로 넣는다.
 *
 * 둘 다 "검증을 느슨하게" 하는 게 아니라 **기록 당시 실제로 쓰인 입력**을 찾는 것이다.
 * 그래서 신규(v3) 행에는 절대 적용되지 않는다.
 */
function legacyDriveVariants(row: DecisionEventRow): { timestamp: string; actorId: string }[] {
  const timestamps = [row.occurred_at];
  if (row.created_at && row.created_at !== row.occurred_at) timestamps.push(row.created_at);

  const actorIds = [row.actor_id];
  if (row.tenant_id && row.tenant_id !== row.actor_id) actorIds.push(row.tenant_id);

  const variants: { timestamp: string; actorId: string }[] = [];
  for (const timestamp of timestamps) {
    for (const actorId of actorIds) variants.push({ timestamp, actorId });
  }
  return variants;
}

// ─── 개별 검사 ──────────────────────────────────────────────────────
//
// 🔑 재계산·DB 조회는 여기서 하고, **판정은 @cronozen/dpu-core 에 위임한다.**
//    "무엇을 통과로 볼 것인가"가 검증기마다 갈리면 같은 레코드에 상반된 판정이 나오고,
//    그 불일치 자체가 감사에서 반대증거가 된다(ops F10). 판정 정본은 하나여야 한다.

/**
 * 이 행이 기록될 때 쓰였을 수 있는 해시 후보들.
 *
 * `contentBound` 는 **이 계산이 레코드 내용을 덮는지**를 우리가 선언하는 값이다.
 * v3 는 레코드 전체를 덮고, v2 는 type·action_type·actor_id 3개뿐이다.
 * 엔진은 이 값을 해석하지 않고, 실제로 일치한 후보의 값을 그대로 보고한다.
 */
function buildHashCandidates(db: Database, row: DecisionEventRow): ChainHashCandidate[] {
  const version = row.chain_payload_version ?? 2;

  if (version >= 3) {
    return [{
      scheme: 'proof.v3',
      hash: computeChainHash(buildChainContentV3(row), row.previous_hash ?? null, row.occurred_at),
      contentBound: true,
    }];
  }

  // ── v2 레거시 ──
  let fileHash: string | null = null;
  if (row.type === 'file_change') {
    const file = db
      .prepare('SELECT file_hash FROM proof_files WHERE decision_event_id = ? ORDER BY created_at ASC LIMIT 1')
      .get(row.id) as { file_hash: string } | undefined;
    fileHash = file?.file_hash ?? null;
  }

  // 구 drive 경로가 아니면 폴백 없이 저장된 값 그대로 한 번만 계산한다.
  if (!isLegacyDriveRow(row)) {
    return [{
      scheme: 'proof.v2',
      hash: computeChainHash(buildChainContentV2(row, fileHash), row.previous_hash ?? null, row.occurred_at),
      contentBound: false,
    }];
  }

  return legacyDriveVariants(row).map(({ timestamp, actorId }) => ({
    scheme: 'proof.v2-drive',
    hash: computeChainHash(
      buildChainContentV2({ ...row, actor_id: actorId }, fileHash),
      row.previous_hash ?? null,
      timestamp,
    ),
    contentBound: false,
  }));
}

/**
 * 선행·후행 링크 상태를 DB 에서 읽어 3상태로 만든다.
 *
 * `null` = 대상 레코드가 없음(체인의 시작/끝) → 통과.
 * `false` = 대상이 있는데 어긋남, 또는 있어야 할 선행이 없음 → 실패.
 * 없는 것과 어긋난 것을 같게 취급하면 둘 다 놓친다.
 */
function readLinkState(db: Database, row: DecisionEventRow): {
  previousLinkValid: LinkState;
  nextLinkValid: LinkState;
  previousMissing: boolean;
} {
  const index = row.chain_index;

  let previousLinkValid: LinkState = null;
  let previousMissing = false;

  if (index > 0) {
    const previous = db
      .prepare(
        'SELECT chain_hash FROM decision_events WHERE chain_domain = ? AND tenant_id = ? AND chain_index = ?',
      )
      .get(row.chain_domain, row.tenant_id, index - 1) as { chain_hash: string | null } | undefined;

    if (!previous) {
      previousLinkValid = false;
      previousMissing = true;
    } else {
      previousLinkValid = !!row.previous_hash && previous.chain_hash === row.previous_hash;
    }
  }

  const next = db
    .prepare(
      'SELECT previous_hash FROM decision_events WHERE chain_domain = ? AND tenant_id = ? AND chain_index = ?',
    )
    .get(row.chain_domain, row.tenant_id, index + 1) as { previous_hash: string | null } | undefined;

  const nextLinkValid: LinkState = next ? next.previous_hash === row.chain_hash : null;

  return { previousLinkValid, nextLinkValid, previousMissing };
}

/**
 * 봉인(승인) 검사.
 *
 * 승인은 레코드 생성 이후에 일어나므로 chain_hash가 덮지 못한다.
 * seal_hash가 그 공백을 메운다 — 없으면 승인자·승인결과를 자유롭게 바꿀 수 있다.
 */
function checkSeal(db: Database, row: DecisionEventRow): Check & { binding: SealBinding } {
  const isSealed = !!row.sealed_at || !!row.approval_result;

  /**
   * 🔑 체인에서 봉인 레코드를 **직접 찾는다.** 행의 버전 라벨을 보고 "찾을지 말지"를
   *    결정하지 않는다 — 그러면 그 라벨이 또 하나의 다운그레이드 레버가 된다.
   *    봉인 레코드는 체인 안에 있으므로, 지우면 링크 검사가 구멍을 잡는다.
   */
  //    🔴 조회를 인덱스 컬럼에만 걸면 그 컬럼을 바꾸는 것만으로 봉인이 "없는" 것이 된다.
  //       권위 필드(해시된 action_output.targetDecisionId)로도 찾아야 한다 —
  //       그걸 바꾸면 봉인 레코드 자체의 해시가 깨져 다른 검사가 잡는다.
  //       (2026-08-06 하네스의 seal-record-retarget 이 이 구멍을 잡았다.)
  const sealRecord = db
    .prepare(
      `SELECT * FROM decision_events
       WHERE chain_domain = ? AND tenant_id = ? AND type = 'seal'
         AND (seals_decision_id = ? OR action_output LIKE ?)
       ORDER BY chain_index ASC LIMIT 1`,
    )
    .get(
      row.chain_domain,
      row.tenant_id,
      row.decision_id,
      `%"targetDecisionId":"${row.decision_id}"%`,
    ) as DecisionEventRow | undefined;

  // ── 봉인 레코드가 체인에 있다 = 이 결정은 승인된 적이 있다 ──
  if (sealRecord) {
    let claim: Record<string, unknown>;
    try {
      claim = JSON.parse(sealRecord.action_output ?? '{}');
    } catch {
      return { ok: false, binding: 'chain', detail: 'Seal record payload is not readable.' };
    }

    // 봉인 레코드의 권위는 해시된 action_output 이다. 조회용 컬럼과 어긋나면 컬럼이 조작된 것.
    if (claim.targetDecisionId !== row.decision_id) {
      return {
        ok: false,
        binding: 'chain',
        detail: 'Seal record found for this decision does not name it as its target.',
      };
    }

    // 조회용 컬럼이 권위 필드와 어긋나면 컬럼이 조작된 것이다.
    if (sealRecord.seals_decision_id !== row.decision_id) {
      return {
        ok: false,
        binding: 'chain',
        detail: 'Seal record lookup column was altered to point elsewhere.',
      };
    }

    // 🔴 롤백 탐지: 체인에 봉인이 있는데 결정 행은 승인이 없다고 말한다.
    if (!isSealed) {
      return {
        ok: false,
        binding: 'chain',
        detail:
          'The chain contains a seal for this decision, but the record shows no approval — '
          + 'the approval was rolled back after it was sealed.',
      };
    }

    const mismatches: string[] = [];
    const cmp = (field: string, rowValue: unknown, claimValue: unknown) => {
      if ((rowValue ?? null) !== (claimValue ?? null)) mismatches.push(field);
    };
    cmp('approvalResult', row.approval_result, claim.result);
    cmp('evidenceLevel', row.evidence_level, claim.evidenceLevel);
    cmp('status', row.status, claim.status);
    cmp('approverId', row.approver_id, claim.approverId);
    cmp('approverName', row.approver_name, claim.approverName);
    cmp('approvedAt', row.approved_at, claim.approvedAt);
    cmp('sealedAt', row.sealed_at, claim.sealedAt);
    cmp('sealHash', row.seal_hash, claim.sealHash);

    if (mismatches.length > 0) {
      return {
        ok: false,
        binding: 'chain',
        detail: `Approval fields disagree with the seal recorded in the chain (${mismatches.join(', ')}).`,
      };
    }

    return { ok: true, binding: 'chain' };
  }

  // ── 봉인 레코드가 없다 ──
  if (!isSealed) {
    if (row.seal_hash) {
      return { ok: false, binding: 'none', detail: 'Record carries a seal hash but has no approval — seal was stripped.' };
    }

    // 봉인 전 불변식 — 해시로 못 덮는 값은 여기서 막는다.
    const violations: string[] = [];
    if (row.status !== 'recorded') violations.push(`status=${row.status}`);
    if (row.evidence_level && row.evidence_level !== 'DRAFT') violations.push(`evidenceLevel=${row.evidence_level}`);
    if (row.approver_id) violations.push('approverId');
    if (row.approver_type) violations.push('approverType');
    if (row.approver_name) violations.push('approverName');
    if (row.approval_reason) violations.push('approvalReason');
    if (row.approved_at) violations.push('approvedAt');

    if (violations.length > 0) {
      return {
        ok: false,
        binding: 'none',
        detail: `Record is not sealed but carries approval state (${violations.join(', ')}) — approval was forged without a seal.`,
      };
    }

    return { ok: true, binding: 'none', detail: 'Not sealed yet (pending approval).' };
  }

  // 승인은 있는데 체인에 봉인 레코드가 없다 = 이 결합 방식 도입 이전에 봉인된 행.
  // 🔴 여기서 "레거시니까 통과"로 끝내면 안 된다 — 결속 강도가 다르다는 걸 응답에 실어야 한다.
  const version = row.chain_payload_version ?? 2;
  if (!row.seal_hash) {
    if (version < 3) {
      return {
        ok: true,
        binding: 'none',
        detail: 'Sealed before seal hashing existed — approval fields are not cryptographically bound.',
      };
    }
    return { ok: false, binding: 'none', detail: 'Record is sealed but carries no seal hash.' };
  }

  const recomputed = computeObjectHash(
    buildSealContent({
      chain_hash: row.chain_hash ?? '',
      decision_id: row.decision_id,
      evidence_id: row.evidence_id,
      status: row.status,
      evidence_level: row.evidence_level,
      approver_id: row.approver_id,
      approver_type: row.approver_type,
      approver_name: row.approver_name,
      approval_result: row.approval_result,
      approval_reason: row.approval_reason,
      approved_at: row.approved_at,
      sealed_at: row.sealed_at,
    }),
  );

  if (recomputed !== row.seal_hash) {
    return {
      ok: false,
      binding: 'row',
      detail: 'Recomputed seal hash does not match — approval details were altered after sealing.',
    };
  }

  return {
    ok: true,
    binding: 'row',
    detail: 'Approval is bound by a row-level seal hash only — it is not part of the chain, so an external anchor does not cover it.',
  };
}

// ─── 공개 진입점 ────────────────────────────────────────────────────

export function verifyRecord(db: Database, row: DecisionEventRow): VerificationResult {
  const version = row.chain_payload_version ?? 2;

  // 🔑 해시·링크 판정은 dpu-core 의 단일 엔진에 위임한다.
  //    여기서 하는 일은 후보를 만들고 링크 상태를 읽어오는 것까지다.
  const link = readLinkState(db, row);
  const core = evaluateVerification({
    storedChainHash: row.chain_hash,
    candidates: buildHashCandidates(db, row),
    chainIndex: row.chain_index,
    previousHash: row.previous_hash,
    previousLinkValid: link.previousLinkValid,
    nextLinkValid: link.nextLinkValid,
    previousMissing: link.previousMissing,
  });

  const chainHash: ChainHashCheck = core.chainHash;
  const chainLink: Check = core.chainLink;

  // 봉인·서명은 호출자마다 모델이 달라 엔진에 올리지 않았다(ops 에는 seal_hash 개념이 없다).
  const seal = checkSeal(db, row);
  const serverSignature = verifyRecordSignature({
    chainHash: row.chain_hash ?? '',
    sealHash: row.seal_hash,
    signature: row.signature,
    signatureAlg: row.signature_alg,
    signatureKeyId: row.signature_key_id,
    applicable: version >= CHAIN_PAYLOAD_VERSION,
  });

  // 해시·링크 실패 사유는 엔진이 만든 것을 그대로 쓴다 — 여기서 다시 쓰면 문구가 갈리고,
  // 갈린 문구는 "같은 결함인데 검증기마다 다르게 말하는" 상태가 된다.
  const failures: string[] = [...core.failures];
  if (!seal.ok) failures.push(`seal: ${seal.detail}`);

  // 🔴 다운그레이드 봉쇄 — 이 조직에서 가장 비싼 종류의 결함이었다.
  //
  // `chain_payload_version` 은 **공격자가 쓸 수 있는 DB 컬럼**인데, 그 값 하나가
  // 세 보호를 동시에 껐다: 내용 결속(v2 는 3필드만) · 봉인 검사(v<3 면 seal 없어도 통과)
  // · 서명 요구(applicable = v>=3). 그래서 v3 레코드를 v2 로 내리고 3필드 해시를 다시
  // 계산하면 산출물을 마음대로 바꾸고도 verified:true 가 나왔다.
  // (2026-08-05 fable·codex 가 독립적으로 같은 지점을 짚었고 실제 공격으로 재현됨)
  //
  // 뿌리는 "라벨이 판정 기준을 고른다"는 것이다. 라벨을 못 믿으므로 **결과**로 판정한다:
  // 실제로 일치한 계산이 레코드 내용을 덮지 못했다면 통과시키지 않는다.
  // 다운그레이드하면 contentBound 가 false 가 되므로 이 게이트에서 걸린다.
  //
  // 진짜 레거시 행은 이 게이트에서 함께 떨어진다. 그건 부작용이 아니라 정직함이다 —
  // 그 행들의 내용은 애초에 결속된 적이 없어서 "변조되지 않았다"고 말할 근거가 없다.
  // 옛 관대함이 필요한 운영자는 PROOF_ACCEPT_LEGACY_UNBOUND=true 로 명시적으로 켠다.
  // 🔑 이건 **별도 검사**여야 한다. 실패 사유를 어느 검사에도 안 붙이면
  //    `verified:false` 인데 checks 는 전부 초록인 자기모순 응답이 나온다
  //    (2026-08-06 공격 하네스가 실제로 잡았다). 두 사실은 서로 다르다:
  //      chainHash.ok       = 저장된 해시가 재계산과 일치한다
  //      contentCoverage.ok = 그 계산이 레코드 내용을 덮는다
  const acceptUnbound = process.env.PROOF_ACCEPT_LEGACY_UNBOUND === 'true';
  const bound = core.chainHash.contentBound;

  const contentCoverage: Check & { contentBound: boolean | null; legacyAccepted: boolean } =
    !core.chainHash.ok
      ? {
          ok: false,
          contentBound: null,
          legacyAccepted: false,
          detail: 'Not evaluated — the hash itself did not match.',
        }
      : bound !== false
        ? { ok: true, contentBound: bound, legacyAccepted: false }
        : acceptUnbound
          ? {
              ok: true,
              contentBound: false,
              legacyAccepted: true,
              // 🔴 이 서버는 레거시를 받아들이도록 설정돼 있다. 그 사실을 응답에 실어야 한다 —
              //    안 실으면 검증자가 이 verified:true 를 v3 와 같은 강도로 읽는다.
              detail:
                'The matching computation does NOT cover the record content, but this server runs with '
                + 'PROOF_ACCEPT_LEGACY_UNBOUND=true so it is accepted anyway. The outcome, AI reasoning and '
                + 'approval fields are not bound by any hash on this record.',
            }
          : {
              ok: false,
              contentBound: false,
              legacyAccepted: false,
              detail:
                `The matching computation (${core.chainHash.matchedScheme}) does not cover the record content. `
                + 'Cannot attest that the outcome, AI reasoning or approval fields are unchanged.',
            };

  if (!contentCoverage.ok) failures.push(`contentCoverage: ${contentCoverage.detail}`);
  // not_configured / not_applicable 은 판정에서 제외한다 — 서명을 안 켠 것이 위조는 아니다.
  // 반대로 missing/invalid 는 실패다: 키가 있는데 서명이 없다면 다운그레이드 시도로 본다.
  if (serverSignature.status === 'invalid' || serverSignature.status === 'missing') {
    failures.push(`serverSignature: ${serverSignature.status} — ${serverSignature.detail ?? 'signature check failed'}`);
  }

  return {
    verified: failures.length === 0,
    checks: {
      chainHash,
      contentCoverage,
      chainLink,
      seal,
      serverSignature,
      trustedTimestamp: {
        status: 'not_implemented',
        detail:
          'RFC 3161 trusted timestamping is not implemented. Timestamps here are server-asserted, not third-party attested.',
      },
    },
    chainPayloadVersion: version,
    failures,
  };
}

export interface ChainVerificationResult {
  domain: string;
  verified: boolean;
  totalEvents: number;
  scanned: number;
  verifiedEvents: number;
  /** 처음으로 깨진 체인 인덱스. 전부 정상이면 null. */
  firstBrokenIndex: number | null;
  /** 인덱스 연속성 — 중간에 빠진 레코드가 있으면 여기 담긴다. */
  missingIndexes: number[];
  records: {
    chainIndex: number;
    evidenceId: string | null;
    verified: boolean;
    failures: string[];
  }[];
  truncated: boolean;
  /**
   * 이 판정이 체인 **전체**를 본 결과인가.
   *
   * 🔴 부분 스캔에서 verified:true 를 주면 안 된다 — 깨진 구간을 범위 밖으로 밀어내는 것만으로
   *    통과를 만들어낼 수 있다(`?limit=0` 이면 아무것도 안 보고 통과했다).
   */
  scope: 'full' | 'partial';
}

/**
 * 도메인 전체 체인 검증.
 *
 * 레코드 하나만 보는 `/verify/:id`와 달리, 체인 **전체**를 인덱스 순서대로 훑는다.
 * 개별 레코드가 각자 정상이어도 중간이 통째로 빠져 있으면 체인은 깨진 것이다 —
 * 그래서 인덱스 연속성을 따로 센다.
 *
 * 🔴 이 함수의 결과는 도메인명과 인덱스를 담으므로 **인증된 호출자에게만** 준다.
 *    공개 검증(`/verify/:id`)과 같은 화이트리스트를 적용하면 체인 검증 자체가 무의미해진다.
 */
export function verifyChain(
  db: Database,
  params: { domain: string; tenantId: string; fromIndex?: number; toIndex?: number; limit?: number },
): ChainVerificationResult {
  const { domain, tenantId } = params;
  // 🔴 하한이 없으면 `?limit=0` 이 "아무것도 안 봤으니 깨진 게 없다"가 된다.
  const requested = params.limit ?? COVERAGE_SCAN_LIMIT;
  const limit = Math.max(1, Math.min(requested, COVERAGE_SCAN_LIMIT));
  const ranged = params.fromIndex !== undefined || params.toIndex !== undefined;

  const total = (
    db
      .prepare('SELECT COUNT(*) as count FROM decision_events WHERE chain_domain = ? AND tenant_id = ?')
      .get(domain, tenantId) as { count: number }
  ).count;

  const conditions = ['chain_domain = ?', 'tenant_id = ?'];
  const args: unknown[] = [domain, tenantId];

  if (params.fromIndex !== undefined) {
    conditions.push('chain_index >= ?');
    args.push(params.fromIndex);
  }
  if (params.toIndex !== undefined) {
    conditions.push('chain_index <= ?');
    args.push(params.toIndex);
  }

  const rows = db
    .prepare(
      `SELECT * FROM decision_events WHERE ${conditions.join(' AND ')} ORDER BY chain_index ASC LIMIT ?`,
    )
    .all(...args, limit) as DecisionEventRow[];

  const records: ChainVerificationResult['records'] = [];
  const missingIndexes: number[] = [];
  let firstBrokenIndex: number | null = null;
  let verifiedEvents = 0;
  let expectedIndex = rows.length > 0 ? rows[0].chain_index : 0;

  for (const row of rows) {
    // 인덱스 건너뜀 = 레코드가 통째로 사라졌다는 뜻. 개별 검증은 통과할 수 있으므로 따로 잡는다.
    while (row.chain_index > expectedIndex) {
      missingIndexes.push(expectedIndex);
      if (firstBrokenIndex === null) firstBrokenIndex = expectedIndex;
      expectedIndex += 1;
    }
    expectedIndex = row.chain_index + 1;

    const result = verifyRecord(db, row);
    if (result.verified) {
      verifiedEvents += 1;
    } else if (firstBrokenIndex === null) {
      firstBrokenIndex = row.chain_index;
    }

    records.push({
      chainIndex: row.chain_index,
      evidenceId: row.evidence_id,
      verified: result.verified,
      failures: result.failures,
    });
  }

  const truncated = total > rows.length;
  // 범위 필터를 걸었거나 전부 못 훑었으면 "부분"이다. 부분 판정은 통과를 만들지 못한다 —
  // 그러지 않으면 깨진 구간을 범위 밖으로 밀어내는 것만으로 초록불을 살 수 있다.
  const scope: 'full' | 'partial' = ranged || truncated ? 'partial' : 'full';
  const clean = firstBrokenIndex === null && missingIndexes.length === 0;

  return {
    domain,
    verified: scope === 'full' && clean,
    totalEvents: total,
    scanned: rows.length,
    verifiedEvents,
    firstBrokenIndex,
    missingIndexes,
    records,
    truncated,
    scope,
  };
}

export interface CoverageResult {
  totalEvents: number;
  verifiedEvents: number;
  /** 스캔 한도를 넘어 일부만 검사했는지. 조용히 자르지 않고 표시한다. */
  truncated: boolean;
  scanned: number;
}

/**
 * 이 레코드가 속한 체인의 Coverage.
 *
 * 이벤트 **개수**만 센다. 이벤트 이름·도메인은 내보내지 않는다 —
 * "심사반려"·"정산보류" 같은 이름은 그 자체가 고객사 운영 정보다.
 */
export function computeCoverage(db: Database, row: DecisionEventRow): CoverageResult {
  const total = (
    db
      .prepare('SELECT COUNT(*) as count FROM decision_events WHERE chain_domain = ? AND tenant_id = ?')
      .get(row.chain_domain, row.tenant_id) as { count: number }
  ).count;

  const rows = db
    .prepare(
      'SELECT * FROM decision_events WHERE chain_domain = ? AND tenant_id = ? ORDER BY chain_index ASC LIMIT ?',
    )
    .all(row.chain_domain, row.tenant_id, COVERAGE_SCAN_LIMIT) as DecisionEventRow[];

  let verified = 0;
  for (const candidate of rows) {
    if (verifyRecord(db, candidate).verified) verified += 1;
  }

  return {
    totalEvents: total,
    verifiedEvents: verified,
    truncated: total > rows.length,
    scanned: rows.length,
  };
}
