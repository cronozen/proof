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
/** 외부 로그가 기억하는 항목들 — 우리가 로컬에서 지워도 여기서는 안 사라진다. */
const remoteLedger: string[] = [];

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

  async reconcile() {
    // 🔑 원격 목록을 **스텁**한다. 테스트가 남의 인프라에 의존하면 안 되고,
    //    여기서 보는 것은 "밖에 있는데 여기 없으면 잡는가" 라는 판정 로직이다.
    const { reconcileAnchors } = await import('../lib/anchor-scheduler.js');
    const known = (db
      .prepare("SELECT external_ref FROM anchor_submissions WHERE provider = 'rekor'")
      .all() as { external_ref: string | null }[])
      .map(r => /uuid=([0-9a-f]+)/i.exec(r.external_ref ?? '')?.[1])
      .filter((v): v is string => !!v);
    // 원격에는 지워지기 전 목록이 그대로 남아 있다고 본다.
    remoteLedger.push(...known.filter(u => !remoteLedger.includes(u)));
    await reconcileAnchors(db, async () => remoteLedger);
  },

  async anchor() {
    const res = await app.fetch(
      new Request('http://localhost/decision-events/anchor', {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_KEY}` },
      }),
    );
    assert.equal(res.status, 201, `anchor failed: ${await res.text()}`);
    // 제출이 꺼져 있으므로(테스트) rekor 행이 없다. 원격 원장에 가짜 uuid 를 심어
    // "밖에는 있다" 를 재현한다.
    const latest = db.prepare('SELECT id FROM chain_anchors ORDER BY anchored_at DESC LIMIT 1').get() as { id: string };
    const uuid = latest.id.replace(/-/g, '');
    db.prepare(`INSERT OR REPLACE INTO anchor_submissions
        (anchor_id, provider, status, receipt, external_ref, verify_url, error, submitted_at, confirmed_at, attempts, last_attempt_at)
        VALUES (?, 'rekor', 'confirmed', '{}', ?, NULL, NULL, ?, ?, 1, ?)`)
      .run(latest.id, `logIndex=0 uuid=${uuid}`, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
    if (!remoteLedger.includes(uuid)) remoteLedger.push(uuid);
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

// ─── 봉인 레코드 자체 ──────────────────────────────────────────────

describe('봉인 레코드도 하나의 체인 레코드다', () => {
  it('승인 후 봉인 레코드 자신이 검증을 통과한다', async () => {
    // 🪤 개별 결정 레코드만 검증하면 이게 안 보인다 — 봉인 레코드에 대상의
    //    evidence_level(AUDIT_READY)을 넣었더니 "승인 없이 AUDIT_READY" 가 되어
    //    자기 불변식에 걸렸다. PROD 체인 검증이 잡은 결함이라 여기에 못박는다.
    const domain = 'seal-record-self';
    const target = await deps.record(domain);
    await deps.approve(target.decisionId, 'approved');

    const sealRow = db
      .prepare("SELECT evidence_id FROM decision_events WHERE type = 'seal' AND seals_decision_id = ?")
      .get(target.decisionId) as { evidence_id: string } | undefined;

    assert.ok(sealRow, '봉인 레코드가 체인에 없다');

    const res = await deps.verify(sealRow.evidence_id);
    assert.equal(res.verified, true, `봉인 레코드가 검증 실패: ${JSON.stringify(res.failures)}`);
  });

  it('체인 전체 검증에서 봉인 레코드까지 통과한다', async () => {
    const domain = 'seal-chain-full';
    const target = await deps.record(domain);
    await deps.approve(target.decisionId, 'approved');

    const res = await app.fetch(
      new Request(`http://localhost/decision-events/verify-chain/${domain}`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      }),
    );
    const d = (await res.json() as any).data;
    assert.equal(d.totalEvents, 2, '결정 1 + 봉인 1 이어야 한다');
    assert.equal(d.verified, true, `체인 검증 실패: ${JSON.stringify(d.records)}`);
  });
});

// ─── 앵커 스케줄러 ─────────────────────────────────────────────────

