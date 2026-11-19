import { isDeliveryBundle, isSpecBundle, type DeliveryBundle, type MissionInfo } from "../shared/protocol.js";
import { imageCapability, type Capability, type ImageCapabilityConfig } from "./capabilities.js";
import type { MediationDetails, TroqoClient } from "./client.js";
import { mediationPrompt, moderationPrompt, parseModeration, parseRanking, parseVerdict, rankingPrompt, solvePrompt } from "./prompts.js";
import { runSolver, type SolverConfig } from "./sandbox.js";

/** How a worker earns credits while its user is away. Stored under "worker" in ~/.troqo/config.json. */
export interface WorkerConfig {
  /** Mission kinds this worker takes, e.g. ["code", "text"]. */
  kinds: string[];
  /** Lowest price accepted per kind (default: any). */
  minPrice?: Record<string, number>;
  /**
   * Which requesters to work for. A new identity has no paid mission: it may be honest, or a cheater who
   * changed identity. Default: anyone.
   */
  requesters?: {
    /** Missions the requester must have paid (to different solvers counting once each)... */
    minPaid?: number;
    /** ...unless the mission is priced at most this (small risk with an unknown requester). */
    unknownMaxPrice?: number;
  };
  /** Missions held at once. */
  maxConcurrent?: number;
  pollSeconds?: number;
  /** LLM solver for text missions and mediations. */
  solver?: SolverConfig;
  /** Settle disputes the worker is drawn for (needs a solver). */
  mediate?: boolean;
  /** Kinds served without an LLM, e.g. image generation through an API (market maker). */
  capabilities?: { image?: ImageCapabilityConfig };
}

export type WorkerEvent =
  | { type: "sync"; received: number; specsSent: number; evidenceSent: number; problems: string[] }
  | { type: "took"; missionId: string; kind: string; price: number }
  | { type: "delivered"; missionId: string }
  | { type: "mediated"; missionId: string; verdict: string }
  | { type: "ranked"; groupId: string; order: string[] }
  | { type: "moderated"; caseId: string; verdict: string }
  | { type: "error"; message: string };

export class Worker {
  private readonly capabilities = new Map<string, Capability>();
  private stopped = false;

  constructor(
    private readonly client: TroqoClient,
    private readonly config: WorkerConfig,
    private readonly log: (e: WorkerEvent) => void = () => undefined,
  ) {
    if (config.capabilities?.image) this.capabilities.set("image", imageCapability(config.capabilities.image));
    if (config.mediate && !config.solver) throw new Error("worker.mediate needs worker.solver");
  }

  private handles(kind: string) {
    return this.capabilities.has(kind) || (!!this.config.solver && this.config.kinds.includes(kind));
  }

  /** One pass: sync, settle mediations, solve held missions, take new ones. */
  async tick(): Promise<void> {
    const report = await this.client.sync();
    if (report.received || report.specsSent || report.evidenceSent || report.problems.length) this.log({ type: "sync", ...report });

    if (this.config.mediate) {
      // Each duty is isolated: a failure in one must not keep the worker from the others or from its missions.
      for (const duty of [() => this.settleMediations(), () => this.rankAnswers(), () => this.moderate()]) {
        await duty().catch((e) => this.log({ type: "error", message: (e as Error).message }));
      }
    }
    const mine = await this.client.myMissions();
    for (const m of mine) {
      if (m.solverId === this.client.agentId && m.status === "in_progress" && m.local.spec && !m.local.delivery) {
        // A spec that does not match the fingerprint posted on the market is not the one a mediator would
        // judge the delivery against: working on it could only lose a dispute.
        if (m.local.specTampered) {
          const back = await this.client.releaseMission(m.missionId).then(() => "handed back", (e) => `could not hand it back: ${(e as Error).message}`);
          this.log({ type: "error", message: `Mission ${m.missionId}: the spec received does not match its fingerprint, not solving it (${back})` });
          continue;
        }
        await this.solve(m).catch((e) => this.log({ type: "error", message: `Mission ${m.missionId}: ${(e as Error).message}` }));
      }
    }

    const held = mine.filter((m) => m.solverId === this.client.agentId && (m.status === "taken" || m.status === "in_progress"));
    if (held.length >= (this.config.maxConcurrent ?? 1)) return;
    const open = await this.client.listMissions();
    const levels = open.some((m) => m.minLevel)
      ? new Map((await this.client.profile()).certifications.map((c) => [c.kind, c.level]))
      : new Map<string, number>();
    const pick = open.find(
      (m) =>
        this.handles(m.kind) &&
        m.priceCredits >= (this.config.minPrice?.[m.kind] ?? 0) &&
        (m.minLevel ?? 0) <= (levels.get(m.kind) ?? 0) &&
        this.trusts(m),
    );
    if (!pick) return;
    try {
      await this.client.takeMission(pick.missionId);
      this.log({ type: "took", missionId: pick.missionId, kind: pick.kind, price: pick.priceCredits });
    } catch (e) {
      this.log({ type: "error", message: `Take ${pick.missionId}: ${(e as Error).message}` });
    }
  }

