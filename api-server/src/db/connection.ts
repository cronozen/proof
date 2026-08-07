/**
 * SQLite DB 연결 (MVP)
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { SCHEMA_SQL } from './schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/proof.db');

let db: Database.Database | null = null;

export function getDB(): Database.Database {
  if (!db) {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initializeDatabase(db);
  }
  return db;
}

/**
 * 마이그레이션 + 스키마 적용.
 *
 * getDB() 밖으로 꺼내둔 이유는 테스트가 **실제로 도는 이 코드**를 옛 모양의 DB에 걸어볼 수
 * 있어야 하기 때문이다. 테스트가 마이그레이션 로직을 따로 복제하면, 복제본만 초록이 된다.
 *
 * 🔴 순서가 중요하다 — 컬럼 마이그레이션이 SCHEMA_SQL **앞**에 온다.
 *
 * SCHEMA_SQL 은 `CREATE TABLE IF NOT EXISTS` 와 `CREATE INDEX IF NOT EXISTS` 를 함께 담는다.
 * 기존 DB에서는 CREATE TABLE 이 건너뛰어지는데, 그 뒤 CREATE INDEX 는 건너뛰지 않는다.
 * 그래서 인덱스가 아직 없는 컬럼을 가리키면 `SqliteError: no such column` 으로
 * **부팅 자체가 죽는다**. source_type 마이그레이션이 exec 뒤에 있어서 실제로 그 상태였다
 * (2026-04 이전에 만들어진 DB로는 서버가 뜨지 않았다 — 레포가 멈춰 있어 아무도 밟지 않았을 뿐).
 *
 * 컬럼을 먼저 채우고 → 스키마/인덱스를 적용한다. 신규 DB는 테이블이 없으니 마이그레이션을 건너뛴다.
 */
export function initializeDatabase(database: Database.Database): void {
  const tableExists = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'decision_events'")
    .get();

  if (tableExists) {
    const addColumn = (name: string, ddl: string) => {
      const current = database.prepare('PRAGMA table_info(decision_events)').all() as { name: string }[];
      if (!current.some(c => c.name === name)) {
        database.exec(`ALTER TABLE decision_events ADD COLUMN ${ddl}`);
      }
    };

    // 2026-04: 4-layer source 분류
    addColumn('source_type', "source_type TEXT NOT NULL DEFAULT 'manual'");

    // 2026-08-05: 검증 엔진 컬럼.
    // 전부 nullable 이고 기본값을 주지 않는다 — 기존 행은 v2 규칙(3개 필드)으로 기록됐고
    // 그 행에 chain_payload_version=3 을 채워 넣으면 검증이 전부 실패한다.
    // NULL 은 "레거시"라는 정보이지 결측이 아니다.
    addColumn('chain_payload_version', 'chain_payload_version INTEGER');
    addColumn('seal_hash', 'seal_hash TEXT');
    addColumn('signature', 'signature TEXT');
    addColumn('signature_alg', 'signature_alg TEXT');
    addColumn('signature_key_id', 'signature_key_id TEXT');

    // 2026-08-06: 봉인을 체인 레코드로 승격 — 봉인 레코드가 가리키는 결정.
    addColumn('seals_decision_id', 'seals_decision_id TEXT');
  }

  database.exec(SCHEMA_SQL);

  enforceChainUniqueness(database);
}

/**
 * 체인 위치 유일성 — 같은 (tenant, domain, index)가 두 번 존재할 수 없게 한다.
 *
 * 쓰기 경로는 트랜잭션으로 경합을 막지만, 그건 **이 프로세스 안에서만** 참이다.
 * 여러 인스턴스·수동 INSERT·복구 스크립트까지 덮는 최후 방어선은 DB 제약뿐이다.
 * 체인이 갈라지면 앞뒤 링크 조회가 비결정적이 되고, 검증기가 같은 레코드에 대해
 * 실행할 때마다 다른 답을 낸다 — 감사에서 최악의 실패 방식이다.
 *
 * 🔴 이미 중복이 있으면 인덱스 생성이 실패한다. 그때는 **조용히 넘어가지 않는다.**
 *    중복을 그대로 두는 것보다 나쁜 건, 중복이 있다는 사실을 모르는 것이다.
 *    (부팅은 막지 않는다 — 여기서 죽이면 기존 배포가 통째로 못 뜬다.
 *     대신 무엇이 중복인지 로그로 정확히 말한다.)
 */
function enforceChainUniqueness(database: Database.Database): void {
  try {
    database.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_events_chain_position ' +
        'ON decision_events(tenant_id, chain_domain, chain_index)',
    );
  } catch (err) {
    const duplicates = database
      .prepare(
        `SELECT tenant_id, chain_domain, chain_index, COUNT(*) as count
         FROM decision_events
         GROUP BY tenant_id, chain_domain, chain_index
         HAVING count > 1
         ORDER BY count DESC
         LIMIT 20`,
      )
      .all() as { tenant_id: string; chain_domain: string; chain_index: number; count: number }[];

    console.error('');
    console.error('🔴 CHAIN INTEGRITY: could not enforce unique chain positions.');
    console.error(`   ${(err as Error).message}`);
    console.error(`   ${duplicates.length} duplicated chain position(s) found (showing up to 20):`);
    for (const d of duplicates) {
      console.error(`   - tenant=${d.tenant_id} domain=${d.chain_domain} index=${d.chain_index} count=${d.count}`);
    }
    console.error('   Verification results for these records are non-deterministic until resolved.');
    console.error('');
  }
}
