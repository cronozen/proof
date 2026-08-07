/**
 * 공격 목록 전체를 하네스로 돌린다.
 *
 * 개별 `it()` 로 흩어져 있던 결함주입을 `attacks.ts` 의 표 하나로 모았다.
 * 구조를 바꿀 때(예: 봉인을 체인 레코드로 승격) 여기 한 번만 돌리면
 * 무엇이 깨지고 무엇이 여전히 막히는지 표로 나온다.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { generateKeyPairSync } from 'crypto';
import type { AttackResult, HarnessDeps } from './attack-harness.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-attack-suite-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
delete process.env.PROOF_ACCEPT_LEGACY_UNBOUND;

const { privateKey } = generateKeyPairSync('ed25519');
process.env.PROOF_SIGNING_PRIVATE_KEY = Buffer.from(
  privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  'utf8',
).toString('base64');

const { app } = await import('../app.js');
const { getDB } = await import('../db/connection.js');
const { createApiKey } = await import('../middleware/auth.js');
const { ATTACKS } = await import('./attacks.js');
const { runAttack, formatResults } = await import('./attack-harness.js');

const db = getDB();
const { key: API_KEY } = createApiKey('tenant-attack', 'attack suite key');

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

let seq = 0;

const deps: HarnessDeps = {
  db,
  async record(domain) {
    seq += 1;
    const res = await app.fetch(
      new Request('http://localhost/decision-events', {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'ai_decision',
          actor: { id: 'agent-1', type: 'ai', name: 'Claude' },
          action: {
            type: 'APPROVE_CLAIM',
            description: `청구 자동 승인 #${seq}`,
            input: { claimId: `clm_${seq}` },
            output: { decision: 'approved', payout: 1_200_000 },
          },
          aiContext: { model: 'claude-opus-5', reasoning: '수급 요건 충족' },
          metadata: { domain },
        }),
      }),
    );
    const body = (await res.json()) as any;
    assert.equal(res.status, 201, `record failed: ${JSON.stringify(body)}`);
    return { evidenceId: body.data.evidence.id, decisionId: body.data.decisionId };
  },

  async approve(decisionId, result) {
    const res = await app.fetch(
      new Request(`http://localhost/decision-events/${decisionId}/approvals`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approver: { id: 'director-1', type: 'human', name: '조현주' },
          result,
          reason: '규정 검토 완료',
        }),
      }),
    );
    assert.equal(res.status, 200, `approve failed: ${await res.text()}`);
  },

  async verify(evidenceId) {
    const res = await app.fetch(new Request(`http://localhost/verify/${evidenceId}`));
    return (await res.json()) as any;
  },
};

// ─── 실행 ──────────────────────────────────────────────────────────

const results: AttackResult[] = [];

describe('🎯 적대적 검증 하네스 — 공격 목록 전체', () => {
  for (const attack of ATTACKS) {
    const label = attack.knownGap ? `🔴갭 ${attack.id} — ${attack.what}` : `${attack.id} — ${attack.what}`;

    it(label, async () => {
      const result = await runAttack(deps, attack);
      results.push(result);

      assert.ok(
        result.baselineVerified,
        `기준선이 통과하지 못했다 — 항상 false 를 뱉는 엔진도 공격 테스트는 통과한다: ${result.note}`,
      );
      assert.ok(result.passed, result.note ?? '판정 실패');
    });
  }

  it('요약 — 사람이 읽는 형태', () => {
    console.log('\n' + formatResults(results) + '\n');

    // 하네스가 스스로를 지키는 불변식: 목록이 비면 안 되고, 기준선이 하나라도 실패하면 안 된다.
    assert.ok(results.length >= 15, `공격 목록이 너무 적다 (${results.length})`);
    assert.ok(results.every(r => r.baselineVerified), '기준선이 실패한 공격이 있다');
  });
});

// ─── 하네스 자체의 성질 ────────────────────────────────────────────

describe('하네스가 스스로 지키는 것', () => {
  it('알려진 갭은 목록에 남아 있어야 한다 (지우면 없는 문제가 된다)', () => {
    const gaps = ATTACKS.filter(a => a.knownGap);
    assert.ok(gaps.length > 0, '알려진 갭이 하나도 없다 — 정말 다 막았는지 의심하라');
    for (const g of gaps) {
      assert.ok(g.knownGap!.needs, `${g.id}: 무엇이 있어야 막히는지 적혀 있지 않다`);
    }
  });

  it('모든 공격이 어느 검사가 잡아야 하는지 지목한다', () => {
    for (const a of ATTACKS) {
      assert.ok(a.detectedBy, `${a.id}: detectedBy 없음`);
      assert.ok(a.impact.length > 10, `${a.id}: impact 가 비었다 — 감사에서 읽히는 문장이다`);
    }
  });
});
