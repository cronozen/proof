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

  // 해시 체인 계산
  const lastInChain = db
    .prepare('SELECT chain_hash, chain_index FROM decision_events WHERE chain_domain = ? AND tenant_id = ? ORDER BY chain_index DESC LIMIT 1')
    .get(chainDomain, auth.tenantId) as { chain_hash: string; chain_index: number } | undefined;

  const previousHash = lastInChain?.chain_hash || null;
  const chainIndex = (lastInChain?.chain_index ?? -1) + 1;

  const evidenceId = `evi_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

  // source_type 자동 추론: aiContext가 있으면 'ai', 명시적 값 우선
  const resolvedSourceType = sourceType
    || (aiContext ? 'ai' : 'manual');

  // 🔑 컬럼값을 먼저 확정한 뒤 그 객체에서 해시를 뽑는다.
  //    검증기(lib/verification.ts)는 DB 행을 같은 빌더에 넣으므로,
  //    기록 시점과 검증 시점의 입력이 같은 모양임이 구조적으로 보장된다.
  //    해시를 별도 리터럴로 따로 계산하면 바로 여기서 두 경로가 갈라진다.
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
    chain_index: chainIndex,
    previous_hash: previousHash,
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

  const chainHash = computeChainHash(
    buildChainContentV3(cols),
    previousHash,
    cols.occurred_at,
  );

  // 서명 키가 없으면 null — 서명한 척하지 않는다. 검증 응답이 그 상태를 그대로 말한다.
  const sig = signRecord(chainHash, null);

  db.prepare(`
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
  `).run({
    ...cols,
    chain_hash: chainHash,
    chain_payload_version: CHAIN_PAYLOAD_VERSION,
    signature: sig?.signature ?? null,
    signature_alg: sig?.alg ?? null,
    signature_key_id: sig?.keyId ?? null,
  });

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

  db.prepare(`
    UPDATE decision_events SET
      status = @status,
      evidence_level = @evidence_level,
      approver_id = @approver_id,
      approver_type = @approver_type,
      approver_name = @approver_name,
      approval_result = @approval_result,
      approval_reason = @approval_reason,
      approved_at = @approved_at,
      sealed_at = @sealed_at,
      seal_hash = @seal_hash,
      signature = @signature,
      signature_alg = @signature_alg,
      signature_key_id = @signature_key_id,
      updated_at = @updated_at
    WHERE id = @id
  `).run({
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

  const updated = db.prepare('SELECT * FROM decision_events WHERE id = ?').get(row.id) as EventRow;

  return c.json({
    data: {
      approvalId: `apr_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
      decisionId: updated.decision_id,
      approver: { id: approver.id, type: approver.type || 'human', name: approver.name },
      result: approvalResult,
      reason: reason || undefined,
      evidenceLevel,
      sealedHash: approvalResult === 'approved' ? updated.chain_hash : undefined,
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
