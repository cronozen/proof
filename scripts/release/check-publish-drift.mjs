#!/usr/bin/env node
/**
 * 배포 드리프트 검사 — 로컬 workspace 버전이 npm 에 올라갔나.
 *
 * 🔴 왜 있나 (2026-08-27):
 *    `@cronozen/dpu-core` 의 체인 해시 결함이 `480c66da04` 에서 고쳐졌는데
 *    **npm 에 안 올라갔다.** ops 는 `node_modules/@cronozen/dpu-core` 를 로컬 패키지로
 *    **심볼릭 링크**해서 즉시 수리를 받았고, npm 을 쓰는 dataforge 는 **8개월간 v1** 을 물었다.
 *    양쪽 다 초록이었다 — 심볼릭 링크가 「고쳤다」는 착각을 만든다.
 *
 * 🔑 그래서 이 검사는 「버전을 어떻게 매기나」가 아니라
 *    **「배포됐는지 아무도 모른다」** 를 막는다. 이 레포에 필요한 릴리스 자동화는 이것 하나다.
 *
 * 판정:
 *   local > npm   → 🔴 미배포 (exit 1)   ← 오늘 사고의 형태
 *   local === npm → ✅
 *   local < npm   → 🪤 로컬이 뒤처짐 (경고. 누가 다른 데서 올렸다)
 *   npm 에 없음    → 🪤 미공개 패키지로 본다 (private:true 면 조용히 스킵)
 *
 * 사용: node scripts/release/check-publish-drift.mjs [--json]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('../..', import.meta.url).pathname;
const JSON_OUT = process.argv.includes('--json');

/** npm 레지스트리의 최신 버전. 없으면 null. 네트워크 실패는 throw(조용한 초록 금지). */
function npmLatest(name) {
  try {
    const out = execFileSync('npm', ['view', `${name}`, 'version'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    });
    return out.trim() || null;
  } catch (e) {
    const msg = String(e.stderr || e.message || '');
    // 🪤 「없는 패키지」와 「네트워크 실패」를 구분한다. 후자를 null 로 접으면
    //    레지스트리가 죽은 날 전 패키지가 "미공개" 로 보이고 검사가 무의미해진다.
    if (/E404|404 Not Found/.test(msg)) return null;
    throw new Error(`npm view ${name} 실패 (네트워크/인증?): ${msg.split('\n')[0]}`);
  }
}

/** semver 비교. -1 / 0 / 1 */
function cmp(a, b) {
  const pa = a.split('-')[0].split('.').map(Number);
  const pb = b.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1;
  }
  // 프리릴리스는 정식보다 낮다
  const ra = a.includes('-'), rb = b.includes('-');
  if (ra !== rb) return ra ? -1 : 1;
  return 0;
}

const pkgDir = join(ROOT, 'packages');
const rows = [];
for (const name of readdirSync(pkgDir)) {
  const p = join(pkgDir, name, 'package.json');
  if (!existsSync(p)) continue;
  const d = JSON.parse(readFileSync(p, 'utf8'));
  if (d.private === true) continue;              // 비공개 패키지는 대상 아님
  const latest = npmLatest(d.name);
  const state =
    latest === null ? 'unpublished'
    : cmp(d.version, latest) > 0 ? 'drift'
    : cmp(d.version, latest) < 0 ? 'behind'
    : 'ok';
  rows.push({ pkg: d.name, local: d.version, npm: latest, state });
}

if (JSON_OUT) { console.log(JSON.stringify({ rows }, null, 2)); }
else {
  const label = { ok: '✅ 일치', drift: '🔴 미배포', behind: '🪤 로컬이 뒤처짐', unpublished: '🪤 npm 에 없음' };
  for (const r of rows) {
    console.log(`${label[r.state]}  ${r.pkg}  local=${r.local}  npm=${r.npm ?? '-'}`);
  }
  // 🔑 0건이 「없음」인지 「관측 안 됨」인지 구분되게 한다.
  console.log(`\n검사한 패키지 ${rows.length}개 (packages/*, private 제외)`);
}

const drifted = rows.filter((r) => r.state === 'drift');
if (drifted.length) {
  console.error(
    `\n🔴 로컬 버전이 npm 보다 앞선 패키지 ${drifted.length}개 — **아직 배포되지 않았다.**\n` +
    drifted.map((r) => `   ${r.pkg}: local ${r.local} > npm ${r.npm}`).join('\n') +
    `\n\n   심볼릭 링크로 물고 있는 소비처(ops)는 이미 수리를 받았지만\n` +
    `   npm 으로 물고 있는 소비처(dataforge)는 **아직 옛 코드를 쓴다.**\n` +
    `   배포: cd packages/<name> && npm publish && git tag <name>@<version>\n`,
  );
  process.exit(1);
}
