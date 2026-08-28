/**
 * 재계산 후보 생성 테스트
 *
 * 이 파일이 막는 것은 두 부류다:
 *  ① **거짓 통과** — 내용을 안 덮는 계산으로 통과시키고 "내용이 그대로다" 라고 말하는 것
 *  ② **거짓 실패** — 정상 레코드를 불일치로 보고하는 것(감사에서 신뢰를 잃는 쪽은 이쪽도 같다)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildChainHashCandidates,
  diffStoredContentAgainstRow,
  strictLegacyFallback,
  CHAIN_CORE_FIELDS,
  type ChainVerificationRow,
} from '../chain-verification';
import { computeChainHash, computeChainHashV1 } from '../hash';
import { evaluateChainHash } from '../verify';

const PREV = 'a'.repeat(64);
const TS = '2026-01-02T03:04:05.000Z';

function row(over: Partial<ChainVerificationRow> = {}): ChainVerificationRow {
  return {
    domain: 'rehab',
    purpose: '치료 배정',
    final_action: 'assign',
    final_responsible: 'actor-1',
    previous_hash: PREV,
    executed_at: TS,
    ...over,
  };
}

const CORE = {
  domain: 'rehab',
  purpose: '치료 배정',
  final_action: 'assign',
  final_responsible: 'actor-1',
};

describe('buildChainHashCandidates — 기본(엄격) 정책', () => {
  it('v2 · 행 기준 후보를 낸다', () => {
    const c = buildChainHashCandidates(row());
    assert.equal(c.length, 1);
    assert.deepEqual(
      { scheme: c[0].scheme, source: c[0].source, contentBound: c[0].contentBound },
      { scheme: 'v2', source: 'row', contentBound: true }
    );
    assert.equal(c[0].hash, computeChainHash(CORE, PREV, TS));
  });

  it('🔴 라벨이 없으면 v1 폴백을 주지 않는다 — 라벨을 지워 검증 기준을 고르는 경로를 막는다', () => {
    const c = buildChainHashCandidates(row({ chain_hash_version: null }));
    assert.equal(c.filter(x => x.scheme === 'v1').length, 0);
  });

  it('🔴 알 수 없는 스킴도 v1 폴백을 주지 않는다', () => {
    for (const s of ['v0-unrecoverable', 'V1', 'v2 ', 'nonsense']) {
      const c = buildChainHashCandidates(row({ chain_hash_version: s }));
      assert.equal(c.filter(x => x.scheme === 'v1').length, 0, `스킴 ${JSON.stringify(s)}`);
    }
  });

  it("명시적 'v1' 이면 폴백을 준다", () => {
    const c = buildChainHashCandidates(row({ chain_hash_version: 'v1' }));
    const v1 = c.filter(x => x.scheme === 'v1');
    assert.ok(v1.length >= 1);
    assert.ok(v1.every(x => x.contentBound === false), 'v1 은 절대 contentBound 가 아니다');
  });

  it('v2 로 기록된 행에는 v1 폴백이 없다 — 관용 정책을 줘도 마찬가지', () => {
    const c = buildChainHashCandidates(row({ chain_hash_version: 'v2' }), {
      allowLegacyV1Fallback: s => s !== 'v2',
    });
    assert.equal(c.filter(x => x.scheme === 'v1').length, 0);
  });
});

describe('compatibility profile — 관용은 호출자가 명시한다', () => {
  it('라벨 없는 레거시를 살리려면 정책을 넘겨야 한다', () => {
    const strict = buildChainHashCandidates(row({ chain_hash_version: null }));
    const lenient = buildChainHashCandidates(row({ chain_hash_version: null }), {
      allowLegacyV1Fallback: s => s !== 'v2',
    });
    assert.equal(strict.filter(x => x.scheme === 'v1').length, 0);
    assert.ok(lenient.filter(x => x.scheme === 'v1').length >= 1);
  });

  it('strictLegacyFallback 이 export 되어 기본값과 같다', () => {
    assert.equal(strictLegacyFallback('v1'), true);
    assert.equal(strictLegacyFallback('v2'), false);
    assert.equal(strictLegacyFallback(null), false);
    assert.equal(strictLegacyFallback(undefined), false);
    assert.equal(strictLegacyFallback('v0-unrecoverable'), false);
  });
});

describe('🔴 저장 복사본 후보 — contentBound 는 복사본이 행과 같을 때만 참이다', () => {
  const stored = { ...CORE };

  it('복사본이 행과 같으면 contentBound=true', () => {
    const c = buildChainHashCandidates(
      row({ chain_hash_version: 'v2', chain_content: stored, chain_timestamp: TS })
    );
    const s = c.find(x => x.source === 'stored');
    assert.ok(s);
    assert.equal(s.contentBound, true);
  });

  it('🔴 행이 바뀌었는데 복사본이 그대로면 contentBound=false — 해시는 맞아도 행을 못 보증한다', () => {
    const c = buildChainHashCandidates(
      row({
        final_action: 'REVOKED', // 행만 바뀌었다
        chain_hash_version: 'v2',
        chain_content: stored, // 복사본은 옛 값
        chain_timestamp: TS,
      })
    );
    const s = c.find(x => x.source === 'stored');
    assert.ok(s, '후보 자체는 나온다 — 그래야 거짓 실패를 안 낸다');
    assert.equal(s.contentBound, false, '그러나 내용 보증은 아니다');
  });

  it('🔴 그 거짓 통과가 엔진 판정문까지 가지 않는다', () => {
    const c = buildChainHashCandidates(
      row({
        final_action: 'REVOKED',
        chain_hash_version: 'v2',
        chain_content: stored,
        chain_timestamp: TS,
      })
    );
    const s = c.find(x => x.source === 'stored')!;
    const verdict = evaluateChainHash(s.hash, c);
    assert.equal(verdict.ok, true, '해시는 맞는다');
    assert.equal(verdict.contentBound, false, '내용 보증은 아니라고 말한다');
    assert.ok(verdict.detail, '왜 약한 주장인지 사유가 남는다');
  });

  it('저장 복사본이 v1 이면 contentBound 는 언제나 false', () => {
    const c = buildChainHashCandidates(
      row({ chain_hash_version: 'v1', chain_content: stored, chain_timestamp: TS })
    );
    const s = c.find(x => x.source === 'stored');
    assert.ok(s);
    assert.equal(s.contentBound, false);
    assert.equal(s.hash, computeChainHashV1(stored, PREV, TS));
  });

  it('🪤 스킴이 알 수 없는 값이면 저장 복사본 후보를 아예 안 만든다 — v2 로 승격 금지', () => {
    for (const s of ['v0-unrecoverable', null, undefined, 'weird']) {
      const c = buildChainHashCandidates(
        row({ chain_hash_version: s as string, chain_content: stored, chain_timestamp: TS })
      );
      assert.equal(c.filter(x => x.source === 'stored').length, 0, `스킴 ${String(s)}`);
    }
  });

  it('chain_content 가 배열이면 무시한다(객체가 아니다)', () => {
    const c = buildChainHashCandidates(
      row({ chain_hash_version: 'v2', chain_content: [1, 2] as unknown as Record<string, unknown>, chain_timestamp: TS })
    );
    assert.equal(c.filter(x => x.source === 'stored').length, 0);
  });
});

describe('diffStoredContentAgainstRow', () => {
  it('복사본이 없으면 null — 모르는 것은 모른다고 답한다', () => {
    assert.equal(diffStoredContentAgainstRow(null, CORE), null);
    assert.equal(diffStoredContentAgainstRow(undefined, CORE), null);
  });

  it('일치하면 빈 배열', () => {
    assert.deepEqual(diffStoredContentAgainstRow({ ...CORE }, CORE), []);
  });

  it('발산한 필드명을 돌려준다', () => {
    assert.deepEqual(
      diffStoredContentAgainstRow({ ...CORE, final_action: 'other' }, CORE),
      ['final_action']
    );
  });

  it('🪤 복사본에 없는 키는 건너뛴다 — 없는 것을 불일치로 세면 정상 레코드가 거짓 실패한다', () => {
    const partial = { domain: 'rehab' };
    assert.deepEqual(diffStoredContentAgainstRow(partial, CORE), []);
  });

  it('null 과 undefined 는 같은 것으로 본다', () => {
    assert.deepEqual(
      diffStoredContentAgainstRow({ domain: null }, { domain: undefined }),
      []
    );
  });

  it('CHAIN_CORE_FIELDS 가 4필드로 고정돼 있다 — 늘리면 옛 레코드가 거짓 실패한다', () => {
    assert.deepEqual([...CHAIN_CORE_FIELDS], [
      'domain', 'purpose', 'final_action', 'final_responsible',
    ]);
  });
});

describe('시각 소스', () => {
  it('executed_at 이 없으면 created_at 을 쓴다', () => {
    const c = buildChainHashCandidates(row({ executed_at: null, created_at: TS }));
    assert.equal(c[0].hash, computeChainHash(CORE, PREV, TS));
  });

  it('Date 객체도 ISO 로 정규화한다', () => {
    const c = buildChainHashCandidates(row({ executed_at: new Date(TS) }));
    assert.equal(c[0].hash, computeChainHash(CORE, PREV, TS));
  });

  it('시각이 아예 없으면 행 기준 후보가 없다', () => {
    const c = buildChainHashCandidates(row({ executed_at: null, created_at: null }));
    assert.equal(c.filter(x => x.source === 'row').length, 0);
  });

  it("created_at 이 executed_at 과 다르면 v1 폴백 후보가 하나 더 (명시 'v1' 일 때)", () => {
    const other = '2026-01-02T09:09:09.000Z';
    const c = buildChainHashCandidates(
      row({ chain_hash_version: 'v1', executed_at: TS, created_at: other })
    );
    assert.equal(c.filter(x => x.scheme === 'v1' && x.source === 'row').length, 2);
  });
});
