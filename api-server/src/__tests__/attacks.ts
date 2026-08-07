/**
 * 공격 목록 — 검증기가 막아야 하는 것들의 정본
 *
 * 이 배열이 "우리가 무엇을 막는가"의 답이다. 감사에서 물으면 이 파일을 보여준다.
 * 새 공격을 알게 되면 여기 한 줄 추가하면 러너가 알아서 돌린다.
 *
 * 🔴 `knownGap` 이 붙은 항목은 **아직 못 막는 것**이다. 지우지 않는 이유:
 *    목록에서 지우면 없는 문제가 되고, 나중에 누가 "다 막았다"고 말하게 된다.
 */

import { computeChainHash } from '@cronozen/dpu-core';
import { signRecord } from '../lib/signing.js';
import type { Attack } from './attack-harness.js';

/** 대상 행의 컬럼 하나를 바꾼다. */
function set(ctx: { db: any; target: { evidenceId: string } }, column: string, value: unknown): void {
  ctx.db.prepare(`UPDATE decision_events SET ${column} = ? WHERE evidence_id = ?`)
    .run(value as never, ctx.target.evidenceId);
}

function row(ctx: { db: any; target: { evidenceId: string } }): any {
  return ctx.db.prepare('SELECT * FROM decision_events WHERE evidence_id = ?').get(ctx.target.evidenceId);
}

