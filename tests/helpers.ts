import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { generateIdentity } from "../src/shared/crypto.js";
import { TroqoClient } from "../src/client/client.js";
import { startHttp } from "../src/server/http.js";
import { TroqoServer } from "../src/server/troqo.js";
import type { ServerConfig } from "../src/server/context.js";
import type { TaskDefinition } from "../src/server/work.js";
import { DEFAULT_POLICY, type CertificationPolicy } from "../src/server/certification/policy.js";

export const OPTIONS = ["yes", "no"];
export const ADMIN_TOKEN = "test-admin-token";

export const bank = (real: number, gold: number): TaskDefinition[] => [
  ...Array.from({ length: real }, (_, i) => ({
    id: `r${i}`,
    kind: "classify" as const,
    instruction: "Is it a fruit?",
    input: `item ${i}`,
    options: OPTIONS,
  })),
  ...Array.from({ length: gold }, (_, i) => ({
    id: `g${i}`,
    kind: "classify" as const,
    instruction: "Is it a fruit?",
    input: `apple ${i}`,
    options: OPTIONS,
    gold: "yes",
  })),
];

export interface TestMarket {
  troqo: TroqoServer;
  url: string;
  server: Server;
  agent: (credits?: number, opts?: { mediator?: boolean }) => Promise<TroqoClient>;
  close: () => Promise<void>;
}

/** A real market server on a random port, with a helper to create funded agents. */
export async function market(config: Partial<ServerConfig> = {}, policy: CertificationPolicy = DEFAULT_POLICY): Promise<TestMarket> {
  // Tests opt into the mediator bond and track record (tests/security.test.ts); elsewhere they would
  // only shift every balance by the bond.
  const troqo = new TroqoServer(
    { dbPath: ":memory:", honeypotRate: 0, powBaseBits: 0, mediatorBondCredits: 0,
    communityMinMediators: 0,
    moderationSampleRate: 0, mediatorMinRequesters: 0, ...config },
    policy,
  );
  troqo.work.loadTasks(bank(40, 10));
  const server = await startHttp(troqo, { port: 0, adminToken: ADMIN_TOKEN, rateLimitPerMinute: 10_000, registrationsPerHour: 1000 });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    troqo,
    url,
    server,
    async agent(credits = 0, opts = {}) {
      const home = mkdtempSync(join(tmpdir(), "troqo-test-"));
      const c = new TroqoClient(url, generateIdentity(), home);
      await c.api.register();
      troqo.ctx.db
        .prepare(`UPDATE agents SET credits = ?, batches_passed = ? WHERE agent_id = ?`)
        .run(credits, opts.mediator ? 5 : 0, c.agentId);
      return c;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export const SPEC = {
  kind: "code",
  title: "Write a slugify function",
  summary: "TypeScript slugify(s): lowercase, words joined by dashes.",
  spec: "Write slugify(s: string): string in TypeScript. Lowercase; words separated by single dashes.",
  acceptance: "slugify('Hello World') === 'hello-world'",
  priceCredits: 10,
};

/** Moves a timestamp column far into the past to trigger a deadline. */
export const backdate = (m: TestMarket, sql: string, ...params: string[]) =>
  m.troqo.ctx.db.prepare(sql).run("2000-01-01T00:00:00.000Z", ...params);
