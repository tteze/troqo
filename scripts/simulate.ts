/**
 * Economic simulation of a starting market: scripted agents (no LLM, no cost) on a local server,
 * over simulated days. It checks whether the rules hold when the market opens: do cheaters gain
 * anything, when does community mediation start, can the going rate be swayed, how many credits
 * are created.
 *
 *   npm run simulate                 # 14 days, seed 1
 *   npm run simulate -- --days 21 --seed 7
 *   npm run simulate -- --bank 0     # no micro-task bank, as on a fresh server
 *
 * Deliveries are strings starting with GOOD or BAD: honest requesters accept GOOD and contest BAD,
 * honest mediators judge the same way. Never run against a real market.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---- simulated clock: every Date in this process (server and clients) runs on it.
const RealDate = Date;
let offsetMs = 0;
class SimDate extends RealDate {
  constructor(...args: unknown[]) {
    // @ts-expect-error spread into Date's overloads
    if (args.length === 0) super(RealDate.now() + offsetMs);
    // @ts-expect-error spread into Date's overloads
    else super(...args);
  }
  static now() {
    return RealDate.now() + offsetMs;
  }
}
globalThis.Date = SimDate as DateConstructor;
const advance = (minutes: number) => (offsetMs += minutes * 60_000);

const { TroqoServer } = await import("../src/server/troqo.js");
const { startHttp } = await import("../src/server/http.js");
const { TroqoClient } = await import("../src/client/client.js");
const { generateIdentity } = await import("../src/shared/crypto.js");
type Client = InstanceType<typeof TroqoClient>;

// ---- options and seeded randomness
const argv = process.argv.slice(2);
const opt = (name: string, d: number) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : d;
};
const DAYS = opt("days", 14);
const TICKS_PER_DAY = 12; // every 2 h: under the 4 h delivery deadline, as real agents deliver in minutes
const BANK = opt("bank", 4000);
let seed = opt("seed", 1);
const rand = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)];

// ---- the market
const troqo = new TroqoServer({ dbPath: ":memory:", powBaseBits: 0, honeypotRate: 0 });
const truth = (n: number) => (n % 2 === 0 ? "yes" : "no");
troqo.work.loadTasks([
  ...Array.from({ length: BANK }, (_, i) => ({ id: `r${i}`, kind: "classify" as const, instruction: "Is n even?", input: `n=${1000 + i}`, options: ["yes", "no"] })),
  ...Array.from({ length: Math.round(BANK * 0.3) }, (_, i) => ({
    id: `g${i}`,
    kind: "classify" as const,
    instruction: "Is n even?",
    input: `n=${90000 + i}`,
    options: ["yes", "no"],
    gold: truth(90000 + i),
  })),
]);
const server = await startHttp(troqo, { port: 0, rateLimitPerMinute: 1e9, registrationsPerHour: 1e9 });
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const homes: string[] = [];
const db = troqo.ctx.db;

// ---- agents
type Cohort =
  | "honest-requester"
  | "honest-solver"
  | "contester"
  | "whitewasher"
  | "advance-abuser"
  | "wash-trader"
  | "squatter"
  | "bot-farm";
interface Agent {
  c: Client;
  cohort: Cohort;
  model?: string;
  contests: number;
  retired: boolean;
}
const agents: Agent[] = [];
const errors = new Map<string, number>();
const note = (e: unknown) => {
  const code = (e as { code?: string }).code ?? (e as Error).message.slice(0, 40);
  errors.set(code, (errors.get(code) ?? 0) + 1);
};
const attempt = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await fn();
  } catch (e) {
    note(e);
    return undefined;
  }
};

async function join_(cohort: Cohort, model?: string): Promise<Agent> {
  const home = mkdtempSync(join(tmpdir(), "troqo-sim-"));
  homes.push(home);
  const c = new TroqoClient(url, generateIdentity(), home);
  await c.api.register();
  if (model) await c.declareModel(model);
  const a: Agent = { c, cohort, model, contests: 0, retired: false };
  agents.push(a);
  return a;
}

const KINDS = ["code", "text", "data"];
const BASE: Record<string, number> = { code: 6, text: 3, data: 4 };
const QUALITY: Record<string, number> = { "model-a": 0.95, "model-b": 0.8 };

async function microTasks(a: Agent, batches: number, honest = true) {
  for (let i = 0; i < batches; i++) {
    let b = await a.c.earnCredits().catch((e) => e as Error & { code?: string });
    if ((b as { code?: string }).code === "no_work_yet") {
      advance(0.2); // the market asks to wait a few seconds for real work before generated tasks
      b = await a.c.earnCredits().catch((e) => e as Error & { code?: string });
    }
    if (b instanceof Error) {
      note(b);
      return;
    }
    // Real tasks: honest agents know the truth. Generated ones: a capable agent (or a script) answers right.
    const expected = new Map(
      (db.prepare(`SELECT task_id, expected FROM assignments WHERE batch_id = ?`).all(b.batchId) as { task_id: string; expected: string | null }[]).map((r) => [r.task_id, r.expected]),
    );
    const answers = b.tasks.map((t) => ({
      taskId: t.taskId,
      answer: b.generated ? expected.get(t.taskId)! : honest ? truth(Number(t.input.slice(2))) : pick(["yes", "no"]),
    }));
    await attempt(() => a.c.submitWork(b.batchId, answers));
  }
}

/**
 * What a requester offers: the going rate of the model it asks for, or, for any model, the cheapest
 * model's rate (falling back to the kind's rate, then to a default), plus a little noise.
 */
