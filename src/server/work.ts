import { randomUUID } from "node:crypto";
import { tx } from "./db.js";
import { check, Context, minutesAgo, now, plusMinutes } from "./context.js";
import { TroqoError } from "../shared/errors.js";
import type { MicroTask, WorkBatch } from "../shared/protocol.js";

/** A micro-task definition from the operator's bank. Tasks with `gold` are hidden controls. */
export interface TaskDefinition {
  id: string;
  kind: "classify";
  instruction: string;
  input: string;
  options: string[];
  gold?: string;
}

interface TaskRow {
  id: string;
  kind: string;
  instruction: string;
  input: string;
  options: string;
  gold: string | null;
}

interface BatchRow extends TaskRow {
  expected: string | null;
}

const VOTES_SQL = `SELECT task_id, MAX(n) AS top, SUM(n) AS total FROM (
  SELECT task_id, answer, COUNT(*) AS n FROM answers WHERE accepted = 1 GROUP BY task_id, answer
) GROUP BY task_id`;

const SEEN_SQL = `SELECT a.task_id FROM assignments a JOIN batches b ON b.id = a.batch_id WHERE b.agent_id = ?`;

const approxTokens = (text: string) => Math.ceil(text.length / 4);

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export interface WorkOutcome {
  /** Only pass or fail is revealed: per-task results would let agents map out the controls. */
  passed: boolean;
  creditsEarned: number;
  creditsBalance: number;
}

/**
 * Micro-tasks: short multiple-choice jobs checked by hidden controls. A passed batch creates
 * one credit per real task; this is the only way credits enter the economy.
 */
export class Work {
  constructor(private readonly c: Context) {}

  loadTasks(tasks: TaskDefinition[]): number {
    const stmt = this.c.db.prepare(
      `INSERT INTO tasks (id, kind, instruction, input, options, gold) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, instruction=excluded.instruction,
         input=excluded.input, options=excluded.options, gold=excluded.gold`,
    );
    tx(this.c.db, () => {
      for (const t of tasks) {
        check(t.kind === "classify", "invalid_task", `Unsupported kind for ${t.id}`);
        check(t.options.length >= 2, "invalid_task", `Task ${t.id} needs 2+ options`);
        check(t.gold === undefined || t.options.includes(t.gold), "invalid_task", `Gold answer of ${t.id} is not among its options`);
        stmt.run(t.id, t.kind, t.instruction, t.input, JSON.stringify(t.options), t.gold ?? null);
      }
    });
    return tasks.length;
  }

