# DPU 적용·판매 계획 v3 — 실측으로 이어 씀

작성 2026-08-28 · 선행 = `dpu-core-consolidation-plan-2026-08-27.md`(v2, 통합 계획)
v2 는 **「판다」로 결정하는 날 꺼낸다**로 끝나 있었다. 오늘 꺼냈다.
v3 는 v2 를 대체하지 않는다 — v2 는 **패키지 통합** 계획이고, v3 는 **적용·판매** 계획이다.

---

## 0. 오늘 실측 — v2 이후 움직인 것 / v2 가 몰랐던 것

### ✅ v2 Phase 0 은 끝났다
| 항목 | v2 상태 | 오늘 |
|---|---|---|
| `npm deprecate dpu-core@0.1.0` | 🔴 사장 몫, 미실행 | ✅ 완료(「체인 해시가 내용을 커밋하지 않습니다 — 0.3.0 이상」) |
| ops `publish-dpu.yml` 공개 발행 경로 | 🔴 경주 중 | ✅ 제거(`a8d5f61377`) |
| 발행 버전 | 0.2.0 | **0.3.0**(0.2.0 도 deprecate — canonicalizeFlat 결함) |
| 배포 드리프트 검사 | 없음 | ✅ `scripts/release/check-publish-drift.mjs` |

### 🔴 v2 의 전제 하나가 **틀렸다** — 레퍼런스는 약하지 않다

v2·메모리는 「proof PROD **2행**」을 근거로 축2를 「독립가능자산」으로 강등했다.
그 2행은 **cronozen-proof 독립 저장소**의 것이고, **ops PROD 는 전혀 다르다**:

```
decision_proof_units       72,486 행   (2026-02-09 ~ 2026-08-28, 오늘도 씀)
dpu_commitment_events      72,486 행   ← 봉투 커버리지 100% 유지
dpu_anchor_checkpoints          9 건   (RFC3161 외부 앵커, 최근 08-27)
decision_proof_policies        53 개
```

일 생산량 **~1,100건**(최근 10일 1,014~1,226/일). 도메인 **20개 이상**:
`rehab 66,232` · `image-proof 2,022` · `interior 1,043` · `market 903` ·
`interior_document 710` · `interior_proposal 527` · `interior_pledge 266` ·
`interior_completion_confirm 200` · `artterier 154` · `session:* 246` · `platform 81` ·
`market_coupon_settlement 34` · …

스킴 분포도 건강하다:
```
v2                68,789  (94.9%)   2026-04-06 ~ 2026-08-28
(null)             3,635            2026-07-25 ~ 2026-08-03  ← 닫힌 창. 지금은 안 난다
v1                    52            2026-02-09 ~ 2026-03-24
v0-unrecoverable      10
```
**최근 10일은 100% v2, null 0건.** 옛 결함은 유한하고 경계가 그어져 있다.

🔑 **⇒ 「우리도 이걸 씁니다」는 참이다. 그것도 세게 참이다.**
   레퍼런스가 약해서 못 판 게 아니다. **팔 물건 쪽이 안 됐던 것**이다.

### 🔴 v2 가 몰랐던 것 — **발행본에 지뢰 E 가 아직 살아 있다**

v2 §2-E 가 「0.2.0 에 실결함」이라 적었다. **0.3.0 도 안 고쳤다.** npm tarball 실물 확인:

```
@cronozen/dpu-core@0.3.0  dist/index.js:298    legal_scope: null,      ← 하드코딩
                          (chain_hash_version / chain_timestamp / chain_content 없음)
```

ops 사본은 이 셋을 전부 영속한다. 즉 **파는 물건이 쓴 레코드는 스킴 라벨 없이 태어나
영구히 v1 폴백 대상**이다. 우리 자신은 그 결함을 안 받는다.
🪤 `legal_scope: null` 은 ops 에서 **30일 조용한 100% 실패**를 냈던 바로 그 버그다.

### 🔴 그리고 **발행본은 검증을 끝까지 못 한다**

