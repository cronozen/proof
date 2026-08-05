/**
 * Verification Engine — 결함주입 테스트
 *
 * ## 이 테스트가 지키려는 것
 *
 * "검증기가 있다"는 사실은 아무것도 보장하지 않는다. 이 조직에서 반복된 실패 방식은
 * **가드가 초록인데 아무것도 안 지키고 있던 것**이었고, 그건 결함주입으로만 잡힌다.
 * 그래서 모든 검사는 "정상일 때 통과"가 아니라 **"변조했을 때 실제로 실패하는가"**로 확인한다.
 *
 * 각 케이스는 DB를 직접 조작한다 — 공격자가 DB 쓰기 권한을 얻은 상황을 그대로 재현한다.
 * (이전 구현 `verified: !!row.sealed_at` 은 이 조작들 중 **단 하나도** 잡지 못했다.)
 *
 * 앱을 import 하기 전에 DB_PATH·서명키를 설정해야 하므로 동적 import를 쓴다.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { generateKeyPairSync } from 'crypto';

// ─── 격리된 환경 준비 (import 전에 끝나야 한다) ─────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-verify-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');

const { privateKey } = generateKeyPairSync('ed25519');
process.env.PROOF_SIGNING_PRIVATE_KEY = Buffer.from(
  privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  'utf8',
).toString('base64');

const { app } = await import('../app.js');
const { getDB, initializeDatabase } = await import('../db/connection.js');
const { createApiKey } = await import('../middleware/auth.js');
const { computeChainHash } = await import('@cronozen/dpu-core');
const { default: Database } = await import('better-sqlite3');

const db = getDB();
const { key: API_KEY } = createApiKey('tenant-test', 'test key');

// ─── 헬퍼 ──────────────────────────────────────────────────────────

async function post(url: string, body: unknown) {
  const res = await app.fetch(
    new Request(`http://localhost${url}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as any };
}

async function verify(id: string) {
  const res = await app.fetch(new Request(`http://localhost/verify/${id}`));
  return { status: res.status, body: (await res.json()) as any };
}

let seq = 0;
async function recordEvent(overrides: Record<string, unknown> = {}) {
  seq += 1;
  const { status, body } = await post('/decision-events', {
    type: 'ai_decision',
    actor: { id: 'agent-1', type: 'ai', name: 'Claude' },
    action: {
      type: 'APPROVE_CLAIM',
      description: `청구 건 자동 승인 #${seq}`,
      input: { claimId: `clm_${seq}`, amount: 1_200_000 },
      output: { decision: 'approved', payout: 1_200_000 },
    },
    aiContext: {
      model: 'claude-opus-5',
      provider: 'anthropic',
      confidence: 0.93,
      reasoning: '수급 요건 충족, 중복청구 없음',
    },
    metadata: { domain: 'settlement' },
    ...overrides,
  });
  assert.equal(status, 201, `record failed: ${JSON.stringify(body)}`);
  return body.data;
}

/** 컬럼 하나를 직접 조작하고, 테스트 후 되돌리기 위한 원값을 돌려준다. */
function tamper(evidenceId: string, column: string, value: unknown): unknown {
  const row = db
    .prepare(`SELECT id, ${column} as target FROM decision_events WHERE evidence_id = ?`)
    .get(evidenceId) as { id: string; target: unknown };
  db.prepare(`UPDATE decision_events SET ${column} = ? WHERE id = ?`).run(value as never, row.id);
  return row.target;
}

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── 기준선 ────────────────────────────────────────────────────────

describe('기준선 — 손대지 않은 레코드', () => {
  it('기록 직후 검증을 통과한다 (기록/검증 경로 대칭성)', async () => {
    const event = await recordEvent();
    const { status, body } = await verify(event.evidence.id);

    assert.equal(status, 200);
    assert.equal(body.verified, true, `failures: ${JSON.stringify(body.failures)}`);
    assert.equal(body.checks.chainHash.ok, true);
    assert.equal(body.checks.chainLink.ok, true);
    assert.equal(body.checks.serverSignature.status, 'valid');
    assert.equal(body.evidence.chainPayloadVersion, 3);
  });

  it('RFC 3161은 구현했다고 말하지 않는다', async () => {
    const event = await recordEvent();
    const { body } = await verify(event.evidence.id);
    assert.equal(body.checks.trustedTimestamp.status, 'not_implemented');
  });
});

// ─── 결함주입: 내용 변조 ────────────────────────────────────────────

