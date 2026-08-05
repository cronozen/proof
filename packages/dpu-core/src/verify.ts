/**
 * 체인 검증 판정 — 순수 함수
 *
 * ## 왜 이게 core 에 있나
 *
 * 검증기가 여러 개면 **같은 레코드에 상반된 판정**이 나오고, 그 불일치 자체가 감사에서
 * 우리에게 불리한 증거가 된다. thearound-ops 가 `verify-decision.ts` 에 적어둔 규칙:
 *
 *   "공개 검증기와 관리자 벌크 검증기가 같은 규칙을 써야 한다 — 갈리면 같은 DPU 에
 *    상반된 판정이 나오고 그 불일치가 감사에서 반대증거가 된다(F10)."
 *
 * 그래서 **판정부만** 여기로 올린다. DB 조회·해시 재계산·서명 검증은 호출자의 몫이고,
 * "무엇을 통과로 볼 것인가"는 여기 하나뿐이어야 한다.
 *
 * ## 설계 원칙 1 — 라벨이 아니라 실제로 맞은 계산이 진실이다
 *
 * ops 가 2026-07-31 독립검증에서 얻은 규칙. 저장된 버전 라벨만 보고 "내용까지 결속됨"이라
 * 보고했다가 거짓 통과를 냈다 — v1 계산으로 맞은 해시가 `contentBound: true` 로 보고됐는데,
 * v1 은 직렬화 버그로 content 를 `{}` 로 뭉개므로 내용을 전혀 덮지 않는다.
 * **검증이 없는 것보다 나쁜 상태다.**
 *
 * 그래서 이 엔진은 후보의 `contentBound` 를 **실제로 일치한 후보에서** 가져온다.
 * 저장된 라벨은 쳐다보지 않는다.
 *
 * ## 설계 원칙 2 — 엔진은 스킴 이름을 모른다
 *
 * 호출자마다 버전 라벨이 **다른 축**을 가리킨다:
 *   - thearound-ops : `v1`/`v2` = **직렬화** 버전 (canonicalizeChainPayload vs V1)
 *   - cronozen-proof: `v2`/`v3` = **페이로드 커버리지** 버전 (3필드 vs 레코드 전체)
 *
 * 한쪽 이름 체계를 엔진에 박으면 다른 쪽이 틀린다. 그래서 스킴은 **호출자가 붙이는
 * 불투명 문자열**이고, "이 계산이 내용을 덮는가"는 후보를 만든 쪽이 선언한다.
 * 그건 후보를 만든 쪽만 알 수 있는 사실이다.
 *
 * ## 설계 원칙 3 — 링크는 3상태다
 *
 * 대상이 **없는 것**(체인의 시작/끝)과 **어긋난 것**은 다르다. 같게 취급하면 둘 다 놓친다.
 * `null` = 대상 없음(통과), `false` = 어긋남(실패), `true` = 일치.
 */

// ==================== Types ====================

/**
 * 해시 재계산 후보.
 *
 * 호출자가 "이렇게 계산했을 수 있다"는 경우의 수를 만들어 넘긴다.
 * (레거시 스킴, 타임스탬프 후보 등 — 기록 당시 실제로 쓰인 입력을 찾기 위한 것)
 */
export interface ChainHashCandidate {
  /** 호출자 네임스페이스의 스킴 식별자. 예: `ops.v2`, `proof.v3`. 엔진은 해석하지 않는다. */
  scheme: string;
  /** 이 스킴으로 재계산한 해시 */
  hash: string;
  /**
   * 이 계산이 레코드 **내용**까지 덮는가.
   *
   * 🔴 후보를 만든 쪽만 알 수 있다. false 면 해시가 맞아도 "내용이 안 바뀌었다"고 말할 수 없다.
   *    (예: ops v1 은 content 를 `{}` 로 뭉갠다. proof v2 는 3개 필드만 덮는다.)
   */
  contentBound: boolean;
}

/** 링크 3상태. `null` = 대상 레코드가 없음(체인의 시작/끝). */
export type LinkState = boolean | null;

export interface Check {
  ok: boolean;
  detail?: string;
}

export interface ChainHashVerdict extends Check {
  /** 실제로 일치한 스킴. 안 맞았으면 null. **저장된 라벨이 아니다.** */
  matchedScheme: string | null;
  /** 일치한 계산이 내용까지 덮는가. 안 맞았으면 단정하지 않고 null. */
  contentBound: boolean | null;
}

