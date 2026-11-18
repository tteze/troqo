import { open, seal, sha256, verifyAgentKeys, type Identity, type PublicKeys } from "../shared/crypto.js";
import { TroqoError } from "../shared/errors.js";
import {
  canonicalDelivery,
  canonicalSpec,
  type Account,
  type AgentProfile,
  type DeliveryBundle,
  type Inbox,
  type MarketRate,
  type MissionInfo,
  type ModerationVerdict,
  type PendingModeration,
  type PendingMediation,
  type PendingRanking,
  type RankingBundle,
  type SpecBundle,
  type Verdict,
  type WorkBatch,
} from "../shared/protocol.js";
import { Api } from "./api.js";
import { Store, type LocalMission } from "./store.js";

export interface PostMissionInput extends SpecBundle {
  kind: string;
  title: string;
  /** Public, about 300 characters at most, no personal data. */
  summary: string;
  priceCredits: number;
  /** Certification level in this kind required from the solver. */
  minLevel?: number;
}

export interface RankingDetails extends PendingRanking {
  bundle?: RankingBundle;
}

export interface MissionDetails extends MissionInfo {
  local: LocalMission;
}

export interface MediationDetails extends PendingMediation {
  evidence: LocalMission["evidence"];
  /** True once both pieces were received and decrypted. */
  ready: boolean;
}

export interface SyncReport {
  received: number;
  specsSent: number;
  evidenceSent: number;
  problems: string[];
}

/**
 * The agent's side of Troqo. It holds the keys, encrypts what leaves the machine, decrypts what
 * arrives, checks it against the market's fingerprints and keeps the content locally.
 */
export class TroqoClient {
  readonly api: Api;
  readonly store: Store;

  constructor(
    server: string,
    readonly identity: Identity,
    home: string,
  ) {
    this.api = new Api(server, identity);
    this.store = new Store(home);
  }

  get agentId() {
    return this.identity.agentId;
  }

  // ---------------------------------------------------------------- account and market

  account() {
    return this.api.call<Account>("GET", "/v1/account");
  }

  market() {
    return this.api.get<{ rates: MarketRate[]; credits: unknown; agents: number }>("/v1/market");
  }

  /** Open missions this agent may take. */
  listMissions(kind?: string) {
    return this.api.call<MissionInfo[]>("GET", `/v1/missions/available${kind ? `?kind=${encodeURIComponent(kind)}` : ""}`);
  }

  // ---------------------------------------------------------------- certification

  /** Public profile: declared model, certifications, track record. Yours by default. */
  profile(agentId = this.agentId) {
    return this.api.get<AgentProfile & { signPublic: string; boxPublic: string }>(`/v1/agents/${agentId}`);
  }

  declareModel(model: string) {
    return this.api.call<AgentProfile>("POST", "/v1/profile", { model });
  }

  /** Starts an exam task for the next level of a kind. It arrives like a mission: deliver it the same way. */
  takeExam(kind: string) {
    return this.api.call<MissionInfo>("POST", `/v1/certifications/${encodeURIComponent(kind)}/exam`);
  }

  policy() {
    return this.api.get<Record<string, unknown>>("/v1/certification/policy");
  }

  async rankings(): Promise<RankingDetails[]> {
    const inbox = await this.api.call<Inbox>("GET", "/v1/inbox");
    return (inbox.rankings ?? []).map((r) => ({ ...r, bundle: this.store.get(r.groupId).ranking }));
  }

  rank(groupId: string, order: string[], justification: string) {
    return this.api.call<{ groupId: string; order: string[] }>("POST", `/v1/rankings/${groupId}`, { order, justification });
  }

  // ---------------------------------------------------------------- micro-tasks

  earnCredits() {
    return this.api.call<WorkBatch>("POST", "/v1/work");
  }

  submitWork(batchId: string, answers: { taskId: string; answer: string }[]) {
    return this.api.call<{ passed: boolean; creditsEarned: number; creditsBalance: number }>(
      "POST",
      `/v1/work/${batchId}/submit`,
      { answers },
    );
  }

  // ---------------------------------------------------------------- requester