describe('결함주입 — 레코드 내용 변조', () => {
  it('action_output(산출물)을 바꾸면 검증이 깨진다', async () => {
    const event = await recordEvent();
    tamper(event.evidence.id, 'action_output', JSON.stringify({ decision: 'approved', payout: 99_000_000 }));

    const { body } = await verify(event.evidence.id);
    assert.equal(body.verified, false);
    assert.equal(body.checks.chainHash.ok, false);
  });

  it('ai_reasoning(AI 판단 근거)을 바꾸면 검증이 깨진다', async () => {
    const event = await recordEvent();
    tamper(event.evidence.id, 'ai_reasoning', '요건 미충족이었으나 승인함');

    const { body } = await verify(event.evidence.id);
    assert.equal(body.verified, false);
    assert.equal(body.checks.chainHash.ok, false);
  });

  it('actor_id(행위자)를 바꾸면 검증이 깨진다', async () => {
    const event = await recordEvent();
    tamper(event.evidence.id, 'actor_id', 'someone-else');

    const { body } = await verify(event.evidence.id);
    assert.equal(body.verified, false);
    assert.equal(body.checks.chainHash.ok, false);
  });

  it('occurred_at(발생 시각)을 바꾸면 검증이 깨진다', async () => {
    const event = await recordEvent();
    tamper(event.evidence.id, 'occurred_at', '2020-01-01T00:00:00.000Z');

    const { body } = await verify(event.evidence.id);
    assert.equal(body.verified, false);
    assert.equal(body.checks.chainHash.ok, false);
  });

  it('chain_hash 자체를 바꿔치기해도 통과하지 않는다', async () => {
    const event = await recordEvent();
    tamper(event.evidence.id, 'chain_hash', 'f'.repeat(64));

    const { body } = await verify(event.evidence.id);
    assert.equal(body.verified, false);
  });
});

// ─── 결함주입: 체인 구조 ────────────────────────────────────────────

describe('결함주입 — 체인 구조', () => {
  it('앞 레코드를 삭제하면 뒤 레코드의 연결 검사가 깨진다', async () => {
    const first = await recordEvent();
    const second = await recordEvent();

    // 정상 상태 확인
    assert.equal((await verify(second.evidence.id)).body.checks.chainLink.ok, true);

    db.prepare('DELETE FROM decision_events WHERE evidence_id = ?').run(first.evidence.id);

    const { body } = await verify(second.evidence.id);
    assert.equal(body.verified, false);
    assert.equal(body.checks.chainLink.ok, false);
    assert.match(body.checks.chainLink.detail, /missing|gap/i);
  });

  it('뒤 레코드가 나를 안 가리키면 잡는다 (후행 링크 — 앞만 보면 통과했던 구멍)', async () => {
    const domain = 'next-link';
    const first = await recordEvent({ metadata: { domain } });
    const second = await recordEvent({ metadata: { domain } });

    // 첫 레코드는 이 시점에 정상
    assert.equal((await verify(first.evidence.id)).body.checks.chainLink.ok, true);

    // 후속 레코드의 previous_hash 를 다른 값으로 — 첫 레코드 자체는 손대지 않는다.
    tamper(second.evidence.id, 'previous_hash', 'b'.repeat(64));

    const { body } = await verify(first.evidence.id);
    assert.equal(body.verified, false, '후행 링크를 안 보면 여기서 통과한다');
    assert.equal(body.checks.chainLink.ok, false);
    assert.match(body.checks.chainLink.detail, /following record/i);
  });

  it('previous_hash를 다른 값으로 바꾸면 연결 검사가 깨진다', async () => {
    await recordEvent();
    const target = await recordEvent();

    tamper(target.evidence.id, 'previous_hash', 'a'.repeat(64));

    const { body } = await verify(target.evidence.id);
    assert.equal(body.verified, false);
    assert.equal(body.checks.chainLink.ok, false);
  });
});

// ─── 결함주입: 승인 위조 ────────────────────────────────────────────

