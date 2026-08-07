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

/**
 * 🔴 배포 범위 플래그 — **기본 꺼짐**
 *
 * ## 왜 있나 (2026-08-05)
 *
 * 라이브 배포본이 main 보다 오래된 이미지였다. 실측: `/files`·`/integrations/status`·
 * `/webhooks/google-drive` 가 전부 404 — 2026-04-07 커밋(파일 증빙·Drive 연동·쿼타)이
 * **한 번도 배포된 적 없다.**
 *
 * 검증 엔진을 배포하려면 그 미배포분이 통째로 같이 켜진다. 그 중에는
 * **무인증 공개 웹훅**과 **평문 OAuth 토큰 저장**이 들어 있고, 그건 이번에 실사한 적이 없다.
 * 실사하지 않은 것을 실사한 것에 태워 보내면 오늘의 실사가 의미를 잃는다.
 *
 * 그래서 지우지 않고 **끈다.** 지우면 main 과 갈라지고 나중에 되살릴 때 또 위험해진다.
 * 끄면 배포되는 표면이 지금 프로덕션과 동일해진다(검증 엔드포인트만 추가).
 * 각 기능은 자기 실사를 통과한 뒤 플래그로 따로 켠다.
 */
function flagOn(name: string): boolean {
  return ['1', 'true', 'yes'].includes((process.env[name] || '').trim().toLowerCase());
}

export interface AppFeatures {
  /** `/files/*` — 파일 증빙 업로드. 256MB 단일 머신의 로컬 디스크에 쓴다. */
  files: boolean;
  /** `/integrations/*` + `/webhooks/*` — Google Drive 연동. 무인증 웹훅 + 평문 OAuth 토큰. */
  drive: boolean;
  /** `/decision-events` 의 쿼타 게이트. proof_free 는 100건 한도 — 켜면 기존 테넌트가 막힐 수 있다. */
  quota: boolean;
}

export function resolveFeatures(): AppFeatures {
  return {
    files: flagOn('PROOF_ENABLE_FILES'),
    drive: flagOn('PROOF_ENABLE_DRIVE'),
    quota: flagOn('PROOF_ENABLE_QUOTA'),
  };
}

