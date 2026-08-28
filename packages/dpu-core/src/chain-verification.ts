/**
 * chain_hash 재계산 **후보 생성** + 행↔chain_content 결속 판정
 *
 * ## 이게 왜 무료(core)인가
 *
 * `verify.ts` 는 판정 **엔진**이다 — 후보를 받아 verdict 를 낸다.
 * 이 파일은 그 앞단, **후보 생성기**다. 둘은 중복이 아니라 파이프라인 앞뒤다.
 *
 * 🔑 **후보 생성기가 없으면 core 는 검증을 끝까지 못 한다.** 해시를 만들 줄만 알고
 *    "이 저장된 해시가 맞는가" 를 답하지 못한다 ⇒ 그건 「우리를 믿어라」다.
 *    검증 primitive 를 유료로 빼면 오픈코어의 무료 쪽이 쓸모없어진다.
 *
 * ## 🔴 왜 SSoT 여야 하는가 — 갈리면 같은 레코드에 상반된 판정이 난다
 *
 * 검증기는 보통 두 벌 이상 생긴다(공개 단건 조회 / 관리자 벌크 감사).
 * 폴백 정책만 공유하고 **후보 생성을 각자 하드코딩하면 결국 갈린다.**
 * 실제 사례: 한쪽이 `chain_content` 를 아예 안 보고 행 필드만 계산해서,
 * writer 가 content 에 추가 필드를 넣은 도메인의 레코드 다수를 **거짓 불일치**로
 * 보고했다. 같은 행을 다른 검증기는 통과시켰다.
 * **같은 레코드에 상반된 판정이 나오는 것 자체가 감사에서 반대증거가 된다.**
 */

import { computeChainHash, computeChainHashV1 } from './hash';
import type { ChainHashCandidate } from './verify';

export type ChainHashScheme = 'v1' | 'v2';

/**
 * 엔진(`verify.ts`)이 받는 `ChainHashCandidate` 에 **출처**를 더한 것.
 *
 * 🔑 엔진 타입을 **확장**한다 — 경쟁하는 타입을 두 벌로 두지 않는다.
 *    두 벌이면 한쪽에만 필드가 늘고, 그 순간 두 검증기가 다시 갈린다.
 * 🪤 엔진 타입 자체(`ChainHashCandidate`)의 이름을 뺏지 않는다 — 0.3.1 에 이미 발행돼
 *    있어서 뺏으면 breaking 이고, 직접 후보를 만드는 소비자는 `source` 를 가질 이유가 없다.
 */
export interface BuiltChainHashCandidate extends ChainHashCandidate {
  scheme: ChainHashScheme;
  /**
   * 후보를 만든 입력 출처.
   * - `row`    : 현재 행의 core 필드로 계산 — **행을 직접 보증한다**
   * - `stored` : 저장된 `chain_content` 로 계산 — **행의 복사본을 보증한다.**
   *              단독으로 믿으면 안 된다(아래 `diffStoredContentAgainstRow` 참조).
   */
  source: 'row' | 'stored';
}

/** chain_hash 가 덮는 결정 core 필드. 저장된 `chain_content` 와 행을 대조하는 축이다. */
export const CHAIN_CORE_FIELDS = [
  'domain',
  'purpose',
  'final_action',
  'final_responsible',
] as const;

export type ChainCoreField = (typeof CHAIN_CORE_FIELDS)[number];

/** 후보 생성에 필요한 레코드의 최소 형태. */
export interface ChainVerificationRow {
  domain: string;
  purpose: string;
  final_action: string;
  final_responsible: string;
  previous_hash?: string | null;
  chain_hash_version?: string | null;
  chain_timestamp?: string | null;
  chain_content?: Record<string, unknown> | null;
  executed_at?: Date | string | null;
  created_at?: Date | string | null;
}

/**
 * v1 레거시 폴백을 허용할지 결정하는 정책.
 *
 * 🔴 **기본값은 엄격하다** — 스킴이 명시적으로 `'v1'` 일 때만 허용한다.
 *    라벨이 없는(null) 레코드에는 폴백을 **주지 않는다.**
 *
 * 왜 그런가: v1 은 직렬화 버그로 content 를 `{}` 로 만들어 내용을 커밋하지 않는다.
 * 라벨 없는 행에 v1 폴백을 열어주면, **provenance 컬럼을 제어할 수 있는 쪽이
 * 검증 기준을 고르게 된다**(라벨을 지우면 내용 무관 통과 경로가 열린다).
 *
 * 🪤 **자기 레거시 분포를 이 기본값에 밀어넣지 마라.** "우리 DB 엔 라벨 없는 행이
 *    N건이라 막으면 오판이 난다" 는 **그 배포판의 사정**이지 이 라이브러리의 정책이 아니다.
 *    그런 관용은 호출자가 **명시적으로** 넘겨라 — 그래야 관용이 눈에 보인다.
 *
 * ```ts
 * // 라벨 없는 레거시가 있는 배포판의 compatibility profile
 * buildChainHashCandidates(row, { allowLegacyV1Fallback: s => s !== 'v2' })
 * ```
 */
export type LegacyFallbackPolicy = (storedScheme: string | null | undefined) => boolean;

/** 기본 정책 — 명시적 `'v1'` 만 허용. unknown·null 은 거부. */
export const strictLegacyFallback: LegacyFallbackPolicy = (s) => s === 'v1';

export interface BuildCandidateOptions {
  /** 기본값 `strictLegacyFallback`. 레거시 관용은 호출자가 명시한다. */
  allowLegacyV1Fallback?: LegacyFallbackPolicy;
}

