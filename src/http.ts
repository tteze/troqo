import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Troqo } from "./engine.js";
import { buildServer } from "./server.js";

export interface HttpOptions {
  port: number;
  host?: string;
  /** Bearer token → agent id, for a private server. */
  agentKeys: Map<string, string>;
  /**
   * No accounts: any agent may connect with a secret key it generated itself (see `troqo key`).
   * Its identity is derived from the key; a new key starts with zero credits.
   */
  openAccess?: boolean;
  /** Protects GET /stats and /export. If unset, those routes are disabled. */
  adminToken?: string;
  publicUrl?: string;
}

/** Parses "token1:agentA,token2:agentB". */
export function parseAgentKeys(value: string | undefined): Map<string, string> {
  const keys = new Map<string, string>();
  for (const pair of (value ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = pair.indexOf(":");
    if (i <= 0 || i === pair.length - 1) throw new Error(`Invalid TROQO_AGENT_KEYS entry: "${pair}"`);
    keys.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return keys;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("Body too large");
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
}

/** A secret agent key: 43 base64url characters (256 bits). Whoever holds it owns the credits. */
export function generateAgentKey(): string {
  return `tq_${randomBytes(32).toString("base64url")}`;
}

const AGENT_KEY = /^tq_[A-Za-z0-9_-]{43}$/;

/** Stable public id of a self-generated key; the key itself is never stored. */
export function agentIdFromKey(key: string): string {
  return `agent_${createHash("sha256").update(key).digest("hex").slice(0, 20)}`;
}

function resolveAgentId(token: string | undefined, opts: HttpOptions): string | undefined {
  if (!token) return undefined;
  const listed = opts.agentKeys.get(token);
  if (listed) return listed;
  return opts.openAccess && AGENT_KEY.test(token) ? agentIdFromKey(token) : undefined;
}

export function startHttp(engine: Troqo, opts: HttpOptions): Promise<Server> {
  if (opts.agentKeys.size === 0 && !opts.openAccess) {
    throw new Error("Set TROQO_AGENT_KEYS for a private server, or TROQO_OPEN_ACCESS=1 for self-generated keys");
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true });

      const result = url.pathname.match(/^\/results\/([0-9a-f-]{36})$/);
      if (req.method === "GET" && result) {
        const r = engine.getResult(result[1]);
        if (!r) return json(res, 404, { error: "not_found" });
        return res.writeHead(200, { "content-type": r.mimeType }).end(Buffer.from(r.data, "base64"));
      }

      if (req.method === "GET" && (url.pathname === "/stats" || url.pathname === "/export")) {
        const token = bearer(req);
        if (!opts.adminToken || !token || !safeEqual(token, opts.adminToken)) {
          return json(res, 401, { error: "unauthorized" });
        }
        return json(res, 200, url.pathname === "/stats" ? engine.stats() : engine.resolvedTasks());
      }

      if (url.pathname === "/mcp") {
        const token = bearer(req);
        const agentId = resolveAgentId(token, opts);
        if (!agentId) return json(res, 401, { error: "unauthorized" });
        if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });

        // Stateless mode: one server + transport per request.
        const mcp = buildServer(engine, (extra) => extra.authInfo?.clientId ?? agentId, {
          publicUrl: opts.publicUrl,
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport);
        const authed = Object.assign(req, { auth: { token: token!, clientId: agentId, scopes: [] } });
        await transport.handleRequest(authed, res, await readBody(req));
        return;
      }

      json(res, 404, { error: "not_found" });
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: (err as Error).message });
    }
  });

  return new Promise((resolve) => server.listen(opts.port, opts.host ?? "127.0.0.1", () => resolve(server)));
}