v2 §5 가 「검증 primitive 는 무료여야 한다 — 검증기 없는 core = 『우리를 믿어라』」라고
경계를 정했다. **발행본은 그 경계에 아직 도달하지 않았다.**

| | 발행본 0.3.0 | ops 사본 |
|---|---|---|
| 판정 엔진 `evaluateChainHash/Link/Verification` | ✅ | ✅ |
| **후보 생성기 `chain-verification.ts`** | ❌ **없다** | ✅ |
| `hash-scheme-policy.ts` | ❌ | ✅ |
| `graph/` | ❌ (v2 결정대로 뺌 — 유지) | ✅ |
| `allowLegacyV1Fallback` export | ❌ | ✅ |

⇒ 구매자는 DB 행 → 재계산 후보를 **스스로 짜야** 검증이 성립한다.
   지금 발행본으로 할 수 있는 건 「해시 만들기」와 「후보를 남이 주면 판정하기」뿐이다.

### 코드 동일성 실측 (주석 제거 후 비교)
```
✅ canonicalize.ts   코드 동일        ← second-preimage 방어는 양쪽 다 들어갔다
🔴 hash.ts           코드 다름
🔴 envelope.ts       코드 다름        ← 위 provenance 결함
🔴 adapter.ts        코드 다름
🔴 index.ts          코드 다름        ← allowLegacyV1Fallback
```
🪤 **ops 쪽 드리프트 가드는 없다.** proof 레포의 `check-publish-drift.mjs` 는
   `local > npm` 버전만 본다 — **내용 비교가 아니다.** v2 가 「드리프트 가드로 지킨다」고
   했는데 그 가드는 아직 안 지어졌다.

### 🔴 외부 고객은 **0명**이다 — 두 채널 모두

```
api_keys                1행 = ak-be2185a1 "DPU session-close anchor"
                             scopes={proof:anchor}  우리 것. 07-24 생성, 오늘도 씀
subscriptions           proof 플랜(cloud-pro/cloud-business) 행 0건
                        (있는 18행은 free 12 / professional 3 / starter 2 — 전부 다른 상품)
metered_usage           2행
```
⇒ `/api/v1/decision-events` 는 **외부에서 한 번도 안 불렸다.**
   `/subscribe?product=proof` 는 **한 건도 결제되지 않았다.**

---

## 1. 판정 — 우리는 지금 무엇을 파는가

채널이 셋인데 **준비도가 전혀 다르다.** 하나로 뭉뚱그려 「DPU 를 판다」고 말하면
매번 제일 안 된 채널이 발목을 잡는다.

| # | 채널 | 형태 | 가격 | 준비도 | 막는 것 |
|---|---|---|---|---|---|
| **A** | **Cloud** — `/api/v1/decision-events` + `/subscribe?product=proof` | SaaS | ₩129,000/월 (Cloud Pro) | 🟡 **배관은 산다** | 계량기 없음·쿼터 미집행·온보딩(키 발급 UI) 없음 |
| **B** | **self-host** — `@cronozen/dpu-pro` npm | 라이선스 | 미정 | 🔴 **팔면 안 된다** | 서명 미검증·LICENSE 부재·deprecated 0.1.0 정확 핀 |
| **C** | **오픈코어 미끼** — `@cronozen/dpu-core` npm | 무료 | — | 🟡 **깔려 있는데 반쪽** | 후보 생성기 부재·provenance 결함 |

🔑 **순서는 C → A → B 다.** 근거:
- **C 가 A·B 양쪽의 신뢰 기반**이다. 반쪽 검증기를 깔아두고 파는 건
  「우리를 믿어라」를 npm 으로 배포하는 것이다.
- **A 는 배관이 이미 산다**(API·인증·스코프·과금 페이지·플랜 정의 전부 있음).
  없는 건 계량기 하나와 온보딩 하나다. **첫 유료 1건까지의 거리가 제일 짧다.**
- **B 는 지금 팔면 사고다.** `CRZ-PRO-base64("아무회사:2099-01-01:x")` 로 뚫린다.
  게다가 파는 tarball 이 **deprecated 된 0.1.0 을 정확 핀**으로 문다.

---

## 2. 🔴 판매 차단 — 순서대로 4건

