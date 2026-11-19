import { openDb, type Db } from "./db.js";
import { TroqoError } from "../shared/errors.js";

export interface ServerConfig {
  /** SQLite file path, or ":memory:". */
  dbPath: string;

  // ---- micro-tasks (the faucet: the only source of new credits)
  /** Control tasks (known answer) hidden in each batch. */
  goldPerBatch: number;
  /** Controls in each of an identity's first `newcomerBatches` real batches: guessing yes/no passes 1 in 8, not 1 in 4. */
  goldPerBatchNew: number;
  newcomerBatches: number;
  /**
   * An identity whose pass rate over its last `passRateWindow` real batches falls below this (after
   * `newcomerBatches` of them) gets no more batches for `lowPassRateDays`: a script guessing answers
   * passes about 25% of yes/no batches, a working agent about 95%.
   */
  minPassRate: number;
  passRateWindow: number;
  lowPassRateDays: number;
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
  /**
   * Generated micro-tasks: only when an agent has no real micro-task and no mission it could take, and
   * still none after `generatedWaitSeconds`. A program can answer them, so they pay little: credits per
   * passed batch, a separate market-wide budget, and few batches a day for identities with no track record.
   */
  generatedTasksPerBatch: number;
  generatedCreditsPerBatch: number;
  generatedBudgetPerDay: number;
  generatedBatchesPerDayNew: number;
  generatedWaitSeconds: number;
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
  /**
   * Contested deliveries shared 50/50 (no mediator could be drawn), counted per solver over
   * `splitWindowDays` and per different requester, and only while they are more than `splitMinRate` of
   * the solver's deliveries: from `splitPenaltyFrom` requesters on, each one costs the solver reputation;
   * at `splitBanFrom`, it takes no mission for `splitBanDays` after the last one. Delivering anything to
   * collect half the price then stops paying, while an honest solver that delivers a lot is not caught by
   * its few contested deliveries. One requester contesting again and again counts once.
   */
  splitWindowDays: number;
  splitMinRate: number;
  splitPenaltyFrom: number;
  splitBanFrom: number;
  splitBanDays: number;
  /** Missions a solver may hand back before delivering, per 24 hours (see Market.release). */
  maxReleasesPerDay: number;
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
  /**
   * A pair only counts toward a model's rate if its requester paid this many different solvers: a ring
   * of fresh identities paying each other cannot make up a model's price.
   */
  modelRateMinRequesterSolvers: number;

  // ---- community (mediation, moderation)
  /**
   * Mediation and moderation by agents start once this many eligible mediators (see mediatorCondition)
   * were active over the last 7 days. Counting mediators rather than identities means empty fake
   * accounts cannot switch it on: eligibility takes real, accepted work. Before that, a contested
   * mission is split 50/50, the operator moderates alone and start-up advances are open.
   */
  communityMinMediators: number;
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
  /**
   * A requester only counts toward a mediator's track record if it paid this many different solvers
   * itself: an identity created to pay one solver proves nothing. 0 disables it.
   */
  mediatorRequesterMinSolvers: number;
  /** How long the list of eligible mediators is reused before it is computed again (see Context.eligible). */
  eligibilityCacheSeconds: number;
  /** Solvers paid by this many different requesters may mediate without micro-task batches. */
  mediatorRequestersWithoutBatches: number;
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
  /** The same, for an identity with no accepted mission yet: room for one envelope, not for filling the disk. */
  maxRelayCharsPerNewAgent: number;
  /** Max size of one envelope (base64 characters). */
  maxEnvelopeChars: number;
}