describe('결함주입 — 승인(봉인) 위조', () => {
  async function recordAndSeal() {
    const event = await recordEvent();
    const { status, body } = await post(`/decision-events/${event.decisionId}/approvals`, {
      approver: { id: 'director-1', type: 'human', name: '조현주' },
      result: 'approved',
      reason: '규정 검토 완료',
    });
    assert.equal(status, 200, `approval failed: ${JSON.stringify(body)}`);
    return event;
  }

  it('봉인된 레코드는 검증을 통과한다', async () => {
    const event = await recordAndSeal();
    const { body } = await verify(event.evidence.id);

    assert.equal(body.verified, true, `failures: ${JSON.stringify(body.failures)}`);
    assert.equal(body.checks.seal.ok, true);
    assert.ok(body.evidence.sealedAt);
  });

  it('승인자 이름을 바꿔치기하면 봉인 검사가 깨진다', async () => {
    const event = await recordAndSeal();
    tamper(event.evidence.id, 'approver_name', '다른사람');

    const { body } = await verify(event.evidence.id);
    assert.equal(body.verified, false);
    assert.equal(body.checks.seal.ok, false);
  });

  it('승인 결과를 rejected → approved 로 뒤집으면 봉인 검사가 깨진다', async () => {
    const event = await recordEvent();
    await post(`/decision-events/${event.decisionId}/approvals`, {
      approver: { id: 'director-1', type: 'human', name: '조현주' },
      result: 'rejected',
      reason: '요건 미충족',
    });

    tamper(event.evidence.id, 'approval_result', 'approved');
    tamper(event.evidence.id, 'evidence_level', 'AUDIT_READY');

    const { body } = await verify(event.evidence.id);
    assert.equal(body.verified, false);
    assert.equal(body.checks.seal.ok, false);
  });

  it('봉인 해시를 지우면(승인 흔적 제거) 검사가 깨진다', async () => {
    const event = await recordAndSeal();
    tamper(event.evidence.id, 'seal_hash', null);

    const { body } = await verify(event.evidence.id);
    assert.equal(body.verified, false);
    assert.equal(body.checks.seal.ok, false);
  });

  it('승인 없이 sealed_at 만 채워 넣으면 검사가 깨진다', async () => {
    const event = await recordEvent();
    tamper(event.evidence.id, 'sealed_at', new Date().toISOString());
    tamper(event.evidence.id, 'evidence_level', 'AUDIT_READY');

    const { body } = await verify(event.evidence.id);
    assert.equal(body.verified, false);
    assert.equal(body.checks.seal.ok, false);
  });
});

// ─── 결함주입: 서명 다운그레이드 ────────────────────────────────────

describe('결함주입 — 서버 서명', () => {
  it('서명을 지우면(다운그레이드) 검증이 깨진다', async () => {
    const event = await recordEvent();
    tamper(event.evidence.id, 'signature', null);

    const { body } = await verify(event.evidence.id);
    assert.equal(body.verified, false);
    assert.equal(body.checks.serverSignature.status, 'missing');
  });

  it('서명을 다른 값으로 바꾸면 검증이 깨진다', async () => {
    const event = await recordEvent();
    tamper(event.evidence.id, 'signature', Buffer.alloc(64, 1).toString('base64'));

    const { body } = await verify(event.evidence.id);
    assert.equal(body.verified, false);
    assert.equal(body.checks.serverSignature.status, 'invalid');
  });

  it('서로 다른 키는 서로 다른 keyId를 갖는다', async () => {
    const { generateSigningKeyPair, resetSignerCache, exportPublicKeyPem } = await import('../lib/signing.js');
    const original = process.env.PROOF_SIGNING_PRIVATE_KEY;
    const seen = new Set<string>();

    try {
      for (let i = 0; i < 3; i += 1) {
        const { privateKeyPem } = generateSigningKeyPair();
        process.env.PROOF_SIGNING_PRIVATE_KEY = Buffer.from(privateKeyPem, 'utf8').toString('base64');
        resetSignerCache();
        seen.add(exportPublicKeyPem()!.keyId);
      }
    } finally {
      process.env.PROOF_SIGNING_PRIVATE_KEY = original;
      resetSignerCache();
    }

    // SPKI DER 앞부분은 모든 Ed25519 키가 공유한다 → 자르기만 하면 전부 같은 ID가 나온다.
    assert.equal(seen.size, 3, `keyId collision: ${[...seen].join(', ')}`);
  });

  it('공개키 엔드포인트가 검증자에게 키를 준다', async () => {
    const res = await app.fetch(new Request('http://localhost/verify/public-key'));
    const body = (await res.json()) as any;

    assert.equal(res.status, 200);
    assert.equal(body.status, 'active');
    assert.equal(body.alg, 'Ed25519');
    assert.match(body.publicKeyPem, /BEGIN PUBLIC KEY/);
  });

  it('public-key 라우트가 :id 보다 먼저 잡힌다 (라우트 순서 회귀 방지)', async () => {
    const res = await app.fetch(new Request('http://localhost/verify/public-key'));
    const body = (await res.json()) as any;
    assert.notEqual(body.error, 'Evidence not found');
  });
});

// ─── 공개 필드 화이트리스트 ─────────────────────────────────────────

