# Changelog

## [0.3.0] - 2026-08-27

### 🔴 Breaking — `canonicalizeFlat` 도 중첩을 비우고 있었다 (0.2.0 이 절반만 고쳤다)

0.2.0 은 `canonicalize` 와 `canonicalizeChainPayload` **둘만** 고쳤다.
`canonicalizeFlat` 은 그대로였고, 그 위의 `computeObjectHash`·`generatePolicyHash` 가
**중첩 값 변조를 원리적으로 못 잡았다.**

```js
computeObjectHash({w:{from:'A'}}) === computeObjectHash({w:{from:'X'}})   // 0.2.0 에서 true
generatePolicyHash({a:{b:1}})     === generatePolicyHash({a:{b:2}})       // 0.2.0 에서 true
```

🪤 **이름이 "Flat" 이라 「평면만 다룬다」로 읽히지만 실제 소비자는 중첩을 넣었다** —
워크플로 정의 해시(`{name, domain, steps:[{name, dependsOn, dpuAction}]}`)가 실제로
`{"domain":"d","name":"wf","steps":[{"name":"s1"}]}` 로 직렬화돼
**의존 관계와 액션이 해시 밖에 있었다.** 「변조 감지」라 불리던 것이 그걸 못 했다.

### Changed
- `canonicalizeFlat()` — `deepSortKeys` 재귀 정렬. **중첩의 모든 필드가 포함된다**
- `deepSortKeys` — 🔴 **`toJSON` 을 존중한다.** own-enumerable 키만 복사하면 프로토타입의
  `toJSON` 이 끊겨 **Date 가 `{}` 로 뭉개졌다**(0.2.0 부터의 회귀). `v1` 이 오히려 나았던 자리다.
- `canonicalizeFlat()` — **`canonicalize` 의 `@deprecated` alias 로 강등.**
  🪤 이름이 「평면만 다룬다」는 착각을 만들었고 **그 착각이 8개월간 이 결함을 살렸다.**
  0.4.0 에서 제거 예정.
- `verifyPolicyHash()` — 🔴 **strict v2 단독 유지**(0.2.0 과 동일). 폴백을 넣었다가 되돌렸다

### Added
- `canonicalizeFlatV1()` · `generatePolicyHashV1()` · `computeObjectHashV1()` — **레거시 검증 전용**
- `verifyPolicyHashDetailed()` → `{ matched, scheme: 'v2'|'v1'|null, contentBound }`
  🔑 `verifyPolicyHash` 의 `true` 는 v1/v2 를 구분하지 못한다. **구분이 필요하면 이걸 써라.**

### 이주 방법

🔴 **`verifyPolicyHash` 는 v1 을 통과시키지 않는다.** 레거시는 **명시적으로** 받아라:

```ts
const r = verifyPolicyHashDetailed(policy, stored);
if (r.matched && r.contentBound) → 무결
if (r.matched && !r.contentBound) → **v1. 중첩 내용 미보증** — 별도 카테고리로 세어라
if (!r.matched)                   → 불일치
```

🪤 **폴백을 boolean 기본값에 두지 마라 — 한 번 넣었다가 되돌렸다.**
v1 은 중첩을 커밋한 적이 없어 **v1 해시로 저장된 것은 중첩을 변조해도 v1 재계산이 그대로 맞는다.**
기본값에 두면 이 릴리스가 고친 변조 불감이 boolean API 에서 재현되고,
**0.2.0 에서 `false` 이던 것이 `true` 가 된다** — 수리가 아니라 회귀다.

🔴 **v1 으로 통과한 것을 「무결」로 보고하지 마라.** v1 은 중첩을 커밋한 적이 없어
해시가 맞아도 그 내용이 그대로라는 뜻이 아니다.
🔴 **백필(재계산해 덮기)을 하지 마라.** 재계산해 덮을 수 있는 해시는 증빙이 아니고,
v1 해시는 재계산해도 중첩 내용에 대해 아무것도 말해주지 않는다.

