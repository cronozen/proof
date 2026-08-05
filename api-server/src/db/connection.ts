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
  }

  database.exec(SCHEMA_SQL);
}