async function priceFor(kind: string, model?: string): Promise<number> {
  const rate = troqo.market.rates().find((r) => r.kind === kind);
  const models = rate?.models ?? [];
  let base: number;
  if (model) base = models.find((m) => m.model === model)?.avgAcceptedPrice ?? BASE[kind] * 1.5;
  else if (models.length) base = Math.min(...models.map((m) => m.avgAcceptedPrice));
  else base = rate && rate.pairs30d >= 3 && rate.avgAcceptedPrice ? rate.avgAcceptedPrice : BASE[kind];
  return Math.max(1, Math.round(base) + pick([-1, 0, 0, 1]));
}

async function post(a: Agent, opts: { price?: number; kind?: string; model?: string } = {}) {
  const kind = opts.kind ?? pick(KINDS);
  const model = opts.model ?? (opts.price ? undefined : rand() < 0.2 ? "model-a" : undefined);
  const price = opts.price ?? (await priceFor(kind, model));
  const acc = await attempt(() => a.c.account());
  if (!acc || acc.credits + acc.advanceCredits < price) return;
  await attempt(() =>
    a.c.postMission({ kind, title: `${kind} task`, summary: `A ${kind} task for the simulation.`, spec: "Do it well.", acceptance: "GOOD", priceCredits: price, model }),
  );
}

/** Requester side: review deliveries. Honest agents accept GOOD and contest BAD; cheaters contest all. */
async function review(a: Agent, contestAll: boolean) {
  const mine = (await attempt(() => a.c.myMissions())) ?? [];
  for (const m of mine) {
    if (m.requesterId !== a.c.agentId) continue;
    if (m.status === "delivered") {
      const good = m.local.delivery?.content.startsWith("GOOD");
      if (good && !contestAll) await attempt(() => a.c.review(m.missionId, "accept"));
      else {
        const r = await attempt(() => a.c.review(m.missionId, "contest", "The delivery does not meet the acceptance criteria."));
        if (r) a.contests++;
      }
    }
    if (m.status === "mediated" && m.verdict === "accept") await attempt(() => a.c.respondToVerdict(m.missionId, "accept"));
  }
}

function trusts(m: { priceCredits: number; requester?: { paid: number; paidSolvers: number; contested: number } }) {
  const r = m.requester ?? { paid: 0, paidSolvers: 0, contested: 0 };
  if (r.contested > Math.max(1, r.paid * 0.3)) return false; // contests too often
  return r.paidSolvers >= 2 || m.priceCredits <= 4;
}

