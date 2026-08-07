/**
 * ⚓ 앵커 외부 제출 — 우리가 못 건드리는 곳에 root 를 둔다
 *
 * ## 왜 두 곳인가
 *
 * 앵커의 목적이 "우리 손 밖에 둔다" 인데 그 곳이 하나뿐이면 그 하나가 새 단일 장애점이 된다.
 * 실측(2026-08-07): OTS 캘린더 3곳 중 **finney 는 이미 죽어 있었다.** 가정이 아니라 관측이다.
 *
 * | 제공자 | 성격 | 확정 시점 |
 * |---|---|---|
 * | OpenTimestamps | 비트코인. 무료·무계정. 가장 강한 무신뢰성 | **즉시 아님** — 캘린더 영수증 → 나중에 업그레이드해야 비트코인 증명이 채워진다 |
 * | Sigstore Rekor | Linux Foundation 운영 공개 투명성 로그 | 쓰는 즉시 (logIndex + inclusion proof + SET) |
 *
 * ## 🔴 이 파일이 지키는 규율
 *
 * **캘린더 영수증을 "비트코인에 박혔다" 로 보고하지 않는다.** OTS 는 제출 직후엔
 * 캘린더의 약속일 뿐이고, 업그레이드를 돌려야 비트코인 증명이 들어간다.
 * 그 둘을 같은 상태로 뭉치면 정확히 이 조직이 금지한 false-assurance 다.
 * 그래서 상태가 `submitted` 와 `confirmed` 로 갈린다.
 *
 * ## 서명 키가 두 개인 이유
 *
 * 레코드 서명은 Ed25519(`PROOF_SIGNING_PRIVATE_KEY`). 그런데 Rekor 는 Ed25519 에
 * **Ed25519ph**(pre-hash) 를 요구하고 Node 기본 API 로는 그 형식이 안 나온다(실측: 400).
 * 그래서 앵커 제출에는 **ECDSA P-256** 전용 키를 쓴다(`PROOF_ANCHOR_KEY`).
 * 용도가 다른 키를 하나로 겸하지 않는다 — 겸하면 회전 정책도 얽힌다.
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign } from 'crypto';

export type SubmissionStatus =
  | 'submitted'   // 제출됐고 영수증을 받았다. 아직 최종 확정은 아니다(OTS 캘린더 단계)
  | 'confirmed'   // 외부 로그에 확정됐다 — 제3자가 지금 확인 가능
  | 'failed';

export interface SubmissionResult {
  provider: string;
  status: SubmissionStatus;
  /** 영수증 원본(base64 또는 JSON 문자열). 제3자가 검증에 쓰는 값. */
  receipt: string | null;
  /** 사람이 확인할 수 있는 외부 참조 — 로그 인덱스, UUID 등. */
  externalRef: string | null;
  /** 검증자가 직접 열어볼 수 있는 URL. 없으면 null. */
  verifyUrl: string | null;
  error?: string;
}

