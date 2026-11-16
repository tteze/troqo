import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Troqo } from "./engine.js";
import { buildServer } from "./server.js";

export interface HttpOptions {
  port: number;
  host?: string;
  /** Bearer token → agent id. Each token identifies one agent and its credit balance. */
  agentKeys: Map<string, string>;
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

export function startHttp(engine: Troqo, opts: HttpOptions): Promise<Server> {
  if (opts.agentKeys.size === 0) throw new Error("No agent keys configured (TROQO_AGENT_KEYS)");

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
        const agentId = token ? opts.agentKeys.get(token) : undefined;
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
