/**
 * ⏱️ 앵커 스케줄러 — 앵커가 **실제로 주기적으로 찍히게** 한다
 *
 * ## 왜 이게 스케줄러와 감시를 같이 갖고 있나
 *
 * 잡을 만들면서 **그 잡이 안 돌 때 드러나는 장치**를 같이 넣지 않으면,
 * "잡은 있는데 죽은 줄 모르는" 상태가 된다. 그러면 시간이 갈수록
 * `externallyAttested: true` 가 실제보다 강하게 읽힌다 — 마지막 앵커는 3일 전인데
 * 응답은 여전히 "외부에 박혀 있다"고 말하는 상태다.
 * 그래서 나이(age)를 계산하는 함수가 이 파일에 같이 있고, `/health` 와 `/verify` 가 그걸 읽는다.
 *
 * ## 왜 인프로세스인가 (GitHub Actions 가 아니라)
 *
 * - 공개 레포에 API 키 시크릿을 둘 필요가 없다
 * - 움직이는 부품이 타이머 하나뿐이다
 * - GH 크론은 레포 60일 비활성 시 **자동 정지**한다 — 조용히 죽는 방식이 하나 더 늘어난다
 * - 앱이 죽으면 앵커도 멈추지만, 그때는 기록도 안 쌓이므로 덮을 대상도 없다
 *
 * 단 인프로세스 감시는 자기 자신을 감시하는 것이라 약하다. 그래서 나이를 `/health` 에
 * 노출해 **밖에서 보는 눈**이 판정할 수 있게 한다.
 *
 * ## 언제 찍나
 *
 *   - 체인 머리가 마지막 앵커 이후 **자랐고**, 그리고
 *   - 간격이 지났거나 **아직 안 덮인 봉인(승인)이 있으면**
 *
 * 승인이 가장 값나가는 이벤트라 그것만은 창을 짧게 가져간다.
 */

import type { Database } from 'better-sqlite3';
import { createAnchor, submitAnchor } from './anchor.js';

/** 앵커 간격. 이 값이 곧 "탐지 못 하는 창" 의 상한이다. */
export function anchorIntervalMs(): number {
  return Number(process.env.PROOF_ANCHOR_INTERVAL_MS || 60 * 60 * 1000);
}

/** 이 시간을 넘도록 앵커가 없으면 잡이 죽은 것으로 본다. */
export function staleAfterMs(): number {
  return Number(process.env.PROOF_ANCHOR_STALE_MS || anchorIntervalMs() * 2);
}

function tickMs(): number {
  return Number(process.env.PROOF_ANCHOR_TICK_MS || 60 * 1000);
}

// ─── 나이 / 신선도 ──────────────────────────────────────────────────

export interface AnchorFreshness {
  latestAnchoredAt: string | null;
  ageSeconds: number | null;
  stale: boolean;
  staleAfterSeconds: number;
  /** 외부에 확정된 앵커가 하나라도 있는가 */
  externallyAttested: boolean;
  lastError: string | null;
}

/**
 * 앵커 신선도.
 *
 * 🔴 `stale` 을 조용히 두면 안 된다. 잡이 멈춘 채로 며칠이 지나도 `verified: true` 는
 *    계속 나오고, 그 사이 쌓인 레코드는 아무 앵커도 안 덮는다.
 */
export function anchorFreshness(db: Database, tenantId?: string): AnchorFreshness {
  const row = (tenantId
    ? db.prepare('SELECT anchored_at FROM chain_anchors WHERE tenant_id = ? ORDER BY anchored_at DESC LIMIT 1').get(tenantId)
    : db.prepare('SELECT anchored_at FROM chain_anchors ORDER BY anchored_at DESC LIMIT 1').get()
  ) as { anchored_at: string } | undefined;

  const confirmed = db
    .prepare("SELECT 1 FROM anchor_submissions WHERE status = 'confirmed' LIMIT 1")
    .get() as unknown;

  const lastErrRow = db
    .prepare("SELECT error FROM anchor_submissions WHERE error IS NOT NULL ORDER BY last_attempt_at DESC LIMIT 1")
    .get() as { error: string } | undefined;

  const staleAfter = staleAfterMs();

  if (!row) {
    return {
      latestAnchoredAt: null,
      ageSeconds: null,
      // 앵커가 아예 없는 것도 "신선하지 않다" 로 본다 — 없는 것을 정상으로 읽으면 안 된다.
      stale: true,
      staleAfterSeconds: Math.round(staleAfter / 1000),
      externallyAttested: false,
      lastError: lastErrRow?.error ?? null,
    };
  }

  const ageMs = Date.now() - new Date(row.anchored_at).getTime();
  return {
    latestAnchoredAt: row.anchored_at,
    ageSeconds: Math.round(ageMs / 1000),
    stale: ageMs > staleAfter,
    staleAfterSeconds: Math.round(staleAfter / 1000),
    externallyAttested: !!confirmed,
    lastError: lastErrRow?.error ?? null,
  };
}

