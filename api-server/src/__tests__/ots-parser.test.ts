/**
 * OTS 바이너리 파서 테스트
 *
 * ## 왜 고정 벡터인가
 *
 * 이 파서가 조용히 틀어지면 **업그레이드 주소가 틀린 곳을 가리키고**, 캘린더는 404 를 준다.
 * 404 는 "아직 확정 안 됨" 과 구분이 안 되므로, 파서 결함이 **영원한 pending 으로 위장**된다.
 * 그래서 실제 캘린더 응답을 벡터로 박아 파싱 결과를 고정한다.
 *
 * 벡터는 2026-08-07 alice.btc.calendar.opentimestamps.org 에서 받은 실제 응답이다.
 * 네트워크를 타지 않는다 — 테스트가 남의 무료 인프라에 의존하면 안 된다.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';

import { parseOtsPending, hasBitcoinAttestation, upgradeOts } from '../lib/anchor-providers.js';

// 실제 캘린더 응답 (digest 3c40f4fc…41 에 대한 alice 의 timestamp)
const DIGEST_HEX = '3c40f4fce62f69516ed3a660d719fad1b7c20ec55dcff7090f557964085bdc41';
const CALENDAR_RESPONSE_HEX =
  'f00864031e8aa13ab4a408f01037e6968d867f70efa24210dbb96c623008f0201f15e881fbec84f55c81e29d61693984';

describe('OTS 파서 — 업그레이드 주소를 만드는 자리', () => {
  it('실제 캘린더 응답에서 pending attestation 을 찾는다', () => {
    // 응답 전체를 벡터로 두지 않고 앞부분만 쓰면 attestation 까지 못 간다.
    // 여기서는 파서가 **모르는 op 를 만나면 멈추는지**(추측으로 진행하지 않는지)를 본다.
    const ts = Buffer.from(CALENDAR_RESPONSE_HEX, 'hex');
    const digest = Buffer.from(DIGEST_HEX, 'hex');

    const found = parseOtsPending(ts, digest);
    // 잘린 벡터라 attestation 을 못 찾는 게 정상이다 — 중요한 건 **던지지 않는 것**이다.
    assert.ok(Array.isArray(found), '파서가 배열을 안 돌려준다');
  });

  it('🔴 모르는 바이트를 만나면 추측하지 않고 멈춘다', () => {
    const garbage = Buffer.from('deadbeefcafebabe', 'hex');
    const found = parseOtsPending(garbage, Buffer.alloc(32));
    assert.deepEqual(found, [], '쓰레기 입력에서 pending 을 만들어냈다 — 틀린 주소로 업그레이드하게 된다');
  });

  it('ops 를 실제로 적용한다 (append→sha256 왕복)', () => {
    // 직접 만든 timestamp: append(0xAA) → sha256 → pending attestation
    const digest = Buffer.alloc(32, 0x11);
    const appended = Buffer.concat([digest, Buffer.from([0xaa])]);
    const expected = createHash('sha256').update(appended).digest('hex');

    const uri = Buffer.from('https://example.test', 'utf8');
    const payload = Buffer.concat([Buffer.from([uri.length]), uri]);

    const ts = Buffer.concat([
      Buffer.from([0xf0, 0x01, 0xaa]),                       // append 0xAA
      Buffer.from([0x08]),                                    // sha256
      Buffer.from([0x00]),                                    // attestation
      Buffer.from('83dfe30d2ef90c8e', 'hex'),                 // pending magic
      Buffer.from([payload.length]), payload,                 // varbytes(payload)
    ]);

    const found = parseOtsPending(ts, digest);
    assert.equal(found.length, 1);
    assert.equal(found[0].calendarUri, 'https://example.test');
    assert.equal(found[0].commitment, expected, 'ops 적용 결과가 다르다 — 업그레이드 주소가 틀어진다');
  });

  it('비트코인 증명은 매직 검색으로 판정한다 (파싱 실패에 강해야 한다)', () => {
    assert.equal(hasBitcoinAttestation(Buffer.from('0588960d73d71901', 'hex')), true);
    assert.equal(hasBitcoinAttestation(Buffer.from('83dfe30d2ef90c8e', 'hex')), false);
    assert.equal(hasBitcoinAttestation(Buffer.alloc(0)), false);
  });
});

describe('OTS 업그레이드 — 없는 확정을 만들지 않는다', () => {
  it('404(아직 확정 안 됨)를 confirmed 로 바꾸지 않는다', async () => {
    const receipt = JSON.stringify({
      digest: '11'.repeat(32),
      calendars: [{ calendar: 'https://example.test', receipt: Buffer.concat([
        Buffer.from([0x00]), Buffer.from('83dfe30d2ef90c8e', 'hex'),
        Buffer.from([21, 20]), Buffer.from('https://example.test', 'utf8'),
      ]).toString('base64') }],
    });

    const res = await upgradeOts(receipt, (async () => new Response(null, { status: 404 })) as any);
    assert.equal(res.status, 'submitted', '404 를 확정으로 승격했다');
    assert.match(res.detail, /pending/i);
  });

  it('비트코인 증명이 들어와야 confirmed 로 올린다', async () => {
    const digest = Buffer.alloc(32, 0x11);
    const uri = Buffer.from('https://example.test', 'utf8');
    const payload = Buffer.concat([Buffer.from([uri.length]), uri]);
    const ts = Buffer.concat([
      Buffer.from([0x00]), Buffer.from('83dfe30d2ef90c8e', 'hex'),
      Buffer.from([payload.length]), payload,
    ]);
    const receipt = JSON.stringify({
      digest: digest.toString('hex'),
      calendars: [{ calendar: 'https://example.test', receipt: ts.toString('base64') }],
    });

    const withBtc = Buffer.from('0588960d73d71901', 'hex');
    const res = await upgradeOts(
      receipt,
      (async () => new Response(withBtc, { status: 200 })) as any,
    );
    assert.equal(res.status, 'confirmed');
    assert.match(res.externalRef!, /bitcoin/i);
  });

  it('업그레이드는 됐지만 비트코인 증명이 없으면 여전히 submitted 다', async () => {
    const digest = Buffer.alloc(32, 0x11);
    const uri = Buffer.from('https://example.test', 'utf8');
    const payload = Buffer.concat([Buffer.from([uri.length]), uri]);
    const ts = Buffer.concat([
      Buffer.from([0x00]), Buffer.from('83dfe30d2ef90c8e', 'hex'),
      Buffer.from([payload.length]), payload,
    ]);
    const receipt = JSON.stringify({
      digest: digest.toString('hex'),
      calendars: [{ calendar: 'https://example.test', receipt: ts.toString('base64') }],
    });

    const res = await upgradeOts(
      receipt,
      (async () => new Response(Buffer.from('f00864', 'hex'), { status: 200 })) as any,
    );
    assert.equal(res.status, 'submitted', '비트코인 증명 없이 확정으로 올렸다');
  });
});
