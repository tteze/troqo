import { randomInt, randomUUID } from "node:crypto";
import { generateIdentity, open, seal, sha256 } from "../../shared/crypto.js";
import { TroqoError } from "../../shared/errors.js";
import {
  canonicalSpec,
  type AgentProfile,
  type DeliveryBundle,
  type MissionInfo,
  type PendingRanking,
  type RankingBundle,
  type Verdict,
} from "../../shared/protocol.js";
import { tx } from "../db.js";
import { check, Context, minutesAgo, now, plusMinutes, SYSTEM_AGENT } from "../context.js";
import type { Market } from "../market.js";
import { generatorById, pickGenerator } from "./generators.js";
import type { CertificationPolicy } from "./policy.js";

/**
 * Certification by kind of mission, driven entirely by a CertificationPolicy:
 *
 * - **Exams**: an agent asks for one; it receives generated missions with a known answer. Passing
 *   enough in a row grants a level.
 * - **Hidden controls**: once certified, some of the missions an agent sees are generated controls,
 *   posted by a one-off identity like any newcomer. Failing one costs the level.
 * - **Model conformity**: agents that declare the same model answer the same open-ended task; peers
 *   (preferably with the same model) rank the answers blind. Consistently last means "below peers".
 *
 * Controls are Troqo's own content: the server generates them, holds the key of their one-off
 * requester, and so can read and grade what is delivered. Real missions stay end-to-end encrypted.
 */

const LABELS = "ABCDEFGHIJ";

interface ControlRow {
  id: string;
  mission_id: string;
  agent_id: string;
  kind: string;
  purpose: "exam" | "check" | "conformity";
  generator: string;
  difficulty: number;
  group_id: string | null;
  spec: string;
  acceptance: string;
  expected: string;
  requester_id: string;
  box_public: string;
  box_private: string;
  delivery: string | null;
  result: "pass" | "fail" | null;
  policy_version: string;
}

interface CertRow {
  agent_id: string;
  kind: string;
  level: number;
  policy_version: string;
  granted_at: string;
  expires_at: string;
  streak: number;
  controls_passed: number;
  controls_failed: number;
}

export class Certifier {
  constructor(
    private readonly c: Context,
    private readonly market: Market,
    readonly policy: CertificationPolicy,
  ) {}

  private get db() {
    return this.c.db;
  }

  // ------------------------------------------------------------------ levels

  /** Effective level of an agent for a kind: 0 if never certified or lapsed. */
  level(agentId: string, kind: string): number {
    const r = this.db
      .prepare(`SELECT level FROM certifications WHERE agent_id = ? AND kind = ? AND expires_at > ?`)
      .get(agentId, kind, now()) as { level: number } | undefined;
    return r?.level ?? 0;
  }

  maxLevel(): number {
    return this.policy.levels.length;
  }

  private cert(agentId: string, kind: string): CertRow | undefined {
    return this.db.prepare(`SELECT * FROM certifications WHERE agent_id = ? AND kind = ?`).get(agentId, kind) as CertRow | undefined;
  }

  private setLevel(agentId: string, kind: string, level: number) {
    const t = now();
    const expires = plusMinutes(t, this.policy.validityDays * 24 * 60);
    this.db
      .prepare(
        `INSERT INTO certifications (agent_id, kind, level, policy_version, granted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, kind) DO UPDATE SET level = excluded.level, policy_version = excluded.policy_version,
           granted_at = excluded.granted_at, expires_at = excluded.expires_at`,
      )
      .run(agentId, kind, level, this.policy.version, t, expires);
  }

  // ------------------------------------------------------------------ exams

