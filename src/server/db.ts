import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

/**
 * The market's whole state. There is no work content here: missions carry fingerprints,
 * and the relay table only holds ciphertext, erased once fetched or after a few days.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  sign_public TEXT NOT NULL,
  box_public TEXT NOT NULL,
  credits INTEGER NOT NULL DEFAULT 0,
  reputation REAL NOT NULL DEFAULT 1.0,
  batches_passed INTEGER NOT NULL DEFAULT 0,
  batches_failed INTEGER NOT NULL DEFAULT 0,
  missions_solved INTEGER NOT NULL DEFAULT 0,
  model TEXT, -- declared by the agent, unverified; compared with peers of the same model
  system INTEGER NOT NULL DEFAULT 0, -- 1: one-off requester of a control mission, played by the server
  created_at TEXT NOT NULL
);
-- Micro-tasks of the operator's bank: the only source of new credits.
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  instruction TEXT NOT NULL,
  input TEXT NOT NULL,
  options TEXT NOT NULL,
  gold TEXT
);
CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL, -- awaiting_work | passed | failed | cancelled | expired
  credits_earned INTEGER NOT NULL DEFAULT 0,
  approx_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS assignments (
  batch_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  expected TEXT, -- set when the task is a control in this batch
  PRIMARY KEY (batch_id, task_id)
);
CREATE TABLE IF NOT EXISTS answers (
  batch_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  answer TEXT NOT NULL,
  accepted INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (batch_id, task_id)
);
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  price_credits INTEGER NOT NULL,
  spec_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  solver_id TEXT,
  taken_at TEXT,
  spec_sent_at TEXT,
  delivery_hash TEXT,
  delivery_mime TEXT,
  delivered_at TEXT,
  contest_reason TEXT,
  verdict TEXT,
  verdict_at TEXT,
  outcome_reason TEXT,
  honeypot_id TEXT,
  solver_bond INTEGER NOT NULL DEFAULT 0, -- locked by the solver at take, returned on delivery
  requester_deposit INTEGER NOT NULL DEFAULT 0, -- mediation fees locked by the requester when contesting or appealing
  solver_deposit INTEGER NOT NULL DEFAULT 0, -- mediation fees locked by the solver when appealing
  min_level INTEGER NOT NULL DEFAULT 0, -- certification level required to take it
  target_id TEXT, -- control missions: the only agent that sees it
  control_id TEXT, -- control missions: row in controls
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE TABLE IF NOT EXISTS mediations (
  mission_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  mediator_id TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  verdict TEXT, -- accept | refuse | expired | NULL (pending)
  justification TEXT,
  voted_at TEXT,
  paid INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (mission_id, mediator_id)
);
-- Relay: ciphertext only. envelope is set to NULL once fetched or expired; the row stays as proof of sending.
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  envelope TEXT,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  fetched_at TEXT
);
-- Fake disputes with a known verdict, used to check mediators. Operator-provided, like gold tasks.
CREATE TABLE IF NOT EXISTS honeypots (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  spec TEXT NOT NULL,
  acceptance TEXT NOT NULL,
  delivery_mime TEXT NOT NULL,
  delivery_content TEXT NOT NULL,
  contest_reason TEXT NOT NULL,
  verdict TEXT NOT NULL
);
-- Certification (see src/server/certification). Controls are Troqo's own generated content.
CREATE TABLE IF NOT EXISTS controls (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  agent_id TEXT NOT NULL, -- the agent being checked
  kind TEXT NOT NULL,
  purpose TEXT NOT NULL, -- exam | check | conformity
  generator TEXT NOT NULL,
  difficulty INTEGER NOT NULL,
  group_id TEXT,
  spec TEXT NOT NULL,
  acceptance TEXT NOT NULL,
  expected TEXT NOT NULL, -- JSON, never sent to anyone
  requester_id TEXT NOT NULL, -- one-off identity posting the control
  box_public TEXT NOT NULL,
  box_private TEXT NOT NULL, -- lets the server read deliveries to its own controls
  delivery TEXT, -- conformity answers only, erased once ranked
  result TEXT, -- pass | fail
  policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  graded_at TEXT
);
CREATE TABLE IF NOT EXISTS certifications (
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  level INTEGER NOT NULL,
  policy_version TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  streak INTEGER NOT NULL DEFAULT 0,
  controls_passed INTEGER NOT NULL DEFAULT 0,
  controls_failed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, kind)
);
CREATE TABLE IF NOT EXISTS conformity_groups (
  id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  kind TEXT NOT NULL,
  generator TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  spec TEXT NOT NULL,
  acceptance TEXT NOT NULL,
  status TEXT NOT NULL, -- filling | ranking | done
  policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ranking_at TEXT
);
CREATE TABLE IF NOT EXISTS rankings (
  group_id TEXT NOT NULL,
  ranker_id TEXT NOT NULL,
  labels TEXT NOT NULL, -- {"A": controlId, ...}, shuffled per ranker
  ranking TEXT, -- ["B", "A", "C"], best first
  justification TEXT,
  assigned_at TEXT NOT NULL,
  ranked_at TEXT,
  PRIMARY KEY (group_id, ranker_id)
);
CREATE TABLE IF NOT EXISTS conformity_scores (
  group_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  model TEXT NOT NULL,
  score REAL NOT NULL, -- 1: ranked first by everyone, 0: last
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, agent_id)
);
-- Credit creation and destruction, to follow the economy.
CREATE TABLE IF NOT EXISTS supply (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reason TEXT NOT NULL, -- work | honeypot | mediation | control | burn
  credits INTEGER NOT NULL, -- positive: created, negative: destroyed
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_created ON agents(created_at);
CREATE INDEX IF NOT EXISTS idx_controls_agent ON controls(agent_id, kind, purpose);
CREATE INDEX IF NOT EXISTS idx_controls_mission ON controls(mission_id);
CREATE INDEX IF NOT EXISTS idx_supply_time ON supply(reason, created_at);
CREATE INDEX IF NOT EXISTS idx_answers_task ON answers(task_id);
CREATE INDEX IF NOT EXISTS idx_batches_agent ON batches(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status, kind);
CREATE INDEX IF NOT EXISTS idx_mediations_mediator ON mediations(mediator_id, verdict);
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_id, fetched_at);
CREATE INDEX IF NOT EXISTS idx_messages_mission ON messages(mission_id, kind, from_id, to_id);
`;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  // Columns added after v0.3.0, for databases created before.
  const add = (table: string, columns: Record<string, string>) => {
    const cols = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
    for (const [c, type] of Object.entries(columns)) if (!cols.has(c)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${c} ${type}`);
  };
  add("missions", {
    solver_bond: "INTEGER NOT NULL DEFAULT 0",
    requester_deposit: "INTEGER NOT NULL DEFAULT 0",
    solver_deposit: "INTEGER NOT NULL DEFAULT 0",
    min_level: "INTEGER NOT NULL DEFAULT 0",
    target_id: "TEXT",
    control_id: "TEXT",
  });
  add("agents", { model: "TEXT", system: "INTEGER NOT NULL DEFAULT 0" });
  return db;
}

/** Runs fn inside a transaction, rolling back on error. Not reentrant. */
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
