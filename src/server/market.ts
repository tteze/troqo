import { randomUUID } from "node:crypto";
import { tx } from "./db.js";
import { check, Context, minutesAgo, now, plusMinutes, SYSTEM_AGENT } from "./context.js";
import type { Certifier } from "./certification/certifier.js";
import type { Moderation } from "./moderation.js";
import type { Work } from "./work.js";
import { corruptAnswer, GENERATORS } from "./certification/generators.js";
import { seal, sha256 } from "../shared/crypto.js";
import { TroqoError } from "../shared/errors.js";
import {
  canonicalDelivery,
  canonicalSpec,
  type AgentEvents,
  type Inbox,
  type InboxMessage,
  type InboxTask,
  type MarketRate,
  type MessageKind,
  type MissionInfo,
  type MissionStatus,
  type PendingMediation,
  type RequesterRecord,
  type Verdict,
} from "../shared/protocol.js";

/**
 * The mission market. The server sees only metadata: titles, short public summaries, prices,
 * fingerprints (sha256) of specs and deliveries, and ciphertext in transit. Specs and deliveries
 * travel encrypted between agents; mediators check what they receive against the fingerprints.
 */

const KIND = /^[a-z][a-z0-9-]{1,30}$/;
const HASH = /^[0-9a-f]{64}$/;

function median(xs: number[]): number {
  const a = [...xs].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}
/** Same format as a declared model (Certifier.setModel). */
const MODEL = /^[a-z0-9][a-z0-9._-]{1,59}$/;
const ACTIVE: MissionStatus[] = ["open", "taken", "in_progress", "delivered", "disputed", "mediated", "appealed"];
const IN_DISPUTE: MissionStatus[] = ["disputed", "appealed"];

interface MissionRow {
  id: string;
  requester_id: string;
  kind: string;
  title: string;
  summary: string;
  price_credits: number;
  spec_hash: string;
  status: MissionStatus;
  solver_id: string | null;
  taken_at: string | null;
  spec_sent_at: string | null;
  delivery_hash: string | null;
  delivery_mime: string | null;
  delivered_at: string | null;
  contest_reason: string | null;
  verdict: Verdict | null;
  verdict_at: string | null;
  outcome_reason: string | null;
  honeypot_id: string | null;
  min_level: number;
  model: string | null;
  solver_model: string | null;
  target_id: string | null;
  control_id: string | null;
  solver_bond: number;
  requester_deposit: number;
  solver_deposit: number;
  created_at: string;
  closed_at: string | null;
}

export interface HoneypotDefinition {
  id: string;
  kind: string;
  title: string;
  summary: string;
  spec: string;
  acceptance: string;
  delivery: { mime: string; content: string };
  contestReason: string;
  /** The right verdict: mediators who vote otherwise lose reputation and are not paid. */
  verdict: Verdict;
}

interface HoneypotRow {
  id: string;
  kind: string;
  title: string;
  summary: string;
  spec: string;
  acceptance: string;
  delivery_mime: string;
  delivery_content: string;
  contest_reason: string;
  verdict: Verdict;
}

export interface PostMissionInput {
  kind: string;
  title: string;
  summary: string;
  priceCredits: number;
  specHash: string;
  /** Certification level in this kind a solver needs to take the mission. */
  minLevel?: number;
  /** Model the solver must have declared. */
  model?: string;
}

export class Market {
  /** Set by TroqoServer. Certification rules live in their own module and policy. */
  certifier?: Certifier;
  /** Set by TroqoServer. Reviews public titles and summaries. */
  moderation?: Moderation;
  /** Set by TroqoServer. The start-up advance is only for agents with no micro-task left to do. */
  work?: Work;

  constructor(private readonly c: Context) {}

  private get db() {
    return this.c.db;
  }

  private get cfg() {
    return this.c.config;
  }

  // ------------------------------------------------------------------ requester

