/**
 * DPU Hash Functions - 순수 해시 계산
 *
 * DB 의존 없는 순수 함수만 포함합니다.
 * 체인 링크 생성/조회/검증 판정은 @cronozen/dpu-pro에서 제공합니다.
 *
 * @version 1.0
 * @locked 🪤 **이 잠금은 이미 두 번 깨졌다** — 0.2.0 이 `canonicalizeChainPayload` 를,
 *         0.3.0 이 `canonicalizeFlat` 을 고쳤다. 둘 다 **내용을 커밋하지 않는 결함**이라
 *         고치는 게 맞았고, 호환은 **V1 함수를 남기는 방식**으로 지켰다.
 *         ⇒ 잠금의 진짜 뜻은 「바꾸지 마라」가 아니라
 *           **「기존 해시를 재현할 수 있는 경로를 없애지 마라」** 다.
 */

import { createHash } from 'crypto';
import {
  canonicalizeChainPayload,
  canonicalizeChainPayloadV1,
  canonicalizeFlat,
  canonicalizeFlatV1,
} from './canonicalize';

// ==================== Chain Hash ====================

/**
 * 체인 해시 계산
 *
 * SHA-256(canonicalize(content + previousHash + timestamp))
 *
 * @param dpuContent - DPU 핵심 내용 (domain, purpose, final_action, final_responsible)
 * @param previousHash - 이전 DPU의 chain_hash (Genesis는 null)
 * @param timestamp - ISO-8601 타임스탬프
 * @returns SHA-256 hex 해시
 *
 * @example
 * const hash = computeChainHash(
 *   { domain: 'pharmacy', purpose: '교품거래', final_action: 'CREATED', final_responsible: 'kim' },
 *   null, // Genesis
 *   '2026-02-10T00:00:00+09:00'
 * );
 */
export function computeChainHash(
  dpuContent: Record<string, unknown>,
  previousHash: string | null,
  timestamp: string
): string {
  const dataString = canonicalizeChainPayload(dpuContent, previousHash, timestamp);
  return createHash('sha256').update(dataString).digest('hex');
}

/**
 * v1 레거시 체인 해시 계산 (기존 DPU 검증용)
 *
 * @deprecated 새 DPU는 computeChainHash (v2) 사용
 */
export function computeChainHashV1(
  dpuContent: Record<string, unknown>,
  previousHash: string | null,
  timestamp: string
): string {
  const dataString = canonicalizeChainPayloadV1(dpuContent, previousHash, timestamp);
  return createHash('sha256').update(dataString).digest('hex');
}

// ==================== Policy Hash ====================

/**
 * 정책 설정에서 해시 생성
 *
 * @param policyConfig - 정책 설정 객체
 * @returns SHA-256 hex 해시
 */
export function generatePolicyHash(policyConfig: Record<string, unknown>): string {
  const content = canonicalizeFlat(policyConfig);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * 정책 해시 검증
 *
 * @param policyConfig - 정책 설정 객체
 * @param expectedHash - 기대하는 해시값
 * @returns 해시 일치 여부
 */
export function verifyPolicyHash(
  policyConfig: Record<string, unknown>,
  expectedHash: string
): boolean {
  // 🔴 2026-08-27 — **strict v2 단독이다. v1 폴백을 여기 넣지 마라.**
  //    한 번 넣었다가 되돌렸다. 이유:
  //    · v1 은 중첩을 커밋한 적이 없다 ⇒ **v1 해시로 저장된 정책은 중첩을 변조해도
  //      v1 재계산이 그대로 맞는다.** 폴백을 기본값에 두면 이 릴리스가 고친 변조 불감이
  //      boolean API 에서 그대로 재현된다.
  //    · 0.2.0 은 strict 였다. 폴백을 넣으면 **어제 false 이던 것이 오늘 true 가 된다** —
  //      검증을 느슨하게 만드는 릴리스가 된다.
  //    · `verify.ts` 가 스스로 적었다: 「v1 match 를 contentBound true 로 보고한 것은
  //      **검증이 없는 것보다 나쁘다**」. boolean 은 그 구분을 뭉갠다.
  //  🔑 레거시가 필요하면 `verifyPolicyHashDetailed` 로 **명시적으로** 받아라.
  //     `scheme:'v1'` 은 「맞았지만 내용 미보증」이지 「무결」이 아니다.
  //  🪤 그 API 에서도 **`matched` 만 보면 폴백이 되살아난다** — `scheme` 을 봐라.
  return generatePolicyHash(policyConfig) === expectedHash;
}

/**
 * 정책 해시 검증 — **어느 계산이 맞았는지 돌려준다.**
 *
 * 🔑 `verifyPolicyHash` 는 **strict v2 단독**이라 v1 저장분을 통과시키지 않는다.
 *    레거시를 봐야 하면 이걸 쓰되 — 🔴 **`matched` 만 보지 마라.**
 *    그러면 strict 에서 제거한 폴백이 이 API 를 통해 되살아난다.
 *    판정은 `scheme` 과 `contentBound` 로 한다:
 *      scheme:'v2'  → 내용까지 커밋된 무결
 *      scheme:'v1'  → **시각·형태만 맞다. 중첩 내용 미보증** — 별도 카테고리로 세어라
 *
 * 🪤 `contentBound` 는 실패 시 `null` 이다 — 「내용을 안 덮었다」가 아니라
 *    **「일치한 스킴이 없어 판정 불가」**다. `verify.ts` 의 `LinkState` 가 같은 원칙이다.
 *
 * 🪤 `contentBound: true` 도 **무조건 참이 아니다** — 입력이 허용 JSON 도메인 안에 있을 때만이다.
 *    (도메인 밖 값은 `canonicalize` 가 거부하므로 여기까지 오지 않는다)
 */
export type PolicyHashVerdict =
  | { matched: true; scheme: 'v2'; contentBound: true }
  | { matched: true; scheme: 'v1'; contentBound: false }
  | { matched: false; scheme: null; contentBound: null };

export function verifyPolicyHashDetailed(
  policyConfig: Record<string, unknown>,
  expectedHash: string
): PolicyHashVerdict {
  if (generatePolicyHash(policyConfig) === expectedHash) {
    return { matched: true, scheme: 'v2', contentBound: true };
  }
  if (generatePolicyHashV1(policyConfig) === expectedHash) {
    return { matched: true, scheme: 'v1', contentBound: false };
  }
  return { matched: false, scheme: null, contentBound: null };
}



// ==================== Generic Content Hash ====================

/**
 * 범용 콘텐츠 해시 계산
 *
 * 문자열 입력에 대한 SHA-256 해시.
 * DPU의 ai_prompt_hash, policy_snapshot_hash 등에 사용.
 *
 * @param content - 해시할 문자열
 * @returns SHA-256 hex 해시
 */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * 객체를 정규화 후 해시 계산
 *
 * @param data - 해시할 객체
 * @returns SHA-256 hex 해시
 */
export function computeObjectHash(data: Record<string, unknown>): string {
  const content = canonicalizeFlat(data);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * v1 레거시 정책 해시 (기존 정책 스냅샷 검증용)
 *
 * @deprecated 새 해시는 generatePolicyHash (v2) 사용
 */
export function generatePolicyHashV1(policyConfig: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalizeFlatV1(policyConfig)).digest('hex');
}

/**
 * v1 레거시 객체 해시 (기존 해시 검증용)
 *
 * @deprecated 새 해시는 computeObjectHash (v2) 사용
 */
export function computeObjectHashV1(data: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalizeFlatV1(data)).digest('hex');
}
