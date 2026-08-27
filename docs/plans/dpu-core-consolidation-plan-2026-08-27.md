# dpu-core 정본 통합 계획 v2 — codex·fable 검증 반영

작성 2026-08-27 · v1 을 두 검증이 「순서가 뒤집혔다」로 반박함

---

## 0. 제품 맥락 (판정 기준)

- **오픈코어로 판다** — 무료 `dpu-core` / 유료 `dpu-pro`
- **우리 레포가 첫 레퍼런스** — 「우리도 이걸 씁니다」가 판매 논거

🔑 **레퍼런스 주장의 실체는 유통 채널이 아니라 「코드 동일성」이다.**
오늘 그 주장이 거짓인 이유는 ops 가 workspace 를 써서가 아니라 **내용이 달라서**다.
⇒ ops 를 npm 소비자로 바꿀 필요는 없다. **드리프트 가드**로 동일성을 지키면 된다.

---

## 1. 🔴 v1 계획이 틀린 곳 — 순서

v1 은 「ops → proof 전체 병합 후 0.3.0 발행」이었다. 두 검증이 같은 지점을 쳤다:

> **ops 의 더 앞선 모든 코드를 공개 정본으로 복사하는 것은 정본화가 아니라
> 「무료 제품 범위 확정」이다.** (codex)

> 계획 §3 은 자기 자신의 §3-1 경고와 모순된다 — 2번이 graph 까지 가져오고 5번이 발행하면
> **경계 결정이 「안 한 채로 확정」된다.** (fable)

**⇒ core/pro 경계 확정이 병합보다 앞이다. 열기는 나중에 되지만 닫기는 안 된다.**

---

## 2. 실측된 지뢰 (전부 확인함)

| # | 지뢰 | 근거 |
|---|---|---|
| **A** | 🔴 **`dpu-pro`·`connector` 가 `dpu-core: "0.1.0"` 정확 핀** — 로컬을 지우거나 0.3.0 으로 올리면 **npm 의 v1 버그판을 받아온다.** 벌크 검증기가 내용 미커밋 코어 위에서 돈다 | 각 `package.json` |
| **B** | 🔴 **ops 가 같은 npm 이름을 발행하는 워크플로를 갖고 있다** — 두 레포가 이름을 두고 경주. npm 0.1.0 의 출처가 ops 였을 가능성 | `publish-dpu.yml:11-12,36` |
| **C** | 🔴 **pro 라이선스 게이트가 장식** — `CRZ-{tier}-{base64(org:expiry:signature)}` 인데 **서명 미검증.** 아무나 키를 찍는다. 막힌 건 채널이 아니라 서명이다 | `dpu-pro/src/license.ts:88,163` |
| **D** | 🔴 **내부 포렌식 주석이 공개된다** — `"PROD 457건"`·`"2026-07-31 PROD 3,091건"` 등 | `adapter.ts:94` · `hash-scheme-policy.ts:19` |
| **E** | 🔴 **내가 배포한 0.2.0 에 실결함** — proof `envelope.ts` 가 `chain_hash_version`·`timestamp`·`content` 를 **영속 안 함** ⇒ **0.2.0 으로 쓴 레코드는 provenance null 로 태어나 영구 v1 폴백 대상.** 판 물건이 래칫을 못 건다. + `legal_scope: null` 명시(ops 에서 30일 조용한 100% 실패를 낸 버그) | `proof/envelope.ts:190` |
| **F** | 🔴 **`dp-schema-public` 도 갈라져 있다** — ops 에만 `proof-event.ts`, proof 에만 `event-type-metadata.ts`. dpu-core 0.3.0 은 `^0.2.0` 을 무는데 ops 는 `0.1.0` 정확 핀 | diff 실측 |
| **G** | 🪤 **버전 번호가 거짓말 중** — ops 사본은 `0.1.0` 인데 내용이 npm `0.2.0` 보다 앞섰다. 버전 비교로 신선도를 판단하면 정반대 결론 | |
| **H** | 🪤 **ops 팬텀 의존** — 루트 `package.json` 에 `@cronozen/dpu-core` 선언이 **없다.** workspace 호이스팅 + `tsconfig.json:24-27` **paths 매핑**으로 해석된다 | |
| **I** | 🪤 **ops 는 tsup dist 를 한 번도 실행해 본 적 없다** — paths 가 `src` 를 가리킨다. npm 이주 = 「배포판 첫 실사용」이자 「빌드 산출물 첫 실사용」 | |
| **J** | 🔴 **df 검증기가 지금 8개월치 v1 레코드를 전부 `brokenAt` 으로 판정한다**(v2 단일 재계산, 폴백 없음) — **미룰 정리가 아니라 반쯤 급한 일** | df `proof-service.ts:133` |