describe('공개 필드 화이트리스트', () => {
  it('고객사 운영 정보를 응답에 담지 않는다', async () => {
    const event = await recordEvent();
    const { body } = await verify(event.evidence.id);
    const serialized = JSON.stringify(body);

    // chain_domain — 어느 고객사의 어떤 업무인지 드러난다
    assert.ok(!serialized.includes('settlement'), 'chain_domain leaked');
    // 행위 내용 / 행위자 / 산출물
    assert.ok(!serialized.includes('청구 건 자동 승인'), 'action_description leaked');
    assert.ok(!serialized.includes('agent-1'), 'actor_id leaked');
    assert.ok(!serialized.includes('수급 요건 충족'), 'ai_reasoning leaked');
    assert.ok(!serialized.includes('clm_'), 'action_input leaked');
    // decisionId — 내부 식별자
    assert.ok(!serialized.includes(event.decisionId), 'decisionId leaked');
  });

  it('검증에 필요한 값은 준다', async () => {
    const event = await recordEvent();
    const { body } = await verify(event.evidence.id);

    assert.equal(body.evidence.id, event.evidence.id);
    assert.equal(body.evidence.hashAlgorithm, 'SHA-256');
    assert.ok(body.evidence.chain.hash);
    assert.ok(typeof body.evidence.chain.index === 'number');
    assert.ok(Array.isArray(body.limitations));
  });

  it('Coverage 는 기본으로 계산하지 않는다 (무인증 증폭 방지)', async () => {
    const event = await recordEvent();
    const { body } = await verify(event.evidence.id);

    // 무인증 요청 하나가 체인 전체를 재검증하면 단일 머신을 재울 수 있다.
    assert.equal(body.coverage.computed, false);
    assert.ok(!('totalEvents' in body.coverage));
  });

  it('?coverage=1 을 주면 개수만 준다 — 이벤트 이름은 주지 않는다', async () => {
    const event = await recordEvent();
    const res = await app.fetch(new Request(`http://localhost/verify/${event.evidence.id}?coverage=1`));
    const body = (await res.json()) as any;

    assert.ok(typeof body.coverage.totalEvents === 'number');
    assert.ok(typeof body.coverage.verifiedEvents === 'number');
    assert.ok(!('events' in body.coverage), 'coverage must not enumerate event names');
  });
});

// ─── 체인 전체 검증 ─────────────────────────────────────────────────

describe('체인 전체 검증 (/decision-events/verify-chain/:domain)', () => {
  async function get(url: string, withAuth = true) {
    const res = await app.fetch(
      new Request(`http://localhost${url}`, {
        headers: withAuth ? { Authorization: `Bearer ${API_KEY}` } : {},
      }),
    );
    return { status: res.status, body: (await res.json()) as any };
  }

  it('정상 체인은 verified=true, firstBrokenIndex=null', async () => {
    const domain = 'chain-ok';
    for (let i = 0; i < 3; i += 1) await recordEvent({ metadata: { domain } });

    const { status, body } = await get(`/decision-events/verify-chain/${domain}`);
    assert.equal(status, 200);
    assert.equal(body.data.verified, true, JSON.stringify(body.data.records));
    assert.equal(body.data.firstBrokenIndex, null);
    assert.equal(body.data.totalEvents, 3);
    assert.equal(body.data.verifiedEvents, 3);
  });

  it('중간 레코드를 지우면 인덱스 구멍을 잡는다 (개별 검증만으로는 안 잡힌다)', async () => {
    const domain = 'chain-gap';
    const events = [];
    for (let i = 0; i < 3; i += 1) events.push(await recordEvent({ metadata: { domain } }));

    // 가운데(index 1) 제거
    db.prepare('DELETE FROM decision_events WHERE evidence_id = ?').run(events[1].evidence.id);

    const { body } = await get(`/decision-events/verify-chain/${domain}`);
    assert.equal(body.data.verified, false);
    assert.deepEqual(body.data.missingIndexes, [1]);
    assert.equal(body.data.firstBrokenIndex, 1);
  });

  it('레코드를 변조하면 그 인덱스를 짚어준다', async () => {
    const domain = 'chain-tampered';
    const events = [];
    for (let i = 0; i < 3; i += 1) events.push(await recordEvent({ metadata: { domain } }));

    tamper(events[2].evidence.id, 'action_output', JSON.stringify({ payout: 99_000_000 }));

    const { body } = await get(`/decision-events/verify-chain/${domain}`);
    assert.equal(body.data.verified, false);
    assert.equal(body.data.firstBrokenIndex, 2);
    assert.equal(body.data.verifiedEvents, 2);
  });

  it('인증 없이는 접근할 수 없다 (도메인명이 드러난다)', async () => {
    const domain = 'chain-private';
    await recordEvent({ metadata: { domain } });

    const { status } = await get(`/decision-events/verify-chain/${domain}`, false);
    assert.equal(status, 401);
  });

  it('다른 테넌트의 체인은 보이지 않는다', async () => {
    const domain = 'chain-other-tenant';
    await recordEvent({ metadata: { domain } });

    const otherKey = createApiKey('tenant-other', 'other tenant key').key;
    const res = await app.fetch(
      new Request(`http://localhost/decision-events/verify-chain/${domain}`, {
        headers: { Authorization: `Bearer ${otherKey}` },
      }),
    );
    assert.equal(res.status, 404);
  });

  it('verify-chain 라우트가 /:id 보다 먼저 잡힌다 (라우트 순서 회귀 방지)', async () => {
    const domain = 'chain-route-order';
    await recordEvent({ metadata: { domain } });

    const { status, body } = await get(`/decision-events/verify-chain/${domain}`);
    assert.equal(status, 200);
    assert.ok(body.data?.records, 'verify-chain was swallowed by the /:id route');
  });
});