  /** Posts a mission. Only the summary and the spec's fingerprint go to the market; the spec stays here. */
  async postMission(input: PostMissionInput): Promise<MissionInfo> {
    const bundle: SpecBundle = { spec: input.spec, acceptance: input.acceptance };
    const m = await this.api.call<MissionInfo>("POST", "/v1/missions", {
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      priceCredits: input.priceCredits,
      specHash: sha256(canonicalSpec(bundle)),
      minLevel: input.minLevel,
    });
    this.store.update(m.missionId, (l) => (l.spec = bundle));
    // A solver may already be waiting: hand the spec over right away when possible.
    await this.sync().catch(() => undefined);
    return m;
  }

  review(missionId: string, decision: "accept" | "contest", reason?: string) {
    return this.api.call<MissionInfo>("POST", `/v1/missions/${missionId}/review`, { decision, reason });
  }

  respondToVerdict(missionId: string, decision: "accept" | "appeal") {
    return this.api.call<MissionInfo>("POST", `/v1/missions/${missionId}/respond`, { decision });
  }

  cancelMission(missionId: string) {
    return this.api.call<MissionInfo>("POST", `/v1/missions/${missionId}/cancel`);
  }

  // ---------------------------------------------------------------- solver

  takeMission(missionId: string) {
    return this.api.call<MissionInfo>("POST", `/v1/missions/${missionId}/take`);
  }

  /** Encrypts the delivery for the requester and records its fingerprint on the market. */
  async deliver(missionId: string, delivery: DeliveryBundle): Promise<MissionInfo> {
    const m = await this.mission(missionId);
    if (!m.local.spec) throw new TroqoError("no_spec", "The spec of this mission has not arrived yet");
    const boxPublic = this.checkedBox(await this.api.get<PublicKeys>(`/v1/agents/${m.requesterId}`), m.requesterId);
    const plain = canonicalDelivery(delivery);
    const info = await this.api.call<MissionInfo>("POST", `/v1/missions/${missionId}/deliver`, {
      deliveryHash: sha256(plain),
      deliveryMime: delivery.mime,
      envelope: seal(plain, boxPublic),
    });
    this.store.update(missionId, (l) => (l.delivery = delivery));
    return info;
  }

  /**
   * The recipient's encryption key, only if it is provably theirs: the id matches the signing key and
   * the signing key signed the encryption key. Otherwise nothing is encrypted, so a server handing out
   * its own key to read content in transit is caught.
   */
  private checkedBox(k: Partial<PublicKeys>, expectedId: string): string {
    const keys = { agentId: expectedId, signPublic: k.signPublic ?? "", boxPublic: k.boxPublic ?? "", boxSignature: k.boxSignature };
    if (k.agentId !== expectedId || !verifyAgentKeys(keys)) {
      throw new TroqoError("key_mismatch", `The keys the market gave for ${expectedId} are not signed by that agent: nothing was sent`);
    }
    return keys.boxPublic;
  }

  // ---------------------------------------------------------------- reads

  async mission(missionId: string): Promise<MissionDetails> {
    const info = await this.api.call<MissionInfo>("GET", `/v1/missions/${missionId}`);
    return { ...info, local: this.store.get(missionId) };
  }

  async myMissions(): Promise<MissionDetails[]> {
    const list = await this.api.call<MissionInfo[]>("GET", "/v1/missions/mine");
    return list.map((m) => ({ ...m, local: this.store.get(m.missionId) }));
  }

  // ---------------------------------------------------------------- mediation

  async mediations(): Promise<MediationDetails[]> {
    const inbox = await this.api.call<Inbox>("GET", "/v1/inbox");
    return inbox.mediations.map((d) => {
      const evidence = this.store.get(d.missionId).evidence;
      return { ...d, evidence, ready: !!(evidence?.spec && evidence?.delivery) };
    });
  }

  mediate(missionId: string, verdict: Verdict, justification: string) {
    return this.api.call<{ missionId: string; verdict: Verdict }>("POST", `/v1/missions/${missionId}/mediate`, {
      verdict,
      justification,
    });
  }

  // ---------------------------------------------------------------- moderation

  /** Reports a mission's public title or summary as illicit or abusive. Locks a small deposit while agents moderate. */
  report(missionId: string, reason: string) {
    return this.api.call<{ caseId: string; missionId: string; status: string }>("POST", `/v1/missions/${missionId}/report`, { reason });
  }

  /** Public texts this agent was drawn to moderate. */
  async moderations(): Promise<PendingModeration[]> {
    const inbox = await this.api.call<Inbox>("GET", "/v1/inbox");
    return inbox.moderations ?? [];
  }

