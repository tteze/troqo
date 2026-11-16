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
  -- Expected answer when the task is a control in this batch (explicit gold or consensus), else NULL.
  expected TEXT,
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
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  spec TEXT NOT NULL,
  acceptance TEXT NOT NULL,
  price_credits INTEGER NOT NULL,
  -- open | taken | delivered | disputed | mediated | appealed | accepted | refused | cancelled
  status TEXT NOT NULL,
  solver_id TEXT,
  taken_at TEXT,
  -- Transient: erased when the mission closes. Troqo keeps no work content.
  delivery TEXT,
  delivered_at TEXT,
  contest_reason TEXT,
  -- Verdict of the first mediation, final unless appealed.
  verdict TEXT,
  verdict_at TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE TABLE IF NOT EXISTS mediations (
  mission_id TEXT NOT NULL,
  -- 1 = first mediation, 2 = appeal
  round INTEGER NOT NULL,
  mediator_id TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  -- accept | refuse | expired (did not vote in time) | NULL (pending)
  verdict TEXT,
  justification TEXT,
  voted_at TEXT,
  paid INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (mission_id, mediator_id)
);
CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status, kind);
CREATE INDEX IF NOT EXISTS idx_mediations_mediator ON mediations(mediator_id, verdict);
CREATE INDEX IF NOT EXISTS idx_answers_task ON answers(task_id);
CREATE INDEX IF NOT EXISTS idx_requests_agent ON requests(agent_id, status);
`;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Upgrades databases created by earlier versions. */
function migrate(db: Db) {
  const cols = db.prepare("PRAGMA table_info(assignments)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "expected")) {
    db.exec("ALTER TABLE assignments ADD COLUMN expected TEXT");
    db.exec("UPDATE assignments SET expected = (SELECT gold FROM tasks WHERE tasks.id = assignments.task_id)");
  }
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
