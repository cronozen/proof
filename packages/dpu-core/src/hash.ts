/**
 * DPU Hash Functions - 순수 해시 계산
 *
 * DB 의존 없는 순수 함수만 포함합니다.
 * 체인 링크 생성/조회/검증 판정은 @cronozen/dpu-pro에서 제공합니다.
 *
 * @version 1.0
 * @locked computeChainHash의 직렬화 규칙은 기존 체인 호환을 위해 변경 금지
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
  // 🔑 v2 먼저, v1 폴백. 저장된 라벨을 안 믿고 **실제로 맞은 계산**이 진실이다.
  // 🔴 v1 으로 맞은 것을 「무결」로 보고하지 마라 — v1 은 중첩 내용을 커밋한 적이 없다.
  //    구분이 필요하면 verifyPolicyHashDetailed 를 써라.
  return (
    generatePolicyHash(policyConfig) === expectedHash ||
    generatePolicyHashV1(policyConfig) === expectedHash
  );
}

/**
 * 정책 해시 검증 — **어느 계산이 맞았는지 돌려준다.**
 *
 * 🔑 `verifyPolicyHash` 의 `true` 는 v1/v2 를 구분하지 못한다.
 *    v1 일치는 「시각·형태는 맞으나 **중첩 내용은 미보증**」이다. 초록에 섞지 마라.
 */
export function verifyPolicyHashDetailed(
  policyConfig: Record<string, unknown>,
  expectedHash: string
): { matched: boolean; scheme: 'v2' | 'v1' | null; contentBound: boolean } {
  if (generatePolicyHash(policyConfig) === expectedHash) {
    return { matched: true, scheme: 'v2', contentBound: true };
  }
  if (generatePolicyHashV1(policyConfig) === expectedHash) {
    return { matched: true, scheme: 'v1', contentBound: false };
  }
  return { matched: false, scheme: null, contentBound: false };
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
