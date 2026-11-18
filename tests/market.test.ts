import { afterEach, describe, expect, it } from "vitest";
import { generateIdentity, signRequest } from "../src/shared/crypto.js";
import { backdate, market, SPEC, type TestMarket } from "./helpers.js";

let m: TestMarket;
afterEach(() => m?.close());

/** Everything the server stores, as one string, to prove no content leaks into it. */
function serverDump(t: TestMarket): string {
  const tables = ["agents", "missions", "mediations", "messages", "batches"];
  return tables.map((n) => JSON.stringify(t.troqo.ctx.db.prepare(`SELECT * FROM ${n}`).all())).join("\n");
}

async function delivered(
  t: TestMarket,
  delivery = "export const slugify = (s: string) => s.toLowerCase().split(' ').join('-');",
  solverCredits = 2, // the bond of a 10-credit mission
) {
  const req = await t.agent(20);
  const sol = await t.agent(solverCredits);
  const posted = await req.postMission(SPEC);
  await sol.takeMission(posted.missionId);
  await req.sync(); // hands the encrypted spec over
  await sol.sync(); // receives and checks it
  await sol.deliver(posted.missionId, { mime: "text/plain", content: delivery });
  await req.sync(); // receives the delivery
  return { req, sol, id: posted.missionId };
}

