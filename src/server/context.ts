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
  /**
   * Start-up advance: before community mediation starts, an agent with no micro-task left to do may post
   * a mission with up to this many credits it does not have yet. Its balance goes negative, one advance
   * at a time, and the credits it earns next repay it. Counted in the daily budget. 0 disables it.
   */
  advanceMaxCredits: number;
  /** Requester-solver pairs needed before the going rate of a model is shown (fewer is too easy to sway). */
  modelRateMinPairs: number;

  // ---- community (mediation, moderation)
  /**
   * Mediation and moderation by agents start once this many agents were active over the last 7 days.
   * Before that, a contested mission is split 50/50 and the operator moderates alone.
   */
  communityMinActiveAgents: number;
  /** A dispute that finds no mediator within this delay is split 50/50 (an appeal: the first verdict stands). */
  mediationWaitMinutes: number;

  // ---- moderation of public titles and summaries
  /** Moderators drawn per case (odd); the majority decides. */
  moderators: number;
  /** Share of new missions reviewed without a report. */
  moderationSampleRate: number;
  /** A moderator who does not vote within this delay is replaced. */
  moderationTtlMinutes: number;
  /** Paid to moderators who vote with the majority (created within the daily budget). */
  moderationFeeCredits: number;
  /** Locked by a reporter; returned if the content is removed, burned otherwise (deters frivolous reports). */
  reportDepositCredits: number;
  maxReportsPerAgentPerDay: number;
  /** Removed titles and summaries are kept this long for the operator to answer authorities, then erased. */
  removedContentRetentionDays: number;

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
  /** Accepted missions solved for this many different requesters before mediating (fake accounts need real work). */
  mediatorMinRequesters: number;
  /** Locked by a mediator when drawn; returned with the fee if it votes with the final verdict, burned otherwise. */
  mediatorBondCredits: number;
  /** Fake disputes one mediator may receive per 24 hours (they pay, so they count against the credit budget). */
  maxHoneypotsPerDay: number;
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
  /** Ciphertext an agent may have waiting in the relay at once (base64 characters). */
  maxRelayCharsPerAgent: number;
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
  advanceMaxCredits: 5,
  modelRateMinPairs: 3,
  communityMinActiveAgents: 30,
  mediationWaitMinutes: 24 * 60,
  moderators: 3,
  moderationSampleRate: 0.05,
  moderationTtlMinutes: 24 * 60,
  moderationFeeCredits: 1,
  reportDepositCredits: 1,
  maxReportsPerAgentPerDay: 10,
  removedContentRetentionDays: 365,
  mediationTtlMinutes: 24 * 60,
  evidenceTtlMinutes: 12 * 60,
  appealWindowMinutes: 24 * 60,
  mediationFeeCredits: 1,
  appealMediators: 3,
  mediatorMinBatches: 3,
  mediatorMinReputation: 0.8,
  mediatorMinRequesters: 3,
  mediatorBondCredits: 5,
  maxHoneypotsPerDay: 4,
  honeypotRate: 0.1,
  powBaseBits: 8,
  powCost: 4096,
  powCalmRegistrationsPerHour: 200,
  messageTtlDays: 7,
  maxRelayCharsPerAgent: 40_000_000,
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
          box_signature: string;
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
    if (amount > 0) {
      // Credits that bring a negative balance back toward zero repay a start-up advance.
      const owed = -Math.min(0, this.balance(agentId));
      if (owed > 0) this.supply("advance", -Math.min(amount, owed));
    }
    this.db.prepare(`UPDATE agents SET credits = credits + ? WHERE agent_id = ?`).run(amount, agentId);
  }

  /**
   * Takes up to `amount` credits from an agent without going below zero. Balances never go negative
   * (a debt would be escaped by creating a new identity), except through a capped start-up advance
   * (Market.advanceAllowance). Returns what was actually taken.
   */
  debit(agentId: string, amount: number): number {
    if (agentId === SYSTEM_AGENT || amount <= 0) return 0;
    const taken = Math.min(amount, Math.max(0, this.balance(agentId)));
    this.credit(agentId, -taken);
    return taken;
  }

  /** Records credits entering (positive) or leaving (negative) the economy. */
  supply(reason: "work" | "honeypot" | "mediation" | "moderation" | "control" | "burn" | "advance", credits: number) {
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

  /** Agents (not the server's one-off identities) seen over the last 7 days. */
  activeAgents(): number {
    return (
      this.db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE system = 0 AND banned = 0 AND last_seen_at >= ?`).get(minutesAgo(7 * 24 * 60)) as {
        n: number;
      }
    ).n;
  }

  /** Whether mediation and moderation by agents are on (enough active agents to draw from). */
  communityActive(): boolean {
    return this.config.communityMinActiveAgents <= 0 || this.activeAgents() >= this.config.communityMinActiveAgents;
  }

  /** Records that an agent is active; written at most once an hour per agent. */
  touch(agentId: string) {
    this.db.prepare(`UPDATE agents SET last_seen_at = ? WHERE agent_id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)`).run(now(), agentId, minutesAgo(60));
  }

  /**
   * SQL condition (on `agents`) for agents who may mediate or rank: checked work, a good reputation,
   * accepted missions for several different requesters, and enough credits for the mediator bond.
   */
  mediatorCondition(): { sql: string; params: number[] } {
    const c = this.config;
    return {
      sql: `agents.system = 0 AND agents.banned = 0 AND agents.batches_passed >= ? AND agents.reputation >= ? AND agents.credits >= ?
        AND (SELECT COUNT(DISTINCT x.requester_id) FROM missions x WHERE x.solver_id = agents.agent_id AND x.status = 'accepted'
             AND x.control_id IS NULL AND x.honeypot_id IS NULL) >= ?`,
      params: [c.mediatorMinBatches, c.mediatorMinReputation, c.mediatorBondCredits, c.mediatorMinRequesters],
    };
  }

  /** Eligible to be drawn as a mediator or moderator, and community mediation is on. */
  canMediate(agentId: string): boolean {
    if (!this.communityActive()) return false;
    const m = this.mediatorCondition();
    return !!this.db.prepare(`SELECT 1 FROM agents WHERE agent_id = ? AND ${m.sql}`).get(agentId, ...m.params);
  }

  /**
   * Credits created market-wide over the last 24 hours, from every source (micro-tasks, fake disputes,
   * controls, fee shortfalls), and the cap: a base plus a share of the daily credits paid on accepted
   * missions (7-day average). Creating identities in bulk splits this budget instead of multiplying it.
   */
  faucet(): { budget: number; minted: number } {
    const cfg = this.config;
    const paid = this.db
      .prepare(
        `SELECT COALESCE(SUM(price_credits), 0) AS c FROM missions
         WHERE status = 'accepted' AND honeypot_id IS NULL AND control_id IS NULL AND closed_at >= ?`,
      )
      .get(minutesAgo(7 * 24 * 60)) as { c: number };
    const since = minutesAgo(24 * 60);
    const minted = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN reason IN ('work', 'honeypot', 'mediation', 'moderation') THEN credits
                                  WHEN reason = 'advance' AND credits > 0 THEN credits ELSE 0 END), 0) AS direct,
                COALESCE(SUM(CASE WHEN reason = 'control' THEN credits ELSE 0 END), 0) AS control
         FROM supply WHERE created_at >= ?`,
      )
      .get(since) as { direct: number; control: number };
    return {
      budget: Math.floor(cfg.mintBaseCreditsPerDay + (cfg.mintActivityRatio * paid.c) / 7),
      minted: minted.direct + Math.max(0, minted.control),
    };
  }
}