export interface ChainLinkInput {
  chainIndex: number;
  previousHash: string | null;
  /** 선행 레코드와의 일치 여부. genesis 등 대상이 없으면 null. */
  previousLinkValid: LinkState;
  /** 후행 레코드와의 일치 여부. 체인의 끝이면 null. */
  nextLinkValid: LinkState;
  /** 선행 레코드가 **아예 없어서** false 인 경우. 메시지를 정확히 하기 위한 힌트. */
  previousMissing?: boolean;
}

export interface VerificationInput extends ChainLinkInput {
  /** 저장된 chain_hash */
  storedChainHash: string | null;
  candidates: ChainHashCandidate[];
}

export interface VerificationVerdict {
  verified: boolean;
  chainHash: ChainHashVerdict;
  chainLink: Check;
  /** genesis(index 0)는 선행 해시를 가지면 안 된다 */
  genesisValid: boolean;
  /** 실패 사유. verified=true 면 빈 배열. */
  failures: string[];
}

// ==================== 해시 판정 ====================

/**
 * 저장된 해시가 후보 중 하나와 일치하는지.
 *
 * 🔑 결과의 `contentBound` 는 **일치한 후보**에서 가져온다. 저장된 버전 라벨을 보지 않는다.
 */
export function evaluateChainHash(
  storedChainHash: string | null,
  candidates: ChainHashCandidate[],
): ChainHashVerdict {
  if (!storedChainHash) {
    return {
      ok: false,
      matchedScheme: null,
      contentBound: null,
      detail: 'Record has no chain hash.',
    };
  }

  const matched = candidates.find(c => c.hash === storedChainHash) ?? null;

  if (!matched) {
    return {
      ok: false,
      matchedScheme: null,
      contentBound: null,
      detail:
        'Recomputed hash does not match the stored chain hash — record content was altered after recording.',
    };
  }

  return {
    ok: true,
    matchedScheme: matched.scheme,
    contentBound: matched.contentBound,
    detail: matched.contentBound
      ? undefined
      : 'The matching computation does not cover the record content — a true result here does not mean the outcome is unchanged.',
  };
}

// ==================== 링크 판정 ====================

/**
 * 앞뒤 링크 + genesis 불변식.
 *
 * 🔴 후행 링크를 빼면 **뒤가 끊겨도 "통과"** 라고 답한다. ops 가 2026-07-31 독립검증에서
 *    지적받고 조인 항목이다.
 */
export function evaluateChainLink(input: ChainLinkInput): Check & { genesisValid: boolean } {
  const genesisValid = input.chainIndex === 0 ? input.previousHash == null : true;

  if (!genesisValid) {
    return {
      ok: false,
      genesisValid,
      detail: 'Genesis record (index 0) must not reference a previous hash.',
    };
  }

  if (input.previousLinkValid === false) {
    return {
      ok: false,
      genesisValid,
      detail: input.previousMissing
        ? `Previous record at chain index ${input.chainIndex - 1} is missing — the chain has a gap.`
        : 'Previous hash does not match the actual preceding record — the chain was reordered or rewritten.',
    };
  }

  if (input.nextLinkValid === false) {
    return {
      ok: false,
      genesisValid,
      detail:
        'The following record does not point back to this one — the chain was rewritten after this record.',
    };
  }

  return {
    ok: true,
    genesisValid,
    detail: input.chainIndex === 0 ? 'Genesis record.' : undefined,
  };
}

// ==================== 종합 판정 ====================

/**
 * 해시 + 링크 + genesis 를 묶은 최종 판정.
 *
 * 봉인(승인) 무결성과 서버 서명은 호출자마다 모델이 달라 여기 넣지 않는다.
 * 호출자는 이 결과에 자기 검사를 더해 최종 `verified` 를 만든다.
 */
export function evaluateVerification(input: VerificationInput): VerificationVerdict {
  const chainHash = evaluateChainHash(input.storedChainHash, input.candidates);
  const link = evaluateChainLink(input);

  const failures: string[] = [];
  if (!chainHash.ok) failures.push(`chainHash: ${chainHash.detail}`);
  if (!link.ok) failures.push(`chainLink: ${link.detail}`);

  return {
    verified: failures.length === 0,
    chainHash,
    chainLink: { ok: link.ok, detail: link.detail },
    genesisValid: link.genesisValid,
    failures,
  };
}
