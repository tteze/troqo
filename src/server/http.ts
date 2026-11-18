import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { VERSION } from "../shared/version.js";
import { readFile, stat } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { agentIdFor, HEADERS, requestSigningString, verifyMessage } from "../shared/crypto.js";
import { TroqoError } from "../shared/errors.js";
import type { TroqoServer } from "./troqo.js";
import type { PowChallenge } from "../shared/pow.js";

export interface HttpOptions {
  port: number;
  host?: string;
  /** Protects /admin/*. If unset, those routes are disabled. */
  adminToken?: string;
  /** Trust X-Forwarded-For (behind Caddy or nginx) to rate-limit by client address. */
  trustProxy?: boolean;
  /** Folder of the public website. Defaults to the package's `site/`. */
  siteDir?: string;
  /** API documentation for agents (Markdown). Defaults to the package's `docs/API.md`. */
  docsFile?: string;
  /** Requests per minute and per address. */
  rateLimitPerMinute?: number;
  /** New identities per hour and per address. */
  registrationsPerHour?: number;
  /** Long-polls held at once on GET /v1/events, market-wide (3 per agent). */
  maxWatchers?: number;
}

/** Longest a GET /v1/events request is held, in seconds (below the usual proxy timeouts). */
export const MAX_EVENTS_WAIT = 50;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAX_BODY = 12_000_000;
const CLOCK_SKEW_MS = 5 * 60_000;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".tgz": "application/gzip",
  ".webmanifest": "application/manifest+json",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function statusFor(code: string): number {
  if (code === "forbidden") return 403;
  if (code.startsWith("unknown_")) return 404;
  if (code === "faucet_dry") return 429;
  if (code === "certification_required") return 403;
  if (code === "too_many_reports") return 429;
  if (code === "already_reported" || code === "already_removed" || code === "appeal_unavailable") return 409;
  if (code === "mission_not_open" || code === "key_conflict" || code === "invalid_state" || code === "batch_closed") return 409;
  return 400;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res
    .writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-troqo-version": VERSION, ...headers })
    .end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, max = MAX_BODY): Promise<string> {
  if (Number(req.headers["content-length"] ?? 0) > max) throw new HttpError(413, "body_too_large", "Request body too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new HttpError(413, "body_too_large", "Request body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Fixed-window counters per key (client addresses). Good enough for one process. Expired entries are
 * purged every few minutes, so an address is kept in memory no longer than its window plus 5 minutes,
 * and never written anywhere.
 */
export class Limiter {
  private readonly hits = new Map<string, { n: number; until: number }>();
  private nextPurge = 0;
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  /** Hits in the current window, without counting a new one. */
  count(key: string): number {
    const h = this.hits.get(key);
    return h && h.until >= Date.now() ? h.n : 0;
  }

  allow(key: string): boolean {
    const t = Date.now();
    if (t >= this.nextPurge || this.hits.size > 50_000) {
      for (const [k, v] of this.hits) if (v.until < t) this.hits.delete(k);
      this.nextPurge = t + 5 * 60_000;
    }
    const h = this.hits.get(key);
    if (!h || h.until < t) {
      this.hits.set(key, { n: 1, until: t + this.windowMs });
      return true;
    }
    h.n++;
    return h.n <= this.max;
  }
}

type Handler = (ctx: { agentId: string; body: any; params: string[]; query: URLSearchParams; res: ServerResponse }) => unknown;

export function startHttp(troqo: TroqoServer, opts: HttpOptions): Promise<Server> {
  const siteDir = opts.siteDir ?? join(ROOT, "site");
  const docsFile = opts.docsFile ?? join(ROOT, "docs", "API.md");
  const limiter = new Limiter(opts.rateLimitPerMinute ?? 300, 60_000);
  const registrations = new Limiter(opts.registrationsPerHour ?? 20, 3_600_000);
  // New identities per hour and per network (/24, /48), to raise the proof of work only where a surge comes from.
  const networkRegistrations = new Limiter(Number.MAX_SAFE_INTEGER, 3_600_000);
  const powFor = (ip: string): PowChallenge => {
    const base = troqo.powChallenge();
    if (base.bits <= 0) return base;
    const n = networkRegistrations.count(networkKey(ip));
    const extra = n > 3 ? Math.floor(Math.log2(n / 3)) + 1 : 0;
    return { ...base, bits: Math.min(base.bits + extra, 24) };
  };
  const nonces = new Map<string, number>();
  const { work, market } = troqo;

  // ---- long-polls on GET /v1/events. Any change made through the API wakes them up to recompute the
  // agent's state; a periodic wake-up catches deadlines that pass without a request.
  const watchers = new Set<() => void>();
  const watchersPerAgent = new Map<string, number>();
  const wakeWatchers = () => setImmediate(() => [...watchers].forEach((w) => w()));
  const wakeTimer = setInterval(wakeWatchers, 15_000);
  wakeTimer.unref();

  async function events(agentId: string, since: string, waitSeconds: number, res: ServerResponse) {
    let state = market.events(agentId);
    const held = watchersPerAgent.get(agentId) ?? 0;
    if (!since || state.cursor !== since || !(waitSeconds > 0) || held >= 3 || watchers.size >= (opts.maxWatchers ?? 1000)) return state;
    watchersPerAgent.set(agentId, held + 1);
    const deadline = Date.now() + Math.min(waitSeconds, MAX_EVENTS_WAIT) * 1000;
    let gone = false;
    const onGone = () => (gone = true);
    res.once("close", onGone);
    try {
      while (Date.now() < deadline && !gone) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            watchers.delete(done);
            res.off("close", done);
            resolve();
          };
          const timer = setTimeout(done, deadline - Date.now());
          watchers.add(done);
          res.once("close", done);
        });
        if (gone) break;
        state = market.events(agentId);
        if (state.cursor !== since) break;
      }
      return state;
    } finally {
      res.off("close", onGone);
      const n = (watchersPerAgent.get(agentId) ?? 1) - 1;
      if (n > 0) watchersPerAgent.set(agentId, n);
      else watchersPerAgent.delete(agentId);
    }
  }

  // Signed routes: [method, pattern, handler]. Captured groups become params.
  const routes: [string, RegExp, Handler][] = [
    ["GET", /^\/v1\/account$/, ({ agentId }) => troqo.account(agentId)],
    ["GET", /^\/v1\/events$/, ({ agentId, query, res }) =>
      events(agentId, query.get("since") ?? "", Number(query.get("wait") ?? 0), res)],
    ["POST", /^\/v1\/work$/, ({ agentId }) => work.openBatch(agentId)],
    ["GET", /^\/v1\/work\/([\w-]+)$/, ({ agentId, params }) => work.getBatch(agentId, params[0])],
    ["POST", /^\/v1\/work\/([\w-]+)\/submit$/, ({ agentId, params, body }) => work.submit(agentId, params[0], arr(body.answers))],
    ["POST", /^\/v1\/work\/([\w-]+)\/cancel$/, ({ agentId, params }) => (work.cancelBatch(agentId, params[0]), { ok: true })],
    ["POST", /^\/v1\/missions$/, ({ agentId, body }) =>
      market.post(agentId, {
        kind: str(body.kind),
        title: str(body.title),
        summary: str(body.summary),
        priceCredits: Number(body.priceCredits),
        specHash: str(body.specHash),
        minLevel: body.minLevel === undefined ? undefined : Number(body.minLevel),
        model: body.model === undefined ? undefined : str(body.model),
      })],
    ["GET", /^\/v1\/missions\/available$/, ({ agentId, query }) => market.listOpen(query.get("kind") ?? undefined, agentId)],
    ["GET", /^\/v1\/missions\/mine$/, ({ agentId }) => market.mine(agentId)],
    ["GET", /^\/v1\/missions\/([\w-]+)$/, ({ agentId, params }) => market.get(agentId, params[0])],
    ["POST", /^\/v1\/missions\/([\w-]+)\/take$/, ({ agentId, params }) => market.take(agentId, params[0])],
    ["POST", /^\/v1\/missions\/([\w-]+)\/spec$/, ({ agentId, params, body }) => market.sendSpec(agentId, params[0], str(body.envelope))],
    ["POST", /^\/v1\/missions\/([\w-]+)\/deliver$/, ({ agentId, params, body }) =>
      market.deliver(agentId, params[0], {
        deliveryHash: str(body.deliveryHash),
        deliveryMime: str(body.deliveryMime),
        envelope: str(body.envelope),
      })],
    ["POST", /^\/v1\/missions\/([\w-]+)\/review$/, ({ agentId, params, body }) =>
      market.review(agentId, params[0], oneOf(body.decision, ["accept", "contest"]), body.reason === undefined ? undefined : str(body.reason))],
    ["POST", /^\/v1\/missions\/([\w-]+)\/respond$/, ({ agentId, params, body }) =>
      market.respond(agentId, params[0], oneOf(body.decision, ["accept", "appeal"]))],
    ["POST", /^\/v1\/missions\/([\w-]+)\/cancel$/, ({ agentId, params }) => market.cancel(agentId, params[0])],
    ["POST", /^\/v1\/missions\/([\w-]+)\/evidence$/, ({ agentId, params, body }) =>
      market.sendEvidence(agentId, params[0], str(body.to), str(body.envelope))],
    ["POST", /^\/v1\/missions\/([\w-]+)\/mediate$/, ({ agentId, params, body }) =>
      market.mediate(agentId, params[0], oneOf(body.verdict, ["accept", "refuse"]), str(body.justification))],
    ["GET", /^\/v1\/inbox$/, ({ agentId }) => market.inbox(agentId)],
    ["POST", /^\/v1\/missions\/([\w-]+)\/report$/, ({ agentId, params, body }) => {
      const k = troqo.moderation.report(agentId, params[0], str(body.reason));
      return { caseId: k.caseId, missionId: k.missionId, status: k.status };
    }],
    ["POST", /^\/v1\/moderations\/([\w-]+)$/, ({ agentId, params, body }) =>
      troqo.moderation.vote(agentId, params[0], oneOf(body.verdict, ["keep", "remove"]), str(body.justification))],
    ["POST", /^\/v1\/profile$/, ({ agentId, body }) => troqo.certifier.setModel(agentId, str(body.model))],
    ["POST", /^\/v1\/certifications\/([\w-]+)\/exam$/, ({ agentId, params }) => troqo.certifier.startExam(agentId, params[0])],
    ["POST", /^\/v1\/rankings\/([\w-]+)$/, ({ agentId, params, body }) =>
      troqo.certifier.rank(agentId, params[0], Array.isArray(body.order) ? body.order.map(String) : [], str(body.justification))],
    ["POST", /^\/v1\/inbox\/([\w-]+)\/ack$/, ({ agentId, params }) => (market.ack(agentId, params[0]), { ok: true })],
  ];

  /** Header checks that need no body: done before reading it, so unsigned junk costs the server nothing. */
  function preAuthenticate(req: IncomingMessage, path: string) {
    const h = (name: string) => {
      const v = req.headers[name];
      return typeof v === "string" ? v : undefined;
    };
    const agentId = h(HEADERS.agent);
    const timestamp = h(HEADERS.timestamp);
    const nonce = h(HEADERS.nonce);
    const signature = h(HEADERS.signature);
    if (!agentId || !timestamp || !nonce || !signature) {
      throw new HttpError(401, "unauthorized", "Signed request required (see /api.md)");
    }
    const skew = Math.abs(Date.now() - Date.parse(timestamp));
    if (!(skew <= CLOCK_SKEW_MS)) throw new HttpError(401, "bad_timestamp", "Timestamp missing or more than 5 minutes off");
    if (!/^[\w-]{8,64}$/.test(nonce)) throw new HttpError(401, "bad_nonce", "Invalid nonce");
    if (nonces.has(`${agentId}:${nonce}`)) throw new HttpError(401, "replayed", "This request was already received");
    if (path !== "/v1/register") {
      const a = troqo.ctx.db.prepare(`SELECT banned FROM agents WHERE agent_id = ?`).get(agentId) as { banned: number } | undefined;
      if (!a) throw new HttpError(401, "unknown_agent", "Register your public keys first");
      if (a.banned) throw new HttpError(403, "banned", "This identity was banned by the operator (see troqo.dev/legal)");
    }
    return { agentId, timestamp, nonce, signature };
  }

  function authenticate(req: IncomingMessage, path: string, body: string): string {
    const { agentId, timestamp, nonce, signature } = preAuthenticate(req, path);
    const key = `${agentId}:${nonce}`;

    let signPublic: string;
    if (path === "/v1/register") {
      signPublic = String(JSON.parse(body || "{}").signPublic ?? "");
      if (agentIdFor(signPublic) !== agentId) throw new HttpError(401, "unauthorized", "Agent id does not match the key");
    } else {
      signPublic = troqo.publicKeys(agentId).signPublic;
    }
    const message = requestSigningString(req.method ?? "GET", path, timestamp, nonce, body);
    if (!verifyMessage(message, signature, signPublic)) throw new HttpError(401, "bad_signature", "Signature does not verify");
    nonces.set(key, Date.now() + 2 * CLOCK_SKEW_MS);
    if (path !== "/v1/register") troqo.ctx.touch(agentId);
    if (nonces.size > 100_000) for (const [k, exp] of nonces) if (exp < Date.now()) nonces.delete(k);
    return agentId;
  }

  function requireAdmin(req: IncomingMessage) {
    // X-Troqo-Admin works behind a proxy that uses Authorization itself (Basic Auth of a closed beta).
    const token = String(req.headers["x-troqo-admin"] ?? req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!opts.adminToken || !token || !safeEqual(token, opts.adminToken)) throw new HttpError(401, "unauthorized", "Admin token required");
  }

  async function serveFile(res: ServerResponse, file: string, cache = "public, max-age=300") {
    try {
      const s = await stat(file);
      if (!s.isFile()) return false;
      const type = TYPES[extname(file)] ?? "application/octet-stream";
      res.writeHead(200, { "content-type": type, "cache-control": cache }).end(await readFile(file));
      return true;
    } catch {
      return false;
    }
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const pathWithQuery = path + url.search;
      // The proxy appends the address it saw: the last entry. Earlier ones are whatever the client sent.
      const fwd = opts.trustProxy ? (String(req.headers["x-forwarded-for"] ?? "").split(",").pop() ?? "").trim() : "";
      const ip = addressKey(fwd || req.socket.remoteAddress || "unknown");
      if (!limiter.allow(ip)) throw new HttpError(429, "rate_limited", "Too many requests, slow down");
      res.setHeader("access-control-allow-origin", "*");
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-methods": "GET, POST",
          "access-control-allow-headers": `content-type, ${Object.values(HEADERS).join(", ")}`,
        }).end();
        return;
      }

      // ---- public
      if (req.method === "GET") {
        if (path === "/health") return send(res, 200, { ok: true });
        if (path === "/v1/pow") return send(res, 200, powFor(ip));
        if (path === "/v1/certification/policy") return send(res, 200, troqo.certifier.policy, { "cache-control": "public, max-age=300" });
        if (path === "/v1/market") return send(res, 200, troqo.publicMarket(), { "cache-control": "public, max-age=15" });
        if (path === "/v1/missions/open") return send(res, 200, market.listOpen(url.searchParams.get("kind") ?? undefined));
        const keys = path.match(/^\/v1\/agents\/([\w-]+)$/);
        if (keys) return send(res, 200, troqo.publicProfile(keys[1]));
        if (path === "/api.md" || path === "/llms.txt") {
          if (await serveFile(res, docsFile)) return;
        }
        if (path === "/admin/stats" || path === "/admin/export" || path === "/admin/moderation") {
          requireAdmin(req);
          if (path === "/admin/moderation") return send(res, 200, troqo.moderation.cases(url.searchParams.get("status") ?? "operator"));
          return send(res, 200, path === "/admin/stats" ? troqo.stats() : work.resolvedTasks());
        }
      }
      // ---- operator actions (moderation, bans)
      if (req.method === "POST" && path.startsWith("/admin/")) {
        requireAdmin(req);
        wakeWatchers();
        const b = JSON.parse((await readBody(req, 8192)) || "{}");
        const reason = str(b.reason);
        if (reason.trim().length < 5) throw new HttpError(400, "invalid_request", "reason: required, it is shown to the author");
        let m: RegExpMatchArray | null;
        if ((m = path.match(/^\/admin\/moderation\/([\w-]+)$/))) {
          return send(res, 200, troqo.moderation.decide(m[1], oneOf(b.verdict, ["keep", "remove"]), "operator", reason));
        }
        if ((m = path.match(/^\/admin\/missions\/([\w-]+)\/remove$/))) return send(res, 200, troqo.moderation.remove(m[1], reason));
        if ((m = path.match(/^\/admin\/agents\/([\w-]+)\/ban$/))) return send(res, 200, troqo.moderation.ban(m[1], reason));
        throw new HttpError(404, "not_found", "No such admin action");
      }

      // ---- signed API
      if (path === "/v1/register" && req.method === "POST") {
        preAuthenticate(req, path);
        const body = await readBody(req, 4096);
        const agentId = authenticate(req, pathWithQuery, body);
        if (troqo.ctx.agentExists(agentId)) return send(res, 200, { agentId, created: false });
        if (!registrations.allow(ip)) throw new HttpError(429, "rate_limited", "Too many new identities from this address");
        const b = JSON.parse(body);
        const str = (v: unknown) => (v === undefined ? "" : String(v));
        const out = troqo.register(str(b.signPublic), str(b.boxPublic), str(b.boxSignature), str(b.pow), powFor(ip));
        if (out.agentId !== agentId) throw new HttpError(401, "unauthorized", "Agent id does not match the key");
        if (out.created) networkRegistrations.allow(networkKey(ip));
        return send(res, out.created ? 201 : 200, out);
      }
      if (path.startsWith("/v1/")) {
        const route = routes.find(([m, re]) => m === req.method && re.test(path));
        if (!route) throw new HttpError(404, "not_found", "No such endpoint (see /api.md)");
        preAuthenticate(req, path);
        const body = req.method === "POST" ? await readBody(req) : "";
        const agentId = authenticate(req, pathWithQuery, body);
        let parsed: unknown = {};
        try {
          parsed = body ? JSON.parse(body) : {};
        } catch {
          throw new HttpError(400, "invalid_json", "Body must be JSON");
        }
        const params = path.match(route[1])!.slice(1);
        const out = await route[2]({ agentId, body: parsed ?? {}, params, query: url.searchParams, res });
        if (req.method === "POST") wakeWatchers();
        if (res.writableEnded || res.destroyed) return; // a long-poll whose client left
        return send(res, 200, out);
      }

      // ---- website
      if (req.method === "GET" || req.method === "HEAD") {
        let rel: string;
        try {
          rel = decodeURIComponent(path);
        } catch {
          throw new HttpError(400, "bad_path", "Malformed URL");
        }
        if (rel.endsWith("/")) rel += "index.html";
        if (!extname(rel)) rel += ".html";
        const file = normalize(join(siteDir, rel));
        if (file.startsWith(siteDir + sep) && (await serveFile(res, file))) return;
      }
      throw new HttpError(404, "not_found", "Not found");
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof HttpError) return send(res, err.status, { error: err.code, message: err.message });
      if (err instanceof TroqoError) return send(res, statusFor(err.code), { error: err.code, message: err.message });
      if (err instanceof SyntaxError) return send(res, 400, { error: "invalid_json", message: "Body must be JSON" });
      return send(res, 500, { error: "internal_error", message: "Internal error" });
    }
  });

  server.on("close", () => {
    clearInterval(wakeTimer);
    [...watchers].forEach((w) => w());
  });
  return new Promise((resolve) => server.listen(opts.port, opts.host ?? "127.0.0.1", () => resolve(server)));
}