### 차단 1. 발행본 provenance 결함 (C·B 공통) — **최우선**
`packages/dpu-core/src/envelope.ts` 가 `chain_hash_version`·`chain_timestamp`·
`chain_content` 를 영속하지 않고 `legal_scope: null` 을 하드코딩한다.
- ops 사본에 이미 정답이 있다 → **ops → proof 방향 이식**
- 🪤 이건 v2 §5 「경계 확정이 먼저」의 예외가 아니다 — envelope 은 **이미 발행된 무료 범위**다.
  범위를 넓히는 게 아니라 **이미 판 것의 버그를 고치는 것**이다.
- ⇒ `0.3.1`

### 차단 2. 후보 생성기 무료화 (C) — v2 §5 의 미이행분
`chain-verification.ts` 를 발행본에 넣는다. v2 가 이미 「무료」로 판정했다.
- 🔴 그대로 복사하면 안 된다 — v2 §3 의 `ChainHashCandidate` 모양 충돌
  (ops `{scheme:'v1'|'v2', hash, source}` / proof `{scheme:string, hash, contentBound}`).
  **ops 후보에 `contentBound` 부여**(v1→false, v2→true)로 통합.
- 🪤 `hash-scheme-policy.ts` 는 **같이 옮기지 마라** — ops 의 역사적 분포를 정책으로 박은 것이다.
  core 엔 순수 정책, 「기존 레코드를 어떻게 볼지」는 ops 의 compatibility profile.
- ⇒ `0.4.0`

### 차단 3. 계량기 (A) — **파는 데 필요한 유일한 없는 부품**
`/api/v1/decision-events` POST 가 인증·스코프·검증만 하고 **쓴 만큼을 안 센다.**
플랜은 「월 1,000 의사결정 이벤트」를 파는데 집행할 근거가 없다.
- `metered_usage` **2행**이 그 증거다. 테이블은 있고 입구가 없다.
- 🔑 이건 DPU 만의 문제가 아니다 — [[revenue-structure-measured-2026h1]]·
  [[public-fund-execution-os-thesis-2026-08-25]] 가 **같은 진단**을 냈다.
  「계량기 입구 부재」가 회사 전체의 공통 병목이다. **DPU 가 그걸 처음 뚫는 자리로 적당하다**
  (외부 고객 0 = 깨뜨릴 게 없다).
- 🪤 **후불 미터링 + 로컬 한도**로 간다. 선불 크레딧은 깨진다
  ([[bid-pricing-ladder-and-metering-axis-2026-08-26]] 와 같은 축).

### 차단 4. pro 라이선스 서명 + LICENSE (B)
`license.ts` 가 `parts[2]`(signature)를 **읽고 버린다.** 만료일만 본다.
- 서명 검증(Ed25519 공개키 임베드) + `LICENSE` 파일 작성
- 🪤 `dpu-connector-prisma` 는 Apache-2.0 인데 비공개 배포 — 모순 정리
- **B 채널은 이게 끝나기 전엔 열지 않는다.**

---

## 3. 적용(適用) 계획 — 우리 자신에게

「판다」의 절반은 **우리 사용을 증거로 만드는 것**이다. 지금은 데이터는 있는데
**보여줄 형태가 아니다.**

### 3-1. 🔑 지금 당장 가능 — 레퍼런스 숫자를 정본으로 고정
72,486행·일 1,100건·20 도메인·v2 94.9%·앵커 9건은 **오늘 처음 센 숫자**다.
- [ ] 주간 자동 집계 → `system_events`(`PLATFORM_CENTER_ID` + `runInPlatformCenter()`)
- 🪤 대외 문구에 쓰기 전에 **매번 다시 세라.** 「72,486」을 상수로 박으면 3주 뒤 거짓말이 된다
  ([[feedback-no-budget-figures-in-outreach-2026-08-14]] 와 같은 부류)