// ─── 찍을 때가 됐는가 ───────────────────────────────────────────────

interface DueCheck {
  due: boolean;
  reason: string;
}

export function anchorDue(db: Database, tenantId: string): DueCheck {
  const last = db
    .prepare('SELECT id, anchored_at FROM chain_anchors WHERE tenant_id = ? ORDER BY anchored_at DESC LIMIT 1')
    .get(tenantId) as { id: string; anchored_at: string } | undefined;

  const head = db
    .prepare('SELECT COUNT(*) as n, MAX(chain_index) as idx FROM decision_events WHERE tenant_id = ?')
    .get(tenantId) as { n: number; idx: number | null };

  if (head.n === 0) return { due: false, reason: 'no records' };
  if (!last) return { due: true, reason: 'never anchored' };

  // 머리가 안 자랐으면 같은 것을 또 박을 이유가 없다.
  const grown = db
    .prepare(
      `SELECT COUNT(*) as n FROM decision_events e
       WHERE e.tenant_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM chain_anchor_heads h
           WHERE h.anchor_id = ? AND h.chain_domain = e.chain_domain AND h.chain_index >= e.chain_index
         )`,
    )
    .get(tenantId, last.id) as { n: number };

  if (grown.n === 0) return { due: false, reason: 'nothing new since last anchor' };

  // 아직 안 덮인 **봉인**이 있으면 간격을 기다리지 않는다 — 승인이 가장 값나가는 이벤트다.
  const unanchoredSeal = db
    .prepare(
      `SELECT COUNT(*) as n FROM decision_events e
       WHERE e.tenant_id = ? AND e.type = 'seal'
         AND NOT EXISTS (
           SELECT 1 FROM chain_anchor_heads h
           WHERE h.anchor_id = ? AND h.chain_domain = e.chain_domain AND h.chain_index >= e.chain_index
         )`,
    )
    .get(tenantId, last.id) as { n: number };

  if (unanchoredSeal.n > 0) return { due: true, reason: `${unanchoredSeal.n} unanchored seal(s)` };

  const elapsed = Date.now() - new Date(last.anchored_at).getTime();
  if (elapsed >= anchorIntervalMs()) return { due: true, reason: 'interval elapsed' };

  return { due: false, reason: 'within interval' };
}

// ─── 한 바퀴 ────────────────────────────────────────────────────────

export async function runAnchorTick(db: Database): Promise<{ tenantId: string; reason: string }[]> {
  const tenants = db
    .prepare('SELECT DISTINCT tenant_id FROM decision_events')
    .all() as { tenant_id: string }[];

  const done: { tenantId: string; reason: string }[] = [];
  for (const { tenant_id } of tenants) {
    const check = anchorDue(db, tenant_id);
    if (!check.due) continue;
    try {
      const anchor = createAnchor(db, tenant_id);
      await submitAnchor(db, tenant_id, anchor);
      done.push({ tenantId: tenant_id, reason: check.reason });
    } catch (err) {
      // 한 테넌트가 실패해도 나머지는 돈다. 그리고 **조용히 넘어가지 않는다.**
      console.error(`[anchor] tenant=${tenant_id} failed: ${(err as Error).message}`);
    }
  }
  return done;
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * 스케줄러 시작. **부팅에서만 부른다** — 테스트가 import 만으로 네트워크를 타면 안 된다.
 */
export function startAnchorScheduler(db: Database): void {
  if (timer) return;
  const every = tickMs();

  timer = setInterval(() => {
    runAnchorTick(db).then(done => {
      for (const d of done) console.log(`[anchor] anchored tenant=${d.tenantId} (${d.reason})`);
    }).catch(err => console.error(`[anchor] tick failed: ${(err as Error).message}`));
  }, every);

  // 프로세스를 붙잡지 않는다 — 종료가 이것 때문에 막히면 안 된다.
  timer.unref?.();

  console.log(
    `Anchor scheduler: every ${Math.round(every / 1000)}s `
    + `(interval ${Math.round(anchorIntervalMs() / 1000)}s, stale after ${Math.round(staleAfterMs() / 1000)}s)`,
  );
}

export function stopAnchorScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
