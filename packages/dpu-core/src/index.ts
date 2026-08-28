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

// ==================== 재계산 후보 생성 (검증 파이프라인 앞단) ====================
//
// 🔑 위의 판정 엔진은 후보를 **받아서** 판정한다. 후보를 만들 줄 모르면 core 로는
//    검증이 끝까지 안 되고, 그건 「우리를 믿어라」다. 그래서 이쪽도 무료다.
// 🪤 벌크 순회·DB 질의·조직 스코프·리포팅은 여기 없다 — 그건 배포판의 몫이다.

export {
  buildChainHashCandidates,
  diffStoredContentAgainstRow,
  strictLegacyFallback,
  CHAIN_CORE_FIELDS,
  type BuiltChainHashCandidate,
  type BuildCandidateOptions,
  type ChainCoreField,
  type ChainHashScheme,
  type ChainVerificationRow,
  type LegacyFallbackPolicy,
} from './chain-verification';

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