  /** Starts an exam task for the next level of a kind. Its spec arrives like any mission's. */
  startExam(agentId: string, kind: string): MissionInfo {
    check(this.policy.kinds.includes(kind), "not_certifiable", `Certifiable kinds: ${this.policy.kinds.join(", ")}`);
    const current = this.level(agentId, kind);
    const rule = this.policy.levels.find((l) => l.level === current + 1);
    check(rule, "max_level", `You already hold the highest level for ${kind}`);
    const c = this.cert(agentId, kind);
    check(
      (c?.controls_passed ?? 0) >= rule.minControlsPassed,
      "needs_track_record",
      `Level ${rule.level} needs ${rule.minControlsPassed} passed controls at the level below (you have ${c?.controls_passed ?? 0})`,
    );
    const pending = this.db
      .prepare(
        `SELECT 1 FROM controls k JOIN missions m ON m.id = k.mission_id
         WHERE k.agent_id = ? AND k.purpose = 'exam' AND m.status IN ('taken', 'in_progress')`,
      )
      .get(agentId);
    check(!pending, "exam_in_progress", "Deliver your current exam task first");
    const today = this.db
      .prepare(`SELECT COUNT(*) AS n FROM controls WHERE agent_id = ? AND purpose = 'exam' AND created_at >= ?`)
      .get(agentId, minutesAgo(24 * 60)) as { n: number };
    check(today.n < 20, "daily_exam_limit", "20 exam tasks per 24 hours at most");
    const id = this.createControl(agentId, kind, "exam", rule.exam.difficulty);
    check(id, "not_certifiable", `No exam generator for ${kind} at difficulty ${rule.exam.difficulty}`);
    return this.market.get(agentId, id);
  }

  /** Exam tasks passed in a row at a difficulty, most recent first, stopping at the first failure. */
  private examStreak(agentId: string, kind: string, difficulty: number): number {
    const results = this.db
      .prepare(
        `SELECT result FROM controls WHERE agent_id = ? AND kind = ? AND purpose = 'exam' AND difficulty = ?
           AND result IS NOT NULL ORDER BY created_at DESC LIMIT 50`,
      )
      .all(agentId, kind, difficulty) as { result: string }[];
    let n = 0;
    for (const r of results) {
      if (r.result !== "pass") break;
      n++;
    }
    return n;
  }

  // ------------------------------------------------------------------ hidden controls

  /** Called after an agent takes a real mission: sometimes queues a hidden control for it. */
  afterTake(agentId: string, kind: string) {
    const level = this.level(agentId, kind);
    const model = this.model(agentId);
    const conformityPossible = this.policy.conformity.enabled && !!model && !!pickGenerator(kind, "open");
    if (level === 0 && !conformityPossible) return;
    const pending = this.db
      .prepare(
        `SELECT 1 FROM controls k JOIN missions m ON m.id = k.mission_id
         WHERE k.agent_id = ? AND k.purpose != 'exam' AND m.status IN ('open', 'taken', 'in_progress', 'delivered', 'disputed')`,
      )
      .get(agentId);
    if (pending) return;
    const c = this.cert(agentId, kind);
    const cp = this.policy.controls;
    const rate = (c?.streak ?? 0) >= cp.establishedAfter ? cp.establishedRate : cp.initialRate;
    if (Math.random() >= rate) return;
    const conformity = conformityPossible && (level === 0 || Math.random() < this.policy.conformity.share);
    this.createControl(agentId, kind, conformity ? "conformity" : "check", Math.max(1, level));
  }

