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
  canonicalize,
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

describe('🔴 verifyPolicyHash 는 strict — v1 폴백을 기본값에 두지 않는다', () => {
  const policy = { a: { b: 1 } };

  it('🔴 v1 해시는 boolean API 로 통과하지 않는다', () => {
    // 한 번 폴백을 넣었다가 되돌렸다. v1 은 중첩을 커밋한 적이 없어
    // **v1 해시로 저장된 정책은 중첩을 변조해도 v1 재계산이 그대로 맞는다.**
    // 폴백이 기본값이면 이 릴리스가 고친 변조 불감이 boolean 에서 재현된다.
    assert.equal(verifyPolicyHash(policy, generatePolicyHashV1(policy)), false);
  });

  it('🔴 그 위험을 실증한다 — v1 은 중첩 변조본도 통과시킨다', () => {
    const tampered = { a: { b: 999 } };
    // v1 계산으로는 원본과 변조본이 같은 해시다(중첩을 안 덮으므로)
    assert.equal(generatePolicyHashV1(policy), generatePolicyHashV1(tampered));
    // 그래서 boolean 이 v1 을 받아주면 변조본이 통과한다 — 지금은 차단된다
    assert.equal(verifyPolicyHash(tampered, generatePolicyHashV1(policy)), false);
  });

  it('🪤 0.2.0 도 strict 였다 — 폴백은 검증을 느슨하게 만드는 변경이었다', () => {
    // 어제 false 이던 것이 오늘 true 가 되면 그건 수리가 아니라 회귀다.
    assert.equal(verifyPolicyHash(policy, generatePolicyHashV1(policy)), false);
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

describe('🔴 toJSON 을 존중한다 — v2 가 Date 를 뭉개고 있었다', () => {
  it('Date 가 ISO 문자열로 커밋된다', () => {
    assert.equal(canonicalizeFlat({ a: new Date('2026-01-01T00:00:00.000Z') }), '{"a":"2026-01-01T00:00:00.000Z"}');
  });

  it('🔴 Date 값이 다르면 해시가 다르다 — 안 그러면 v1 보다 나쁘다', () => {
    assert.notEqual(computeObjectHash({ a: new Date(0) }), computeObjectHash({ a: new Date(99999) }));
  });

  it('🪤 v1 은 toJSON 을 탔다 — own-enumerable 만 복사하면 그게 끊긴다', () => {
    // 이 결함의 교훈: 「중첩을 조용히 버리는 해시 함수를 남기면 안 된다」가
    // v2 자신에게도 적용된다. Date 는 own key 가 0개라 `{}` 로 뭉개졌었다.
    assert.equal(canonicalizeFlatV1({ a: new Date(0) }).includes('1970-01-01'), true);
  });

  it('중첩된 toJSON 도 탄다', () => {
    assert.equal(canonicalizeFlat({ n: { d: new Date(0) } }), '{"n":{"d":"1970-01-01T00:00:00.000Z"}}');
  });
});

describe('🪤 canonicalizeFlat 은 canonicalize 의 alias 다 (deprecated)', () => {
  it('두 함수가 같은 결과를 낸다 — 이름이 만든 착각을 코드로 없앤다', () => {
    const x = { b: { d: 1, c: 2 }, a: 3, arr: [{ z: 1, y: 2 }] };
    assert.equal(canonicalizeFlat(x), canonicalize(x));
  });
});

describe('🔴 own-key 0개 객체 / 프로토타입 오염 / 순환 — 조용히 뭉개지 않는다', () => {
  it('🔴 `__proto__` 키가 살아남는다 — second-preimage 방어', () => {
    // 일반 `{}` 에 `out["__proto__"] = x` 는 **프로토타입 setter 로 흘러 키가 조용히 소실된다.**
    // 실측: {"__proto__":{"evil":1},"a":1} → {"a":1} 로 evil 이 해시 밖으로 나갔다.
    // ⇒ 서로 다른 원본이 같은 해시를 낸다. `Object.create(null)` 로 막는다.
    const withProto = JSON.parse('{"__proto__":{"evil":1},"a":1}');
    assert.equal(canonicalize(withProto), '{"__proto__":{"evil":1},"a":1}');
    assert.notEqual(computeObjectHash(withProto), computeObjectHash({ a: 1 }));
  });

  it('🔴 Map/Set 은 거부한다 — `{}` 로 뭉개면 내용이 해시 밖으로 나간다', () => {
    // Date 와 **정확히 같은 부류**다(own-enumerable 키 0개). 단 toJSON 도 없다.
    // 조용히 비우느니 거부한다 — 소비자가 자기 표현을 정해서 넘겨야 한다.
    assert.throws(() => canonicalize({ a: new Map([['k', 1]]) }), /Map\/Set/);
    assert.throws(() => canonicalize({ a: new Set([1]) }), /Map\/Set/);
  });

  it('🔴 순환 참조는 거부한다 — 스택 오버플로 대신 명시적으로', () => {
    const o: Record<string, unknown> = { a: 1 };
    o.self = o;
    assert.throws(() => canonicalize(o), /순환 참조/);

    const arr: unknown[] = [1];
    arr.push(arr);
    assert.throws(() => canonicalize({ arr }), /순환 참조/);
  });

  it('🪤 DAG 는 순환이 아니다 — 형제가 같은 객체를 참조해도 통과한다', () => {
    // `seen` 을 「본 적 있는 것 전부」로 두면 이게 순환으로 오판된다.
    // **현재 경로(ancestor)** 여야 한다 — 실제 데이터에 흔한 모양이다.
    const shared = { x: 1 };
    assert.equal(canonicalize({ a: shared, b: shared }), '{"a":{"x":1},"b":{"x":1}}');
    assert.equal(canonicalize({ l: [shared, shared] }), '{"l":[{"x":1},{"x":1}]}');
  });

  it('🪤 BigInt 는 JSON.stringify 가 거부한다 — 그게 맞다', () => {
    // 조용히 문자열로 바꾸면 `1n` 과 `"1"` 이 같은 해시가 된다. 모르는 건 거부한다.
    assert.throws(() => canonicalize({ a: 1n as unknown }));
  });
});
