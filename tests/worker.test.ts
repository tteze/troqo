import { afterEach, describe, expect, it } from "vitest";
import { createConnection } from "node:net";
import type { Server } from "node:http";
import { Worker, type WorkerEvent } from "../src/client/worker.js";
import { dockerArgs, sandboxSetupCommands } from "../src/client/sandbox.js";
import { isAllowed, startEgressProxy } from "../src/client/egress-proxy.js";
import { parseVerdict } from "../src/client/prompts.js";
import { market, SPEC, type TestMarket } from "./helpers.js";

/** A stand-in for `claude -p`: reads the prompt on stdin, answers deterministically. */
const FAKE_SOLVER = [
  "node",
  "-e",
  `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
     if (s.includes("You are a mediator")) console.log("ACCEPT\\nThe delivery meets the acceptance criteria.");
     else console.log("export const slugify = (s: string) => s.trim().toLowerCase().split(/\\\\s+/).join('-');");
   });`,
];

let m: TestMarket;
afterEach(() => m?.close());

describe("worker", () => {
  it("takes a mission, waits for the spec, solves it with the solver command and delivers", async () => {
    m = await market();
    const req = await m.agent(20);
    const events: WorkerEvent[] = [];
    const worker = new Worker(await m.agent(2), { kinds: ["code"], solver: { command: FAKE_SOLVER, sandbox: "none" } }, (e) =>
      events.push(e),
    );
    const posted = await req.postMission(SPEC);
    await worker.tick(); // takes
    expect(events).toContainEqual(expect.objectContaining({ type: "took", missionId: posted.missionId }));
    await req.sync(); // the requester's client hands the spec over
    await worker.tick(); // receives the spec, solves, delivers
    expect(events).toContainEqual({ type: "delivered", missionId: posted.missionId });
    await req.sync();
    const view = await req.mission(posted.missionId);
    expect(view.local.delivery?.content).toContain("split(/\\s+/)");
    expect(view.local.deliveryTampered).toBe(false);
  });

  it("respects kinds and minimum prices", async () => {
    m = await market();
    const req = await m.agent(20);
    await req.postMission({ ...SPEC, priceCredits: 2 });
    const events: WorkerEvent[] = [];
    const w = new Worker(await m.agent(), { kinds: ["code"], minPrice: { code: 5 }, solver: { command: FAKE_SOLVER, sandbox: "none" } }, (e) =>
      events.push(e),
    );
    await w.tick();
    expect(events.filter((e) => e.type === "took")).toHaveLength(0);
  });

  it("settles a dispute it was drawn for", async () => {
    m = await market();
    const mediator = await m.agent(0, { mediator: true });
    const req = await m.agent(20);
    const sol = await m.agent(2);
    const posted = await req.postMission(SPEC);
    await sol.takeMission(posted.missionId);
    await req.sync();
    await sol.sync();
    await sol.deliver(posted.missionId, { mime: "text/plain", content: "slugify = s => s.toLowerCase().replace(/ /g, '-')" });
    await req.review(posted.missionId, "contest", "It does not handle tabs at all.");
    await req.sync();
    await sol.sync();
    const events: WorkerEvent[] = [];
    await new Worker(mediator, { kinds: [], mediate: true, solver: { command: FAKE_SOLVER, sandbox: "none" } }, (e) => events.push(e)).tick();
    expect(events).toContainEqual({ type: "mediated", missionId: posted.missionId, verdict: "accept" });
    expect((await req.mission(posted.missionId)).verdict).toBe("accept");
  });

  it("serves image missions as a market maker, without an LLM", async () => {
    m = await market();
    const req = await m.agent(20);
    const maker = new Worker(await m.agent(), { kinds: [], capabilities: { image: { provider: "mock" } } });
    const posted = await req.postMission({
      kind: "image",
      title: "A lighthouse at dusk",
      summary: "One square image of a lighthouse at dusk.",
      spec: "A lighthouse at dusk, warm light, calm sea.",
      acceptance: "A square image showing a lighthouse.",
      priceCredits: 4,
    });
    await maker.tick();
    await req.sync();
    await maker.tick();
    await req.sync();
    const d = (await req.mission(posted.missionId)).local.delivery!;
    expect(d.mime).toBe("image/png");
    expect(Buffer.from(d.content, "base64").subarray(1, 4).toString()).toBe("PNG");
  });
});

describe("sandbox", () => {
  it("runs the solver in a locked-down container on an internal network", () => {
    const args = dockerArgs(["claude", "-p"], { mounts: ["/home/me/.claude:/home/solver/.claude"], env: ["ANTHROPIC_API_KEY"] });
    const joined = args.join(" ");
    for (const part of [
      "--network troqo-sandbox",
      "--read-only",
      "--cap-drop ALL",
      "--security-opt no-new-privileges",
      "--pids-limit 256",
      "--user 1000:1000",
      "HTTPS_PROXY=http://troqo-egress:3128",
      "-v /home/me/.claude:/home/solver/.claude:ro",
      "-e ANTHROPIC_API_KEY",
    ]) {
      expect(joined).toContain(part);
    }
    expect(args.slice(-3)).toEqual(["troqo-solver", "claude", "-p"]);
    expect(() => dockerArgs(["x"], { env: ["BAD;NAME"] })).toThrow();
    const setup = sandboxSetupCommands(["api.anthropic.com"]);
    expect(setup[0]).toEqual(["docker", "network", "create", "--internal", "troqo-sandbox"]);
    expect(setup[1].join(" ")).toContain("egress-proxy --port 3128 --allow api.anthropic.com");
  });

  it("lets the egress proxy reach allowed HTTPS hosts only", async () => {
    expect(isAllowed("api.anthropic.com:443", ["api.anthropic.com"])).toBe(true);
    expect(isAllowed("api.anthropic.com:80", ["api.anthropic.com"])).toBe(false);
    expect(isAllowed("evil.com:443", ["api.anthropic.com"])).toBe(false);
    expect(isAllowed("x.openai.com:443", ["*.openai.com"])).toBe(true);
    expect(isAllowed("openai.com.evil.io:443", ["*.openai.com"])).toBe(false);
    expect(isAllowed("192.168.1.10:443", ["api.anthropic.com"])).toBe(false);

    const proxy: Server = await startEgressProxy(0, ["api.anthropic.com"], "127.0.0.1");
    const port = (proxy.address() as { port: number }).port;
    const reply = await new Promise<string>((resolve) => {
      const s = createConnection(port, "127.0.0.1", () => s.write("CONNECT 192.168.1.1:443 HTTP/1.1\r\nHost: x\r\n\r\n"));
      let data = "";
      s.on("data", (d) => (data += d)).on("close", () => resolve(data)).on("end", () => resolve(data));
    });
    expect(reply).toMatch(/403/);
    await new Promise<void>((r) => proxy.close(() => r()));
  });

  it("parses mediation answers", () => {
    expect(parseVerdict("ACCEPT\nMeets the criteria.")).toEqual({ verdict: "accept", justification: "Meets the criteria." });
    expect(parseVerdict("refuse: wrong language entirely")?.verdict).toBe("refuse");
    expect(parseVerdict("I think it is fine")).toBeUndefined();
  });
});
