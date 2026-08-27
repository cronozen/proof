# Changelog

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
