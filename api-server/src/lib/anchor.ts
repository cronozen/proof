/**
 * ⚓ 체인 앵커 — "T 시점에 머리가 여기였다"
 *
 * ## 무엇을 푸는가
 *
 * DB 안의 어떤 값으로도 **무엇이 있었는지**는 알 수 없다. 꼬리를 지우면 남은 체인은
 * 인덱스가 연속이고 링크도 맞아 정상으로 보인다. 승인 봉인 레코드도 체인의 꼬리라
 * 같은 방식으로 사라질 수 있다. 안에서는 풀 수 없는 문제다.
 *
 * 앵커는 특정 시점의 **머리(domain, index, hash)** 를 박제한다. 나중에 검증할 때
 * "앵커된 머리가 지금 체인에 그대로 있고, 지금 머리의 조상인가"를 대조하면
 * 그 사이 짧아진 것이 드러난다.
 *
 * ## 🔴 정직한 한계 — 이 파일만으로는 절반이다
 *
 * 이 표는 우리 DB 안에 있다. DB 를 쓸 수 있는 자는 앵커도 같이 지울 수 있다.
 * 그러므로 여기서 세우는 것은 **탐지 절차**이고, 앵커 자체를 위조 불가로 만드는 것은
 * 외부 제공자(OpenTimestamps 등)의 몫이다 — `provider`/`receipt` 가 그 자리다.
 * `provider='none'` 인 앵커를 "외부 앵커가 있다"고 말하면 안 된다. 응답이 그대로 말한다.
 *
 * ## 왜 Merkle 인가
 *
 * 외부에 박는 것은 **한 값(root)** 이어야 한다 — 제공자 호출 비용은 값 개수에 비례하니까.
 * root 하나로 그 시점의 모든 체인 머리를 덮고, 각 머리는 inclusion proof 로 자기가
 * 그 root 아래 있었음을 보인다.
 *
 * ## 도메인 은닉
 *
 * leaf 에 `chain_domain` 을 그대로 넣으면, 공개되는 inclusion proof 가 고객사 업무명을
 * 드러낸다 — 공개 검증 응답에서 일부러 뺀 값이다. 그래서 leaf 에는 테넌트별 salt 로
 * 가린 `domainKey` 를 쓴다. 우리 DB 안에는 평문으로 두되(우리 DB다), 밖으로 나가는
 * 값에는 안 넣는다.
 */

import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';

export const ANCHOR_TREE_VERSION = 'anchor-v1';

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

