-- Users who have ever DM'd the bot (for broadcasts)
CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY,
  can_dm INTEGER NOT NULL DEFAULT 1,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  support_blocked INTEGER NOT NULL DEFAULT 0
);

-- Membership status (global membership, applies to all managed chats)
CREATE TABLE IF NOT EXISTS memberships (
  user_id INTEGER PRIMARY KEY,
  verified_at INTEGER NOT NULL,
  expire_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- Expired members snapshot
CREATE TABLE IF NOT EXISTS expired_users (
  user_id INTEGER PRIMARY KEY,
  expired_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- One-time card keys
CREATE TABLE IF NOT EXISTS codes (
  code TEXT PRIMARY KEY,
  days INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('unused','used','revoked')) DEFAULT 'unused',
  created_at INTEGER NOT NULL,
  created_by INTEGER,
  bound_chat_id INTEGER,
  used_by INTEGER,
  used_at INTEGER
);

-- Managed chats (only these chats/channels are enforced)
CREATE TABLE IF NOT EXISTS managed_chats (
  chat_id INTEGER PRIMARY KEY,
  chat_type TEXT NOT NULL CHECK(chat_type IN ('group','channel')),
  title TEXT,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- Track which users were approved by the bot into which managed chats
CREATE TABLE IF NOT EXISTS user_chats (
  user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  approved_at INTEGER NOT NULL,
  removed_at INTEGER,
  PRIMARY KEY (user_id, chat_id),
  FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY(chat_id) REFERENCES managed_chats(chat_id) ON DELETE CASCADE
);

-- Join request audit logs
CREATE TABLE IF NOT EXISTS join_request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  invite_name TEXT NOT NULL,
  invite_link TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY(chat_id) REFERENCES managed_chats(chat_id) ON DELETE CASCADE
);

-- Message templates (HTML parse mode by default)
-- buttons_json is a 2D array of rows: [[{text,type,url,data}], ...]
CREATE TABLE IF NOT EXISTS templates (
  key TEXT PRIMARY KEY,
  title TEXT,
  parse_mode TEXT NOT NULL DEFAULT 'HTML',
  disable_preview INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  buttons_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);

-- Automated reminder rules
-- kind: exp_before / exp_after / nonmember_monthly
-- offset_days: for exp_before/after; for monthly use 30
CREATE TABLE IF NOT EXISTS auto_rules (
  rule_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('exp_before','exp_after','nonmember_monthly')),
  offset_days INTEGER NOT NULL,
  template_key TEXT NOT NULL,
  is_enabled INTEGER NOT NULL DEFAULT 1
);

-- Track last send per user per rule
CREATE TABLE IF NOT EXISTS rule_sends (
  user_id INTEGER NOT NULL,
  rule_key TEXT NOT NULL,
  last_sent_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, rule_key)
);

-- Broadcast jobs (manual)
CREATE TABLE IF NOT EXISTS broadcast_jobs (
  job_id TEXT PRIMARY KEY,
  audience TEXT NOT NULL CHECK(audience IN ('all','member','nonmember')),
  template_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('pending','sending','done')) DEFAULT 'pending',
  total INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 0,
  fail INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS broadcast_logs (
  job_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ok','fail')),
  error_code INTEGER,
  error_msg TEXT,
  sent_at INTEGER NOT NULL
);

-- Customer support session state (persistent; spam counters live in KV)
CREATE TABLE IF NOT EXISTS support_sessions (
  user_id INTEGER PRIMARY KEY,
  is_open INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- Image host configuration
CREATE TABLE IF NOT EXISTS image_hosts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  base_url TEXT NOT NULL UNIQUE,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  fail_count INTEGER NOT NULL DEFAULT 0,
  is_faulty INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Simple settings store
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