// ─── 레거시 v2 행 ──────────────────────────────────────────────────

describe('레거시 v2 레코드 (2026-08-05 이전 기록)', () => {
  /** v2 규칙(3개 필드)으로 기록된 행을 그대로 재현한다. */
  function insertLegacyRow(domain: string) {
    const id = crypto.randomUUID();
    const decisionId = `dec_legacy_${domain}`;
    const evidenceId = `evi_legacy_${domain}`;
    const occurredAt = '2026-04-01T00:00:00.000Z';

    const chainHash = computeChainHash(
      { type: 'agent_execution', action_type: 'RUN', actor_id: 'legacy-agent' },
      null,
      occurredAt,
    );

    db.prepare(`
      INSERT INTO decision_events (
        id, decision_id, type, source_type, status,
        actor_id, actor_type, action_type,
        evidence_id, evidence_level, chain_hash, chain_index, previous_hash, chain_domain,
        occurred_at, tenant_id, created_at, updated_at
      ) VALUES (?, ?, 'agent_execution', 'manual', 'recorded', 'legacy-agent', 'ai', 'RUN',
                ?, 'DRAFT', ?, 0, NULL, ?, ?, 'tenant-test', ?, ?)
    `).run(id, decisionId, evidenceId, chainHash, domain, occurredAt, occurredAt, occurredAt);

    return evidenceId;
  }

  it('v2 행은 v2 규칙으로 재계산된다 — "변조됨"으로 몰지 않는다', async () => {
    const evidenceId = insertLegacyRow('legacy-ok');
    const { body } = await verify(evidenceId);

    // 해시 자체는 맞는다 = 변조 아님. 이게 거짓 경보를 안 낸다는 뜻이다.
    assert.equal(body.checks.chainHash.ok, true, `변조로 오판했다: ${JSON.stringify(body.failures)}`);
    assert.equal(body.evidence.chainPayloadVersion, 2);
    // 서명 개념이 없던 시절의 행 → 서명 없음을 위조로 몰지 않는다
    assert.equal(body.checks.serverSignature.status, 'not_applicable');
  });

  it('🔴 그래도 기본값에서는 verified=false 다 — 내용이 결속된 적이 없으므로 보증할 수 없다', async () => {
    const evidenceId = insertLegacyRow('legacy-strict');
    const { body } = await verify(evidenceId);

    assert.equal(body.verified, false, '내용 미결속 레코드가 통과했다 = 다운그레이드 통로');
    assert.ok(body.failures.some((f: string) => /does not cover the record content/i.test(f)));
  });

  it('운영자가 명시적으로 켜면 레거시를 받아들인다 (PROOF_ACCEPT_LEGACY_UNBOUND)', async () => {
    const evidenceId = insertLegacyRow('legacy-optin');
    process.env.PROOF_ACCEPT_LEGACY_UNBOUND = 'true';
    try {
      const { body } = await verify(evidenceId);
      assert.equal(body.verified, true, `failures: ${JSON.stringify(body.failures)}`);
      assert.equal(body.checks.chainHash.contentBound, false);
    } finally {
      delete process.env.PROOF_ACCEPT_LEGACY_UNBOUND;
    }
  });

  it('라벨이 아니라 실제로 맞은 계산을 보고한다 (contentBound)', async () => {
    const evidenceId = insertLegacyRow('legacy-contentbound');
    const { body } = await verify(evidenceId);

    // 라벨이 아니라 실제로 맞은 계산을 보고한다
    // 스킴은 호출자 네임스페이스가 붙는다 — ops('ops.v1'/'ops.v2')와 라벨이 충돌하지 않게.
    assert.equal(body.checks.chainHash.matchedScheme, 'proof.v2');
    assert.equal(body.checks.chainHash.contentBound, false);
    // 응답을 읽는 사람이 과신하지 않도록 경고를 함께 내보낸다
    assert.ok(
      body.limitations.some((l: string) => /legacy record/i.test(l)),
      'legacy 경고가 limitations 에 없다',
    );
  });

  it('v3 행은 contentBound=true 로 보고한다', async () => {
    const event = await recordEvent();
    const { body } = await verify(event.evidence.id);

    assert.equal(body.checks.chainHash.matchedScheme, 'proof.v3');
    assert.equal(body.checks.chainHash.contentBound, true);
    assert.ok(!body.limitations.some((l: string) => /legacy record/i.test(l)));
  });

  it('v2 행도 변조하면 잡힌다 (레거시라고 봐주지 않는다)', async () => {
    const evidenceId = insertLegacyRow('legacy-tampered');
    tamper(evidenceId, 'actor_id', 'someone-else');

    const { body } = await verify(evidenceId);
    assert.equal(body.verified, false);
    assert.equal(body.checks.chainHash.ok, false);
  });
});

