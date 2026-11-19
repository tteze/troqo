/**
 * Response times of the market's hot paths on a large synthetic database: what a busy market costs
 * per request. No network, no client: the server's own functions, timed.
 *
 *   npm run bench                         # 5,000 agents, 200,000 missions over 90 days
 *   npm run bench -- --agents 20000 --missions 1000000
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TroqoServer } from "../src/server/troqo.js";

const argv = process.argv.slice(2);
const opt = (name: string, d: number) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : d;
};
const AGENTS = opt("agents", 5000);
const MISSIONS = opt("missions", 200_000);
const DAYS = 90;
const RUNS = opt("runs", 5);

const dir = mkdtempSync(join(tmpdir(), "troqo-bench-"));
const troqo = new TroqoServer({ dbPath: join(dir, "bench.db") });
const db = troqo.ctx.db;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const rnd = (n: number) => Math.floor(Math.random() * n);

// ---- fill
let t = performance.now();
const ids = Array.from({ length: AGENTS }, () => randomUUID());
db.exec("BEGIN");
const insAgent = db.prepare(
  `INSERT INTO agents (agent_id, sign_public, box_public, credits, reputation, batches_passed, model, last_seen_at, created_at)
   VALUES (?, 'x', 'x', ?, ?, ?, ?, ?, ?)`,
);
for (const id of ids) {
  insAgent.run(id, rnd(200), Math.random() < 0.8 ? 1 : Math.random(), rnd(6), ["model-a", "model-b", null][rnd(3)], ago(rnd(14 * 24 * 60)), ago(rnd(DAYS * 24 * 60)));
}
const KINDS = ["code", "text", "data", "image", "review"];
const STATUSES = ["accepted", "accepted", "accepted", "accepted", "accepted", "accepted", "split", "refused", "cancelled", "expired"];
const insMission = db.prepare(
  `INSERT INTO missions (id, requester_id, kind, title, summary, price_credits, spec_hash, status, solver_id, solver_model,
     delivered_at, created_at, closed_at) VALUES (?, ?, ?, 't', 's', ?, 'h', ?, ?, ?, ?, ?, ?)`,
);
for (let i = 0; i < MISSIONS; i++) {
  const age = rnd(DAYS * 24 * 60);
  const open = i % 200 === 0;
  insMission.run(randomUUID(), ids[rnd(AGENTS)], KINDS[rnd(KINDS.length)], 1 + rnd(20), open ? "open" : STATUSES[rnd(STATUSES.length)],
    open ? null : ids[rnd(AGENTS)], ["model-a", "model-b"][rnd(2)], open ? null : ago(age - 30), ago(age), open ? null : ago(age - 60));
}
const insSupply = db.prepare(`INSERT INTO supply (reason, credits, created_at) VALUES (?, ?, ?)`);
for (let i = 0; i < MISSIONS; i++) insSupply.run(["work", "burn", "control", "advance"][rnd(4)], rnd(10) - 3, ago(rnd(DAYS * 24 * 60)));
db.exec("COMMIT");
console.log(`Filled ${AGENTS} agents and ${MISSIONS} missions in ${((performance.now() - t) / 1000).toFixed(1)} s\n`);

// ---- time
const agent = ids[0];
const m = troqo.market;
const cases: [string, () => unknown][] = [
  ["market: rates", () => m.rates()],
  ["market: history", () => m.history()],
  ["market: stats", () => m.stats()],
  ["market: faucet", () => troqo.work.faucet()],
  ["active agents", () => troqo.ctx.activeAgents()],
  ["GET /v1/market (uncached)", () => troqo.publicMarket()],
  ["GET /v1/missions/open", () => troqo.market.listOpen(agent, undefined, 50)],
  ["community active?", () => troqo.ctx.communityActive()],
  ["eligible mediators", () => troqo.ctx.activeMediators()],
  ["can this agent mediate?", () => troqo.ctx.canMediate(agent)],
  ["market sweep (every request)", () => troqo.market.sweep()],
  ["account", () => troqo.account(agent)],
  ["my missions", () => troqo.market.mine(agent)],
];
console.log("| operation | median ms | max ms |\n| --- | --- | --- |");
for (const [name, fn] of cases) {
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    t = performance.now();
    fn();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  console.log(`| ${name} | ${times[Math.floor(RUNS / 2)].toFixed(1)} | ${times[RUNS - 1].toFixed(1)} |`);
}
troqo.close();
rmSync(dir, { recursive: true, force: true });
