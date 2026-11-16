import { describe, expect, it } from "vitest";
import { Troqo, WORK_CAPABILITY } from "../src/engine.js";
import { agentIdFromKey, generateAgentKey } from "../src/http.js";
import { mockImageProvider } from "../src/providers.js";
import type { TaskDefinition } from "../src/types.js";

const OPTIONS = ["yes", "no"];
const bank = (real: number, gold: number): TaskDefinition[] => [
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

const MISSION = {
  kind: "code",
  title: "Write a slugify function",
  spec: "TypeScript function slugify(s: string): string, lowercase, dashes between words.",
  acceptance: "slugify('Hello World') === 'hello-world'",
  priceCredits: 6,
};

/** Engine where `agents` hold credits and `mediators` are eligible to mediate. */
function setup(credits: Record<string, number> = { req: 10 }, mediators = ["m1", "m2", "m3", "m4"]) {
  const t = new Troqo({ dbPath: ":memory:" }, [mockImageProvider(3)]);
  t.loadTasks(bank(20, 5));
  for (const [a, c] of Object.entries(credits)) {
    t.db.prepare("INSERT INTO ledger (agent_id, credits) VALUES (?, ?)").run(a, c);
  }
  for (const m of mediators) {
    t.db.prepare("INSERT INTO ledger (agent_id, credits, batches_passed) VALUES (?, 0, 5)").run(m);
  }
  return t;
}

function delivered(t: Troqo) {
  const { missionId } = t.market.postMission("req", MISSION);
  t.market.takeMission("sol", missionId);
  t.market.deliverMission("sol", missionId, "export const slugify = (s: string) => s.toLowerCase().split(' ').join('-');");
  return missionId;
}

const assigned = (t: Troqo, missionId: string, round: number) =>
  (
    t.db
      .prepare("SELECT mediator_id FROM mediations WHERE mission_id = ? AND round = ? AND verdict IS NULL")
      .all(missionId, round) as { mediator_id: string }[]
  ).map((r) => r.mediator_id);

const backdate = (t: Troqo, sql: string, id: string) => t.db.prepare(sql).run("2000-01-01T00:00:00.000Z", id);

describe("mission market", () => {
  it("locks the price in escrow and pays the solver once the requester accepts", () => {
    const t = setup();
    const posted = t.market.postMission("req", MISSION);
    expect(t.balance("req")).toBe(4);
    expect(t.market.listMissions("req")).toHaveLength(0);
    expect(t.market.listMissions("sol")[0]).toMatchObject({ missionId: posted.missionId, priceCredits: 6 });

    t.market.takeMission("sol", posted.missionId);
    expect(t.market.listMissions("other")).toHaveLength(0);
    t.market.deliverMission("sol", posted.missionId, "done");
    expect(t.market.getMission("req", posted.missionId)).toMatchObject({ status: "delivered", delivery: "done" });

    const closed = t.market.reviewDelivery("req", posted.missionId, "accept");
    expect(closed.status).toBe("accepted");
    expect(closed.delivery).toBeUndefined(); // Troqo keeps no work content
    expect(t.balance("sol")).toBe(6);
    expect(t.balance("req")).toBe(4);
  });

  it("requires credits earned beforehand", () => {
    const t = setup({ poor: 2 });
    expect(() => t.market.postMission("poor", MISSION)).toThrow(/costs 6 credits and your balance is 2/);
  });

  it("lets only one agent take a mission, never its requester", () => {
    const t = setup();
    const { missionId } = t.market.postMission("req", MISSION);
    expect(() => t.market.takeMission("req", missionId)).toThrow(/own mission/);
    t.market.takeMission("a", missionId);
    expect(() => t.market.takeMission("b", missionId)).toThrow(/taken by someone else/);
    expect(() => t.market.deliverMission("b", missionId, "x")).toThrow(/do not hold/);
  });

  it("refunds a cancelled mission and reopens one that was not delivered in time", () => {
    const t = setup({ req: 20 });
    const a = t.market.postMission("req", MISSION);
    t.market.cancelMission("req", a.missionId);
    expect(t.balance("req")).toBe(20);

    const b = t.market.postMission("req", MISSION);
    t.market.takeMission("sol", b.missionId);
    backdate(t, "UPDATE missions SET taken_at = ? WHERE id = ?", b.missionId);
    expect(t.market.listMissions("other")).toHaveLength(1);
    expect(() => t.market.deliverMission("sol", b.missionId, "late")).toThrow(/do not hold/);
  });

  it("accepts a delivery the requester never reviews", () => {
    const t = setup();
    const id = delivered(t);
    backdate(t, "UPDATE missions SET delivered_at = ? WHERE id = ?", id);
    expect(t.market.myMissions("sol")[0]).toMatchObject({ missionId: id, status: "accepted" });
    expect(t.balance("sol")).toBe(6);
  });

  it("settles a contest with one random mediator, never a party", () => {
    const t = setup({ req: 10 }, ["m1"]);
    const id = delivered(t);
    expect(() => t.market.reviewDelivery("req", id, "contest", "short")).toThrow(/Explain/);
    t.market.reviewDelivery("req", id, "contest", "It does not handle multiple spaces.");
    expect(assigned(t, id, 1)).toEqual(["m1"]);
    expect(t.market.listMediations("m1")[0]).toMatchObject({ missionId: id, round: 1 });

    t.market.mediate("m1", id, "accept", "The criterion given is met exactly.");
    expect(t.market.getMission("sol", id)).toMatchObject({ status: "mediated", verdict: "accept" });
    expect(() => t.market.respondToVerdict("sol", id, "appeal")).toThrow(/lost the mediation/);

    t.market.respondToVerdict("req", id, "accept");
    expect(t.balance("sol")).toBe(6);
    expect(t.balance("m1")).toBe(1);
    expect(t.balance("req")).toBe(3); // 10 - 6 escrow - 1 mediation fee
  });

  it("on appeal, three new mediators decide by majority; the minority is not paid", () => {
    const t = setup();
    const id = delivered(t);
    t.market.reviewDelivery("req", id, "contest", "It does not handle multiple spaces.");
    const [first] = assigned(t, id, 1);
    t.market.mediate(first, id, "refuse", "Multiple spaces are not handled.");
    t.market.respondToVerdict("sol", id, "appeal");

    const panel = assigned(t, id, 2);
    expect(panel).toHaveLength(3);
    expect(panel).not.toContain(first);
    t.market.mediate(panel[0], id, "accept", "The only stated criterion is met.");
    t.market.mediate(panel[1], id, "refuse", "Spaces should collapse into one dash.");
    expect(t.market.getMission("req", id).status).toBe("appealed");
    t.market.mediate(panel[2], id, "accept", "The acceptance test passes as written.");

    expect(t.market.getMission("req", id).status).toBe("accepted");
    expect(t.balance("sol")).toBe(6);
    expect(t.balance(panel[0])).toBe(1);
    expect(t.balance(panel[2])).toBe(1);
    expect(t.balance(panel[1])).toBe(0);
    expect(t.balance(first)).toBe(0);
    expect(t.balance("req")).toBe(2); // 10 - 6 - 2 fees
  });

  it("lets a losing party go into debt, which blocks new missions until worked off", () => {
    const t = setup({ req: 6 }, ["m1"]);
    const id = delivered(t);
    t.market.reviewDelivery("req", id, "contest", "It does not handle multiple spaces.");
    t.market.mediate("m1", id, "accept", "The criterion given is met exactly.");
    t.market.respondToVerdict("req", id, "accept");
    expect(t.balance("req")).toBe(-1);
    expect(() => t.market.postMission("req", { ...MISSION, priceCredits: 1 })).toThrow(/insufficient|balance is -1/);
  });

  it("replaces a mediator who does not vote in time", () => {
    const t = setup({ req: 10 }, ["m1", "m2"]);
    const id = delivered(t);
    t.market.reviewDelivery("req", id, "contest", "It does not handle multiple spaces.");
    const [first] = assigned(t, id, 1);
    backdate(t, "UPDATE mediations SET assigned_at = ? WHERE mission_id = ?", id);
    expect(t.market.listMediations(first)).toHaveLength(0);
    expect(assigned(t, id, 1)).toEqual([first === "m1" ? "m2" : "m1"]);
  });

  it("reports market rates set by requesters", () => {
    const t = setup({ req: 30 });
    t.market.postMission("req", MISSION);
    t.market.postMission("req", { ...MISSION, priceCredits: 10 });
    expect(t.market.rates()).toEqual([
      expect.objectContaining({ kind: "code", open: 2, minOpenPrice: 6, maxOpenPrice: 10 }),
    ]);
  });
});

describe("earning credits", () => {
  it("creates credits only through checked micro-tasks", async () => {
    const t = setup({}, []);
    const batch = t.requestWork("w");
    expect(batch.capability).toBe(WORK_CAPABILITY);
    const answers = batch.tasks.map((x) => ({ taskId: x.taskId, answer: x.taskId.startsWith("g") ? "yes" : "no" }));
    const out = await t.submitTasks("w", batch.requestId, answers);
    expect(out).toMatchObject({ status: "delivered", creditsEarned: 4, creditsBalance: 4 });
    expect(out.result).toBeUndefined();
  });
});

describe("identity without accounts", () => {
  it("derives a stable public id from a self-generated secret key", () => {
    const key = generateAgentKey();
    expect(key).toMatch(/^tq_[A-Za-z0-9_-]{43}$/);
    expect(agentIdFromKey(key)).toBe(agentIdFromKey(key));
    expect(agentIdFromKey(key)).not.toContain(key.slice(3, 20));
    expect(agentIdFromKey(generateAgentKey())).not.toBe(agentIdFromKey(key));
  });
});
