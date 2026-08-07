/**
 * 🎯 적대적 검증 하네스
 *
 * ## 왜 있나 (2026-08-06)
 *
 * 공격 테스트가 `it()` 마다 흩어져 있으면 두 가지가 안 된다:
 *   ① **구조를 바꿀 때 무엇이 깨지는지 한눈에 안 보인다.** 봉인을 UPDATE 에서 체인 append 로
 *      바꾸는 것 같은 변경은 여러 검사에 동시에 영향을 준다. 표가 없으면 하나씩 손으로 따라가야 한다.
 *   ② **공격 목록 자체가 자산인데 코드에 흩어져 있으면 목록으로 못 읽는다.** 감사에서 "무엇을
 *      막는가"를 묻는 자리에 내밀 것이 테스트 파일 700줄이면 안 된다.
 *
 * 그래서 공격을 **데이터로 선언**하고 러너가 돌린다. 새 공격은 배열에 한 줄 추가다.
 *
 * ## 이 하네스가 스스로 지키는 불변식 두 개
 *
 * 러너는 공격마다 **두 번** 판정한다:
 *   1. 변조 **전** 기준선이 `verified: true` 여야 한다 — 아니면 항상 false 를 뱉는 엔진이 통과한다
 *   2. 변조 **후** `verified: false` 여야 하고, **지목한 검사**가 실패해야 한다
 *
 * 이 쌍이 핵심이다. 하나만 보면 "전부 통과" 엔진이나 "전부 실패" 엔진이 초록으로 지나간다.
 * (이 레포에서 반복된 실패 방식이 정확히 '가드가 초록인데 아무것도 안 지키는 것'이다.)
 */

import type { Database } from 'better-sqlite3';

/** 검증 응답에서 우리가 판정에 쓰는 부분만. */
export interface VerifyResponse {
  verified: boolean;
  checks: {
    chainHash: { ok: boolean; detail?: string; matchedScheme: string | null; contentBound: boolean | null };
    contentCoverage: { ok: boolean; detail?: string; contentBound: boolean | null; legacyAccepted: boolean };
    chainLink: { ok: boolean; detail?: string };
    seal: { ok: boolean; detail?: string };
    serverSignature: { status: string; detail?: string };
    anchor: { ok: boolean; status: string; detail?: string; externallyAttested?: boolean };
  };
  failures: string[];
  evidence: Record<string, unknown>;
}

export type CheckName = 'chainHash' | 'contentCoverage' | 'chainLink' | 'seal' | 'serverSignature' | 'anchor';

export interface AttackContext {
  db: Database;
  /** 이 공격 전용 체인 도메인. 공격끼리 서로 오염시키지 않는다. */
  domain: string;
  /** setup 이 만든 레코드들 (기록 순서). */
  records: { evidenceId: string; decisionId: string }[];
  /** 공격 대상 — 기본은 records[0]. */
  target: { evidenceId: string; decisionId: string };
}

export interface Attack {
  /** 안정 식별자. 보고서·이슈에서 이 값으로 부른다. */
  id: string;
  /** 한 줄 설명 — 무엇을 하는 공격인가. */
  what: string;
  /** 왜 이게 위험한가. 감사에서 읽히는 문장이므로 결과를 적는다. */
  impact: string;
  /**
   * 필요한 초기 상태.
   *   'record'  — 미봉인 레코드 1건
   *   'sealed'  — 승인(approved)까지 끝난 레코드 1건
   *   'rejected'— 반려(rejected)된 레코드 1건
   *   'chain3'  — 같은 도메인에 3건 (target = 가운데)
   *   'anchored'— 3건 기록 후 **앵커를 찍는다** (target = 가운데)
   *   'anchoredSeal' — 기록+승인 후 앵커 (target = 결정 레코드)
   */
  setup: 'record' | 'sealed' | 'rejected' | 'chain3' | 'anchored' | 'anchoredSeal';
  /** DB 를 직접 조작한다 — 공격자가 쓰기 권한을 얻은 상황 그대로. */
  mutate(ctx: AttackContext): void;
  /** 이 검사가 실패해야 한다. 다른 검사가 대신 잡으면 그건 우연이므로 실패로 본다. */
  detectedBy: CheckName;
  /** 실패 사유가 이 패턴이어야 한다(선택). 문구가 바뀌면 알아채려는 것. */
  detailMatches?: RegExp;
  /**
   * 🔴 아직 못 막는 공격. `true` 면 러너가 **탐지 실패를 기대**한다.
   * 이렇게 표시해두면 (a) 목록에 남아 잊히지 않고 (b) 나중에 막았을 때 러너가
   * "이제 잡힌다"고 알려준다. 못 막는 것을 테스트에서 지우면 없는 문제가 된다.
   */
  knownGap?: { why: string; needs: string };
}

export interface AttackResult {
  attack: Attack;
  baselineVerified: boolean;
  afterVerified: boolean;
  failingCheck: CheckName | null;
  passed: boolean;
  note?: string;
}

