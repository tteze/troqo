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