/** Solver side: deliver what it holds, take one mission it trusts, mediate, answer verdicts. */
async function solve(a: Agent, opts: { deliver: boolean }) {
  const mine = (await attempt(() => a.c.myMissions())) ?? [];
  for (const m of mine) {
    if (m.solverId !== a.c.agentId) continue;
    if (m.status === "in_progress" && m.local.spec && opts.deliver) {
      const good = rand() < (QUALITY[a.model ?? "model-b"] ?? 0.8);
      await attempt(() => a.c.deliver(m.missionId, { mime: "text/plain", content: good ? "GOOD work" : "BAD work" }));
    }
    if (m.status === "mediated" && m.verdict === "refuse") await attempt(() => a.c.respondToVerdict(m.missionId, "accept"));
  }
  const held = mine.filter((m) => m.solverId === a.c.agentId && (m.status === "taken" || m.status === "in_progress")).length;
  if (held < 1 || !opts.deliver) {
    const open = (await attempt(() => a.c.listMissions())) ?? [];
    const target = opts.deliver ? open.find((m) => trusts(m) && (!m.model || m.model === a.model)) : open.find((m) => m.priceCredits <= 4);
    if (target) await attempt(() => a.c.takeMission(target.missionId));
  }
  // Moderation duty, as the worker does: every simulated title is ordinary.
  for (const k of (await attempt(() => a.c.moderations())) ?? []) {
    await attempt(() => a.c.moderate(k.caseId, "keep", "An ordinary task title and summary, nothing illicit."));
  }
  for (const d of (await attempt(() => a.c.mediations())) ?? []) {
    if (!d.ready) continue;
    const good = d.evidence?.delivery?.content.startsWith("GOOD");
    await attempt(() => a.c.mediate(d.missionId, good ? "accept" : "refuse", good ? "The delivery meets the criterion GOOD." : "The delivery is marked BAD: criterion not met."));
  }
}

// ---- schedule: who joins when
async function arrivals(day: number) {
  const want: [Cohort, number, string?][] =
    day === 0
      ? [["honest-requester", 4], ["honest-solver", 3, "model-a"], ["honest-solver", 3, "model-b"]]
      : [["honest-requester", day <= 8 ? 1 : 0], ["honest-solver", day <= 8 ? 1 : 0, "model-a"], ["honest-solver", day <= 8 ? 1 : 0, "model-b"]];
  if (day === 1) want.push(["contester", 2], ["whitewasher", 2], ["squatter", 1]);
  if (day === 2) want.push(["wash-trader", 3, "model-c"]);
  for (const [cohort, n, model] of want) for (let i = 0; i < n; i++) await join_(cohort, model);
  // Advance abusers: two fresh identities a day, each posting one mission on an advance and vanishing.
  if (day >= 1) for (let i = 0; i < 2; i++) await join_("advance-abuser");
  // A bot farm: five fresh scripted identities a day that only farm generated tasks.
  if (day >= 1) for (let i = 0; i < 5; i++) await join_("bot-farm");
}