  /** Whether the requester's track record is enough for this worker's settings. */
  private trusts(m: MissionInfo): boolean {
    const r = this.config.requesters;
    if (!r?.minPaid) return true;
    if ((m.requester?.paidSolvers ?? 0) >= r.minPaid) return true;
    return r.unknownMaxPrice !== undefined && m.priceCredits <= r.unknownMaxPrice;
  }

  private async solve(m: MissionInfo & { local: { spec?: { spec: string; acceptance: string } } }) {
    const spec = m.local.spec!;
    let delivery: DeliveryBundle;
    const cap = this.capabilities.get(m.kind);
    if (cap) delivery = await cap.execute(spec);
    else {
      if (!this.config.solver) throw new Error(`No solver for kind ${m.kind}`);
      const out = await runSolver(this.config.solver, solvePrompt(m.kind, m.title, spec));
      if (!out.trim()) throw new Error("Solver produced no output");
      delivery = { mime: "text/plain", content: out.trim() };
    }
    await this.client.deliver(m.missionId, delivery);
    this.log({ type: "delivered", missionId: m.missionId });
  }

  private async settleMediations() {
    for (const d of await this.client.mediations()) {
      await this.settleMediation(d).catch((e) => this.log({ type: "error", message: `Mediation ${d.missionId}: ${(e as Error).message}` }));
    }
  }

  private async settleMediation(d: MediationDetails) {
    if (!d.ready || !d.evidence?.spec || !d.evidence.delivery) return;
    // Pieces stored by an older client were not checked when received.
    if (!isSpecBundle(d.evidence.spec) || !isDeliveryBundle(d.evidence.delivery)) throw new Error("malformed evidence");
    let verdict: "accept" | "refuse";
    let justification: string;
    // A piece that does not match its fingerprint decides the dispute against whoever sent it.
    if (d.evidence.deliveryTampered) {
      verdict = "refuse";
      justification = "The delivery received does not match the fingerprint recorded at delivery time.";
    } else if (d.evidence.specTampered) {
      verdict = "accept";
      justification = "The spec received does not match the fingerprint recorded when the mission was posted.";
    } else {
      const out = await runSolver(
        this.config.solver!,
        mediationPrompt({
          kind: d.kind,
          title: d.title,
          contestReason: d.contestReason,
          spec: d.evidence.spec,
          delivery: d.evidence.delivery,
          firstVerdict: d.firstVerdict,
        }),
      ).catch((e) => {
        this.log({ type: "error", message: `Mediation ${d.missionId}: ${(e as Error).message}` });
        return "";
      });
      const parsed = parseVerdict(out);
      if (!parsed) return;
      ({ verdict, justification } = parsed);
    }
    await this.client.mediate(d.missionId, verdict, justification);
    this.log({ type: "mediated", missionId: d.missionId, verdict });
  }

  /** Conformity rankings use the same solver as mediations. */
  private async rankAnswers() {
    for (const r of await this.client.rankings()) {
      if (!r.bundle) continue;
      const out = await runSolver(this.config.solver!, rankingPrompt(r.bundle)).catch((e) => {
        this.log({ type: "error", message: `Ranking ${r.groupId}: ${(e as Error).message}` });
        return "";
      });
      const parsed = parseRanking(out, r.labels);
      if (!parsed) continue;
      await this.client.rank(r.groupId, parsed.order, parsed.justification);
      this.log({ type: "ranked", groupId: r.groupId, order: parsed.order });
    }
  }

  /** Moderation of public texts uses the same solver as mediations. */
  private async moderate() {
    for (const k of await this.client.moderations()) {
      const out = await runSolver(this.config.solver!, moderationPrompt(k)).catch((e) => {
        this.log({ type: "error", message: `Moderation ${k.caseId}: ${(e as Error).message}` });
        return "";
      });
      const parsed = parseModeration(out);
      if (!parsed) continue;
      await this.client.moderate(k.caseId, parsed.verdict, parsed.justification);
      this.log({ type: "moderated", caseId: k.caseId, verdict: parsed.verdict });
    }
  }

  async run(): Promise<void> {
    const pause = (this.config.pollSeconds ?? 30) * 1000;
    while (!this.stopped) {
      await this.tick().catch((e) => this.log({ type: "error", message: (e as Error).message }));
      if (!this.stopped) await new Promise((r) => setTimeout(r, pause));
    }
  }

  stop() {
    this.stopped = true;
  }
}
