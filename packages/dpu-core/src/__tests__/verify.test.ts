/**
 * 체인 검증 판정 엔진 테스트
 *
 * 이 엔진은 "무엇을 통과로 볼 것인가"의 단일 정본이다. 여기가 틀리면 모든 검증기가 같이 틀린다.
 * 그래서 정상 경로보다 **거짓 통과**를 먼저 막는다.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateChainHash,
  evaluateChainLink,
  evaluateVerification,
  type ChainHashCandidate,
} from '../verify';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

function bound(scheme: string, hash: string): ChainHashCandidate {
  return { scheme, hash, contentBound: true };
}
function unbound(scheme: string, hash: string): ChainHashCandidate {
  return { scheme, hash, contentBound: false };
}

// ─── F10: 라벨이 아니라 실제로 맞은 계산이 진실이다 ──────────────────

describe('F10 회귀 — contentBound 는 일치한 후보에서 나온다', () => {
  it('내용을 안 덮는 계산으로 맞으면 contentBound=false 다', () => {
    // ops v1(직렬화 버그로 content 가 {} 로 뭉개짐) 로 맞은 경우.
    // 예전 구현은 저장된 라벨이 v2 라는 이유로 contentBound:true 를 보고했다 —
    // 검증한 적 없는 내용을 "결속됨" 으로 통과시키는 거짓 보고다.
    const verdict = evaluateChainHash(HASH_A, [
      bound('ops.v2', HASH_B),   // 안 맞음
      unbound('ops.v1', HASH_A), // 맞음 — 내용 미포함
    ]);

    assert.equal(verdict.ok, true);
    assert.equal(verdict.matchedScheme, 'ops.v1');
    assert.equal(verdict.contentBound, false, '내용을 안 덮는 계산으로 맞았는데 결속됐다고 보고했다');
    assert.match(verdict.detail!, /does not cover the record content/i);
  });

  it('내용을 덮는 계산으로 맞으면 contentBound=true 다', () => {
    const verdict = evaluateChainHash(HASH_A, [bound('proof.v3', HASH_A)]);

    assert.equal(verdict.ok, true);
    assert.equal(verdict.matchedScheme, 'proof.v3');
    assert.equal(verdict.contentBound, true);
    assert.equal(verdict.detail, undefined);
  });

  it('아무것도 안 맞으면 contentBound 를 단정하지 않는다 (null)', () => {
    const verdict = evaluateChainHash(HASH_A, [bound('proof.v3', HASH_B), unbound('ops.v1', HASH_C)]);

    assert.equal(verdict.ok, false);
    assert.equal(verdict.matchedScheme, null);
    assert.equal(verdict.contentBound, null, '실패했는데 결속 여부를 단정했다');
  });

  it('후보가 비어 있으면 통과하지 않는다', () => {
    assert.equal(evaluateChainHash(HASH_A, []).ok, false);
  });

  it('저장된 해시가 없으면 통과하지 않는다', () => {
    const verdict = evaluateChainHash(null, [bound('proof.v3', HASH_A)]);
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail!, /no chain hash/i);
  });

  it('엔진은 스킴 이름을 해석하지 않는다 — 임의 문자열도 그대로 돌려준다', () => {
    // ops 는 v1/v2(직렬화 축), proof 는 v2/v3(커버리지 축)을 쓴다.
    // 엔진이 이름을 해석하면 한쪽이 반드시 틀린다.
    const verdict = evaluateChainHash(HASH_A, [{ scheme: '아무거나-v9', hash: HASH_A, contentBound: true }]);
    assert.equal(verdict.matchedScheme, '아무거나-v9');
    assert.equal(verdict.contentBound, true);
  });
});

// ─── 링크 3상태 ────────────────────────────────────────────────────

describe('링크 3상태 — 없는 것과 어긋난 것은 다르다', () => {
  const base = { chainIndex: 5, previousHash: HASH_A, previousLinkValid: true, nextLinkValid: true };

  it('앞뒤 모두 일치하면 통과', () => {
    assert.equal(evaluateChainLink(base).ok, true);
  });

  it('대상이 없으면(null) 통과로 본다 — 체인의 시작/끝', () => {
    assert.equal(evaluateChainLink({ ...base, nextLinkValid: null }).ok, true);
    assert.equal(evaluateChainLink({ ...base, previousLinkValid: null, nextLinkValid: null }).ok, true);
  });

  it('선행 링크가 어긋나면 실패', () => {
    const verdict = evaluateChainLink({ ...base, previousLinkValid: false });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail!, /reordered or rewritten/i);
  });

  it('선행 레코드가 아예 없으면 "gap" 으로 말한다', () => {
    const verdict = evaluateChainLink({ ...base, previousLinkValid: false, previousMissing: true });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail!, /missing|gap/i);
    assert.match(verdict.detail!, /index 4/);
  });

  it('🔴 후행 링크가 어긋나면 실패 — 앞만 보면 뒤가 끊겨도 통과한다', () => {
    const verdict = evaluateChainLink({ ...base, nextLinkValid: false });
    assert.equal(verdict.ok, false, '후행 링크를 안 보면 여기서 통과한다');
    assert.match(verdict.detail!, /following record/i);
  });

  it('genesis 는 선행 해시를 가지면 안 된다', () => {
    const verdict = evaluateChainLink({
      chainIndex: 0,
      previousHash: HASH_A,
      previousLinkValid: null,
      nextLinkValid: null,
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.genesisValid, false);
    assert.match(verdict.detail!, /genesis/i);
  });

  it('정상 genesis 는 통과', () => {
    const verdict = evaluateChainLink({
      chainIndex: 0,
      previousHash: null,
      previousLinkValid: null,
      nextLinkValid: true,
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.genesisValid, true);
    assert.match(verdict.detail!, /genesis/i);
  });
});

// ─── 종합 판정 ─────────────────────────────────────────────────────

describe('evaluateVerification 종합', () => {
  const ok = {
    storedChainHash: HASH_A,
    candidates: [bound('proof.v3', HASH_A)],
    chainIndex: 3,
    previousHash: HASH_B,
    previousLinkValid: true,
    nextLinkValid: true,
  };

  it('전부 맞으면 verified=true, failures 는 빈 배열', () => {
    const v = evaluateVerification(ok);
    assert.equal(v.verified, true);
    assert.deepEqual(v.failures, []);
    assert.equal(v.chainHash.contentBound, true);
  });

  it('해시가 틀리면 verified=false 이고 사유가 남는다', () => {
    const v = evaluateVerification({ ...ok, storedChainHash: HASH_C });
    assert.equal(v.verified, false);
    assert.equal(v.failures.length, 1);
    assert.match(v.failures[0], /^chainHash:/);
  });

  it('링크가 틀리면 verified=false', () => {
    const v = evaluateVerification({ ...ok, nextLinkValid: false });
    assert.equal(v.verified, false);
    assert.match(v.failures[0], /^chainLink:/);
  });

  it('둘 다 틀리면 사유가 둘 다 남는다', () => {
    const v = evaluateVerification({ ...ok, storedChainHash: HASH_C, previousLinkValid: false });
    assert.equal(v.verified, false);
    assert.equal(v.failures.length, 2);
  });

  it('🔴 내용 미결속으로 통과해도 verified 는 true 다 — 그래서 contentBound 를 함께 봐야 한다', () => {
    // 이 조합이 위험하다: 해시는 맞고 링크도 맞으니 verified:true 인데,
    // 실제로 덮인 건 레코드 일부뿐이다. 호출자는 반드시 contentBound 를 함께 노출해야 한다.
    const v = evaluateVerification({ ...ok, candidates: [unbound('proof.v2', HASH_A)] });
    assert.equal(v.verified, true);
    assert.equal(v.chainHash.contentBound, false);
  });
});
