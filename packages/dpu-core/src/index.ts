/**
 * @cronozen/dpu-core
 *
 * Cronozen DPU Core 패키지
 *
 * 거버넌스 없는 순수 엔진:
 * - 해시 체인 계산 (computeChainHash)
 * - 정책 해시 계산/검증 (generatePolicyHash, verifyPolicyHash)
 * - 정규화 (canonicalize)
 * - DPU Envelope 생성 (createDPUEnvelope)
 * - Storage Adapter 인터페이스 (DPUStorageAdapter)
 *
 * 거버넌스 가드, 컴플라이언스 판정, 책임 그래프는
 * @cronozen/dpu-pro에서 제공합니다.
 *
 * @version 0.3.0
 * @license Apache-2.0
 */

// ==================== Re-export dp-schema-public ====================

export {
  EvidenceLevel,
  AIMode,
  RiskLevel,
  AuditStatus,
  DataSensitivityLevel,
} from '@cronozen/dp-schema-public';

// ==================== Canonicalization ====================

export {
  canonicalize,
  canonicalizeFlat,
  canonicalizeFlatV1,
  canonicalizeChainPayload,
  canonicalizeChainPayloadV1,
} from './canonicalize';

// ==================== Hash Functions ====================

export {
  CHAIN_HASH_VERSION,
  computeChainHash,
  computeChainHashV1,
  generatePolicyHash,
  verifyPolicyHash,
  computeContentHash,
  computeObjectHash,
  computeObjectHashV1,
  generatePolicyHashV1,
  verifyPolicyHashDetailed,
} from './hash';

// ==================== Verification (판정 SSoT) ====================
//
// 🔑 검증기가 여러 개면 같은 레코드에 상반된 판정이 나오고, 그 불일치가 감사에서
//    반대증거가 된다. "무엇을 통과로 볼 것인가"는 여기 하나뿐이어야 한다.
//    재계산·DB 조회·서명 검증은 호출자의 몫이고, 판정만 공유한다.

export {
  evaluateVerification,
  evaluateChainHash,
  evaluateChainLink,
  type ChainHashCandidate,
  type ChainHashVerdict,
  type ChainLinkInput,
  type Check,
  type LinkState,
  type VerificationInput,
  type VerificationVerdict,
} from './verify';

// ==================== Envelope ====================

export {
  createDPUEnvelope,
  type CreateEnvelopeInput,
  type ChainContext,
  type DPUEnvelope,
} from './envelope';

// ==================== Adapter Interface ====================

export type {
  DPUStorageAdapter,
  DPURecord,
  PolicyRecord,
  AuditLogRecord,
  ChainLinkResult,
} from './adapter';
