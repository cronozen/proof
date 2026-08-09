/**
 * Cronozen Proof API — SQLite Schema (MVP)
 *
 * 프로덕션에서는 PostgreSQL로 전환.
 * MVP에서는 SQLite로 빠르게 검증.
 */

export const SCHEMA_SQL = `
-- 의사결정 이벤트
CREATE TABLE IF NOT EXISTS decision_events (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'recorded',

  -- Actor
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL DEFAULT 'human',
  actor_name TEXT,
  actor_metadata TEXT, -- JSON

  -- Source (4-layer architecture: ai | harness | manual | system)
  source_type TEXT NOT NULL DEFAULT 'manual',

  -- Action
  action_type TEXT NOT NULL,
  action_description TEXT,
  action_input TEXT, -- JSON
  action_output TEXT, -- JSON
  action_metadata TEXT, -- JSON

  -- AI Context
  ai_model TEXT,
  ai_provider TEXT,
  ai_confidence REAL,
  ai_prompt_hash TEXT,
  ai_reasoning TEXT,
  ai_tokens_input INTEGER,
  ai_tokens_output INTEGER,
  ai_metadata TEXT, -- JSON

  -- Evidence & Chain
  evidence_id TEXT,
  evidence_level TEXT DEFAULT 'DRAFT',
  chain_hash TEXT,
  chain_index INTEGER,
  previous_hash TEXT,
  chain_domain TEXT DEFAULT 'default',

  -- 체인 페이로드 버전 — 이 행의 chain_hash가 어떤 필드 집합으로 계산됐는지.
  -- NULL/2 = 레거시(type·action_type·actor_id 3개만 덮음), 3 = 전체 레코드.
  -- 검증기는 이 값으로 빌더를 고른다. 버전 없이 필드를 바꾸면 옛 행이 전부 실패한다.
  chain_payload_version INTEGER,

  -- 봉인 해시 — 승인은 레코드 생성 이후에 일어나므로 chain_hash가 덮지 못한다.
  -- 이 값이 승인자·승인결과·봉인시각을 chain_hash에 묶는다.
  seal_hash TEXT,

  -- 서버 서명 (Ed25519) — DB 쓰기 권한만으로는 위조할 수 없게 한다.
  signature TEXT,
  signature_alg TEXT,
  signature_key_id TEXT,

  -- 이 레코드가 type='seal' 일 때, 어느 결정을 봉인하는가.
  -- 🔑 조회용 인덱스일 뿐이고 **권위는 해시된 action_output.targetDecisionId** 다.
  --    이 컬럼을 고쳐도 해시가 안 맞으므로 봉인 레코드 자체의 검증이 깨진다.
  seals_decision_id TEXT,

  -- Approval
  approver_id TEXT,
  approver_type TEXT,
  approver_name TEXT,
  approval_result TEXT,
  approval_reason TEXT,
  approved_at TEXT,

  -- Metadata
  occurred_at TEXT NOT NULL,
  tags TEXT, -- JSON array
  metadata TEXT, -- JSON
  idempotency_key TEXT UNIQUE,
  sealed_at TEXT,

  -- Tenant
  tenant_id TEXT NOT NULL DEFAULT 'default',
  api_key_id TEXT,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_decision_events_tenant ON decision_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_decision_events_type ON decision_events(type);
CREATE INDEX IF NOT EXISTS idx_decision_events_source ON decision_events(source_type);
CREATE INDEX IF NOT EXISTS idx_decision_events_status ON decision_events(status);
CREATE INDEX IF NOT EXISTS idx_decision_events_chain ON decision_events(chain_domain, chain_index);
CREATE INDEX IF NOT EXISTS idx_decision_events_idempotency ON decision_events(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_decision_events_seals ON decision_events(seals_decision_id);

-- 체인 앵커 — 특정 시점의 체인 머리를 박제한다
--
-- 🔑 왜 필요한가: DB 안의 어떤 값으로도 "무엇이 있었는지"는 알 수 없다.
--    꼬리를 지우면 남은 체인은 인덱스가 연속이고 링크도 맞아 정상으로 보인다.
--    앵커는 "T 시점에 머리가 여기였다"를 밖에 박아, 그 뒤로 짧아진 것을 드러낸다.
--
-- 🔴 이 표가 우리 DB 안에 있는 한, DB 를 쓸 수 있는 자는 앵커도 같이 지울 수 있다.
--    그래서 이 표는 **탐지 절차**를 세우는 자리이고, 앵커 자체를 위조 불가로 만드는 것은
--    외부 제공자(OTS 등)의 몫이다. provider/receipt 가 그 자리다.
CREATE TABLE IF NOT EXISTS chain_anchors (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,

  tree_version TEXT NOT NULL,        -- 'anchor-v1'
  merkle_root TEXT NOT NULL,
  prev_root TEXT,                    -- 직전 앵커의 root. 앵커 기록 자체의 절단을 막는다.
  leaf_count INTEGER NOT NULL,

  anchored_at TEXT NOT NULL,

  -- 외부 증빙. provider='none' 이면 아직 우리 DB 안에만 있는 것이다 — 그렇게 보고한다.
  provider TEXT NOT NULL DEFAULT 'none',
  receipt TEXT,
  confirmed_at TEXT,

  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chain_anchors_tenant ON chain_anchors(tenant_id, anchored_at);

-- 앵커가 덮은 각 체인의 머리
CREATE TABLE IF NOT EXISTS chain_anchor_heads (
  anchor_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  chain_domain TEXT NOT NULL,
  chain_index INTEGER NOT NULL,
  chain_hash TEXT NOT NULL,
  PRIMARY KEY (anchor_id, chain_domain)
);

CREATE INDEX IF NOT EXISTS idx_chain_anchor_heads_lookup
  ON chain_anchor_heads(tenant_id, chain_domain, chain_index);

-- 앵커를 외부 어디에 제출했는가 (제공자별로 한 행)
--
-- 🔴 'submitted' 와 'confirmed' 를 뭉치지 않는다. OTS 는 제출 직후엔 캘린더의 약속일 뿐이고
--    업그레이드를 돌려야 비트코인 증명이 채워진다. 그 둘을 같게 보고하면 false-assurance 다.
CREATE TABLE IF NOT EXISTS anchor_submissions (
  anchor_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,              -- submitted | confirmed | failed
  receipt TEXT,
  external_ref TEXT,
  verify_url TEXT,
  error TEXT,
  submitted_at TEXT NOT NULL,
  confirmed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  last_attempt_at TEXT,
  PRIMARY KEY (anchor_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_anchor_submissions_status ON anchor_submissions(status, submitted_at);

-- 외부 로그와의 대조 결과
--
-- 🔑 우리 DB 안의 앵커가 지워졌는지는 **밖에서 되읽어야** 안다. 이 표가 그 결과를 담는다.
--    이 표 자체도 지워질 수 있지만, 대조 잡이 매 틱 다시 돌아 불일치를 되살린다.
CREATE TABLE IF NOT EXISTS anchor_reconciliation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  checked_at TEXT NOT NULL,
  remote_count INTEGER NOT NULL,
  local_count INTEGER NOT NULL,
  missing_count INTEGER NOT NULL,
  detail TEXT
);

-- 파일 증빙 (업로드형 하네스)
CREATE TABLE IF NOT EXISTS proof_files (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  decision_event_id TEXT,

  -- File metadata
  filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER NOT NULL,
  file_hash TEXT NOT NULL,        -- SHA-256 of file content

  -- Version tracking
  parent_file_id TEXT,            -- 이전 버전의 proof_files.id (null = 최초)
  version_number INTEGER NOT NULL DEFAULT 1,
  diff_summary TEXT,              -- 이전 버전과의 차이 요약 (JSON)

  -- Storage
  storage_path TEXT NOT NULL,     -- 로컬 또는 S3 경로
  storage_type TEXT NOT NULL DEFAULT 'local', -- local | s3

  -- Retention
  expires_at TEXT,                -- 보관 만료일 (null = 무제한)

  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_proof_files_tenant ON proof_files(tenant_id);
CREATE INDEX IF NOT EXISTS idx_proof_files_hash ON proof_files(file_hash, tenant_id);
CREATE INDEX IF NOT EXISTS idx_proof_files_parent ON proof_files(parent_file_id);
CREATE INDEX IF NOT EXISTS idx_proof_files_event ON proof_files(decision_event_id);
CREATE INDEX IF NOT EXISTS idx_proof_files_expires ON proof_files(expires_at);

-- 외부 연동 (Google Drive, OneDrive 등)
CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL,           -- google_drive | onedrive | sharepoint
  status TEXT NOT NULL DEFAULT 'active', -- active | paused | revoked

  -- OAuth tokens (암호화 필요 — MVP에서는 평문)
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at TEXT,

  -- 감시 설정
  watch_folder_id TEXT,             -- Drive 폴더 ID
  watch_folder_name TEXT,           -- 표시용 이름
  watch_channel_id TEXT,            -- Drive push notification channel
  watch_resource_id TEXT,           -- Drive resource ID (webhook 해제용)
  watch_expires_at TEXT,            -- Channel 만료 (최대 24시간, 자동 갱신)
  page_token TEXT,                  -- Drive Changes API start page token

  -- 매핑
  chain_domain TEXT NOT NULL DEFAULT 'default', -- DPU 이벤트를 기록할 도메인

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_integrations_tenant ON integrations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_integrations_channel ON integrations(watch_channel_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_integrations_provider ON integrations(tenant_id, provider, watch_folder_id);

-- API 키
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  name TEXT,
  permissions TEXT NOT NULL DEFAULT '["read","write"]', -- JSON array
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id);
`;
