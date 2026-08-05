/**
 * File Proof API
 *
 * POST   /files/upload     — Upload file → auto-create DPU event
 * GET    /files/:id        — Get file metadata + proof info
 * GET    /files            — List files for tenant
 *
 * 핵심 흐름:
 * 1. 파일 수신
 * 2. SHA-256 해시 계산
 * 3. 동일 해시 중복 체크 (같은 파일이면 skip)
 * 4. 이전 버전 탐색 (같은 파일명 → version linking)
 * 5. 파일 저장 (로컬 MVP, S3 확장 예정)
 * 6. file_change DPU 이벤트 자동 생성
 * 7. 응답: 파일 메타 + DPU + 체인 해시
 */

import { Hono } from 'hono';
import { getDB } from '../db/connection.js';
import { computeChainHash } from '@cronozen/dpu-core';
import { CHAIN_PAYLOAD_VERSION, buildChainContentV3 } from '../lib/chain-content.js';
import { signRecord } from '../lib/signing.js';
import type { AuthContext } from '../middleware/auth.js';
import type { QuotaInfo } from '../middleware/quota.js';
import { calculateExpiresAt, checkStorageLimit } from '../services/retention.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../../data/uploads');

type Env = { Variables: { auth: AuthContext; quota?: QuotaInfo } };

export const filesRouter = new Hono<Env>();

// ─── POST /files/upload ───────────────────────────────────────────

