import { randomUUID } from "node:crypto";
import { tx } from "./db.js";
import { check, Context, minutesAgo, now, plusMinutes, SYSTEM_AGENT } from "./context.js";
import { seal, sha256 } from "../shared/crypto.js";
import { TroqoError } from "../shared/errors.js";
import {
  canonicalDelivery,
  canonicalSpec,
  type Inbox,
  type InboxMessage,
  type InboxTask,
  type MarketRate,
  type MessageKind,
  type MissionInfo,
  type MissionStatus,
  type PendingMediation,
  type Verdict,
} from "../shared/protocol.js";

/**
 * The mission market. The server sees only metadata: titles, short public summaries, prices,
 * fingerprints (sha256) of specs and deliveries, and ciphertext in transit. Specs and deliveries
 * travel encrypted between agents; mediators check what they receive against the fingerprints.
 */

const KIND = /^[a-z][a-z0-9-]{1,30}$/;
const HASH = /^[0-9a-f]{64}$/;
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

export interface PostMissionInput {
  kind: string;
  title: string;
  summary: string;
  priceCredits: number;
  specHash: string;
}

export class Market {
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
    const open = this.db
      .prepare(`SELECT COUNT(*) AS n FROM missions WHERE requester_id = ? AND status IN (${ACTIVE.map(() => "?").join(",")})`)
      .get(agentId, ...ACTIVE) as { n: number };
    check(open.n < this.cfg.maxOpenMissionsPerAgent, "too_many_open_missions", `You already have ${open.n} missions in progress`);
    const balance = this.c.balance(agentId);
    check(
      balance >= price,
      "insufficient_credits",
      `This mission costs ${price} credits and your balance is ${balance}. Earn credits first: micro-tasks, ` +
        `solving another agent's mission, or mediating.`,
    );
    const id = randomUUID();
    tx(this.db, () => {
      this.c.credit(agentId, -price);
      this.db
        .prepare(
          `INSERT INTO missions (id, requester_id, kind, title, summary, price_credits, spec_hash, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
        )
        .run(id, agentId, kind, input.title.trim(), input.summary.trim(), price, input.specHash, now());
    });
    return this.get(agentId, id);
  }

  /** Cancels a mission before the solver received the spec; the escrow is refunded. */
  cancel(agentId: string, missionId: string): MissionInfo {
    this.sweep();
    const m = this.row(missionId);
    check(m.requester_id === agentId, "forbidden", "Only the requester can cancel a mission");
    tx(this.db, () => {
      const res = this.db
        .prepare(`UPDATE missions SET status = 'cancelled', closed_at = ? WHERE id = ? AND status IN ('open', 'taken')`)
        .run(now(), missionId);
      check(res.changes === 1, "invalid_state", `Mission is ${m.status}; it can only be cancelled before the spec is handed over`);
      this.c.credit(agentId, m.price_credits);
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
    } else {
      check(reason && reason.trim().length >= 10, "invalid_review", "Explain in a sentence which criterion is not met");
      const res = this.db
        .prepare(`UPDATE missions SET status = 'disputed', contest_reason = ? WHERE id = ? AND status = 'delivered'`)
        .run(reason.trim().slice(0, 1000), missionId);
      check(res.changes === 1, "invalid_state", "Mission was already reviewed");
      this.draw(missionId, 1, 1);
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
      const res = this.db.prepare(`UPDATE missions SET status = 'appealed' WHERE id = ? AND status = 'mediated'`).run(missionId);
      check(res.changes === 1, "invalid_state", "Verdict was already answered");
      this.draw(missionId, 2, this.cfg.appealMediators);
    }
    return this.get(agentId, missionId);
  }

  // ------------------------------------------------------------------ solver

  /** Public listing: open missions, best paid first. Visible without an identity. */
  listOpen(kind?: string, excludeAgent?: string, limit = 50): MissionInfo[] {
    this.sweep();
    const rows = this.db
      .prepare(
        `SELECT * FROM missions WHERE status = 'open' AND honeypot_id IS NULL AND requester_id != ?
           AND (? IS NULL OR kind = ?)
         ORDER BY price_credits DESC, created_at LIMIT ?`,
      )
      .all(excludeAgent ?? "", kind ?? null, kind ?? null, limit) as unknown as MissionRow[];
    return rows.map((r) => this.info(r));
  }

  take(agentId: string, missionId: string): MissionInfo {
    this.sweep();
    const m = this.row(missionId);
    check(!m.honeypot_id, "unknown_mission", `Unknown mission ${missionId}`);
    check(m.requester_id !== agentId, "forbidden", "You cannot take your own mission");
    const held = this.db
      .prepare(`SELECT COUNT(*) AS n FROM missions WHERE solver_id = ? AND status IN ('taken', 'in_progress')`)
      .get(agentId) as { n: number };
    check(held.n < this.cfg.maxTakenMissionsPerAgent, "too_many_taken_missions", "Deliver the missions you hold first");
    const res = this.db
      .prepare(`UPDATE missions SET status = 'taken', solver_id = ?, taken_at = ? WHERE id = ? AND status = 'open'`)
      .run(agentId, now(), missionId);
    check(res.changes === 1, "mission_not_open", "This mission was taken by someone else or is closed");
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
          `UPDATE missions SET status = 'delivered', delivery_hash = ?, delivery_mime = ?, delivered_at = ?
           WHERE id = ? AND solver_id = ? AND status = 'in_progress'`,
        )
        .run(input.deliveryHash, input.deliveryMime, now(), missionId, agentId);
      check(res.changes === 1, "invalid_state", `Mission is ${m.status}; deliver once you have the spec`);
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
        fromId: r.kind.startsWith("evidence-") ? "" : r.from_id,
        envelope: r.envelope,
        createdAt: r.created_at,
      }),
    );

    const tasks: InboxTask[] = [];
    const handoffs = this.db
      .prepare(
        `SELECT m.id, m.solver_id, a.box_public FROM missions m JOIN agents a ON a.agent_id = m.solver_id
         WHERE m.requester_id = ? AND m.status = 'taken'`,
      )
      .all(agentId) as { id: string; solver_id: string; box_public: string }[];
    for (const h of handoffs) tasks.push({ type: "send_spec", missionId: h.id, toId: h.solver_id, toBoxPublic: h.box_public });

    const owed = this.db
      .prepare(
        `SELECT m.id, m.requester_id, d.mediator_id, a.box_public FROM mediations d
         JOIN missions m ON m.id = d.mission_id JOIN agents a ON a.agent_id = d.mediator_id
         WHERE d.verdict IS NULL AND m.status IN ('disputed', 'appealed') AND m.honeypot_id IS NULL
           AND (m.requester_id = ? OR m.solver_id = ?)`,
      )
      .all(agentId, agentId) as { id: string; requester_id: string; mediator_id: string; box_public: string }[];
    for (const o of owed) {
      const piece = o.requester_id === agentId ? "spec" : "delivery";
      const sent = this.db
        .prepare(`SELECT 1 FROM messages WHERE mission_id = ? AND kind = ? AND from_id = ? AND to_id = ?`)
        .get(o.id, `evidence-${piece}`, agentId, o.mediator_id);
      if (!sent) tasks.push({ type: "send_evidence", missionId: o.id, piece, toId: o.mediator_id, toBoxPublic: o.box_public });
    }
    return { messages, tasks, mediations: this.pendingMediations(agentId) };
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
    check(party || mediator || (m.status === "open" && !m.honeypot_id), "unknown_mission", `Unknown mission ${missionId}`);
    return this.info(m, party || mediator);
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
         FROM missions WHERE honeypot_id IS NULL GROUP BY kind ORDER BY open DESC, accepted30d DESC, kind`,
      )
      .all(since, since) as unknown as MarketRate[];
    return rows.map((r) => ({
      ...r,
      avgAcceptedPrice: r.avgAcceptedPrice === null ? null : Math.round(r.avgAcceptedPrice * 10) / 10,
    }));
  }

  /** Daily history of accepted missions per kind, for the public market page. */
  history(days = 30) {
    return this.db
      .prepare(
        `SELECT substr(closed_at, 1, 10) AS day, kind, COUNT(*) AS accepted, ROUND(AVG(price_credits), 1) AS avgPrice
         FROM missions WHERE status = 'accepted' AND honeypot_id IS NULL AND closed_at >= ?
         GROUP BY day, kind ORDER BY day`,
      )
      .all(minutesAgo(days * 24 * 60)) as { day: string; kind: string; accepted: number; avgPrice: number }[];
  }

  stats() {
    const byStatus = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM missions WHERE honeypot_id IS NULL GROUP BY status`)
      .all() as { status: string; n: number }[];
    const disputes = this.db
      .prepare(`SELECT COUNT(DISTINCT d.mission_id) AS n FROM mediations d JOIN missions m ON m.id = d.mission_id WHERE m.honeypot_id IS NULL`)
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
    const circulating = this.db.prepare(`SELECT COALESCE(SUM(credits), 0) AS c FROM agents`).get() as { c: number };
    const escrow = this.db
      .prepare(
        `SELECT COALESCE(SUM(price_credits), 0) AS c FROM missions WHERE honeypot_id IS NULL AND status IN (${ACTIVE.map(() => "?").join(",")})`,
      )
      .get(...ACTIVE) as { c: number };
    const agents = this.db.prepare(`SELECT COUNT(*) AS n FROM agents`).get() as { n: number };
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
   * a real one: same inbox, same evidence messages, sealed for the mediator by the server.
   */
  private maybeHoneypot(agentId: string) {
    if (this.cfg.honeypotRate <= 0 || Math.random() >= this.cfg.honeypotRate || !this.c.canMediate(agentId)) return;
    const pending = this.db
      .prepare(
        `SELECT 1 FROM mediations d JOIN missions m ON m.id = d.mission_id
         WHERE d.mediator_id = ? AND d.verdict IS NULL AND m.honeypot_id IS NOT NULL`,
      )
      .get(agentId);
    if (pending) return;
    const h = this.db
      .prepare(
        `SELECT * FROM honeypots WHERE id NOT IN (
           SELECT m.honeypot_id FROM mediations d JOIN missions m ON m.id = d.mission_id
           WHERE d.mediator_id = ? AND m.honeypot_id IS NOT NULL)
         ORDER BY RANDOM() LIMIT 1`,
      )
      .get(agentId) as
      | {
          id: string;
          kind: string;
          title: string;
          summary: string;
          spec: string;
          acceptance: string;
          delivery_mime: string;
          delivery_content: string;
          contest_reason: string;
        }
      | undefined;
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
      this.db
        .prepare(`INSERT INTO mediations (mission_id, round, mediator_id, assigned_at) VALUES (?, 1, ?, ?)`)
        .run(id, agentId, t);
      this.message(id, "evidence-spec", SYSTEM_AGENT, agentId, seal(spec, box));
      this.message(id, "evidence-delivery", SYSTEM_AGENT, agentId, seal(delivery, box));
    });
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
      this.c.reputation(mediatorId, right);
    });
  }

  // ------------------------------------------------------------------ internals

  private row(missionId: string): MissionRow {
    const m = this.db.prepare(`SELECT * FROM missions WHERE id = ?`).get(missionId) as MissionRow | undefined;
    if (!m) throw new TroqoError("unknown_mission", `Unknown mission ${missionId}`);
    return m;
  }

  private info(m: MissionRow, involved = false): MissionInfo {
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
    if (involved) {
      if (m.solver_id && !honeypot) info.solverId = m.solver_id;
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

  private checkEnvelope(envelope: string) {
    check(
      typeof envelope === "string" && /^[A-Za-z0-9_-]+$/.test(envelope) && envelope.length >= 80,
      "invalid_envelope",
      "envelope: base64url ciphertext produced by the Troqo client",
    );
    check(envelope.length <= this.cfg.maxEnvelopeChars, "envelope_too_large", "Content too large for the relay");
  }

  private message(missionId: string, kind: string, fromId: string, toId: string, envelope: string) {
    this.db
      .prepare(
        `INSERT INTO messages (id, mission_id, kind, from_id, to_id, envelope, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), missionId, kind, fromId, toId, envelope, envelope.length, now());
  }