// ─── 교차검증에서 나온 실제 공격 (fable · codex, 2026-08-05) ────────
//
// 아래 셋은 **재현된 공격**이다. 이 파일의 다른 테스트가 전부 초록이던 시점에
// 세 개 모두 verified:true 를 받아냈다. 되돌아오면 안 된다.

describe('🔴 재현된 공격 — 회귀 방지', () => {
  it('공격 1: 승인 없이 evidence_level 만 AUDIT_READY 로 올리기', async () => {
    const event = await recordEvent({ metadata: { domain: 'atk-approval' } });

    // approval_result·sealed_at 은 건드리지 않는다 → 옛 checkSeal 은 "아직 봉인 안 됨"으로 통과시켰다.
    tamper(event.evidence.id, 'evidence_level', 'AUDIT_READY');
    tamper(event.evidence.id, 'status', 'sealed');
    tamper(event.evidence.id, 'approver_name', '가짜승인자');

    const { body } = await verify(event.evidence.id);
    assert.equal(body.verified, false, '승인한 적 없는 건이 감사준비 완료로 통과했다');
    assert.equal(body.checks.seal.ok, false);
    assert.match(body.checks.seal.detail, /approval was forged/i);
  });

  it('공격 2: chain_payload_version 을 2로 내리고 3필드 해시를 다시 계산하기', async () => {
    const event = await recordEvent({ metadata: { domain: 'atk-downgrade' } });
    const row = db
      .prepare('SELECT * FROM decision_events WHERE evidence_id = ?')
      .get(event.evidence.id) as any;

    // 공격자는 서명 키가 없어도 v2 해시는 스스로 계산할 수 있다.
    const forged = computeChainHash(
      { type: row.type, action_type: row.action_type, actor_id: row.actor_id },
      row.previous_hash,
      row.occurred_at,
    );
    db.prepare(`
      UPDATE decision_events
      SET action_output = ?, chain_payload_version = 2, chain_hash = ?,
          signature = NULL, signature_alg = NULL, signature_key_id = NULL
      WHERE evidence_id = ?
    `).run(JSON.stringify({ payout: 99_000_000 }), forged, event.evidence.id);

    const { body } = await verify(event.evidence.id);
    assert.equal(body.verified, false, '버전 한 칸으로 내용결속·봉인·서명이 전부 꺼졌다');
    assert.equal(body.checks.chainHash.contentBound, false);
    assert.ok(body.failures.some((f: string) => /does not cover the record content/i.test(f)));
  });

  it('공격 3: verify-chain 범위 파라미터로 깨진 구간 밀어내기', async () => {
    const domain = 'atk-scope';
    const events = [];
    for (let i = 0; i < 3; i += 1) events.push(await recordEvent({ metadata: { domain } }));
    tamper(events[0].evidence.id, 'action_output', JSON.stringify({ t: 1 }));

    const call = async (qs: string) => {
      const res = await app.fetch(
        new Request(`http://localhost/decision-events/verify-chain/${domain}${qs}`, {
          headers: { Authorization: `Bearer ${API_KEY}` },
        }),
      );
      return (await res.json() as any).data;
    };

    assert.equal((await call('')).verified, false, '전체 스캔이 깨진 체인을 못 잡았다');

    // 범위를 좁혀 깨진 레코드를 스캔 밖으로 밀어내도 통과를 살 수 없어야 한다.
    for (const qs of ['?limit=0', '?limit=1', '?fromIndex=1']) {
      const d = await call(qs);
      assert.equal(d.verified, false, `${qs} 로 통과를 사들였다`);
      assert.equal(d.scope, 'partial', `${qs} 가 전체 스캔으로 보고됐다`);
    }
  });
});

// ─── 구 google-drive 레거시 행 ──────────────────────────────────────