filesRouter.post('/upload', async (c) => {
  const auth = c.get('auth');

  const formData = await c.req.formData();
  const file = formData.get('file') as File | null;
  const domain = (formData.get('domain') as string) || 'default';
  const description = formData.get('description') as string | null;

  if (!file) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'file is required (multipart/form-data)' } },
      400,
    );
  }

  // 1. 파일 내용 읽기 + SHA-256 해시
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

  const db = getDB();

  // 2. 동일 해시 중복 체크
  const duplicate = db
    .prepare('SELECT id, decision_event_id FROM proof_files WHERE file_hash = ? AND tenant_id = ?')
    .get(fileHash, auth.tenantId) as { id: string; decision_event_id: string } | undefined;

  if (duplicate) {
    return c.json({
      data: {
        fileId: duplicate.id,
        duplicate: true,
        message: 'Identical file already exists',
        decisionEventId: duplicate.decision_event_id,
      },
    });
  }

  // 3. 스토리지 한도 체크
  const quota = c.get('quota');
  const tier = quota?.tier ?? 'proof_free';
  const storageCheck = checkStorageLimit(auth.tenantId, tier, buffer.length);
  if (!storageCheck.allowed) {
    return c.json({
      error: {
        code: 'STORAGE_LIMIT_EXCEEDED',
        message: `Storage limit exceeded (${storageCheck.usedMB}MB / ${storageCheck.limitMB}MB)`,
      },
      storage: storageCheck,
    }, 413);
  }

  // 4. 이전 버전 탐색 (같은 파일명)
  const previousVersion = db
    .prepare(
      'SELECT id, version_number, file_hash FROM proof_files WHERE filename = ? AND tenant_id = ? ORDER BY version_number DESC LIMIT 1',
    )
    .get(file.name, auth.tenantId) as { id: string; version_number: number; file_hash: string } | undefined;

  const versionNumber = previousVersion ? previousVersion.version_number + 1 : 1;
  const parentFileId = previousVersion?.id ?? null;

  // 4. 파일 저장
  const tenantDir = path.join(UPLOAD_DIR, auth.tenantId);
  if (!fs.existsSync(tenantDir)) {
    fs.mkdirSync(tenantDir, { recursive: true });
  }

  const fileId = crypto.randomUUID();
  const ext = path.extname(file.name) || '';
  const storageName = `${fileId}${ext}`;
  const storagePath = path.join(auth.tenantId, storageName);
  const fullPath = path.join(UPLOAD_DIR, storagePath);

  fs.writeFileSync(fullPath, buffer);

  // 5. DPU 이벤트 자동 생성 (file_change)
  const eventId = crypto.randomUUID();
  const decisionId = `dec_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const evidenceId = `evi_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const now = new Date().toISOString();

  // 🔑 컬럼값을 먼저 확정 → 그 객체에서 해시. 검증기가 DB 행을 같은 빌더에 넣는다.
  //    chain_index / previous_hash 는 아래 트랜잭션 안에서 채운다 — 체인의 끝은
  //    읽는 순간과 쓰는 순간 사이에 움직일 수 있다.
  //    파일 이벤트는 file_hash가 action_metadata 안에 들어가므로 그 JSON 문자열이 해시에 묶인다.
  const eventCols = {
    id: eventId,
    decision_id: decisionId,
    type: 'file_change',
    source_type: 'manual',
    status: 'recorded',

    actor_id: auth.tenantId,
    actor_type: 'human',
    actor_name: null,
    actor_metadata: null,

    action_type: 'UPLOAD',
    action_description: description || `File uploaded: ${file.name}`,
    action_input: null,
    action_output: null,
    action_metadata: JSON.stringify({
      fileId,
      filename: file.name,
      fileHash,
      sizeBytes: buffer.length,
      mimeType: file.type,
      version: versionNumber,
    }),

    ai_model: null,
    ai_provider: null,
    ai_confidence: null,
    ai_prompt_hash: null,
    ai_reasoning: null,
    ai_tokens_input: null,
    ai_tokens_output: null,
    ai_metadata: null,

    evidence_id: evidenceId,
    evidence_level: 'DRAFT',
    chain_index: -1,                      // 트랜잭션 안에서 확정
    previous_hash: null as string | null, // 〃
    chain_domain: domain,

    occurred_at: now,
    tags: JSON.stringify(['file', 'upload']),
    metadata: JSON.stringify({ domain, fileId }),

    tenant_id: auth.tenantId,
    api_key_id: auth.apiKeyId,
    created_at: now,
    updated_at: now,
  };


  // diff 요약 (이전 버전이 있으면)
  const diffSummary = previousVersion
    ? JSON.stringify({
        previousHash: previousVersion.file_hash,
        currentHash: fileHash,
        versionChange: `v${previousVersion.version_number} → v${versionNumber}`,
      })
    : null;

  // 6. DB 저장 — 트랜잭션으로 파일 + 이벤트 동시 저장
  const expiresAt = calculateExpiresAt(tier, now);

  const insertFile = db.prepare(`
    INSERT INTO proof_files (
      id, tenant_id, decision_event_id,
      filename, mime_type, size_bytes, file_hash,
      parent_file_id, version_number, diff_summary,
      storage_path, storage_type, expires_at,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', ?, ?)
  `);

  const insertEvent = db.prepare(`
    INSERT INTO decision_events (
      id, decision_id, type, source_type, status,
      actor_id, actor_type, actor_name, actor_metadata,
      action_type, action_description, action_input, action_output, action_metadata,
      ai_model, ai_provider, ai_confidence, ai_prompt_hash, ai_reasoning,
      ai_tokens_input, ai_tokens_output, ai_metadata,
      evidence_id, evidence_level, chain_hash, chain_index, previous_hash, chain_domain,
      chain_payload_version, signature, signature_alg, signature_key_id,
      occurred_at, tags, metadata,
      tenant_id, api_key_id, created_at, updated_at
    ) VALUES (
      @id, @decision_id, @type, @source_type, @status,
      @actor_id, @actor_type, @actor_name, @actor_metadata,
      @action_type, @action_description, @action_input, @action_output, @action_metadata,
      @ai_model, @ai_provider, @ai_confidence, @ai_prompt_hash, @ai_reasoning,
      @ai_tokens_input, @ai_tokens_output, @ai_metadata,
      @evidence_id, @evidence_level, @chain_hash, @chain_index, @previous_hash, @chain_domain,
      @chain_payload_version, @signature, @signature_alg, @signature_key_id,
      @occurred_at, @tags, @metadata,
      @tenant_id, @api_key_id, @created_at, @updated_at
    )
  `);

  // 🔴 체인의 끝 읽기도 이 트랜잭션 **안**에 있어야 한다. 밖에서 읽으면 동시 업로드 둘이
  //    같은 chain_index 를 받아 체인이 조용히 갈라진다. `.immediate()` 로 시작 시점에
  //    쓰기 락을 잡는다(기본 deferred 는 첫 쓰기까지 락을 미뤄 read-then-write 경합을 못 막는다).
  // 응답에 실어 보낼 체인 값. 트랜잭션 안에서 확정되므로 밖에서 받아둔다.
  let insertedChainHash = '';

  const transaction = db.transaction(() => {
    const lastInChain = db
      .prepare(
        'SELECT chain_hash, chain_index FROM decision_events WHERE chain_domain = ? AND tenant_id = ? ORDER BY chain_index DESC LIMIT 1',
      )
      .get(domain, auth.tenantId) as { chain_hash: string; chain_index: number } | undefined;

    eventCols.previous_hash = lastInChain?.chain_hash || null;
    eventCols.chain_index = (lastInChain?.chain_index ?? -1) + 1;

    const chainHash = computeChainHash(
      buildChainContentV3(eventCols),
      eventCols.previous_hash,
      eventCols.occurred_at,
    );
    const sig = signRecord(chainHash, null);
    insertedChainHash = chainHash;

    insertFile.run(
      fileId, auth.tenantId, eventId,
      file.name, file.type || null, buffer.length, fileHash,
      parentFileId, versionNumber, diffSummary,
      storagePath, expiresAt,
      now,
    );

    insertEvent.run({
      ...eventCols,
      chain_hash: chainHash,
      chain_payload_version: CHAIN_PAYLOAD_VERSION,
      signature: sig?.signature ?? null,
      signature_alg: sig?.alg ?? null,
      signature_key_id: sig?.keyId ?? null,
    });
  });

  transaction.immediate();

  // 7. 응답
  return c.json({
    data: {
      file: {
        id: fileId,
        filename: file.name,
        mimeType: file.type,
        sizeBytes: buffer.length,
        fileHash,
        version: versionNumber,
        parentFileId,
        diffSummary: diffSummary ? JSON.parse(diffSummary) : null,
      },
      proof: {
        decisionId,
        evidenceId,
        chainHash: insertedChainHash,
        chainIndex: eventCols.chain_index,
        previousHash: eventCols.previous_hash,
        domain,
        type: 'file_change',
        sourceType: 'manual',
      },
    },
    ...(quota ? { quota } : {}),
  }, 201);
});

