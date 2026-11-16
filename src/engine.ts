import { randomUUID } from "node:crypto";
import { openDb, tx, type Db } from "./db.js";
import type {
  AssignedTask,
  CapabilityProvider,
  RequestStatus,
  RequestView,
  TaskAnswer,
  TaskDefinition,
} from "./types.js";

export interface TroqoConfig {
  /** SQLite file path, or ":memory:". */
  dbPath: string;
  /** Number of control tasks (known answer) hidden in each batch. */
  goldPerBatch: number;
  /** Share of control tasks an agent must get right for the batch to be accepted (0–1). */
  goldPassRatio: number;
  /** Number of agreeing accepted answers needed to consider a task resolved. */
  minAgreement: number;
  /** Max requests awaiting work per agent, to prevent hoarding tasks. */
  maxOpenRequestsPerAgent: number;
  /** Hard cap on real money spent at capability providers, in USD. */
  maxSpendUsd: number;
}

export const DEFAULT_CONFIG: TroqoConfig = {
  dbPath: "troqo.db",
  goldPerBatch: 1,
  goldPassRatio: 1,
  minAgreement: 2,
  maxOpenRequestsPerAgent: 3,
  maxSpendUsd: 5,
};

export class TroqoError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface SubmitOutcome {
  status: RequestStatus;
  goldCorrect: number;
  goldTotal: number;
  creditsEarned: number;
  creditsBalance: number;
  result?: { resultId: string; mimeType: string; data: string };
  error?: string;
}

interface TaskRow {
  id: string;
  kind: string;
  instruction: string;
  input: string;
  options: string;
  gold: string | null;
}

interface RequestRow {
  id: string;
  agent_id: string;
  capability: string;
  prompt: string;
  status: RequestStatus;
  price_credits: number;
  result_id: string | null;
  error: string | null;
  created_at: string;
}

const now = () => new Date().toISOString();
const approxTokens = (text: string) => Math.ceil(text.length / 4);

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function toAssigned(row: TaskRow): AssignedTask {
  return {
    taskId: row.id,
    kind: row.kind as AssignedTask["kind"],
    instruction: row.instruction,
    input: row.input,
    options: JSON.parse(row.options) as string[],
  };
}

export class Troqo {
  readonly db: Db;
  readonly config: TroqoConfig;
  private readonly providers = new Map<string, CapabilityProvider>();

