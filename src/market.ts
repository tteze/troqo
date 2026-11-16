import { randomUUID } from "node:crypto";
import { tx } from "./db.js";
import { TroqoError } from "./errors.js";
import type { Troqo } from "./engine.js";

/**
 * Mission market: agents post missions for each other and pay in credits.
 *
 * - Posting locks the price in escrow: you must have earned the credits first.
 * - Requester and solver validate together: the requester accepts or contests the delivery.
 * - A contest is settled by one mediator drawn at random; the loser may appeal to three more.
 *   The final verdict is the majority; mediators on the losing side of it are not paid.
 * - Credits only move between agents (or are created by micro-tasks). Balances may go negative
 *   when a losing party owes mediation fees: it must work them off before posting again.
 * - Troqo keeps no work content: a delivery is erased when its mission closes.
 */

export type MissionStatus =
  | "open"
  | "taken"
  | "delivered"
  | "disputed"
  | "mediated"
  | "appealed"
  | "accepted"
  | "refused"
  | "cancelled";
export type Verdict = "accept" | "refuse";

const ACTIVE: MissionStatus[] = ["open", "taken", "delivered", "disputed", "mediated", "appealed"];
const KIND = /^[a-z][a-z0-9-]{1,30}$/;

interface MissionRow {
  id: string;
  requester_id: string;
  kind: string;
  title: string;
  spec: string;
  acceptance: string;
  price_credits: number;
  status: MissionStatus;
  solver_id: string | null;
  taken_at: string | null;
  delivery: string | null;
  delivered_at: string | null;
  contest_reason: string | null;
  verdict: Verdict | null;
  verdict_at: string | null;
  created_at: string;
  closed_at: string | null;
}

export interface MissionInput {
  kind: string;
  title: string;
  spec: string;
  acceptance: string;
  priceCredits: number;
}

/** What one agent may see of a mission, depending on its role. */
export interface MissionView {
  missionId: string;
  role: "requester" | "solver" | "mediator" | "visitor";
  kind: string;
  title: string;
  priceCredits: number;
  status: MissionStatus;
  spec?: string;
  acceptance?: string;
  delivery?: string;
  contestReason?: string;
  verdict?: Verdict;
  /** Deadline of the current step, if any (ISO). */
  deadline?: string;
  createdAt: string;
}

export interface PendingMediation {
  missionId: string;
  round: number;
  kind: string;
  title: string;
  spec: string;
  acceptance: string;
  delivery: string;
  contestReason: string;
  /** Earlier verdict when this is an appeal. */
  firstVerdict?: Verdict;
  deadline: string;
}

const now = () => new Date().toISOString();
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const plusMinutes = (iso: string, m: number) => new Date(new Date(iso).getTime() + m * 60_000).toISOString();

function check(cond: unknown, code: string, message: string): asserts cond {
  if (!cond) throw new TroqoError(code, message);
}

export class Market {
  constructor(private readonly t: Troqo) {}

  private get db() {
    return this.t.db;
  }

  private get c() {
    return this.t.config;
  }

  // ---------------------------------------------------------------- requester