---

## 3. 🔑 두 검증 모듈은 중복이 아니다 — 파이프라인 앞뒤다

| | proof `verify.ts` (215줄) | ops `chain-verification.ts` (161줄) |
|---|---|---|
| 역할 | **판정 엔진** — 후보 → verdict | **후보 생성기** — DB 행 → 재계산 후보 |
| 스킴 | **불투명 문자열**(엔진은 스킴 이름을 모른다) | `'v1'\|'v2'` + ops 행 모양에 결합 |

**진짜 중복은 ops 앱 층의 `verify-decision.ts`** — core 엔진과 같은 문제를 다시 풀었다.
⇒ 버릴 것은 core 의 어느 쪽도 아니다.

🔴 **합칠 때 즉시 터지는 지뢰**: 둘 다 `ChainHashCandidate` 를 **다른 모양**으로 export 한다
(ops `{scheme:'v1'|'v2', hash, source}` / proof `{scheme:string, hash, contentBound}`).
파일 복사가 아니라 **타입 통합 설계**가 필요하다(ops 후보에 `contentBound` 부여: v1→false, v2→true).

🪤 **dataforge 는 ops 의 후보 생성기를 못 쓴다** — df content 모양이
`{domain, purpose, inputHash, outputHash, companyId}` 라 ops 의 `CHAIN_CORE_FIELDS` 와 다르다.
⇒ df 는 **엔진 + 자기 후보빌더** 조합으로만 성립한다.

---

## 4. ✅ 다운그레이드 공격 — 단독으론 성립 안 한다

- `chain_hash_version` 은 **해시도 commitment(cmt-v1)도 안 덮는다** — 라벨은 뗄 수 있다
- **그러나 라벨만 뒤집어선 위조가 안 된다.** v2 로 계산된 해시는 v1 재계산과 일치할 수 없고,
  `chain_hash` 자체를 바꾸려면 ①다음 레코드의 링크 ②commitment ③외부 앵커를 넘어야 한다
- 잔여 면 = **앵커 미도달 꼬리 구간**뿐, 그때도 `contentBound:false` 로 보고된다

🔑 **「스킴 저장」과 「해시 두 번」은 둘 다 쓰는 게 맞고 이미 그렇게 갈라져 있다** —
라벨은 *후보를 좁히는 게이트*, `contentBound` 는 *주장 강도의 진실*.

⏳ 남는 숙제: ①라벨을 v3 에서 해시 입력에 넣거나 cmt-v2 에 포함해 **뗄 수 없게** ②**df 에는
`chain_hash_version` 컬럼 자체가 없어** 게이트가 읽을 값이 없다(전 행 폴백 고정) — 마이그레이션 필요.

---

## 5. 🔑 core/pro 경계 — 확정안

### 무료(core)로 준다
canonicalization · v1/v2 해시 · `CHAIN_HASH_VERSION` · 순수 판정 자료형 ·
`evaluateChainHash/Link/Verification` · **`chain-verification.ts`(후보 생성)** ·
「unknown scheme 은 거부」 기본 안전 정책 · adapter 인터페이스

🔑 **검증 primitive 를 유료로 빼면 core 가 쓸모없어진다** —
검증기 없는 core = 해시 생성기뿐 = 「우리를 믿어라」.
그리고 코드가 이미 그 경계를 전제한다: 유료 `dpu-pro/verify-chain.ts` 가
`buildChainHashCandidates` 를 **core 에서 import** 한다.
🪤 **벌크 검증은 모트가 아니다** — O(n) 루프는 누구나 30분에 다시 쓴다.

### 유료(pro)/connector 로 남긴다
DB batch traversal · Prisma 질의 · 조직별 chain scope · 관리자 bulk audit ·
remediation/reporting · 정책·컴플라이언스 판단 · commitment 원장 · 외부 앵커 운영 ·
ops 행 shape → core 입력 매퍼