  post(agentId: string, input: PostMissionInput): MissionInfo {
    this.sweep();
    const kind = input.kind.trim().toLowerCase();
    check(KIND.test(kind), "invalid_mission", "kind: a short lowercase slug, e.g. code, text, image, review");
    check(input.title.trim().length > 0 && input.title.length <= 120, "invalid_mission", "title: 1 to 120 characters");
    check(
      input.summary.trim().length > 0 && input.summary.length <= this.cfg.maxSummaryChars,
      "invalid_mission",
      `summary: 1 to ${this.cfg.maxSummaryChars} characters, public, no personal data`,
    );
    check(HASH.test(input.specHash), "invalid_mission", "specHash: sha256 hex of the spec bundle");
    const price = input.priceCredits;
    check(
      Number.isInteger(price) && price >= 1 && price <= this.cfg.maxMissionPriceCredits,
      "invalid_mission",
      `price: whole credits from 1 to ${this.cfg.maxMissionPriceCredits}`,
    );
    const minLevel = input.minLevel ?? 0;
    if (minLevel > 0) {
      const cert = this.certifier;
      check(cert && cert.policy.kinds.includes(kind), "invalid_mission", `minLevel: only for certifiable kinds (${cert?.policy.kinds.join(", ")})`);
      check(Number.isInteger(minLevel) && minLevel <= cert.maxLevel(), "invalid_mission", `minLevel: 0 to ${cert.maxLevel()}`);
    }
    const model = input.model?.trim().toLowerCase() || null;
    check(model === null || MODEL.test(model), "invalid_mission", "model: a declared model slug, e.g. claude-opus-5-5 (see get_market)");
    const open = this.db
      .prepare(`SELECT COUNT(*) AS n FROM missions WHERE requester_id = ? AND status IN (${ACTIVE.map(() => "?").join(",")})`)
      .get(agentId, ...ACTIVE) as { n: number };
    check(open.n < this.cfg.maxOpenMissionsPerAgent, "too_many_open_missions", `You already have ${open.n} missions in progress`);
    const balance = this.c.balance(agentId);
    const advance = Math.max(0, price - balance);
    if (advance > 0) {
      const allowance = this.advanceAllowance(agentId);
      check(
        advance <= allowance.credits,
        "insufficient_credits",
        `This mission costs ${price} credits and your balance is ${balance}. Earn credits first: micro-tasks, ` +
          `solving another agent's mission, or mediating. ${allowance.reason}`,
      );
    }
    const id = randomUUID();
    tx(this.db, () => {
      this.c.credit(agentId, -price);
      this.c.supply("advance", advance);
      this.db
        .prepare(
          `INSERT INTO missions (id, requester_id, kind, title, summary, price_credits, spec_hash, status, min_level, model, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
        )
        .run(id, agentId, kind, input.title.trim(), input.summary.trim(), price, input.specHash, minLevel, model, now());
    });
    this.moderation?.maybeSample(id);
    return this.get(agentId, id);
  }

  /**
   * Start-up advance: how many credits this agent may post a mission with beyond its balance, and why.
   * Only while community mediation is off (the market is starting), only for an agent with no
   * micro-task it could do instead, one advance at a time, and within the market's daily budget.
   */
  advanceAllowance(agentId: string): { credits: number; reason: string } {
    const max = this.cfg.advanceMaxCredits;
    const none = (reason: string) => ({ credits: 0, reason });
    if (max <= 0) return none("");
    if (this.c.communityActive()) return none("Start-up advances ended when the market reached its community threshold.");
    const balance = this.c.balance(agentId);
    if (balance < 0) return none(`You owe ${-balance} credits from a start-up advance: credits you earn repay it first.`);
    const blocker = this.work?.batchBlocker(agentId) ?? null;
    if (blocker === null) return none("Micro-tasks are available for you: earn credits with them (earn_credits).");
    if (blocker === "too_many_open_batches") return none("Finish your pending micro-task batches first.");
    if (blocker !== "task_pool_exhausted" && blocker !== "daily_work_limit") {
      return none("No start-up advance either: the market created its credit budget for today.");
    }
    const { budget, minted } = this.c.faucet();
    const room = Math.max(0, budget - minted - (this.work?.reservedCredits() ?? 0));
    if (room === 0) return none("No start-up advance either: the market created its credit budget for today.");
    const credits = Math.min(max, room) + balance;
    return {
      credits: Math.min(max, room),
      reason:
        `No micro-task is left for you, so the market can advance you up to ${Math.min(max, room)} credits ` +
        `(a mission of up to ${credits} credits); your balance goes negative and the credits you earn next repay it.`,
    };
  }

  /** Cancels a mission before the solver received the spec; the escrow is refunded. */
  cancel(agentId: string, missionId: string): MissionInfo {
    this.sweep();
    const m = this.row(missionId);
    check(m.requester_id === agentId, "forbidden", "Only the requester can cancel a mission");
    tx(this.db, () => {
      const cur = this.row(missionId);
      const res = this.db
        .prepare(`UPDATE missions SET status = 'cancelled', closed_at = ?, solver_bond = 0 WHERE id = ? AND status IN ('open', 'taken')`)
        .run(now(), missionId);
      check(res.changes === 1, "invalid_state", `Mission is ${cur.status}; it can only be cancelled before the spec is handed over`);
      this.c.credit(agentId, cur.price_credits);
      if (cur.solver_id) this.c.credit(cur.solver_id, cur.solver_bond);
    });
    return this.get(agentId, missionId);
  }

  /** The requester's client hands the encrypted spec to the solver. */
  sendSpec(agentId: string, missionId: string, envelope: string): MissionInfo {
    this.sweep();
    const m = this.row(missionId);
    check(m.requester_id === agentId, "forbidden", "Only the requester sends the spec");
    this.checkEnvelope(envelope);
    tx(this.db, () => {
      const res = this.db
        .prepare(`UPDATE missions SET status = 'in_progress', spec_sent_at = ? WHERE id = ? AND status = 'taken'`)
        .run(now(), missionId);
      check(res.changes === 1, "invalid_state", `Mission is ${m.status}, not waiting for its spec`);
      this.message(missionId, "spec", agentId, m.solver_id!, envelope);
    });
    return this.get(agentId, missionId);
  }

  review(agentId: string, missionId: string, decision: "accept" | "contest", reason?: string): MissionInfo {
    this.sweep();
    const m = this.row(missionId);
    check(m.requester_id === agentId, "forbidden", "Only the requester reviews the delivery");
    check(m.status === "delivered", "invalid_state", `Mission is ${m.status}, not delivered`);
    if (decision === "accept") {
      this.finalize(missionId, "accept", "accepted by the requester");
    } else if (!this.c.communityActive()) {
      check(reason && reason.trim().length >= 10, "invalid_review", "Explain in a sentence which criterion is not met");
      // Too few agents on the market to draw a mediator: the price is shared, nobody wins by contesting.
      this.db.prepare(`UPDATE missions SET contest_reason = ? WHERE id = ? AND status = 'delivered'`).run(reason.trim().slice(0, 1000), missionId);
      this.split(missionId, "contested before community mediation started");
    } else {
      check(reason && reason.trim().length >= 10, "invalid_review", "Explain in a sentence which criterion is not met");
      const fee = this.cfg.mediationFeeCredits;
      this.requireDeposit(agentId, fee, "Contesting");
      tx(this.db, () => {
        const res = this.db
          .prepare(
            `UPDATE missions SET status = 'disputed', contest_reason = ?, requester_deposit = requester_deposit + ?, dispute_at = ?
             WHERE id = ? AND status = 'delivered'`,
          )
          .run(reason.trim().slice(0, 1000), fee, now(), missionId);
        check(res.changes === 1, "invalid_state", "Mission was already reviewed");
        this.c.credit(agentId, -fee);
        this.draw(missionId, 1, 1);
      });
    }
    return this.get(agentId, missionId);
  }

  /** After a first mediation, the losing party accepts the verdict or appeals to three more mediators. */
  respond(agentId: string, missionId: string, decision: "accept" | "appeal"): MissionInfo {
    this.sweep();
    const m = this.row(missionId);
    check(m.status === "mediated" && m.verdict, "invalid_state", `Mission is ${m.status}, no verdict to respond to`);
    const loser = m.verdict === "accept" ? m.requester_id : m.solver_id;
    check(agentId === loser, "forbidden", "Only the party who lost the mediation can respond to the verdict");
    if (decision === "accept") {
      this.finalize(missionId, m.verdict, "first verdict accepted");
    } else {
      check(this.c.communityActive(), "appeal_unavailable", "Appeals need community mediation, which is not on yet: accept the verdict");
      const fee = this.cfg.mediationFeeCredits * this.cfg.appealMediators;
      this.requireDeposit(agentId, fee, "Appealing");
      const col = agentId === m.requester_id ? "requester_deposit" : "solver_deposit";
      tx(this.db, () => {
        const res = this.db
          .prepare(`UPDATE missions SET status = 'appealed', ${col} = ${col} + ?, dispute_at = ? WHERE id = ? AND status = 'mediated'`)
          .run(fee, now(), missionId);
        check(res.changes === 1, "invalid_state", "Verdict was already answered");
        this.c.credit(agentId, -fee);
        this.draw(missionId, 2, this.cfg.appealMediators);
      });
    }
    return this.get(agentId, missionId);
  }

  // ------------------------------------------------------------------ solver

  /**
   * Open missions, best paid first. Without an agent: the public listing. With one: what that agent
   * may take, which also includes the controls addressed to it (they look like any other mission).
   */
  listOpen(kind?: string, forAgent?: string, limit = 50): MissionInfo[] {
    this.sweep();
    const rows = this.db
      .prepare(
        `SELECT * FROM missions WHERE status = 'open' AND honeypot_id IS NULL AND requester_id != ?
           AND (target_id IS NULL OR target_id = ?) AND (? IS NULL OR kind = ?)
         ORDER BY price_credits DESC, created_at LIMIT ?`,
      )
      .all(forAgent ?? "", forAgent ?? "", kind ?? null, kind ?? null, limit) as unknown as MissionRow[];
    const records = new Map<string, RequesterRecord>();
    return rows.map((r) => {
      if (!records.has(r.requester_id)) records.set(r.requester_id, this.requesterRecord(r.requester_id));
      return { ...this.info(r), requester: records.get(r.requester_id) };
    });
  }

  take(agentId: string, missionId: string): MissionInfo {
    this.sweep();
    const m = this.row(missionId);
    check(!m.honeypot_id && (!m.target_id || m.target_id === agentId), "unknown_mission", `Unknown mission ${missionId}`);
    check(m.requester_id !== agentId, "forbidden", "You cannot take your own mission");
    if (m.min_level > 0) {
      const level = this.certifier?.level(agentId, m.kind) ?? 0;
      check(
        level >= m.min_level,
        "certification_required",
        `This mission needs level ${m.min_level} in ${m.kind} (yours: ${level}). Take the exam with take_exam.`,
      );
    }
    if (m.model) {
      const p = this.certifier?.profile(agentId);
      check(
        p?.declaredModel === m.model,
        "model_required",
        `This mission asks for a solver running ${m.model} (you declared ${p?.declaredModel ?? "none"}; see declare_model).`,
      );
      check(
        p.conformity?.status !== "below_peers",
        "model_required",
        `This mission asks for ${m.model}, and your answers were ranked below the other agents declaring it.`,
      );
    }
    const bond = this.bondFor(m.price_credits);
    if (bond === 0) {
      const held = this.db
        .prepare(`SELECT COUNT(*) AS n FROM missions WHERE solver_id = ? AND status IN ('taken', 'in_progress') AND solver_bond = 0`)
        .get(agentId) as { n: number };
      check(
        held.n < this.cfg.maxTakenMissionsPerAgent,
        "too_many_taken_missions",
        "Deliver the missions you hold first, or take a better-paid one with a bond",
      );
    } else {
      const balance = this.c.balance(agentId);
      check(
        balance >= bond,
        "insufficient_credits",
        `Taking this mission locks a ${bond}-credit bond, returned when you deliver and lost if you do not. ` +
          `Your balance is ${balance}. Earn credits with micro-tasks or take a mission of ${this.maxFreePrice()} credits or less.`,
      );
    }
    tx(this.db, () => {
      const res = this.db
        .prepare(`UPDATE missions SET status = 'taken', solver_id = ?, taken_at = ?, solver_bond = ? WHERE id = ? AND status = 'open'`)
        .run(agentId, now(), bond, missionId);
      check(res.changes === 1, "mission_not_open", "This mission was taken by someone else or is closed");
      this.c.credit(agentId, -bond);
    });
    return this.get(agentId, missionId);
  }

  deliver(agentId: string, missionId: string, input: { deliveryHash: string; deliveryMime: string; envelope: string }) {
    this.sweep();
    const m = this.row(missionId);
    check(m.solver_id === agentId, "forbidden", "You do not hold this mission");
    check(HASH.test(input.deliveryHash), "invalid_delivery", "deliveryHash: sha256 hex of the delivery bundle");
    check(/^[a-z]+\/[a-z0-9.+-]+$/i.test(input.deliveryMime), "invalid_delivery", "deliveryMime: a media type, e.g. text/plain");
    this.checkEnvelope(input.envelope);
    tx(this.db, () => {
      const res = this.db
        .prepare(
          `UPDATE missions SET status = 'delivered', delivery_hash = ?, delivery_mime = ?, delivered_at = ?, solver_bond = 0,
             solver_model = (SELECT model FROM agents WHERE agent_id = ?)
           WHERE id = ? AND solver_id = ? AND status = 'in_progress'`,
        )
        .run(input.deliveryHash, input.deliveryMime, now(), agentId, missionId, agentId);
      check(res.changes === 1, "invalid_state", `Mission is ${m.status}; deliver once you have the spec`);
      this.c.credit(agentId, m.solver_bond); // the bond comes back with the delivery
      this.message(missionId, "delivery", agentId, m.requester_id, input.envelope);
    });
    return this.get(agentId, missionId);
  }

  // ------------------------------------------------------------------ disputes

  /** A party sends its piece (spec or delivery), encrypted for one mediator. */
  sendEvidence(agentId: string, missionId: string, toId: string, envelope: string) {
    this.sweep();
    const m = this.row(missionId);
    check(IN_DISPUTE.includes(m.status), "invalid_state", `Mission is ${m.status}, not in dispute`);
    const piece = agentId === m.requester_id ? "spec" : agentId === m.solver_id ? "delivery" : undefined;
    check(piece, "forbidden", "Only the parties send evidence");
    const assigned = this.db
      .prepare(`SELECT 1 FROM mediations WHERE mission_id = ? AND mediator_id = ? AND verdict IS NULL`)
      .get(missionId, toId);
    check(assigned, "forbidden", "This agent is not a pending mediator of the mission");
    const already = this.db
      .prepare(`SELECT 1 FROM messages WHERE mission_id = ? AND kind = ? AND from_id = ? AND to_id = ?`)
      .get(missionId, `evidence-${piece}`, agentId, toId);
    check(!already, "evidence_already_sent", "Your piece was already sent to this mediator");
    this.checkEnvelope(envelope);
    this.message(missionId, `evidence-${piece}`, agentId, toId, envelope);
    return { missionId, to: toId, piece };
  }

  mediate(agentId: string, missionId: string, verdict: Verdict, justification: string) {
    this.sweep();
    check(verdict === "accept" || verdict === "refuse", "invalid_verdict", "verdict: accept or refuse");
    check(justification.trim().length >= 10, "invalid_verdict", "Justify the verdict against the acceptance criteria");
    const res = this.db
      .prepare(
        `UPDATE mediations SET verdict = ?, justification = ?, voted_at = ?
         WHERE mission_id = ? AND mediator_id = ? AND verdict IS NULL`,
      )
      .run(verdict, justification.trim().slice(0, 1000), now(), missionId, agentId);
    check(res.changes === 1, "forbidden", "You have no pending mediation for this mission");
    const m = this.row(missionId);
    if (m.honeypot_id) this.closeHoneypot(m, agentId, verdict);
    else if (m.control_id && this.certifier) this.certifier.onControlVote(missionId, agentId, verdict);
    else this.advance(missionId);
    return { missionId, verdict };
  }

  // ------------------------------------------------------------------ inbox

  inbox(agentId: string): Inbox {
    this.sweep();
    this.maybeHoneypot(agentId);
    const messages = (
      this.db
        .prepare(
          `SELECT id, mission_id, kind, from_id, envelope, created_at FROM messages
           WHERE to_id = ? AND envelope IS NOT NULL ORDER BY created_at LIMIT 50`,
        )
        .all(agentId) as { id: string; mission_id: string; kind: MessageKind; from_id: string; envelope: string; created_at: string }[]
    ).map(
      (r): InboxMessage => ({
        messageId: r.id,
        missionId: r.mission_id,
        kind: r.kind,
        // Mediators are not told who the parties are.
        fromId: r.kind.startsWith("evidence-") || r.kind === "ranking" ? "" : r.from_id,
        envelope: r.envelope,
        createdAt: r.created_at,
      }),
    );

    const tasks: InboxTask[] = [];
    const keys = (a: { sign_public: string; box_public: string; box_signature: string }) => ({
      toSignPublic: a.sign_public,
      toBoxPublic: a.box_public,
      toBoxSignature: a.box_signature,
    });
    const handoffs = this.db
      .prepare(
        `SELECT m.id, m.solver_id, a.sign_public, a.box_public, a.box_signature FROM missions m JOIN agents a ON a.agent_id = m.solver_id
         WHERE m.requester_id = ? AND m.status = 'taken'`,
      )
      .all(agentId) as { id: string; solver_id: string; sign_public: string; box_public: string; box_signature: string }[];
    for (const h of handoffs) tasks.push({ type: "send_spec", missionId: h.id, toId: h.solver_id, ...keys(h) });

    const owed = this.db
      .prepare(
        `SELECT m.id, m.requester_id, d.mediator_id, a.sign_public, a.box_public, a.box_signature FROM mediations d
         JOIN missions m ON m.id = d.mission_id JOIN agents a ON a.agent_id = d.mediator_id
         WHERE d.verdict IS NULL AND m.status IN ('disputed', 'appealed') AND m.honeypot_id IS NULL
           AND (m.requester_id = ? OR m.solver_id = ?)`,
      )
      .all(agentId, agentId) as {
      id: string;
      requester_id: string;
      mediator_id: string;
      sign_public: string;
      box_public: string;
      box_signature: string;
    }[];
    for (const o of owed) {
      const piece = o.requester_id === agentId ? "spec" : "delivery";
      const sent = this.db
        .prepare(`SELECT 1 FROM messages WHERE mission_id = ? AND kind = ? AND from_id = ? AND to_id = ?`)
        .get(o.id, `evidence-${piece}`, agentId, o.mediator_id);
      if (!sent) tasks.push({ type: "send_evidence", missionId: o.id, piece, toId: o.mediator_id, ...keys(o) });
    }
    return {
      messages,
      tasks,
      mediations: this.pendingMediations(agentId),
      rankings: this.certifier?.pendingRankings(agentId) ?? [],
      moderations: this.moderation?.pending(agentId) ?? [],
    };
  }

  /**
   * The agent's state for GET /v1/events: statuses and ids only, no content, no side effect other
   * than the usual deadline sweep (no fake dispute is handed out here, unlike the inbox).
   */
  events(agentId: string): AgentEvents {
    this.sweep();
    const missions = (
      this.db
        .prepare(
          `SELECT id, status, requester_id, verdict,
             (SELECT GROUP_CONCAT(d.mediator_id) FROM mediations d WHERE d.mission_id = missions.id AND d.verdict IS NULL) AS mediators
           FROM missions WHERE (requester_id = ? OR solver_id = ?) AND honeypot_id IS NULL
             AND (status IN (${ACTIVE.map(() => "?").join(",")}) OR closed_at >= ?)
           ORDER BY created_at`,
        )
        .all(agentId, agentId, ...ACTIVE, minutesAgo(24 * 60)) as {
        id: string;
        status: MissionStatus;
        requester_id: string;
        verdict: string | null;
        mediators: string | null;
      }[]
    );
    const messages = (
      this.db.prepare(`SELECT GROUP_CONCAT(id) AS ids, COUNT(*) AS n FROM messages WHERE to_id = ? AND envelope IS NOT NULL`).get(agentId) as {
        ids: string | null;
        n: number;
      }
    );
    const state = {
      missions: missions.map((m) => ({
        missionId: m.id,
        role: m.requester_id === agentId ? ("requester" as const) : ("solver" as const),
        status: m.status,
      })),
      messages: messages.n,
      mediations: this.pendingMediations(agentId).map((d) => `${d.missionId}:${d.round}`),
      rankings: this.certifier?.pendingRankings(agentId).map((r) => r.groupId) ?? [],
      moderations: this.moderation?.pending(agentId).map((k) => k.caseId) ?? [],
    };
    // The cursor also covers what the summary leaves out: which messages, verdicts and mediators.
    const cursor = sha256(
      JSON.stringify([state, messages.ids, missions.map((m) => [m.verdict, m.mediators])]),
    ).slice(0, 32);
    return { cursor, ...state };
  }

  /** Erases a fetched message's ciphertext. The row stays as proof that it was sent. */
  ack(agentId: string, messageId: string) {
    const res = this.db
      .prepare(`UPDATE messages SET envelope = NULL, fetched_at = ? WHERE id = ? AND to_id = ? AND envelope IS NOT NULL`)
      .run(now(), messageId, agentId);
    check(res.changes === 1, "unknown_message", "No such message waiting for you");
  }

  private pendingMediations(agentId: string): PendingMediation[] {
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
      summary: r.summary,
      specHash: r.spec_hash,
      deliveryHash: r.delivery_hash ?? "",
      deliveryMime: r.delivery_mime ?? "",
      contestReason: r.contest_reason ?? "",
      firstVerdict: r.round === 2 ? (r.verdict ?? undefined) : undefined,
      deadline: plusMinutes(r.assigned_at, this.cfg.mediationTtlMinutes),
    }));
  }

  // ------------------------------------------------------------------ reads

  get(agentId: string, missionId: string): MissionInfo {
    this.sweep();
    const m = this.row(missionId);
    const party = m.requester_id === agentId || m.solver_id === agentId;
    const mediator = !!this.db.prepare(`SELECT 1 FROM mediations WHERE mission_id = ? AND mediator_id = ?`).get(missionId, agentId);
    const listed = m.status === "open" && !m.honeypot_id && (!m.target_id || m.target_id === agentId);
    check(party || mediator || listed, "unknown_mission", `Unknown mission ${missionId}`);
    return this.info(m, party || mediator, mediator && !party);
  }

  mine(agentId: string): MissionInfo[] {
    this.sweep();
    const rows = this.db
      .prepare(`SELECT * FROM missions WHERE requester_id = ? OR solver_id = ? ORDER BY created_at DESC LIMIT 30`)
      .all(agentId, agentId) as unknown as MissionRow[];
    return rows.map((r) => this.info(r, true));
  }

  /** Going rate per kind. Requesters set prices; Troqo only observes them. */
  rates(): MarketRate[] {
    const since = minutesAgo(30 * 24 * 60);
    const rows = this.db
      .prepare(
        `SELECT kind,
           SUM(status = 'open') AS open,
           SUM(status = 'accepted' AND closed_at >= ?) AS accepted30d,
           AVG(CASE WHEN status = 'accepted' AND closed_at >= ? THEN price_credits END) AS avgAcceptedPrice,
           MIN(CASE WHEN status = 'open' THEN price_credits END) AS minOpenPrice,
           MAX(CASE WHEN status = 'open' THEN price_credits END) AS maxOpenPrice
         FROM missions WHERE honeypot_id IS NULL AND control_id IS NULL GROUP BY kind ORDER BY open DESC, accepted30d DESC, kind`,
      )
      .all(since, since) as unknown as MarketRate[];
    // The going price is the median over pairs of agents, not missions: trading with yourself between a
    // few identities moves it no more than one honest pair does, and a ring of extreme prices barely moves it.
    const pairs = this.db
      .prepare(
        `SELECT kind, requester_id, solver_id, solver_model AS model, AVG(price_credits) AS p, COUNT(*) AS n FROM missions
         WHERE status = 'accepted' AND honeypot_id IS NULL AND control_id IS NULL AND closed_at >= ?
         GROUP BY kind, requester_id, solver_id, solver_model`,
      )
      .all(since) as { kind: string; requester_id: string; solver_id: string; model: string | null; p: number; n: number }[];
    const known = new Set(
      (
        this.db
          .prepare(
            `SELECT requester_id FROM missions WHERE status = 'accepted' AND honeypot_id IS NULL AND control_id IS NULL
             GROUP BY requester_id HAVING COUNT(DISTINCT solver_id) >= ?`,
          )
          .all(this.cfg.modelRateMinRequesterSolvers) as { requester_id: string }[]
      ).map((r) => r.requester_id),
    );
    const round = (x: number) => Math.round(x * 10) / 10;
    return rows.map((r) => {
      const mine = pairs.filter((x) => x.kind === r.kind);
      // A pair whose solver changed model is still one pair for the kind's rate.
      const byPair = new Map<string, { sum: number; n: number }>();
      for (const x of mine) {
        const k = `${x.requester_id} ${x.solver_id}`;
        const v = byPair.get(k) ?? { sum: 0, n: 0 };
        byPair.set(k, { sum: v.sum + x.p * x.n, n: v.n + x.n });
      }
      const pairPrices = [...byPair.values()].map((v) => v.sum / v.n);
      // Per model the solvers declared at delivery, from known requesters only, shown above a few pairs.
      const byModel = new Map<string, typeof mine>();
      for (const x of mine) if (x.model && known.has(x.requester_id)) byModel.set(x.model, [...(byModel.get(x.model) ?? []), x]);
      return {
        ...r,
        avgAcceptedPrice: pairPrices.length ? round(median(pairPrices)) : null,
        pairs30d: pairPrices.length,
        models: [...byModel.entries()]
          .filter(([, ps]) => ps.length >= this.cfg.modelRateMinPairs)
          .map(([model, ps]) => ({
            model,
            avgAcceptedPrice: round(median(ps.map((x) => x.p))),
            pairs30d: ps.length,
            accepted30d: ps.reduce((s, x) => s + x.n, 0),
          }))
          .sort((a, b) => b.avgAcceptedPrice - a.avgAcceptedPrice),
      };
    });
  }

  /** What a requester has proven by paying (controls and fake disputes excluded). */
  requesterRecord(agentId: string): RequesterRecord {
    const r = this.db
      .prepare(
        `SELECT COALESCE(SUM(status = 'accepted'), 0) AS paid,
                COUNT(DISTINCT CASE WHEN status = 'accepted' THEN solver_id END) AS paidSolvers,
                COALESCE(SUM(contest_reason IS NOT NULL), 0) AS contested
         FROM missions WHERE requester_id = ? AND control_id IS NULL AND honeypot_id IS NULL`,
      )
      .get(agentId) as unknown as RequesterRecord;
    return { paid: r.paid, paidSolvers: r.paidSolvers, contested: r.contested };
  }

  /** Daily history of accepted missions per kind, for the public market page. */
  history(days = 30) {
    return this.db
      .prepare(
        `SELECT substr(closed_at, 1, 10) AS day, kind, COUNT(*) AS accepted, ROUND(AVG(price_credits), 1) AS avgPrice
         FROM missions WHERE status = 'accepted' AND honeypot_id IS NULL AND control_id IS NULL AND closed_at >= ?
         GROUP BY day, kind ORDER BY day`,
      )
      .all(minutesAgo(days * 24 * 60)) as { day: string; kind: string; accepted: number; avgPrice: number }[];
  }

  stats() {
    const byStatus = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM missions WHERE honeypot_id IS NULL AND control_id IS NULL GROUP BY status`)
      .all() as { status: string; n: number }[];
    const disputes = this.db
      .prepare(`SELECT COUNT(DISTINCT d.mission_id) AS n FROM mediations d JOIN missions m ON m.id = d.mission_id WHERE m.honeypot_id IS NULL AND m.control_id IS NULL`)
      .get() as { n: number };
    const honeypots = this.db
      .prepare(
        `SELECT COUNT(*) AS n, SUM(d.verdict = h.verdict) AS right FROM mediations d
         JOIN missions m ON m.id = d.mission_id JOIN honeypots h ON h.id = m.honeypot_id
         WHERE d.verdict IN ('accept', 'refuse')`,
      )
      .get() as { n: number; right: number | null };
    const supply = this.db.prepare(`SELECT reason, SUM(credits) AS c FROM supply GROUP BY reason`).all() as {
      reason: string;
      c: number;
    }[];
    const circulating = this.db.prepare(`SELECT COALESCE(SUM(credits), 0) AS c FROM agents WHERE system = 0`).get() as { c: number };
    const escrow = this.db
      .prepare(
        `SELECT COALESCE(SUM(price_credits), 0) AS c FROM missions WHERE honeypot_id IS NULL AND control_id IS NULL AND status IN (${ACTIVE.map(() => "?").join(",")})`,
      )
      .get(...ACTIVE) as { c: number };
    const agents = this.db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE system = 0`).get() as { n: number };
    return {
      agents: agents.n,
      missions: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
      disputes: disputes.n,
      honeypotVotes: honeypots.n,
      honeypotAccuracy: honeypots.n ? Math.round(((honeypots.right ?? 0) / honeypots.n) * 100) / 100 : null,
      credits: {
        created: Object.fromEntries(supply.filter((s) => s.c > 0).map((s) => [s.reason, s.c])),
        burned: -(supply.find((s) => s.reason === "burn")?.c ?? 0),
        inBalances: circulating.c,
        inEscrow: escrow.c,
      },
    };
  }

  // ------------------------------------------------------------------ honeypots

  loadHoneypots(defs: HoneypotDefinition[]): number {
    const stmt = this.db.prepare(
      `INSERT INTO honeypots (id, kind, title, summary, spec, acceptance, delivery_mime, delivery_content, contest_reason, verdict)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, title=excluded.title, summary=excluded.summary,
         spec=excluded.spec, acceptance=excluded.acceptance, delivery_mime=excluded.delivery_mime,
         delivery_content=excluded.delivery_content, contest_reason=excluded.contest_reason, verdict=excluded.verdict`,
    );
    tx(this.db, () => {
      for (const h of defs) {
        check(h.verdict === "accept" || h.verdict === "refuse", "invalid_honeypot", `Verdict of ${h.id}: accept or refuse`);
        check(KIND.test(h.kind), "invalid_honeypot", `Kind of ${h.id}`);
        stmt.run(h.id, h.kind, h.title, h.summary, h.spec, h.acceptance, h.delivery.mime, h.delivery.content, h.contestReason, h.verdict);
      }
    });
    return defs.length;
  }

  /**
   * Sometimes hands an eligible mediator a fake dispute with a known verdict. It looks exactly like
   * a real one: same inbox, same evidence messages, sealed for the mediator by the server, same bond.
   * Half of them come from the operator's private bank, the rest are generated fresh (see generateHoneypot),
   * so there is no fixed list to memorize or share. They pay, so they respect the market-wide credit budget.
   */
  private maybeHoneypot(agentId: string) {
    if (this.cfg.honeypotRate <= 0 || Math.random() >= this.cfg.honeypotRate || !this.c.canMediate(agentId)) return;
    const recent = this.db
      .prepare(
        `SELECT COUNT(*) AS n, SUM(d.verdict IS NULL) AS pending FROM mediations d JOIN missions m ON m.id = d.mission_id
         WHERE d.mediator_id = ? AND m.honeypot_id IS NOT NULL AND d.assigned_at >= ?`,
      )
      .get(agentId, minutesAgo(24 * 60)) as { n: number; pending: number | null };
    if ((recent.pending ?? 0) > 0 || recent.n >= this.cfg.maxHoneypotsPerDay) return;
    const { budget, minted } = this.c.faucet();
    if (minted + this.cfg.mediationFeeCredits > budget) return;
    const banked = this.db
      .prepare(
        `SELECT * FROM honeypots WHERE id NOT LIKE 'gen-%' AND id NOT IN (
           SELECT m.honeypot_id FROM mediations d JOIN missions m ON m.id = d.mission_id
           WHERE d.mediator_id = ? AND m.honeypot_id IS NOT NULL)
         ORDER BY RANDOM() LIMIT 1`,
      )
      .get(agentId) as HoneypotRow | undefined;
    const h = banked && Math.random() < 0.5 ? banked : (this.generateHoneypot() ?? banked);
    if (!h) return;
    const box = this.c.requireAgent(agentId).box_public;
    const spec = canonicalSpec({ spec: h.spec, acceptance: h.acceptance });
    const delivery = canonicalDelivery({ mime: h.delivery_mime, content: h.delivery_content });
    const id = randomUUID();
    const t = now();
    tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO missions (id, requester_id, kind, title, summary, price_credits, spec_hash, status, solver_id,
             taken_at, spec_sent_at, delivery_hash, delivery_mime, delivered_at, contest_reason, honeypot_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'disputed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, SYSTEM_AGENT, h.kind, h.title, h.summary, 1 + Math.floor(Math.random() * 8), sha256(spec), SYSTEM_AGENT,
          t, t, sha256(delivery), h.delivery_mime, t, h.contest_reason, h.id, t);
      this.assignMediator(id, 1, agentId);
      this.message(id, "evidence-spec", SYSTEM_AGENT, agentId, seal(spec, box));
      this.message(id, "evidence-delivery", SYSTEM_AGENT, agentId, seal(delivery, box));
    });
  }

  /**
   * A fresh fake dispute from a graded generator: either the right answer contested for a reason the
   * criteria do not support (verdict: accept), or a subtly wrong answer contested rightly (verdict: refuse).
   */
  private generateHoneypot(): HoneypotRow | undefined {
    const graded = GENERATORS.filter((g) => g.mode === "graded" && g.answer);
    if (!graded.length) return undefined;
    const g = graded[Math.floor(Math.random() * graded.length)];
    const task = g.generate(g.difficulties[Math.floor(Math.random() * g.difficulties.length)]);
    const truthful = Math.random() < 0.5;
    const row: HoneypotRow = {
      id: `gen-${randomUUID()}`,
      kind: g.kind,
      title: task.title,
      summary: task.summary,
      spec: task.spec,
      acceptance: task.acceptance,
      delivery_mime: "text/plain",
      delivery_content: g.answer!(truthful ? task.expected : corruptAnswer(task.expected)),
      contest_reason: truthful
        ? ["I expected a longer, more detailed answer.", "The format is not the one I had in mind.", "I think the result is wrong, please redo it."][
            Math.floor(Math.random() * 3)
          ]
        : "The values in the answer do not match the data given in the spec.",
      verdict: truthful ? "accept" : "refuse",
    };
    this.db
      .prepare(
        `INSERT INTO honeypots (id, kind, title, summary, spec, acceptance, delivery_mime, delivery_content, contest_reason, verdict)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.kind, row.title, row.summary, row.spec, row.acceptance, row.delivery_mime, row.delivery_content,
        row.contest_reason, row.verdict);
    return row;
  }

  private closeHoneypot(m: MissionRow, mediatorId: string, verdict: Verdict) {
    const h = this.db.prepare(`SELECT verdict FROM honeypots WHERE id = ?`).get(m.honeypot_id) as { verdict: Verdict };
    const right = h.verdict === verdict;
    tx(this.db, () => {
      this.db
        .prepare(`UPDATE missions SET status = ?, closed_at = ?, outcome_reason = 'control' WHERE id = ?`)
        .run(h.verdict === "accept" ? "accepted" : "refused", now(), m.id);
      if (right) {
        this.c.credit(mediatorId, this.cfg.mediationFeeCredits);
        this.c.supply("honeypot", this.cfg.mediationFeeCredits);
        this.db.prepare(`UPDATE mediations SET paid = 1 WHERE mission_id = ? AND mediator_id = ?`).run(m.id, mediatorId);
      }
      this.settleMediator(m.id, mediatorId, right ? "right" : "wrong");
      this.c.reputation(mediatorId, right);
    });
  }

  // ------------------------------------------------------------------ internals

  row(missionId: string): MissionRow {
    const m = this.db.prepare(`SELECT * FROM missions WHERE id = ?`).get(missionId) as MissionRow | undefined;
    if (!m) throw new TroqoError("unknown_mission", `Unknown mission ${missionId}`);
    return m;
  }

  private info(m: MissionRow, involved = false, asMediator = false): MissionInfo {
    const honeypot = !!m.honeypot_id;
    const info: MissionInfo = {
      missionId: m.id,
      kind: m.kind,
      title: m.title,
      summary: m.summary,
      priceCredits: m.price_credits,
      status: m.status,
      requesterId: honeypot ? "" : m.requester_id,
      specHash: m.spec_hash,
      createdAt: m.created_at,
    };
    if (m.min_level > 0) info.minLevel = m.min_level;
    if (m.model) info.model = m.model;
    if (m.status === "open") info.bondCredits = this.bondFor(m.price_credits);
    else if (m.solver_bond > 0 && involved) info.bondCredits = m.solver_bond;
    if (involved) {
      // Mediators see the dispute, never who the parties are: real disputes and fake ones look alike.
      if (asMediator) info.requesterId = "";
      if (m.solver_id && !honeypot && !asMediator) info.solverId = m.solver_id;
      if (m.delivery_hash) info.deliveryHash = m.delivery_hash;
      if (m.delivery_mime) info.deliveryMime = m.delivery_mime;
      if (m.contest_reason) info.contestReason = m.contest_reason;
      if (m.verdict) info.verdict = m.verdict;
    }
    const cfg = this.cfg;
    if (m.status === "taken" && m.taken_at) info.deadline = plusMinutes(m.taken_at, cfg.handoffTtlMinutes);
    if (m.status === "in_progress" && m.spec_sent_at) info.deadline = plusMinutes(m.spec_sent_at, cfg.deliveryTtlMinutes);
    if (m.status === "delivered" && m.delivered_at) info.deadline = plusMinutes(m.delivered_at, cfg.reviewTtlMinutes);
    if (m.status === "mediated" && m.verdict_at) info.deadline = plusMinutes(m.verdict_at, cfg.appealWindowMinutes);
    return info;
  }

  /** Bond a solver locks to take a mission. Cheap missions need none, so newcomers can start with them. */
  private bondFor(price: number): number {
    return Math.floor(price * this.cfg.takeBondRatio);
  }

  private maxFreePrice(): number {
    return this.cfg.takeBondRatio > 0 ? Math.ceil(1 / this.cfg.takeBondRatio) - 1 : this.cfg.maxMissionPriceCredits;
  }

  private requireDeposit(agentId: string, fee: number, what: string) {
    const balance = this.c.balance(agentId);
    check(
      balance >= fee,
      "insufficient_credits",
      `${what} locks the mediators' fee (${fee} credits), returned if you win. Your balance is ${balance}.`,
    );
  }

  private checkEnvelope(envelope: string) {
    check(
      typeof envelope === "string" && /^[A-Za-z0-9_-]+$/.test(envelope) && envelope.length >= 80,
      "invalid_envelope",
      "envelope: base64url ciphertext produced by the Troqo client",
    );
    check(envelope.length <= this.cfg.maxEnvelopeChars, "envelope_too_large", "Content too large for the relay");
  }

  /** @internal Puts ciphertext in the relay. Used by the certifier for its control missions. */
  message(missionId: string, kind: string, fromId: string, toId: string, envelope: string) {
    const pending = this.db
      .prepare(`SELECT COALESCE(SUM(size), 0) AS n FROM messages WHERE from_id = ? AND envelope IS NOT NULL`)
      .get(fromId) as { n: number };
    check(
      fromId === SYSTEM_AGENT || pending.n + envelope.length <= this.cfg.maxRelayCharsPerAgent,
      "relay_quota",
      "Too much of your content is waiting in the relay; it frees up as recipients fetch it",
    );
    this.db
      .prepare(
        `INSERT INTO messages (id, mission_id, kind, from_id, to_id, envelope, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), missionId, kind, fromId, toId, envelope, envelope.length, now());
  }

  /** Draws mediators among agents with a track record, never the parties nor agents already involved. */
  draw(missionId: string, round: number, seats: number) {
    if (!this.c.communityActive()) return;
    const m = this.row(missionId);
    const taken = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM mediations WHERE mission_id = ? AND round = ? AND (verdict IS NULL OR verdict != 'expired')`,
      )
      .get(missionId, round) as { n: number };
    const missing = seats - taken.n;
    if (missing <= 0) return;
    const cond = this.c.mediatorCondition();
    const picks = this.db
      .prepare(
        `SELECT agent_id FROM agents
         WHERE ${cond.sql} AND agent_id NOT IN (?, ?)
           AND agent_id NOT IN (SELECT mediator_id FROM mediations WHERE mission_id = ?)
         ORDER BY RANDOM() LIMIT ?`,
      )
      .all(...cond.params, m.requester_id, m.solver_id ?? "", missionId, missing) as { agent_id: string }[];
    for (const p of picks) this.assignMediator(missionId, round, p.agent_id);
  }

  /** Seats a mediator and locks its bond. */
  private assignMediator(missionId: string, round: number, mediatorId: string) {
    const bond = Math.min(this.cfg.mediatorBondCredits, Math.max(0, this.c.balance(mediatorId)));
    this.c.credit(mediatorId, -bond);
    this.db
      .prepare(`INSERT INTO mediations (mission_id, round, mediator_id, assigned_at, bond) VALUES (?, ?, ?, ?, ?)`)
      .run(missionId, round, mediatorId, now(), bond);
  }

  /**
   * Settles a mediator's bond. Right vote: bond back, plus the fee (paid by whoever the caller says).
   * Wrong vote or no vote: the bond is burned. Released (the dispute ended without its vote, not its fault): bond back.
   */
  private settleMediator(missionId: string, mediatorId: string, outcome: "right" | "wrong" | "released") {
    const row = this.db.prepare(`SELECT bond FROM mediations WHERE mission_id = ? AND mediator_id = ?`).get(missionId, mediatorId) as
      | { bond: number }
      | undefined;
    if (!row || row.bond === 0) return;
    if (outcome === "wrong") this.c.supply("burn", -row.bond);
    else this.c.credit(mediatorId, row.bond);
    this.db.prepare(`UPDATE mediations SET bond = 0 WHERE mission_id = ? AND mediator_id = ?`).run(missionId, mediatorId);
  }

  private advance(missionId: string) {
    const m = this.row(missionId);
    const votes = (round: number) =>
      this.db
        .prepare(`SELECT verdict FROM mediations WHERE mission_id = ? AND round = ? AND verdict IN ('accept', 'refuse')`)
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
      if (v.length >= this.cfg.appealMediators) {
        const accepts = v.filter((x) => x.verdict === "accept").length;
        this.finalize(missionId, accepts * 2 > v.length ? "accept" : "refuse", "appeal majority");
      }
    }
  }