/**
 * The key rate limits count against. An IPv6 connection usually owns a whole /64 (billions of
 * addresses), so IPv6 is limited per /64 prefix; IPv4 and IPv4-mapped addresses per address.
 */
export function addressKey(ip: string): string {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.split("%")[0].toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = ip.includes("::") && tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

/** The network a registration surge is attributed to: an IPv4 /24 or an IPv6 /48. */
export function networkKey(ip: string): string {
  const k = addressKey(ip);
  if (k.endsWith("::/64")) return k.split(":").slice(0, 3).join(":") + "::/48";
  const v4 = k.match(/^(\d+\.\d+\.\d+)\.\d+$/);
  return v4 ? `${v4[1]}.0/24` : k;
}

function str(v: unknown): string {
  if (typeof v !== "string") throw new TroqoError("invalid_request", "Expected a string field");
  return v;
}

function arr(v: unknown): { taskId: string; answer: string }[] {
  if (!Array.isArray(v)) throw new TroqoError("invalid_request", "answers: an array of { taskId, answer }");
  return v.map((x) => ({ taskId: str(x?.taskId), answer: str(x?.answer) }));
}

function oneOf<T extends string>(v: unknown, values: T[]): T {
  if (typeof v !== "string" || !values.includes(v as T)) {
    throw new TroqoError("invalid_request", `Expected one of: ${values.join(", ")}`);
  }
  return v as T;
}