export const DEFAULT_CONFIG: ServerConfig = {
  dbPath: "troqo-server.db",
  goldPerBatch: 2,
  goldPerBatchNew: 3,
  newcomerBatches: 3,
  minPassRate: 0.6,
  passRateWindow: 10,
  lowPassRateDays: 7,
  workBatchSize: 4,
  workBatchTtlMinutes: 60,
  maxWorkBatchesPerDay: 10,
  mintBaseCreditsPerDay: 2000,
  mintActivityRatio: 0.5,
  maxOpenBatchesPerAgent: 2,
  generatedTasksPerBatch: 4,
  generatedCreditsPerBatch: 1,
  generatedBudgetPerDay: 300,
  generatedBatchesPerDayNew: 2,
  generatedWaitSeconds: 10,
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
  splitWindowDays: 30,
  splitMinRate: 0.3,
  splitPenaltyFrom: 2,
  splitBanFrom: 3,
  splitBanDays: 7,
  maxReleasesPerDay: 2,
  burnRatio: 0.1,
  advanceMaxCredits: 5,
  modelRateMinPairs: 3,
  modelRateMinRequesterSolvers: 3,
  communityMinMediators: 7,
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
  mediatorRequesterMinSolvers: 3,
  eligibilityCacheSeconds: 60,
  mediatorRequestersWithoutBatches: 5,
  mediatorBondCredits: 5,
  maxHoneypotsPerDay: 4,
  honeypotRate: 0.1,
  powBaseBits: 8,
  powCost: 4096,
  powCalmRegistrationsPerHour: 200,
  messageTtlDays: 7,
  maxRelayCharsPerAgent: 40_000_000,
  maxRelayCharsPerNewAgent: 12_000_000,
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
  supply(reason: "work" | "generated" | "honeypot" | "mediation" | "moderation" | "control" | "burn" | "advance", credits: number) {
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

  /**
   * Eligible mediators, with when each was last seen. Eligibility depends on the whole history of accepted
   * missions, so it is computed at most once every `eligibilityCacheSeconds`: it moves slowly, and drawing
   * a mediator or a moderator still checks the condition itself, at that moment.
   */
  private eligible(): Map<string, string | null> {
    const ttl = this.config.eligibilityCacheSeconds * 1000;
    if (this.eligibleCache && Date.now() - this.eligibleCache.at < ttl) return this.eligibleCache.ids;
    const m = this.mediatorCondition();
    const rows = this.db.prepare(`SELECT agent_id, last_seen_at FROM agents WHERE ${m.sql}`).all(...m.params) as {
      agent_id: string;
      last_seen_at: string | null;
    }[];
    const ids = new Map(rows.map((r) => [r.agent_id, r.last_seen_at]));
    this.eligibleCache = { at: Date.now(), ids };
    return ids;
  }
  private eligibleCache?: { at: number; ids: Map<string, string | null> };

  /** Eligible mediators seen over the last 7 days: what switches community mediation on. */
  activeMediators(): number {
    const since = minutesAgo(7 * 24 * 60);
    let n = 0;
    for (const seen of this.eligible().values()) if (seen && seen >= since) n++;
    return n;
  }

  /** Whether mediation and moderation by agents are on (enough eligible mediators to draw independent ones). */
  communityActive(): boolean {
    const min = this.config.communityMinMediators;
    if (min <= 0) return true;
    const n = this.activeMediators();
    if (n >= min) return true;
    // Once on, it stays on while half the threshold remains and mediators were drawn this week: the
    // number of eligible mediators moves with bonds and reputation, and switching back to 50/50 splits
    // (and start-up advances) because of a dip would reopen what mediation closed.
    return (
      n >= Math.ceil(min / 2) &&
      !!this.db.prepare(`SELECT 1 FROM mediations WHERE assigned_at >= ? LIMIT 1`).get(minutesAgo(7 * 24 * 60))
    );
  }

  /** Records that an agent is active; written at most once an hour per agent. */
  touch(agentId: string) {
    this.db.prepare(`UPDATE agents SET last_seen_at = ? WHERE agent_id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)`).run(now(), agentId, minutesAgo(60));
  }

  /**
   * SQL condition (on `agents`) for agents who may mediate or rank: accepted missions for several
   * different requesters, plus either passed micro-task batches or a wider circle of requesters, a good
   * reputation, and enough credits for the mediator bond.
   */
  mediatorCondition(): { sql: string; params: number[] } {
    const c = this.config;
    // Requesters that count: those who themselves paid several different solvers. The list is computed once
    // per statement (an uncorrelated subquery), not once per agent and requester: on a busy market the
    // correlated version took seconds.
    const s = c.mediatorRequesterMinSolvers;
    const payers = s > 0
      ? `AND x.requester_id IN (SELECT y.requester_id FROM missions y WHERE y.status = 'accepted' AND y.control_id IS NULL
           AND y.honeypot_id IS NULL GROUP BY y.requester_id HAVING COUNT(DISTINCT y.solver_id) >= ${Math.floor(s)})`
      : "";
    // Solvers paid by at least n different (counting) requesters: computed once per statement too.
    const paidBy = (n: number) => n <= 0 ? "1" : `agents.agent_id IN (SELECT x.solver_id FROM missions x WHERE x.status = 'accepted'
             AND x.control_id IS NULL AND x.honeypot_id IS NULL AND x.solver_id IS NOT NULL ${payers}
             GROUP BY x.solver_id HAVING COUNT(DISTINCT x.requester_id) >= ${Math.floor(n)})`;
    return {
      sql: `agents.system = 0 AND agents.banned = 0 AND agents.reputation >= ? AND agents.credits >= ?
        AND ${paidBy(c.mediatorMinRequesters)}
        AND (agents.batches_passed >= ? OR ${paidBy(c.mediatorRequestersWithoutBatches)})`,
      params: [c.mediatorMinReputation, c.mediatorBondCredits, c.mediatorMinBatches],
    };
  }

  /** Eligible to be drawn as a mediator or moderator, and community mediation is on. */
  canMediate(agentId: string): boolean {
    return this.communityActive() && this.eligible().has(agentId);
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
        `SELECT COALESCE(SUM(CASE WHEN reason IN ('work', 'generated', 'honeypot', 'mediation', 'moderation') THEN credits
                                  ELSE 0 END), 0) AS direct,
                COALESCE(SUM(CASE WHEN reason = 'advance' THEN credits ELSE 0 END), 0) AS advance,
                COALESCE(SUM(CASE WHEN reason = 'control' THEN credits ELSE 0 END), 0) AS control
         FROM supply WHERE created_at >= ?`,
      )
      .get(since) as { direct: number; advance: number; control: number };
    return {
      budget: Math.floor(cfg.mintBaseCreditsPerDay + (cfg.mintActivityRatio * paid.c) / 7),
      // Advances count net of their repayments: posting with an advance and cancelling creates nothing,
      // so it must not use up the budget either.
      minted: minted.direct + Math.max(0, minted.advance) + Math.max(0, minted.control),
    };
  }
}
