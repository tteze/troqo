import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIdentity, signBoxKey, signRequest } from "../src/shared/crypto.js";
import { generateReleaseKey, signRelease, verifyRelease } from "../src/shared/release.js";
import { networkKey, startHttp } from "../src/server/http.js";
import { Api } from "../src/client/api.js";
import { API_RELAYS, startEgressProxy, type ApiRelay } from "../src/client/egress-proxy.js";
import { dockerArgs, sandboxSetupCommands } from "../src/client/sandbox.js";
import { ADMIN_TOKEN, backdate, market, SPEC, type TestMarket } from "./helpers.js";

let m: TestMarket;
const servers: Server[] = [];
afterEach(async () => {
  await m?.close();
  m = undefined as unknown as TestMarket;
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

const tmp = () => mkdtempSync(join(tmpdir(), "troqo-sec-"));

describe("encryption keys are bound to identities", () => {
  it("refuses to encrypt for a key the market swapped, for specs and deliveries", async () => {
    m = await market();
    const req = await m.agent(20);
    const sol = await m.agent(2);
    const posted = await req.postMission(SPEC);
    await sol.takeMission(posted.missionId);
    const real = m.troqo.publicKeys(sol.agentId).boxPublic;
    // A malicious market hands out its own encryption key for the solver...
    m.troqo.ctx.db.prepare(`UPDATE agents SET box_public = ? WHERE agent_id = ?`).run(generateIdentity().boxPublic, sol.agentId);
    const report = await req.sync();
    expect(report.specsSent).toBe(0);
    expect(report.problems.join()).toMatch(/not signed by that agent/);
    // ...the requester's client sends nothing. With the right key back, the handover goes through.
    m.troqo.ctx.db.prepare(`UPDATE agents SET box_public = ? WHERE agent_id = ?`).run(real, sol.agentId);
    expect((await req.sync()).specsSent).toBe(1);
    await sol.sync();
    m.troqo.ctx.db.prepare(`UPDATE agents SET box_public = ? WHERE agent_id = ?`).run(generateIdentity().boxPublic, req.agentId);
    await expect(sol.deliver(posted.missionId, { mime: "text/plain", content: "x" })).rejects.toMatchObject({ code: "key_mismatch" });
  });

  it("rejects a registration whose encryption key is not signed by the identity", async () => {
    m = await market();
    const id = generateIdentity();
    const other = generateIdentity();
    for (const boxSignature of [undefined, signBoxKey(other), signBoxKey({ ...id, boxPublic: other.boxPublic })]) {
      const body = JSON.stringify({ signPublic: id.signPublic, boxPublic: id.boxPublic, boxSignature });
      const res = await fetch(`${m.url}/v1/register`, {
        method: "POST",
        headers: { ...signRequest(id, "POST", "/v1/register", body), "content-type": "application/json" },
        body,
      });
      expect(await res.json()).toMatchObject({ error: "invalid_keys" });
    }
  });
});

describe("relay limits", () => {
  it("accepts each piece of evidence once per mediator, and caps what an agent has waiting", async () => {
    m = await market();
    const mediator = await m.agent(0, { mediator: true });
    const req = await m.agent(20);
    const sol = await m.agent(2);
    const posted = await req.postMission(SPEC);
    await sol.takeMission(posted.missionId);
    await req.sync();
    await sol.sync();
    await sol.deliver(posted.missionId, { mime: "text/plain", content: "x" });
    await req.review(posted.missionId, "contest", "This is not a slugify function.");
    await req.sync(); // sends the spec to the mediator
    const envelope = "A".repeat(100);
    expect(() => m.troqo.market.sendEvidence(req.agentId, posted.missionId, mediator.agentId, envelope)).toThrow(/already sent/);

    m.troqo.ctx.config.maxRelayCharsPerAgent = 50;
    expect(() => m.troqo.market.sendEvidence(sol.agentId, posted.missionId, mediator.agentId, envelope)).toThrow(/relay/);
  });
});

describe("mediators", () => {
  it("need a track record with several requesters and lock a bond they lose on a wrong vote", async () => {
    m = await market({ mediatorBondCredits: 5, mediatorMinRequesters: 2, honeypotRate: 1 });
    const med = await m.agent(5, { mediator: true });
    expect((await med.account()).canMediate).toBe(false); // passed batches alone are not enough
    const t = new Date().toISOString();
    const ins = m.troqo.ctx.db.prepare(
      `INSERT INTO missions (id, requester_id, kind, title, summary, price_credits, spec_hash, status, solver_id, created_at, closed_at)
       VALUES (?, ?, 'text', 't', 's', 4, 'h', 'accepted', ?, ?, ?)`,
    );
    ins.run("h1", "someone", med.agentId, t, t);
    expect((await med.account()).canMediate).toBe(false); // one requester is not several
    ins.run("h2", "someone-else", med.agentId, t, t);
    expect((await med.account()).canMediate).toBe(true);

    await med.sync(); // receives a fake dispute, generated since there is no bank
    expect((await med.account()).credits).toBe(0); // bond locked
    const [d] = await med.mediations();
    expect(d.ready).toBe(true);
    const truth = (m.troqo.ctx.db
      .prepare(`SELECT h.verdict FROM missions x JOIN honeypots h ON h.id = x.honeypot_id WHERE x.id = ?`)
      .get(d.missionId) as { verdict: string }).verdict;
    await med.mediate(d.missionId, truth === "accept" ? "refuse" : "accept", "Voted without reading the pieces.");
    expect((await med.account()).credits).toBe(0); // bond burned, no fee
    expect(m.troqo.market.stats().credits.burned).toBe(5);
  });

  it("generates fake disputes, at most a few per day, and only within the credit budget", async () => {
    m = await market({ honeypotRate: 1, maxHoneypotsPerDay: 1 });
    const med = await m.agent(0, { mediator: true });
    await med.sync();
    const [d] = await med.mediations();
    expect(d.ready).toBe(true);
    expect(d.title.length).toBeGreaterThan(5);
    await med.mediate(d.missionId, "accept", "Checked against the acceptance criteria.");
    await med.sync();
    expect(await med.mediations()).toHaveLength(0); // daily cap reached

    await m.close();
    m = await market({ honeypotRate: 1, mintBaseCreditsPerDay: 0 });
    const poor = await m.agent(0, { mediator: true });
    await poor.sync();
    expect(await poor.mediations()).toHaveLength(0); // no budget left: no paying fake dispute
  });

  it("burns the bond of a mediator who never votes", async () => {
    m = await market({ mediatorBondCredits: 3 });
    const med = await m.agent(3, { mediator: true });
    const req = await m.agent(20);
    const sol = await m.agent(2);
    const posted = await req.postMission(SPEC);
    await sol.takeMission(posted.missionId);
    await req.sync();
    await sol.sync();
    await sol.deliver(posted.missionId, { mime: "text/plain", content: "x" });
    await req.review(posted.missionId, "contest", "This is not a slugify function.");
    expect((await med.account()).credits).toBe(0);
    await req.sync();
    await sol.sync();
    backdate(m, `UPDATE mediations SET assigned_at = ? WHERE mission_id = ?`, posted.missionId);
    m.troqo.ctx.config.evidenceTtlMinutes = 1e9; // keep the dispute open: only the mediator is late
    await req.mission(posted.missionId);
    expect((await med.account()).credits).toBe(0);
    expect(m.troqo.market.stats().credits.burned).toBe(3);
  });
});

describe("worker sandbox", () => {
  it("keeps the API key in the proxy: the solver only gets a placeholder and the relay URL", () => {
    const args = dockerArgs(["claude", "-p"], { relay: ["anthropic"], env: ["ANTHROPIC_API_KEY", "LANG"] }).join(" ");
    expect(args).toContain("ANTHROPIC_BASE_URL=http://troqo-egress:3128/relay/anthropic");
    expect(args).toContain("ANTHROPIC_API_KEY=troqo-relay-placeholder");
    expect(args).not.toMatch(/-e ANTHROPIC_API_KEY( |$)/); // the real key is never passed through
    expect(args).toContain("-e LANG");
    const setup = sandboxSetupCommands(["api.anthropic.com"], { relay: ["anthropic"] })[1].join(" ");
    expect(setup).toContain("-e ANTHROPIC_API_KEY");
    expect(setup).toContain("--relay anthropic");
  });

  it("relays API calls with the real key, whatever credentials the solver sends", async () => {
    let seen: Record<string, string | string[] | undefined> = {};
    const upstream = createServer((req, res) => {
      seen = req.headers;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ path: req.url }));
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    servers.push(upstream);
    const relay: ApiRelay = { ...API_RELAYS.anthropic, target: `http://127.0.0.1:${(upstream.address() as { port: number }).port}` };
    const proxy = await startEgressProxy(0, [], "127.0.0.1", [relay], { ANTHROPIC_API_KEY: "sk-real-secret" });
    servers.push(proxy);
    const res = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/relay/anthropic/v1/messages?x=1`, {
      method: "POST",
      headers: { "x-api-key": "troqo-relay-placeholder", authorization: "Bearer stolen", "content-type": "application/json" },
      body: "{}",
    });
    expect(await res.json()).toEqual({ path: "/v1/messages?x=1" });
    expect(seen["x-api-key"]).toBe("sk-real-secret");
    expect(seen.authorization).toBeUndefined();
  });
});

describe("releases are signed", () => {
  it("verifies a signed package and rejects a modified one", () => {
    const dir = tmp();
    const { privateFile, publicFile } = generateReleaseKey(dir);
    const pkg = join(dir, "troqo.tgz");
    writeFileSync(pkg, "package bytes");
    signRelease(pkg, readFileSync(privateFile, "utf8"));
    const pub = readFileSync(publicFile, "utf8");
    expect(verifyRelease(pkg, `${pkg}.sig`, pub)).toBe(true);
    writeFileSync(pkg, "package bytes, tampered");
    expect(verifyRelease(pkg, `${pkg}.sig`, pub)).toBe(false);
  });
});

describe("HTTP hardening", () => {
  it("rejects unsigned bodies before reading them, malformed paths, and prices proofs of work per network", async () => {
    m = await market({ powBaseBits: 1, powCost: 1024 });
    const res = await fetch(`${m.url}/v1/missions`, { method: "POST", body: "x".repeat(1_000_000) });
    expect(res.status).toBe(401);
    expect((await fetch(`${m.url}/%E0%A4%A`)).status).toBe(400);

    expect(((await (await fetch(`${m.url}/v1/pow`)).json()) as { bits: number }).bits).toBe(1);
    for (let i = 0; i < 6; i++) await m.agent(); // six identities from one network in the hour: twice the calm 3
    expect(((await (await fetch(`${m.url}/v1/pow`)).json()) as { bits: number }).bits).toBe(3);
    expect(networkKey("203.0.113.77")).toBe("203.0.113.0/24");
    expect(networkKey("2001:db8:1:2::9")).toBe("2001:db8:1::/48");
  });
});

describe("behind a reverse proxy (closed beta)", () => {
  it("rate-limits by the address the proxy saw, not by what the client wrote in X-Forwarded-For", async () => {
    m = await market();
    const server = await startHttp(m.troqo, { port: 0, trustProxy: true, rateLimitPerMinute: 3 });
    servers.push(server);
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/health`;
    const hit = (spoofed: string) => fetch(url, { headers: { "x-forwarded-for": `${spoofed}, 203.0.113.7` } }).then((r) => r.status);
    expect([await hit("1.1.1.1"), await hit("2.2.2.2"), await hit("3.3.3.3")]).toEqual([200, 200, 200]);
    expect(await hit("4.4.4.4")).toBe(429);
  });

  it("sends the Basic Auth of the server URL, and takes the admin token in X-Troqo-Admin", async () => {
    let seen = "";
    const proxy = createServer((req, res) => {
      seen = String(req.headers.authorization ?? "");
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    servers.push(proxy);
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
    const api = new Api(`http://beta:p%40ss@127.0.0.1:${(proxy.address() as { port: number }).port}/`, generateIdentity());
    await api.get("/v1/market");
    expect(seen).toBe(`Basic ${Buffer.from("beta:p@ss").toString("base64")}`);
    expect(api.server).not.toMatch(/p%40ss|beta/);

    m = await market();
    const admin = (headers: Record<string, string>) => fetch(`${m.url}/admin/moderation`, { headers }).then((r) => r.status);
    expect(await admin({ authorization: "Basic YmV0YTpwYXNz", "x-troqo-admin": ADMIN_TOKEN })).toBe(200);
    expect(await admin({ authorization: "Basic YmV0YTpwYXNz" })).toBe(401);
  });
});
