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
import { computeChainHash, computeObjectHash } from '@cronozen/dpu-core';
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
}

export interface Check {
  ok: boolean;
  detail?: string;
}

export type ChainScheme = 'v2' | 'v3';

/**
 * 해시 검사 결과.
 *
 * 🔑 **라벨이 아니라 실제로 맞은 계산이 진실이다.** (thearound-ops 가 2026-07-31 codex
 *    독립검증에서 얻은 규칙 — 저장된 버전 라벨만 보고 "내용까지 결속됨"이라 보고했다가
 *    거짓 통과를 냈다. 검증이 없는 것보다 나쁜 상태다.)
 *    그래서 `matchedScheme`은 저장된 `chain_payload_version`이 아니라 **실제로 일치한 빌더**다.
 */
export interface ChainHashCheck extends Check {
  matchedScheme: ChainScheme | null;
  /**
   * 이 해시가 레코드 **내용**까지 덮는가.
   *
   * 🔴 v2는 `type`·`action_type`·`actor_id` 3개만 덮는다. 즉 v2 레코드는
   *    `verified: true`여도 산출물·AI 근거·승인 결과를 바꿔치기할 수 있다.
   *    이 값을 함께 내보내지 않으면 "verified"가 실제보다 훨씬 강하게 읽힌다.
   *    해시가 안 맞았으면 단정하지 않고 null.
   */
  contentBound: boolean | null;
}

export interface VerificationResult {
  verified: boolean;
  checks: {
    chainHash: ChainHashCheck;
    chainLink: Check;
    seal: Check;
    serverSignature: SignatureCheck;
    trustedTimestamp: { status: 'not_implemented'; detail: string };
  };
  chainPayloadVersion: number;
  /** 판정 실패 사유. verified=true면 빈 배열. */
  failures: string[];
}

// ─── 콘텐츠 복원 ────────────────────────────────────────────────────

/**
 * 이 행이 기록될 때 쓰인 체인 콘텐츠를 그대로 되만든다.
 *
 * 버전별로 빌더가 갈린다. v2 행을 v3 규칙으로 검증하면 멀쩡한 기록이 전부 실패한다 —
 * 그건 변조 탐지가 아니라 거짓 경보다.
 */
function rebuildChainContent(db: Database, row: DecisionEventRow): Record<string, unknown> {
  const version = row.chain_payload_version ?? 2;

  if (version >= 3) return buildChainContentV3(row);

  // v2: file_change 이벤트는 file_hash를 추가로 넣었으므로 proof_files에서 되찾아온다.
  let fileHash: string | null = null;
  if (row.type === 'file_change') {
    const file = db
      .prepare('SELECT file_hash FROM proof_files WHERE decision_event_id = ? ORDER BY created_at ASC LIMIT 1')
      .get(row.id) as { file_hash: string } | undefined;
    fileHash = file?.file_hash ?? null;
  }
  return buildChainContentV2(row, fileHash);
}

/**
 * 체인 해시 계산에 쓰인 타임스탬프 후보.
 *
 * v3은 항상 occurred_at 하나다 — 저장한 값으로 검증되어야 한다는 것이 규칙이다.
 *
 * 🔴 v2에는 결함이 있었다: services/google-drive.ts 는 해시를 `now` 로 계산하면서
 *    occurred_at 컬럼에는 `file.modifiedTime` 을 저장했다. 두 값이 다르면 그 행은
 *    재계산이 불가능하다. 검증기가 없던 시절이라 아무도 몰랐던 결함이다.
 *    옛 행을 "변조됨"으로 몰지 않기 위해 v2에 한해 created_at(=당시의 `now`)도 시도한다.
 *    이건 검증 완화가 아니라, 기록 당시 실제로 쓰인 입력을 찾는 것이다.
 */
function chainTimestampCandidates(row: DecisionEventRow): string[] {
  const version = row.chain_payload_version ?? 2;
  if (version >= 3) return [row.occurred_at];

  const candidates = [row.occurred_at];
  if (row.created_at && row.created_at !== row.occurred_at) candidates.push(row.created_at);
  return candidates;
}

// ─── 개별 검사 ──────────────────────────────────────────────────────

function checkChainHash(db: Database, row: DecisionEventRow): ChainHashCheck {
  if (!row.chain_hash) {
    return { ok: false, matchedScheme: null, contentBound: null, detail: 'Record has no chain hash.' };
  }

  const version = row.chain_payload_version ?? 2;
  const scheme: ChainScheme = version >= 3 ? 'v3' : 'v2';
  const content = rebuildChainContent(db, row);

  for (const timestamp of chainTimestampCandidates(row)) {
    const recomputed = computeChainHash(content, row.previous_hash ?? null, timestamp);
    if (recomputed === row.chain_hash) {
      return {
        ok: true,
        matchedScheme: scheme,
        contentBound: scheme === 'v3',
        detail:
          scheme === 'v3'
            ? undefined
            : 'Legacy v2 record: the hash covers only type, action type and actor — the outcome, AI reasoning and approval fields are NOT bound by it.',
      };
    }
  }

  return {
    ok: false,
    matchedScheme: null,
    contentBound: null,
    detail: 'Recomputed hash does not match the stored chain hash — record content was altered after recording.',
  };
}

