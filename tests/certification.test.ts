import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TroqoClient } from "../src/client/client.js";
import { extractJson, GENERATORS, sameJson } from "../src/server/certification/generators.js";
import { DEFAULT_POLICY, loadPolicy, validatePolicy, type CertificationPolicy } from "../src/server/certification/policy.js";
import { market, SPEC, type TestMarket } from "./helpers.js";

let m: TestMarket;
afterEach(() => m?.close());

const policy = (patch: Partial<CertificationPolicy> = {}): CertificationPolicy => ({
  ...DEFAULT_POLICY,
  ...patch,
  controls: { ...DEFAULT_POLICY.controls, ...patch.controls },
  conformity: { ...DEFAULT_POLICY.conformity, ...patch.conformity },
});

/** The answer the server expects for a control mission (read from its database, as only a test can). */
const expected = (t: TestMarket, missionId: string) =>
  JSON.parse((t.troqo.ctx.db.prepare(`SELECT expected FROM controls WHERE mission_id = ?`).get(missionId) as { expected: string }).expected);

async function answerExam(t: TestMarket, a: TroqoClient, kind: string, right: boolean) {
  const exam = await a.takeExam(kind);
  await a.sync(); // receives the generated spec, encrypted like any other
  const local = (await a.mission(exam.missionId)).local;
  expect(local.spec?.spec.length).toBeGreaterThan(20);
  expect(local.specTampered).toBe(false);
  const content = right ? JSON.stringify(expected(t, exam.missionId)) : "[]";
  await a.deliver(exam.missionId, { mime: "text/plain", content });
  return (await a.mission(exam.missionId)).status;
}

async function certify(t: TestMarket, a: TroqoClient, kind = "data") {
  for (let i = 0; i < 3; i++) expect(await answerExam(t, a, kind, true)).toBe("accepted");
}

describe("control generators", () => {
  it("draw a fresh task each time, accept their own answer and reject a wrong one", () => {
    for (const g of GENERATORS.filter((x) => x.mode === "graded")) {
      for (const d of g.difficulties) {
        const a = g.generate(d);
        const b = g.generate(d);
        expect(a.spec).not.toBe(b.spec);
        expect(g.grade!(a.expected, "Here you go:\n```json\n" + JSON.stringify(a.expected) + "\n```")).toBe(true);
        expect(g.grade!(a.expected, JSON.stringify({ wrong: true }))).toBe(false);
      }
    }
    expect(extractJson('Sure! {"a": [1, 2]} done')).toEqual({ a: [1, 2] });
    expect(sameJson({ b: 1.001, a: "x" }, { a: "x ", b: 1 })).toBe(true);
  });
});

describe("exams", () => {
  it("grants a level after three passed tasks in a row; a failure restarts the count", async () => {
    m = await market();
    const a = await m.agent();
    expect(await answerExam(m, a, "data", true)).toBe("accepted");
    expect(await answerExam(m, a, "data", false)).toBe("refused");
    await certify(m, a);
    const profile = await a.profile();
    expect(profile.certifications).toEqual([
      expect.objectContaining({ kind: "data", level: 1, name: "certified", policyVersion: DEFAULT_POLICY.version }),
    ]);
    expect((await a.account()).credits).toBe(0); // exams pay nothing
    await expect(a.takeExam("data")).rejects.toMatchObject({ code: "needs_track_record" }); // level 2 needs controls first
    await expect(a.takeExam("poetry")).rejects.toMatchObject({ code: "not_certifiable" });
  });

  it("lets requesters reserve a mission for certified solvers", async () => {
    m = await market();
    const req = await m.agent(20);
    const posted = await req.postMission({ ...SPEC, kind: "data", minLevel: 1 });
    expect(posted.minLevel).toBe(1);
    const plain = await m.agent(5);
    await expect(plain.takeMission(posted.missionId)).rejects.toMatchObject({ code: "certification_required" });
    const certified = await m.agent(5);
    await certify(m, certified);
    await certified.takeMission(posted.missionId);
    await expect(req.postMission({ ...SPEC, minLevel: 1, kind: "poetry" })).rejects.toMatchObject({ code: "invalid_mission" });
  });
});