// ─── GET /files ───────────────────────────────────────────────────

filesRouter.get('/', async (c) => {
  const auth = c.get('auth');
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);
  const offset = parseInt(c.req.query('offset') || '0');
  const filename = c.req.query('filename');

  const db = getDB();
  let where = 'WHERE tenant_id = ?';
  const params: unknown[] = [auth.tenantId];

  if (filename) {
    where += ' AND filename = ?';
    params.push(filename);
  }

  const total = (db.prepare(`SELECT COUNT(*) as count FROM proof_files ${where}`).get(...params) as { count: number }).count;
  const rows = db.prepare(`SELECT * FROM proof_files ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);

  return c.json({
    data: rows,
    pagination: { total, limit, offset, hasMore: offset + limit < total },
  });
});

// ─── GET /files/:id ───────────────────────────────────────────────

filesRouter.get('/:id', async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');

  const db = getDB();
  const file = db
    .prepare('SELECT * FROM proof_files WHERE id = ? AND tenant_id = ?')
    .get(id, auth.tenantId);

  if (!file) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'File not found' } }, 404);
  }

  // 연결된 DPU 이벤트도 함께 조회
  const event = db
    .prepare('SELECT decision_id, chain_hash, chain_index, evidence_level, status FROM decision_events WHERE id = ?')
    .get((file as Record<string, unknown>).decision_event_id);

  return c.json({
    data: {
      file,
      proof: event || null,
    },
  });
});
