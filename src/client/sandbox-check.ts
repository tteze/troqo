import { spawnSync } from "node:child_process";
import { DEFAULT_DOCKER, dockerArgs, type DockerSandbox } from "./sandbox.js";
import { API_RELAYS } from "./egress-proxy.js";

/**
 * `troqo sandbox check`: starts a real solver container with the worker's own Docker options and
 * probes, from inside, what it can and cannot reach. Run it once after `troqo sandbox setup --run`,
 * and again after changing the sandbox settings.
 */

/** One line of the report. `ok` is whether the sandbox behaves as it should. */
export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** What the probe running inside the container reports (see PROBE). */
export interface ProbeReport {
  uid: number;
  capEff: string;
  rootWritable: boolean;
  tmpWritable: boolean;
  dockerSocket: boolean;
  secrets: string[];
  /** CONNECT through the egress proxy: HTTP status, or an error. */
  proxy: Record<string, string>;
  /** Plain request to an API relay: HTTP status, or an error. */
  relay: Record<string, string>;
  /** Direct TCP connections that bypass the proxy: "open" or the error. */
  direct: Record<string, string>;
}

/** Hosts the solver must not reach, directly or through the proxy. */
export const FORBIDDEN_DIRECT = ["1.1.1.1:443", "172.17.0.1:22", "172.17.0.1:80", "192.168.0.1:80", "192.168.1.1:80", "10.0.0.1:80", "169.254.169.254:80"];
export const FORBIDDEN_VIA_PROXY = ["example.com:443", "troqo.dev:443", "127.0.0.1:22", "192.168.1.1:443", "169.254.169.254:443"];

/**
 * Runs inside the container with plain Node (no dependency). Prints one JSON line. Each network
 * probe gives up after a few seconds: a timeout counts as blocked.
 */
export const PROBE = String.raw`
const fs = require("fs"), net = require("net"), http = require("http");
const input = JSON.parse(process.argv[1]);
const proxy = new URL(process.env.HTTPS_PROXY || "http://troqo-egress:3128");
const out = { uid: process.getuid(), capEff: "", rootWritable: false, tmpWritable: false, dockerSocket: false, secrets: [], proxy: {}, relay: {}, direct: {} };
try { out.capEff = (fs.readFileSync("/proc/self/status", "utf8").match(/CapEff:\s*(\w+)/) || [])[1] || ""; } catch {}
const canWrite = (p) => { try { fs.writeFileSync(p, "x"); fs.unlinkSync(p); return true; } catch { return false; } };
out.rootWritable = canWrite("/troqo-probe") || canWrite("/usr/troqo-probe");
out.tmpWritable = canWrite("/tmp/troqo-probe");
out.dockerSocket = fs.existsSync("/var/run/docker.sock");
for (const [k, v] of Object.entries(process.env)) {
  if (/^(sk-|sk_|AIza|ghp_|xox)/.test(v || "") || (/KEY|TOKEN|SECRET|PASSWORD/i.test(k) && v && v !== "troqo-relay-placeholder")) out.secrets.push(k);
}
const connect = (target) => new Promise((resolve) => {
  const req = http.request({ host: proxy.hostname, port: proxy.port || 80, method: "CONNECT", path: target, timeout: 6000 });
  req.on("connect", (res, socket) => { socket.destroy(); resolve(String(res.statusCode)); });
  req.on("response", (res) => resolve(String(res.statusCode)));
  req.on("timeout", () => { req.destroy(); resolve("timeout"); });
  req.on("error", (e) => resolve(e.code || e.message));
  req.end();
});
const get = (url) => new Promise((resolve) => {
  const req = http.get(url, { timeout: 15000 }, (res) => { res.resume(); resolve(String(res.statusCode)); });
  req.on("timeout", () => { req.destroy(); resolve("timeout"); });
  req.on("error", (e) => resolve(e.code || e.message));
});
const tcp = (target) => new Promise((resolve) => {
  const [host, port] = target.split(":");
  const s = net.connect({ host, port: Number(port) });
  const done = (r) => { s.destroy(); resolve(r); };
  s.setTimeout(3000, () => done("timeout"));
  s.on("connect", () => done("open"));
  s.on("error", (e) => done(e.code || e.message));
});
(async () => {
  for (const t of input.allowed) out.proxy[t] = await connect(t);
  for (const t of input.forbiddenViaProxy) out.proxy[t] = await connect(t);
  for (const [name, url] of Object.entries(input.relays)) out.relay[name] = await get(url);
  await Promise.all(input.forbiddenDirect.map(async (t) => { out.direct[t] = await tcp(t); }));
  console.log(JSON.stringify(out));
})();
`;

