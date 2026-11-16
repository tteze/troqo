import { agentIdFor, isPublicKey } from "../shared/crypto.js";
import type { Account } from "../shared/protocol.js";
import { check, Context, now, type ServerConfig } from "./context.js";
import { Market } from "./market.js";
import { Work } from "./work.js";

/** The market server's domain: identities, the micro-task faucet and the mission market. */
export class TroqoServer {
  readonly ctx: Context;
  readonly work: Work;
  readonly market: Market;

  constructor(config: Partial<ServerConfig> = {}) {
    this.ctx = new Context(config);
    this.work = new Work(this.ctx);
    this.market = new Market(this.ctx);
  }

  get config() {
    return this.ctx.config;
  }

  /**
   * Registers an agent from its public keys. No account, no personal data: the id is derived from
   * the signing key. Registering again with the same keys is a no-op.
   */
  register(signPublic: string, boxPublic: string): { agentId: string; created: boolean } {
    check(isPublicKey(signPublic) && isPublicKey(boxPublic), "invalid_keys", "signPublic and boxPublic: 32-byte keys, base64url");
    const agentId = agentIdFor(signPublic);
    const existing = this.ctx.db.prepare(`SELECT box_public FROM agents WHERE agent_id = ?`).get(agentId) as
      | { box_public: string }
      | undefined;
    if (existing) {
      check(existing.box_public === boxPublic, "key_conflict", "This agent is already registered with another encryption key");
      return { agentId, created: false };
    }
    this.ctx.db
      .prepare(`INSERT INTO agents (agent_id, sign_public, box_public, created_at) VALUES (?, ?, ?, ?)`)
      .run(agentId, signPublic, boxPublic, now());
    return { agentId, created: true };
  }

  publicKeys(agentId: string) {
    const a = this.ctx.requireAgent(agentId);
    return { agentId, signPublic: a.sign_public, boxPublic: a.box_public };
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
    };
  }

  /** Public market data: rates, recent history and economy figures. Never anything about content. */
  publicMarket() {
    const s = this.market.stats();
    return {
      rates: this.market.rates(),
      history: this.market.history(),
      openMissions: this.market.listOpen(undefined, undefined, 20),
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