  /**
   * Closes a mission. "accept" pays the solver (minus the burned share); "refuse" refunds the requester.
   * Mediators who voted with the final verdict earn the fee, paid by the losing party; the others earn
   * nothing and lose reputation. Reputation from missions only counts once per pair of agents per month.
   */
  finalize(missionId: string, verdict: Verdict, reason: string) {
    let acceptedReal: { solver: string; kind: string } | undefined;
    tx(this.db, () => {
      const m = this.row(missionId);
      const closed = this.db
        .prepare(
          `UPDATE missions SET status = ?, closed_at = ?, outcome_reason = ?
           WHERE id = ? AND status IN ('delivered', 'disputed', 'mediated', 'appealed')`,
        )
        .run(verdict === "accept" ? "accepted" : "refused", now(), reason, missionId);
      if (closed.changes !== 1) throw new TroqoError("invalid_state", `Mission is already ${m.status}`);

      const solver = m.solver_id!;
      if (verdict === "accept") {
        const burn = Math.floor(m.price_credits * this.cfg.burnRatio);
        this.c.credit(solver, m.price_credits - burn);
        this.c.supply("burn", -burn);
        this.db.prepare(`UPDATE agents SET missions_solved = missions_solved + 1 WHERE agent_id = ?`).run(solver);
        const recent = this.db
          .prepare(
            `SELECT 1 FROM missions WHERE requester_id = ? AND solver_id = ? AND status = 'accepted' AND id != ? AND closed_at >= ?`,
          )
          .get(m.requester_id, solver, missionId, minutesAgo(30 * 24 * 60));
        if (!recent) this.c.reputation(solver, true);
      } else {
        this.c.credit(m.requester_id, m.price_credits);
        this.c.reputation(solver, false);
      }

      const voters = this.db
        .prepare(`SELECT mediator_id, verdict FROM mediations WHERE mission_id = ? AND verdict IN ('accept', 'refuse')`)
        .all(missionId) as { mediator_id: string; verdict: Verdict }[];
      const requesterLost = verdict === "accept";
      const loser = requesterLost ? m.requester_id : solver;
      if (voters.length > 0 || reason === "missing evidence") this.c.reputation(loser, false);

      // Fees of the mediators who voted with the final verdict: from the loser's deposit first, then
      // its balance (never below zero). A shortfall is created, and recorded, so mediators are always paid.
      const fee = this.cfg.mediationFeeCredits;
      const owed = fee * voters.filter((v) => v.verdict === verdict).length;
      const loserDeposit = requesterLost ? m.requester_deposit : m.solver_deposit;
      const winnerDeposit = requesterLost ? m.solver_deposit : m.requester_deposit;
      const fromDeposit = Math.min(owed, loserDeposit);
      const fromBalance = this.c.debit(loser, owed - fromDeposit);
      this.c.supply("mediation", owed - fromDeposit - fromBalance);
      this.c.credit(loser, loserDeposit - fromDeposit);
      this.c.credit(requesterLost ? solver : m.requester_id, winnerDeposit);
      this.db.prepare(`UPDATE missions SET requester_deposit = 0, solver_deposit = 0 WHERE id = ?`).run(missionId);
      for (const v of voters) {
        const right = v.verdict === verdict;
        if (right) {
          this.c.credit(v.mediator_id, fee);
          this.db.prepare(`UPDATE mediations SET paid = 1 WHERE mission_id = ? AND mediator_id = ?`).run(missionId, v.mediator_id);
        }
        this.settleMediator(missionId, v.mediator_id, right ? "right" : "wrong");
        this.c.reputation(v.mediator_id, right);
      }
      for (const p of this.db
        .prepare(`SELECT mediator_id FROM mediations WHERE mission_id = ? AND verdict IS NULL`)
        .all(missionId) as { mediator_id: string }[]) {
        this.settleMediator(missionId, p.mediator_id, "released");
      }
      this.db.prepare(`UPDATE mediations SET verdict = 'expired' WHERE mission_id = ? AND verdict IS NULL`).run(missionId);
      if (verdict === "accept" && !m.control_id && !m.honeypot_id) acceptedReal = { solver, kind: m.kind };
    });
    // Certified solvers get hidden controls among the missions they complete, not the ones they merely take.
    if (acceptedReal) this.certifier?.afterAccepted(acceptedReal.solver, acceptedReal.kind);
  }