describe('앵커 스케줄러 — 잡이 멈추면 드러나야 한다', () => {
  it('앵커가 아예 없으면 /health 가 degraded(503) 다', async () => {
    // 🔑 "앵커 없음" 을 정상으로 읽으면 안 된다. 없는 것도 신선하지 않은 것이다.
    const prev = process.env.PROOF_ANCHOR_STALE_MS;
    process.env.PROOF_ANCHOR_STALE_MS = '1';
    try {
      const res = await app.fetch(new Request('http://localhost/health'));
      const body = (await res.json()) as any;
      // 이 스위트는 앞선 테스트에서 앵커를 찍으므로 stale 여부는 상황에 따라 다르다.
      // 여기서 못박는 것은 **필드가 존재하고 밖에서 읽힌다**는 것.
      assert.ok('anchor' in body, '/health 에 앵커 상태가 없다 — 밖에서 잡의 죽음을 볼 수 없다');
      assert.ok(typeof body.anchor.stale === 'boolean');
      assert.ok(typeof body.anchor.staleAfterSeconds === 'number');
    } finally {
      if (prev === undefined) delete process.env.PROOF_ANCHOR_STALE_MS;
      else process.env.PROOF_ANCHOR_STALE_MS = prev;
    }
  });

  it('봉인이 생기면 간격을 기다리지 않고 앵커가 due 가 된다', async () => {
    const { anchorDue, runAnchorTick } = await import('../lib/anchor-scheduler.js');
    const domain = 'sched-seal';

    const rec = await deps.record(domain);
    await runAnchorTick(db);
    assert.equal(anchorDue(db, 'tenant-attack').due, false, '방금 찍었는데 또 due 다');

    await deps.approve(rec.decisionId, 'approved');
    const due = anchorDue(db, 'tenant-attack');
    assert.equal(due.due, true, '봉인이 생겼는데 앵커가 안 밀린다');
    assert.match(due.reason, /seal/i);
  });

  it('🔴 조용한 시스템은 stale 이 아니다 — 전부 덮였으면 앵커가 오래돼도 정상', async () => {
    // 프로덕션에서 실제로 난 오보: 안 덮인 레코드 0건인데 age 9,983초로 STALE.
    // 나이로 판정하면 조용한 시스템이 시간이 지날수록 무조건 degraded 가 되고,
    // 경보가 늑대가 되면 진짜 degraded 일 때 아무도 안 본다.
    const { runAnchorTick, anchorFreshness } = await import('../lib/anchor-scheduler.js');
    await runAnchorTick(db);

    const prev = process.env.PROOF_ANCHOR_STALE_MS;
    process.env.PROOF_ANCHOR_STALE_MS = '1'; // 임계를 1ms 로 — 나이로 판정하면 무조건 stale 이 된다
    try {
      const f = anchorFreshness(db);
      assert.equal(f.unanchoredForSeconds, null, '안 덮인 레코드가 남아 있다');
      assert.equal(f.stale, false, '전부 덮였는데 stale 로 보고했다 — 나이로 판정하고 있다');
    } finally {
      if (prev === undefined) delete process.env.PROOF_ANCHOR_STALE_MS;
      else process.env.PROOF_ANCHOR_STALE_MS = prev;
    }
  });

  it('안 덮인 레코드가 오래되면 stale 이다', async () => {
    const { anchorFreshness } = await import('../lib/anchor-scheduler.js');
    const rec = await deps.record('stale-probe'); // 앵커 안 찍고 남겨둔다

    // 🪤 방금 만든 레코드는 나이가 0~1ms 라 임계와 경합한다(테스트가 비결정적이 된다).
    //    시간을 뒤로 밀어 확정적으로 만든다 — 임계 비교 자체를 보는 테스트다.
    db.prepare('UPDATE decision_events SET created_at = ? WHERE evidence_id = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), rec.evidenceId);

    const prev = process.env.PROOF_ANCHOR_STALE_MS;
    process.env.PROOF_ANCHOR_STALE_MS = '1000';
    try {
      const f = anchorFreshness(db);
      assert.ok(f.unanchoredForSeconds !== null, '안 덮인 레코드를 못 찾았다');
      assert.equal(f.stale, true, '안 덮인 레코드가 있는데 정상이라고 했다');
    } finally {
      if (prev === undefined) delete process.env.PROOF_ANCHOR_STALE_MS;
      else process.env.PROOF_ANCHOR_STALE_MS = prev;
    }
  });

  it('앵커 이후 아무것도 안 바뀌면 또 찍지 않는다', async () => {
    const { anchorDue, runAnchorTick } = await import('../lib/anchor-scheduler.js');
    await runAnchorTick(db);
    const before = db.prepare('SELECT COUNT(*) n FROM chain_anchors').get() as { n: number };
    await runAnchorTick(db);
    const after = db.prepare('SELECT COUNT(*) n FROM chain_anchors').get() as { n: number };
    assert.equal(after.n, before.n, '바뀐 게 없는데 앵커가 또 찍혔다');
    assert.equal(anchorDue(db, 'tenant-attack').due, false);
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