function sha256(...parts: Buffer[]): Buffer {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

/**
 * 도메인 은닉 키.
 *
 * salt 는 서버 설정에서 온다. 없으면 은닉이 없다는 뜻이므로 그렇게 표시한다 —
 * 조용히 평문을 쓰면 "가렸다"고 믿으면서 안 가리는 상태가 된다.
 */
export function domainKey(tenantId: string, domain: string): string {
  const salt = process.env.PROOF_ANCHOR_DOMAIN_SALT?.trim();
  if (!salt) return `plain:${tenantId}:${domain}`;
  return `blinded:${sha256(Buffer.from(`${salt}|${tenantId}|${domain}`, 'utf8')).toString('hex')}`;
}

export interface AnchorHead {
  chainDomain: string;
  chainIndex: number;
  chainHash: string;
}

/** leaf = H(0x00 ‖ version ‖ domainKey ‖ index ‖ hash) — 도메인 분리 접두사로 second-preimage 방지. */
export function anchorLeaf(tenantId: string, head: AnchorHead): Buffer {
  return sha256(
    LEAF_PREFIX,
    Buffer.from(
      `${ANCHOR_TREE_VERSION}|${domainKey(tenantId, head.chainDomain)}|${head.chainIndex}|${head.chainHash}`,
      'utf8',
    ),
  );
}

/** 직전 root 도 leaf 로 넣는다 — 앵커 **기록 자체**의 절단을 막는다. */
export function prevRootLeaf(prevRoot: string): Buffer {
  return sha256(LEAF_PREFIX, Buffer.from(`${ANCHOR_TREE_VERSION}|prev-root|${prevRoot}`, 'utf8'));
}

/**
 * Merkle root.
 *
 * 홀수 노드는 **복제하지 않고 그대로 올린다**. 복제(비트코인 방식)는 서로 다른 leaf 집합이
 * 같은 root 를 내는 CVE-2012-2459 계열 문제가 알려져 있다.
 */
export function merkleRoot(leaves: Buffer[]): string {
  if (leaves.length === 0) return sha256(LEAF_PREFIX, Buffer.from('empty', 'utf8')).toString('hex');

  let level = [...leaves].sort(Buffer.compare);
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? sha256(NODE_PREFIX, level[i], level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0].toString('hex');
}

// ─── 앵커 생성 ──────────────────────────────────────────────────────

export interface CreateAnchorResult {
  anchorId: string;
  merkleRoot: string;
  prevRoot: string | null;
  leafCount: number;
  anchoredAt: string;
  heads: AnchorHead[];
  provider: string;
}

/**
 * 지금 시점의 모든 체인 머리를 하나의 root 로 묶어 기록한다.
 *
 * 한 트랜잭션 안에서 읽고 쓴다 — 머리를 여러 번에 나눠 읽으면 그 사이 쓰기가 끼어들어
 * 찢어진 스냅숏이 박제된다.
 */
export function createAnchor(db: Database, tenantId: string): CreateAnchorResult {
  const anchorId = crypto.randomUUID();
  const anchoredAt = new Date().toISOString();

  const tx = db.transaction(() => {
    const heads = db
      .prepare(
        `SELECT chain_domain as chainDomain, MAX(chain_index) as chainIndex
         FROM decision_events WHERE tenant_id = ? GROUP BY chain_domain`,
      )
      .all(tenantId) as { chainDomain: string; chainIndex: number }[];

    const full: AnchorHead[] = heads.map(h => {
      const row = db
        .prepare(
          'SELECT chain_hash FROM decision_events WHERE tenant_id = ? AND chain_domain = ? AND chain_index = ?',
        )
        .get(tenantId, h.chainDomain, h.chainIndex) as { chain_hash: string };
      return { chainDomain: h.chainDomain, chainIndex: h.chainIndex, chainHash: row.chain_hash };
    });

    const prev = db
      .prepare('SELECT merkle_root FROM chain_anchors WHERE tenant_id = ? ORDER BY anchored_at DESC LIMIT 1')
      .get(tenantId) as { merkle_root: string } | undefined;
    const prevRoot = prev?.merkle_root ?? null;

    const leaves = full.map(h => anchorLeaf(tenantId, h));
    if (prevRoot) leaves.push(prevRootLeaf(prevRoot));

    const root = merkleRoot(leaves);

    db.prepare(`
      INSERT INTO chain_anchors (id, tenant_id, tree_version, merkle_root, prev_root, leaf_count, anchored_at, provider)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'none')
    `).run(anchorId, tenantId, ANCHOR_TREE_VERSION, root, prevRoot, leaves.length, anchoredAt);

    const insertHead = db.prepare(`
      INSERT INTO chain_anchor_heads (anchor_id, tenant_id, chain_domain, chain_index, chain_hash)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const h of full) insertHead.run(anchorId, tenantId, h.chainDomain, h.chainIndex, h.chainHash);

    return { root, prevRoot, leafCount: leaves.length, heads: full };
  });

  const out = tx.immediate();
  return {
    anchorId,
    merkleRoot: out.root,
    prevRoot: out.prevRoot,
    leafCount: out.leafCount,
    anchoredAt,
    heads: out.heads,
    provider: 'none',
  };
}

// ─── 대조 (탐지가 실제로 일어나는 자리) ──────────────────────────────

export type AnchorStatus =
  | 'no_anchor'          // 이 체인을 덮는 앵커가 없다
  | 'consistent'         // 앵커된 머리가 지금도 체인에 있고 조상이다
  | 'truncated'          // 앵커 시점보다 체인이 짧아졌다
  | 'rewritten'          // 앵커된 위치의 해시가 다르다
  | 'unanchored_growth'; // 앵커 이후 자란 부분은 아직 안 덮였다(정보성)

export interface AnchorCheck {
  ok: boolean;
  status: AnchorStatus;
  detail?: string;
  anchoredAt?: string;
  anchoredIndex?: number;
  currentIndex?: number;
  /** 🔴 외부 제공자가 없으면 이 앵커는 우리 DB 안에만 있다. 그대로 말한다. */
  provider?: string;
  externallyAttested?: boolean;
}

/**
 * 이 레코드가 속한 체인을 덮는 **가장 최근 앵커**와 대조한다.
 *
 * 여기가 꼬리 절단이 드러나는 유일한 자리다:
 *   앵커는 "그때 머리가 index N 이었다"고 말하는데 지금 체인이 N 보다 짧으면
 *   그 사이 레코드가 사라진 것이다. 남은 체인이 아무리 정합해도 이건 못 숨긴다.
 */
export function checkAnchor(
  db: Database,
  tenantId: string,
  chainDomain: string,
): AnchorCheck {
  const anchored = db
    .prepare(
      `SELECT h.chain_index, h.chain_hash, a.anchored_at, a.provider, a.confirmed_at
       FROM chain_anchor_heads h
       JOIN chain_anchors a ON a.id = h.anchor_id
       WHERE h.tenant_id = ? AND h.chain_domain = ?
       ORDER BY h.chain_index DESC LIMIT 1`,
    )
    .get(tenantId, chainDomain) as
    | { chain_index: number; chain_hash: string; anchored_at: string; provider: string; confirmed_at: string | null }
    | undefined;

  if (!anchored) {
    return {
      ok: true,
      status: 'no_anchor',
      detail: 'No anchor covers this chain yet — truncation of the tail would not be detectable.',
    };
  }

  const externallyAttested = anchored.provider !== 'none' && !!anchored.confirmed_at;
  const base = {
    anchoredAt: anchored.anchored_at,
    anchoredIndex: anchored.chain_index,
    provider: anchored.provider,
    externallyAttested,
  };

  const head = db
    .prepare(
      'SELECT MAX(chain_index) as idx FROM decision_events WHERE tenant_id = ? AND chain_domain = ?',
    )
    .get(tenantId, chainDomain) as { idx: number | null };
  const currentIndex = head.idx ?? -1;

  if (currentIndex < anchored.chain_index) {
    return {
      ...base,
      ok: false,
      status: 'truncated',
      currentIndex,
      detail:
        `The chain was anchored at index ${anchored.chain_index} on ${anchored.anchored_at}, `
        + `but its head is now index ${currentIndex} — records were deleted from the tail.`,
    };
  }

  const atAnchor = db
    .prepare(
      'SELECT chain_hash FROM decision_events WHERE tenant_id = ? AND chain_domain = ? AND chain_index = ?',
    )
    .get(tenantId, chainDomain, anchored.chain_index) as { chain_hash: string } | undefined;

  if (!atAnchor) {
    return {
      ...base,
      ok: false,
      status: 'truncated',
      currentIndex,
      detail: `The record anchored at index ${anchored.chain_index} is missing from the chain.`,
    };
  }

  if (atAnchor.chain_hash !== anchored.chain_hash) {
    return {
      ...base,
      ok: false,
      status: 'rewritten',
      currentIndex,
      detail:
        `The record at anchored index ${anchored.chain_index} no longer matches the anchored hash — `
        + 'the chain was rewritten below the anchor point.',
    };
  }

  return {
    ...base,
    ok: true,
    status: currentIndex > anchored.chain_index ? 'unanchored_growth' : 'consistent',
    currentIndex,
    detail:
      currentIndex > anchored.chain_index
        ? `Consistent up to anchored index ${anchored.chain_index}. Records after it are not yet anchored — `
          + 'deleting only those would still be undetectable.'
        : undefined,
  };
}
