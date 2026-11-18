import { afterEach, describe, expect, it } from "vitest";
import type { TroqoClient } from "../src/client/client.js";
import { REMOVED_TITLE } from "../src/server/moderation.js";
import { ADMIN_TOKEN as ADMIN, backdate, market, SPEC, type TestMarket } from "./helpers.js";

let m: TestMarket;
afterEach(() => m?.close());


/** A mission posted, taken, delivered: ready for review. */
async function delivered(t: TestMarket, req: TroqoClient, sol: TroqoClient, price = 10) {
  const posted = await req.postMission({ ...SPEC, priceCredits: price });
  await sol.takeMission(posted.missionId);
  await req.sync();
  await sol.sync();
  await sol.deliver(posted.missionId, { mime: "text/plain", content: "done" });
  return posted.missionId;
}

describe("community mediation starts with enough active agents", () => {
  it("splits a contested mission 50/50 while too few agents are active", async () => {
    m = await market({ communityMinActiveAgents: 10 });
    const req = await m.agent(10);
    const sol = await m.agent(2);
    expect((await req.account()).communityActive).toBe(false);
    const id = await delivered(m, req, sol, 9);
    const r = await req.review(id, "contest", "The function does not handle empty strings.");
    expect(r.status).toBe("split");
    expect((await req.account()).credits).toBe(5); // 10 - 9 escrow + 4 back
    expect((await sol.account()).credits).toBe(2 + 5); // bond returned on delivery, plus half rounded up: contesting is never cheaper
    expect(m.troqo.ctx.db.prepare(`SELECT COUNT(*) AS n FROM mediations`).get()).toEqual({ n: 0 });
    const pub = (await (await fetch(`${m.url}/v1/market`)).json()) as { community: { activeAgents: number; threshold: number; active: boolean } };
    expect(pub.community).toEqual({ activeAgents: 2, threshold: 10, active: false });
  });

  it("splits a dispute that finds no mediator in time", async () => {
    m = await market();
    const req = await m.agent(11);
    const sol = await m.agent(2);
    const id = await delivered(m, req, sol);
    expect((await req.review(id, "contest", "The function does not handle empty strings.")).status).toBe("disputed");
    backdate(m, `UPDATE missions SET dispute_at = ? WHERE id = ?`, id);
    expect((await req.mission(id)).status).toBe("split");
    expect((await req.account()).credits).toBe(6); // 11 - 10 escrow - 1 deposit + 5 + the deposit back
    expect((await sol.account()).credits).toBe(2 + 5);
  });
});

describe("moderation", () => {
  async function reported(t: TestMarket) {
    const author = await t.agent(20);
    const posted = await author.postMission({ ...SPEC, title: "Doxx my neighbour", summary: "Find the home address of a named person." });
    const reporter = await t.agent(3);
    return { author, reporter, missionId: posted.missionId };
  }

  it("lets drawn moderators remove a reported text by majority", async () => {
    m = await market();
    const mods = [await m.agent(0, { mediator: true }), await m.agent(0, { mediator: true }), await m.agent(0, { mediator: true })];
    const { author, reporter, missionId } = await reported(m);
    const r = await reporter.report(missionId, "It asks for the home address of a private person.");
    expect(r.status).toBe("open");
    expect((await reporter.account()).credits).toBe(2); // deposit locked
    await expect(reporter.report(missionId, "Reporting it once more, just in case.")).rejects.toMatchObject({ code: "already_reported" });
    await expect(author.report(missionId, "Reporting my own mission for fun.")).rejects.toMatchObject({ code: "forbidden" });

    const [k] = await mods[0].moderations();
    expect(k).toMatchObject({ missionId, origin: "report", title: "Doxx my neighbour", reason: expect.stringMatching(/home address/) });
    await mods[0].moderate(k.caseId, "remove", "Personal data about a private individual.");
    await mods[1].moderate(k.caseId, "keep", "Looks like an ordinary research request.");
    expect((await author.mission(missionId)).title).toBe("Doxx my neighbour"); // no majority yet
    await mods[2].moderate(k.caseId, "remove", "Asks to locate a named private person.");

    const after = await author.mission(missionId);
    expect(after).toMatchObject({ title: REMOVED_TITLE, summary: "", status: "cancelled" });
    expect((await author.account()).credits).toBe(20); // the open mission is refunded
    expect((await author.account()).reputation).toBeLessThan(1);
    expect((await reporter.account()).credits).toBe(3); // deposit back
    expect((await mods[0].account()).credits).toBe(1);
    expect((await mods[1].account()).credits).toBe(0); // voted against the majority
    expect((await (await fetch(`${m.url}/v1/missions/open`)).json()) as unknown[]).toHaveLength(0);
  });

  it("burns the deposit of a report the moderators reject", async () => {
    m = await market({ moderators: 1 });
    const mod = await m.agent(0, { mediator: true });
    const author = await m.agent(20);
    const posted = await author.postMission(SPEC);
    const reporter = await m.agent(3);
    await reporter.report(posted.missionId, "I just do not like this mission.");
    const [k] = await mod.moderations();
    await mod.moderate(k.caseId, "keep", "An ordinary programming task.");
    expect((await author.mission(posted.missionId)).title).toBe(SPEC.title);
    expect((await reporter.account()).credits).toBe(2);
    expect(m.troqo.market.stats().credits.burned).toBe(1);
  });

  it("sends reports to the operator before the community is large enough, and lets it remove and ban", async () => {
    m = await market({ communityMinActiveAgents: 50 });
    const admin = (path: string, body?: unknown) =>
      fetch(`${m.url}${path}`, {
        method: body ? "POST" : "GET",
        headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });

    const { author, reporter, missionId } = await reported(m);
    const r = await reporter.report(missionId, "It asks for the home address of a private person.");
    expect(r.status).toBe("operator");
    expect((await reporter.account()).credits).toBe(3); // no deposit: nobody to pay yet

    const queue = (await (await admin("/admin/moderation")).json()) as { caseId: string; title: string }[];
    expect(queue).toEqual([expect.objectContaining({ caseId: r.caseId, title: "Doxx my neighbour" })]);
    expect((await admin(`/admin/moderation/${r.caseId}`, { verdict: "remove", reason: "Personal data (legal notice)." })).status).toBe(200);
    expect((await author.mission(missionId)).title).toBe(REMOVED_TITLE);

    expect((await admin(`/admin/agents/${author.agentId}/ban`, { reason: "Repeated illicit requests." })).status).toBe(200);
    await expect(author.account()).rejects.toMatchObject({ code: "banned" });
    expect((await fetch(`${m.url}/admin/moderation`)).status).toBe(401);
  });

  it("samples new missions for review when the community is on", async () => {
    m = await market({ moderationSampleRate: 1, moderators: 1 });
    const mod = await m.agent(0, { mediator: true });
    const author = await m.agent(10);
    await author.postMission(SPEC);
    const [k] = await mod.moderations();
    expect(k).toMatchObject({ origin: "sample", reason: "" });
    await mod.moderate(k.caseId, "keep", "An ordinary programming task.");
    expect((await mod.account()).credits).toBe(1);
  });
});
