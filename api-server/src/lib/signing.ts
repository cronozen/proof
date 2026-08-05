/**
 * 🔏 Server Signature — Ed25519
 *
 * ## 설계 원칙: "하지 않은 것을 했다고 적지 않는다"
 *
 * thearound-ops/src/lib/proof/timestamp-service.ts 가 2026-08-02에 세운 원칙을 그대로 따른다.
 * 서명 키가 설정되지 않았으면 서명한 척하지 않는다. 상태를 `not_configured`로 **소리내어 말한다**.
 *
 * ## 다운그레이드 방지
 *
 * "서명이 없으면 통과"는 서명 컬럼을 지우는 것만으로 검증을 무력화한다.
 * 그래서 판정은 **서버에 키가 있는지**를 기준으로 갈린다:
 *   - 키 있음 + 행에 서명 있음 → 실제 검증 (틀리면 verified=false)
 *   - 키 있음 + 행에 서명 없음 → `missing` → **verified=false** (다운그레이드로 취급)
 *   - 키 없음                  → `not_configured` → 판정에서 제외하되 응답에 명시
 *
 * ## 왜 Ed25519인가
 * Node 내장 crypto만으로 서명·검증이 되고(외부 의존성 0), 공개키가 44바이트라
 * 검증자에게 그대로 배포할 수 있다. 제3자 검증에는 우리 서버가 필요 없어야 한다.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'crypto';

export const SIGNATURE_ALG = 'Ed25519';

export type SignatureStatus =
  | 'valid'
  | 'invalid'
  | 'missing'
  | 'not_configured'
  | 'not_applicable';

export interface ServerSignature {
  alg: string;
  keyId: string;
  signature: string; // base64
}

interface SignerState {
  privateKey: KeyObject;
  publicKey: KeyObject;
  keyId: string;
}

let cached: SignerState | null | undefined;

/**
 * PEM 또는 base64(PEM) 둘 다 받는다.
 *
 * 환경변수에 줄바꿈을 넣기 어려운 배포 환경이 많아서 base64 형태를 허용한다.
 * 어느 쪽인지는 'BEGIN' 포함 여부로 판별한다.
 */
function parsePem(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes('BEGIN')) return trimmed;
  return Buffer.from(trimmed, 'base64').toString('utf8');
}

/**
 * 서명자 상태. 키가 설정되지 않았으면 null.
 *
 * 키가 설정됐는데 **파싱에 실패하면 던진다** — 조용히 not_configured로 떨어뜨리면
 * "서명한다고 믿었는데 안 하고 있는" 상태가 되고, 그게 정확히 이 파일이 막으려는 것이다.
 */
export function getSigner(): SignerState | null {
  if (cached !== undefined) return cached;

  const raw = process.env.PROOF_SIGNING_PRIVATE_KEY;
  if (!raw || !raw.trim()) {
    cached = null;
    return cached;
  }

  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: parsePem(raw), format: 'pem' });
  } catch (err) {
    throw new Error(
      `PROOF_SIGNING_PRIVATE_KEY is set but could not be parsed as a PEM private key. ` +
        `Refusing to start unsigned while claiming to sign. Cause: ${(err as Error).message}`,
    );
  }

  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `PROOF_SIGNING_PRIVATE_KEY must be an Ed25519 key (got ${privateKey.asymmetricKeyType}).`,
    );
  }

  const publicKey = createPublicKey(privateKey);
  const keyId = process.env.PROOF_SIGNING_KEY_ID?.trim() || defaultKeyId(publicKey);

  cached = { privateKey, publicKey, keyId };
  return cached;
}

/** 테스트에서 환경변수를 바꾼 뒤 캐시를 비우기 위한 훅. */
export function resetSignerCache(): void {
  cached = undefined;
}

/**
 * 공개키에서 결정론적으로 키 ID를 만든다 — 별도 설정 없이도 키 회전을 식별할 수 있다.
 *
 * 🔴 DER을 그대로 base64 해서 앞부분을 자르면 안 된다. SPKI DER의 앞 12바이트는
 *    **모든 Ed25519 키가 공유하는 알고리즘 헤더**라, 서로 다른 키가 같은 keyId를 갖는다.
 *    (실제로 그렇게 짰다가 부팅 스모크에서 `ed25519-MCowBQYDK2VwAyEA` 를 보고 잡았다.)
 *    해시를 거쳐야 키마다 달라진다.
 */
function defaultKeyId(publicKey: KeyObject): string {
  const raw = publicKey.export({ type: 'spki', format: 'der' });
  const digest = createHash('sha256').update(raw).digest('base64url');
  return `ed25519-${digest.slice(0, 16)}`;
}

/**
 * 서명 대상 메시지.
 *
 * chain_hash와 seal_hash를 함께 묶는다. seal_hash가 바뀌면(=승인 내용이 바뀌면)
 * 서명이 깨져야 하므로 서명은 봉인 시점에 다시 계산된다.
 */
export function signingMessage(chainHash: string, sealHash: string | null): string {
  return `cronozen-proof/v3|${chainHash}|${sealHash ?? ''}`;
}

