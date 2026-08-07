/**
 * Cronozen Proof Cloud API — 부팅
 *
 * 라우트 정의는 app.ts. 이 파일은 포트를 잡고, 초기 키를 만들고, 상태를 로그로 말한다.
 *
 * Endpoints:
 *   POST   /decision-events
 *   GET    /decision-events
 *   GET    /decision-events/:id
 *   POST   /decision-events/:id/approvals
 *   GET    /evidence/:id
 *   GET    /evidence/:id/export
 *   GET    /verify/:id            — 공개 검증 (해시 재계산 + 체인 연결 + 봉인 + 서명)
 *   GET    /verify/public-key     — 검증용 공개키
 *
 * Auth: Bearer token (API key)
 * Storage: SQLite (MVP) → PostgreSQL (prod)
 * Hash Chain: @cronozen/dpu-core
 *
 * @version 0.1.0
 */

import { serve } from '@hono/node-server';
import { app } from './app.js';
import { createApiKey } from './middleware/auth.js';
import { getDB } from './db/connection.js';
import { getSigner } from './lib/signing.js';
import { startAnchorScheduler } from './lib/anchor-scheduler.js';

const port = parseInt(process.env.PORT || '3200');

// DB 초기화 + 기본 API 키 생성
const db = getDB();
const hasKeys = db.prepare('SELECT COUNT(*) as count FROM api_keys').get() as { count: number };

if (hasKeys.count === 0) {
  const { key } = createApiKey('default', 'Default API Key');
  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log('  Cronozen Proof API — Initial Setup');
  console.log('═══════════════════════════════════════════');
  console.log(`  API Key: ${key}`);
  console.log('  Save this key — it won\'t be shown again.');
  console.log('═══════════════════════════════════════════');
  console.log('');
}

// 서명 상태를 부팅 로그에 소리내어 말한다.
// "서명하고 있다고 믿었는데 안 하고 있었다"가 이 조직에서 반복된 실패 방식이다.
const signer = getSigner();
if (signer) {
  console.log(`Server signature: ACTIVE (Ed25519, keyId=${signer.keyId})`);
} else {
  console.log('Server signature: NOT CONFIGURED — records are verified by hash chain only.');
  console.log('  → Generate a key: npm run keygen --workspace=api-server');
}

// 앵커 스케줄러는 **부팅에서만** 시작한다 — 테스트가 import 만으로 네트워크를 타면 안 된다.
startAnchorScheduler(db);

serve({ fetch: app.fetch, port }, () => {
  console.log(`Cronozen Proof API running on http://localhost:${port}`);
  console.log(`Health: http://localhost:${port}/health`);
  console.log(`Verify: http://localhost:${port}/verify/:id`);
});

export default app;
