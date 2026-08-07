/**
 * Decision Events API
 *
 * POST   /decision-events           — Record a new decision
 * GET    /decision-events           — List decisions
 * GET    /decision-events/:id       — Get a decision
 * POST   /decision-events/:id/approvals — Approve/reject a decision
 */

import { Hono } from 'hono';
import { getDB } from '../db/connection.js';
import { computeChainHash, computeObjectHash } from '@cronozen/dpu-core';
import {
  CHAIN_PAYLOAD_VERSION,
  buildChainContentV3,
  buildSealContent,
} from '../lib/chain-content.js';
import { signRecord } from '../lib/signing.js';
import { verifyChain } from '../lib/verification.js';
import type { AuthContext } from '../middleware/auth.js';
import type { QuotaInfo } from '../middleware/quota.js';

type Env = { Variables: { auth: AuthContext; quota?: QuotaInfo } };

export const decisionsRouter = new Hono<Env>();

// ─── POST /decision-events ─────────────────────────────────────────

decisionsRouter.post('/', async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json();

  const {
    type,
    sourceType,
    actor,
    action,
    occurredAt,
    aiContext,
    metadata,
    tags,
    idempotencyKey,
  } = body;

  // 필수 필드 검증
  if (!type || !actor?.id || !action?.type) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'type, actor.id, action.type are required' } },
      400,
    );
  }

  // Idempotency check
  if (idempotencyKey) {
    const db = getDB();
    const existing = db
      .prepare('SELECT id, decision_id FROM decision_events WHERE idempotency_key = ? AND tenant_id = ?')
      .get(idempotencyKey, auth.tenantId) as { id: string; decision_id: string } | undefined;

    if (existing) {
      const full = db.prepare('SELECT * FROM decision_events WHERE id = ?').get(existing.id);
      return c.json({ data: formatEvent(full as EventRow) });
    }
  }

  const db = getDB();
  const id = crypto.randomUUID();
  const decisionId = `dec_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const now = new Date().toISOString();
  const chainDomain = metadata?.domain || 'default';

  const evidenceId = `evi_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

  // source_type 자동 추론: aiContext가 있으면 'ai', 명시적 값 우선
  const resolvedSourceType = sourceType
    || (aiContext ? 'ai' : 'manual');

  // 🔑 컬럼값을 먼저 확정한 뒤 그 객체에서 해시를 뽑는다.
  //    검증기(lib/verification.ts)는 DB 행을 같은 빌더에 넣으므로,
  //    기록 시점과 검증 시점의 입력이 같은 모양임이 구조적으로 보장된다.
  //    해시를 별도 리터럴로 따로 계산하면 바로 여기서 두 경로가 갈라진다.
  //
  //    chain_index / previous_hash 는 트랜잭션 안에서 채운다(아래) — 체인의 끝은
  //    읽는 순간과 쓰는 순간 사이에 움직일 수 있는 값이라 여기서 확정하면 안 된다.
  const cols = {
    id,
    decision_id: decisionId,
    type,
    source_type: resolvedSourceType,
    status: 'recorded',

    actor_id: actor.id,
    actor_type: actor.type || 'human',
    actor_name: actor.name || null,
    actor_metadata: actor.metadata ? JSON.stringify(actor.metadata) : null,

    action_type: action.type,
    action_description: action.description || null,
    action_input: action.input ? JSON.stringify(action.input) : null,
    action_output: action.output ? JSON.stringify(action.output) : null,
    action_metadata: action.metadata ? JSON.stringify(action.metadata) : null,

    ai_model: aiContext?.model || null,
    ai_provider: aiContext?.provider || null,
    ai_confidence: aiContext?.confidence ?? null,
    ai_prompt_hash: aiContext?.promptHash || null,
    ai_reasoning: aiContext?.reasoning || null,
    ai_tokens_input: aiContext?.tokens?.input ?? null,
    ai_tokens_output: aiContext?.tokens?.output ?? null,
    ai_metadata: aiContext ? JSON.stringify(aiContext.metadata || {}) : null,

    evidence_id: evidenceId,
    evidence_level: 'DRAFT',
    chain_index: -1,        // 트랜잭션 안에서 확정
    previous_hash: null as string | null, // 〃
    chain_domain: chainDomain,

    occurred_at: occurredAt || now,
    tags: tags ? JSON.stringify(tags) : null,
    metadata: metadata ? JSON.stringify(metadata) : null,
    idempotency_key: idempotencyKey || null,

    tenant_id: auth.tenantId,
    api_key_id: auth.apiKeyId,
    created_at: now,
    updated_at: now,
  };

  const insertStatement = db.prepare(`
    INSERT INTO decision_events (
      id, decision_id, type, source_type, status,
      actor_id, actor_type, actor_name, actor_metadata,
      action_type, action_description, action_input, action_output, action_metadata,
      ai_model, ai_provider, ai_confidence, ai_prompt_hash, ai_reasoning,
      ai_tokens_input, ai_tokens_output, ai_metadata,
      evidence_id, evidence_level, chain_hash, chain_index, previous_hash, chain_domain,
      chain_payload_version, signature, signature_alg, signature_key_id,
      occurred_at, tags, metadata, idempotency_key,
      tenant_id, api_key_id, created_at, updated_at
    ) VALUES (
      @id, @decision_id, @type, @source_type, @status,
      @actor_id, @actor_type, @actor_name, @actor_metadata,
      @action_type, @action_description, @action_input, @action_output, @action_metadata,
      @ai_model, @ai_provider, @ai_confidence, @ai_prompt_hash, @ai_reasoning,
      @ai_tokens_input, @ai_tokens_output, @ai_metadata,
      @evidence_id, @evidence_level, @chain_hash, @chain_index, @previous_hash, @chain_domain,
      @chain_payload_version, @signature, @signature_alg, @signature_key_id,
      @occurred_at, @tags, @metadata, @idempotency_key,
      @tenant_id, @api_key_id, @created_at, @updated_at
    )
  `);

  /**
   * 🔴 체인의 끝을 읽고 이어붙이는 것은 **한 트랜잭션 안에서** 일어나야 한다.
   *
   * 읽기와 쓰기가 갈라져 있으면 동시 요청 둘이 같은 `chain_index`와 같은 `previous_hash`를
   * 받아 체인이 조용히 갈라진다. 그러면 앞뒤 링크 조회가 비결정적이 되고,
   * 검증기는 같은 레코드에 대해 실행할 때마다 다른 답을 낼 수 있다 — 감사에서 최악이다.
   *
   * `.immediate()`는 트랜잭션 시작 시점에 쓰기 락을 잡는다. 기본(deferred)은 첫 쓰기까지
   * 락을 미루므로 read-then-write 경합을 막지 못한다.
   * (DB의 UNIQUE(tenant_id, chain_domain, chain_index) 인덱스가 최후 방어선이다.)
   */
  const appendToChain = db.transaction(() => {
    const lastInChain = db
      .prepare(
        'SELECT chain_hash, chain_index FROM decision_events WHERE chain_domain = ? AND tenant_id = ? ORDER BY chain_index DESC LIMIT 1',
      )
      .get(chainDomain, auth.tenantId) as { chain_hash: string; chain_index: number } | undefined;

    cols.previous_hash = lastInChain?.chain_hash || null;
    cols.chain_index = (lastInChain?.chain_index ?? -1) + 1;

    const chainHash = computeChainHash(
      buildChainContentV3(cols),
      cols.previous_hash,
      cols.occurred_at,
    );

    // 서명 키가 없으면 null — 서명한 척하지 않는다. 검증 응답이 그 상태를 그대로 말한다.
    const sig = signRecord(chainHash, null);

    insertStatement.run({
      ...cols,
      chain_hash: chainHash,
      chain_payload_version: CHAIN_PAYLOAD_VERSION,
      signature: sig?.signature ?? null,
      signature_alg: sig?.alg ?? null,
      signature_key_id: sig?.keyId ?? null,
    });
  });

  appendToChain.immediate();

  const inserted = db.prepare('SELECT * FROM decision_events WHERE id = ?').get(id);
  const quota = c.get('quota');
  return c.json({
    data: formatEvent(inserted as EventRow),
    ...(quota ? { quota } : {}),
  }, 201);
});