  constructor(config: Partial<TroqoConfig> = {}, providers: CapabilityProvider[] = []) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.db = openDb(this.config.dbPath);
    for (const p of providers) this.providers.set(p.id, p);
  }

  // ---------------------------------------------------------------- tasks

  /** Loads (or updates) task definitions. Gold answers must be one of the options. */
  loadTasks(tasks: TaskDefinition[]): number {
    const stmt = this.db.prepare(
      `INSERT INTO tasks (id, kind, instruction, input, options, gold) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, instruction=excluded.instruction,
         input=excluded.input, options=excluded.options, gold=excluded.gold`,
    );
    tx(this.db, () => {
      for (const t of tasks) {
        if (t.kind !== "classify") throw new TroqoError("invalid_task", `Unsupported kind for ${t.id}`);
        if (t.options.length < 2) throw new TroqoError("invalid_task", `Task ${t.id} needs 2+ options`);
        if (t.gold !== undefined && !t.options.includes(t.gold)) {
          throw new TroqoError("invalid_task", `Gold answer of ${t.id} is not among its options`);
        }
        stmt.run(t.id, t.kind, t.instruction, t.input, JSON.stringify(t.options), t.gold ?? null);
      }
    });
    return tasks.length;
  }

  /**
   * Real tasks this agent has never seen, least-answered first, skipping tasks already resolved.
   */
  private pickRealTasks(agentId: string, count: number): TaskRow[] {
    return this.db
      .prepare(
        `SELECT t.* FROM tasks t
         WHERE t.gold IS NULL
           AND t.id NOT IN (SELECT a.task_id FROM assignments a JOIN requests r ON r.id = a.request_id
                            WHERE r.agent_id = ?)
           AND t.id NOT IN (SELECT task_id FROM answers WHERE accepted = 1
                            GROUP BY task_id, answer HAVING COUNT(*) >= ?)
         ORDER BY (SELECT COUNT(*) FROM answers an WHERE an.task_id = t.id AND an.accepted = 1), RANDOM()
         LIMIT ?`,
      )
      .all(agentId, this.config.minAgreement, count) as unknown as TaskRow[];
  }

  /** Control tasks, preferring ones this agent has not seen yet. */
  private pickGoldTasks(agentId: string, count: number): TaskRow[] {
    return this.db
      .prepare(
        `SELECT t.* FROM tasks t
         WHERE t.gold IS NOT NULL
         ORDER BY (t.id IN (SELECT a.task_id FROM assignments a JOIN requests r ON r.id = a.request_id
                            WHERE r.agent_id = ?)), RANDOM()
         LIMIT ?`,
      )
      .all(agentId, count) as unknown as TaskRow[];
  }

  // ---------------------------------------------------------------- capabilities

  listCapabilities() {
    return [...this.providers.values()].map((p) => ({
      id: p.id,
      description: p.description,
      priceCredits: p.priceCredits,
      tasksPerRequest: p.priceCredits + this.config.goldPerBatch,
    }));
  }

  private provider(id: string): CapabilityProvider {
    const p = this.providers.get(id);
    if (!p) throw new TroqoError("unknown_capability", `Unknown capability "${id}"`);
    return p;
  }

  /**
   * Opens a request. If the agent already holds enough credits it is executed at once;
   * otherwise a batch of micro-tasks (real tasks + hidden control tasks) is returned.
   */
  async requestCapability(
    agentId: string,
    capability: string,
    prompt: string,
  ): Promise<{ request: RequestView; outcome?: SubmitOutcome }> {
    const provider = this.provider(capability);
    if (!prompt.trim()) throw new TroqoError("invalid_prompt", "Prompt is empty");
    if (prompt.length > 2000) throw new TroqoError("invalid_prompt", "Prompt exceeds 2000 characters");
    this.ensureAgent(agentId);

    const requestId = randomUUID();
    const balance = this.balance(agentId);

    if (balance >= provider.priceCredits) {
      this.db
        .prepare(
          `INSERT INTO requests (id, agent_id, capability, prompt, status, price_credits, created_at)
           VALUES (?, ?, ?, ?, 'awaiting_work', ?, ?)`,
        )
        .run(requestId, agentId, capability, prompt, provider.priceCredits, now());
      const outcome = await this.payAndExecute(requestId, agentId, provider, prompt, 0, 0, 0);
      return { request: this.getRequest(agentId, requestId), outcome };
    }

    const open = this.db
      .prepare(`SELECT COUNT(*) AS n FROM requests WHERE agent_id = ? AND status = 'awaiting_work'`)
      .get(agentId) as { n: number };
    if (open.n >= this.config.maxOpenRequestsPerAgent) {
      throw new TroqoError(
        "too_many_open_requests",
        `Finish your ${open.n} pending request(s) before opening a new one`,
      );
    }

    const needed = provider.priceCredits - balance;
    const real = this.pickRealTasks(agentId, needed);
    const gold = this.pickGoldTasks(agentId, this.config.goldPerBatch);
    if (real.length < needed || gold.length < this.config.goldPerBatch) {
      throw new TroqoError("task_pool_exhausted", "Not enough micro-tasks available right now");
    }

    const batch = shuffle([...real, ...gold]);
    tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO requests (id, agent_id, capability, prompt, status, price_credits, created_at)
           VALUES (?, ?, ?, ?, 'awaiting_work', ?, ?)`,
        )
        .run(requestId, agentId, capability, prompt, provider.priceCredits, now());
      const ins = this.db.prepare(`INSERT INTO assignments (request_id, task_id, position) VALUES (?, ?, ?)`);
      batch.forEach((t, i) => ins.run(requestId, t.id, i));
    });

    return { request: this.getRequest(agentId, requestId) };
  }

  /** Grades a batch, credits the agent, then executes the capability if the batch passed. */
  async submitTasks(agentId: string, requestId: string, answers: TaskAnswer[]): Promise<SubmitOutcome> {
    const req = this.requestRow(agentId, requestId);
    if (req.status !== "awaiting_work") {
      throw new TroqoError("request_closed", `Request is already ${req.status}`);
    }
    const provider = this.provider(req.capability);

    const tasks = this.db
      .prepare(
        `SELECT t.* FROM assignments a JOIN tasks t ON t.id = a.task_id
         WHERE a.request_id = ? ORDER BY a.position`,
      )
      .all(requestId) as unknown as TaskRow[];

    // Validate: one answer per assigned task, each answer among the options (case-insensitive).
    const byTask = new Map(answers.map((a) => [a.taskId, a.answer]));
    const normalized = new Map<string, string>();
    for (const t of tasks) {
      const raw = byTask.get(t.id);
      if (raw === undefined) throw new TroqoError("missing_answer", `No answer for task ${t.id}`);
      const options = JSON.parse(t.options) as string[];
      const match = options.find((o) => o.toLowerCase() === raw.trim().toLowerCase());
      if (!match) {
        throw new TroqoError("invalid_answer", `Answer for ${t.id} must be one of: ${options.join(", ")}`);
      }
      normalized.set(t.id, match);
    }
    const unknown = answers.find((a) => !tasks.some((t) => t.id === a.taskId));
    if (unknown) throw new TroqoError("unknown_task", `Task ${unknown.taskId} is not part of this request`);

    const goldTasks = tasks.filter((t) => t.gold !== null);
    const goldCorrect = goldTasks.filter((t) => normalized.get(t.id) === t.gold).length;
    const passed = goldTasks.length === 0 || goldCorrect / goldTasks.length >= this.config.goldPassRatio;
    const realCount = tasks.length - goldTasks.length;
    const tokens = tasks.reduce(
      (sum, t) => sum + approxTokens(t.instruction + t.input + t.options + (normalized.get(t.id) ?? "")),
      0,
    );

    tx(this.db, () => {
      const ins = this.db.prepare(
        `INSERT INTO answers (request_id, task_id, agent_id, answer, accepted, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const t of tasks) ins.run(requestId, t.id, agentId, normalized.get(t.id)!, passed ? 1 : 0, now());
      this.db.prepare(`UPDATE requests SET approx_tokens = ? WHERE id = ?`).run(tokens, requestId);
      if (!passed) {
        this.db
          .prepare(`UPDATE requests SET status = 'rejected', completed_at = ?, error = ? WHERE id = ?`)
          .run(now(), "Quality check failed", requestId);
        this.db
          .prepare(
            `UPDATE ledger SET batches_failed = batches_failed + 1,
               reputation = MAX(0, reputation * 0.8) WHERE agent_id = ?`,
          )
          .run(agentId);
      } else {
        this.db
          .prepare(
            `UPDATE ledger SET credits = credits + ?, batches_passed = batches_passed + 1,
               reputation = MIN(1, reputation * 0.9 + 0.1) WHERE agent_id = ?`,
          )
          .run(realCount, agentId);
      }
    });

    if (!passed) {
      return {
        status: "rejected",
        goldCorrect,
        goldTotal: goldTasks.length,
        creditsEarned: 0,
        creditsBalance: this.balance(agentId),
        error: "Quality check failed: some control answers were wrong. No credits granted.",
      };
    }
    return this.payAndExecute(requestId, agentId, provider, req.prompt, realCount, goldCorrect, goldTasks.length);
  }

  private async payAndExecute(
    requestId: string,
    agentId: string,
    provider: CapabilityProvider,
    prompt: string,
    creditsEarned: number,
    goldCorrect: number,
    goldTotal: number,
  ): Promise<SubmitOutcome> {
    const base = { goldCorrect, goldTotal, creditsEarned };
    const fail = (error: string): SubmitOutcome => {
      this.db
        .prepare(`UPDATE requests SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`)
        .run(error, now(), requestId);
      return { ...base, status: "failed", creditsBalance: this.balance(agentId), error };
    };

    if (this.balance(agentId) < provider.priceCredits) return fail("Not enough credits");
    if (this.totalSpendUsd() + provider.estimatedCostUsd > this.config.maxSpendUsd) {
      return fail("Spending cap reached on this server; credits kept for later");
    }

    // Debit before calling the provider, refund on failure.
    this.db.prepare(`UPDATE ledger SET credits = credits - ? WHERE agent_id = ?`).run(provider.priceCredits, agentId);
    try {
      const result = await provider.execute(prompt);
      const resultId = randomUUID();
      tx(this.db, () => {
        this.db
          .prepare(`INSERT INTO results (id, request_id, mime_type, data, created_at) VALUES (?, ?, ?, ?, ?)`)
          .run(resultId, requestId, result.mimeType, result.data, now());
        this.db
          .prepare(`INSERT INTO spend (provider, cost_usd, created_at) VALUES (?, ?, ?)`)
          .run(provider.id, result.costUsd, now());
        this.db
          .prepare(`UPDATE requests SET status = 'delivered', result_id = ?, completed_at = ? WHERE id = ?`)
          .run(resultId, now(), requestId);
      });
      return {
        ...base,
        status: "delivered",
        creditsBalance: this.balance(agentId),
        result: { resultId, mimeType: result.mimeType, data: result.data },
      };
    } catch (err) {
      this.db.prepare(`UPDATE ledger SET credits = credits + ? WHERE agent_id = ?`).run(provider.priceCredits, agentId);
      return fail(`Provider error: ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- reads

  private ensureAgent(agentId: string) {
    this.db.prepare(`INSERT OR IGNORE INTO ledger (agent_id) VALUES (?)`).run(agentId);
  }

  balance(agentId: string): number {
    const row = this.db.prepare(`SELECT credits FROM ledger WHERE agent_id = ?`).get(agentId) as
      | { credits: number }
      | undefined;
    return row?.credits ?? 0;
  }

  account(agentId: string) {
    this.ensureAgent(agentId);
    const row = this.db.prepare(`SELECT * FROM ledger WHERE agent_id = ?`).get(agentId) as {
      credits: number;
      reputation: number;
      batches_passed: number;
      batches_failed: number;
    };
    return {
      agentId,
      credits: row.credits,
      reputation: Math.round(row.reputation * 100) / 100,
      batchesPassed: row.batches_passed,
      batchesFailed: row.batches_failed,
    };
  }

  private requestRow(agentId: string, requestId: string): RequestRow {
    const row = this.db.prepare(`SELECT * FROM requests WHERE id = ? AND agent_id = ?`).get(requestId, agentId) as
      | RequestRow
      | undefined;
    if (!row) throw new TroqoError("unknown_request", `Unknown request ${requestId}`);
    return row;
  }

  getRequest(agentId: string, requestId: string): RequestView {
    const row = this.requestRow(agentId, requestId);
    const tasks =
      row.status === "awaiting_work"
        ? (
            this.db
              .prepare(
                `SELECT t.* FROM assignments a JOIN tasks t ON t.id = a.task_id
                 WHERE a.request_id = ? ORDER BY a.position`,
              )
              .all(requestId) as unknown as TaskRow[]
          ).map(toAssigned)
        : [];
    return {
      requestId: row.id,
      agentId: row.agent_id,
      capability: row.capability,
      prompt: row.prompt,
      status: row.status,
      priceCredits: row.price_credits,
      tasks,
      resultId: row.result_id ?? undefined,
      error: row.error ?? undefined,
      createdAt: row.created_at,
    };
  }

  getResult(resultId: string): { mimeType: string; data: string } | undefined {
    const row = this.db.prepare(`SELECT mime_type, data FROM results WHERE id = ?`).get(resultId) as
      | { mime_type: string; data: string }
      | undefined;
    return row && { mimeType: row.mime_type, data: row.data };
  }

  totalSpendUsd(): number {
    const row = this.db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM spend`).get() as { s: number };
    return row.s;
  }

  /**
   * The work product: real tasks whose accepted answers reached consensus.
   * This is what could be delivered to a buyer or bartered with a capability provider.
   */
  resolvedTasks() {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.instruction, t.input, an.answer, COUNT(*) AS votes,
           (SELECT COUNT(*) FROM answers x WHERE x.task_id = t.id AND x.accepted = 1) AS total
         FROM answers an JOIN tasks t ON t.id = an.task_id
         WHERE an.accepted = 1 AND t.gold IS NULL
         GROUP BY t.id, an.answer
         HAVING COUNT(*) >= ?
         ORDER BY t.id`,
      )
      .all(this.config.minAgreement) as {
      id: string;
      instruction: string;
      input: string;
      answer: string;
      votes: number;
      total: number;
    }[];
    return rows
      .filter((r) => r.votes / r.total >= 2 / 3)
      .map((r) => ({ taskId: r.id, input: r.input, answer: r.answer, votes: r.votes, totalAnswers: r.total }));
  }

  /** Metrics needed to validate the business model. */
  stats() {
    const byStatus = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM requests GROUP BY status`)
      .all() as { status: string; n: number }[];
    const graded = this.db
      .prepare(
        `SELECT AVG(approx_tokens) AS avgTokens,
           AVG((julianday(completed_at) - julianday(created_at)) * 86400) AS avgSeconds
         FROM requests WHERE status IN ('delivered', 'rejected', 'failed') AND approx_tokens > 0`,
      )
      .get() as { avgTokens: number | null; avgSeconds: number | null };
    const counts = Object.fromEntries(byStatus.map((r) => [r.status, r.n]));
    const delivered = counts.delivered ?? 0;
    const rejected = counts.rejected ?? 0;
    const spend = this.totalSpendUsd();
    return {
      requests: counts,
      qualityPassRate: delivered + rejected ? delivered / (delivered + rejected) : null,
      avgApproxTokensPerBatch: graded.avgTokens === null ? null : Math.round(graded.avgTokens),
      avgSecondsToComplete: graded.avgSeconds === null ? null : Math.round(graded.avgSeconds),
      totalSpendUsd: Math.round(spend * 10000) / 10000,
      costPerDeliveryUsd: delivered ? Math.round((spend / delivered) * 10000) / 10000 : null,
      resolvedTasks: this.resolvedTasks().length,
    };
  }

  close() {
    this.db.close();
  }
}