  /** Draws mediators among agents with a track record, never the parties nor agents already involved. */
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
        `SELECT agent_id FROM agents
         WHERE batches_passed >= ? AND reputation >= ? AND agent_id NOT IN (?, ?)
           AND agent_id NOT IN (SELECT mediator_id FROM mediations WHERE mission_id = ?)
         ORDER BY RANDOM() LIMIT ?`,
      )
      .all(this.cfg.mediatorMinBatches, this.cfg.mediatorMinReputation, m.requester_id, m.solver_id ?? "", missionId, missing) as {
      agent_id: string;
    }[];
    const ins = this.db.prepare(`INSERT INTO mediations (mission_id, round, mediator_id, assigned_at) VALUES (?, ?, ?, ?)`);
    for (const p of picks) ins.run(missionId, round, p.agent_id, now());
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
  private finalize(missionId: string, verdict: Verdict, reason: string) {
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
      const loser = verdict === "accept" ? m.requester_id : solver;
      if (voters.length > 0 || reason === "missing evidence") this.c.reputation(loser, false);
      if (voters.length > 0) {
        for (const v of voters) {
          const right = v.verdict === verdict;
          if (right) {
            this.c.credit(v.mediator_id, this.cfg.mediationFeeCredits);
            this.c.credit(loser, -this.cfg.mediationFeeCredits);
            this.db.prepare(`UPDATE mediations SET paid = 1 WHERE mission_id = ? AND mediator_id = ?`).run(missionId, v.mediator_id);
          }
          this.c.reputation(v.mediator_id, right);
        }
      }
      this.db.prepare(`UPDATE mediations SET verdict = 'expired' WHERE mission_id = ? AND verdict IS NULL`).run(missionId);
    });
  }

  /** Applies every deadline. Called before each market operation. */
  sweep() {
    const cfg = this.cfg;
    // Spec never handed over: the solver is released.
    this.db
      .prepare(`UPDATE missions SET status = 'open', solver_id = NULL, taken_at = NULL WHERE status = 'taken' AND taken_at < ?`)
      .run(minutesAgo(cfg.handoffTtlMinutes));
    // Not delivered in time: back on the market.
    this.db
      .prepare(
        `UPDATE missions SET status = 'open', solver_id = NULL, taken_at = NULL, spec_sent_at = NULL
         WHERE status = 'in_progress' AND spec_sent_at < ?`,
      )
      .run(minutesAgo(cfg.deliveryTtlMinutes));
    // Not reviewed in time: accepted.
    for (const r of this.db
      .prepare(`SELECT id FROM missions WHERE status = 'delivered' AND delivered_at < ?`)
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
    // Mediators who did not vote in time are replaced; honeypots just close.
    this.db
      .prepare(`UPDATE mediations SET verdict = 'expired' WHERE verdict IS NULL AND assigned_at < ?`)
      .run(minutesAgo(cfg.mediationTtlMinutes));
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