/** 제출 대상. 비워두면 아무 데도 안 보낸다 — 테스트·오프라인 기본값이 네트워크를 안 탄다. */
export function enabledProviders(): string[] {
  return (process.env.PROOF_ANCHOR_PROVIDERS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

const OTS_CALENDARS = (process.env.PROOF_OTS_CALENDARS
  || 'https://alice.btc.calendar.opentimestamps.org,https://bob.btc.calendar.opentimestamps.org')
  .split(',')
  .map(s => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const REKOR_URL = (process.env.PROOF_REKOR_URL || 'https://rekor.sigstore.dev').replace(/\/+$/, '');

// ─── OpenTimestamps ─────────────────────────────────────────────────

/**
 * 캘린더에 digest 를 제출한다.
 *
 * 프로토콜이 단순해서 라이브러리를 쓰지 않는다 — 공식 JS 라이브러리는 2022년이 마지막
 * 발행이고 `bitcore-lib`·네이티브 빌드를 끌고 온다. 보안 경로에 4년 방치된 의존성을
 * 넣는 것 자체가 위험이라, 제출은 HTTP 로 하고 영수증 해석은 표준 도구에 맡긴다.
 *
 * 🔴 여기서 받은 영수증은 **캘린더의 약속**이다. 비트코인 증명은 나중에 업그레이드로 채운다.
 *    그래서 status 는 'submitted' 이지 'confirmed' 가 아니다.
 */
export async function submitToOts(rootHex: string, fetchImpl = fetch): Promise<SubmissionResult> {
  const digest = Buffer.from(rootHex, 'hex');
  const receipts: { calendar: string; receipt: string }[] = [];
  const errors: string[] = [];

  for (const calendar of OTS_CALENDARS) {
    try {
      const res = await fetchImpl(`${calendar}/digest`, {
        method: 'POST',
        body: digest,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        errors.push(`${calendar}: HTTP ${res.status}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      receipts.push({ calendar, receipt: buf.toString('base64') });
    } catch (err) {
      errors.push(`${calendar}: ${(err as Error).message}`);
    }
  }

  if (receipts.length === 0) {
    return {
      provider: 'ots',
      status: 'failed',
      receipt: null,
      externalRef: null,
      verifyUrl: null,
      error: errors.join(' | ') || 'no calendar responded',
    };
  }

  return {
    provider: 'ots',
    status: 'submitted',
    receipt: JSON.stringify({ digest: rootHex, calendars: receipts }),
    externalRef: receipts.map(r => new URL(r.calendar).hostname).join(','),
    verifyUrl: null,
    // 일부만 성공해도 남긴다 — 조용히 삼키면 "2곳에 넣었다" 는 착각이 생긴다.
    error: errors.length > 0 ? `partial: ${errors.join(' | ')}` : undefined,
  };
}

// ─── Sigstore Rekor ─────────────────────────────────────────────────

interface AnchorSigner {
  privateKey: ReturnType<typeof createPrivateKey>;
  publicKeyPem: string;
}

let anchorSigner: AnchorSigner | null | undefined;

/**
 * 앵커 제출용 ECDSA P-256 키.
 *
 * 없으면 null — Rekor 제출은 건너뛴다. 조용히 다른 키로 대체하지 않는다.
 */
export function getAnchorSigner(): AnchorSigner | null {
  if (anchorSigner !== undefined) return anchorSigner;

  const raw = process.env.PROOF_ANCHOR_KEY;
  if (!raw || !raw.trim()) {
    anchorSigner = null;
    return anchorSigner;
  }

  const pem = raw.includes('BEGIN') ? raw.trim() : Buffer.from(raw.trim(), 'base64').toString('utf8');
  const privateKey = createPrivateKey({ key: pem, format: 'pem' });
  if (privateKey.asymmetricKeyType !== 'ec') {
    throw new Error(`PROOF_ANCHOR_KEY must be an EC (P-256) key, got ${privateKey.asymmetricKeyType}`);
  }

  anchorSigner = {
    privateKey,
    publicKeyPem: createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString(),
  };
  return anchorSigner;
}

export function resetAnchorSignerCache(): void {
  anchorSigner = undefined;
}

/** 앵커 성명서 — Rekor 에 싣는 artifact 의 정본. 이 문자열이 서명·해시 대상이다. */
export function anchorStatement(input: {
  tenantId: string;
  treeVersion: string;
  merkleRoot: string;
  prevRoot: string | null;
  leafCount: number;
  anchoredAt: string;
}): string {
  return JSON.stringify({
    kind: 'cronozen-proof-anchor',
    treeVersion: input.treeVersion,
    tenantId: input.tenantId,
    merkleRoot: input.merkleRoot,
    prevRoot: input.prevRoot,
    leafCount: input.leafCount,
    anchoredAt: input.anchoredAt,
  });
}

/**
 * Rekor 공개 투명성 로그에 앵커 성명서를 등재한다.
 *
 * 🪤 실측으로 확정한 형식(2026-08-07):
 *    - Ed25519 는 **거부된다** — Rekor 가 Ed25519ph(pre-hash)를 기대하고 Node 기본 API 로는 안 나온다.
 *      (sha256 → "unsupported hash algorithm", sha512 → "invalid signature")
 *    - **ECDSA P-256 + SHA-256, 원문(statement)에 서명** → 201. 이게 되는 조합이다.
 *
 * 쓰는 즉시 inclusion proof 와 SET(서명된 항목 타임스탬프)가 돌아오므로 'confirmed' 다.
 */
export async function submitToRekor(statement: string, fetchImpl = fetch): Promise<SubmissionResult> {
  const signer = getAnchorSigner();
  if (!signer) {
    return {
      provider: 'rekor',
      status: 'failed',
      receipt: null,
      externalRef: null,
      verifyUrl: null,
      error: 'PROOF_ANCHOR_KEY is not configured — nothing was submitted.',
    };
  }

  const body = {
    apiVersion: '0.0.1',
    kind: 'hashedrekord',
    spec: {
      data: { hash: { algorithm: 'sha256', value: createHash('sha256').update(statement).digest('hex') } },
      signature: {
        content: cryptoSign('sha256', Buffer.from(statement), signer.privateKey).toString('base64'),
        publicKey: { content: Buffer.from(signer.publicKeyPem).toString('base64') },
      },
    },
  };

  try {
    const res = await fetchImpl(`${REKOR_URL}/api/v1/log/entries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    });

    const text = await res.text();
    if (!res.ok) {
      return {
        provider: 'rekor',
        status: 'failed',
        receipt: null,
        externalRef: null,
        verifyUrl: null,
        error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
      };
    }

    const parsed = JSON.parse(text) as Record<string, any>;
    const uuid = Object.keys(parsed)[0];
    const entry = parsed[uuid];
    const hasProof = !!entry?.verification?.inclusionProof;

    return {
      provider: 'rekor',
      // inclusion proof 가 없으면 확정이라 부르지 않는다.
      status: hasProof ? 'confirmed' : 'submitted',
      receipt: JSON.stringify({ uuid, logIndex: entry?.logIndex, statement, verification: entry?.verification }),
      externalRef: `logIndex=${entry?.logIndex} uuid=${uuid}`,
      verifyUrl: `${REKOR_URL}/api/v1/log/entries/${uuid}`,
    };
  } catch (err) {
    return {
      provider: 'rekor',
      status: 'failed',
      receipt: null,
      externalRef: null,
      verifyUrl: null,
      error: (err as Error).message,
    };
  }
}

/** 앵커 제출 키 생성 — scripts/generate-anchor-key.ts 에서 사용. */
export function generateAnchorKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}
