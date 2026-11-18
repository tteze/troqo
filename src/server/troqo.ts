import { agentIdFor, isPublicKey, verifyAgentKeys } from "../shared/crypto.js";
import { verifyPow, type PowChallenge } from "../shared/pow.js";
import type { Account } from "../shared/protocol.js";
import { check, Context, minutesAgo, now, type ServerConfig } from "./context.js";
import { Market } from "./market.js";
import { Work } from "./work.js";
import { Certifier } from "./certification/certifier.js";
import { Moderation } from "./moderation.js";
import { DEFAULT_POLICY, validatePolicy, type CertificationPolicy } from "./certification/policy.js";

/** The market server's domain: identities, the micro-task faucet and the mission market. */
export class TroqoServer {
  readonly ctx: Context;
  readonly work: Work;
  readonly market: Market;
  readonly certifier: Certifier;
  readonly moderation: Moderation;

  constructor(config: Partial<ServerConfig> = {}, policy: CertificationPolicy = DEFAULT_POLICY) {
    this.ctx = new Context(config);
    this.work = new Work(this.ctx);
    this.market = new Market(this.ctx);
    this.certifier = new Certifier(this.ctx, this.market, validatePolicy(policy));
    this.market.certifier = this.certifier;
    this.moderation = new Moderation(this.ctx);
    this.market.moderation = this.moderation;
    this.market.work = this.work;
  }

  get config() {
    return this.ctx.config;
  }

  /**
   * Registers an agent from its public keys. No account, no personal data: the id is derived from
   * the signing key. Registering again with the same keys is a no-op.
   */
  register(
    signPublic: string,
    boxPublic: string,
    boxSignature: string,
    pow = "",
    challenge: PowChallenge = this.powChallenge(),
  ): { agentId: string; created: boolean } {
    check(isPublicKey(signPublic) && isPublicKey(boxPublic), "invalid_keys", "signPublic and boxPublic: 32-byte keys, base64url");
    const agentId = agentIdFor(signPublic);
    check(
      verifyAgentKeys({ agentId, signPublic, boxPublic, boxSignature }),
      "invalid_keys",
      "boxSignature: Ed25519 signature of \"troqo-box-v1\\n<agentId>\\n<boxPublic>\" by the signing key",
    );
    const existing = this.ctx.db.prepare(`SELECT box_public FROM agents WHERE agent_id = ?`).get(agentId) as
      | { box_public: string }
      | undefined;
    if (existing) {
      check(existing.box_public === boxPublic, "key_conflict", "This agent is already registered with another encryption key");
      return { agentId, created: false };
    }
    check(
      verifyPow(signPublic, pow, challenge),
      "pow_required",
      `Registration needs a proof of work of ${challenge.bits} bits (see GET /v1/pow and /api.md)`,
    );
    this.ctx.db
      .prepare(`INSERT INTO agents (agent_id, sign_public, box_public, box_signature, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(agentId, signPublic, boxPublic, boxSignature, now());
    return { agentId, created: true };
  }

  /**
   * Current proof-of-work difficulty for new identities. It rises by one bit (twice the work) each
   * time registrations over the last hour double beyond the calm rate, and falls back by itself.
   */
  powChallenge(): PowChallenge {
    const cfg = this.config;
    if (cfg.powBaseBits <= 0) return { bits: 0, cost: cfg.powCost };
    const recent = (this.ctx.db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE system = 0 AND created_at >= ?`).get(minutesAgo(60)) as { n: number }).n;
    const extra = recent > cfg.powCalmRegistrationsPerHour ? Math.floor(Math.log2(recent / cfg.powCalmRegistrationsPerHour)) + 1 : 0;
    // Market-wide surges add at most 3 bits (8× the work), so an attacker cannot lock honest newcomers out;
    // surges from one network are priced at the HTTP layer, for that network only.
    return { bits: cfg.powBaseBits + Math.min(extra, 3), cost: cfg.powCost };
  }

  publicKeys(agentId: string) {
    const a = this.ctx.requireAgent(agentId);
    return { agentId, signPublic: a.sign_public, boxPublic: a.box_public, boxSignature: a.box_signature };
  }

  /** Public keys, declared model, certifications and track record. */
  publicProfile(agentId: string) {
    return { ...this.publicKeys(agentId), ...this.certifier.profile(agentId) };
  }

  account(agentId: string): Account {
    const a = this.ctx.requireAgent(agentId);
    return {
      agentId,
      credits: a.credits,
      reputation: Math.round(a.reputation * 100) / 100,
      batchesPassed: a.batches_passed,
      batchesFailed: a.batches_failed,
      missionsSolved: a.missions_solved,
      canMediate: this.ctx.canMediate(agentId),
      communityActive: this.ctx.communityActive(),
      advanceCredits: this.market.advanceAllowance(agentId).credits,
    };
  }

  /** Public market data: rates, recent history and economy figures. Never anything about content. */
  publicMarket() {
    const s = this.market.stats();
    return {
      rates: this.market.rates(),
      history: this.market.history(),
      openMissions: this.market.listOpen(undefined, undefined, 20),
      faucet: this.work.faucet(),
      community: {
        activeAgents: this.ctx.activeAgents(),
        threshold: this.config.communityMinActiveAgents,
        active: this.ctx.communityActive(),
      },
      advance: { maxCredits: this.config.advanceMaxCredits, available: this.config.advanceMaxCredits > 0 && !this.ctx.communityActive() },
      agents: s.agents,
      credits: s.credits,
      missions: s.missions,
      updatedAt: now(),
    };
  }

  stats() {
    return { work: this.work.stats(), market: this.market.stats() };
  }

  close() {
    this.ctx.db.close();
  }
}