🔴 **자기 사본을 가진 소비처를 찾아라 — 패키지를 고쳐도 그건 안 고쳐진다.**
실례 둘, 그리고 **두 번째가 훨씬 크다**:
1. ops `src/lib/decision-proof/verify-policy.ts` — 같은 버그의 함수 사본
2. 🔴 **ops `packages/dpu-core` 전체가 vendored 사본이다.**
   `tsconfig.json` 이 `@cronozen/dpu-core` → `packages/dpu-core/src` 로 매핑하고
   node_modules 도 workspace 심볼릭 링크다. ⇒ **npm 에 올려도 ops 는 1비트도 안 바뀐다.**
   ops 의 유일한 실제 결함 지점(`src/core/automation/engine.ts:620` `graphHash` —
   `dependsOn`·`dpuAction` 변조를 못 잡는다)은 **그 사본을 동기화해야 고쳐진다.**
   🪤 그리고 `dpu-pro`·`dpu-connector-prisma` 가 `"@cronozen/dpu-core": "0.1.0"` **정확 핀**이라,
      사본 버전을 올리면 workspace 매칭이 깨져 **npm 의 완전 결함 0.1.0 을 조용히 끌어온다.**


## [0.2.0] - 2026-08-27

### 🔴 Breaking — 체인 해시가 내용을 커밋하지 않던 결함 수정

`canonicalizeChainPayload()` 가 `JSON.stringify(payload, Object.keys(payload).sort())` 로
직렬화했는데, **배열 replacer 는 「모든 깊이에 적용되는 키 허용목록」**이다.
그래서 `content` 의 자기 키들이 전부 걸러지고 실제 해시 대상이 `{"content":{},...}` 였다.

```js
canonicalizeChainPayload({a:1, b:{c:2}}, 'p', 't')
// v1 → {"content":{},"previousHash":"p","timestamp":"t"}   ← 내용이 사라진다
// v2 → {"content":{"a":1,"b":{"c":2}},"previousHash":"p","timestamp":"t"}
```

⇒ v1 에서는 **입력·출력을 바꿔치기해도 체인이 초록**이었다. 변조 탐지가 원리적으로 불가능했다.

### Changed
- `canonicalizeChainPayload()` — `deepSortKeys` 재귀 정렬로 교체. **content 의 모든 필드가 해시에 포함된다.**
- `canonicalize()` — 동일한 재귀 정렬 적용.

### Added
- `canonicalizeChainPayloadV1()` / `computeChainHashV1()` — **기존 체인 검증 전용**(deprecated).
  0.1.0 으로 만들어진 해시는 이걸로만 검증된다.

### 이주 방법

기존 레코드가 있는 소비처는 **v2 먼저 / v1 폴백** 순으로 검증한다:

```ts
if (computeChainHash(content, prev, ts) === stored) return { ok: true, algo: 'v2' };
if (computeChainHashV1(content, prev, ts) === stored) return { ok: true, algo: 'v1' };
return { ok: false };
```

🪤 **v1 로 검증된 레코드를 「무결」로 보고하지 마라.** v1 은 내용을 커밋한 적이 없어
해시가 맞아도 내용이 그대로라는 뜻이 아니다. 별도 카테고리로 세어 보고할 것.

🪤 **백필(재계산해 덮기)을 하지 마라.** 나중에 우리가 재계산해 덮을 수 있는 해시는 증빙이 아니고,
v1 해시는 재계산해도 내용에 대해 아무것도 말해주지 않는다.


## [0.1.0] - 2026-02-10

### Added
- `canonicalize()`, `canonicalizeFlat()`, `canonicalizeChainPayload()` - JSON 정규화 표준 함수
- `computeChainHash()` - SHA-256 체인 해시 계산 (순수 함수)
- `generatePolicyHash()`, `verifyPolicyHash()` - 정책 해시 계산/검증
- `computeContentHash()`, `computeObjectHash()` - 범용 해시
- `createDPUEnvelope()` - DPU 레코드 포맷 빌더 (DB 접근 없음)
- `DPUStorageAdapter` 인터페이스 - DB 어댑터 추상화
- CLI: `cronozen-dpu init`, `validate`, `hash`

### Hash Compatibility Guarantee
`computeChainHash()`는 기존 `src/lib/decision-proof/hash-chain.ts`의 동일 함수와
**바이트 단위로 동일한 해시를 생성**합니다.
이 호환성은 @locked 정책에 의해 보장되며, 향후 버전에서도 유지됩니다.
동일 입력에 대해 동일 해시가 나오지 않는 경우는 breaking change로 취급됩니다.
