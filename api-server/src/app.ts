/**
 * Cronozen Proof Cloud API — 라우트 정의
 *
 * ## 왜 index.ts 에서 분리됐나 (2026-08-05)
 *
 * index.ts 는 import 되는 순간 `serve()` 를 호출해 실제 포트를 잡았다.
 * 그래서 테스트가 앱을 import 할 수 없었고, 검증 엔드포인트를 테스트하려면
 * 라우트를 테스트 파일에 **복제**해야 했다 — 복제한 라우트를 테스트하면
 * 진짜 라우트가 깨져도 초록이 뜬다. 이 레포에서 반복된 실패 방식이라 여기서 끊는다.
 *
 * 이 파일: 앱 조립(부작용 없음). index.ts: 부팅(포트·키·로그).
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { authMiddleware } from './middleware/auth.js';
import { quotaMiddleware } from './middleware/quota.js';
import { decisionsRouter } from './routes/decisions.js';
import { evidenceRouter } from './routes/evidence.js';
import { filesRouter } from './routes/files.js';
import { integrationsRouter, webhooksRouter } from './routes/integrations.js';
import { getDB } from './db/connection.js';
import { computeCoverage, verifyRecord, type DecisionEventRow } from './lib/verification.js';
import { exportPublicKeyPem } from './lib/signing.js';

export const app = new Hono();

// ─── Global Middleware ─────────────────────────────────────────────

app.use('*', cors());
app.use('*', logger());

// ─── Root + Health Check (unauthenticated) ─────────────────────────

app.get('/', (c) => {
  return c.json({
    name: 'Cronozen Proof API',
    version: '0.1.0',
    docs: 'https://github.com/cronozen/proof',
    endpoints: {
      health: '/health',
      decisions: '/decision-events',
      evidence: '/evidence/:id',
      files: '/files/upload',
      integrations: '/integrations/google-drive/connect',
      webhooks: '/webhooks/google-drive',
      verify: '/verify/:id',
      verifyPublicKey: '/verify/public-key',
    },
  });
});

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  });
});

// ─── Webhooks (unauthenticated — external services call directly) ──

app.route('/webhooks', webhooksRouter);

// ─── Public Verification (unauthenticated) ─────────────────────────

/**
 * 검증용 공개키.
 *
 * 제3자 검증이 성립하려면 검증자가 우리 서버 응답을 믿지 않고도 서명을 확인할 수 있어야 한다.
 * 키가 설정되지 않았으면 그렇다고 말한다 — 없는 능력을 있는 것처럼 적지 않는다.
 *
 * ⚠️ 이 라우트는 반드시 `/verify/:id` **앞에** 있어야 한다. 뒤에 두면 :id 가 먼저 잡아
 *    'public-key' 를 증거 ID로 조회하고 404를 돌려준다.
 */
app.get('/verify/public-key', (c) => {
  const key = exportPublicKeyPem();
  if (!key) {
    return c.json({
      status: 'not_configured',
      detail: 'No server signing key is configured. Records are verified by hash chain only.',
    }, 200);
  }
  return c.json({ status: 'active', ...key });
});

/**
 * 공개 검증.
 *
 * ## 🔴 공개 필드 화이트리스트 — 여기 없는 것은 내보내지 않는다
 *
 * 이 엔드포인트는 인증이 없다. 즉 응답에 들어가는 모든 값은 **전 세계에 공개**된다.
 * `chain_domain`(어느 고객사의 어떤 업무인지), `decision_id`, 행위자·행위 내용은
 * 그 자체가 고객사 운영 정보다. 검증자에게 필요한 건 "이 해시가 맞느냐"이지
 * "무슨 일이 있었느냐"가 아니다.
 *
 * 그래서 `SELECT *` 로 읽되 **응답은 아래 목록으로만 조립한다.**
 * 컬럼이 늘어도 자동으로 새어나가지 않게 하려는 것이다 —
 * 스프레드(`...row`)를 쓰면 다음에 컬럼 하나 추가될 때 조용히 공개된다.
 *
 * 이전 구현은 `verified: !!row.sealed_at` 하나였다. 해시를 다시 계산하지 않았고
 * previous_hash 연결도 보지 않았다. 지금은 lib/verification.ts 가 실제로 검사한다.
 */
app.get('/verify/:id', (c) => {
  const id = c.req.param('id');
  const db = getDB();

  const row = db
    .prepare('SELECT * FROM decision_events WHERE evidence_id = ? OR id = ? OR decision_id = ?')
    .get(id, id, id) as DecisionEventRow | undefined;

  if (!row) {
    return c.json({ verified: false, error: 'Evidence not found' }, 404);
  }

  const result = verifyRecord(db, row);
  const coverage = computeCoverage(db, row);

  return c.json({
    verified: result.verified,
    checks: result.checks,
    failures: result.failures,

    // ── 공개 필드 화이트리스트 (이 아래로만 내보낸다) ──
    evidence: {
      id: row.evidence_id || row.id,
      evidenceLevel: row.evidence_level,
      hashAlgorithm: 'SHA-256',
      chainPayloadVersion: result.chainPayloadVersion,
      chain: {
        hash: row.chain_hash,
        index: row.chain_index,
        previousHash: row.previous_hash,
        // domain 은 의도적으로 제외 — 고객사·업무가 드러난다.
      },
      sealHash: row.seal_hash,
      sealedAt: row.sealed_at || null,
    },

    coverage: {
      totalEvents: coverage.totalEvents,
      verifiedEvents: coverage.verifiedEvents,
      // 이벤트 **이름**은 내보내지 않는다("심사반려"·"정산보류" 자체가 운영 정보다).
      ...(coverage.truncated
        ? { truncated: true, scanned: coverage.scanned, note: `Coverage computed over the first ${coverage.scanned} events.` }
        : {}),
    },

    limitations: [
      'This endpoint proves that the record we hold is internally consistent and unaltered since recording.',
      'It is not third-party attestation: there is no RFC 3161 trusted timestamp and no external anchor yet.',
      'Server signature (when configured) lets you verify independently using the public key at /verify/public-key.',
    ],
  });
});

// ─── Authenticated Routes ──────────────────────────────────────────

app.use('/decision-events/*', authMiddleware);
app.use('/decision-events/*', quotaMiddleware());
app.use('/evidence/*', authMiddleware);
app.use('/files/*', authMiddleware);
app.use('/files/*', quotaMiddleware());
// OAuth callback은 인증 불필요 (Google이 리다이렉트) — 나머지는 인증 필요
app.use('/integrations/google-drive/connect', authMiddleware);
app.use('/integrations/google-drive/folders', authMiddleware);
app.use('/integrations/google-drive/watch', authMiddleware);
app.use('/integrations/google-drive/disconnect', authMiddleware);
app.use('/integrations/status', authMiddleware);

app.route('/decision-events', decisionsRouter);
app.route('/evidence', evidenceRouter);
app.route('/files', filesRouter);
app.route('/integrations', integrationsRouter);

export default app;