### 3-2. 옛 레코드 경계 — **백필하지 마라**
```
v1                    52  →  경계 밖. 「내용 미커밋」으로 보고
v0-unrecoverable      10  →  경계 밖
(null)             3,635  →  경계 밖 (2026-07-25 ~ 08-03, 닫힌 창)
v2                68,789  →  경계 안
```
🔑 **재계산해 덮을 수 있는 해시는 증빙이 아니다.** 초록 불은 지금의 빨간 불보다 나쁘다.
- [ ] 검증 화면이 `legacyCount` 를 **세어서 보고**(3,697건 = 5.1%)
- [ ] 마커는 **접두로만 인정** — v2 뒤에 v1 이 오면 invalid(다운그레이드 차단)

### 3-3. 정책 스냅샷 — v2 §12 의 **C 결정을 유지**
`policy_snapshot` 은 3,229행(4.5%)에만 있고, 그 해시는 **원리적으로 재현 불가**
(쓰기 정렬 없음 → jsonb 재정렬 → 읽기 알파벳 정렬, 게다가 `snapshot_at` 이 들어감).
- **지금 A(고치기)로 가지 않는다.** 읽는 사람이 0명이라 효과가 안 난다.
- ⏰ **트리거: 채널 A 의 첫 유료 고객.** 그때 「누가 언제 볼 것인가」가 같이 정해진다.
- 그 전에 무료로 되는 것 하나: **읽기 사본 둘을 하나로 줄이기**
  (`src/lib/decision-proof/verify-policy.ts` 자체 구현 vs `packages/dpu-pro/` 패키지 사용 —
  2026-08-27 이후 계산이 갈렸다. 둘 다 호출자 0건이라 지금이 제일 싸다)

### 3-4. 드리프트 가드 — v2 가 약속하고 안 지은 것
- [ ] ops CI: `packages/dpu-core` ↔ 발행 tarball **내용** diff (버전 비교 아님)
- 🪤 `check-publish-drift.mjs` 는 버전만 본다. 오늘 실측에서 4파일이 갈려 있었는데 **초록이었다.**
- 🔑 이 가드가 「우리도 씁니다」의 **유일한 담보**다. v2 가 「유통 채널이 아니라 코드 동일성」이라
  판정한 그 동일성을 지키는 물건이다.

---

## 3-5. ✅ 2026-08-28 착지분 (발행 전까지)

### [적용 3-4] 드리프트 가드 — ops `npm run check:dpu-core-drift`
- **행위 비교**다(텍스트 diff 아님). 발행 tarball 은 `dist` 만 싣고, 두 사본 차이의 대부분이
  주석이라 텍스트 비교는 매번 빨개져 **사람이 가드를 끄게 만든다.**
- 골든 벡터 **30종**은 **발행본 tarball 이** 만든다(`--update`). ops 로 만들면 동어반복 핀.
- 네트워크는 검사 경로에 **없다**(골든 체크인) — npm 장애에 안 흔들린다.
- 🔑 **기지 갈림은 `만료일 + ops 값해시`로 등재.** 벡터 이름만 적었더니 결함주입에서
  「envelope 필드 하나 소실」이 **기지 갈림 뒤에 숨었다.** 값까지 고정하니 잡힌다.
  (시크릿 allowlist 가 `경로+값해시` 인 것과 같은 이유)
- **결함주입 5종 전부 탐지** — `check:dpu-core-drift:mutation`
- CI `typecheck` 잡에 배선 + `tsconfig.guard-scripts.json` 등재

🔴 **가드가 내가 못 본 것을 하나 더 잡았다**: 발행본이 `CHAIN_HASH_VERSION` 을 **아예
export 하지 않는다**(dist grep 0건). 소비자가 `'v2'` 를 손으로 재현하게 되는 자리다.
⇒ §2 차단1 은 3건이 아니라 **4건**이었다.

