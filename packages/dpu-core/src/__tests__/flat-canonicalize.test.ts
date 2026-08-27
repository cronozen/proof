/**
 * `canonicalizeFlat` 계열 v1/v2 회귀 — 0.3.0
 *
 * 🔴 0.2.0 은 `canonicalize` 와 `canonicalizeChainPayload` **둘만** 고쳤다.
 *    `canonicalizeFlat` 은 그대로였고, 그 위의 `computeObjectHash`·`generatePolicyHash` 가
 *    **중첩 값 변조를 원리적으로 못 잡았다.**
 * 🪤 이름이 "Flat" 이라 「평면만 다룬다」로 읽히지만 실제 소비자는 중첩을 넣었다
 *    (ops 워크플로 정의 `graphHash` · 정책 스냅샷). **이름이 만든 착각이었다.**
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeFlat,
  canonicalizeFlatV1,
  computeObjectHash,
  computeObjectHashV1,
  generatePolicyHash,
  generatePolicyHashV1,
  verifyPolicyHash,
  verifyPolicyHashDetailed,
} from '../index';

describe('canonicalizeFlat v2 — 중첩을 비우지 않는다', () => {
  it('🔴 중첩 객체의 키가 살아남는다', () => {
    assert.equal(canonicalizeFlat({ a: 'A', n: { x: 1 } }), '{"a":"A","n":{"x":1}}');
  });

  it('🪤 v1 은 중첩을 비운다 — 레거시 재현용으로 그 성질을 보존한다', () => {
    assert.equal(canonicalizeFlatV1({ a: 'A', n: { x: 1 } }), '{"a":"A","n":{}}');
  });

  it('모든 깊이를 정렬한다 (결정론)', () => {
    assert.equal(canonicalizeFlat({ b: { d: 1, c: 2 }, a: 3 }), canonicalizeFlat({ a: 3, b: { c: 2, d: 1 } }));
  });
});

describe('🔴 중첩 값 변조를 잡는다 — v1 이 못 잡던 것', () => {
  it('computeObjectHash — 중첩값이 다르면 해시가 다르다', () => {
    assert.notEqual(computeObjectHash({ w: { from: 'A' } }), computeObjectHash({ w: { from: 'X' } }));
  });

  it('generatePolicyHash — 중첩값이 다르면 해시가 다르다', () => {
    assert.notEqual(generatePolicyHash({ a: { b: 1 } }), generatePolicyHash({ a: { b: 2 } }));
  });

  it('🪤 v1 은 여전히 못 잡는다 — 이 사실 자체가 「v1 통과 ≠ 무결」의 근거다', () => {
    assert.equal(computeObjectHashV1({ w: { from: 'A' } }), computeObjectHashV1({ w: { from: 'X' } }));
    assert.equal(generatePolicyHashV1({ a: { b: 1 } }), generatePolicyHashV1({ a: { b: 2 } }));
  });

  it('🔴 v1 ≠ v2 — breaking 이라 minor 를 올렸다', () => {
    assert.notEqual(generatePolicyHash({ a: { b: 1 } }), generatePolicyHashV1({ a: { b: 1 } }));
  });
});

describe('🔑 ops graphHash 실사례 — 의존관계·액션 변조가 안 잡히고 있었다', () => {
  // src/core/automation/engine.ts:620 이 만드는 모양. 주석은 「변조 감지」라고 적혀 있었다.
  const mk = (dependsOn: string[], dpuAction: string) => ({
    name: 'wf',
    domain: 'd',
    steps: [{ name: 's1', dependsOn, dpuAction }],
  });

  it('dependsOn 변조를 잡는다 (v1 은 못 잡았다)', () => {
    assert.notEqual(computeObjectHash(mk([], 'A')), computeObjectHash(mk(['해킹'], 'A')));
    assert.equal(computeObjectHashV1(mk([], 'A')), computeObjectHashV1(mk(['해킹'], 'A')));
  });

  it('dpuAction 변조를 잡는다 (v1 은 못 잡았다)', () => {
    assert.notEqual(computeObjectHash(mk([], 'A')), computeObjectHash(mk([], 'DELETE_ALL')));
    assert.equal(computeObjectHashV1(mk([], 'A')), computeObjectHashV1(mk([], 'DELETE_ALL')));
  });
});

describe('폴백 검증 — v2 먼저, v1 은 별도 칸', () => {
  const policy = { a: { b: 1 } };

  it('v1 으로 만든 해시가 verifyPolicyHash 로 통과한다 (기존 스냅샷이 안 죽는다)', () => {
    assert.equal(verifyPolicyHash(policy, generatePolicyHashV1(policy)), true);
  });

  it('v2 도 통과한다', () => {
    assert.equal(verifyPolicyHash(policy, generatePolicyHash(policy)), true);
  });

  it('🔴 상세 검증이 v1/v2 를 구분한다 — contentBound 가 진실이다', () => {
    assert.deepEqual(verifyPolicyHashDetailed(policy, generatePolicyHashV1(policy)), {
      matched: true, scheme: 'v1', contentBound: false,
    });
    assert.deepEqual(verifyPolicyHashDetailed(policy, generatePolicyHash(policy)), {
      matched: true, scheme: 'v2', contentBound: true,
    });
  });

  it('둘 다 아니면 불일치', () => {
    assert.equal(verifyPolicyHash(policy, 'deadbeef'), false);
    assert.deepEqual(verifyPolicyHashDetailed(policy, 'deadbeef'), {
      matched: false, scheme: null, contentBound: false,
    });
  });
});
