# Changelog

## [0.4.0] - 2026-08-28

### 검증 primitive 를 무료로 — 후보 생성기가 core 에 들어왔다

`verify.ts` 는 판정 **엔진**이다(후보 → verdict). 그 앞단인 **후보 생성기**가 없어서,
지금까지 이 패키지로는 "이 저장된 해시가 맞는가" 를 끝까지 답할 수 없었다.
해시를 만들 줄만 알고 검증을 못 하는 core 는 **「우리를 믿어라」**다.

**추가**
- `buildChainHashCandidates(row, options?)` — 재계산 후보 전량 생성
- `diffStoredContentAgainstRow(storedContent, row)` — 저장 복사본 ↔ 행 대조
- `strictLegacyFallback` · `CHAIN_CORE_FIELDS`
- 타입: `BuiltChainHashCandidate` · `BuildCandidateOptions` · `ChainVerificationRow` ·
  `ChainCoreField` · `ChainHashScheme` · `LegacyFallbackPolicy`

### 🔴 기본 폴백 정책은 **엄격**하다

`chain_hash_version` 이 명시적으로 `'v1'` 일 때만 v1 폴백을 준다.
**라벨이 없는(null) 레코드에는 폴백을 주지 않는다.**

v1 은 직렬화가 content 를 비워 내용을 커밋하지 않는다. 라벨 없는 행에 폴백을 열어주면
**provenance 컬럼을 제어할 수 있는 쪽이 검증 기준을 고르게 된다**(라벨을 지우면
내용 무관 통과 경로가 열린다).

🪤 자기 배포판의 레거시 분포는 이 기본값이 아니라 **compatibility profile 로 명시**하라 —
그래야 관용이 눈에 보인다:
```ts
buildChainHashCandidates(row, { allowLegacyV1Fallback: s => s !== 'v2' })
```

### 🔑 `contentBound` 는 저장 복사본이 **행과 일치할 때만** 참이다

`chain_content` 는 작성자가 해시에 넣은 원문의 **복사본**이다. 그 복사본으로 계산한
후보가 맞아도, **행을 UPDATE 하면 해시는 여전히 맞고 행은 달라져 있다.**
감사인이 읽는 것은 행이다.

그래서 후보를 만들 때 대조까지 하고 결과를 싣는다:
- v2 · 행 기준 → `contentBound: true`
- v2 · 저장 복사본 → **복사본이 행과 일치할 때만** `true`
- v1 → 언제나 `false`

`evaluateChainHash` 가 이 값을 verdict 에 그대로 싣기 때문에, 여기서 과대주장하면
그 거짓이 판정문까지 간다.

### 이름
엔진 타입 `ChainHashCandidate`(0.3.1 에 이미 발행)는 **그대로 둔다.** 직접 후보를 만드는
소비자는 `source` 를 가질 이유가 없다. 확장형은 `BuiltChainHashCandidate` 다.

### 이 릴리스에 **없는** 것
벌크 순회 · DB 질의 · 조직 스코프 · 관리자 감사 리포팅 · commitment 원장 · 외부 앵커 운영.
그건 배포판의 몫이다. 🪤 벌크 검증은 모트가 아니다 — O(n) 루프는 누구나 다시 쓴다.

## [0.3.1] - 2026-08-28

### 🔴 Fix — 발행본이 **자기가 만든 레코드의 provenance 를 안 남기고 있었다**

0.2.0·0.3.0 은 해시 **계산**을 고쳤지만, `createDPUEnvelope` 가 그 계산의 출처를
레코드에 **영속하지 않았다.**

```
0.3.0 이 만든 레코드:  chain_hash_version 없음 · chain_timestamp 없음 · chain_content 없음
```

⇒ 검증기가 「이 해시는 어느 스킴으로 만들어졌나」를 읽을 값이 없어 **영구히 v1 폴백 대상**이
된다. v1 은 내용을 커밋하지 않으므로, 그 레코드는 **「내용을 커밋했다」고 말할 수 없다.**
해시를 고쳐 놓고 그 사실을 기록하지 않으면 고친 값어치가 레코드에 도달하지 않는다.

🔴 **백필로 못 고친다** — 나중에 재계산해 덮을 수 있는 값은 증빙이 아니다.
   이 수정 **이후** 생성분부터 provenance 가 붙는다.

**추가된 영속 필드** (`DPURecord` / `DPUEnvelope`)
- `chain_hash_version` — 계산 스킴 라벨 (`CHAIN_HASH_VERSION`)
- `chain_timestamp` — 해시에 **실제로 투입된** ISO-8601 원문. `executed_at` 과 다를 수 있다
- `chain_content` — 해시 content 원문 전체(키 목록이 아니라 **값까지**)