/** 러너가 필요로 하는 외부 배선 — 테스트 파일이 주입한다. */
export interface HarnessDeps {
  db: Database;
  /** 도메인에 레코드 1건 기록하고 식별자를 돌려준다. */
  record(domain: string): Promise<{ evidenceId: string; decisionId: string }>;
  /** 승인 또는 반려한다 — 둘 다 봉인이다. */
  approve(decisionId: string, result: 'approved' | 'rejected'): Promise<void>;
  /** 공개 검증을 부른다. */
  verify(evidenceId: string): Promise<VerifyResponse>;
  /** 지금 시점의 체인 머리를 앵커한다. */
  anchor(): Promise<void>;
}

async function buildSetup(deps: HarnessDeps, attack: Attack, domain: string): Promise<AttackContext> {
  const records: { evidenceId: string; decisionId: string }[] = [];

  const many = attack.setup === 'chain3' || attack.setup === 'anchored';
  const count = many ? 3 : 1;
  for (let i = 0; i < count; i += 1) records.push(await deps.record(domain));

  if (attack.setup === 'sealed') await deps.approve(records[0].decisionId, 'approved');
  if (attack.setup === 'rejected') await deps.approve(records[0].decisionId, 'rejected');
  if (attack.setup === 'anchoredSeal') await deps.approve(records[0].decisionId, 'approved');

  // 앵커는 **마지막에** 찍는다 — 지금 머리를 박제하는 것이므로.
  if (attack.setup === 'anchored' || attack.setup === 'anchoredSeal') await deps.anchor();

  // chain3/anchored 는 가운데를 노린다 — 앞뒤 링크가 둘 다 있는 유일한 위치다.
  const target = many ? records[1] : records[0];
  return { db: deps.db, domain, records, target };
}

function firstFailingCheck(res: VerifyResponse): CheckName | null {
  if (!res.checks.chainHash.ok) return 'chainHash';
  if (!res.checks.contentCoverage.ok) return 'contentCoverage';
  if (!res.checks.chainLink.ok) return 'chainLink';
  if (!res.checks.seal.ok) return 'seal';
  if (res.checks.serverSignature.status === 'invalid' || res.checks.serverSignature.status === 'missing') {
    return 'serverSignature';
  }
  if (!res.checks.anchor.ok) return 'anchor';
  return null;
}

/**
 * 공격 하나를 돌린다.
 *
 * 실패 판정은 넉넉하지 않다 — `verified:false` 만으로는 통과시키지 않고
 * **지목한 검사**가 실패해야 한다. 엉뚱한 검사가 우연히 잡는 것을 "막았다"로 세면,
 * 나중에 그 우연이 사라졌을 때 아무도 모른다.
 */
export async function runAttack(deps: HarnessDeps, attack: Attack): Promise<AttackResult> {
  const domain = `atk-${attack.id}`;
  const ctx = await buildSetup(deps, attack, domain);

  const before = await deps.verify(ctx.target.evidenceId);
  if (!before.verified) {
    return {
      attack,
      baselineVerified: false,
      afterVerified: before.verified,
      failingCheck: firstFailingCheck(before),
      passed: false,
      note: `기준선이 이미 실패했다 — 공격이 아니라 셋업이나 엔진이 문제다: ${JSON.stringify(before.failures)}`,
    };
  }

  attack.mutate(ctx);

  const after = await deps.verify(ctx.target.evidenceId);
  const failing = firstFailingCheck(after);

  if (attack.knownGap) {
    // 못 막는 것으로 선언된 공격: 여전히 통과해야 "알려진 갭"이 유지된 것이다.
    // 만약 잡히기 시작했다면 그것도 알려준다 — 갭 표시를 지울 때가 된 것이다.
    return {
      attack,
      baselineVerified: true,
      afterVerified: after.verified,
      failingCheck: failing,
      passed: after.verified === true,
      note: after.verified
        ? `알려진 갭 유지 — ${attack.knownGap.needs} 가 있어야 잡힌다`
        : '🎉 알려진 갭이 이제 탐지된다 — knownGap 표시를 지워라',
    };
  }

  const detailOk =
    !attack.detailMatches || attack.detailMatches.test(after.checks[attack.detectedBy].detail ?? '');

  return {
    attack,
    baselineVerified: true,
    afterVerified: after.verified,
    failingCheck: failing,
    passed: after.verified === false && failing === attack.detectedBy && detailOk,
    note:
      after.verified === true
        ? '🔴 변조가 탐지되지 않았다'
        : failing !== attack.detectedBy
          ? `다른 검사가 잡았다: ${failing} (기대: ${attack.detectedBy}) — 우연일 수 있다`
          : !detailOk
            ? `사유 문구가 기대와 다르다: ${after.checks[attack.detectedBy].detail}`
            : undefined,
  };
}

/** 사람이 읽는 요약 — 감사·리뷰에 그대로 붙일 수 있는 형태. */
export function formatResults(results: AttackResult[]): string {
  const lines = results.map(r => {
    const mark = r.passed ? '✔' : '✖';
    const gap = r.attack.knownGap ? ' 🔴갭' : '';
    return `${mark}${gap} ${r.attack.id.padEnd(28)} ${r.attack.what}${r.note ? `\n     ↳ ${r.note}` : ''}`;
  });
  const gaps = results.filter(r => r.attack.knownGap).length;
  const failed = results.filter(r => !r.passed).length;
  return [
    ...lines,
    '',
    `총 ${results.length}건 · 실패 ${failed}건 · 알려진 갭 ${gaps}건`,
  ].join('\n');
}