// ─── GET /decision-events ──────────────────────────────────────────

decisionsRouter.get('/', async (c) => {
  const auth = c.get('auth');
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);
  const offset = parseInt(c.req.query('offset') || '0');
  const type = c.req.query('type');
  const sourceType = c.req.query('source_type');
  const status = c.req.query('status');
  const tag = c.req.query('tag');

  const db = getDB();
  let where = 'WHERE tenant_id = ?';
  const params: unknown[] = [auth.tenantId];

  if (type) { where += ' AND type = ?'; params.push(type); }
  if (sourceType) { where += ' AND source_type = ?'; params.push(sourceType); }
  if (status) { where += ' AND status = ?'; params.push(status); }
  if (tag) { where += ' AND tags LIKE ?'; params.push(`%"${tag}"%`); }

  const total = (db.prepare(`SELECT COUNT(*) as count FROM decision_events ${where}`).get(...params) as { count: number }).count;
  const rows = db.prepare(`SELECT * FROM decision_events ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as EventRow[];

  return c.json({
    data: rows.map(formatEvent),
    pagination: { total, limit, offset, hasMore: offset + limit < total },
  });
});

// ─── GET /decision-events/verify-chain/:domain ─────────────────────

/**
 * 도메인 전체 체인 검증.
 *
 * `/verify/:id`는 레코드 하나만 본다. 개별 레코드가 각자 정상이어도 중간이 통째로
 * 빠져 있으면 체인은 깨진 것이다 — 그 판정은 여기서 한다.
 *
 * ⚠️ `/:id` 라우트보다 **먼저** 선언해야 한다. 뒤에 두면 'verify-chain'을
 *    decision id 로 조회하고 404가 난다.
 *
 * 🔴 인증 필수(tenant 스코핑). 응답이 도메인명과 인덱스를 담기 때문에 공개할 수 없다.
 */
decisionsRouter.get('/verify-chain/:domain', async (c) => {
  const auth = c.get('auth');
  const domain = c.req.param('domain');

  const parseIndex = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const value = parseInt(raw, 10);
    return Number.isFinite(value) ? value : undefined;
  };

  const result = verifyChain(getDB(), {
    domain,
    tenantId: auth.tenantId,
    fromIndex: parseIndex(c.req.query('fromIndex')),
    toIndex: parseIndex(c.req.query('toIndex')),
    limit: parseIndex(c.req.query('limit')),
  });

  if (result.totalEvents === 0) {
    return c.json(
      { error: { code: 'NOT_FOUND', message: `No records found for chain domain '${domain}'` } },
      404,
    );
  }

  return c.json({ data: result });
});

// ─── GET /decision-events/:id ──────────────────────────────────────

decisionsRouter.get('/:id', async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');

  const db = getDB();
  const row = db
    .prepare('SELECT * FROM decision_events WHERE (id = ? OR decision_id = ?) AND tenant_id = ?')
    .get(id, id, auth.tenantId) as EventRow | undefined;

  if (!row) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Decision event not found' } }, 404);
  }

  return c.json({ data: formatEvent(row) });
});

// ─── POST /decision-events/:id/approvals ───────────────────────────

decisionsRouter.post('/:id/approvals', async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');
  const body = await c.req.json();

  const { approver, result: approvalResult, reason, approvedAt } = body;

  if (!approver?.id || !approvalResult) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'approver.id and result are required' } },
      400,
    );
  }

  const db = getDB();
  const row = db
    .prepare('SELECT * FROM decision_events WHERE (id = ? OR decision_id = ?) AND tenant_id = ?')
    .get(id, id, auth.tenantId) as EventRow | undefined;

  if (!row) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Decision event not found' } }, 404);
  }

  if (row.status === 'sealed') {
    return c.json({ error: { code: 'CONFLICT', message: 'Decision is already sealed' } }, 409);
  }

  const now = new Date().toISOString();
  const newStatus = approvalResult === 'approved' ? 'sealed' : 'rejected';
  const evidenceLevel = approvalResult === 'approved' ? 'AUDIT_READY' : 'DRAFT';

  // 🔑 승인은 레코드 생성 **이후**에 일어나므로 chain_hash가 덮지 못한다.
  //    seal_hash가 그 공백을 메운다 — 없으면 승인자와 승인결과를 나중에 자유롭게 바꿀 수 있고,
  //    감사에서 가장 먼저 문제되는 값이 정확히 그것이다.
  const sealFields = {
    chain_hash: row.chain_hash ?? '',
    decision_id: row.decision_id,
    evidence_id: row.evidence_id,
    status: newStatus,
    evidence_level: evidenceLevel,
    approver_id: approver.id,
    approver_type: approver.type || 'human',
    approver_name: approver.name || null,
    approval_result: approvalResult,
    approval_reason: reason || null,
    approved_at: approvedAt || now,
    sealed_at: approvalResult === 'approved' ? now : null,
  };

  const sealHash = computeObjectHash(buildSealContent(sealFields));

  // 서명은 chain_hash와 seal_hash를 함께 묶는다 → 승인 내용이 바뀌면 서명도 깨진다.
  const sig = signRecord(sealFields.chain_hash, sealHash);

  /**
   * 🔑 봉인을 **체인 레코드로 승격**한다 (2026-08-06).
   *
   * 왜: `seal_hash` 는 결정 행에 옆으로 매달린 값이라 **어떤 체인에도 들어가지 않았다.**
   * 다음 레코드의 previous_hash 는 앞 레코드의 chain_hash 를 가리키지 seal_hash 를 가리키지 않는다.
   * 그래서 체인 헤드를 외부에 앵커해도 "누가 승인했나"는 한 바이트도 안 덮였다 —
   * ops 가 naive 앵커를 금지한 이유 1번이 모양만 바꿔 그대로 재현되는 상태였다.
   *
   * 승인 시 같은 도메인 체인에 `type='seal'` 레코드를 append 하면:
   *   - 헤드 앵커가 승인까지 **전이적으로** 덮는다
   *   - 봉인 레코드를 지우면 체인에 구멍이 생겨 링크 검사가 잡는다
   *   - 결정 행의 승인 필드를 되돌려도 봉인 레코드가 남아 불일치로 잡힌다(롤백 탐지)
   *
   * ops 는 이 문제를 별도 테이블(dpu_commitment_events)로 풀었는데, 여기서는 기존 체인
   * 하나로 푼다 — 같은 것을 두 번 표현하지 않는다.
   *
   * 🔴 봉인 레코드의 권위는 **해시된 action_output** 이다. `seals_decision_id` 컬럼은
   *    조회용 인덱스일 뿐이라 고쳐도 해시가 안 맞아 봉인 레코드 자체가 깨진다.
   */
  const sealRecordId = crypto.randomUUID();
  const sealDecisionId = `dec_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const sealEvidenceId = `evi_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

  const sealCols = {
    id: sealRecordId,
    decision_id: sealDecisionId,
    type: 'seal',
    source_type: 'system',
    status: 'recorded',

    actor_id: sealFields.approver_id,
    actor_type: sealFields.approver_type,
    actor_name: sealFields.approver_name,
    actor_metadata: null,

    action_type: 'SEAL',
    action_description: `Seal for ${row.decision_id}`,
    action_input: null,
    // 이 JSON 이 봉인의 정본이다. v3 콘텐츠가 이 문자열을 통째로 해시한다.
    action_output: JSON.stringify({
      targetDecisionId: row.decision_id,
      targetEvidenceId: row.evidence_id,
      targetChainHash: row.chain_hash,
      result: sealFields.approval_result,
      evidenceLevel: sealFields.evidence_level,
      status: sealFields.status,
      approverId: sealFields.approver_id,
      approverType: sealFields.approver_type,
      approverName: sealFields.approver_name,
      approvedAt: sealFields.approved_at,
      sealedAt: sealFields.sealed_at,
      sealHash,
    }),
    action_metadata: null,

    ai_model: null,
    ai_provider: null,
    ai_confidence: null,
    ai_prompt_hash: null,
    ai_reasoning: null,
    ai_tokens_input: null,
    ai_tokens_output: null,
    ai_metadata: null,

    evidence_id: sealEvidenceId,
    evidence_level: sealFields.evidence_level,
    chain_index: -1,                      // 트랜잭션 안에서 확정
    previous_hash: null as string | null, // 〃
    chain_domain: row.chain_domain,

    occurred_at: sealFields.approved_at,
    tags: JSON.stringify(['seal']),
    metadata: JSON.stringify({ domain: row.chain_domain, sealOf: row.decision_id }),

    tenant_id: auth.tenantId,
    api_key_id: auth.apiKeyId,
    created_at: now,
    updated_at: now,
  };

  const insertSeal = db.prepare(`
    INSERT INTO decision_events (
      id, decision_id, type, source_type, status,
      actor_id, actor_type, actor_name, actor_metadata,
      action_type, action_description, action_input, action_output, action_metadata,
      ai_model, ai_provider, ai_confidence, ai_prompt_hash, ai_reasoning,
      ai_tokens_input, ai_tokens_output, ai_metadata,
      evidence_id, evidence_level, chain_hash, chain_index, previous_hash, chain_domain,
      chain_payload_version, signature, signature_alg, signature_key_id, seals_decision_id,
      occurred_at, tags, metadata,
      tenant_id, api_key_id, created_at, updated_at
    ) VALUES (
      @id, @decision_id, @type, @source_type, @status,
      @actor_id, @actor_type, @actor_name, @actor_metadata,
      @action_type, @action_description, @action_input, @action_output, @action_metadata,
      @ai_model, @ai_provider, @ai_confidence, @ai_prompt_hash, @ai_reasoning,
      @ai_tokens_input, @ai_tokens_output, @ai_metadata,
      @evidence_id, @evidence_level, @chain_hash, @chain_index, @previous_hash, @chain_domain,
      @chain_payload_version, @signature, @signature_alg, @signature_key_id, @seals_decision_id,
      @occurred_at, @tags, @metadata,
      @tenant_id, @api_key_id, @created_at, @updated_at
    )
  `);

  const updateDecision = db.prepare(`
    UPDATE decision_events SET
      status = @status, evidence_level = @evidence_level,
      approver_id = @approver_id, approver_type = @approver_type, approver_name = @approver_name,
      approval_result = @approval_result, approval_reason = @approval_reason,
      approved_at = @approved_at, sealed_at = @sealed_at, seal_hash = @seal_hash,
      signature = @signature, signature_alg = @signature_alg, signature_key_id = @signature_key_id,
      updated_at = @updated_at
    WHERE id = @id
  `);

  // 결정 행 갱신과 봉인 레코드 append 는 **한 트랜잭션**이어야 한다.
  // 갈라지면 "승인됐다는 행은 있는데 봉인 레코드가 없는" 상태가 생기고, 그건 검증기가
  // 위조로 판정하는 모양이다 — 우리 배선이 만든 위조 신호는 최악이다.
  const sealTx = db.transaction(() => {
    updateDecision.run({
      status: sealFields.status,
      evidence_level: sealFields.evidence_level,
      approver_id: sealFields.approver_id,
      approver_type: sealFields.approver_type,
      approver_name: sealFields.approver_name,
      approval_result: sealFields.approval_result,
      approval_reason: sealFields.approval_reason,
      approved_at: sealFields.approved_at,
      sealed_at: sealFields.sealed_at,
      seal_hash: sealHash,
      signature: sig?.signature ?? null,
      signature_alg: sig?.alg ?? null,
      signature_key_id: sig?.keyId ?? null,
      updated_at: now,
      id: row.id,
    });

    const lastInChain = db
      .prepare(
        'SELECT chain_hash, chain_index FROM decision_events WHERE chain_domain = ? AND tenant_id = ? ORDER BY chain_index DESC LIMIT 1',
      )
      .get(row.chain_domain, auth.tenantId) as { chain_hash: string; chain_index: number } | undefined;

    sealCols.previous_hash = lastInChain?.chain_hash || null;
    sealCols.chain_index = (lastInChain?.chain_index ?? -1) + 1;

    const sealChainHash = computeChainHash(
      buildChainContentV3(sealCols),
      sealCols.previous_hash,
      sealCols.occurred_at,
    );
    const sealSig = signRecord(sealChainHash, null);

    insertSeal.run({
      ...sealCols,
      chain_hash: sealChainHash,
      chain_payload_version: CHAIN_PAYLOAD_VERSION,
      signature: sealSig?.signature ?? null,
      signature_alg: sealSig?.alg ?? null,
      signature_key_id: sealSig?.keyId ?? null,
      seals_decision_id: row.decision_id,
    });
  });

  sealTx.immediate();

  const updated = db.prepare('SELECT * FROM decision_events WHERE id = ?').get(row.id) as EventRow;

  return c.json({
    data: {
      approvalId: `apr_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
      decisionId: updated.decision_id,
      approver: { id: approver.id, type: approver.type || 'human', name: approver.name },
      result: approvalResult,
      reason: reason || undefined,
      evidenceLevel,
      // 🪤 이 값이 chain_hash 를 돌려주고 있었다 — 이름과 값이 달랐다(codex 지적).
      sealHash,
      sealRecord: { evidenceId: sealEvidenceId, chainIndex: sealCols.chain_index },
      sealedAt: approvalResult === 'approved' ? now : undefined,
      createdAt: now,
    },
  });
});