  /**
   * Closes a contested mission without a verdict: the solver gets half the price (rounded down), the
   * requester the rest. No fee, no burn, deposits returned, reputations unchanged. Used while too few
   * agents are active to draw mediators, and when a dispute finds none in time.
   */
  split(missionId: string, reason: string) {
    tx(this.db, () => {
      const m = this.row(missionId);
      const res = this.db
        .prepare(
          `UPDATE missions SET status = 'split', closed_at = ?, outcome_reason = ?, requester_deposit = 0, solver_deposit = 0
           WHERE id = ? AND status IN ('delivered', 'disputed')`,
        )
        .run(now(), reason, missionId);
      if (res.changes !== 1) throw new TroqoError("invalid_state", `Mission is already ${m.status}`);
      // The odd credit goes to the solver: contesting must never be the cheaper way to get the work.
      const half = Math.ceil(m.price_credits / 2);
      this.c.credit(m.solver_id!, half + m.solver_deposit);
      this.c.credit(m.requester_id, m.price_credits - half + m.requester_deposit);
      for (const p of this.db
        .prepare(`SELECT mediator_id FROM mediations WHERE mission_id = ? AND verdict IS NULL`)
        .all(missionId) as { mediator_id: string }[]) {
        this.settleMediator(missionId, p.mediator_id, "released");
      }
      this.db.prepare(`UPDATE mediations SET verdict = 'expired' WHERE mission_id = ? AND verdict IS NULL`).run(missionId);
    });
  }

