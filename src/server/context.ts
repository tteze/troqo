import { openDb, type Db } from "./db.js";
import { TroqoError } from "../shared/errors.js";

export interface ServerConfig {
  /** SQLite file path, or ":memory:". */
  dbPath: string;

  // ---- micro-tasks (the faucet: the only source of new credits)
  /** Control tasks (known answer) hidden in each batch. Two keep a careless agent's pass rate near 5%. */
  goldPerBatch: number;
  /** Real tasks per batch; one credit each. */
  workBatchSize: number;
  workBatchTtlMinutes: number;
  /** Caps credit creation per agent and per day. */
  maxWorkBatchesPerDay: number;
  /**
   * Caps credit creation for the whole market, per rolling 24 hours: a base, plus a share of the
   * credits paid on accepted missions (daily average over 7 days). Creating identities in bulk then
   * splits the same budget instead of multiplying it.
   */
  mintBaseCreditsPerDay: number;
  mintActivityRatio: number;
  maxOpenBatchesPerAgent: number;
  /** Agreeing answers needed to resolve a real task. */
  minAgreement: number;
  /** Share of answers the top answer must hold to resolve a task. */
  consensusRatio: number;
  /** A task with this many answers and still no consensus is withdrawn as contested. */
  maxAnswersPerTask: number;
  /** A task answered unanimously by this many agents becomes a control for others. */
  consensusGoldMinVotes: number;

  // ---- missions
  maxSummaryChars: number;
  maxMissionPriceCredits: number;
  maxOpenMissionsPerAgent: number;
  /** Missions held at once without a bond (cheap missions). Bonded ones are limited by the balance. */
  maxTakenMissionsPerAgent: number;
  /** Share of the price a solver locks when taking a mission, rounded down; lost if it does not deliver. */
  takeBondRatio: number;
  /** The requester's client must hand over the spec within this delay, or the solver is released. */
  handoffTtlMinutes: number;
  /** Once the spec is handed over, the solver must deliver within this delay. */
  deliveryTtlMinutes: number;
  /** A delivery neither accepted nor contested within this delay is accepted. */
  reviewTtlMinutes: number;
  /** Share of an accepted mission's price destroyed, so the credit supply does not only grow. */
  burnRatio: number;

  // ---- mediation
  /** A mediator who does not vote within this delay is replaced. */
  mediationTtlMinutes: number;
  /** Each party must send its piece to the mediator within this delay, or loses the dispute. */
  evidenceTtlMinutes: number;
  appealWindowMinutes: number;
  mediationFeeCredits: number;
  /** Mediators drawn on appeal (odd). */
  appealMediators: number;
  mediatorMinBatches: number;
  mediatorMinReputation: number;
  /** Probability, when an eligible mediator checks its inbox, of receiving a fake dispute with a known verdict. */
  honeypotRate: number;

  // ---- identities
  /** Proof of work at registration: leading zero bits at the calm rate (about 2 s with cost 4096). 0 disables it. */
  powBaseBits: number;
  powCost: number;
  /** Registrations per hour, market-wide, above which each doubling adds one bit (doubles the cost). */
  powCalmRegistrationsPerHour: number;

  // ---- relay
  messageTtlDays: number;
  /** Max size of one envelope (base64 characters). */
  maxEnvelopeChars: number;
}

export const DEFAULT_CONFIG: ServerConfig = {
  dbPath: "troqo-server.db",
  goldPerBatch: 2,
  workBatchSize: 4,
  workBatchTtlMinutes: 60,
  maxWorkBatchesPerDay: 10,
  mintBaseCreditsPerDay: 2000,
  mintActivityRatio: 0.5,
  maxOpenBatchesPerAgent: 2,
  minAgreement: 2,
  consensusRatio: 2 / 3,
  maxAnswersPerTask: 5,
  consensusGoldMinVotes: 3,
  maxSummaryChars: 300,
  maxMissionPriceCredits: 100,
  maxOpenMissionsPerAgent: 5,
  maxTakenMissionsPerAgent: 2,
  takeBondRatio: 0.2,
  handoffTtlMinutes: 24 * 60,
  deliveryTtlMinutes: 4 * 60,
  reviewTtlMinutes: 24 * 60,
  burnRatio: 0.1,
  mediationTtlMinutes: 24 * 60,
  evidenceTtlMinutes: 12 * 60,
  appealWindowMinutes: 24 * 60,
  mediationFeeCredits: 1,
  appealMediators: 3,
  mediatorMinBatches: 3,
  mediatorMinReputation: 0.8,
  honeypotRate: 0.1,
  powBaseBits: 8,
  powCost: 4096,
  powCalmRegistrationsPerHour: 200,
  messageTtlDays: 7,
  maxEnvelopeChars: 11_000_000,
};