// ─── Helpers ───────────────────────────────────────────────────────

interface EventRow {
  id: string;
  decision_id: string;
  type: string;
  source_type: string;
  status: string;
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
  evidence_id: string | null;
  evidence_level: string | null;
  chain_hash: string | null;
  chain_index: number | null;
  previous_hash: string | null;
  chain_domain: string;
  approver_id: string | null;
  approver_type: string | null;
  approver_name: string | null;
  approval_result: string | null;
  approval_reason: string | null;
  approved_at: string | null;
  occurred_at: string;
  tags: string | null;
  metadata: string | null;
  sealed_at: string | null;
  tenant_id: string;
  created_at: string;
  updated_at: string;
}

function formatEvent(row: EventRow) {
  return {
    id: row.id,
    decisionId: row.decision_id,
    type: row.type,
    sourceType: row.source_type,
    status: row.status,
    actor: {
      id: row.actor_id,
      type: row.actor_type,
      name: row.actor_name || undefined,
      metadata: row.actor_metadata ? JSON.parse(row.actor_metadata) : undefined,
    },
    action: {
      type: row.action_type,
      description: row.action_description || undefined,
      input: row.action_input ? JSON.parse(row.action_input) : undefined,
      output: row.action_output ? JSON.parse(row.action_output) : undefined,
      metadata: row.action_metadata ? JSON.parse(row.action_metadata) : undefined,
    },
    occurredAt: row.occurred_at,
    aiContext: row.ai_model ? {
      model: row.ai_model,
      provider: row.ai_provider || undefined,
      confidence: row.ai_confidence || undefined,
      promptHash: row.ai_prompt_hash || undefined,
      reasoning: row.ai_reasoning || undefined,
      tokens: (row.ai_tokens_input || row.ai_tokens_output)
        ? { input: row.ai_tokens_input || undefined, output: row.ai_tokens_output || undefined }
        : undefined,
    } : undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    tags: row.tags ? JSON.parse(row.tags) : [],
    evidence: row.evidence_id ? {
      id: row.evidence_id,
      status: row.sealed_at ? 'sealed' : 'pending',
      chainHash: row.chain_hash || undefined,
      chainIndex: row.chain_index ?? undefined,
    } : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