/** The probe's input: what to test, from the worker's settings. */
export function probeInput(allowHosts: string[], options: Partial<DockerSandbox>) {
  const o = { ...DEFAULT_DOCKER, ...options };
  const relays: Record<string, string> = {};
  for (const name of o.relay) {
    const r = API_RELAYS[name];
    // A GET on the models list: answered by the provider through the relay, which adds the real key.
    if (r) relays[name] = `${o.proxy}/relay/${r.name}/v1/models`;
  }
  return {
    allowed: allowHosts.map((h) => (h.includes(":") ? h : `${h}:443`)),
    forbiddenViaProxy: FORBIDDEN_VIA_PROXY,
    forbiddenDirect: FORBIDDEN_DIRECT,
    relays,
  };
}

/** Turns the probe's report into pass/fail lines. */
export function evaluate(report: ProbeReport, input: ReturnType<typeof probeInput>): CheckResult[] {
  const r: CheckResult[] = [];
  r.push({ name: "Unprivileged user", ok: report.uid !== 0, detail: `uid ${report.uid}` });
  r.push({ name: "No Linux capabilities", ok: /^0+$/.test(report.capEff), detail: `CapEff ${report.capEff || "?"}` });
  r.push({ name: "Read-only file system", ok: !report.rootWritable, detail: report.rootWritable ? "the image can be written to" : "writes refused" });
  r.push({ name: "Scratch space in /tmp", ok: report.tmpWritable, detail: report.tmpWritable ? "writable" : "not writable: the solver may fail" });
  r.push({ name: "No Docker socket", ok: !report.dockerSocket, detail: report.dockerSocket ? "/var/run/docker.sock is mounted" : "absent" });
  r.push({
    name: "No secret in the environment",
    ok: report.secrets.length === 0,
    detail: report.secrets.length ? `visible: ${report.secrets.join(", ")} (use "relay" instead of passing keys)` : "none",
  });
  for (const t of input.allowed) {
    const s = report.proxy[t];
    r.push({ name: `Allowed: ${t} through the proxy`, ok: s === "200", detail: s === "200" ? "reachable" : `not reachable (${s})` });
  }
  for (const t of input.forbiddenViaProxy) {
    const s = report.proxy[t];
    r.push({ name: `Blocked: ${t} through the proxy`, ok: s !== "200", detail: s === "200" ? "REACHABLE" : `refused (${s})` });
  }
  for (const [name] of Object.entries(input.relays)) {
    const s = report.relay[name];
    const ok = s === "200";
    const detail = ok ? "the provider answered, with the key added by the proxy" : s === "401" ? "401: the proxy has no valid key (set it before sandbox setup)" : `no answer (${s})`;
    r.push({ name: `API relay: ${name}`, ok, detail });
  }
  for (const t of input.forbiddenDirect) {
    const s = report.direct[t];
    r.push({ name: `Blocked: direct connection to ${t}`, ok: s !== "open", detail: s === "open" ? "OPEN" : `no route (${s})` });
  }
  return r;
}

function docker(args: string[]) {
  return spawnSync("docker", args, { encoding: "utf8", timeout: 120_000 });
}

/** Host-side checks, then the probe inside a solver container. */
export function runSandboxCheck(allowHosts: string[], options: Partial<DockerSandbox> = {}): CheckResult[] {
  const o = { ...DEFAULT_DOCKER, ...options };
  const results: CheckResult[] = [];
  const net = docker(["network", "inspect", "-f", "{{.Internal}}", o.network]);
  if (net.error) return [{ name: "Docker", ok: false, detail: `docker not found: ${net.error.message}` }];
  results.push({
    name: `Network ${o.network} is internal`,
    ok: net.stdout.trim() === "true",
    detail: net.status === 0 ? `Internal=${net.stdout.trim()}` : "missing: run troqo sandbox setup --run",
  });
  const proxy = docker(["inspect", "-f", "{{.State.Running}}", proxyContainer(o.proxy)]);
  results.push({
    name: "Egress proxy running",
    ok: proxy.stdout.trim() === "true",
    detail: proxy.status === 0 ? `running=${proxy.stdout.trim()}` : "missing: run troqo sandbox setup --run",
  });
  if (!results.every((x) => x.ok)) return results;

  const input = probeInput(allowHosts, o);
  const run = docker(dockerArgs(["node", "-e", PROBE, JSON.stringify(input)], o));
  const line = run.stdout.trim().split("\n").pop() ?? "";
  try {
    return [...results, ...evaluate(JSON.parse(line) as ProbeReport, input)];
  } catch {
    return [...results, { name: "Probe", ok: false, detail: `could not run in ${o.image}: ${(run.stderr || run.stdout).trim().slice(-300)}` }];
  }
}

const proxyContainer = (proxy: string) => new URL(proxy).hostname;
