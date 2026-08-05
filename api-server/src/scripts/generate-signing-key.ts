/**
 * 서버 서명 키 생성 (Ed25519)
 *
 *   npm run keygen --workspace=api-server
 *
 * 출력된 두 줄을 .env 에 넣으면 서명이 켜진다.
 * 개인키는 서버에만, 공개키는 검증자에게 배포한다 —
 * 제3자 검증이 성립하려면 검증자가 우리 서버를 믿지 않고도 서명을 확인할 수 있어야 한다.
 */

import { generateSigningKeyPair } from '../lib/signing.js';

const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();

const privateB64 = Buffer.from(privateKeyPem, 'utf8').toString('base64');
const publicB64 = Buffer.from(publicKeyPem, 'utf8').toString('base64');

console.log('');
console.log('═══════════════════════════════════════════════════════════');
console.log('  Cronozen Proof — Server Signing Key (Ed25519)');
console.log('═══════════════════════════════════════════════════════════');
console.log('');
console.log('# .env 에 추가 (개인키는 서버 밖으로 내보내지 말 것)');
console.log(`PROOF_SIGNING_PRIVATE_KEY=${privateB64}`);
console.log('');
console.log('# 검증자에게 배포할 공개키 (선택 — 개인키가 있으면 자동 유도된다)');
console.log(`PROOF_SIGNING_PUBLIC_KEY=${publicB64}`);
console.log('');
console.log('─── 공개키 (PEM) ───');
console.log(publicKeyPem.trim());
console.log('');
console.log('⚠️  키를 교체하면 기존 레코드의 서명은 검증되지 않는다.');
console.log('   교체 시에는 옛 공개키도 함께 배포해야 한다(키 회전 미구현).');
console.log('═══════════════════════════════════════════════════════════');
console.log('');
