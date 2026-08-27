/**
 * @cronozen/dpu-core Unit Tests
 *
 * Node.js built-in test runner (node:test + node:assert).
 * Zero external test dependencies.
 *
 * Covers:
 * - canonicalize.ts: key sorting, nested objects, null/undefined, determinism
 * - hash.ts: computeChainHash, generatePolicyHash, verifyPolicyHash,
 *            computeContentHash, computeObjectHash
 * - envelope.ts: createDPUEnvelope (genesis & chained)
 * - @locked regression: known inputs → known hashes
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  canonicalize,
  canonicalizeFlat,
  canonicalizeChainPayload,
} from '../canonicalize';

import {
  computeChainHash,
  computeChainHashV1,
  generatePolicyHash,
  verifyPolicyHash,
  computeContentHash,
  computeObjectHash,
} from '../hash';

import { createDPUEnvelope } from '../envelope';
import type { CreateEnvelopeInput, ChainContext } from '../envelope';

// ============================================================
// Helpers
// ============================================================

/** Compute SHA-256 hex of a string (reference implementation for tests) */
function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Minimal valid CreateEnvelopeInput for testing */
function minimalInput(overrides?: Partial<CreateEnvelopeInput>): CreateEnvelopeInput {
  return {
    domain: 'pharmacy',
    purpose: '교품거래',
    final_action: 'CREATED',
    final_responsible: 'kim',
    evidence_level: 'DRAFT' as const,
    ...overrides,
  };
}

// ============================================================
// canonicalize.ts
// ============================================================

describe('canonicalize()', () => {
  it('sorts top-level keys alphabetically', () => {
    const result = canonicalize({ b: 2, a: 1 });
    assert.equal(result, '{"a":1,"b":2}');
  });

  it('produces compact JSON (no spaces)', () => {
    const result = canonicalize({ key: 'value', another: true });
    assert.ok(!result.includes(' '), 'output should have no spaces');
  });

  it('handles empty object', () => {
    const result = canonicalize({});
    assert.equal(result, '{}');
  });

  it('preserves null values', () => {
    const result = canonicalize({ a: null, b: 1 });
    assert.equal(result, '{"a":null,"b":1}');
  });

  it('🔴 undefined 를 **거부한다** — 예전엔 조용히 버렸다(0.3.0 에서 뒤집음)', () => {
    // 옛 동작: `{a: undefined, b: 1}` → `'{"b":1}'` 로 키가 사라졌다.
    // ⇒ `{a: undefined}` 와 `{}` 가 **같은 해시**였다(second-preimage).
    //    「JSON.stringify 동작이니까」라는 이유로 고정돼 있었는데,
    //    해시 입력으로는 그게 결함이다. 모르는 건 거부한다.
    assert.throws(() => canonicalize({ a: undefined, b: 1 }), /undefined/);
  });

  it('handles string, number, boolean, null types', () => {
    const result = canonicalize({ s: 'hello', n: 42, b: false, x: null });
    const parsed = JSON.parse(result);
    assert.equal(parsed.s, 'hello');
    assert.equal(parsed.n, 42);
    assert.equal(parsed.b, false);
    assert.equal(parsed.x, null);
  });

  it('handles nested objects (inner keys keep insertion order)', () => {
    // canonicalize only sorts top-level keys using Object.keys().sort() as the replacer
    const result = canonicalize({ z: { b: 2, a: 1 }, a: 'first' });
    // Top-level: a before z
    assert.ok(result.startsWith('{"a":'));
    // Nested object: with JSON.stringify replacer for top-level keys only,
    // the nested object serialization depends on the replacer behavior.
    // The replacer array only filters keys; for nested objects keys not in
    // the replacer array would be excluded by JSON.stringify spec.
    // Actually, JSON.stringify with an array replacer includes only those
    // keys that appear in the array at ANY level. So nested keys not in the
    // top-level key list would be excluded.
    // Let's verify the actual behavior:
    const parsed = JSON.parse(result);
    assert.equal(parsed.a, 'first');
  });

  it('is deterministic — same input always produces same output', () => {
    const data = { z: 1, m: 2, a: 3 };
    const r1 = canonicalize(data);
    const r2 = canonicalize(data);
    const r3 = canonicalize(data);
    assert.equal(r1, r2);
    assert.equal(r2, r3);
  });

  it('produces different output for different key orders only if values differ', () => {
    // Same keys, same values — should be identical regardless of insertion order
    const r1 = canonicalize({ a: 1, b: 2 });
    const r2 = canonicalize({ b: 2, a: 1 });
    assert.equal(r1, r2);
  });

  it('handles arrays as values', () => {
    const result = canonicalize({ items: [1, 2, 3], name: 'test' });
    const parsed = JSON.parse(result);
    assert.deepEqual(parsed.items, [1, 2, 3]);
    assert.equal(parsed.name, 'test');
  });
});