### ❌ `graph/` 는 0.3.0 에서 **뺀다**
- **타입 정의뿐**(엔진 없음)이고 헤더가 스스로 「Phase 3 (**Proof SaaS**)」라 적었다
- 소비자는 ops `graph-runner.ts` 하나뿐 — proof·df 는 안 쓴다
- 🔑 **빼도 아무도 안 아프고, 나중에 열 수는 있어도 닫을 수는 없다**

### 🪤 `hash-scheme-policy.ts` 는 그대로 옮기지 않는다
`storedScheme !== 'v2'` 는 **ops 의 역사적 데이터 분포를 정책으로 박은 것**이다.
core 엔 명시적 순수 정책을, 「기존 레코드를 어떻게 볼지」는 **ops 의 compatibility profile** 로.

---

## 6. 순서

### Phase 0 — 지금 (무위험)
- [ ] 🔴 **`npm deprecate @cronozen/dpu-core@0.1.0`** — 지뢰 A 의 독약 제거. 통합과 무관하게 즉시
- [ ] **ops `publish-dpu.yml` 의 dpu-core·dp-schema-public 발행 경로 무장해제**(지뢰 B)

### Phase 1 — 경계 확정 (코드 이동 전)
- [ ] §5 를 문서로 확정 — 무엇이 무료이고 무엇이 유료인가
- [ ] `ChainHashCandidate` 타입 통합 설계(지뢰 §3)
- [ ] **주석 세척 규칙**(지뢰 D) — 공개 전 내부 포렌식 제거

### Phase 2 — 통합 후 발행
- [ ] `chain-verification.ts` + 정책 + **provenance 영속 envelope**(지뢰 E 수정) 를 proof 로
- [ ] `dp-schema-public` 동반 통합(지뢰 F)
- [ ] 나머지 5파일: `envelope`·`adapter`·`hash`·`index` 는 **ops 채택 + proof verify export 병합**,
      `core.test.ts` 는 **양쪽 병합**(proof 의 독립 literal vector·v1 회귀는 우선 — ops 의 일부
      「pinned」 검사는 구현 함수로 expected 를 재계산해 **핀이 아니다**)
- [ ] `npm pack` 결과를 **설치해서** CJS·ESM·types·CLI 각각 검사(source test ≠ tarball)
- [ ] `0.3.0` 발행 + 태그 → `0.2.0` deprecate
- [ ] ⚠️ df 는 **정확 버전 고정**(`^0.3.0` 아님 — 자동 minor 갱신 방지)

### Phase 3 — df 배선 (지뢰 J: 반쯤 급함)
- [ ] 엔진 + **자기 후보빌더**(ops 것 못 씀, §3)
- [ ] `chain_hash_version` 컬럼 마이그레이션
- [ ] 🔑 **순서 규약: 새 verifier → 새 writer → 관찰 → legacy 축소.**
      **writer 를 verifier 보다 먼저 바꾸면 안 된다**

### ⏸ 미룸 — ops 가 로컬을 지우고 npm 을 문다
지뢰 A·H·I 가 전부 여기 몰려 있고 **고객 영향 0**이다.
ops 는 지금 RLS 이행·테이블 소유권 복구가 걸린 PROD 다.
**대신 드리프트 가드**: CI 에서 ops `packages/dpu-core` ↔ 발행본 diff 검사.

---

## 7. 별건 (이 계획 밖, 기록만)
- 🔴 **pro 라이선스 서명 검증**(지뢰 C) — 팔기 전 필수. 배포 채널은 이미 잡혀 있다
- `dpu-pro` LICENSE 파일 부재(`"SEE LICENSE IN LICENSE"` 인데 파일이 없다)
- `dpu-connector-prisma` 모순 — Apache-2.0 인데 private 배포
- commitment(cmt-v1)에 scheme/content/timestamp 부재 — 폴백 정책만 공개하면 취약한 정책을 정본화

## 8. 🪤 확인 못 한 것
npm 0.1.0 을 어느 레포가 발행했는지 · 외부 npm 다운로드·다른 비공개 레포의 0.2.0 소비 ·
RFC3161 앵커가 commitment 밖 컬럼을 얼마나 덮는지 전체 그림

---

# 12. 정책 스냅샷 검증 — 켜기 전에 반드시 읽을 것 (2026-08-27 추가)

## 🔴 지금 켜면 전건 불일치다. 변조 때문이 아니다.

