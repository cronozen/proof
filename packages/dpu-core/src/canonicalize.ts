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
function deepSortKeys(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  // ── 원시값: **JSON 도메인 밖은 거부한다** ─────────────────────────────
  // 🔴 조용히 통과시키면 `JSON.stringify` 가 서로 다른 값을 같은 것으로 만든다(실측):
  //      NaN · Infinity · -Infinity · Invalid Date  →  전부 `null` ⇒ **진짜 null 과 충돌**
  //      undefined (객체 속성)                       →  키가 사라짐 ⇒ `{a:undefined}` == `{}`
  //      undefined (배열 원소)                       →  `null` ⇒ `[undefined]` == `[null]`
  //      -0                                          →  `0`
  //    전부 **second-preimage**(서로 다른 원본이 같은 해시)다. `__proto__` 와 같은 부류다.
  // 🔑 「모르는 건 거부한다」를 BigInt·Map/Set 에만 적용하고 여기는 빠뜨렸었다.
  if (value === null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `canonicalize: ${String(value)} 는 해시 입력이 될 수 없다 — null 로 직렬화되어 진짜 null 과 충돌한다`,
      );
    }
    if (Object.is(value, -0)) {
      throw new TypeError('canonicalize: -0 은 해시 입력이 될 수 없다 — 0 으로 직렬화되어 충돌한다');
    }
    return value;
  }
  if (value === undefined) {
    throw new TypeError(
      'canonicalize: undefined 는 해시 입력이 될 수 없다 — 객체에선 키가 사라지고 배열에선 null 이 된다',
    );
  }
  if (typeof value === 'bigint') {
    // 🪤 문자열로 바꾸면 `1n` 과 `"1"` 이 같은 해시가 된다. 거부한다.
    throw new TypeError('canonicalize: BigInt 는 해시 입력이 될 수 없다 — 문자열로 바꿔서 넘겨라');
  }
  if (typeof value === 'symbol' || typeof value === 'function') {
    throw new TypeError(`canonicalize: ${typeof value} 는 해시 입력이 될 수 없다 — 조용히 사라진다`);
  }
  if (typeof value !== 'object') return value; // string · boolean

  // 🔴 순환 참조 — 스택 오버플로 대신 명시적으로 거부한다.
  // 🪤 `seen` 은 **현재 경로(ancestor)** 지 「본 적 있는 것 전부」가 아니다.
  //    후자로 두면 형제가 같은 객체를 참조하는 **DAG 가 순환으로 오판**된다
  //    (`{a: shared, b: shared}` 는 순환이 아니고 실제 데이터에 흔하다).
  //    그래서 자식 순회가 끝나면 지운다.
  if (seen.has(value)) {
    throw new TypeError('canonicalize: 순환 참조는 해시 입력이 될 수 없다');
  }
  seen.add(value);

  // 🔴 `toJSON` 을 먼저 존중한다 (2026-08-27).
  //    own-enumerable 키만 복사하면 **프로토타입의 `toJSON` 이 끊긴다.**
  //    Date 는 own key 가 0개라 `{}` 로 뭉개졌다 ⇒ 값이 달라도 같은 해시. **v1 보다 나빴다.**
  // 🪤 네이티브 `JSON.stringify` 는 `toJSON(key)` 로 키를 넘긴다. 여기선 안 넘긴다 —
  //    키에 따라 결과가 달라지는 `toJSON` 은 네이티브와 다르게 동작한다.
  //    그런 구현은 정규화 대상이 아니라고 본다(결정론적 해시 입력이 아니다).
  const maybe = value as { toJSON?: () => unknown };
  if (typeof maybe.toJSON === 'function') {
    const projected = maybe.toJSON();
    // 🪤 자기 자신을 돌려주면 무한루프다. `String(value)` 폴백은 서로 다른 객체를
    //    `"[object Object]"` 하나로 뭉개므로 **거부**한다.
    if (projected === value) {
      throw new TypeError('canonicalize: toJSON 이 자기 자신을 반환한다 — 정규화할 수 없다');
    }
    // 🔴 **Invalid Date 함정.** `new Date('x').toJSON()` 은 `null` 을 돌려준다
    //    ⇒ 진짜 `null` 과 같은 해시. 위 원시값 거부를 통과해버리는 유일한 경로다
    //    (거부는 입력을 보는데, 여기선 `toJSON` 이 만들어낸 `null` 이라 안 걸린다).
    if (projected === null && value instanceof Date) {
      throw new TypeError(
        'canonicalize: Invalid Date 는 해시 입력이 될 수 없다 — null 로 직렬화되어 진짜 null 과 충돌한다',
      );
    }
    const out = deepSortKeys(projected, seen);
    seen.delete(value);
    return out;
  }

  if (Array.isArray(value)) {
    const out = value.map((v) => deepSortKeys(v, seen));
    seen.delete(value);
    return out;
  }

  // 🔴 own-enumerable 키가 0개인데 내용이 있는 것들 — `toJSON` 도 없다.
  //    Date 와 **정확히 같은 부류**다. `{}` 로 뭉개면 내용이 해시 밖으로 나간다.
  if (value instanceof Map || value instanceof Set) {
    seen.delete(value);
    throw new TypeError(
      'canonicalize: Map/Set 은 해시 입력이 될 수 없다 — 배열/객체로 바꿔서 넘겨라',
    );
  }

  // ⚠️ `Object.create(null)` 필수 — 일반 `{}` 에 `out["__proto__"] = x` 는
  //    **프로토타입 setter 로 흘러 키가 조용히 소실된다.**
  //    실측: `{"__proto__":{"evil":1},"a":1}` → `{"a":1}` 로 evil 이 해시 밖으로.
  //    ⇒ **second-preimage.** (ops `commitment.ts` 가 같은 방어를 먼저 했다)
  const sorted: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = deepSortKeys((value as Record<string, unknown>)[key], seen);
  }
  seen.delete(value);
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
 * @deprecated 🔴 **이름이 거짓말한다.** 이제 `canonicalize` 와 완전히 같은 구현이다
 *             (재귀 정렬). "Flat" 이라는 이름이 「평면만 다룬다」는 착각을 만들었고
 *             그 착각이 **8개월간 이 결함을 살렸다**. 새 코드는 `canonicalize` 를 써라.
 *             0.4.0 에서 제거 예정.
 */
export function canonicalizeFlat(data: Record<string, unknown>): string {
  return canonicalize(data);
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
