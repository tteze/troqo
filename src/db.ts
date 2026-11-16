import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  instruction TEXT NOT NULL,
  input TEXT NOT NULL,
  options TEXT NOT NULL,
  gold TEXT
);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  price_credits INTEGER NOT NULL,
  approx_tokens INTEGER NOT NULL DEFAULT 0,
  result_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS assignments (
  request_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (request_id, task_id)
);
CREATE TABLE IF NOT EXISTS answers (
  request_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  answer TEXT NOT NULL,
  accepted INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (request_id, task_id)
);
CREATE TABLE IF NOT EXISTS ledger (
  agent_id TEXT PRIMARY KEY,
  credits INTEGER NOT NULL DEFAULT 0,
  reputation REAL NOT NULL DEFAULT 1.0,
  batches_passed INTEGER NOT NULL DEFAULT 0,
  batches_failed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS spend (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  cost_usd REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_answers_task ON answers(task_id);
CREATE INDEX IF NOT EXISTS idx_requests_agent ON requests(agent_id, status);
`;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

/** Runs fn inside a transaction, rolling back on error. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