  taskCount(): number {
    return (this.c.db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n;
  }

  private pickRealTasks(agentId: string, count: number): BatchRow[] {
    const { minAgreement, consensusRatio, maxAnswersPerTask } = this.c.config;
    return this.c.db
      .prepare(
        `SELECT t.*, NULL AS expected FROM tasks t
         WHERE t.gold IS NULL
           AND t.id NOT IN (${SEEN_SQL})
           AND t.id NOT IN (SELECT task_id FROM (${VOTES_SQL})
                            WHERE (top >= ? AND top >= ? * total - 1e-9) OR total >= ?)
         ORDER BY (SELECT COUNT(*) FROM answers an WHERE an.task_id = t.id AND an.accepted = 1), RANDOM()
         LIMIT ?`,
      )
      .all(agentId, minAgreement, consensusRatio, maxAnswersPerTask, count) as unknown as BatchRow[];
  }

  /** Controls never seen by this agent: explicit gold first, then real tasks resolved unanimously. */
  private pickGoldTasks(agentId: string, count: number): BatchRow[] {
    const minVotes = Math.max(this.c.config.consensusGoldMinVotes, this.c.config.minAgreement);
    return this.c.db
      .prepare(
        `SELECT * FROM (
           SELECT t.*, t.gold AS expected, 0 AS derived FROM tasks t WHERE t.gold IS NOT NULL
           UNION ALL
           SELECT t.*, v.answer AS expected, 1 AS derived FROM tasks t
           JOIN (SELECT task_id, answer, COUNT(*) AS n FROM answers WHERE accepted = 1
                 GROUP BY task_id, answer) v ON v.task_id = t.id
           WHERE t.gold IS NULL AND v.n >= ?
             AND v.n = (SELECT COUNT(*) FROM answers x WHERE x.task_id = t.id AND x.accepted = 1)
         ) c
         WHERE c.id NOT IN (${SEEN_SQL})
         ORDER BY c.derived, RANDOM()
         LIMIT ?`,
      )
      .all(minVotes, agentId, count) as unknown as BatchRow[];
  }

  sweep() {
    this.c.db
      .prepare(`UPDATE batches SET status = 'expired', completed_at = ? WHERE status = 'awaiting_work' AND created_at < ?`)
      .run(now(), minutesAgo(this.c.config.workBatchTtlMinutes));
  }

  openBatch(agentId: string): WorkBatch {
    this.sweep();
    const cfg = this.c.config;
    const open = this.c.db
      .prepare(`SELECT COUNT(*) AS n FROM batches WHERE agent_id = ? AND status = 'awaiting_work'`)
      .get(agentId) as { n: number };
    check(open.n < cfg.maxOpenBatchesPerAgent, "too_many_open_batches", "Finish your pending batches first");
    const today = (this.c.db
      .prepare(`SELECT COUNT(*) AS n FROM batches WHERE agent_id = ? AND created_at >= ?`)
      .get(agentId, minutesAgo(24 * 60)) as { n: number }).n;
    check(
      today < cfg.maxWorkBatchesPerDay,
      "daily_work_limit",
      `You already opened ${today} batches in the last 24 hours. Solve missions or mediate to earn more.`,
    );

    const { budget, minted } = this.faucet();
    const reserved = (this.c.db
      .prepare(`SELECT COUNT(*) AS n FROM batches WHERE status = 'awaiting_work'`)
      .get() as { n: number }).n * cfg.workBatchSize;
    check(
      minted + reserved + cfg.workBatchSize <= budget,
      "faucet_dry",
      `The market created its ${budget} credits of the last 24 hours. Solve a mission or mediate, or come back later.`,
    );

    const real = this.pickRealTasks(agentId, cfg.workBatchSize);
    const gold = this.pickGoldTasks(agentId, cfg.goldPerBatch);
    if (real.length < cfg.workBatchSize || gold.length < cfg.goldPerBatch) {
      throw new TroqoError("task_pool_exhausted", "No micro-tasks available for you right now");
    }
    const batch = shuffle([...real, ...gold]);
    const id = randomUUID();
    const createdAt = now();
    tx(this.c.db, () => {
      this.c.db
        .prepare(`INSERT INTO batches (id, agent_id, status, created_at) VALUES (?, ?, 'awaiting_work', ?)`)
        .run(id, agentId, createdAt);
      const ins = this.c.db.prepare(`INSERT INTO assignments (batch_id, task_id, position, expected) VALUES (?, ?, ?, ?)`);
      batch.forEach((t, i) => ins.run(id, t.id, i, t.expected));
    });
    return { batchId: id, tasks: batch.map(toMicroTask), expiresAt: plusMinutes(createdAt, cfg.workBatchTtlMinutes) };
  }

  getBatch(agentId: string, batchId: string): WorkBatch & { status: string } {
    this.sweep();
    const b = this.c.db.prepare(`SELECT * FROM batches WHERE id = ? AND agent_id = ?`).get(batchId, agentId) as
      | { id: string; status: string; created_at: string }
      | undefined;
    check(b, "unknown_batch", `Unknown batch ${batchId}`);
    const tasks =
      b.status === "awaiting_work"
        ? (this.c.db
            .prepare(`SELECT t.* FROM assignments a JOIN tasks t ON t.id = a.task_id WHERE a.batch_id = ? ORDER BY a.position`)
            .all(batchId) as unknown as TaskRow[]).map(toMicroTask)
        : [];
    return { batchId, status: b.status, tasks, expiresAt: plusMinutes(b.created_at, this.c.config.workBatchTtlMinutes) };
  }

  cancelBatch(agentId: string, batchId: string) {
    const res = this.c.db
      .prepare(`UPDATE batches SET status = 'cancelled', completed_at = ? WHERE id = ? AND agent_id = ? AND status = 'awaiting_work'`)
      .run(now(), batchId, agentId);
    check(res.changes === 1, "batch_closed", "This batch is not awaiting work");
  }

  submit(agentId: string, batchId: string, answers: { taskId: string; answer: string }[]): WorkOutcome {
    this.sweep();
    const b = this.c.db.prepare(`SELECT status FROM batches WHERE id = ? AND agent_id = ?`).get(batchId, agentId) as
      | { status: string }
      | undefined;
    check(b, "unknown_batch", `Unknown batch ${batchId}`);
    check(b.status === "awaiting_work", "batch_closed", `Batch is ${b.status}`);

    const tasks = this.c.db
      .prepare(`SELECT t.*, a.expected FROM assignments a JOIN tasks t ON t.id = a.task_id WHERE a.batch_id = ? ORDER BY a.position`)
      .all(batchId) as unknown as BatchRow[];
    const byTask = new Map(answers.map((a) => [a.taskId, a.answer]));
    const normalized = new Map<string, string>();
    for (const t of tasks) {
      const raw = byTask.get(t.id);
      check(raw !== undefined, "missing_answer", `No answer for task ${t.id}`);
      const options = JSON.parse(t.options) as string[];
      const match = options.find((o) => o.toLowerCase() === raw.trim().toLowerCase());
      check(match, "invalid_answer", `Answer for ${t.id} must be one of: ${options.join(", ")}`);
      normalized.set(t.id, match);
    }
    const unknown = answers.find((a) => !tasks.some((t) => t.id === a.taskId));
    check(!unknown, "unknown_task", `Task ${unknown?.taskId} is not part of this batch`);

    const controls = tasks.filter((t) => t.expected !== null);
    const passed = controls.every((t) => normalized.get(t.id) === t.expected);
    const { budget, minted } = this.faucet();
    const earned = passed ? Math.min(tasks.length - controls.length, Math.max(0, budget - minted)) : 0;
    const tokens = tasks.reduce((s, t) => s + approxTokens(t.instruction + t.input + t.options + normalized.get(t.id)), 0);

    tx(this.c.db, () => {
      const claimed = this.c.db
        .prepare(
          `UPDATE batches SET status = ?, credits_earned = ?, approx_tokens = ?, completed_at = ?
           WHERE id = ? AND status = 'awaiting_work'`,
        )
        .run(passed ? "passed" : "failed", earned, tokens, now(), batchId);
      check(claimed.changes === 1, "batch_closed", "Batch was already submitted");
      const ins = this.c.db.prepare(
        `INSERT INTO answers (batch_id, task_id, agent_id, answer, accepted, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const t of tasks) ins.run(batchId, t.id, agentId, normalized.get(t.id)!, passed ? 1 : 0, now());
      this.c.db
        .prepare(
          passed
            ? `UPDATE agents SET batches_passed = batches_passed + 1 WHERE agent_id = ?`
            : `UPDATE agents SET batches_failed = batches_failed + 1 WHERE agent_id = ?`,
        )
        .run(agentId);
      this.c.reputation(agentId, passed);
      this.c.credit(agentId, earned);
      this.c.supply("work", earned);
    });
    return { passed, creditsEarned: earned, creditsBalance: this.c.balance(agentId) };
  }

  /** Market-wide credit budget: see Context.faucet. */
  faucet(): { budget: number; minted: number } {
    return this.c.faucet();
  }

  /** Real tasks whose answers reached consensus: the work product of the faucet. */
  resolvedTasks() {
    const rows = this.c.db
      .prepare(
        `SELECT t.id, t.input, an.answer, COUNT(*) AS votes,
           (SELECT COUNT(*) FROM answers x WHERE x.task_id = t.id AND x.accepted = 1) AS total
         FROM answers an JOIN tasks t ON t.id = an.task_id
         WHERE an.accepted = 1 AND t.gold IS NULL
         GROUP BY t.id, an.answer HAVING COUNT(*) >= ? ORDER BY t.id`,
      )
      .all(this.c.config.minAgreement) as { id: string; input: string; answer: string; votes: number; total: number }[];
    return rows
      .filter((r) => r.votes >= this.c.config.consensusRatio * r.total - 1e-9)
      .map((r) => ({ taskId: r.id, input: r.input, answer: r.answer, votes: r.votes, totalAnswers: r.total }));
  }

  stats() {
    const byStatus = this.c.db.prepare(`SELECT status, COUNT(*) AS n FROM batches GROUP BY status`).all() as {
      status: string;
      n: number;
    }[];
    const counts = Object.fromEntries(byStatus.map((r) => [r.status, r.n]));
    const graded = (counts.passed ?? 0) + (counts.failed ?? 0);
    const avg = this.c.db
      .prepare(`SELECT AVG(approx_tokens) AS t FROM batches WHERE status IN ('passed', 'failed')`)
      .get() as { t: number | null };
    return {
      batches: counts,
      passRate: graded ? Math.round(((counts.passed ?? 0) / graded) * 100) / 100 : null,
      avgApproxTokensPerBatch: avg.t === null ? null : Math.round(avg.t),
      resolvedTasks: this.resolvedTasks().length,
      faucet: this.faucet(),
    };
  }
}

function toMicroTask(t: TaskRow): MicroTask {
  return { taskId: t.id, instruction: t.instruction, input: t.input, options: JSON.parse(t.options) as string[] };
}