// ---- run
const daily: Record<string, number | string>[] = [];
let communityDay: number | null = null;
const t0 = RealDate.now();
for (let day = 0; day < DAYS; day++) {
  await arrivals(day);
  for (let tick = 0; tick < TICKS_PER_DAY; tick++) {
    const order = agents.filter((x) => !x.retired);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const a of order) {
      await attempt(() => a.c.sync());
      switch (a.cohort) {
        case "honest-requester": {
          const acc = await attempt(() => a.c.account());
          if (acc && acc.credits < 10) await microTasks(a, 2);
          if (rand() < 0.3) await post(a);
          await review(a, false);
          break;
        }
        case "honest-solver": {
          const acc = await attempt(() => a.c.account());
          if (acc && acc.credits < 6) await microTasks(a, 1);
          await solve(a, { deliver: true });
          break;
        }
        case "contester":
        case "whitewasher": {
          const acc = await attempt(() => a.c.account());
          if (acc && acc.credits < 8) await microTasks(a, 2);
          if (rand() < 0.3) await post(a);
          await review(a, true);
          if (a.cohort === "whitewasher" && a.contests >= 2) {
            a.retired = true; // sheds its record and starts over
            await join_("whitewasher");
          }
          break;
        }
        case "advance-abuser": {
          const mine = (await attempt(() => a.c.myMissions())) ?? [];
          if (!mine.length) await post(a, { price: 5, kind: "text" });
          await review(a, false);
          if (mine.some((m) => m.status === "accepted")) a.retired = true; // got the work, never repays
          break;
        }
        case "wash-trader": {
          // A ring of three identities paying each other 60 credits for "code" to inflate its rate and model-c's.
          const ring = agents.filter((x) => x.cohort === "wash-trader");
          const acc = await attempt(() => a.c.account());
          if (acc && acc.credits < 60) await microTasks(a, 3);
          if (tick % 3 === 0) await post(a, { price: 60, kind: "code" });
          const next = ring[(ring.indexOf(a) + 1) % ring.length];
          const open = (await attempt(() => a.c.listMissions("code"))) ?? [];
          const fromRing = open.find((m) => m.requesterId === ring[(ring.indexOf(a) + ring.length - 1) % ring.length].c.agentId);
          if (fromRing) await attempt(() => a.c.takeMission(fromRing.missionId));
          await solve(a, { deliver: true });
          await review(a, false);
          void next;
          break;
        }
        case "squatter":
          await solve(a, { deliver: false });
          break;
        case "bot-farm":
          await microTasks(a, 3, false); // a script: right on generated tasks, guessing on real ones
          break;
      }
    }
    advance((24 * 60) / TICKS_PER_DAY);
  }
  const active = troqo.ctx.activeAgents();
  if (communityDay === null && troqo.ctx.communityActive()) communityDay = day;
  const statuses = Object.fromEntries(
    (db.prepare(`SELECT status, COUNT(*) AS n FROM missions WHERE control_id IS NULL AND honeypot_id IS NULL GROUP BY status`).all() as { status: string; n: number }[]).map(
      (r) => [r.status, r.n],
    ),
  );
  const f = troqo.work.faucet();
  daily.push({
    day: day + 1,
    agents: agents.length,
    active,
    community: troqo.ctx.communityActive() ? "on" : "off",
    accepted: statuses.accepted ?? 0,
    split: statuses.split ?? 0,
    refused: statuses.refused ?? 0,
    open: statuses.open ?? 0,
    mediators: (() => {
      const mc = troqo.ctx.mediatorCondition();
      return (db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE ${mc.sql}`).get(...mc.params) as { n: number }).n;
    })(),
    minted24h: f.minted,
  });
}

// ---- report
const cohortOf = new Map(agents.map((a) => [a.c.agentId, a.cohort]));
const rows = db
  .prepare(
    `SELECT requester_id, solver_id, price_credits AS price, status, delivery_hash IS NOT NULL AS delivered, contest_reason IS NOT NULL AS contested
     FROM missions WHERE control_id IS NULL AND honeypot_id IS NULL`,
  )
  .all() as { requester_id: string; solver_id: string | null; price: number; status: string; delivered: number; contested: number }[];
const cohorts: Cohort[] = ["honest-requester", "contester", "whitewasher", "advance-abuser", "wash-trader"];
const asRequester = cohorts.map((k) => {
  const mine = rows.filter((r) => cohortOf.get(r.requester_id) === k);
  const delivered = mine.filter((r) => r.delivered);
  const paid = mine.reduce((s, r) => s + (r.status === "accepted" ? r.price : r.status === "split" ? Math.ceil(r.price / 2) : 0), 0);
  const value = delivered.reduce((s, r) => s + r.price, 0);
  return {
    cohort: k,
    identities: agents.filter((a) => a.cohort === k).length,
    posted: mine.length,
    deliveriesObtained: delivered.length,
    deliveredValue: value,
    creditsPaid: paid,
    paidPerValue: value ? Math.round((paid / value) * 100) / 100 : "–",
    contested: mine.filter((r) => r.contested).length,
    split: mine.filter((r) => r.status === "split").length,
    refused: mine.filter((r) => r.status === "refused").length,
  };
});
const solverRows = (["honest-solver", "squatter"] as Cohort[]).map((k) => {
  const mine = rows.filter((r) => r.solver_id && cohortOf.get(r.solver_id) === k);
  return { cohort: k, taken: mine.length, accepted: mine.filter((r) => r.status === "accepted").length, delivered: mine.filter((r) => r.delivered).length };
});
const supply = Object.fromEntries((db.prepare(`SELECT reason, SUM(credits) AS c FROM supply GROUP BY reason`).all() as { reason: string; c: number }[]).map((r) => [r.reason, r.c]));
const squatterLost = db
  .prepare(`SELECT COUNT(*) AS n FROM missions WHERE solver_id IS NULL AND status = 'open' AND requester_id IN (SELECT agent_id FROM agents)`)
  .get() as { n: number };
const rates = troqo.market.rates();
const honestCode = db
  .prepare(
    `SELECT AVG(price_credits) AS p FROM missions WHERE status = 'accepted' AND kind = 'code' AND requester_id NOT IN (${agents
      .filter((a) => a.cohort === "wash-trader")
      .map(() => "?")
      .join(",")})`,
  )
  .get(...agents.filter((a) => a.cohort === "wash-trader").map((a) => a.c.agentId)) as { p: number | null };

const mc = troqo.ctx.mediatorCondition();
const table = (items: Record<string, unknown>[]) => {
  const keys = Object.keys(items[0] ?? {});
  return [`| ${keys.join(" | ")} |`, `| ${keys.map(() => "---").join(" | ")} |`, ...items.map((r) => `| ${keys.map((k) => String(r[k])).join(" | ")} |`)].join("\n");
};
const out = [
  `# Troqo market simulation — ${DAYS} days, seed ${opt("seed", 1)}, micro-task bank ${BANK}`,
  "",
  `Run time ${Math.round((RealDate.now() - t0) / 1000)} s. Community mediation started on day ${communityDay === null ? "— (never)" : communityDay + 1}.`,
  "",
  "## Day by day",
  table(daily),
  "",
  "## Requesters: what each cohort got and paid",
  "`paidPerValue`: credits paid to solvers per credit of work obtained (1 = paid the full price).",
  "",
  table(asRequester),
  "",
  "## How contested missions ended",
  table(
    db
      .prepare(
        `SELECT status, COALESCE(outcome_reason, '') AS reason, COUNT(*) AS n FROM missions
         WHERE contest_reason IS NOT NULL AND control_id IS NULL AND honeypot_id IS NULL GROUP BY status, reason ORDER BY n DESC`,
      )
      .all() as Record<string, unknown>[],
  ),
  "",
  "## Solvers",
  table(solverRows),
  "",
  "## Honest solvers against the mediator conditions",
  `Needs: reputation >= ${troqo.config.mediatorMinReputation}, credits >= ${troqo.config.mediatorBondCredits}, >= ${troqo.config.mediatorMinRequesters} requesters, and ${troqo.config.mediatorMinBatches} batches or ${troqo.config.mediatorRequestersWithoutBatches} requesters.`,
  "",
  table(
    agents
      .filter((a) => a.cohort === "honest-solver" && !!mc)
      .map((a) => {
        const r = db
          .prepare(
            `SELECT a.reputation, a.credits, a.batches_passed AS batches,
               (SELECT COUNT(DISTINCT requester_id) FROM missions x WHERE x.solver_id = a.agent_id AND x.status = 'accepted' AND x.control_id IS NULL) AS requesters
             FROM agents a WHERE agent_id = ?`,
          )
          .get(a.c.agentId) as { reputation: number; credits: number; batches: number; requesters: number };
        return { model: a.model, reputation: Math.round(r.reputation * 100) / 100, credits: r.credits, batches: r.batches, requesters: r.requesters, eligible: db.prepare(`SELECT 1 FROM agents WHERE agent_id = ? AND ${mc.sql}`).get(a.c.agentId, ...mc.params) ? "yes" : "no" };
      }),
  ),
  "",
  "## Credits",
  "```json",
  JSON.stringify(supply, null, 2),
  "```",
  `Advance credits never repaid: ${supply.advance ?? 0}.`,
  `Bot farm: ${agents.filter((a) => a.cohort === "bot-farm").length} scripted identities hold ${
    (db
      .prepare(`SELECT COALESCE(SUM(credits), 0) AS c FROM agents WHERE agent_id IN (${agents.filter((a) => a.cohort === "bot-farm").map(() => "?").join(",") || "''"})`)
      .get(...agents.filter((a) => a.cohort === "bot-farm").map((a) => a.c.agentId)) as { c: number }).c
  } credits; generated tasks created ${supply.generated ?? 0} credits in all.`,
  "",
  "## Going rate",
  table(rates.map((r) => ({ kind: r.kind, avgAcceptedPrice: r.avgAcceptedPrice, pairs30d: r.pairs30d, accepted30d: r.accepted30d, models: r.models.map((m) => `${m.model} ${m.avgAcceptedPrice} (${m.pairs30d} pairs)`).join(", ") || "–" }))),
  `Average accepted code price without the wash-trading ring: ${honestCode.p === null ? "–" : Math.round(honestCode.p * 10) / 10}.`,
  "",
  "## Refusals seen by agents (error codes)",
  table([...errors.entries()].sort((a, b) => b[1] - a[1]).map(([code, n]) => ({ code, n }))),
  `Open missions at the end: ${squatterLost.n}.`,
].join("\n");
console.log(out);

server.closeAllConnections();
server.close();
troqo.close();
for (const h of homes) rmSync(h, { recursive: true, force: true });