export const ATTACKS: Attack[] = [
  // ── 내용 변조 ──────────────────────────────────────────────────
  {
    id: 'content-output',
    what: '산출물(action_output)을 바꾼다',
    impact: 'AI 가 내린 결정의 결과가 사후에 바뀐다 — 정산 금액이 여기 들어간다',
    setup: 'record',
    mutate: ctx => set(ctx, 'action_output', JSON.stringify({ payout: 99_000_000 })),
    detectedBy: 'chainHash',
    detailMatches: /altered after recording/i,
  },
  {
    id: 'content-ai-reasoning',
    what: 'AI 판단 근거(ai_reasoning)를 바꾼다',
    impact: '"왜 그렇게 판단했나"가 바뀐다 — 감사에서 가장 먼저 묻는 값',
    setup: 'record',
    mutate: ctx => set(ctx, 'ai_reasoning', '요건 미충족이었으나 승인함'),
    detectedBy: 'chainHash',
  },
  {
    id: 'content-actor',
    what: '행위자(actor_id)를 바꾼다',
    impact: '누가 한 일인지가 바뀐다 — 책임 소재가 이동한다',
    setup: 'record',
    mutate: ctx => set(ctx, 'actor_id', 'someone-else'),
    detectedBy: 'chainHash',
  },
  {
    id: 'content-occurred-at',
    what: '발생 시각(occurred_at)을 바꾼다',
    impact: '언제 일어난 일인지가 바뀐다',
    setup: 'record',
    mutate: ctx => set(ctx, 'occurred_at', '2020-01-01T00:00:00.000Z'),
    detectedBy: 'chainHash',
  },
  {
    id: 'content-hash-swap',
    what: 'chain_hash 자체를 임의값으로 바꿔치기한다',
    impact: '해시만 갈아끼워 재계산을 우회하려는 시도',
    setup: 'record',
    mutate: ctx => set(ctx, 'chain_hash', 'f'.repeat(64)),
    detectedBy: 'chainHash',
  },

  // ── 버전 다운그레이드 ──────────────────────────────────────────
  {
    id: 'downgrade-to-v2',
    what: 'chain_payload_version 을 2 로 내리고 3필드 해시를 다시 계산한다',
    impact: '버전 컬럼 하나로 내용결속·봉인검사·서명요구가 동시에 꺼진다 (2026-08-05 재현)',
    setup: 'record',
    mutate: ctx => {
      const r = row(ctx);
      const forged = computeChainHash(
        { type: r.type, action_type: r.action_type, actor_id: r.actor_id },
        r.previous_hash,
        r.occurred_at,
      );
      ctx.db.prepare(`
        UPDATE decision_events
        SET action_output = ?, chain_payload_version = 2, chain_hash = ?,
            signature = NULL, signature_alg = NULL, signature_key_id = NULL
        WHERE evidence_id = ?
      `).run(JSON.stringify({ payout: 99_000_000 }), forged, ctx.target.evidenceId);
    },
    detectedBy: 'contentCoverage',
    detailMatches: /does not cover the record content/i,
  },

  // ── 체인 구조 ──────────────────────────────────────────────────
  {
    id: 'link-previous-gap',
    what: '앞 레코드를 삭제해 체인에 구멍을 낸다',
    impact: '기록 하나를 통째로 없앤다 — 개별 해시만 보면 안 잡힌다',
    setup: 'chain3',
    mutate: ctx => {
      ctx.db.prepare('DELETE FROM decision_events WHERE evidence_id = ?').run(ctx.records[0].evidenceId);
    },
    detectedBy: 'chainLink',
    detailMatches: /missing|gap/i,
  },
  {
    id: 'link-previous-rewrite',
    what: 'previous_hash 를 다른 값으로 바꾼다',
    impact: '체인을 다른 가지에 붙여 순서를 다시 쓴다',
    setup: 'chain3',
    // previous_hash 는 해시 **입력**이라 chainHash 가 먼저 잡는다(chainLink 도 함께 잡음).
    // 하네스가 이 기대치 오류를 지적했다 — "다른 검사가 잡았다"를 통과로 세면 안 된다.
    mutate: ctx => set(ctx, 'previous_hash', 'a'.repeat(64)),
    detectedBy: 'chainHash',
  },
  {
    id: 'link-next-rewrite',
    what: '뒤 레코드가 나를 안 가리키게 만든다 (후행 링크)',
    impact: '앞만 보는 검증기는 뒤가 끊겨도 통과한다 — ops 가 지적받고 조인 구멍',
    setup: 'chain3',
    mutate: ctx => {
      ctx.db.prepare('UPDATE decision_events SET previous_hash = ? WHERE evidence_id = ?')
        .run('b'.repeat(64), ctx.records[2].evidenceId);
    },
    detectedBy: 'chainLink',
    detailMatches: /following record/i,
  },

  // ── 승인(봉인) 위조 ────────────────────────────────────────────
  {
    id: 'seal-approver-swap',
    what: '승인자 이름을 바꿔치기한다',
    impact: '누가 결재했는지가 바뀐다 — 결재선이 증거의 핵심이다',
    setup: 'sealed',
    mutate: ctx => set(ctx, 'approver_name', '다른사람'),
    detectedBy: 'seal',
  },
  {
    id: 'seal-result-flip',
    what: '승인 결과를 rejected → approved 로 뒤집는다',
    impact: '반려된 건이 승인된 건으로 둔갑한다',
    // 🪤 반려된 건으로 시작해야 실제 공격이다. approved 를 approved 로 바꾸면 no-op 이고
    //    하네스가 "탐지되지 않았다"고 보고한다 — 그게 맞다. 셋업이 틀렸던 것.
    setup: 'rejected',
    mutate: ctx => {
      set(ctx, 'approval_result', 'approved');
      set(ctx, 'evidence_level', 'AUDIT_READY');
    },
    detectedBy: 'seal',
  },
  {
    id: 'seal-hash-strip',
    what: '봉인 해시를 지운다',
    impact: '승인 결속을 없애 이후 승인 필드를 자유롭게 바꾸려는 준비',
    setup: 'sealed',
    mutate: ctx => set(ctx, 'seal_hash', null),
    detectedBy: 'seal',
  },
  {
    id: 'seal-forge-unsealed',
    what: '승인 없이 evidence_level 만 AUDIT_READY 로 올린다',
    impact: '승인한 적 없는 건이 감사준비 완료로 표시된다 (2026-08-05 재현)',
    setup: 'record',
    mutate: ctx => {
      set(ctx, 'evidence_level', 'AUDIT_READY');
      set(ctx, 'status', 'sealed');
      set(ctx, 'approver_name', '가짜승인자');
    },
    detectedBy: 'seal',
    detailMatches: /approval was forged/i,
  },
  {
    id: 'seal-sealedat-only',
    what: '승인 없이 sealed_at 만 채운다',
    impact: '봉인 시각만 만들어 봉인된 것처럼 보이게 한다',
    setup: 'record',
    mutate: ctx => {
      set(ctx, 'sealed_at', new Date().toISOString());
      set(ctx, 'evidence_level', 'AUDIT_READY');
    },
    detectedBy: 'seal',
  },

  // ── 서명 ───────────────────────────────────────────────────────
  {
    id: 'sig-strip',
    what: '서명을 지운다 (다운그레이드)',
    impact: '서명 없이도 통과하면 DB 쓰기 권한만으로 위조가 가능해진다',
    setup: 'record',
    mutate: ctx => set(ctx, 'signature', null),
    detectedBy: 'serverSignature',
  },
  {
    id: 'sig-forge',
    what: '서명을 임의값으로 바꾼다',
    impact: '서명 검증이 실제로 도는지 확인',
    setup: 'record',
    mutate: ctx => set(ctx, 'signature', Buffer.alloc(64, 1).toString('base64')),
    detectedBy: 'serverSignature',
  },
  {
    id: 'sig-alg-strip',
    what: 'signature_alg 를 지워 알고리즘 검사를 건너뛰려 한다',
    impact: '행에 있는 값은 전부 공격자 통제 — 없는 것도 불일치로 봐야 한다',
    setup: 'record',
    mutate: ctx => set(ctx, 'signature_alg', null),
    detectedBy: 'serverSignature',
  },

  // ── 롤백 (2026-08-06 봉인 승격으로 막힘) ────────────────────────
  {
    id: 'rollback-preapproval-signature',
    what: '승인을 지우고 승인 전 서명을 복원한다',
    impact:
      '승인 기록이 흔적 없이 사라진다. 승인 시 서명이 덮어써지므로, 공격자가 승인 전 서명값을 '
      + '보관했다가 되돌리면 메시지가 바이트 단위로 일치해 서명이 그대로 맞는다',
    setup: 'sealed',
    mutate: ctx => {
      // 공격자가 승인 전에 서명을 캡처해 뒀다고 가정하고, 그 상태를 그대로 복원한다.
      const r = row(ctx);
      const preApproval = signRecord(r.chain_hash, null)!;
      ctx.db.prepare(`
        UPDATE decision_events
        SET status = 'recorded', evidence_level = 'DRAFT',
            approver_id = NULL, approver_type = NULL, approver_name = NULL,
            approval_result = NULL, approval_reason = NULL, approved_at = NULL,
            sealed_at = NULL, seal_hash = NULL,
            signature = ?, signature_alg = ?, signature_key_id = ?
        WHERE evidence_id = ?
      `).run(preApproval.signature, preApproval.alg, preApproval.keyId, ctx.target.evidenceId);
    },
    // 🎉 2026-08-06 이전까지 knownGap 이었다. 봉인을 체인 레코드로 승격하자 잡히게 됐다 —
    //    되돌린 행 옆에 봉인 레코드가 체인 안에 그대로 남아 불일치가 드러난다.
    //    하네스가 "알려진 갭이 이제 탐지된다"고 알려줘서 승격했다.
    detectedBy: 'seal',
    detailMatches: /rolled back after it was sealed/i,
  },
  {
    id: 'seal-record-delete',
    what: '체인에서 봉인 레코드 자체를 지운다',
    impact: '승인 흔적을 체인째 없애려는 시도 — 봉인 레코드는 꼬리라 링크로는 안 잡힌다',
    mutate: ctx => {
      const target = row(ctx);
      ctx.db.prepare("DELETE FROM decision_events WHERE type = 'seal' AND seals_decision_id = ?")
        .run(target.decision_id);
    },
    // 🎉 앵커가 생기면서 잡힌다 — 봉인 레코드가 꼬리이므로 지우면 체인이 앵커보다 짧아진다.
    setup: 'anchoredSeal',
    detectedBy: 'anchor',
    detailMatches: /deleted from the tail|missing from the chain/i,
  },
  {
    id: 'seal-record-retarget',
    what: '봉인 레코드가 다른 결정을 가리키게 조회 컬럼을 바꾼다',
    impact: '한 건의 승인을 다른 건으로 옮겨 붙이려는 시도',
    setup: 'sealed',
    mutate: ctx => {
      ctx.db.prepare("UPDATE decision_events SET seals_decision_id = 'dec_somewhere_else' WHERE type = 'seal'")
        .run();
    },
    detectedBy: 'seal',
  },
  // ── 꼬리 절단 (2026-08-07 앵커로 막힘) ──────────────────────────
  {
    id: 'tail-truncation',
    what: '체인의 마지막 레코드들을 지운다',
    impact: '가장 최근 기록이 사라져도 남은 체인은 인덱스가 연속이고 링크도 맞아 정상으로 보인다',
    // 🎉 앵커를 찍은 뒤 꼬리를 지우면, 앵커가 "그때 머리는 #2 였다"고 말하는데
    //    지금 머리가 #1 이라 드러난다. 남은 체인의 정합성으로는 못 숨긴다.
    setup: 'anchored',
    mutate: ctx => {
      ctx.db.prepare('DELETE FROM decision_events WHERE evidence_id = ?').run(ctx.records[2].evidenceId);
    },
    detectedBy: 'anchor',
    detailMatches: /deleted from the tail|missing from the chain/i,
  },
  {
    id: 'anchor-rewrite-below',
    what: '앵커된 위치의 레코드를 다른 것으로 바꿔치기한다',
    impact: '앵커 아래를 다시 써서 과거를 바꾸려는 시도',
    setup: 'anchored',
    mutate: ctx => {
      // 앵커된 머리(#2)의 해시를 바꾼다
      ctx.db.prepare('UPDATE decision_events SET chain_hash = ? WHERE evidence_id = ?')
        .run('c'.repeat(64), ctx.records[2].evidenceId);
    },
    detectedBy: 'anchor',
    detailMatches: /rewritten below the anchor/i,
  },

  // ── 🔴 아직 못 막는 것 ─────────────────────────────────────────
  {
    id: 'gap-truncate-with-anchor-erasure',
    what: '꼬리를 지우면서 앵커 기록까지 함께 지운다',
    impact:
      '앵커가 우리 DB 안에 있는 한, DB 를 쓸 수 있는 자는 앵커도 같이 지운다. '
      + '그러면 "앵커가 없는 체인" 이 되어 대조할 것이 사라진다',
    setup: 'anchored',
    mutate: ctx => {
      ctx.db.prepare('DELETE FROM decision_events WHERE evidence_id = ?').run(ctx.records[2].evidenceId);
      ctx.db.prepare('DELETE FROM chain_anchor_heads WHERE chain_domain = ?').run(ctx.domain);
      ctx.db.prepare('DELETE FROM chain_anchors').run();
    },
    detectedBy: 'anchor',
    knownGap: {
      why: '앵커 표가 같은 DB 안에 있어서 함께 지워진다 — 탐지 절차는 섰지만 앵커 자체가 위조 가능하다',
      needs: '외부 제공자 제출 (OpenTimestamps 등) — root 가 우리 손 밖에 있어야 한다',
    },
  },
];