### [적용 3-1] 레퍼런스 집계 — `scripts/dpu/report-dpu-reference-metrics.ts`
총계·일평균·스킴분포·도메인과 **함께** `legacyCount`(내용 미커밋/판정불가)와
**세션 앵커 수 + 앵커 도입일(2026-07-24)** 을 한 함수가 같이 낸다.
🔑 나눠 두면 한쪽만 인용된다 — 총계만 싣고 앵커율을 빼는 게 정확히 그 과장이다.
🔴 **한계를 파일에 박아뒀다**: 이 스크립트의 tsc 는 DB 스키마를 검증하지 **않는다**
(`guard-scripts` 가 `moduleResolution:"node"` 라 `prisma` 가 **any** 로 떨어진다 — 프로브로 확인).
실제로 `event_data`(없는 컬럼)·`decision_proof_units`(모델명 아님) 둘 다 tsc 가 아니라
schema.prisma 를 직접 읽어 잡았다. **등재됐다고 "검사됐다"로 읽으면 안 된다.**

### [차단1] envelope provenance 이식 — ✅ **0.3.1 발행 완료 · 부채 청산**
`cronozen-proof/packages/dpu-core`:
`hash.ts` CHAIN_HASH_VERSION 신설 · `index.ts` export ·
`envelope.ts` `legal_scope` 하드코딩 null 제거(키 미출력 방식) + `chain_hash_version`·
`chain_timestamp`·`chain_content` 영속 · `adapter.ts` 3필드 선언(내부 포렌식 수치는 세척).
- 타입검사 통과 · 테스트 **145/145** · 빌드 통과
- **ops 소스 ↔ 새 빌드: 30벡터 전부 일치** (갈림 0)
- ✅ `@cronozen/dpu-core@0.3.1` **발행**(`83b094b` · 태그 `dpu-core@0.3.1`)
- ✅ ops 골든을 **발행본 0.3.1 로** 재생성 → `CHAIN_HASH_VERSION=v2` · `legal_scope=LS-TEST` ·
  provenance 3필드 전부 확인
- ✅ **known-divergence 3건 삭제** — 지금 예외 **0건**으로 초록이다(억제 없는 초록)
- ✅ 결함주입 5/5 탐지 유지
- ⏳ 남은 것 = **dataforge 핀 `0.3.0` → `0.3.1`**(정확 핀이라 발행만으로 안 옮겨간다) ·
  `0.3.0` deprecate 여부 · proof 커밋·태그 **푸시**

---

## 4. 순서

```
지금 ─┬─ [적용] 3-1 레퍼런스 집계          무위험, 반나절
      ├─ [적용] 3-4 드리프트 가드          무위험, 반나절   ← 이게 없으면 아래가 또 갈린다
      └─ [차단1] envelope provenance 이식 → 0.3.1
              ↓
        [차단2] 후보 생성기 무료화 + 타입 통합 → 0.4.0
              ↓  여기서 C(오픈코어)가 처음으로 「검증되는 물건」이 된다
        [차단3] 계량기 — POST 경로에 metered_usage 기록 + 로컬 한도
              ↓
        [A 채널 개시] 키 발급 온보딩 → 첫 유료 1건
              ↓  ⏰ 여기서 3-3(정책 스냅샷 A안) 트리거가 켜진다
        [차단4] pro 서명 + LICENSE → B 채널 개시
```

🔴 **v2 의 순서 규약은 그대로 유효하다: 새 verifier → 새 writer → 관찰 → legacy 축소.**
   차단2(verifier)가 차단1(writer)보다 뒤에 있는 게 예외로 보이지만 아니다 —
   차단1 은 **새 writer 가 아니라 이미 판 writer 의 버그 수정**이다.

⏸ **여전히 미룸**: ops 가 로컬 사본을 지우고 npm 을 무는 것(v2 지뢰 A·H·I).
   고객 영향 0이고, ops 는 RLS 이행이 걸린 PROD 다. **드리프트 가드가 대체한다.**

---

## 5. 답이 안 나온 제품 질문 — 이게 계획보다 먼저다

1. **🔴 A 채널의 첫 고객은 누구인가.**
   외부 0명이 8개월간 유지됐다는 건 배관 문제가 아니라 **수요 접점 문제**다.
   차단 1~3 을 다 고쳐도 이 답이 없으면 「팔 수 있는 상태의 안 팔리는 물건」이 된다.
   🪤 [[public-fund-execution-os-thesis-2026-08-25]] 가 축2 를 강등한 진짜 이유가 여기다.
   레퍼런스 숫자(72,486)는 그 판정을 **뒤집지 않는다** — 「우리가 쓴다」와 「남이 산다」는 다른 축이다.

