import { describe, expect, it } from "vitest";
import { Troqo, TroqoError } from "../src/engine.js";
import { mockImageProvider } from "../src/providers.js";
import type { CapabilityProvider, TaskDefinition } from "../src/types.js";

const OPTIONS = ["yes", "no"];
const tasks = (real: number, gold: number): TaskDefinition[] => [
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

function setup(opts: { price?: number; real?: number; gold?: number; providers?: CapabilityProvider[] } = {}) {
  const engine = new Troqo(
    { dbPath: ":memory:", maxSpendUsd: 1 },
    opts.providers ?? [mockImageProvider(opts.price ?? 3)],
  );
  engine.loadTasks(tasks(opts.real ?? 10, opts.gold ?? 3));
  return engine;
}

/** Answers control tasks correctly (or not), real tasks with a fixed answer. */
function answersFor(engine: Troqo, agent: string, requestId: string, goldRight = true, realAnswer = "no") {
  return engine.getRequest(agent, requestId).tasks.map((t) => ({
    taskId: t.taskId,
    answer: t.taskId.startsWith("g") ? (goldRight ? "YES" : "no") : realAnswer,
  }));
}

describe("barter loop", () => {
  it("returns price + control tasks, then delivers a PNG once the batch passes", async () => {
    const engine = setup();
    const { request, outcome } = await engine.requestCapability("a1", "image.mock", "a red fox");
    expect(outcome).toBeUndefined();
    expect(request.tasks).toHaveLength(4);
    expect(request.tasks.every((t) => !("gold" in t))).toBe(true);

    const result = await engine.submitTasks("a1", request.requestId, answersFor(engine, "a1", request.requestId));
    expect(result.status).toBe("delivered");
    expect(result.creditsEarned).toBe(3);
    expect(result.creditsBalance).toBe(0);
    expect(Buffer.from(result.result!.data, "base64").subarray(1, 4).toString()).toBe("PNG");
    expect(engine.getRequest("a1", request.requestId).status).toBe("delivered");
  });

  it("rejects the batch and grants nothing when a control answer is wrong", async () => {
    const engine = setup();
    const { request } = await engine.requestCapability("a1", "image.mock", "x");
    const out = await engine.submitTasks("a1", request.requestId, answersFor(engine, "a1", request.requestId, false));
    expect(out.status).toBe("rejected");
    expect(out.creditsBalance).toBe(0);
    expect(engine.account("a1")).toMatchObject({ batchesFailed: 1, reputation: 0.8 });
    expect(engine.resolvedTasks()).toHaveLength(0);
  });

  it("refuses answers outside the options without closing the request", async () => {
    const engine = setup();
    const { request } = await engine.requestCapability("a1", "image.mock", "x");
    const bad = answersFor(engine, "a1", request.requestId).map((a, i) => (i === 0 ? { ...a, answer: "maybe" } : a));
    await expect(engine.submitTasks("a1", request.requestId, bad)).rejects.toMatchObject({ code: "invalid_answer" });
    await expect(engine.submitTasks("a1", request.requestId, bad.slice(1))).rejects.toMatchObject({
      code: "missing_answer",
    });
    expect(engine.getRequest("a1", request.requestId).status).toBe("awaiting_work");
  });

  it("keeps requests private to their agent and refuses double submission", async () => {
    const engine = setup();
    const { request } = await engine.requestCapability("a1", "image.mock", "x");
    expect(() => engine.getRequest("a2", request.requestId)).toThrow(TroqoError);
    await engine.submitTasks("a1", request.requestId, answersFor(engine, "a1", request.requestId));
    await expect(
      engine.submitTasks("a1", request.requestId, answersFor(engine, "a1", request.requestId)),
    ).rejects.toMatchObject({ code: "request_closed" });
  });

  it("limits open requests per agent", async () => {
    const engine = setup({ real: 30 });
    for (let i = 0; i < 3; i++) await engine.requestCapability("a1", "image.mock", `p${i}`);
    await expect(engine.requestCapability("a1", "image.mock", "p4")).rejects.toMatchObject({
      code: "too_many_open_requests",
    });
  });

  it("never gives the same real task twice to one agent and reports exhaustion", async () => {
    const engine = setup({ real: 3 });
    const { request } = await engine.requestCapability("a1", "image.mock", "x");
    await engine.submitTasks("a1", request.requestId, answersFor(engine, "a1", request.requestId));
    await expect(engine.requestCapability("a1", "image.mock", "y")).rejects.toMatchObject({
      code: "task_pool_exhausted",
    });
  });
});

describe("credits and providers", () => {
  it("delivers immediately when the agent already holds enough credits", async () => {
    const engine = setup({ price: 2 });
    engine.db.prepare("INSERT INTO ledger (agent_id, credits) VALUES ('rich', 5)").run();
    const { outcome } = await engine.requestCapability("rich", "image.mock", "x");
    expect(outcome?.status).toBe("delivered");
    expect(engine.balance("rich")).toBe(3);
  });

  it("keeps earned credits when the spending cap would be exceeded", async () => {
    const pricey: CapabilityProvider = { ...mockImageProvider(3), estimatedCostUsd: 2 };
    const engine = setup({ providers: [pricey] });
    const { request } = await engine.requestCapability("a1", "image.mock", "x");
    const out = await engine.submitTasks("a1", request.requestId, answersFor(engine, "a1", request.requestId));
    expect(out.status).toBe("failed");
    expect(out.error).toMatch(/Spending cap/);
    expect(engine.balance("a1")).toBe(3);
  });

  it("refunds credits when the provider fails", async () => {
    const broken: CapabilityProvider = {
      ...mockImageProvider(3),
      execute: async () => {
        throw new Error("boom");
      },
    };
    const engine = setup({ providers: [broken] });
    const { request } = await engine.requestCapability("a1", "image.mock", "x");
    const out = await engine.submitTasks("a1", request.requestId, answersFor(engine, "a1", request.requestId));
    expect(out).toMatchObject({ status: "failed", creditsBalance: 3 });
    expect(out.error).toMatch(/boom/);
  });

  it("validates task definitions and capability ids", async () => {
    const engine = setup();
    expect(() =>
      engine.loadTasks([{ id: "x", kind: "classify", instruction: "", input: "", options: ["a", "b"], gold: "c" }]),
    ).toThrow(/Gold answer/);
    await expect(engine.requestCapability("a1", "nope", "x")).rejects.toMatchObject({ code: "unknown_capability" });
    await expect(engine.requestCapability("a1", "image.mock", "  ")).rejects.toMatchObject({ code: "invalid_prompt" });
  });
});

describe("work product", () => {
  it("resolves a task once enough agents agree, and reports metrics", async () => {
    const engine = setup({ price: 2, real: 2, gold: 2 });
    for (const agent of ["a1", "a2"]) {
      const { request } = await engine.requestCapability(agent, "image.mock", "x");
      await engine.submitTasks(agent, request.requestId, answersFor(engine, agent, request.requestId));
    }
    const resolved = engine.resolvedTasks();
    expect(resolved.map((r) => r.taskId).sort()).toEqual(["r0", "r1"]);
    expect(resolved[0]).toMatchObject({ answer: "no", votes: 2, totalAnswers: 2 });

    const stats = engine.stats();
    expect(stats.requests).toEqual({ delivered: 2 });
    expect(stats.qualityPassRate).toBe(1);
    expect(stats.avgApproxTokensPerBatch).toBeGreaterThan(0);
    expect(stats.resolvedTasks).toBe(2);
  });

  it("stops handing out a task once it is resolved", async () => {
    const engine = setup({ price: 1, real: 1, gold: 1 });
    for (const agent of ["a1", "a2"]) {
      const { request } = await engine.requestCapability(agent, "image.mock", "x");
      await engine.submitTasks(agent, request.requestId, answersFor(engine, agent, request.requestId));
    }
    await expect(engine.requestCapability("a3", "image.mock", "x")).rejects.toMatchObject({
      code: "task_pool_exhausted",
    });
  });
});

describe("hardening", () => {
  it("keeps defaults for config keys passed as undefined (unset env vars)", () => {
    const engine = new Troqo({ dbPath: ":memory:", maxSpendUsd: undefined, goldPerBatch: undefined });
    expect(engine.config).toMatchObject({ maxSpendUsd: 5, goldPerBatch: 1, requestTtlMinutes: 60 });
  });

  it("grades a batch only once when it is submitted twice concurrently", async () => {
    let release!: () => void;
    let calls = 0;
    const slow: CapabilityProvider = {
      ...mockImageProvider(3),
      execute: async (prompt) => {
        calls++;
        await new Promise<void>((r) => (release = r));
        return mockImageProvider(3).execute(prompt);
      },
    };
    const engine = setup({ providers: [slow] });
    const { request } = await engine.requestCapability("a1", "image.mock", "x");
    const answers = answersFor(engine, "a1", request.requestId);
    const first = engine.submitTasks("a1", request.requestId, answers);
    expect(engine.getRequest("a1", request.requestId).status).toBe("processing");
    await expect(engine.submitTasks("a1", request.requestId, answers)).rejects.toMatchObject({
      code: "request_closed",
    });
    release();
    expect((await first).status).toBe("delivered");
    expect(calls).toBe(1);
    expect(engine.account("a1")).toMatchObject({ credits: 0, batchesPassed: 1 });
  });

  it("expires abandoned requests, which frees their slot", async () => {
    const engine = setup({ real: 30, gold: 5 });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await engine.requestCapability("a1", "image.mock", `p${i}`)).request.requestId);
    engine.db.prepare("UPDATE requests SET created_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", ids[0]);
    await engine.requestCapability("a1", "image.mock", "p3");
    expect(engine.getRequest("a1", ids[0]).status).toBe("expired");
    await expect(engine.submitTasks("a1", ids[0], [])).rejects.toMatchObject({ code: "request_closed" });
  });

  it("lets an agent cancel a request awaiting work, once", async () => {
    const engine = setup({ real: 30, gold: 5 });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await engine.requestCapability("a1", "image.mock", `p${i}`)).request.requestId);
    expect(engine.cancelRequest("a1", ids[1]).status).toBe("cancelled");
    expect(() => engine.cancelRequest("a1", ids[1])).toThrow(/already cancelled/);
    expect(() => engine.cancelRequest("a2", ids[2])).toThrow(TroqoError);
    await engine.requestCapability("a1", "image.mock", "p3");
  });

  it("refunds a request left in processing by a crash", async () => {
    const engine = setup({ price: 2 });
    engine.db.prepare("INSERT INTO ledger (agent_id, credits) VALUES ('a1', 0)").run();
    engine.db
      .prepare(
        `INSERT INTO requests (id, agent_id, capability, prompt, status, price_credits, created_at)
         VALUES ('stuck', 'a1', 'image.mock', 'x', 'processing', 2, '2000-01-01T00:00:00.000Z')`,
      )
      .run();
    expect(engine.getRequest("a1", "stuck")).toMatchObject({ status: "failed", error: expect.stringMatching(/refunded/) });
    expect(engine.balance("a1")).toBe(2);
  });

  it("keeps handing out a tied task, then withdraws it as contested", async () => {
    const engine = setup({ price: 1, real: 1, gold: 1 });
    const agents = ["a1", "a2", "a3", "a4"];
    const reqs = [];
    for (const a of agents) reqs.push((await engine.requestCapability(a, "image.mock", "x")).request);
    for (const [i, a] of agents.entries()) {
      await engine.submitTasks(a, reqs[i].requestId, answersFor(engine, a, reqs[i].requestId, true, i < 2 ? "no" : "yes"));
    }
    expect(engine.resolvedTasks()).toHaveLength(0);
    // 2 vs 2: still offered to a new agent.
    const { request } = await engine.requestCapability("a5", "image.mock", "x");
    expect(request.tasks.map((t) => t.taskId)).toContain("r0");
    await engine.submitTasks("a5", request.requestId, answersFor(engine, "a5", request.requestId));
    // 3 vs 2 after 5 answers: no consensus, withdrawn.
    expect(engine.resolvedTasks()).toHaveLength(0);
    expect(engine.stats().contestedTasks).toBe(1);
    await expect(engine.requestCapability("a6", "image.mock", "x")).rejects.toMatchObject({
      code: "task_pool_exhausted",
    });
  });

  it("never shows the same control task twice to an agent", async () => {
    const engine = setup({ price: 1, real: 10, gold: 1 });
    const { request } = await engine.requestCapability("a1", "image.mock", "x");
    await engine.submitTasks("a1", request.requestId, answersFor(engine, "a1", request.requestId));
    await expect(engine.requestCapability("a1", "image.mock", "y")).rejects.toMatchObject({
      code: "task_pool_exhausted",
    });
  });

  it("uses unanimously resolved tasks as controls for agents who never saw them", async () => {
    const engine = new Troqo({ dbPath: ":memory:", minAgreement: 3 }, [mockImageProvider(1)]);
    engine.loadTasks(tasks(1, 1));
    for (const a of ["a1", "a2", "a3"]) {
      const { request } = await engine.requestCapability(a, "image.mock", "x");
      await engine.submitTasks(a, request.requestId, answersFor(engine, a, request.requestId));
    }
    expect(engine.resolvedTasks()).toMatchObject([{ taskId: "r0", answer: "no", votes: 3 }]);

    // a4 uses the explicit control first, then r0 serves as its control.
    engine.loadTasks([
      { id: "n1", kind: "classify", instruction: "?", input: "a", options: OPTIONS },
      { id: "n2", kind: "classify", instruction: "?", input: "b", options: OPTIONS },
    ]);
    const first = (await engine.requestCapability("a4", "image.mock", "x")).request;
    expect(first.tasks.map((t) => t.taskId)).toContain("g0");
    await engine.submitTasks("a4", first.requestId, answersFor(engine, "a4", first.requestId));
    const second = (await engine.requestCapability("a4", "image.mock", "y")).request;
    expect(second.tasks.map((t) => t.taskId)).toContain("r0");
    const wrong = second.tasks.map((t) => ({ taskId: t.taskId, answer: t.taskId === "r0" ? "yes" : "no" }));
    const out = await engine.submitTasks("a4", second.requestId, wrong);
    expect(out).toMatchObject({ status: "rejected", goldTotal: 1, goldCorrect: 0 });
  });
});