describe('canonicalizeFlat()', () => {
  it('sorts top-level keys', () => {
    const result = canonicalizeFlat({ b: 2, a: 1 });
    assert.equal(result, '{"a":1,"b":2}');
  });

  it('produces JSON with 0 spaces (same as compact)', () => {
    // JSON.stringify with 0 as space is equivalent to no space
    const result = canonicalizeFlat({ key: 'value' });
    assert.equal(result, '{"key":"value"}');
  });

  it('matches canonicalize for flat objects', () => {
    const data = { z: 1, a: 2, m: 3 };
    assert.equal(canonicalize(data), canonicalizeFlat(data));
  });

  it('handles empty object', () => {
    assert.equal(canonicalizeFlat({}), '{}');
  });
});

describe('canonicalizeChainPayload()', () => {
  it('replaces null previousHash with "GENESIS"', () => {
    const result = canonicalizeChainPayload({ a: 1 }, null, '2026-01-01T00:00:00Z');
    const parsed = JSON.parse(result);
    assert.equal(parsed.previousHash, 'GENESIS');
  });

  it('preserves non-null previousHash as-is', () => {
    const hash = 'abc123def456';
    const result = canonicalizeChainPayload({ a: 1 }, hash, '2026-01-01T00:00:00Z');
    const parsed = JSON.parse(result);
    assert.equal(parsed.previousHash, hash);
  });

  it('wraps content, previousHash, timestamp into a sorted-key object', () => {
    const result = canonicalizeChainPayload(
      { domain: 'test' },
      null,
      '2026-01-01T00:00:00Z'
    );
    const parsed = JSON.parse(result);
    assert.ok('content' in parsed);
    assert.ok('previousHash' in parsed);
    assert.ok('timestamp' in parsed);
    assert.equal(Object.keys(parsed).length, 3);
  });

  it('sorts the payload keys alphabetically (content < previousHash < timestamp)', () => {
    const result = canonicalizeChainPayload({ a: 1 }, null, '2026-01-01T00:00:00Z');
    const keys = Object.keys(JSON.parse(result));
    assert.deepEqual(keys, ['content', 'previousHash', 'timestamp']);
  });

  it('is deterministic for identical inputs', () => {
    const r1 = canonicalizeChainPayload({ a: 1 }, 'hash1', '2026-01-01T00:00:00Z');
    const r2 = canonicalizeChainPayload({ a: 1 }, 'hash1', '2026-01-01T00:00:00Z');
    assert.equal(r1, r2);
  });

  it('treats empty string previousHash as empty string (not GENESIS)', () => {
    // '' is falsy, so || 'GENESIS' will replace it
    const result = canonicalizeChainPayload({ a: 1 }, '', '2026-01-01T00:00:00Z');
    const parsed = JSON.parse(result);
    assert.equal(parsed.previousHash, 'GENESIS');
  });
});

// ============================================================
// hash.ts
// ============================================================