describe('구 google-drive 동기화 행 (기록 결함 2종)', () => {
  /**
   * 구 services/google-drive.ts 가 만든 행을 그대로 재현한다.
   *   해시 입력: actor_id = tenantId,  timestamp = now
   *   저장 값  : actor_id = 수정자 이메일, occurred_at = file.modifiedTime
   * 두 값이 모두 어긋나 있어서, 저장된 값으로 재계산하면 반드시 실패한다.
   */
  function insertLegacyDriveRow(domain: string, tenantId = 'tenant-test') {
    const id = crypto.randomUUID();
    const evidenceId = `evi_drive_${domain}`;
    const now = '2026-04-01T09:00:00.000Z';        // 해시에 쓰인 값
    const modifiedTime = '2026-03-30T01:23:45.000Z'; // occurred_at 에 저장된 값
    const email = 'someone@example.com';             // actor_id 에 저장된 값
    const fileHash = 'f'.repeat(64);

    const chainHash = computeChainHash(
      { type: 'file_change', action_type: 'SYNC', actor_id: tenantId, file_hash: fileHash },
      null,
      now,
    );

    db.prepare(`
      INSERT INTO decision_events (
        id, decision_id, type, source_type, status, actor_id, actor_type, actor_name, action_type,
        evidence_id, evidence_level, chain_hash, chain_index, previous_hash, chain_domain,
        occurred_at, tenant_id, created_at, updated_at
      ) VALUES (?, ?, 'file_change', 'harness', 'recorded', ?, 'human', 'Someone', 'SYNC',
                ?, 'DRAFT', ?, 0, NULL, ?, ?, ?, ?, ?)
    `).run(id, `dec_drive_${domain}`, email, evidenceId, chainHash, domain, modifiedTime, tenantId, now, now);

    db.prepare(`
      INSERT INTO proof_files (id, tenant_id, decision_event_id, filename, size_bytes, file_hash, version_number, storage_path, storage_type, created_at)
      VALUES (?, ?, ?, 'x.pdf', 1, ?, 1, 'x', 'local', ?)
    `).run(crypto.randomUUID(), tenantId, id, fileHash, now);

    return evidenceId;
  }

  it('🔴 구 drive 행이 거짓 실패하지 않는다 (actor_id·타임스탬프 둘 다 어긋나 있다)', async () => {
    const evidenceId = insertLegacyDriveRow('drive-ok');
    const { body } = await verify(evidenceId);

    // 🔑 핵심은 "verified" 가 아니라 **변조로 몰지 않는 것**이다.
    //    해시가 맞았다 = 기록 당시 입력을 찾아냈다 = 이 행은 변조되지 않았다.
    assert.equal(body.checks.chainHash.ok, true, `멀쩡한 고객 데이터를 변조로 보고했다: ${JSON.stringify(body.failures)}`);
    assert.equal(body.checks.chainHash.matchedScheme, 'proof.v2-drive');
    assert.equal(body.checks.chainHash.contentBound, false);
    assert.ok(
      !body.failures.some((f: string) => /altered after recording/i.test(f)),
      '변조됐다고 말하면 안 된다',
    );
  });

  it('구 drive 행도 파일 해시를 바꾸면 잡힌다', async () => {
    const evidenceId = insertLegacyDriveRow('drive-tampered');
    const row = db.prepare('SELECT id FROM decision_events WHERE evidence_id = ?').get(evidenceId) as { id: string };
    db.prepare('UPDATE proof_files SET file_hash = ? WHERE decision_event_id = ?').run('0'.repeat(64), row.id);

    const { body } = await verify(evidenceId);
    assert.equal(body.verified, false);
  });

  it('🔴 폴백은 drive 경로에만 열린다 — 일반 v2 행은 occurred_at 을 바꾸면 잡힌다', async () => {
    // 폴백이 모든 v2 행에 열려 있으면, occurred_at 을 바꿔도 created_at 후보가 맞아 통과한다.
    // 그건 구제가 아니라 변조 통로다.
    //
    // 이 행은 drive 경로가 아니다(source_type='manual'). 기록 당시 occurred_at 과 created_at 이
    // 같았으므로, 폴백이 열려 있으면 occurred_at 을 바꿔도 created_at 후보로 통과해버린다.
    const domain = 'v2-narrow';
    const id = crypto.randomUUID();
    const evidenceId = `evi_${domain}`;
    const at = '2026-04-01T00:00:00.000Z';
    const chainHash = computeChainHash(
      { type: 'agent_execution', action_type: 'RUN', actor_id: 'legacy-agent' },
      null,
      at,
    );
    db.prepare(`
      INSERT INTO decision_events (
        id, decision_id, type, source_type, status, actor_id, actor_type, action_type,
        evidence_id, evidence_level, chain_hash, chain_index, previous_hash, chain_domain,
        occurred_at, tenant_id, created_at, updated_at
      ) VALUES (?, ?, 'agent_execution', 'manual', 'recorded', 'legacy-agent', 'ai', 'RUN',
                ?, 'DRAFT', ?, 0, NULL, ?, ?, 'tenant-test', ?, ?)
    `).run(id, `dec_${domain}`, evidenceId, chainHash, domain, at, at, at);

    assert.equal((await verify(evidenceId)).body.checks.chainHash.ok, true, '기준선부터 실패했다');

    tamper(evidenceId, 'occurred_at', '2020-01-01T00:00:00.000Z');

    const { body } = await verify(evidenceId);
    assert.equal(body.checks.chainHash.ok, false, '일반 v2 행에 폴백이 열려 있다');
    assert.ok(body.failures.some((f: string) => /altered after recording/i.test(f)));
  });
});

