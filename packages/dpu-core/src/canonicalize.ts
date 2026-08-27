/**
 * DPU Canonicalization (정규화)
 *
 * JSON 데이터를 결정론적으로 직렬화하는 표준 함수.
 * 해시 체인과 정책 해시의 기반이 되는 핵심 규칙입니다.
 *
 * 규칙:
 * 1. 모든 레벨의 키를 알파벳순 정렬 (재귀)
 * 2. JSON.stringify로 직렬화 (공백 없음)
 * 3. 동일 입력 → 동일 출력 보장 (결정론적)
 *
 * @version 2.0
 * @breaking v1에서 JSON.stringify replacer 배열이 중첩 객체 키를 제거하는 버그 수정.
 *           2.0 은 canonicalize·canonicalizeChainPayload 만 고쳤고,
 *           **canonicalizeFlat 은 3.0(0.3.0)에서 고쳤다** — 그 사이 computeObjectHash·
 *           generatePolicyHash 가 계속 뚫려 있었다.
 *           기존 해시 호환은 canonicalizeChainPayloadV1 · canonicalizeFlatV1 으로 보장
 */

/**
 * 객체의 모든 키를 재귀적으로 알파벳순 정렬
 */
function deepSortKeys(obj: unknown): unknown {
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(deepSortKeys);
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = deepSortKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * 객체를 정규화된 JSON 문자열로 변환 (키 정렬)
 *
 * @param data - 정규화할 객체
 * @returns 키가 알파벳순으로 정렬된 JSON 문자열
 *
 * @example
 * canonicalize({ b: 2, a: 1 })
 * // '{"a":1,"b":2}'
 */
export function canonicalize(data: Record<string, unknown>): string {
  return JSON.stringify(deepSortKeys(data));
}

/**
 * 객체를 정규화된 JSON 문자열로 변환 (v2 — 재귀 정렬)
 *
 * `generatePolicyHash()` · `computeObjectHash()` 의 기반이다.
 * **중첩 객체의 모든 필드가 결과에 포함된다.**
 *
 * 🔴 **v1 은 중첩을 비웠다.** `JSON.stringify(data, Object.keys(data).sort(), 0)` 의
 *    배열 replacer 는 **모든 깊이에 적용되는 키 허용목록**이라 최상위 키만 통과하고
 *    중첩 객체의 자기 키는 전부 걸러졌다:
 *      canonicalizeFlat({a:'A', n:{x:1}})  →  v1: '{"a":"A","n":{}}'
 *    ⇒ `computeObjectHash({w:{from:'A'}}) === computeObjectHash({w:{from:'X'}})` 였다.
 *    **중첩 값 변조를 원리적으로 못 잡았다.**
 * 🪤 이름이 "Flat" 이라 「평면만 다룬다」로 읽히지만, 실제 소비자는 중첩을 넣었다
 *    (워크플로 정의·정책 스냅샷). **이름이 만든 착각이 8개월 갔다.**
 *
 * @param data - 정규화할 객체
 * @returns 모든 깊이의 키가 알파벳순으로 정렬된 JSON 문자열
 * @version 2.0
 */
export function canonicalizeFlat(data: Record<string, unknown>): string {
  return JSON.stringify(deepSortKeys(data));
}

/**
 * v1 레거시 정규화 (기존 policy/object 해시 검증용)
 *
 * 버그: 배열 replacer 가 중첩 객체 키를 제거해 `{}` 로 직렬화됨.
 * 기존 해시와의 호환성을 위해 유지.
 *
 * 🔴 **이걸로 통과한 해시를 「무결」로 보고하지 마라** — 중첩 내용을 커밋한 적이 없어
 *    해시가 맞아도 그 내용이 그대로라는 뜻이 아니다.
 *
 * @deprecated 새 해시는 canonicalizeFlat (v2) 사용
 */
export function canonicalizeFlatV1(data: Record<string, unknown>): string {
  return JSON.stringify(data, Object.keys(data).sort(), 0);
}

/**
 * 체인 해시용 페이로드 정규화 (v2 — 재귀 정렬)
 *
 * content의 모든 필드가 해시에 포함됩니다.
 *
 * @param content - DPU 핵심 내용
 * @param previousHash - 이전 체인 해시 (Genesis는 null → 'GENESIS')
 * @param timestamp - ISO-8601 타임스탬프
 * @returns 정규화된 페이로드 문자열
 */
export function canonicalizeChainPayload(
  content: Record<string, unknown>,
  previousHash: string | null,
  timestamp: string
): string {
  const payload = {
    content: deepSortKeys(content),
    previousHash: previousHash || 'GENESIS',
    timestamp,
  };
  return JSON.stringify(deepSortKeys(payload));
}

/**
 * v1 레거시 정규화 (기존 체인 해시 검증용)
 *
 * 버그: JSON.stringify replacer 배열이 중첩 객체 키를 제거하여
 * content가 항상 {}로 직렬화됨. 기존 DPU와의 호환성을 위해 유지.
 *
 * @deprecated 새 DPU는 canonicalizeChainPayload (v2) 사용
 */
export function canonicalizeChainPayloadV1(
  content: Record<string, unknown>,
  previousHash: string | null,
  timestamp: string
): string {
  const payload = {
    content,
    previousHash: previousHash || 'GENESIS',
    timestamp,
  };
  return JSON.stringify(payload, Object.keys(payload).sort());
}