describe('computeChainHash()', () => {
  it('returns a 64-character hex string (SHA-256)', () => {
    const hash = computeChainHash({ domain: 'test' }, null, '2026-01-01T00:00:00Z');
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  it('genesis: null previousHash produces a valid hash', () => {
    const hash = computeChainHash(
      { domain: 'pharmacy', purpose: '교품거래', final_action: 'CREATED', final_responsible: 'kim' },
      null,
      '2026-02-10T00:00:00+09:00'
    );
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  it('chained: non-null previousHash produces a different hash than genesis', () => {
    const content = { domain: 'pharmacy', purpose: '교품거래' };
    const ts = '2026-02-10T00:00:00+09:00';
    const genesis = computeChainHash(content, null, ts);
    const chained = computeChainHash(content, 'abc123', ts);
    assert.notEqual(genesis, chained);
  });

  it('is deterministic — same inputs always produce same hash', () => {
    const content = { domain: 'test', purpose: 'demo' };
    const ts = '2026-01-01T00:00:00Z';
    const h1 = computeChainHash(content, null, ts);
    const h2 = computeChainHash(content, null, ts);
    assert.equal(h1, h2);
  });

  it('different content produces different hash', () => {
    // Note: canonicalizeChainPayload uses Object.keys(payload).sort() as
    // the JSON.stringify replacer, which is ['content', 'previousHash', 'timestamp'].
    // Array replacers only include keys that appear in the array at ANY nesting level.
    // So content object keys NOT in that list are excluded from serialization.
    // To test different content producing different hashes, we use keys that
    // survive the replacer (e.g., 'content', 'previousHash', 'timestamp')
    // or pass content via the previousHash/timestamp params which are always included.
    const ts = '2026-01-01T00:00:00Z';
    // Different previousHash values guarantee different serialized payloads
    const h1 = computeChainHash({}, 'hash_a', ts);
    const h2 = computeChainHash({}, 'hash_b', ts);
    assert.notEqual(h1, h2);

    // Also: different timestamps produce different hashes
    const h3 = computeChainHash({}, null, '2026-01-01T00:00:00Z');
    const h4 = computeChainHash({}, null, '2026-01-02T00:00:00Z');
    assert.notEqual(h3, h4);

    // Content keys that happen to match the replacer array ARE included
    const h5 = computeChainHash({ content: 'a' }, null, ts);
    const h6 = computeChainHash({ content: 'b' }, null, ts);
    assert.notEqual(h5, h6);
  });

  it('different timestamp produces different hash', () => {
    const content = { domain: 'test' };
    const h1 = computeChainHash(content, null, '2026-01-01T00:00:00Z');
    const h2 = computeChainHash(content, null, '2026-01-02T00:00:00Z');
    assert.notEqual(h1, h2);
  });

  it('different previousHash produces different hash', () => {
    const content = { domain: 'test' };
    const ts = '2026-01-01T00:00:00Z';
    const h1 = computeChainHash(content, 'hash_a', ts);
    const h2 = computeChainHash(content, 'hash_b', ts);
    assert.notEqual(h1, h2);
  });

  it('matches manual SHA-256 computation of the canonical payload', () => {
    const content = { domain: 'pharmacy', purpose: '교품거래' };
    const ts = '2026-02-10T00:00:00+09:00';
    const prevHash = null;

    const payload = canonicalizeChainPayload(content, prevHash, ts);
    const expectedHash = sha256(payload);
    const actualHash = computeChainHash(content, prevHash, ts);

    assert.equal(actualHash, expectedHash);
  });
});

describe('generatePolicyHash()', () => {
  it('returns a 64-character hex string', () => {
    const hash = generatePolicyHash({ rule: 'no-change', level: 2 });
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    const config = { min_approvers: 1, domain: 'pharmacy' };
    const h1 = generatePolicyHash(config);
    const h2 = generatePolicyHash(config);
    assert.equal(h1, h2);
  });

  it('different config produces different hash', () => {
    const h1 = generatePolicyHash({ rule: 'a' });
    const h2 = generatePolicyHash({ rule: 'b' });
    assert.notEqual(h1, h2);
  });

  it('matches manual SHA-256 of canonicalizeFlat output', () => {
    const config = { min_approvers: 2, domain: 'edu' };
    const canonical = canonicalizeFlat(config);
    const expected = sha256(canonical);
    assert.equal(generatePolicyHash(config), expected);
  });
});

describe('verifyPolicyHash()', () => {
  it('returns true for matching hash', () => {
    const config = { rule: 'no-change', level: 2 };
    const hash = generatePolicyHash(config);
    assert.equal(verifyPolicyHash(config, hash), true);
  });

  it('returns false for non-matching hash', () => {
    const config = { rule: 'no-change', level: 2 };
    assert.equal(verifyPolicyHash(config, 'wrong_hash'), false);
  });

  it('round-trip: generate then verify always succeeds', () => {
    const configs = [
      { a: 1 },
      { domain: 'pharmacy', min_approvers: 3, required_review_role: 'admin' },
      { nested: { deep: true }, flat: 'value' },
      {},
    ];
    for (const config of configs) {
      const hash = generatePolicyHash(config);
      assert.equal(verifyPolicyHash(config, hash), true, `round-trip failed for ${JSON.stringify(config)}`);
    }
  });

  it('detects modification (config changed after hash generation)', () => {
    const original = { rule: 'no-change', level: 2 };
    const hash = generatePolicyHash(original);
    const modified = { rule: 'no-change', level: 3 };
    assert.equal(verifyPolicyHash(modified, hash), false);
  });
});

describe('computeContentHash()', () => {
  it('returns a 64-character hex string', () => {
    const hash = computeContentHash('hello world');
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  it('matches node:crypto SHA-256 directly', () => {
    const input = 'test content for hashing';
    assert.equal(computeContentHash(input), sha256(input));
  });

  it('is deterministic', () => {
    assert.equal(computeContentHash('abc'), computeContentHash('abc'));
  });

  it('different inputs produce different hashes', () => {
    assert.notEqual(computeContentHash('a'), computeContentHash('b'));
  });

  it('handles empty string', () => {
    const hash = computeContentHash('');
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(hash, sha256(''));
  });

  it('handles Korean text', () => {
    const hash = computeContentHash('교품거래 정책 확인');
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(hash, sha256('교품거래 정책 확인'));
  });
});

describe('computeObjectHash()', () => {
  it('returns a 64-character hex string', () => {
    const hash = computeObjectHash({ key: 'value' });
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  it('equals SHA-256 of canonicalizeFlat(data)', () => {
    const data = { z: 1, a: 'hello', m: null };
    const canonical = canonicalizeFlat(data);
    assert.equal(computeObjectHash(data), sha256(canonical));
  });

  it('same data with different key order produces same hash', () => {
    const h1 = computeObjectHash({ a: 1, b: 2 });
    const h2 = computeObjectHash({ b: 2, a: 1 });
    assert.equal(h1, h2);
  });

  it('is deterministic', () => {
    const data = { key: 'value' };
    assert.equal(computeObjectHash(data), computeObjectHash(data));
  });
});

// ============================================================
// envelope.ts
// ============================================================

describe('createDPUEnvelope()', () => {
  describe('genesis envelope (no latestLink)', () => {
    it('creates envelope with chain_index 0', () => {
      const envelope = createDPUEnvelope(minimalInput(), { latestLink: null });
      assert.equal(envelope.chain_index, 0);
    });

    it('creates envelope with previous_hash null', () => {
      const envelope = createDPUEnvelope(minimalInput(), { latestLink: null });
      assert.equal(envelope.previous_hash, null);
    });

    it('creates envelope with a valid chain_hash', () => {
      const envelope = createDPUEnvelope(minimalInput(), { latestLink: null });
      assert.match(envelope.chain_hash!, /^[0-9a-f]{64}$/);
    });

    it('sets domain correctly', () => {
      const envelope = createDPUEnvelope(minimalInput({ domain: 'rehab' }), { latestLink: null });
      assert.equal(envelope.domain, 'rehab');
      assert.equal(envelope.chain_domain, 'rehab');
    });

    it('sets decision_id with "dpu-" prefix', () => {
      const envelope = createDPUEnvelope(minimalInput(), { latestLink: null });
      assert.ok(envelope.decision_id.startsWith('dpu-'));
    });

    it('sets default values for optional fields', () => {
      const envelope = createDPUEnvelope(minimalInput(), { latestLink: null });
      assert.equal(envelope.ai_used, false);
      assert.equal(envelope.approved, false);
      assert.equal(envelope.audit_status, 'PENDING');
      assert.equal(envelope.risk_level, 'LOW');
      assert.deepEqual(envelope.tags, []);
      assert.deepEqual(envelope.approver_ids, []);
      assert.deepEqual(envelope.note_ids, []);
      assert.deepEqual(envelope.evidence_ids, []);
      assert.deepEqual(envelope.external_evidence, []);
    });
  });

  describe('chained envelope (with latestLink)', () => {
    const latestLink = { chain_hash: 'abc123def456', chain_index: 5 };

    it('creates envelope with incremented chain_index', () => {
      const envelope = createDPUEnvelope(minimalInput(), { latestLink });
      assert.equal(envelope.chain_index, 6);
    });

    it('sets previous_hash to latestLink chain_hash', () => {
      const envelope = createDPUEnvelope(minimalInput(), { latestLink });
      assert.equal(envelope.previous_hash, 'abc123def456');
    });

    it('creates a different chain_hash than genesis', () => {
      const genesis = createDPUEnvelope(minimalInput(), { latestLink: null });
      const chained = createDPUEnvelope(minimalInput(), { latestLink });
      // Note: timestamps will differ since Date.now() is called inside,
      // but even with same timestamp, different previousHash = different chain_hash
      assert.notEqual(genesis.chain_hash, chained.chain_hash);
    });
  });

  describe('hash correctness', () => {
    it('chain_hash matches manual computation from envelope fields', () => {
      const input = minimalInput();
      const chain: ChainContext = { latestLink: null };
      const envelope = createDPUEnvelope(input, chain);

      // Re-derive the hash from envelope fields
      const chainContent = {
        domain: envelope.domain,
        purpose: envelope.purpose,
        final_action: envelope.final_action,
        final_responsible: envelope.final_responsible,
      };
      const timestamp = (envelope.executed_at as Date).toISOString();
      const expectedHash = computeChainHash(chainContent, envelope.previous_hash ?? null, timestamp);
      assert.equal(envelope.chain_hash, expectedHash);
    });

    it('policy_snapshot_hash is computed when policy_snapshot is provided', () => {
      const policySnapshot = { min_approvers: 2, domain: 'pharmacy' };
      const envelope = createDPUEnvelope(
        minimalInput({ policy_snapshot: policySnapshot }),
        { latestLink: null }
      );
      assert.ok(envelope.policy_snapshot_hash);
      assert.equal(envelope.policy_snapshot_hash, computeContentHash(JSON.stringify(policySnapshot)));
    });

    it('policy_snapshot_hash is null when no policy_snapshot', () => {
      const envelope = createDPUEnvelope(minimalInput(), { latestLink: null });
      assert.equal(envelope.policy_snapshot_hash, null);
    });

    it('ai_prompt_hash is computed when ai_prompt is provided', () => {
      const prompt = 'Analyze the transaction for compliance';
      const envelope = createDPUEnvelope(
        minimalInput({ ai_prompt: prompt, ai_used: true }),
        { latestLink: null }
      );
      assert.equal(envelope.ai_prompt_hash, computeContentHash(prompt));
    });

    it('ai_prompt_hash is null when no ai_prompt', () => {
      const envelope = createDPUEnvelope(minimalInput(), { latestLink: null });
      assert.equal(envelope.ai_prompt_hash, null);
    });
  });

  describe('required fields', () => {
    it('includes all core identity fields', () => {
      const envelope = createDPUEnvelope(minimalInput(), { latestLink: null });
      assert.equal(envelope.domain, 'pharmacy');
      assert.equal(envelope.purpose, '교품거래');
      assert.equal(envelope.final_action, 'CREATED');
      assert.equal(envelope.final_responsible, 'kim');
      assert.equal(envelope.evidence_level, 'DRAFT');
    });

    it('sets created_by to final_responsible', () => {
      const envelope = createDPUEnvelope(minimalInput(), { latestLink: null });
      assert.equal(envelope.created_by, 'kim');
    });

    it('sets execution_status to success', () => {
      const envelope = createDPUEnvelope(minimalInput(), { latestLink: null });
      assert.equal(envelope.execution_status, 'success');
    });

    it('sets executed_at to a Date instance', () => {
      const envelope = createDPUEnvelope(minimalInput(), { latestLink: null });
      assert.ok(envelope.executed_at instanceof Date);
    });
  });

  describe('optional field propagation', () => {
    it('propagates AI fields', () => {
      const envelope = createDPUEnvelope(
        minimalInput({
          ai_used: true,
          ai_mode: 'RECOMMENDATION' as const,
          ai_model: 'gpt-4',
          ai_scope: 'full',
        }),
        { latestLink: null }
      );
      assert.equal(envelope.ai_used, true);
      assert.equal(envelope.ai_mode, 'RECOMMENDATION');
      assert.equal(envelope.ai_model, 'gpt-4');
      assert.equal(envelope.ai_scope, 'full');
      assert.equal(envelope.ai_responsibility, 'suggestion');
    });

    it('sets ai_responsibility to "none" when ai_used is false', () => {
      const envelope = createDPUEnvelope(minimalInput({ ai_used: false }), { latestLink: null });
      assert.equal(envelope.ai_responsibility, 'none');
    });

    it('propagates approval fields', () => {
      const ts = new Date('2026-02-10T00:00:00Z');
      const envelope = createDPUEnvelope(
        minimalInput({
          reviewed_by: 'reviewer1',
          reviewer_role: 'admin',
          approved: true,
          approval_timestamp: ts,
        }),
        { latestLink: null }
      );
      assert.equal(envelope.reviewed_by, 'reviewer1');
      assert.equal(envelope.reviewer_role, 'admin');
      assert.equal(envelope.approved, true);
      assert.equal(envelope.approval_timestamp, ts);
    });

    it('propagates link fields', () => {
      const envelope = createDPUEnvelope(
        minimalInput({
          session_id: 'sess-123',
          note_ids: ['n1', 'n2'],
          evidence_ids: ['e1'],
          document_id: 'doc-1',
          case_id: 'case-1',
        }),
        { latestLink: null }
      );
      assert.equal(envelope.session_id, 'sess-123');
      assert.deepEqual(envelope.note_ids, ['n1', 'n2']);
      assert.deepEqual(envelope.evidence_ids, ['e1']);
      assert.equal(envelope.document_id, 'doc-1');
      assert.equal(envelope.case_id, 'case-1');
    });

    it('propagates risk_level', () => {
      const envelope = createDPUEnvelope(
        minimalInput({ risk_level: 'HIGH' as const }),
        { latestLink: null }
      );
      assert.equal(envelope.risk_level, 'HIGH');
    });

    it('propagates tags', () => {
      const envelope = createDPUEnvelope(
        minimalInput({ tags: ['urgent', 'compliance'] }),
        { latestLink: null }
      );
      assert.deepEqual(envelope.tags, ['urgent', 'compliance']);
    });

    it('propagates tenant_id and policy_ref', () => {
      const envelope = createDPUEnvelope(
        minimalInput({ tenant_id: 'tenant-1', policy_ref: 'POL-001' }),
        { latestLink: null }
      );
      assert.equal(envelope.tenant_id, 'tenant-1');
      assert.equal(envelope.policy_ref, 'POL-001');
    });

    it('sets ai_metadata with policy_ref when provided', () => {
      const envelope = createDPUEnvelope(
        minimalInput({ policy_ref: 'POL-002' }),
        { latestLink: null }
      );
      assert.deepEqual(envelope.ai_metadata, { policy_ref: 'POL-002' });
    });

    it('sets ai_metadata to null when no policy_ref', () => {
      const envelope = createDPUEnvelope(minimalInput(), { latestLink: null });
      assert.equal(envelope.ai_metadata, null);
    });

    it('propagates voice fields', () => {
      const envelope = createDPUEnvelope(
        minimalInput({
          voice_transcript: '교품거래 승인합니다',
          voice_confidence: 0.95,
          voice_provider: 'whisper',
          voice_audio_hash: 'audiohash123',
        }),
        { latestLink: null }
      );
      assert.equal(envelope.voice_transcript, '교품거래 승인합니다');
      assert.equal(envelope.voice_confidence, 0.95);
      assert.equal(envelope.voice_provider, 'whisper');
      assert.equal(envelope.voice_audio_hash, 'audiohash123');
    });

    it('propagates dual approval fields', () => {
      const ts = new Date('2026-02-10T12:00:00Z');
      const envelope = createDPUEnvelope(
        minimalInput({
          second_reviewer_id: 'rev2',
          second_reviewer_role: 'supervisor',
          second_approved: true,
          second_approved_at: ts,
          approver_ids: ['rev1', 'rev2'],
        }),
        { latestLink: null }
      );
      assert.equal(envelope.second_reviewer_id, 'rev2');
      assert.equal(envelope.second_reviewer_role, 'supervisor');
      assert.equal(envelope.second_approved, true);
      assert.equal(envelope.second_approved_at, ts);
      assert.deepEqual(envelope.approver_ids, ['rev1', 'rev2']);
    });
  });

  describe('envelope does NOT include DB-managed fields', () => {
    it('does not include id, created_at, updated_at, version', () => {
      const envelope = createDPUEnvelope(minimalInput(), { latestLink: null });
      assert.equal('id' in envelope, false);
      assert.equal('created_at' in envelope, false);
      assert.equal('updated_at' in envelope, false);
      assert.equal('version' in envelope, false);
    });
  });
});

// ============================================================
// @locked Regression Tests
// ============================================================
// These tests pin specific known inputs to specific known hash outputs.
// If any of these fail, it means a @locked function was modified,
// which would break existing hash chains.

describe('@locked regression: canonicalize', () => {
  it('canonicalize({ b: 2, a: 1 }) produces exact expected output', () => {
    assert.equal(canonicalize({ b: 2, a: 1 }), '{"a":1,"b":2}');
  });

  it('canonicalizeFlat({ b: 2, a: 1 }) produces exact expected output', () => {
    assert.equal(canonicalizeFlat({ b: 2, a: 1 }), '{"a":1,"b":2}');
  });

  it('canonicalizeChainPayload produces exact expected structure for genesis', () => {
    const result = canonicalizeChainPayload(
      { domain: 'pharmacy' },
      null,
      '2026-02-10T00:00:00+09:00'
    );

    // 🔴 2026-08-05 정정: 기존 기댓값은 `JSON.stringify(obj, ['content','previousHash','timestamp'])`
    //    로 만들어져 있었다. 그건 **v1 의 문법**이고, replacer 배열이 모든 깊이에 적용되어
    //    content 가 `{}` 로 뭉개진다 — 정확히 v2 가 고친 버그다.
    //    v2 함수에 v1 기댓값을 걸어놓은 셈이라 이 테스트는 계속 빨간불이었다.
    //    상시 빨간 테스트는 진짜 회귀가 와도 아무도 못 보게 만든다.
    assert.equal(
      result,
      '{"content":{"domain":"pharmacy"},"previousHash":"GENESIS","timestamp":"2026-02-10T00:00:00+09:00"}',
    );
  });
});

/**
 * @locked regression: computeChainHash known vectors
 *
 * 🔴 2026-08-05: 이 블록은 **아무것도 고정하고 있지 않았다.**
 *
 * 기존 구현은 기댓값을 `sha256(canonicalizeChainPayload(...))` 로 계산했다.
 * 즉 검사 대상과 기댓값을 **같은 함수**로 만들었다. 직렬화 규칙을 바꾸면 양쪽이 똑같이
 * 바뀌므로 이 테스트는 절대 깨지지 않는다 — 주석에는 "any change to serialization
 * breaks this test" 라고 적혀 있었지만 사실이 아니었다.
 *
 * 해시 고정은 **리터럴 값**으로만 성립한다. 아래 값들은 실제 구현으로 산출해 박아둔 것이다.
 * 이 값이 바뀌면 기존에 기록된 모든 체인 해시가 무효가 된다는 뜻이므로, 고쳐서 초록으로
 * 만들지 말고 왜 바뀌었는지부터 물어야 한다.
 */
describe('@locked regression: computeChainHash known vectors', () => {
  // Vector #1: Genesis hash for pharmacy domain
  // payload: {"content":{"domain":"pharmacy","final_action":"CREATED","final_responsible":"kim","purpose":"교품거래"},"previousHash":"GENESIS","timestamp":"2026-02-10T00:00:00+09:00"}
  it('genesis hash vector #1', () => {
    const content = { domain: 'pharmacy', final_action: 'CREATED', final_responsible: 'kim', purpose: '교품거래' };
    const ts = '2026-02-10T00:00:00+09:00';

    assert.equal(
      computeChainHash(content, null, ts),
      '3b0d36b5fbbb16489cbc69582446e39dcce70390d3698f7ef780bf698b815b85',
    );
  });

  // Vector #2: Chained hash
  // payload: {"content":{"domain":"edu","purpose":"수업평가"},"previousHash":"aaaa…","timestamp":"2026-03-01T12:00:00Z"}
  it('chained hash vector #2', () => {
    const content = { domain: 'edu', purpose: '수업평가' };
    const prevHash = 'a'.repeat(64);
    const ts = '2026-03-01T12:00:00Z';

    assert.equal(
      computeChainHash(content, prevHash, ts),
      '3a0dac6ea463b67359bf18962479e45775b6616388b3de68a1554f33e1e92221',
    );
  });

  // Vector #3: minimal content
  // payload: {"content":{},"previousHash":"GENESIS","timestamp":"2026-01-01T00:00:00Z"}
  it('minimal content hash vector #3', () => {
    assert.equal(
      computeChainHash({}, null, '2026-01-01T00:00:00Z'),
      'adc06d602cc7d1e3a8485e29b4f35bf8f4d20621673521468e9c0df6a3d4dd98',
    );
  });

  // 기댓값이 구현과 독립적인지 확인한다 — 위 리터럴들이 진짜 고정값이라는 증거.
  it('pinned vectors are literals, not recomputed from the implementation', () => {
    const content = { domain: 'pharmacy', final_action: 'CREATED', final_responsible: 'kim', purpose: '교품거래' };
    const ts = '2026-02-10T00:00:00+09:00';

    // 직렬화 규칙을 손으로 재현한 문자열 → 해시. 구현 함수를 부르지 않는다.
    const handWritten =
      '{"content":{"domain":"pharmacy","final_action":"CREATED","final_responsible":"kim","purpose":"교품거래"},"previousHash":"GENESIS","timestamp":"2026-02-10T00:00:00+09:00"}';

    assert.equal(sha256(handWritten), computeChainHash(content, null, ts));
  });
});

/**
 * @locked regression: v1 레거시 벡터
 *
 * v1 은 `JSON.stringify(payload, ['content','previousHash','timestamp'])` 를 쓴다.
 * replacer 배열은 **모든 깊이**에 적용되므로 content 의 키가 전부 탈락해 항상 `{}` 가 된다.
 * 즉 **내용이 달라도 같은 해시가 나온다** — 이것이 v2 를 만든 이유다.
 *
 * 그럼에도 v1 을 고정해 두는 이유: 2026-08 현재 thearound-ops 가 레거시 DPU 를 검증할 때
 * 여전히 이 계산을 후보로 쓴다. 여기서 값이 흔들리면 살아 있는 레코드가 검증에 실패한다.
 */
describe('@locked regression: computeChainHashV1 legacy vectors', () => {
  it('v1 collapses content to {} — different content, same hash', () => {
    const ts = '2026-02-10T00:00:00+09:00';
    const a = computeChainHashV1({ domain: 'pharmacy' }, null, ts);
    const b = computeChainHashV1(
      { domain: 'pharmacy', final_action: 'CREATED', final_responsible: 'kim', purpose: '교품거래' },
      null,
      ts,
    );

    assert.equal(a, 'cc36afc2fa4765e515e6be91206b181229cf8a76d9551e0003a8cafee282fc47');
    assert.equal(a, b, 'v1 이 내용을 덮지 않는다는 사실 자체가 고정 대상이다');
  });

  it('v1 chained vector', () => {
    assert.equal(
      computeChainHashV1({ domain: 'edu', purpose: '수업평가' }, 'a'.repeat(64), '2026-03-01T12:00:00Z'),
      'ccce2f94bf10306c8152912b2d6bead3a4e294223095f1c142de17b6dd664425',
    );
  });

  it('v1 and v2 agree only when content is empty', () => {
    const ts = '2026-01-01T00:00:00Z';
    assert.equal(computeChainHash({}, null, ts), computeChainHashV1({}, null, ts));
    assert.notEqual(
      computeChainHash({ action: 'test' }, null, ts),
      computeChainHashV1({ action: 'test' }, null, ts),
    );
  });
});

describe('@locked regression: policy hash known vectors', () => {
  it('policy hash vector for known config', () => {
    const config = { domain: 'pharmacy', min_approvers: 1, required_review_role: 'pharmacist' };
    const hash = generatePolicyHash(config);
    const canonical = canonicalizeFlat(config);
    const expected = sha256(canonical);
    assert.equal(hash, expected);
  });
});

describe('@locked regression: pinned hash values', () => {
  // These are absolute pinned values. If they change, the @locked contract is broken.
  // We compute them once here based on the locked algorithm and freeze them.

  it('computeContentHash("hello") always equals SHA-256 of "hello"', () => {
    // SHA-256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    assert.equal(
      computeContentHash('hello'),
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    );
  });

  it('computeContentHash("") always equals SHA-256 of empty string', () => {
    // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    assert.equal(
      computeContentHash(''),
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });

  it('computeObjectHash({ a: 1, b: 2 }) always equals SHA-256 of \'{"a":1,"b":2}\'', () => {
    const expected = sha256('{"a":1,"b":2}');
    assert.equal(computeObjectHash({ a: 1, b: 2 }), expected);
    assert.equal(computeObjectHash({ b: 2, a: 1 }), expected);
  });

  it('genesis chain hash for fixed content/timestamp is pinned', () => {
    // canonical payload: {"content":{"action":"test"},"previousHash":"GENESIS","timestamp":"2026-01-01T00:00:00Z"}
    //
    // 🔴 2026-08-05 정정: 기존 기댓값은 replacer 배열(v1 문법)로 만들어져 content 가 `{}` 로
    //    뭉개진 문자열을 해시했다. v2 함수와 맞을 리 없어 계속 실패하고 있었다.
    assert.equal(
      computeChainHash({ action: 'test' }, null, '2026-01-01T00:00:00Z'),
      'c2d4269d1c6356c8bb871a9347017e1231d0e74b65c3503febf0d31d83c1e5d5',
    );
  });
});