describe("hidden controls", () => {
  async function controlFor(t: TestMarket, a: TroqoClient, others: TroqoClient[]) {
    const req = await t.agent(20);
    const real = await req.postMission({ ...SPEC, kind: "data", priceCredits: 4 });
    await a.takeMission(real.missionId); // taking a real mission may queue a control (rate 1 here)
    const mine = (await a.listMissions()).filter((x) => x.missionId !== real.missionId);
    expect(mine).toHaveLength(1);
    const control = mine[0];
    expect(control.requesterId).toMatch(/^ag_/); // a one-off identity, like any newcomer
    for (const o of others) expect((await o.listMissions()).map((x) => x.missionId)).not.toContain(control.missionId);
    const pub = (await (await fetch(`${t.url}/v1/missions/open`)).json()) as { missionId: string }[];
    expect(pub.map((x) => x.missionId)).not.toContain(control.missionId);
    await a.takeMission(control.missionId);
    await a.sync();
    return control;
  }

  it("pays a passed control and extends the certification", async () => {
    m = await market({}, policy({ controls: { ...DEFAULT_POLICY.controls, initialRate: 1 } }));
    const a = await m.agent(10);
    await certify(m, a);
    const other = await m.agent();
    const control = await controlFor(m, a, [other]);
    const before = (await a.account()).credits;
    await a.deliver(control.missionId, { mime: "text/plain", content: JSON.stringify(expected(m, control.missionId)) });
    expect((await a.mission(control.missionId)).status).toBe("accepted");
    expect((await a.account()).credits).toBeGreaterThan(before);
    expect((await a.profile()).certifications[0]).toMatchObject({ level: 1, controlsPassed: 1, controlsFailed: 0 });
    expect(m.troqo.market.stats().missions.accepted ?? 0).toBe(0); // controls stay out of market statistics
  });

  it("contests a failed control like a real requester, checks the mediator and drops the level", async () => {
    m = await market({}, policy({ controls: { ...DEFAULT_POLICY.controls, initialRate: 1 } }));
    const mediator = await m.agent(0, { mediator: true });
    const a = await m.agent(10);
    await certify(m, a);
    const control = await controlFor(m, a, [mediator]);
    await a.deliver(control.missionId, { mime: "text/plain", content: "I do not know." });
    expect((await a.mission(control.missionId)).status).toBe("disputed");
    await a.sync(); // the solver's client sends its delivery to the mediator
    await mediator.sync(); // receives both pieces; the spec comes from the one-off requester
    const [d] = await mediator.mediations();
    expect(d.ready).toBe(true);
    expect(d.evidence?.specTampered).toBe(false);
    await mediator.mediate(control.missionId, "refuse", "The answer gives no data at all.");
    expect((await a.mission(control.missionId)).status).toBe("refused");
    expect((await mediator.account()).credits).toBe(1);
    expect((await a.profile()).certifications[0]).toMatchObject({ level: 0, controlsFailed: 1 });
  });
});

describe("model conformity", () => {
  it("gives the same task to agents declaring the same model and lets peers rank the answers blind", async () => {
    const p = policy({
      controls: { ...DEFAULT_POLICY.controls, initialRate: 1 },
      conformity: { ...DEFAULT_POLICY.conformity, share: 1, groupSize: 3, rankers: 2, sameModelRankers: 1, minGroups: 1 },
    });
    m = await market({}, p);
    const rankers = [await m.agent(0, { mediator: true }), await m.agent(0, { mediator: true })];
    await rankers[0].declareModel("model-x");
    const solvers = [await m.agent(5), await m.agent(5), await m.agent(5)];
    const req = await m.agent(50);
    const answers = ["A careful, correct explanation with an example.", "Another good explanation, with an example.", "idk"];
    for (const [i, s] of solvers.entries()) {
      await s.declareModel("Model-X");
      const real = await req.postMission({ ...SPEC, kind: "text", priceCredits: 4 });
      await s.takeMission(real.missionId);
      const control = (await s.listMissions()).find((x) => x.missionId !== real.missionId)!;
      await s.takeMission(control.missionId);
      await s.sync();
      expect((await s.mission(control.missionId)).local.spec?.spec).toMatch(/Explain/);
      await s.deliver(control.missionId, { mime: "text/plain", content: answers[i] });
      expect((await s.mission(control.missionId)).status).toBe("accepted"); // open-ended: paid on delivery
    }
    const specs = m.troqo.ctx.db.prepare(`SELECT DISTINCT spec FROM controls WHERE purpose = 'conformity'`).all();
    expect(specs).toHaveLength(1); // one task for the whole group

    for (const r of rankers) {
      await r.sync();
      const [g] = await r.rankings();
      expect(g.bundle?.answers).toHaveLength(3);
      const order = [...g.bundle!.answers].sort((x, y) => (x.content === "idk" ? 1 : 0) - (y.content === "idk" ? 1 : 0)).map((x) => x.label);
      await r.rank(g.groupId, order, "Correct explanations first, the empty answer last.");
    }
    const weak = await solvers[2].profile();
    expect(weak.declaredModel).toBe("model-x");
    expect(weak.conformity).toEqual({ groups: 1, averageScore: 0, status: "below_peers" });
    expect((await solvers[0].profile()).conformity?.status).toBe("consistent");
    expect((await rankers[0].account()).credits).toBe(1);
    expect(m.troqo.ctx.db.prepare(`SELECT COUNT(*) AS n FROM controls WHERE delivery IS NOT NULL`).get()).toEqual({ n: 0 });
  });
});

describe("certification policy", () => {
  it("is public, loaded from a file and checked", async () => {
    m = await market();
    const pub = (await (await fetch(`${m.url}/v1/certification/policy`)).json()) as CertificationPolicy;
    expect(pub.version).toBe(DEFAULT_POLICY.version);

    const file = join(mkdtempSync(join(tmpdir(), "troqo-policy-")), "policy.json");
    writeFileSync(file, JSON.stringify({ version: "community-1", onControlFail: "revoke", controls: { initialRate: 0.2 } }));
    const loaded = loadPolicy(file);
    expect(loaded).toMatchObject({ version: "community-1", onControlFail: "revoke", levels: DEFAULT_POLICY.levels });
    expect(loaded.controls).toMatchObject({ initialRate: 0.2, establishedRate: DEFAULT_POLICY.controls.establishedRate });
    expect(() => validatePolicy(policy({ levels: [{ ...DEFAULT_POLICY.levels[1] }] }))).toThrow(/numbered/);
  });
});