```
쓰기  create-dpu.ts:204   hashString(JSON.stringify(policySnapshot))   ← 정렬 없음(삽입 순서)
      code → version → config → min_approvers → data_sensitivity → ...

저장  policy_snapshot Json? = **jsonb**  ← Postgres 가 (길이, 바이트순)으로 재정렬
      code → config → version → snapshot_at → min_approvers → ...

읽기  generatePolicyHash                 ← 알파벳 정렬
      code → config → data_sensitivity → min_approvers → ...
```

**세 순서가 전부 다르다. 쓰기 시점의 바이트열은 저장되는 순간 사라진다.**
⇒ 어느 읽기 함수로 맞춰도 못 맞춘다 — v1 이든 v2 든 무관하다.
🪤 게다가 스냅샷에 `snapshot_at: new Date().toISOString()` 이 들어가 **재구성도 불가능**하다.
⇒ **기존 `policy_snapshot_hash` 는 원리적으로 재현 불가.**

## 지금 상태 = 「금고에 물건은 들어가는데 열쇠가 안 맞고, 아무도 열려 하지 않는다」

- 매 DPU 마다 계산·저장은 **돌고 있다**
- 읽는 코드는 **호출자 0건**(`verifyDPUWithOriginalPolicy` 를 부르는 앱 코드 없음)
- 🪤 `verify-policy.ts:126-132` 폴백 분기는 **해시가 달라도 `verified: true`** 를 준다 —
  불일치가 표면화조차 안 된다

🔑 **스냅샷 자체(`policy_snapshot`)는 온전하다. 해시(열쇠)만 안 맞는다.**
   ⇒ 나중에 고치면 **그때부터 열린다.** 지금 안 한다고 손해가 누적되지 않는다.

## 🪤 사본이 둘이고 2026-08-27 이후 계산이 갈렸다
| 사본 | 계산 |
|---|---|
| `src/lib/decision-proof/verify-policy.ts` | 자체 구현. **v1 replacer 유지** |
| `packages/dpu-pro/src/verify-policy.ts` | dpu-core 사용 → **v2 로 바뀜** |
둘 다 호출자 0건이라 무해. **켜기 전에 하나로 줄여라.**

## 살릴 때의 순서 (A안)

1. **쓰기를 먼저 고친다** — `create-dpu.ts:204` 를 정규화 해시로
   🪤 평소 규약은 「새 verifier → 새 writer」인데 **여기선 뒤집힌다.**
      verifier 가 죽어 있어(호출자 0) 깨질 게 없고, **읽기를 켜기 전에 쓰기가 맞아야** 한다
2. 읽기 사본을 **하나로** 줄인다(`src/lib/...` 의 자체 함수를 지우고 패키지 것으로)
3. 경계를 긋는다 — 그 시점 이전은 `legacyCount` 로 **세어서 보고**
   🪤 `chain_hash_version` 같은 컬럼이 **없다** → 마이그레이션이 필요할 수 있고,
      ops PROD 라 승격 절차가 붙는다
4. **그 다음에야 읽기를 켠다**

🔴 **백필하지 마라.** 옛 해시는 재현이 원리적으로 불가하므로 백필은
「지금 계산한 값으로 덮어쓰기」다. **재계산해 덮을 수 있는 해시는 증빙이 아니다.**

## 🔴 A 를 하기 전에 답해야 할 제품 질문
**「불일치가 나오면 무엇을 할 것인가」** — 알림? 차단? 세기만?
이게 정해지지 않으면 4번에서 막힌다(오늘 대사에서 정한 것과 같은 문제:
**자동 수정은 버그를 은폐한다. 「보고만」으로 시작하되 보는 사람이 있어야 한다**).

## 예상 비용 (2026-08-27 실측 페이스 기준)
- **C(표시만)** = 15분, 리스크 0 ← **오늘 이걸 했다**
- **A(고친다)** = 2~3시간 + 3번이 마이그레이션이면 **반나절**. 그리고 마지막에 제품 결정 하나

## 결정 (2026-08-27)
**C 로 간다.** 근거:
- 물건(스냅샷)은 계속 쌓이므로 **급하지 않다**
- **B(지우기)는 되돌리기 어렵다** — 지금은 「열쇠만 안 맞는」 상태인데 지우면 「물건이 없는」 상태가 된다
- A 를 지금 해도 **읽는 사람이 없어 효과가 안 난다.**
  「DPU 를 판다」로 결정하면 그때 **「누가 언제 볼 것인가」가 같이 정해지고**, 그때 A 를 하면 막히지 않는다