function toIso(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/**
 * 저장된 `chain_content` 와 현재 행의 core 필드를 대조해 **발산한 필드명**을 돌려준다.
 *
 * 🔴 왜 필요한가: `chain_content` 는 작성자가 해시에 넣은 원문의 **복사본**이다.
 * 그 복사본으로 계산한 후보를 넣고 "후보 중 하나라도 맞으면 통과" 로 판정하면,
 * **행의 core 필드를 UPDATE 해도 복사본이 그대로면 여전히 통과한다.**
 * 해시는 행이 아니라 행의 복사본에 결속돼 있는데, **감사인이 읽는 건 행이다.**
 *
 * - `storedContent` 가 없으면 대조 불가 → `null`(모르는 것은 모른다고 답한다).
 * - `chain_content` 에 그 키가 **없으면 건너뛴다.** 작성자 shape 이 갈릴 수 있어
 *   없는 키를 "불일치" 로 세면 그 경로가 살아나는 순간 정상 레코드가 거짓 실패한다.
 */
export function diffStoredContentAgainstRow(
  storedContent: Record<string, unknown> | null | undefined,
  row: Partial<Record<ChainCoreField, string | null | undefined>>,
): string[] | null {
  if (!storedContent) return null;

  const diverged: string[] = [];
  for (const field of CHAIN_CORE_FIELDS) {
    if (!(field in storedContent)) continue;
    const stored = storedContent[field];
    const actual = row[field];
    // null/undefined 는 같은 것으로 본다(둘 다 "값 없음"). 그 외는 문자열로 정규화해 비교.
    const a = stored == null ? null : String(stored);
    const b = actual == null ? null : String(actual);
    if (a !== b) diverged.push(field);
  }
  return diverged;
}

/**
 * 재계산 후보 전량을 만든다. **모든 검증기가 이 함수만 쓴다 — 각자 만들지 말 것.**
 *
 * 순서:
 *  1. v2 · 행 core 필드 · `executed_at`(없으면 `created_at`)
 *  2. 폴백 정책이 허용하면 v1 2종(`executed_at` / `created_at`)
 *     — v2 로 **기록된** 행이 v1 계산으로 맞는 건 정상이 아니라 이상 신호다.
 *  3. 저장된 `chain_content` + `chain_timestamp` 후보 (스킴은 **명시적으로만** 분기)
 *
 * 🪤 3번의 스킴 분기를 `!== 'v1' 이면 v2` 로 두지 마라. `'v0-unrecoverable'`·오타·
 *    임의 문자열이 전부 v2 로 승격돼, provenance 컬럼을 제어할 수 있는 쪽이
 *    검증 기준을 고르게 된다.
 */
export function buildChainHashCandidates(
  row: ChainVerificationRow,
  options?: BuildCandidateOptions,
): BuiltChainHashCandidate[] {
  const allowV1 = options?.allowLegacyV1Fallback ?? strictLegacyFallback;

  const content: Record<string, unknown> = {
    domain: row.domain,
    purpose: row.purpose,
    final_action: row.final_action,
    final_responsible: row.final_responsible,
  };
  const prev = row.previous_hash ?? null;
  const executedIso = toIso(row.executed_at) ?? toIso(row.created_at);
  const createdIso = toIso(row.created_at);

  const out: BuiltChainHashCandidate[] = [];

  if (executedIso) {
    out.push({
      scheme: 'v2',
      hash: computeChainHash(content, prev, executedIso),
      source: 'row',
      contentBound: true,
    });
  }

  if (allowV1(row.chain_hash_version)) {
    // 🔴 v1 은 **어떤 경우에도** contentBound 가 아니다 — 직렬화가 content 를 비운다.
    if (executedIso) {
      out.push({
        scheme: 'v1',
        hash: computeChainHashV1(content, prev, executedIso),
        source: 'row',
        contentBound: false,
      });
    }
    if (createdIso && createdIso !== executedIso) {
      out.push({
        scheme: 'v1',
        hash: computeChainHashV1(content, prev, createdIso),
        source: 'row',
        contentBound: false,
      });
    }
  }

  const stored =
    row.chain_content && typeof row.chain_content === 'object' && !Array.isArray(row.chain_content)
      ? row.chain_content
      : null;

  if (stored && row.chain_timestamp) {
    // 🔑 **저장 복사본 후보의 contentBound 는 「복사본이 행과 일치할 때만」 참이다.**
    //    복사본만 덮는 해시로 "행의 내용이 안 바뀌었다" 고 말할 수 없다 — 행을 UPDATE 해도
    //    복사본이 그대로면 이 후보가 맞는다. 그래서 여기서 대조까지 하고 결과를 싣는다.
    //    🪤 이 판정을 호출자에게 미루면 아무도 안 한다. 엔진은 contentBound 를 그대로
    //       verdict 에 실으므로, 여기서 과대주장하면 그 거짓이 판정문까지 간다.
    const diverged = diffStoredContentAgainstRow(stored, row);
    const storedMatchesRow = diverged !== null && diverged.length === 0;

    if (row.chain_hash_version === 'v2') {
      out.push({
        scheme: 'v2',
        hash: computeChainHash(stored, prev, row.chain_timestamp),
        source: 'stored',
        contentBound: storedMatchesRow,
      });
    } else if (row.chain_hash_version === 'v1') {
      out.push({
        scheme: 'v1',
        hash: computeChainHashV1(stored, prev, row.chain_timestamp),
        source: 'stored',
        contentBound: false,
      });
    }
  }

  return out;
}