export const SYSTEM_AGENT = "troqo";

export const now = () => new Date().toISOString();
export const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
export const plusMinutes = (iso: string, m: number) => new Date(new Date(iso).getTime() + m * 60_000).toISOString();

export function check(cond: unknown, code: string, message: string): asserts cond {
  if (!cond) throw new TroqoError(code, message);
}

/** Shared state and ledger helpers for the market modules. */
export class Context {
  readonly db: Db;
  readonly config: ServerConfig;

  constructor(config: Partial<ServerConfig> = {}) {
    const defined = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined));
    this.config = { ...DEFAULT_CONFIG, ...defined };
    this.db = openDb(this.config.dbPath);
  }

  agentExists(agentId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM agents WHERE agent_id = ?`).get(agentId);
  }

  requireAgent(agentId: string) {
    const row = this.db.prepare(`SELECT * FROM agents WHERE agent_id = ?`).get(agentId) as
      | {
          agent_id: string;
          sign_public: string;
          box_public: string;
          credits: number;
          reputation: number;
          batches_passed: number;
          batches_failed: number;
          missions_solved: number;
        }
      | undefined;
    if (!row) throw new TroqoError("unknown_agent", `Unknown agent ${agentId}`);
    return row;
  }

  balance(agentId: string): number {
    const row = this.db.prepare(`SELECT credits FROM agents WHERE agent_id = ?`).get(agentId) as
      | { credits: number }
      | undefined;
    return row?.credits ?? 0;
  }

  credit(agentId: string, amount: number) {
    if (agentId === SYSTEM_AGENT || amount === 0) return;
    this.db.prepare(`UPDATE agents SET credits = credits + ? WHERE agent_id = ?`).run(amount, agentId);
  }

  /**
   * Takes up to `amount` credits from an agent without going below zero. Balances never go negative:
   * a debt would be escaped by creating a new identity. Returns what was actually taken.
   */
  debit(agentId: string, amount: number): number {
    if (agentId === SYSTEM_AGENT || amount <= 0) return 0;
    const taken = Math.min(amount, Math.max(0, this.balance(agentId)));
    this.credit(agentId, -taken);
    return taken;
  }

  /** Records credits entering (positive) or leaving (negative) the economy. */
  supply(reason: "work" | "honeypot" | "mediation" | "control" | "burn", credits: number) {
    if (credits !== 0) {
      this.db.prepare(`INSERT INTO supply (reason, credits, created_at) VALUES (?, ?, ?)`).run(reason, credits, now());
    }
  }

  reputation(agentId: string, good: boolean) {
    if (agentId === SYSTEM_AGENT) return;
    this.db
      .prepare(
        good
          ? `UPDATE agents SET reputation = MIN(1, reputation * 0.9 + 0.1) WHERE agent_id = ?`
          : `UPDATE agents SET reputation = MAX(0, reputation * 0.8) WHERE agent_id = ?`,
      )
      .run(agentId);
  }

  canMediate(agentId: string): boolean {
    const a = this.db.prepare(`SELECT batches_passed, reputation FROM agents WHERE agent_id = ?`).get(agentId) as
      | { batches_passed: number; reputation: number }
      | undefined;
    return !!a && a.batches_passed >= this.config.mediatorMinBatches && a.reputation >= this.config.mediatorMinReputation;
  }
}
