import { afterEach, describe, expect, it } from "vitest";
import { generateIdentity, signBoxKey, signRequest } from "../src/shared/crypto.js";
import { leadingZeroBits, solvePow, verifyPow } from "../src/shared/pow.js";
import { addressKey } from "../src/server/http.js";
import { backdate, market, SPEC, type TestMarket } from "./helpers.js";

let m: TestMarket;
afterEach(() => m?.close());

const allYes = (tasks: { taskId: string }[]) => tasks.map((t) => ({ taskId: t.taskId, answer: t.taskId.startsWith("g") ? "yes" : "no" }));

describe("bonds instead of seniority", () => {
  it("lets a newcomer take cheap missions for free and asks a bond above", async () => {
    m = await market();
    const req = await m.agent(30);
    const cheap = await req.postMission({ ...SPEC, priceCredits: 4 });
    const dear = await req.postMission(SPEC);
    const newcomer = await m.agent(0);
    expect((await newcomer.listMissions()).find((x) => x.missionId === dear.missionId)?.bondCredits).toBe(2);
    await expect(newcomer.takeMission(dear.missionId)).rejects.toMatchObject({ code: "insufficient_credits" });
    await newcomer.takeMission(cheap.missionId);
    expect((await newcomer.account()).credits).toBe(0);
  });

  it("gives the bond to the requester when the solver does not deliver", async () => {
    m = await market();
    const req = await m.agent(10);
    const sol = await m.agent(5);
    const posted = await req.postMission(SPEC);
    await sol.takeMission(posted.missionId);
    await req.sync(); // spec handed over
    backdate(m, `UPDATE missions SET spec_sent_at = ? WHERE id = ?`, posted.missionId);
    expect((await req.mission(posted.missionId)).status).toBe("open");
    expect((await req.account()).credits).toBe(2); // 10 - 10 escrow + 2 bond
    const after = await sol.account();
    expect(after.credits).toBe(3);
    expect(after.reputation).toBeLessThan(1);
  });

  it("asks the mediation fee up front to contest, and never lets a balance go negative", async () => {
    m = await market();
    const mediator = await m.agent(0, { mediator: true });
    const req = await m.agent(10);
    const sol = await m.agent(2);
    const posted = await req.postMission(SPEC);
    await sol.takeMission(posted.missionId);
    await req.sync();
    await sol.sync();
    await sol.deliver(posted.missionId, { mime: "text/plain", content: "not even code" });
    await req.sync();
    await expect(req.review(posted.missionId, "contest", "This is not a function at all.")).rejects.toMatchObject({
      code: "insufficient_credits",
    });

    m.troqo.ctx.credit(req.agentId, 1);
    await req.review(posted.missionId, "contest", "This is not a function at all.");
    expect((await req.account()).credits).toBe(0); // the fee is locked
    m.troqo.ctx.db.prepare(`UPDATE agents SET credits = 0 WHERE agent_id = ?`).run(sol.agentId); // the solver spent everything
    await req.sync();
    await sol.sync();
    await mediator.sync();
    await mediator.mediate(posted.missionId, "refuse", "The delivery is not code; the criterion fails.");
    await sol.respondToVerdict(posted.missionId, "accept");

    expect((await req.account()).credits).toBe(11); // escrow and deposit back
    expect((await sol.account()).credits).toBe(0); // owed 1, had 0: not negative
    expect((await mediator.account()).credits).toBe(1); // paid anyway
    expect(m.troqo.market.stats().credits.created).toMatchObject({ mediation: 1 });
  });
});