export function createApp(features: AppFeatures = resolveFeatures()) {
const app = new Hono();

// ─── Global Middleware ─────────────────────────────────────────────

app.use('*', cors());
app.use('*', logger());

// ─── Root + Health Check (unauthenticated) ─────────────────────────

app.get('/', (c) => {
  return c.json({
    name: 'Cronozen Proof API',
    version: '0.1.0',
    docs: 'https://github.com/cronozen/proof',
    // 실제로 마운트된 것만 싣는다. 없는 경로를 광고하면 문서가 거짓말이 된다.
    endpoints: {
      health: '/health',
      decisions: '/decision-events',
      evidence: '/evidence/:id',
      verify: '/verify/:id',
      verifyPublicKey: '/verify/public-key',
      verifyChain: '/decision-events/verify-chain/:domain',
      ...(features.files ? { files: '/files/upload' } : {}),
      ...(features.drive
        ? {
            integrations: '/integrations/google-drive/connect',
            webhooks: '/webhooks/google-drive',
          }
        : {}),
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
//
// 🔴 무인증 공개 엔드포인트다. 실사 전에는 마운트하지 않는다.
if (features.drive) {
  app.route('/webhooks', webhooksRouter);
}

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

  // 🔴 Coverage 는 옵트인이다 (`?coverage=1`).
  //
  // 이 라우트는 무인증이고, computeCoverage 는 같은 체인의 레코드를 최대 COVERAGE_SCAN_LIMIT 건
  // **재검증**한다(각 건마다 링크 조회 2회 + SHA-256 여러 번). 요청 한 번이 수천 쿼리가 되고,
  // 배포본은 shared-cpu-1x / 256MB 단일 머신이다. 무인증 루프 하나로 유일한 머신을 재울 수 있다.
  // 검증자에게 꼭 필요한 건 이 레코드의 판정이고, Coverage 는 화면이 필요할 때만 요청하면 된다.
  const wantCoverage = ['1', 'true', 'yes'].includes((c.req.query('coverage') || '').toLowerCase());
  const coverage = wantCoverage ? computeCoverage(db, row) : null;

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
      // 승인이 무엇에 결속돼 있는가 — 'chain' 이어야 외부 앵커가 승인까지 덮는다.
      sealBinding: result.checks.seal.binding,
    },

    coverage: coverage
      ? {
          totalEvents: coverage.totalEvents,
          verifiedEvents: coverage.verifiedEvents,
          // 이벤트 **이름**은 내보내지 않는다("심사반려"·"정산보류" 자체가 운영 정보다).
          ...(coverage.truncated
            ? { truncated: true, scanned: coverage.scanned, note: `Coverage computed over the first ${coverage.scanned} events.` }
            : {}),
        }
      : { computed: false, hint: 'Add ?coverage=1 to compute chain coverage (costlier).' },

    limitations: [
      'This endpoint proves that the record we hold is internally consistent with the hashes we hold.',
      'It is not third-party attestation: there is no RFC 3161 trusted timestamp and no external anchor yet.',
      // 🔴 서명이 없으면 해시 재계산은 **DB 를 쓸 수 있는 사람** 앞에서 무력하다.
      //    그 사람은 내용을 바꾸고 해시도 다시 계산하면 그만이다.
      //    "unaltered since recording" 이라고 단언하면 그 사실을 덮는다.
      ...(result.checks.serverSignature.status === 'valid'
        ? [
            'A valid server signature is present: forging this record requires the signing key, not just database write access. ' +
              'Verify it yourself with the public key at /verify/public-key.',
          ]
        : [
            'WARNING: no valid server signature on this record. Hash recomputation alone does NOT stop someone with ' +
              'database write access — they can change the content and recompute the hash. Treat this as an integrity ' +
              'check against accidental change, not as proof against a determined insider.',
          ]),
      // 🔴 이전의 정당한 상태로 **되돌리는 것**은 안에서 탐지할 수 없다.
      //    승인 전 서명값을 보관했다가 승인 필드를 지우고 그 서명을 복원하면,
      //    메시지가 그 시점과 바이트 단위로 같아서 서명이 그대로 맞는다. 꼬리 절단과 같은 계열이다.
      'Rollback to an earlier legitimate state (for example removing an approval and restoring the pre-approval ' +
        'signature) is not detectable from inside the database. Detecting it requires an external anchor.',
      // 🔴 꼬리 절단은 구조적으로 탐지 불가다. 마지막 N건을 지우면 남은 체인은
      //    인덱스가 연속이고 링크도 맞아 "정상"으로 보인다. 안에서는 풀 수 없는 문제 —
      //    체인의 머리를 밖에 박아두는 외부 앵커가 있어야 한다.
      //    이걸 안 적으면 "verified"가 "아무것도 삭제되지 않았다"로 읽힌다.
      'Truncation is not detectable: if the most recent records were deleted, the remaining chain still ' +
        'verifies. Detecting a missing tail requires an external anchor, which is not implemented yet.',
      // 🔴 v2 레코드의 "verified: true" 는 실제보다 훨씬 강하게 읽힌다.
      //    해시가 3개 필드만 덮으므로 산출물·AI 근거·승인 결과는 결속되어 있지 않다.
      //    이 사실을 조용히 두면 검증이 없는 것보다 나쁘다.
      ...(result.checks.chainHash.contentBound === false
        ? [
            'WARNING: this is a legacy record. Its hash covers only the event type, action type and actor — ' +
              'the outcome, AI reasoning and approval fields are NOT cryptographically bound. ' +
              'Treat "verified" as "this record exists in the chain unmodified in those three fields" only.',
          ]
        : []),
    ],
  });
});

// ─── Authenticated Routes ──────────────────────────────────────────

app.use('/decision-events/*', authMiddleware);
if (features.quota) app.use('/decision-events/*', quotaMiddleware());
app.use('/evidence/*', authMiddleware);

if (features.files) {
  app.use('/files/*', authMiddleware);
  if (features.quota) app.use('/files/*', quotaMiddleware());
}

if (features.drive) {
  // OAuth callback은 인증 불필요 (Google이 리다이렉트) — 나머지는 인증 필요
  app.use('/integrations/google-drive/connect', authMiddleware);
  app.use('/integrations/google-drive/folders', authMiddleware);
  app.use('/integrations/google-drive/watch', authMiddleware);
  app.use('/integrations/google-drive/disconnect', authMiddleware);
  app.use('/integrations/status', authMiddleware);
}

app.route('/decision-events', decisionsRouter);
app.route('/evidence', evidenceRouter);
if (features.files) app.route('/files', filesRouter);
if (features.drive) app.route('/integrations', integrationsRouter);

  return app;
}

export const app = createApp();
export default app;