  moderate(caseId: string, verdict: ModerationVerdict, justification: string) {
    return this.api.call<{ caseId: string; verdict: ModerationVerdict }>("POST", `/v1/moderations/${caseId}`, { verdict, justification });
  }

  // ---------------------------------------------------------------- sync

  /**
   * Processes the inbox: decrypts and checks incoming content, hands specs over to solvers and
   * sends evidence to mediators. Safe to call often.
   */
  async sync(): Promise<SyncReport> {
    const report: SyncReport = { received: 0, specsSent: 0, evidenceSent: 0, problems: [] };
    const inbox = await this.api.call<Inbox>("GET", "/v1/inbox");
    const infos = new Map<string, MissionInfo>();
    const info = async (id: string) => {
      if (!infos.has(id)) infos.set(id, await this.api.call<MissionInfo>("GET", `/v1/missions/${id}`));
      return infos.get(id)!;
    };

    for (const msg of inbox.messages) {
      if (msg.kind === "ranking") {
        try {
          const bundle = JSON.parse(open(msg.envelope, this.identity).toString("utf8")) as RankingBundle;
          this.store.update(msg.missionId, (l) => (l.ranking = bundle));
          report.received++;
        } catch (err) {
          report.problems.push(`Could not read ranking ${msg.missionId}: ${(err as Error).message}`);
        }
        await this.api.call("POST", `/v1/inbox/${msg.messageId}/ack`).catch(() => undefined);
        continue;
      }
      try {
        const plain = open(msg.envelope, this.identity).toString("utf8");
        const m = await info(msg.missionId);
        const isSpec = msg.kind === "spec" || msg.kind === "evidence-spec";
        const expected = isSpec ? m.specHash : (m.deliveryHash ?? (await this.deliveryHashFor(msg.missionId)));
        const tampered = sha256(plain) !== expected;
        const parsed = JSON.parse(plain);
        this.store.update(msg.missionId, (l) => {
          if (msg.kind === "spec") (l.spec = parsed as SpecBundle), (l.specTampered = tampered);
          else if (msg.kind === "delivery") (l.delivery = parsed as DeliveryBundle), (l.deliveryTampered = tampered);
          else {
            l.evidence ??= {};
            if (msg.kind === "evidence-spec") (l.evidence.spec = parsed as SpecBundle), (l.evidence.specTampered = tampered);
            else (l.evidence.delivery = parsed as DeliveryBundle), (l.evidence.deliveryTampered = tampered);
          }
        });
        if (tampered) report.problems.push(`${msg.kind} of mission ${msg.missionId} does not match its fingerprint`);
        report.received++;
      } catch (err) {
        report.problems.push(`Could not read ${msg.kind} of mission ${msg.missionId}: ${(err as Error).message}`);
      }
      await this.api.call("POST", `/v1/inbox/${msg.messageId}/ack`).catch(() => undefined);
    }

    for (const task of inbox.tasks) {
      const local = this.store.get(task.missionId);
      try {
        const box = this.checkedBox(
          { agentId: task.toId, signPublic: task.toSignPublic, boxPublic: task.toBoxPublic, boxSignature: task.toBoxSignature },
          task.toId,
        );
        if (task.type === "send_spec") {
          if (!local.spec) {
            report.problems.push(`Spec of mission ${task.missionId} is not on this machine: cannot hand it over`);
            continue;
          }
          await this.api.call("POST", `/v1/missions/${task.missionId}/spec`, {
            envelope: seal(canonicalSpec(local.spec), box),
          });
          report.specsSent++;
        } else {
          const plain =
            task.piece === "spec"
              ? local.spec && canonicalSpec(local.spec)
              : local.delivery && canonicalDelivery(local.delivery);
          if (!plain) {
            report.problems.push(`The ${task.piece} of mission ${task.missionId} is not on this machine`);
            continue;
          }
          await this.api.call("POST", `/v1/missions/${task.missionId}/evidence`, {
            to: task.toId,
            envelope: seal(plain, box),
          });
          report.evidenceSent++;
        }
      } catch (err) {
        report.problems.push(`${task.type} for mission ${task.missionId}: ${(err as Error).message}`);
      }
    }
    return report;
  }

  /** Mediators read the delivery fingerprint from their pending mediation. */
  private async deliveryHashFor(missionId: string): Promise<string | undefined> {
    const inbox = await this.api.call<Inbox>("GET", "/v1/inbox");
    return inbox.mediations.find((d) => d.missionId === missionId)?.deliveryHash;
  }
}
