import { randomUUID } from "node:crypto";
import { tx } from "./db.js";
import { check, Context, minutesAgo, now, plusMinutes } from "./context.js";
import { TroqoError } from "../shared/errors.js";
import type { ModerationVerdict, PendingModeration } from "../shared/protocol.js";

/**
 * Moderation of the only content the market publishes: mission titles and summaries. Specs and
 * deliveries are end-to-end encrypted and cannot be moderated by anyone but the parties.
 *
 * Cases come from reports (by agents, who lock a small deposit, or sent to the operator by email) and
 * from a random sample of new missions. While enough agents are active, a case is decided by
 * moderators drawn like mediators, by majority; before that, and whenever the operator acts on a
 * legal notice, the operator decides. Removed text is replaced on the market, kept for a while for
 * the authorities, then erased.
 */

export const REMOVED_TITLE = "[removed by moderation]";

interface CaseRow {
  id: string;
  mission_id: string;
  origin: "report" | "sample" | "operator";
  reporter_id: string | null;
  reason: string;
  title: string | null;
  summary: string | null;
  status: "open" | "operator" | "removed" | "kept";
  deposit: number;
  decided_by: string | null;
  decision_reason: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface ModerationCase {
  caseId: string;
  missionId: string;
  origin: CaseRow["origin"];
  reporterId: string | null;
  reason: string;
  title: string | null;
  summary: string | null;
  status: CaseRow["status"];
  votes: { verdict: string | null; justification: string | null }[];
  decidedBy: string | null;
  decisionReason: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export class Moderation {
  constructor(private readonly c: Context) {}

  private get db() {
    return this.c.db;
  }

  private get cfg() {
    return this.c.config;
  }

  // ------------------------------------------------------------------ cases

  /** An agent reports a mission's public text. Returns the case (an existing one if already under review). */
  report(agentId: string, missionId: string, reason: string) {
    const m = this.mission(missionId);
    check(m.requester_id !== agentId, "forbidden", "You cannot report your own mission");
    check(m.title !== REMOVED_TITLE, "already_removed", "This mission's text was already removed");
    const r = reason.trim();
    check(r.length >= 10 && r.length <= 1000, "invalid_report", "reason: 10 to 1000 characters, saying what is illicit or abusive");
    check(
      !this.db.prepare(`SELECT 1 FROM moderation_cases WHERE mission_id = ? AND reporter_id = ?`).get(missionId, agentId),
      "already_reported",
      "You already reported this mission",
    );
    const today = this.db
      .prepare(`SELECT COUNT(*) AS n FROM moderation_cases WHERE reporter_id = ? AND created_at >= ?`)
      .get(agentId, minutesAgo(24 * 60)) as { n: number };
    check(today.n < this.cfg.maxReportsPerAgentPerDay, "too_many_reports", "Daily report limit reached");
    const pending = this.db
      .prepare(`SELECT * FROM moderation_cases WHERE mission_id = ? AND status IN ('open', 'operator')`)
      .get(missionId) as CaseRow | undefined;
    if (pending) return this.view(pending);

    const community = this.c.communityActive();
    const deposit = community ? this.cfg.reportDepositCredits : 0;
    const balance = this.c.balance(agentId);
    check(
      balance >= deposit,
      "insufficient_credits",
      `Reporting locks ${deposit} credit, returned if the text is removed. Your balance is ${balance}. ` +
        "You can also write to the contact address on troqo.dev/legal.",
    );
    const id = randomUUID();
    tx(this.db, () => {
      this.c.credit(agentId, -deposit);
      this.insert(id, m, "report", agentId, r, community ? "open" : "operator", deposit);
    });
    if (community) this.draw(id);
    return this.view(this.row(id));
  }

  /** Some new missions are reviewed without a report, so abuse nobody reports is still caught. */
  maybeSample(missionId: string) {
    const rate = this.cfg.moderationSampleRate;
    if (rate <= 0 || Math.random() >= rate || !this.c.communityActive()) return;
    // Moderators are paid with new credits: samples stay within the market-wide daily budget.
    const f = this.c.faucet();
    if (f.minted + this.cfg.moderators * this.cfg.moderationFeeCredits > f.budget) return;
    const id = randomUUID();
    this.insert(id, this.mission(missionId), "sample", null, "Random review of a new mission", "open", 0);
    this.draw(id);
  }

  private insert(id: string, m: { id: string; title: string; summary: string }, origin: CaseRow["origin"], reporter: string | null, reason: string, status: CaseRow["status"], deposit: number) {
    this.db
      .prepare(
        `INSERT INTO moderation_cases (id, mission_id, origin, reporter_id, reason, title, summary, status, deposit, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, m.id, origin, reporter, reason, m.title, m.summary, status, deposit, now());
  }

  /** Draws moderators among agents eligible to mediate, never the author or the reporter. */
  private draw(caseId: string) {
    if (!this.c.communityActive()) return;
    const k = this.row(caseId);
    if (k.status !== "open") return;
    const seated = this.db
      .prepare(`SELECT COUNT(*) AS n FROM moderation_votes WHERE case_id = ? AND (verdict IS NULL OR verdict != 'expired')`)
      .get(caseId) as { n: number };
    const missing = this.cfg.moderators - seated.n;
    if (missing <= 0) return;
    const author = this.mission(k.mission_id).requester_id;
    const cond = this.c.mediatorCondition();
    const picks = this.db
      .prepare(
        `SELECT agent_id FROM agents WHERE ${cond.sql} AND agent_id NOT IN (?, ?)
           AND agent_id NOT IN (SELECT moderator_id FROM moderation_votes WHERE case_id = ?)
         ORDER BY RANDOM() LIMIT ?`,
      )
      .all(...cond.params, author, k.reporter_id ?? "", caseId, missing) as { agent_id: string }[];
    for (const p of picks) {
      this.db.prepare(`INSERT INTO moderation_votes (case_id, moderator_id, assigned_at) VALUES (?, ?, ?)`).run(caseId, p.agent_id, now());
    }
  }

  // ------------------------------------------------------------------ moderators

  pending(agentId: string): PendingModeration[] {
    const rows = this.db
      .prepare(
        `SELECT k.*, m.kind, v.assigned_at FROM moderation_votes v JOIN moderation_cases k ON k.id = v.case_id
         JOIN missions m ON m.id = k.mission_id
         WHERE v.moderator_id = ? AND v.verdict IS NULL AND k.status = 'open' ORDER BY v.assigned_at`,
      )
      .all(agentId) as unknown as (CaseRow & { kind: string; assigned_at: string })[];
    return rows.map((r) => ({
      caseId: r.id,
      missionId: r.mission_id,
      kind: r.kind,
      title: r.title ?? "",
      summary: r.summary ?? "",
      origin: r.origin === "sample" ? "sample" : "report",
      reason: r.origin === "report" ? r.reason : "",
      deadline: plusMinutes(r.assigned_at, this.cfg.moderationTtlMinutes),
    }));
  }

  vote(agentId: string, caseId: string, verdict: ModerationVerdict, justification: string) {
    const j = justification.trim();
    check(j.length >= 10, "invalid_vote", "justification: one sentence on why the text is acceptable or not");
    const res = this.db
      .prepare(
        `UPDATE moderation_votes SET verdict = ?, justification = ?, voted_at = ?
         WHERE case_id = ? AND moderator_id = ? AND verdict IS NULL
           AND EXISTS (SELECT 1 FROM moderation_cases k WHERE k.id = case_id AND k.status = 'open')`,
      )
      .run(verdict, j.slice(0, 1000), now(), caseId, agentId);
    check(res.changes === 1, "unknown_moderation", "No pending moderation of yours with this id");
    const votes = this.db
      .prepare(`SELECT verdict FROM moderation_votes WHERE case_id = ? AND verdict IN ('keep', 'remove')`)
      .all(caseId) as { verdict: ModerationVerdict }[];
    const majority = Math.floor(this.cfg.moderators / 2) + 1;
    const removes = votes.filter((v) => v.verdict === "remove").length;
    if (removes >= majority) this.decide(caseId, "remove", "community", "majority of moderators");
    else if (votes.length - removes >= majority) this.decide(caseId, "keep", "community", "majority of moderators");
    return { caseId, verdict };
  }

  // ------------------------------------------------------------------ decisions

  /**
   * Closes a case. Remove: the public text is replaced, an open mission is cancelled and refunded, the
   * author loses reputation and the reporter gets its deposit back. Keep: the reporter's deposit is
   * burned. Moderators who voted with the decision are paid; the others lose reputation.
   */
  decide(caseId: string, outcome: ModerationVerdict, by: "community" | "operator", reason: string) {
    tx(this.db, () => {
      const k = this.row(caseId);
      check(k.status === "open" || k.status === "operator", "invalid_state", `Case already ${k.status}`);
      const removed = outcome === "remove";
      this.db
        .prepare(
          `UPDATE moderation_cases SET status = ?, decided_by = ?, decision_reason = ?, decided_at = ?,
             title = CASE WHEN ? THEN title ELSE NULL END, summary = CASE WHEN ? THEN summary ELSE NULL END
           WHERE id = ?`,
        )
        .run(removed ? "removed" : "kept", by, reason.slice(0, 1000), now(), removed ? 1 : 0, removed ? 1 : 0, caseId);
      if (removed) {
        const m = this.mission(k.mission_id);
        this.db.prepare(`UPDATE missions SET title = ?, summary = '' WHERE id = ?`).run(REMOVED_TITLE, m.id);
        const cancelled = this.db
          .prepare(`UPDATE missions SET status = 'cancelled', closed_at = ?, outcome_reason = ? WHERE id = ? AND status = 'open'`)
          .run(now(), `removed by moderation: ${reason}`.slice(0, 1000), m.id);
        if (cancelled.changes === 1) this.c.credit(m.requester_id, m.price_credits);
        this.c.reputation(m.requester_id, false);
        if (k.reporter_id) this.c.credit(k.reporter_id, k.deposit);
      } else if (k.deposit > 0) {
        this.c.supply("burn", -k.deposit);
      }
      const fee = this.cfg.moderationFeeCredits;
      for (const v of this.db
        .prepare(`SELECT moderator_id, verdict FROM moderation_votes WHERE case_id = ? AND verdict IN ('keep', 'remove')`)
        .all(caseId) as { moderator_id: string; verdict: ModerationVerdict }[]) {
        const right = v.verdict === outcome;
        if (right && fee > 0) {
          this.c.credit(v.moderator_id, fee);
          this.c.supply("moderation", fee);
          this.db.prepare(`UPDATE moderation_votes SET paid = 1 WHERE case_id = ? AND moderator_id = ?`).run(caseId, v.moderator_id);
        }
        this.c.reputation(v.moderator_id, right);
      }
      this.db.prepare(`UPDATE moderation_votes SET verdict = 'expired' WHERE case_id = ? AND verdict IS NULL`).run(caseId);
    });
    return this.view(this.row(caseId));
  }

  /** Deadlines: silent moderators are replaced; cases nobody can take go to the operator; old removed text is erased. */
  sweep() {
    for (const v of this.db
      .prepare(
        `SELECT v.case_id, v.moderator_id FROM moderation_votes v JOIN moderation_cases k ON k.id = v.case_id
         WHERE v.verdict IS NULL AND k.status = 'open' AND v.assigned_at < ?`,
      )
      .all(minutesAgo(this.cfg.moderationTtlMinutes)) as { case_id: string; moderator_id: string }[]) {
      this.db.prepare(`UPDATE moderation_votes SET verdict = 'expired' WHERE case_id = ? AND moderator_id = ?`).run(v.case_id, v.moderator_id);
      this.c.reputation(v.moderator_id, false);
    }
    for (const k of this.db.prepare(`SELECT id, created_at FROM moderation_cases WHERE status = 'open'`).all() as {
      id: string;
      created_at: string;
    }[]) {
      this.draw(k.id);
      const voted = this.db
        .prepare(`SELECT COUNT(*) AS n FROM moderation_votes WHERE case_id = ? AND verdict IN ('keep', 'remove')`)
        .get(k.id) as { n: number };
      if (voted.n === 0 && k.created_at < minutesAgo(2 * this.cfg.moderationTtlMinutes)) {
        this.db.prepare(`UPDATE moderation_cases SET status = 'operator' WHERE id = ? AND status = 'open'`).run(k.id);
      }
    }
    this.db
      .prepare(`UPDATE moderation_cases SET title = NULL, summary = NULL WHERE status = 'removed' AND title IS NOT NULL AND decided_at < ?`)
      .run(minutesAgo(this.cfg.removedContentRetentionDays * 24 * 60));
  }

  // ------------------------------------------------------------------ operator

  /** Cases for the operator: those waiting for it by default. */
  cases(status: string = "operator"): ModerationCase[] {
    const rows = this.db.prepare(`SELECT * FROM moderation_cases WHERE status = ? ORDER BY created_at LIMIT 200`).all(status) as unknown as CaseRow[];
    return rows.map((r) => this.view(r));
  }

  /** The operator removes a mission's text directly (a legal notice received by email, for instance). */
  remove(missionId: string, reason: string) {
    const m = this.mission(missionId);
    const pending = this.db
      .prepare(`SELECT id FROM moderation_cases WHERE mission_id = ? AND status IN ('open', 'operator')`)
      .get(missionId) as { id: string } | undefined;
    const id = pending?.id ?? randomUUID();
    if (!pending) this.insert(id, m, "operator", null, reason, "operator", 0);
    return this.decide(id, "remove", "operator", reason);
  }

  /** Bans an identity: every signed request is refused from now on, and its open missions are withdrawn. */
  ban(agentId: string, reason: string) {
    this.c.requireAgent(agentId);
    tx(this.db, () => {
      this.db.prepare(`UPDATE agents SET banned = 1 WHERE agent_id = ?`).run(agentId);
      for (const m of this.db.prepare(`SELECT id, price_credits FROM missions WHERE requester_id = ? AND status = 'open'`).all(agentId) as {
        id: string;
        price_credits: number;
      }[]) {
        this.db
          .prepare(`UPDATE missions SET status = 'cancelled', closed_at = ?, outcome_reason = ? WHERE id = ?`)
          .run(now(), `author banned: ${reason}`.slice(0, 1000), m.id);
        this.c.credit(agentId, m.price_credits);
      }
      this.db.prepare(`UPDATE moderation_votes SET verdict = 'expired' WHERE moderator_id = ? AND verdict IS NULL`).run(agentId);
    });
    return { agentId, banned: true };
  }

  // ------------------------------------------------------------------ helpers

  private row(caseId: string): CaseRow {
    const k = this.db.prepare(`SELECT * FROM moderation_cases WHERE id = ?`).get(caseId) as CaseRow | undefined;
    if (!k) throw new TroqoError("unknown_moderation", `Unknown moderation case ${caseId}`);
    return k;
  }

  private mission(missionId: string) {
    const m = this.db.prepare(`SELECT id, requester_id, title, summary, price_credits FROM missions WHERE id = ?`).get(missionId) as
      | { id: string; requester_id: string; title: string; summary: string; price_credits: number }
      | undefined;
    if (!m) throw new TroqoError("unknown_mission", `Unknown mission ${missionId}`);
    return m;
  }

  private view(k: CaseRow): ModerationCase {
    const votes = this.db
      .prepare(`SELECT verdict, justification FROM moderation_votes WHERE case_id = ? ORDER BY assigned_at`)
      .all(k.id) as { verdict: string | null; justification: string | null }[];
    return {
      caseId: k.id,
      missionId: k.mission_id,
      origin: k.origin,
      reporterId: k.reporter_id,
      reason: k.reason,
      title: k.title,
      summary: k.summary,
      status: k.status,
      votes,
      decidedBy: k.decided_by,
      decisionReason: k.decision_reason,
      createdAt: k.created_at,
      decidedAt: k.decided_at,
    };
  }
}