/**
 * 체인 연결 — 앞뒤 **양방향**.
 *
 * chain_hash만 맞아도 **행 하나를 통째로 빼내는 것**은 잡히지 않는다.
 * 앞 레코드가 실제로 존재하고 그 해시가 previous_hash와 같은지까지 봐야 한다.
 *
 * 🔴 후행(next) 링크도 봐야 한다. 앞만 보면 **뒤가 끊겨도 "통과"**라고 답한다 —
 *    thearound-ops가 2026-07-31 독립검증에서 정확히 이 구멍을 지적받고 조인 항목이다.
 *    (ops PROD 실측: next_link 보유 43,898건 중 불일치 0건 → 조여도 뒤집히는 레코드가 없었다.)
 *
 * 링크는 3상태다: 대상이 **없으면**(체인의 끝/시작) null → 통과로 본다.
 * 대상이 있는데 어긋나면 실패다. 없는 것과 어긋난 것을 같게 취급하면 둘 다 놓친다.
 */
function checkChainLink(db: Database, row: DecisionEventRow): Check {
  const index = row.chain_index;

  // ── 선행 링크 ──
  if (index === 0) {
    if (row.previous_hash) {
      return { ok: false, detail: 'Genesis record (index 0) must not reference a previous hash.' };
    }
  } else {
    const previous = db
      .prepare(
        'SELECT chain_hash FROM decision_events WHERE chain_domain = ? AND tenant_id = ? AND chain_index = ?',
      )
      .get(row.chain_domain, row.tenant_id, index - 1) as { chain_hash: string | null } | undefined;

    if (!previous) {
      return { ok: false, detail: `Previous record at chain index ${index - 1} is missing — the chain has a gap.` };
    }
    if (!row.previous_hash) {
      return { ok: false, detail: 'Record at a non-zero index carries no previous hash.' };
    }
    if (previous.chain_hash !== row.previous_hash) {
      return {
        ok: false,
        detail: 'Previous hash does not match the actual preceding record — the chain was reordered or rewritten.',
      };
    }
  }

  // ── 후행 링크 ──
  const next = db
    .prepare(
      'SELECT previous_hash FROM decision_events WHERE chain_domain = ? AND tenant_id = ? AND chain_index = ?',
    )
    .get(row.chain_domain, row.tenant_id, index + 1) as { previous_hash: string | null } | undefined;

  if (next && next.previous_hash !== row.chain_hash) {
    return {
      ok: false,
      detail: 'The following record does not point back to this one — the chain was rewritten after this record.',
    };
  }

  return {
    ok: true,
    detail: index === 0 ? 'Genesis record.' : undefined,
  };
}

/**
 * 봉인(승인) 검사.
 *
 * 승인은 레코드 생성 이후에 일어나므로 chain_hash가 덮지 못한다.
 * seal_hash가 그 공백을 메운다 — 없으면 승인자·승인결과를 자유롭게 바꿀 수 있다.
 */
function checkSeal(row: DecisionEventRow): Check {
  const isSealed = !!row.sealed_at || !!row.approval_result;
  const version = row.chain_payload_version ?? 2;

  if (!isSealed) {
    if (row.seal_hash) {
      return { ok: false, detail: 'Record carries a seal hash but has no approval — seal was stripped.' };
    }
    return { ok: true, detail: 'Not sealed yet (pending approval).' };
  }

  // seal_hash가 있으면 버전과 무관하게 검증한다.
  // (레거시 행이라도 v3 배포 이후에 승인됐다면 seal_hash를 받았다 — 있는 것을 안 보면 그게 구멍이다.)
  if (!row.seal_hash) {
    if (version < 3) {
      return {
        ok: true,
        detail: 'Sealed before seal hashing existed (chain payload < v3) — approval fields are not cryptographically bound.',
      };
    }
    return { ok: false, detail: 'Record is sealed but carries no seal hash.' };
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
      detail: 'Recomputed seal hash does not match — approval details were altered after sealing.',
    };
  }

  return { ok: true };
}

// ─── 공개 진입점 ────────────────────────────────────────────────────

export function verifyRecord(db: Database, row: DecisionEventRow): VerificationResult {
  const version = row.chain_payload_version ?? 2;

  const chainHash = checkChainHash(db, row);
  const chainLink = checkChainLink(db, row);
  const seal = checkSeal(row);
  const serverSignature = verifyRecordSignature({
    chainHash: row.chain_hash ?? '',
    sealHash: row.seal_hash,
    signature: row.signature,
    signatureAlg: row.signature_alg,
    signatureKeyId: row.signature_key_id,
    applicable: version >= CHAIN_PAYLOAD_VERSION,
  });

  const failures: string[] = [];
  if (!chainHash.ok) failures.push(`chainHash: ${chainHash.detail}`);
  if (!chainLink.ok) failures.push(`chainLink: ${chainLink.detail}`);
  if (!seal.ok) failures.push(`seal: ${seal.detail}`);
  // not_configured / not_applicable 은 판정에서 제외한다 — 서명을 안 켠 것이 위조는 아니다.
  // 반대로 missing/invalid 는 실패다: 키가 있는데 서명이 없다면 다운그레이드 시도로 본다.
  if (serverSignature.status === 'invalid' || serverSignature.status === 'missing') {
    failures.push(`serverSignature: ${serverSignature.status} — ${serverSignature.detail ?? 'signature check failed'}`);
  }

  return {
    verified: failures.length === 0,
    checks: {
      chainHash,
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
  const limit = Math.min(params.limit ?? COVERAGE_SCAN_LIMIT, COVERAGE_SCAN_LIMIT);

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

  return {
    domain,
    verified: firstBrokenIndex === null && missingIndexes.length === 0,
    totalEvents: total,
    scanned: rows.length,
    verifiedEvents,
    firstBrokenIndex,
    missingIndexes,
    records,
    truncated: rows.length >= limit && total > rows.length,
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