describe("a mission between two agents", () => {
  it("moves spec and delivery end to end encrypted; the server never holds them in clear", async () => {
    m = await market();
    const { req, sol, id } = await delivered(m);

    const solverView = await sol.mission(id);
    expect(solverView.local.spec?.spec).toBe(SPEC.spec);
    expect(solverView.local.specTampered).toBe(false);
    const requesterView = await req.mission(id);
    expect(requesterView.status).toBe("delivered");
    expect(requesterView.local.delivery?.content).toContain("slugify");

    const dump = serverDump(m);
    expect(dump).not.toContain("Lowercase; words separated");
    expect(dump).not.toContain("toLowerCase");
    expect(dump).toContain(SPEC.summary); // the public summary is the only text the market keeps
    // Fetched ciphertext is erased; rows remain as proof of sending.
    expect(m.troqo.ctx.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE envelope IS NOT NULL`).get()).toEqual({ n: 0 });

    await req.review(id, "accept");
    expect((await sol.account()).credits).toBe(11); // bond back, plus 10 minus 10% burned
    expect((await req.account()).credits).toBe(10);
    expect(m.troqo.market.stats().credits.burned).toBe(1);
  });

  it("requires credits earned beforehand and keeps the mission private to its parties", async () => {
    m = await market();
    const poor = await m.agent(3);
    await expect(poor.postMission(SPEC)).rejects.toMatchObject({ code: "insufficient_credits" });
    const req = await m.agent(20);
    const posted = await req.postMission(SPEC);
    expect((await poor.listMissions()).map((x) => x.missionId)).toContain(posted.missionId);
    expect(await req.listMissions()).toHaveLength(0);
    const sol = await m.agent(2);
    await sol.takeMission(posted.missionId);
    await expect(poor.mission(posted.missionId)).rejects.toMatchObject({ code: "unknown_mission" });
    await expect(poor.takeMission(posted.missionId)).rejects.toMatchObject({ code: "mission_not_open" });
  });

  it("refunds a mission cancelled before its spec was handed over", async () => {
    m = await market();
    const req = await m.agent(20);
    const posted = await req.postMission(SPEC);
    const sol = await m.agent(2);
    await sol.takeMission(posted.missionId);
    expect((await sol.account()).credits).toBe(0); // bond locked
    await req.cancelMission(posted.missionId);
    expect((await req.account()).credits).toBe(20);
    expect((await sol.account()).credits).toBe(2); // bond returned
  });

  it("applies deadlines: handoff, delivery and review", async () => {
    m = await market();
    const req = await m.agent(30);
    const sol = await m.agent(2);
    const a = await req.postMission(SPEC);
    await sol.takeMission(a.missionId);
    backdate(m, `UPDATE missions SET taken_at = ? WHERE id = ?`, a.missionId);
    expect((await sol.listMissions()).map((x) => x.missionId)).toContain(a.missionId);
    expect((await sol.account()).credits).toBe(2); // spec never came: not the solver's fault, bond returned

    const { req: r2, sol: s2, id } = await delivered(m);
    backdate(m, `UPDATE missions SET delivered_at = ? WHERE id = ?`, id);
    expect((await r2.mission(id)).status).toBe("accepted");
    expect((await s2.account()).credits).toBe(11);
  });
});

describe("disputes", () => {
  it("first mediation, appeal to three, majority wins and the minority is not paid", async () => {
    m = await market();
    const mediators = await Promise.all([1, 2, 3, 4].map(() => m.agent(0, { mediator: true })));
    const { req, sol, id } = await delivered(m, undefined, 3); // 3 credits: enough to appeal
    await req.review(id, "contest", "It does not collapse repeated spaces.");
    await req.sync();
    await sol.sync(); // both parties send their pieces to the drawn mediator

    const first = (await Promise.all(mediators.map(async (x) => ({ x, list: await x.mediations() })))).find((e) => e.list.length)!;
    expect(first.list[0].ready).toBe(false);
    await first.x.sync();
    const [d] = await first.x.mediations();
    expect(d.ready).toBe(true);
    expect(d.evidence?.spec?.acceptance).toBe(SPEC.acceptance);
    expect(d.evidence?.deliveryTampered).toBe(false);
    await first.x.mediate(id, "refuse", "Repeated spaces produce double dashes.");
    expect((await sol.mission(id)).status).toBe("mediated");

    await sol.respondToVerdict(id, "appeal");
    await req.sync();
    await sol.sync();
    const panel = [];
    for (const x of mediators) {
      if (x === first.x) continue;
      await x.sync();
      if ((await x.mediations()).length) panel.push(x);
    }
    expect(panel).toHaveLength(3);
    await panel[0].mediate(id, "accept", "The only stated criterion is met.");
    await panel[1].mediate(id, "refuse", "Spaces should collapse into one dash.");
    await panel[2].mediate(id, "accept", "The acceptance example passes as written.");

    expect((await req.mission(id)).status).toBe("accepted");
    expect((await sol.account()).credits).toBe(12); // 3 appeal fees back, plus 9
    expect((await panel[0].account()).credits).toBe(1);
    expect((await panel[2].account()).credits).toBe(1);
    expect((await panel[1].account()).credits).toBe(0);
    expect((await first.x.account()).credits).toBe(0);
    expect((await req.account()).credits).toBe(8); // 20 - 10 escrow - 2 fees (1 from the contest deposit)
  });

  it("flags a piece that does not match its fingerprint", async () => {
    m = await market();
    const mediator = await m.agent(0, { mediator: true });
    const { req, sol, id } = await delivered(m);
    await req.review(id, "contest", "It does not collapse repeated spaces.");
    sol.store.update(id, (l) => (l.delivery = { mime: "text/plain", content: "a better version, swapped after the fact" }));
    await req.sync();
    await sol.sync();
    await mediator.sync();
    const [d] = await mediator.mediations();
    expect(d.evidence?.deliveryTampered).toBe(true);
    expect(d.evidence?.specTampered).toBe(false);
  });

  it("a party that never sends its piece loses", async () => {
    m = await market();
    await m.agent(0, { mediator: true });
    const { req, sol, id } = await delivered(m);
    await req.review(id, "contest", "It does not collapse repeated spaces.");
    await req.sync(); // the requester sends its piece, the solver never does
    backdate(m, `UPDATE mediations SET assigned_at = ? WHERE mission_id = ?`, id);
    const view = await req.mission(id);
    expect(view.status).toBe("refused");
    expect((await req.account()).credits).toBe(20); // price and contest deposit refunded
    expect((await sol.account()).credits).toBe(2); // only its bond, returned on delivery
  });
});

describe("checking mediators with fake disputes", () => {
  it("pays a right verdict, penalizes a wrong one, and looks like a real dispute", async () => {
    m = await market({ honeypotRate: 1 });
    m.troqo.market.loadHoneypots([
      {
        id: "hp1",
        kind: "text",
        title: "Translate a sentence to French",
        summary: "Translate one short English sentence into French.",
        spec: "Translate: 'The cat sleeps on the sofa.'",
        acceptance: "A correct, natural French translation.",
        delivery: { mime: "text/plain", content: "Le chien mange dans la cuisine." },
        contestReason: "This is not a translation of the sentence.",
        verdict: "refuse",
      },
      {
        id: "hp2",
        kind: "text",
        title: "Capitalize a word",
        summary: "Return the word in capital letters.",
        spec: "Capitalize: 'troqo'",
        acceptance: "Exactly TROQO.",
        delivery: { mime: "text/plain", content: "TROQO" },
        contestReason: "I wanted lowercase.",
        verdict: "accept",
      },
    ]);
    const med = await m.agent(0, { mediator: true });
    await med.sync();
    const [d1] = await med.mediations();
    expect(d1.ready).toBe(true);
    const wrong = d1.title.startsWith("Translate") ? "accept" : "refuse";
    await med.mediate(d1.missionId, wrong, "Judged quickly without reading.");
    const after = await med.account();
    expect(after.credits).toBe(0);
    expect(after.reputation).toBeLessThan(1);

    await med.sync();
    const [d2] = await med.mediations();
    const right = d2.title.startsWith("Translate") ? "refuse" : "accept";
    await med.mediate(d2.missionId, right, "Matches the acceptance criteria exactly.");
    expect((await med.account()).credits).toBe(1);
    expect(m.troqo.market.stats().honeypotVotes).toBe(2);
    expect(await med.listMissions()).toHaveLength(0); // fake disputes never show on the market
  });
});

describe("micro-tasks", () => {
  it("earns credits with two hidden controls and reveals only pass or fail", async () => {
    m = await market();
    const a = await m.agent();
    const batch = await a.earnCredits();
    expect(batch.tasks).toHaveLength(6);
    const answers = batch.tasks.map((t) => ({ taskId: t.taskId, answer: t.taskId.startsWith("g") ? "yes" : "no" }));
    const out = await a.submitWork(batch.batchId, answers);
    expect(out).toEqual({ passed: true, creditsEarned: 4, creditsBalance: 4 });
    expect(m.troqo.market.stats().credits.created).toEqual({ work: 4 });

    const b2 = await a.earnCredits();
    const bad = await a.submitWork(b2.batchId, b2.tasks.map((t) => ({ taskId: t.taskId, answer: "no" })));
    expect(bad).toEqual({ passed: false, creditsEarned: 0, creditsBalance: 4 });
  });

  it("caps batches per day", async () => {
    m = await market({ maxWorkBatchesPerDay: 1 });
    const a = await m.agent();
    const b = await a.earnCredits();
    await a.submitWork(b.batchId, b.tasks.map((t) => ({ taskId: t.taskId, answer: "yes" })));
    await expect(a.earnCredits()).rejects.toMatchObject({ code: "daily_work_limit" });
  });
});

describe("API security", () => {
  it("rejects unsigned, forged and replayed requests", async () => {
    m = await market();
    const a = await m.agent();
    expect((await fetch(`${m.url}/v1/account`)).status).toBe(401);

    const id = a.identity;
    const headers = signRequest(id, "GET", "/v1/account", "");
    expect((await fetch(`${m.url}/v1/account`, { headers })).status).toBe(200);
    expect((await fetch(`${m.url}/v1/account`, { headers })).status).toBe(401); // replay

    const other = generateIdentity();
    const forged = { ...signRequest(other, "GET", "/v1/account", ""), "x-troqo-agent": id.agentId };
    expect((await fetch(`${m.url}/v1/account`, { headers: forged })).status).toBe(401);

    const body = JSON.stringify({ kind: "code", title: "t", summary: "s", priceCredits: 1, specHash: "0".repeat(64) });
    const signed = signRequest(id, "POST", "/v1/missions", body);
    const res = await fetch(`${m.url}/v1/missions`, {
      method: "POST",
      headers: { ...signed, "content-type": "application/json" },
      body: body.replace('"t"', '"tampered"'),
    });
    expect(res.status).toBe(401);
  });

  it("rate-limits by address", async () => {
    const troqoMarket = await market();
    await troqoMarket.close();
    const { TroqoServer } = await import("../src/server/troqo.js");
    const { startHttp } = await import("../src/server/http.js");
    const server = await startHttp(new TroqoServer({ dbPath: ":memory:" }), { port: 0, rateLimitPerMinute: 3 });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/health`;
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(url)).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    await new Promise<void>((r) => server.close(() => r()));
    m = undefined as unknown as TestMarket;
  });

  it("publishes market data without any content", async () => {
    m = await market();
    const req = await m.agent(20);
    await req.postMission(SPEC);
    const pub = (await (await fetch(`${m.url}/v1/market`)).json()) as { rates: { kind: string; open: number }[] };
    expect(pub.rates).toEqual([expect.objectContaining({ kind: "code", open: 1 })]);
    expect(JSON.stringify(pub)).not.toContain(SPEC.spec);
  });
});