// ─── 체인 위치 유일성 ───────────────────────────────────────────────

describe('체인 위치 유일성 (동시 append 방어)', () => {
  it('같은 (tenant, domain, index)를 두 번 넣을 수 없다', async () => {
    const domain = 'unique-position';
    const event = await recordEvent({ metadata: { domain } });

    const row = db
      .prepare('SELECT * FROM decision_events WHERE evidence_id = ?')
      .get(event.evidence.id) as Record<string, unknown>;

    // 같은 체인 위치에 다른 레코드를 끼워 넣으려는 시도 = 체인 분기
    assert.throws(
      () => {
        db.prepare(`
          INSERT INTO decision_events (
            id, decision_id, type, source_type, status, actor_id, actor_type, action_type,
            evidence_id, chain_index, chain_domain, occurred_at, tenant_id, created_at, updated_at
          ) VALUES (?, ?, 'ai_decision', 'manual', 'recorded', 'x', 'ai', 'FORK',
                    ?, ?, ?, ?, ?, ?, ?)
        `).run(
          crypto.randomUUID(), `dec_fork_${domain}`, `evi_fork_${domain}`,
          row.chain_index, domain, row.occurred_at, row.tenant_id, row.created_at, row.created_at,
        );
      },
      /UNIQUE/i,
      '체인 분기가 DB 제약에 막히지 않았다',
    );
  });

  it('연속 기록이 인덱스를 건너뛰지 않는다', async () => {
    const domain = 'sequential-append';
    for (let i = 0; i < 5; i += 1) await recordEvent({ metadata: { domain } });

    const indexes = (
      db
        .prepare('SELECT chain_index FROM decision_events WHERE chain_domain = ? ORDER BY chain_index')
        .all(domain) as { chain_index: number }[]
    ).map(r => r.chain_index);

    assert.deepEqual(indexes, [0, 1, 2, 3, 4]);
  });
});

// ─── 마이그레이션 순서 회귀 ─────────────────────────────────────────

describe('마이그레이션 순서', () => {
  it('source_type 이전에 만들어진 DB로도 부팅한다', () => {
    // 2026-04 이전 실제 모양: source_type 도, 검증 컬럼도 없다. 나머지는 그대로 있었다.
    const legacyDb = new Database(':memory:');
    legacyDb.exec(`
      CREATE TABLE decision_events (
        id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'recorded',
        actor_id TEXT NOT NULL,
        actor_type TEXT NOT NULL DEFAULT 'human',
        actor_name TEXT,
        actor_metadata TEXT,
        action_type TEXT NOT NULL,
        action_description TEXT,
        action_input TEXT,
        action_output TEXT,
        action_metadata TEXT,
        ai_model TEXT,
        ai_provider TEXT,
        ai_confidence REAL,
        ai_prompt_hash TEXT,
        ai_reasoning TEXT,
        ai_tokens_input INTEGER,
        ai_tokens_output INTEGER,
        ai_metadata TEXT,
        evidence_id TEXT,
        evidence_level TEXT DEFAULT 'DRAFT',
        chain_hash TEXT,
        chain_index INTEGER,
        previous_hash TEXT,
        chain_domain TEXT DEFAULT 'default',
        approver_id TEXT,
        approver_type TEXT,
        approver_name TEXT,
        approval_result TEXT,
        approval_reason TEXT,
        approved_at TEXT,
        occurred_at TEXT NOT NULL,
        tags TEXT,
        metadata TEXT,
        idempotency_key TEXT UNIQUE,
        sealed_at TEXT,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        api_key_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // 고치기 전에는 여기서 `SqliteError: no such column: source_type` 으로 죽었다.
    assert.doesNotThrow(() => initializeDatabase(legacyDb));

    const columns = (legacyDb.prepare('PRAGMA table_info(decision_events)').all() as { name: string }[])
      .map(c => c.name);

    for (const expected of ['source_type', 'chain_payload_version', 'seal_hash', 'signature']) {
      assert.ok(columns.includes(expected), `missing column after migration: ${expected}`);
    }

    legacyDb.close();
  });
});

// ─── 없는 것 ───────────────────────────────────────────────────────

describe('없는 증거', () => {
  it('404를 준다', async () => {
    const { status, body } = await verify('evi_does_not_exist');
    assert.equal(status, 404);
    assert.equal(body.verified, false);
  });
});