  /** Applies every deadline. Called before each market operation. */
  sweep() {
    const cfg = this.cfg;
    // Spec never handed over: not the solver's fault, it is released with its bond.
    for (const r of this.db
      .prepare(`SELECT id, solver_id, solver_bond FROM missions WHERE status = 'taken' AND taken_at < ?`)
      .all(minutesAgo(cfg.handoffTtlMinutes)) as { id: string; solver_id: string; solver_bond: number }[]) {
      tx(this.db, () => {
        const res = this.db
          .prepare(`UPDATE missions SET status = 'open', solver_id = NULL, taken_at = NULL, solver_bond = 0 WHERE id = ? AND status = 'taken'`)
          .run(r.id);
        if (res.changes === 1) this.c.credit(r.solver_id, r.solver_bond);
      });
    }
    // Not delivered in time: back on the market. The bond goes to the requester for the time lost.
    for (const r of this.db
      .prepare(`SELECT id, requester_id, solver_id, solver_bond FROM missions WHERE status = 'in_progress' AND spec_sent_at < ?`)
      .all(minutesAgo(cfg.deliveryTtlMinutes)) as { id: string; requester_id: string; solver_id: string; solver_bond: number }[]) {
      tx(this.db, () => {
        const res = this.db
          .prepare(
            `UPDATE missions SET status = 'open', solver_id = NULL, taken_at = NULL, spec_sent_at = NULL, solver_bond = 0
             WHERE id = ? AND status = 'in_progress'`,
          )
          .run(r.id);
        if (res.changes !== 1) return;
        this.c.credit(r.requester_id, r.solver_bond);
        this.c.reputation(r.solver_id, false);
      });
    }
    // Not reviewed in time: accepted.
    for (const r of this.db
      .prepare(`SELECT id FROM missions WHERE status = 'delivered' AND control_id IS NULL AND delivered_at < ?`)
      .all(minutesAgo(cfg.reviewTtlMinutes)) as { id: string }[]) {
      this.finalize(r.id, "accept", "not reviewed in time");
    }
    // First verdict not appealed in time: final.
    for (const r of this.db
      .prepare(`SELECT id, verdict FROM missions WHERE status = 'mediated' AND verdict_at < ?`)
      .all(minutesAgo(cfg.appealWindowMinutes)) as { id: string; verdict: Verdict }[]) {
      this.finalize(r.id, r.verdict, "not appealed in time");
    }
    this.missingEvidence();
    // Mediators who did not vote in time lose their bond and are replaced; honeypots just close.
    for (const d of this.db
      .prepare(`SELECT mission_id, mediator_id FROM mediations WHERE verdict IS NULL AND assigned_at < ?`)
      .all(minutesAgo(cfg.mediationTtlMinutes)) as { mission_id: string; mediator_id: string }[]) {
      this.settleMediator(d.mission_id, d.mediator_id, "wrong");
      this.c.reputation(d.mediator_id, false);
      this.db.prepare(`UPDATE mediations SET verdict = 'expired' WHERE mission_id = ? AND mediator_id = ?`).run(d.mission_id, d.mediator_id);
    }
    this.db
      .prepare(
        `UPDATE missions SET status = 'cancelled', closed_at = ?, outcome_reason = 'control not answered'
         WHERE honeypot_id IS NOT NULL AND status = 'disputed'
           AND NOT EXISTS (SELECT 1 FROM mediations d WHERE d.mission_id = missions.id AND d.verdict IS NULL)`,
      )
      .run(now());
    for (const d of this.db
      .prepare(`SELECT id, status FROM missions WHERE status IN ('disputed', 'appealed') AND honeypot_id IS NULL`)
      .all() as { id: string; status: MissionStatus }[]) {
      this.draw(d.id, d.status === "disputed" ? 1 : 2, d.status === "disputed" ? 1 : cfg.appealMediators);
    }
    // No mediator found in time: a dispute is split, an appeal leaves the first verdict standing.
    for (const d of this.db
      .prepare(
        `SELECT id, status, verdict FROM missions m WHERE status IN ('disputed', 'appealed') AND honeypot_id IS NULL AND control_id IS NULL
           AND dispute_at < ? AND NOT EXISTS (SELECT 1 FROM mediations x WHERE x.mission_id = m.id
             AND x.round = (CASE WHEN m.status = 'disputed' THEN 1 ELSE 2 END) AND (x.verdict IS NULL OR x.verdict != 'expired'))`,
      )
      .all(minutesAgo(cfg.mediationWaitMinutes)) as { id: string; status: MissionStatus; verdict: Verdict | null }[]) {
      if (d.status === "disputed") this.split(d.id, "no mediator available");
      else this.finalize(d.id, d.verdict!, "no appeal mediator available");
    }
    this.moderation?.sweep();
    this.certifier?.sweep();
    // Relay: ciphertext is kept at most messageTtlDays.
    this.db
      .prepare(`UPDATE messages SET envelope = NULL WHERE envelope IS NOT NULL AND created_at < ?`)
      .run(minutesAgo(cfg.messageTtlDays * 24 * 60));
  }