### 🔴 Fix — `legal_scope` 가 `null` 로 하드코딩돼 있었다

호출자가 무엇을 넘기든 무시하고 `null` 을 썼다. 컬럼이 `NOT NULL DEFAULT …` 인 스키마에서
이건 단순 무시가 아니라 **쓰기 실패**다 — Prisma 가 `Argument \`legal_scope\` must not be null`
로 거부한다. 내부 배포(ops)에서 같은 모양의 버그가 워크플로 DPU 를 **30일 넘게 매일 100%
실패**시켰고, catch 가 삼켜 아무 신호도 없었다.

이제 **키를 아예 내보내지 않는다**(호출자가 주면 그대로, 안 주면 DB 기본값).
기본값을 코드에 복제하지 않는다.

### 🔴 Fix — `CHAIN_HASH_VERSION` 이 export 되지 않았다

상수가 패키지 안에만 있고 공개 API 에 없었다. 소비자가 `'v2'` 를 **손으로 재현**하게 되고,
스킴이 올라가는 날 그 사본만 뒤처져 검증이 갈린다. 이제 export 한다.

### 마이그레이션
`0.3.0` 이하로 쓴 레코드는 provenance 가 없다. **백필하지 말고 경계로 다뤄라** —
`chain_hash_version IS NULL` 을 `legacyCount` 로 **세어서 보고**한다.
🪤 라벨은 해시 밖이라 뗄 수 있다. 접두로만 인정해라(v2 뒤 v1 = invalid, 다운그레이드 차단).

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
- `deepSortKeys` — 🔴 **own-key 0개 객체를 조용히 뭉개지 않는다.** 넷을 고쳤다:
  · **`toJSON` 존중** — Date 가 `{}` 로 뭉개지던 것(아래)
  · **`Object.create(null)`** — `__proto__` 키가 프로토타입 setter 로 흘러 **조용히 소실**됐다.
    실측: `{"__proto__":{"evil":1},"a":1}` → `{"a":1}`. ⇒ **second-preimage**(서로 다른 원본이 같은 해시)
  · **Map/Set 거부** — Date 와 같은 부류(own-key 0개)인데 `toJSON` 도 없다.
    `{}` 로 뭉개면 내용이 해시 밖으로 나간다. 조용히 비우느니 **거부**한다
  · **순환 참조 거부** — 스택 오버플로 대신 명시적 에러.
    🪤 판정은 **현재 경로(ancestor)** 다. 「본 적 있는 것 전부」로 두면
    형제가 같은 객체를 참조하는 **DAG 가 순환으로 오판**된다(실제 데이터에 흔하다)
  · 🔴 **JSON 도메인 밖 원시값을 거부한다** — 전부 second-preimage 였다(실측):
    `NaN`·`±Infinity`·**Invalid Date** → 모두 `null` ⇒ **진짜 `null` 과 충돌** ·
    `undefined` → 객체에선 키 소실(`{a:undefined}` == `{}`), 배열에선 `null` ·
    `-0` → `0` · `BigInt`(`1n` == `"1"`) · `Symbol`·function(조용히 사라짐)
    🪤 **Invalid Date 는 위 거부를 통과하는 유일한 경로**였다 — 거부는 입력을 보는데
       이건 `toJSON` 이 만들어낸 `null` 이라 안 걸린다. 따로 막았다
  · 🪤 `toJSON` 이 **자기 자신을 반환**하면 거부한다 — `String(value)` 폴백은 서로 다른 객체를
    `"[object Object]"` 하나로 뭉갠다
  · (원래 항목) 🔴 **`toJSON` 을 존중한다.** own-enumerable 키만 복사하면 프로토타입의
  `toJSON` 이 끊겨 **Date 가 `{}` 로 뭉개졌다**(0.2.0 부터의 회귀). `v1` 이 오히려 나았던 자리다.
- `canonicalizeFlat()` — **`canonicalize` 의 `@deprecated` alias 로 강등.**
  🪤 이름이 「평면만 다룬다」는 착각을 만들었고 **그 착각이 8개월간 이 결함을 살렸다.**
  0.4.0 에서 제거 예정.
- `verifyPolicyHash()` — 🔴 **strict v2 단독 유지**(0.2.0 과 동일). 폴백을 넣었다가 되돌렸다
- `verifyPolicyHashDetailed()` — **discriminated union** 으로. 실패 시 `contentBound: null`
  (「내용을 안 덮었다」가 아니라 **「일치한 스킴이 없어 판정 불가」**. `verify.ts` 의 `LinkState` 와 같은 원칙)
  🔴 **`matched` 만 보지 마라** — 그러면 strict 에서 제거한 폴백이 이 API 로 되살아난다. `scheme` 을 봐라

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