  postMission(agentId: string, input: MissionInput): MissionView {
    this.sweep();
    this.t.ensureAgent(agentId);
    const kind = input.kind.trim().toLowerCase();
    check(KIND.test(kind), "invalid_mission", "kind must be a short lowercase slug, e.g. code, text, review");
    check(input.title.trim().length > 0 && input.title.length <= 120, "invalid_mission", "title: 1 to 120 characters");
    check(
      input.spec.trim().length > 0 && input.spec.length <= this.c.maxMissionSpecChars,
      "invalid_mission",
      `spec: 1 to ${this.c.maxMissionSpecChars} characters`,
    );
    check(
      input.acceptance.trim().length > 0 && input.acceptance.length <= 2000,
      "invalid_mission",
      "acceptance criteria: 1 to 2000 characters",
    );
    const price = input.priceCredits;
    check(
      Number.isInteger(price) && price >= 1 && price <= this.c.maxMissionPriceCredits,
      "invalid_mission",
      `price: a whole number of credits from 1 to ${this.c.maxMissionPriceCredits}`,
    );

    const open = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM missions WHERE requester_id = ? AND status IN (${ACTIVE.map(() => "?").join(",")})`,
      )
      .get(agentId, ...ACTIVE) as { n: number };
    check(
      open.n < this.c.maxOpenMissionsPerAgent,
      "too_many_open_missions",
      `You already have ${open.n} missions in progress`,
    );
    const balance = this.t.balance(agentId);
    check(
      balance >= price,
      "insufficient_credits",
      `This mission costs ${price} credits and your balance is ${balance}. Earn credits first: ` +
        `earn_credits (micro-tasks), take_mission (solve another agent's mission) or mediate.`,
    );

    const id = randomUUID();
    tx(this.db, () => {
      this.credit(agentId, -price);
      this.db
        .prepare(
          `INSERT INTO missions (id, requester_id, kind, title, spec, acceptance, price_credits, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
        )
        .run(id, agentId, kind, input.title.trim(), input.spec, input.acceptance, price, now());
    });
    return this.getMission(agentId, id);
  }

  /** Cancels a mission nobody has taken yet; the escrow is refunded. */
  cancelMission(agentId: string, missionId: string): MissionView {
    this.sweep();
    const m = this.row(missionId);
    check(m.requester_id === agentId, "forbidden", "Only the requester can cancel a mission");
    tx(this.db, () => {
      const res = this.db
        .prepare(`UPDATE missions SET status = 'cancelled', closed_at = ? WHERE id = ? AND status = 'open'`)
        .run(now(), missionId);
      check(res.changes === 1, "mission_not_open", `Mission is ${m.status}; only an open mission can be cancelled`);
      this.credit(agentId, m.price_credits);
    });
    return this.getMission(agentId, missionId);
  }

  /** The requester accepts the delivery (the solver is paid) or contests it (a mediator is drawn). */
  reviewDelivery(agentId: string, missionId: string, decision: "accept" | "contest", reason?: string): MissionView {
    this.sweep();
    const m = this.row(missionId);
    check(m.requester_id === agentId, "forbidden", "Only the requester can review the delivery");
    check(m.status === "delivered", "invalid_state", `Mission is ${m.status}, not delivered`);
    if (decision === "accept") {
      this.finalize(missionId, "accept");
    } else {
      check(reason && reason.trim().length >= 10, "invalid_review", "Explain in a sentence what does not meet the criteria");
      const res = this.db
        .prepare(`UPDATE missions SET status = 'disputed', contest_reason = ? WHERE id = ? AND status = 'delivered'`)
        .run(reason.trim(), missionId);
      check(res.changes === 1, "invalid_state", "Mission was already reviewed");
      this.draw(missionId, 1, 1);
    }
    return this.getMission(agentId, missionId);
  }

  /** After the first mediation, the losing party accepts the verdict or appeals to more mediators. */
  respondToVerdict(agentId: string, missionId: string, decision: "accept" | "appeal"): MissionView {
    this.sweep();
    const m = this.row(missionId);
    check(m.status === "mediated" && m.verdict, "invalid_state", `Mission is ${m.status}, no verdict to respond to`);
    const loser = m.verdict === "accept" ? m.requester_id : m.solver_id;
    check(agentId === loser, "forbidden", "Only the party who lost the mediation can respond to the verdict");
    if (decision === "accept") {
      this.finalize(missionId, m.verdict);
    } else {
      const res = this.db
        .prepare(`UPDATE missions SET status = 'appealed' WHERE id = ? AND status = 'mediated'`)
        .run(missionId);
      check(res.changes === 1, "invalid_state", "Verdict was already answered");
      this.draw(missionId, 2, this.c.appealMediators);
    }
    return this.getMission(agentId, missionId);
  }

  // ---------------------------------------------------------------- solver

  /** Open missions posted by other agents, best paid first. */
  listMissions(agentId: string, kind?: string, limit = 20) {
    this.sweep();
    const rows = this.db
      .prepare(
        `SELECT id, kind, title, price_credits, spec, created_at FROM missions
         WHERE status = 'open' AND requester_id != ? AND (? IS NULL OR kind = ?)
         ORDER BY price_credits DESC, created_at LIMIT ?`,
      )
      .all(agentId, kind ?? null, kind ?? null, limit) as unknown as Pick<
      MissionRow,
      "id" | "kind" | "title" | "price_credits" | "spec" | "created_at"
    >[];
    return rows.map((r) => ({
      missionId: r.id,
      kind: r.kind,
      title: r.title,
      priceCredits: r.price_credits,
      excerpt: r.spec.length > 200 ? `${r.spec.slice(0, 200)}…` : r.spec,
    }));
  }

  takeMission(agentId: string, missionId: string): MissionView {
    this.sweep();
    this.t.ensureAgent(agentId);
    const m = this.row(missionId);
    check(m.requester_id !== agentId, "forbidden", "You cannot take your own mission");
    const held = this.db
      .prepare(`SELECT COUNT(*) AS n FROM missions WHERE solver_id = ? AND status = 'taken'`)
      .get(agentId) as { n: number };
    check(held.n < this.c.maxTakenMissionsPerAgent, "too_many_taken_missions", "Deliver the missions you hold first");
    const res = this.db
      .prepare(
        `UPDATE missions SET status = 'taken', solver_id = ?, taken_at = ? WHERE id = ? AND status = 'open'`,
      )
      .run(agentId, now(), missionId);
    check(res.changes === 1, "mission_not_open", "This mission was taken by someone else or is closed");
    return this.getMission(agentId, missionId);
  }

  deliverMission(agentId: string, missionId: string, delivery: string): MissionView {
    this.sweep();
    check(
      delivery.trim().length > 0 && delivery.length <= this.c.maxDeliveryChars,
      "invalid_delivery",
      `Delivery: 1 to ${this.c.maxDeliveryChars} characters`,
    );
    const res = this.db
      .prepare(
        `UPDATE missions SET status = 'delivered', delivery = ?, delivered_at = ?
         WHERE id = ? AND solver_id = ? AND status = 'taken'`,
      )
      .run(delivery, now(), missionId, agentId);
    if (res.changes !== 1) {
      const m = this.row(missionId);
      check(m.solver_id === agentId, "forbidden", "You do not hold this mission");
      throw new TroqoError("invalid_state", `Mission is ${m.status}; it can no longer be delivered`);
    }
    return this.getMission(agentId, missionId);
  }

  // ---------------------------------------------------------------- mediator

  listMediations(agentId: string): PendingMediation[] {
    this.sweep();
    const rows = this.db
      .prepare(
        `SELECT m.*, d.round, d.assigned_at FROM mediations d JOIN missions m ON m.id = d.mission_id
         WHERE d.mediator_id = ? AND d.verdict IS NULL ORDER BY d.assigned_at`,
      )
      .all(agentId) as unknown as (MissionRow & { round: number; assigned_at: string })[];
    return rows.map((r) => ({
      missionId: r.id,
      round: r.round,
      kind: r.kind,
      title: r.title,
      spec: r.spec,
      acceptance: r.acceptance,
      delivery: r.delivery ?? "",
      contestReason: r.contest_reason ?? "",
      firstVerdict: r.round === 2 ? (r.verdict ?? undefined) : undefined,
      deadline: plusMinutes(r.assigned_at, this.c.mediationTtlMinutes),
    }));
  }

  mediate(agentId: string, missionId: string, verdict: Verdict, justification: string) {
    this.sweep();
    check(justification.trim().length >= 10, "invalid_verdict", "Justify the verdict against the acceptance criteria");
    const res = this.db
      .prepare(
        `UPDATE mediations SET verdict = ?, justification = ?, voted_at = ?
         WHERE mission_id = ? AND mediator_id = ? AND verdict IS NULL`,
      )
      .run(verdict, justification.trim(), now(), missionId, agentId);
    check(res.changes === 1, "forbidden", "You have no pending mediation for this mission");
    this.advance(missionId);
    return { missionId, verdict, status: this.row(missionId).status };
  }

  // ---------------------------------------------------------------- reads

  getMission(agentId: string, missionId: string): MissionView {
    const m = this.row(missionId);
    const isMediator = !!this.db
      .prepare(`SELECT 1 FROM mediations WHERE mission_id = ? AND mediator_id = ?`)
      .get(missionId, agentId);
    const role: MissionView["role"] =
      m.requester_id === agentId ? "requester" : m.solver_id === agentId ? "solver" : isMediator ? "mediator" : "visitor";
    const view: MissionView = {
      missionId: m.id,
      role,
      kind: m.kind,
      title: m.title,
      priceCredits: m.price_credits,
      status: m.status,
      createdAt: m.created_at,
    };
    if (role !== "visitor" || m.status === "open") {
      view.spec = m.spec;
      view.acceptance = m.acceptance;
    }
    if (role !== "visitor") {
      if (m.delivery) view.delivery = m.delivery;
      if (m.contest_reason) view.contestReason = m.contest_reason;
      if (m.verdict) view.verdict = m.verdict;
    }
    if (m.status === "taken" && m.taken_at) view.deadline = plusMinutes(m.taken_at, this.c.missionTakeTtlMinutes);
    if (m.status === "delivered" && m.delivered_at) view.deadline = plusMinutes(m.delivered_at, this.c.reviewTtlMinutes);
    if (m.status === "mediated" && m.verdict_at) view.deadline = plusMinutes(m.verdict_at, this.c.appealWindowMinutes);
    return view;
  }

  /** Missions this agent posted or is solving, most recent first. */
  myMissions(agentId: string) {
    this.sweep();
    const rows = this.db
      .prepare(
        `SELECT id FROM missions WHERE requester_id = ? OR solver_id = ? ORDER BY created_at DESC LIMIT 20`,
      )
      .all(agentId, agentId) as { id: string }[];
    return rows.map((r) => this.getMission(agentId, r.id));
  }

  /**
   * The market rate: prices are set by requesters (supply and demand); this only reports them.
   */
  rates() {
    const since = minutesAgo(30 * 24 * 60);
    const rows = this.db
      .prepare(
        `SELECT kind,
           SUM(status = 'open') AS open,
           SUM(status = 'accepted' AND closed_at >= ?) AS accepted30d,
           AVG(CASE WHEN status = 'accepted' AND closed_at >= ? THEN price_credits END) AS avgAcceptedPrice,
           MIN(CASE WHEN status = 'open' THEN price_credits END) AS minOpenPrice,
           MAX(CASE WHEN status = 'open' THEN price_credits END) AS maxOpenPrice
         FROM missions GROUP BY kind ORDER BY open DESC, kind`,
      )
      .all(since, since) as {
      kind: string;
      open: number;
      accepted30d: number;
      avgAcceptedPrice: number | null;
      minOpenPrice: number | null;
      maxOpenPrice: number | null;
    }[];
    return rows.map((r) => ({
      ...r,
      avgAcceptedPrice: r.avgAcceptedPrice === null ? null : Math.round(r.avgAcceptedPrice * 10) / 10,
    }));
  }

  stats() {
    const byStatus = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM missions GROUP BY status`)
      .all() as { status: string; n: number }[];
    const med = this.db
      .prepare(
        `SELECT COUNT(DISTINCT mission_id) AS disputes, SUM(round = 2) AS appealVotes FROM mediations`,
      )
      .get() as { disputes: number; appealVotes: number | null };
    return {
      missions: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
      disputes: med.disputes,
      appealVotes: med.appealVotes ?? 0,
    };
  }

  // ---------------------------------------------------------------- internals

  private row(missionId: string): MissionRow {
    const m = this.db.prepare(`SELECT * FROM missions WHERE id = ?`).get(missionId) as MissionRow | undefined;
    if (!m) throw new TroqoError("unknown_mission", `Unknown mission ${missionId}`);
    return m;
  }

  private credit(agentId: string, amount: number) {
    this.t.ensureAgent(agentId);
    this.db.prepare(`UPDATE ledger SET credits = credits + ? WHERE agent_id = ?`).run(amount, agentId);
  }

  private reputation(agentId: string, good: boolean) {
    this.db
      .prepare(
        good
          ? `UPDATE ledger SET reputation = MIN(1, reputation * 0.9 + 0.1) WHERE agent_id = ?`
          : `UPDATE ledger SET reputation = MAX(0, reputation * 0.8) WHERE agent_id = ?`,
      )
      .run(agentId);
  }

  /**
   * Draws mediators at random among agents with a track record, never the parties nor
   * agents already involved in this mission. Missing seats are filled later by sweep().
   */
  private draw(missionId: string, round: number, seats: number) {
    const m = this.row(missionId);
    const taken = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM mediations WHERE mission_id = ? AND round = ? AND (verdict IS NULL OR verdict != 'expired')`,
      )
      .get(missionId, round) as { n: number };
    const missing = seats - taken.n;
    if (missing <= 0) return;
    const picks = this.db
      .prepare(
        `SELECT agent_id FROM ledger
         WHERE batches_passed >= ? AND reputation >= ? AND agent_id NOT IN (?, ?)
           AND agent_id NOT IN (SELECT mediator_id FROM mediations WHERE mission_id = ?)
         ORDER BY RANDOM() LIMIT ?`,
      )
      .all(
        this.c.mediatorMinBatches,
        this.c.mediatorMinReputation,
        m.requester_id,
        m.solver_id ?? "",
        missionId,
        missing,
      ) as { agent_id: string }[];
    const ins = this.db.prepare(
      `INSERT INTO mediations (mission_id, round, mediator_id, assigned_at) VALUES (?, ?, ?, ?)`,
    );
    for (const p of picks) ins.run(missionId, round, p.agent_id, now());
  }

  /** Moves a disputed mission forward once the current round has its votes. */
  private advance(missionId: string) {
    const m = this.row(missionId);
    const votes = (round: number) =>
      this.db
        .prepare(
          `SELECT verdict FROM mediations WHERE mission_id = ? AND round = ? AND verdict IN ('accept', 'refuse')`,
        )
        .all(missionId, round) as { verdict: Verdict }[];

    if (m.status === "disputed") {
      const v = votes(1);
      if (v.length >= 1) {
        this.db
          .prepare(`UPDATE missions SET status = 'mediated', verdict = ?, verdict_at = ? WHERE id = ? AND status = 'disputed'`)
          .run(v[0].verdict, now(), missionId);
      }
    } else if (m.status === "appealed") {
      const v = votes(2);
      if (v.length >= this.c.appealMediators) {
        const accepts = v.filter((x) => x.verdict === "accept").length;
        this.finalize(missionId, accepts * 2 > v.length ? "accept" : "refuse");
      }
    }
  }

  /**
   * Closes a mission. "accept" pays the solver; "refuse" refunds the requester.
   * Every mediator who voted with the final verdict earns the fee, paid by the losing party;
   * mediators who voted against it earn nothing and lose reputation.
   */
  private finalize(missionId: string, verdict: Verdict) {
    tx(this.db, () => {
      const m = this.row(missionId);
      const closed = this.db
        .prepare(
          `UPDATE missions SET status = ?, delivery = NULL, closed_at = ?
           WHERE id = ? AND status IN ('delivered', 'mediated', 'appealed')`,
        )
        .run(verdict === "accept" ? "accepted" : "refused", now(), missionId);
      if (closed.changes !== 1) throw new TroqoError("invalid_state", `Mission is already ${m.status}`);

      const winner = verdict === "accept" ? m.solver_id! : m.requester_id;
      const loser = verdict === "accept" ? m.requester_id : m.solver_id!;
      this.credit(winner, m.price_credits);
      if (m.solver_id) this.reputation(m.solver_id, verdict === "accept");

      const voters = this.db
        .prepare(`SELECT mediator_id, verdict FROM mediations WHERE mission_id = ? AND verdict IN ('accept', 'refuse')`)
        .all(missionId) as { mediator_id: string; verdict: Verdict }[];
      if (voters.length === 0) return;
      this.reputation(loser, false);
      for (const v of voters) {
        const right = v.verdict === verdict;
        if (right) {
          this.credit(v.mediator_id, this.c.mediationFeeCredits);
          this.credit(loser, -this.c.mediationFeeCredits);
          this.db
            .prepare(`UPDATE mediations SET paid = 1 WHERE mission_id = ? AND mediator_id = ?`)
            .run(missionId, v.mediator_id);
        }
        this.reputation(v.mediator_id, right);
      }
      // Pending seats that never voted are dropped.
      this.db
        .prepare(`UPDATE mediations SET verdict = 'expired' WHERE mission_id = ? AND verdict IS NULL`)
        .run(missionId);
    });
  }

  /** Applies every deadline. Called lazily before each market operation. */
  sweep() {
    const c = this.c;
    // Taken but not delivered in time: back on the market.
    this.db
      .prepare(
        `UPDATE missions SET status = 'open', solver_id = NULL, taken_at = NULL WHERE status = 'taken' AND taken_at < ?`,
      )
      .run(minutesAgo(c.missionTakeTtlMinutes));

    // Delivered and not reviewed in time: accepted.
    const unreviewed = this.db
      .prepare(`SELECT id FROM missions WHERE status = 'delivered' AND delivered_at < ?`)
      .all(minutesAgo(c.reviewTtlMinutes)) as { id: string }[];
    for (const r of unreviewed) this.finalize(r.id, "accept");

    // First verdict not appealed in time: final.
    const settled = this.db
      .prepare(`SELECT id, verdict FROM missions WHERE status = 'mediated' AND verdict_at < ?`)
      .all(minutesAgo(c.appealWindowMinutes)) as { id: string; verdict: Verdict }[];
    for (const r of settled) this.finalize(r.id, r.verdict);

    // Mediators who did not vote in time are replaced; empty seats are filled.
    this.db
      .prepare(`UPDATE mediations SET verdict = 'expired' WHERE verdict IS NULL AND assigned_at < ?`)
      .run(minutesAgo(c.mediationTtlMinutes));
    const disputed = this.db
      .prepare(`SELECT id, status FROM missions WHERE status IN ('disputed', 'appealed')`)
      .all() as { id: string; status: MissionStatus }[];
    for (const d of disputed) {
      if (d.status === "disputed") this.draw(d.id, 1, 1);
      else this.draw(d.id, 2, c.appealMediators);
    }
  }
}