describe("market-wide cap on credit creation", () => {
  it("shares one daily budget between all identities", async () => {
    m = await market({ mintBaseCreditsPerDay: 8 });
    const a = await m.agent();
    const b = await m.agent();
    const batchA = await a.earnCredits();
    const batchB = await b.earnCredits();
    await expect((await m.agent()).earnCredits()).rejects.toMatchObject({ code: "faucet_dry" });
    expect((await a.submitWork(batchA.batchId, allYes(batchA.tasks))).creditsEarned).toBe(4);
    expect((await b.submitWork(batchB.batchId, allYes(batchB.tasks))).creditsEarned).toBe(4);
    await expect(a.earnCredits()).rejects.toMatchObject({ code: "faucet_dry" });
    const pub = (await (await fetch(`${m.url}/v1/market`)).json()) as { faucet: { budget: number; minted: number } };
    expect(pub.faucet).toEqual({ budget: 8, minted: 8 });
  });

  it("grows with the credits paid on accepted missions", async () => {
    m = await market({ mintBaseCreditsPerDay: 0, mintActivityRatio: 0.5 });
    const t = new Date().toISOString();
    m.troqo.ctx.db
      .prepare(
        `INSERT INTO missions (id, requester_id, kind, title, summary, price_credits, spec_hash, status, solver_id, created_at, closed_at)
         VALUES ('x', 'a', 'code', 't', 's', 70, 'h', 'accepted', 'b', ?, ?)`,
      )
      .run(t, t);
    expect(m.troqo.work.faucet()).toEqual({ budget: 5, minted: 0 }); // 0.5 × 70 / 7 days
  });
});

describe("proof of work at registration", () => {
  it("is solved by the client and required by the server", async () => {
    m = await market({ powBaseBits: 4, powCost: 1024 });
    const pow = (await (await fetch(`${m.url}/v1/pow`)).json()) as { bits: number; cost: number };
    expect(pow).toEqual({ bits: 4, cost: 1024 });
    const ok = await m.agent(); // the client solves it
    expect((await ok.account()).credits).toBe(0);

    const id = generateIdentity();
    const body = JSON.stringify({ signPublic: id.signPublic, boxPublic: id.boxPublic, boxSignature: signBoxKey(id) });
    const res = await fetch(`${m.url}/v1/register`, {
      method: "POST",
      headers: { ...signRequest(id, "POST", "/v1/register", body), "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "pow_required" });
  });

  it("binds the proof to the key and gets harder when registrations surge", async () => {
    const c = { bits: 6, cost: 1024 };
    const a = generateIdentity();
    const nonce = await solvePow(a.signPublic, c);
    expect(verifyPow(a.signPublic, nonce, c)).toBe(true);
    expect(verifyPow(generateIdentity().signPublic, nonce, { bits: 12, cost: 1024 })).toBe(false);
    expect(leadingZeroBits(Buffer.from([0, 0x10]))).toBe(11);

    m = await market({ powBaseBits: 7, powCalmRegistrationsPerHour: 2 });
    expect(m.troqo.powChallenge().bits).toBe(7);
    const ins = m.troqo.ctx.db.prepare(`INSERT INTO agents (agent_id, sign_public, box_public, created_at) VALUES (?, '', '', ?)`);
    for (let i = 0; i < 8; i++) ins.run(`ag_${i}`, new Date().toISOString());
    expect(m.troqo.powChallenge().bits).toBe(10); // 8 = 4 × the calm rate: +3 bits
  });
});

describe("rate limits and market rates", () => {
  it("limits IPv6 per /64 prefix", () => {
    expect(addressKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:0db8:0001:0002:ffff:0:0:9")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(addressKey("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(addressKey("203.0.113.5")).toBe("203.0.113.5");
  });

  it("averages the going price per pair of agents, so self-trading moves it little", async () => {
    m = await market();
    const t = new Date().toISOString();
    const ins = m.troqo.ctx.db.prepare(
      `INSERT INTO missions (id, requester_id, kind, title, summary, price_credits, spec_hash, status, solver_id, created_at, closed_at)
       VALUES (?, ?, 'code', 't', 's', ?, 'h', 'accepted', ?, ?, ?)`,
    );
    for (let i = 0; i < 9; i++) ins.run(`wash${i}`, "sybil1", 90, "sybil2", t, t); // one pair, many trades
    ins.run("honest", "alice", 10, "bob", t, t);
    const [rate] = m.troqo.market.rates();
    expect(rate).toMatchObject({ kind: "code", accepted30d: 10, pairs30d: 2, avgAcceptedPrice: 50 });
  });
});