  /**
   * Creates a control mission posted by a fresh one-off identity. Exams start already taken;
   * hidden controls are open, visible only to their target.
   */
  private createControl(agentId: string, kind: string, purpose: ControlRow["purpose"], difficulty: number): string | undefined {
    let task: { title: string; summary: string; spec: string; acceptance: string; expected: unknown };
    let generator: string;
    let groupId: string | null = null;
    if (purpose === "conformity") {
      const group = this.groupFor(agentId, kind);
      if (!group) return undefined;
      groupId = group.id;
      generator = group.generator;
      task = { title: group.title, summary: group.summary, spec: group.spec, acceptance: group.acceptance, expected: null };
    } else {
      const g = pickGenerator(kind, "graded", difficulty);
      if (!g) return undefined;
      generator = g.id;
      task = g.generate(difficulty);
    }
    const pseudo = generateIdentity();
    const missionId = randomUUID();
    const controlId = randomUUID();
    const t = now();
    const price = purpose === "exam" ? 0 : this.priceFor(kind);
    const specHash = sha256(canonicalSpec({ spec: task.spec, acceptance: task.acceptance }));
    tx(this.db, () => {
      this.db
        .prepare(`INSERT INTO agents (agent_id, sign_public, box_public, created_at, system) VALUES (?, ?, ?, ?, 1)`)
        .run(pseudo.agentId, pseudo.signPublic, pseudo.boxPublic, t);
      this.db
        .prepare(
          `INSERT INTO missions (id, requester_id, kind, title, summary, price_credits, spec_hash, status, solver_id, taken_at,
             target_id, control_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(missionId, pseudo.agentId, kind, purpose === "exam" ? `Exam: ${task.title}` : task.title, task.summary, price, specHash,
          purpose === "exam" ? "taken" : "open", purpose === "exam" ? agentId : null, purpose === "exam" ? t : null, agentId, controlId, t);
      this.db
        .prepare(
          `INSERT INTO controls (id, mission_id, agent_id, kind, purpose, generator, difficulty, group_id, spec, acceptance, expected,
             requester_id, box_public, box_private, policy_version, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(controlId, missionId, agentId, kind, purpose, generator, difficulty, groupId, task.spec, task.acceptance,
          JSON.stringify(task.expected), pseudo.agentId, pseudo.boxPublic, pseudo.boxPrivate, this.policy.version, t);
      this.c.supply("control", price); // the escrow of a control is created, not taken from anyone
    });
    return missionId;
  }

  /** Controls are priced like the real missions of their kind, so price does not give them away. */
  private priceFor(kind: string): number {
    const prices = (
      this.db
        .prepare(
          `SELECT price_credits AS p FROM missions WHERE kind = ? AND status = 'accepted' AND control_id IS NULL
             AND honeypot_id IS NULL AND closed_at >= ? ORDER BY p`,
        )
        .all(kind, minutesAgo(30 * 24 * 60)) as { p: number }[]
    ).map((r) => r.p);
    if (!prices.length) return this.policy.controls.defaultPrice;
    return Math.max(1, prices[Math.floor(prices.length / 2)] + randomInt(-1, 2));
  }

  private control(missionId: string): ControlRow | undefined {
    return this.db
      .prepare(`SELECT k.*, m.requester_id FROM controls k JOIN missions m ON m.id = k.mission_id WHERE k.mission_id = ?`)
      .get(missionId) as ControlRow | undefined;
  }

  /** Applies a graded result to the agent's certification of that kind. */
  private record(k: ControlRow, passed: boolean) {
    this.db.prepare(`UPDATE controls SET result = ?, graded_at = ? WHERE id = ?`).run(passed ? "pass" : "fail", now(), k.id);
    if (k.purpose === "conformity") return;
    if (k.purpose === "exam") {
      if (!passed) return;
      const rule = this.policy.levels.find((l) => l.exam.difficulty === k.difficulty && l.level === this.level(k.agent_id, k.kind) + 1);
      if (rule && this.examStreak(k.agent_id, k.kind, k.difficulty) >= rule.exam.passes) {
        this.setLevel(k.agent_id, k.kind, rule.level);
        this.db.prepare(`UPDATE certifications SET streak = 0 WHERE agent_id = ? AND kind = ?`).run(k.agent_id, k.kind);
      }
      return;
    }
    const c = this.cert(k.agent_id, k.kind);
    if (!c) return;
    if (passed) {
      this.db
        .prepare(
          `UPDATE certifications SET controls_passed = controls_passed + 1, streak = streak + 1, expires_at = ?
           WHERE agent_id = ? AND kind = ?`,
        )
        .run(plusMinutes(now(), this.policy.validityDays * 24 * 60), k.agent_id, k.kind);
    } else {
      const level = this.policy.onControlFail === "revoke" ? 0 : Math.max(0, c.level - 1);
      this.db
        .prepare(
          `UPDATE certifications SET controls_failed = controls_failed + 1, streak = 0, level = ?, policy_version = ?
           WHERE agent_id = ? AND kind = ?`,
        )
        .run(level, this.policy.version, k.agent_id, k.kind);
    }
  }

  // ------------------------------------------------------------------ sweep

  /** Plays the one-off requesters of controls: hands specs over, grades deliveries, sends evidence. */
  sweep() {
    // Untaken hidden controls vanish.
    for (const r of this.db
      .prepare(`SELECT id FROM missions WHERE control_id IS NOT NULL AND status = 'open' AND created_at < ?`)
      .all(minutesAgo(this.policy.controls.expireMinutes)) as { id: string }[]) {
      this.db.prepare(`UPDATE missions SET status = 'cancelled', closed_at = ?, outcome_reason = 'control expired' WHERE id = ?`).run(now(), r.id);
      this.retire(r.id);
    }
    // Spec handover.
    for (const r of this.db
      .prepare(
        `SELECT m.id, m.solver_id, a.box_public FROM missions m JOIN agents a ON a.agent_id = m.solver_id
         WHERE m.control_id IS NOT NULL AND m.status = 'taken'`,
      )
      .all() as { id: string; solver_id: string; box_public: string }[]) {
      const k = this.control(r.id)!;
      tx(this.db, () => {
        const res = this.db
          .prepare(`UPDATE missions SET status = 'in_progress', spec_sent_at = ? WHERE id = ? AND status = 'taken'`)
          .run(now(), r.id);
        if (res.changes === 1) {
          this.market.message(r.id, "spec", k.requester_id, r.solver_id, seal(canonicalSpec({ spec: k.spec, acceptance: k.acceptance }), r.box_public));
        }
      });
    }
    // Grading.
    for (const r of this.db
      .prepare(`SELECT id FROM missions WHERE control_id IS NOT NULL AND status = 'delivered'`)
      .all() as { id: string }[]) {
      this.grade(r.id);
    }
    // Evidence for disputed controls: the one-off requester sends its spec to the mediator.
    for (const r of this.db
      .prepare(
        `SELECT m.id, d.mediator_id, a.box_public FROM mediations d JOIN missions m ON m.id = d.mission_id
         JOIN agents a ON a.agent_id = d.mediator_id
         WHERE m.control_id IS NOT NULL AND m.status = 'disputed' AND d.verdict IS NULL
           AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.mission_id = m.id AND x.kind = 'evidence-spec' AND x.to_id = d.mediator_id)`,
      )
      .all() as { id: string; mediator_id: string; box_public: string }[]) {
      const k = this.control(r.id)!;
      this.market.message(r.id, "evidence-spec", k.requester_id, r.mediator_id, seal(canonicalSpec({ spec: k.spec, acceptance: k.acceptance }), r.box_public));
    }
    // Closed controls give back what their one-off requester holds (refunds, bonds).
    for (const r of this.db
      .prepare(
        `SELECT m.id FROM missions m JOIN agents a ON a.agent_id = m.requester_id
         WHERE m.control_id IS NOT NULL AND m.status IN ('open', 'accepted', 'refused', 'cancelled') AND a.credits != 0`,
      )
      .all() as { id: string }[]) {
      this.retire(r.id);
    }
    this.sweepRankings();
  }

  private retire(missionId: string) {
    const m = this.db.prepare(`SELECT requester_id FROM missions WHERE id = ?`).get(missionId) as { requester_id: string };
    const held = this.c.balance(m.requester_id);
    if (held !== 0) {
      this.c.credit(m.requester_id, -held);
      this.c.supply("control", -held);
    }
  }

  private grade(missionId: string) {
    const k = this.control(missionId);
    if (!k) return;
    const m = this.db.prepare(`SELECT delivery_hash, solver_id FROM missions WHERE id = ?`).get(missionId) as {
      delivery_hash: string;
      solver_id: string;
    };
    const msg = this.db
      .prepare(`SELECT id, envelope FROM messages WHERE mission_id = ? AND kind = 'delivery' AND to_id = ? AND envelope IS NOT NULL`)
      .get(missionId, k.requester_id) as { id: string; envelope: string } | undefined;
    let delivery: DeliveryBundle | undefined;
    if (msg) {
      try {
        const plain = open(msg.envelope, { boxPublic: k.box_public, boxPrivate: k.box_private }).toString("utf8");
        if (sha256(plain) === m.delivery_hash) delivery = JSON.parse(plain) as DeliveryBundle;
      } catch {
        delivery = undefined;
      }
      this.db.prepare(`UPDATE messages SET envelope = NULL, fetched_at = ? WHERE id = ?`).run(now(), msg.id);
    }

    if (k.purpose === "conformity") {
      this.db.prepare(`UPDATE controls SET delivery = ? WHERE id = ?`).run(delivery ? JSON.stringify(delivery) : null, k.id);
      this.record(k, !!delivery);
      this.market.finalize(missionId, delivery ? "accept" : "refuse", delivery ? "accepted by the requester" : "unreadable delivery");
      if (k.group_id) this.maybeStartRanking(k.group_id);
      return;
    }

    const g = generatorById(k.generator);
    const passed = !!delivery && !!g?.grade && delivery.mime.startsWith("text/") && g.grade(JSON.parse(k.expected), delivery.content);
    this.record(k, passed);
    if (passed) {
      this.market.finalize(missionId, "accept", "accepted by the requester");
    } else if (k.purpose === "exam") {
      this.market.finalize(missionId, "refuse", "exam task failed");
    } else {
      // A hidden control is contested like a real mission, so a mediator also gets checked against a known verdict.
      this.db
        .prepare(`UPDATE missions SET status = 'disputed', contest_reason = ? WHERE id = ? AND status = 'delivered'`)
        .run(`The delivery does not meet the acceptance criteria: ${k.acceptance}`, missionId);
      this.market.draw(missionId, 1, 1);
      const drawn = this.db.prepare(`SELECT 1 FROM mediations WHERE mission_id = ?`).get(missionId);
      if (!drawn) this.market.finalize(missionId, "refuse", "missing evidence");
    }
  }

  /** A mediator's vote on a contested control: checked against the known verdict, then the control closes. */
  onControlVote(missionId: string, mediatorId: string, verdict: Verdict) {
    const right = verdict === "refuse";
    tx(this.db, () => {
      this.db
        .prepare(
          `UPDATE missions SET status = 'refused', verdict = 'refuse', verdict_at = ?, closed_at = ?, outcome_reason = 'mediated'
           WHERE id = ? AND status = 'disputed'`,
        )
        .run(now(), now(), missionId);
      if (right) {
        this.c.credit(mediatorId, this.c.config.mediationFeeCredits);
        this.c.supply("control", this.c.config.mediationFeeCredits);
        this.db.prepare(`UPDATE mediations SET paid = 1 WHERE mission_id = ? AND mediator_id = ?`).run(missionId, mediatorId);
      }
      this.c.reputation(mediatorId, right);
      const solver = (this.db.prepare(`SELECT solver_id FROM missions WHERE id = ?`).get(missionId) as { solver_id: string }).solver_id;
      this.c.reputation(solver, false);
      this.db.prepare(`UPDATE mediations SET verdict = 'expired' WHERE mission_id = ? AND verdict IS NULL`).run(missionId);
    });
    this.retire(missionId);
  }

  // ------------------------------------------------------------------ model conformity

  model(agentId: string): string | null {
    const r = this.db.prepare(`SELECT model FROM agents WHERE agent_id = ?`).get(agentId) as { model: string | null } | undefined;
    return r?.model ?? null;
  }

  /** Declares the model behind an agent. Unverified; peers compare it over time. Empty clears it. */
  setModel(agentId: string, model: string) {
    const m = model.trim().toLowerCase();
    check(m === "" || /^[a-z0-9][a-z0-9._-]{1,59}$/.test(m), "invalid_model", "model: a short slug, e.g. claude-opus-5-5, gpt-6, gemini-3-pro");
    this.db.prepare(`UPDATE agents SET model = ? WHERE agent_id = ?`).run(m || null, agentId);
    return this.profile(agentId);
  }

  /** A filling group of the agent's model and kind it is not part of yet, or a new one. */
  private groupFor(agentId: string, kind: string) {
    const model = this.model(agentId);
    if (!model) return undefined;
    const size = this.policy.conformity.groupSize;
    const existing = this.db
      .prepare(
        `SELECT g.* FROM conformity_groups g WHERE g.model = ? AND g.kind = ? AND g.status = 'filling' AND g.created_at >= ?
           AND (SELECT COUNT(*) FROM controls k WHERE k.group_id = g.id) < ?
           AND NOT EXISTS (SELECT 1 FROM controls k WHERE k.group_id = g.id AND k.agent_id = ?)
         ORDER BY g.created_at LIMIT 1`,
      )
      .get(model, kind, minutesAgo(7 * 24 * 60), size, agentId) as
      | { id: string; generator: string; title: string; summary: string; spec: string; acceptance: string }
      | undefined;
    if (existing) return existing;
    const g = pickGenerator(kind, "open");
    if (!g) return undefined;
    const task = g.generate(1);
    const group = { id: randomUUID(), generator: g.id, ...task };
    this.db
      .prepare(
        `INSERT INTO conformity_groups (id, model, kind, generator, title, summary, spec, acceptance, status, policy_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'filling', ?, ?)`,
      )
      .run(group.id, model, kind, g.id, task.title, task.summary, task.spec, task.acceptance, this.policy.version, now());
    return group;
  }

  /** Once enough agents of the same model answered, rankers receive the answers, sealed and shuffled. */
  private maybeStartRanking(groupId: string) {
    const cp = this.policy.conformity;
    const group = this.db.prepare(`SELECT * FROM conformity_groups WHERE id = ?`).get(groupId) as {
      id: string;
      model: string;
      kind: string;
      title: string;
      spec: string;
      acceptance: string;
      status: string;
    };
    if (group.status !== "filling") return;
    const answers = this.db
      .prepare(`SELECT id, agent_id, delivery FROM controls WHERE group_id = ? AND delivery IS NOT NULL`)
      .all(groupId) as { id: string; agent_id: string; delivery: string }[];
    if (answers.length < cp.groupSize) return;

    const members = answers.map((a) => a.agent_id);
    const eligible = (sameModel: boolean, n: number, exclude: string[]) =>
      (
        this.db
          .prepare(
            `SELECT agent_id FROM agents WHERE system = 0 AND batches_passed >= ? AND reputation >= ?
               AND (model IS ?) = ? AND agent_id NOT IN (SELECT value FROM json_each(?))
             ORDER BY RANDOM() LIMIT ?`,
          )
          .all(this.c.config.mediatorMinBatches, this.c.config.mediatorMinReputation, group.model, sameModel ? 1 : 0,
            JSON.stringify(exclude), n) as { agent_id: string }[]
      ).map((r) => r.agent_id);
    const same = eligible(true, cp.sameModelRankers, members);
    const rankers = [...same, ...eligible(false, cp.rankers - same.length, [...members, ...same])];

    tx(this.db, () => {
      if (!rankers.length) {
        this.db.prepare(`UPDATE conformity_groups SET status = 'done' WHERE id = ?`).run(groupId);
        this.db.prepare(`UPDATE controls SET delivery = NULL WHERE group_id = ?`).run(groupId);
        return;
      }
      this.db.prepare(`UPDATE conformity_groups SET status = 'ranking', ranking_at = ? WHERE id = ?`).run(now(), groupId);
      for (const r of rankers) {
        const order = [...answers].sort(() => Math.random() - 0.5);
        const labels = Object.fromEntries(order.map((a, i) => [LABELS[i], a.id]));
        const bundle: RankingBundle = {
          kind: group.kind,
          title: group.title,
          spec: group.spec,
          acceptance: group.acceptance,
          answers: order.map((a, i) => ({ label: LABELS[i], ...(JSON.parse(a.delivery) as DeliveryBundle) })),
        };
        const box = this.c.requireAgent(r).box_public;
        this.db
          .prepare(`INSERT INTO rankings (group_id, ranker_id, labels, assigned_at) VALUES (?, ?, ?, ?)`)
          .run(groupId, r, JSON.stringify(labels), now());
        this.market.message(groupId, "ranking", SYSTEM_AGENT, r, seal(JSON.stringify(bundle), box));
      }
    });
  }

  pendingRankings(agentId: string): PendingRanking[] {
    const rows = this.db
      .prepare(
        `SELECT r.group_id, r.labels, r.assigned_at, g.kind, g.title FROM rankings r JOIN conformity_groups g ON g.id = r.group_id
         WHERE r.ranker_id = ? AND r.ranking IS NULL AND g.status = 'ranking'`,
      )
      .all(agentId) as { group_id: string; labels: string; assigned_at: string; kind: string; title: string }[];
    return rows.map((r) => ({
      groupId: r.group_id,
      kind: r.kind,
      title: r.title,
      labels: Object.keys(JSON.parse(r.labels) as Record<string, string>),
      deadline: plusMinutes(r.assigned_at, this.policy.conformity.rankingTtlMinutes),
    }));
  }

  rank(agentId: string, groupId: string, order: string[], justification: string) {
    const r = this.db
      .prepare(`SELECT labels FROM rankings WHERE group_id = ? AND ranker_id = ? AND ranking IS NULL`)
      .get(groupId, agentId) as { labels: string } | undefined;
    check(r, "forbidden", "You have no pending ranking for this group");
    const labels = Object.keys(JSON.parse(r.labels) as Record<string, string>);
    const clean = order.map((x) => String(x).trim().toUpperCase());
    check(
      clean.length === labels.length && [...clean].sort().join() === [...labels].sort().join(),
      "invalid_ranking",
      `order: every label exactly once, best first (${labels.join(", ")})`,
    );
    check(justification.trim().length >= 10, "invalid_ranking", "Justify the ranking in a sentence");
    this.db
      .prepare(`UPDATE rankings SET ranking = ?, justification = ?, ranked_at = ? WHERE group_id = ? AND ranker_id = ?`)
      .run(JSON.stringify(clean), justification.trim().slice(0, 1000), now(), groupId, agentId);
    const missing = this.db.prepare(`SELECT 1 FROM rankings WHERE group_id = ? AND ranking IS NULL`).get(groupId);
    if (!missing) this.score(groupId);
    return { groupId, order: clean };
  }

  private sweepRankings() {
    for (const g of this.db
      .prepare(`SELECT id FROM conformity_groups WHERE status = 'ranking' AND ranking_at < ?`)
      .all(minutesAgo(this.policy.conformity.rankingTtlMinutes)) as { id: string }[]) {
      this.score(g.id);
    }
  }

  /**
   * Scores a group: each answer gets 1 - (average position) / (n - 1), so 1 is always first and 0
   * always last. A ranker whose best is the consensus worst, or the reverse, is not paid.
   */
  private score(groupId: string) {
    const rows = this.db
      .prepare(`SELECT ranker_id, labels, ranking FROM rankings WHERE group_id = ? AND ranking IS NOT NULL`)
      .all(groupId) as { ranker_id: string; labels: string; ranking: string }[];
    const group = this.db.prepare(`SELECT model FROM conformity_groups WHERE id = ?`).get(groupId) as { model: string };
    tx(this.db, () => {
      if (rows.length) {
        const positions = new Map<string, number[]>();
        const orders = rows.map((r) => {
          const labels = JSON.parse(r.labels) as Record<string, string>;
          const order = (JSON.parse(r.ranking) as string[]).map((l) => labels[l]);
          order.forEach((controlId, i) => positions.set(controlId, [...(positions.get(controlId) ?? []), i]));
          return { ranker: r.ranker_id, order };
        });
        const n = orders[0].order.length;
        const avg = [...positions].map(([controlId, ps]) => ({ controlId, pos: ps.reduce((a, b) => a + b, 0) / ps.length }));
        avg.sort((a, b) => a.pos - b.pos);
        for (const a of avg) {
          const agent = (this.db.prepare(`SELECT agent_id FROM controls WHERE id = ?`).get(a.controlId) as { agent_id: string }).agent_id;
          this.db
            .prepare(`INSERT INTO conformity_scores (group_id, agent_id, model, score, created_at) VALUES (?, ?, ?, ?, ?)`)
            .run(groupId, agent, group.model, n > 1 ? 1 - a.pos / (n - 1) : 1, now());
        }
        const best = avg[0].controlId;
        const worst = avg[avg.length - 1].controlId;
        for (const o of orders) {
          const right = !(o.order[0] === worst || o.order[o.order.length - 1] === best) || rows.length === 1;
          if (right) {
            this.c.credit(o.ranker, this.policy.conformity.rankerFeeCredits);
            this.c.supply("control", this.policy.conformity.rankerFeeCredits);
          }
          this.c.reputation(o.ranker, right);
        }
      }
      this.db.prepare(`UPDATE conformity_groups SET status = 'done' WHERE id = ?`).run(groupId);
      this.db.prepare(`UPDATE controls SET delivery = NULL WHERE group_id = ?`).run(groupId); // answers are not kept
      this.db.prepare(`UPDATE rankings SET ranking = '[]' WHERE group_id = ? AND ranking IS NULL`).run(groupId);
    });
  }

  // ------------------------------------------------------------------ public profile

  profile(agentId: string): AgentProfile {
    const a = this.db.prepare(`SELECT model, system FROM agents WHERE agent_id = ?`).get(agentId) as
      | { model: string | null; system: number }
      | undefined;
    if (!a) throw new TroqoError("unknown_agent", `Unknown agent ${agentId}`);
    const certs = this.db.prepare(`SELECT * FROM certifications WHERE agent_id = ? ORDER BY kind`).all(agentId) as unknown as CertRow[];
    const record = this.db
      .prepare(
        `SELECT kind, SUM(status = 'accepted') AS accepted, SUM(status = 'refused') AS refused FROM missions
         WHERE solver_id = ? AND control_id IS NULL AND honeypot_id IS NULL GROUP BY kind ORDER BY kind`,
      )
      .all(agentId) as { kind: string; accepted: number; refused: number }[];
    let conformity: AgentProfile["conformity"];
    if (a.model) {
      const s = this.db
        .prepare(`SELECT COUNT(*) AS n, AVG(score) AS avg FROM conformity_scores WHERE agent_id = ? AND model = ?`)
        .get(agentId, a.model) as { n: number; avg: number | null };
      const cp = this.policy.conformity;
      conformity = {
        groups: s.n,
        averageScore: s.avg === null ? null : Math.round(s.avg * 100) / 100,
        status: s.n < cp.minGroups ? "unchecked" : (s.avg ?? 0) < cp.belowPeersScore ? "below_peers" : "consistent",
      };
    }
    const t = now();
    return {
      agentId,
      declaredModel: a.model,
      conformity,
      certifications: certs.map((c) => ({
        kind: c.kind,
        level: c.expires_at > t ? c.level : 0,
        name: this.policy.levels.find((l) => l.level === c.level)?.name ?? "none",
        expiresAt: c.expires_at,
        controlsPassed: c.controls_passed,
        controlsFailed: c.controls_failed,
        policyVersion: c.policy_version,
      })),
      record,
    };
  }
}