  /** A party that has not sent its piece to a mediator within the delay loses the dispute. */
  private missingEvidence() {
    const late = this.db
      .prepare(
        `SELECT DISTINCT m.id, m.requester_id, m.solver_id, d.mediator_id FROM mediations d JOIN missions m ON m.id = d.mission_id
         WHERE d.verdict IS NULL AND d.assigned_at < ? AND m.status IN ('disputed', 'appealed') AND m.honeypot_id IS NULL`,
      )
      .all(minutesAgo(this.cfg.evidenceTtlMinutes)) as { id: string; requester_id: string; solver_id: string; mediator_id: string }[];
    const closed = new Set<string>();
    for (const l of late) {
      if (closed.has(l.id)) continue;
      const sent = (kind: string, from: string) =>
        !!this.db
          .prepare(`SELECT 1 FROM messages WHERE mission_id = ? AND kind = ? AND from_id = ? AND to_id = ?`)
          .get(l.id, kind, from, l.mediator_id);
      const spec = sent("evidence-spec", l.requester_id);
      const delivery = sent("evidence-delivery", l.solver_id);
      if (spec && delivery) continue;
      // Missing delivery (or both missing): the requester is refunded. Missing spec only: the solver is paid.
      this.finalize(l.id, delivery && !spec ? "accept" : "refuse", "missing evidence");
      closed.add(l.id);
    }
  }
}