2. **불일치가 나오면 무엇을 할 것인가** (v2 §12 에서 넘어온 미결).
   알림? 차단? 세기만? 🔑 **「보고만」으로 시작하되 보는 사람이 있어야 한다.**
   자동 수정은 버그를 은폐한다.

3. **B 채널 가격.** 미정이다. 🪤 토큰·건수를 그대로 팔지 마라
   ([[bid-pricing-ladder-and-metering-axis-2026-08-26]]).

4. **AI 기본법 시행 시점이 진짜 트리거인가.** `docs/dpu/RFP_AI_GOVERNANCE_COPY.md` 는
   그 가정 위에 서 있다. 검증된 적 없다.

---

## 5-2. 기준표(`thearound-dataforge/docs/reference/dpu-baseline.md`) 대조 — 2026-08-28

증빙을 건드리기 전 1차 참조 문서다. 오늘 실측으로 **두 칸이 틀렸음을 확인해 고쳤다.**

| 기준표 항목 | 판정 |
|---|---|
| §1 v1 결함 서술 | ✅ 유효 |
| §2 버전 표 | 🔧 **0.3.0 누락**이었다 — 0.1.0·0.2.0 둘 다 deprecated 임을 추가 |
| §3 「ops 사본 = md5 동일」 | 🔴 **틀렸다.** 한 파일만 비교한 것. 실제 4파일 코드 상이 |
| §3 「dataforge ⏳ 이주 중」 | 🔧 **완료됨.** `0.3.0` 정확 핀 |
| §4 이주 규약 · `chain-provenance.ts:140-143` | ✅ 유효(파일·줄 확인) |
| §5 앵커 독립성(`commitment.ts` `deepSortKeys`·`Object.create(null)`) | ✅ 유효 |
| §6 dataforge 사용처 4곳 | ✅ 4곳 전부 존재 |

### dpu-close 로컬 체인 = 기준표에 없던 **세 번째 구현**
`close.mjs` 의 `canonical()` 은 dpu-core 를 안 쓰는 독립 재귀 정규화다. 결함주입 2종으로 확인:
중첩값 1글자 변조 → 탐지 / 해시 재계산 + chain.json 인덱스까지 위조 → **다음 링크가 탐지**.
**전 레포 `--verify`: 11개 체인 548건, `broken` 0건.**

🔴 **그러나 서버 앵커는 250건(45.6%)이고 경계는 2026-07-24 다.**
그 이전 298건은 외부 증인이 없다 — 로컬 파일만 고치면 체인 전체를 일관되게 다시 쓸 수 있다.

🔑 **이건 판매 서사에 직접 걸린다.** 「우리는 세션 단위로 증빙을 남깁니다」는 참이지만,
**「2026-07-24 이후분은 외부 앵커까지 갑니다」**가 정확한 문장이다. 날짜를 빼면 과장이 된다.
⇒ 3-1 레퍼런스 집계에 **앵커율을 같이 싣는다**(집계만 하고 앵커율을 빼면 같은 과장이 재생산된다).

---

## 6. 🪤 확인 못 한 것
- npm 0.3.0 의 **외부 다운로드 수** — 누가 이미 깔았는지 모른다(차단1 의 긴급도가 여기 달렸다)
- `/proof` · `/pricing` 랜딩의 **라이브 전환 퍼널** — 방문은 있는데 결제가 0인지, 방문이 0인지
- RFC3161 앵커 9건이 **commitment 밖 컬럼을 얼마나 덮는지** (v2 §8 에서 그대로 넘어옴)
- cronozen-sdk `cronozen` 패키지 **미배포 드리프트**(local 0.2.0 > npm 0.1.0) — 별건이지만 같은 부류
- dpu-close 서버 앵커의 **도메인 이름이 16종으로 갈려 있다**(`session:develop`·`session:ops-entitle` 등 워크트리 잔재) — repo 축 정규화 전엔 앵커율을 정확히 못 센다