/** 키가 없으면 null을 돌려준다 — 호출자는 서명 없이 기록하되 그 사실을 숨기지 않는다. */
export function signRecord(chainHash: string, sealHash: string | null): ServerSignature | null {
  const signer = getSigner();
  if (!signer) return null;

  const message = Buffer.from(signingMessage(chainHash, sealHash), 'utf8');
  const signature = cryptoSign(null, message, signer.privateKey);

  return { alg: SIGNATURE_ALG, keyId: signer.keyId, signature: signature.toString('base64') };
}

/**
 * 서명 검증.
 *
 * 공개키 출처 우선순위: PROOF_SIGNING_PUBLIC_KEY → 개인키에서 유도.
 * 검증만 하는 노드(개인키를 두면 안 되는 곳)를 위해 공개키 단독 설정을 허용한다.
 */
export function getPublicKey(): KeyObject | null {
  const rawPublic = process.env.PROOF_SIGNING_PUBLIC_KEY;
  if (rawPublic && rawPublic.trim()) {
    try {
      return createPublicKey({ key: parsePem(rawPublic), format: 'pem' });
    } catch (err) {
      throw new Error(
        `PROOF_SIGNING_PUBLIC_KEY is set but could not be parsed as a PEM public key. ` +
          `Cause: ${(err as Error).message}`,
      );
    }
  }
  return getSigner()?.publicKey ?? null;
}

/** 검증자에게 배포할 공개키(PEM). 키가 없으면 null. */
export function exportPublicKeyPem(): { keyId: string; alg: string; publicKeyPem: string } | null {
  const publicKey = getPublicKey();
  if (!publicKey) return null;
  const signer = getSigner();
  return {
    keyId: signer?.keyId ?? process.env.PROOF_SIGNING_KEY_ID?.trim() ?? defaultKeyId(publicKey),
    alg: SIGNATURE_ALG,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

export interface SignatureCheck {
  status: SignatureStatus;
  keyId?: string;
  alg?: string;
  detail?: string;
}

/**
 * 저장된 서명을 검증한다.
 *
 * @param applicable v3 이전 행은 서명 개념이 없었다 → `not_applicable`.
 *                   서명이 없다는 사실로 옛 행을 실패시키면 거짓 경보가 된다.
 */
export function verifyRecordSignature(input: {
  chainHash: string;
  sealHash: string | null;
  signature: string | null;
  signatureAlg: string | null;
  signatureKeyId: string | null;
  applicable: boolean;
}): SignatureCheck {
  const publicKey = getPublicKey();

  if (!input.applicable) {
    return { status: 'not_applicable', detail: 'Record predates server signing (chain payload < v3).' };
  }

  if (!publicKey) {
    return {
      status: 'not_configured',
      detail: 'No signing key configured on this server. Chain integrity is still verified.',
    };
  }

  if (!input.signature) {
    return {
      status: 'missing',
      detail: 'Server has a signing key but this record carries no signature.',
    };
  }

  // 🔴 `input.signatureAlg &&` 로 감싸면 alg 를 null 로 지우는 것만으로 이 검사를 건너뛴다.
  //    행에 있는 값은 전부 공격자가 쓸 수 있으므로, **없는 것도 불일치로 본다.**
  if (input.signatureAlg !== SIGNATURE_ALG) {
    return {
      status: 'invalid',
      alg: input.signatureAlg ?? undefined,
      detail: input.signatureAlg
        ? `Unsupported signature algorithm: ${input.signatureAlg}`
        : 'Signature is present but carries no algorithm — the algorithm field was stripped.',
    };
  }

  // 🔴 keyId 는 행에 저장된 값(=공격자가 쓸 수 있는 값)이다. 검증은 서버 키로 하므로
  //    우회는 아니지만, 그 값을 그대로 응답에 실으면 "valid" 옆에 **남의 키 이름**이 뜬다.
  //    검증자가 /verify/public-key 와 대조했을 때 어긋나 보이므로 여기서 잘라낸다.
  const signer = getSigner();
  const expectedKeyId = signer?.keyId ?? process.env.PROOF_SIGNING_KEY_ID?.trim() ?? null;
  if (expectedKeyId && input.signatureKeyId && input.signatureKeyId !== expectedKeyId) {
    return {
      status: 'invalid',
      alg: SIGNATURE_ALG,
      detail: 'Signature key id does not match the key this server verifies with.',
    };
  }

  const message = Buffer.from(signingMessage(input.chainHash, input.sealHash), 'utf8');
  let ok = false;
  try {
    ok = cryptoVerify(null, message, publicKey, Buffer.from(input.signature, 'base64'));
  } catch {
    ok = false;
  }

  return {
    status: ok ? 'valid' : 'invalid',
    alg: SIGNATURE_ALG,
    // 저장된 값이 아니라 **실제로 검증에 쓴 키**를 보고한다.
    keyId: expectedKeyId ?? undefined,
  };
}

/** 키 생성 — scripts/generate-signing-key.ts 에서 사용. */
export function generateSigningKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}
