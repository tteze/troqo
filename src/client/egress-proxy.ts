import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";

/**
 * An API relay keeps the model API key out of the sandbox. The solver talks plain HTTP to
 * http://troqo-egress:3128/relay/<name>/… with a dummy key; the proxy, which holds the real key in its
 * own environment, replaces the credentials and forwards the request over HTTPS. A prompt injection
 * that makes the solver print its environment only reveals the dummy.
 */
export interface ApiRelay {
  name: string;
  /** Upstream origin, e.g. https://api.anthropic.com */
  target: string;
  /** Header carrying the credential, and how to build it from the key. */
  header: string;
  format: (key: string) => string;
  /** Environment variable holding the real key, in the proxy's environment. */
  keyEnv: string;
  /** Environment variables the solver needs: base URL (relay URL + suffix) and a dummy key. */
  baseUrlEnv: string;
  baseUrlSuffix: string;
}

export const API_RELAYS: Record<string, ApiRelay> = {
  anthropic: {
    name: "anthropic",
    target: "https://api.anthropic.com",
    header: "x-api-key",
    format: (k) => k,
    keyEnv: "ANTHROPIC_API_KEY",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
    baseUrlSuffix: "",
  },
  openai: {
    name: "openai",
    target: "https://api.openai.com",
    header: "authorization",
    format: (k) => `Bearer ${k}`,
    keyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    baseUrlSuffix: "/v1",
  },
};

const CREDENTIAL_HEADERS = ["authorization", "x-api-key", "proxy-authorization", "cookie"];

function relayRequest(req: IncomingMessage, res: ServerResponse, relays: ApiRelay[], env: NodeJS.ProcessEnv): boolean {
  const url = new URL(req.url ?? "/", "http://relay.local");
  const m = url.pathname.match(/^\/relay\/([a-z0-9-]+)(\/.*)?$/);
  const relay = m && relays.find((r) => r.name === m[1]);
  if (!m || !relay) return false;
  const key = env[relay.keyEnv];
  if (!key) {
    res.writeHead(502).end(`Relay ${relay.name}: ${relay.keyEnv} is not set in the proxy\n`);
    return true;
  }
  // The path is appended to the relay's origin, never resolved against it: "//host/…" or "\\host" would
  // otherwise name another host, which would then receive the real key.
  const origin = new URL(relay.target).origin;
  const path = m[2] ?? "/";
  let target: URL | undefined;
  if (!path.startsWith("//") && !path.includes("\\")) {
    try {
      target = new URL(origin + path + url.search);
    } catch {
      target = undefined;
    }
  }
  if (!target || target.origin !== origin) {
    res.writeHead(400).end("Relay: invalid path\n");
    return true;
  }
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined && !CREDENTIAL_HEADERS.includes(k) && k !== "host" && k !== "connection") headers[k] = v;
  }
  headers[relay.header] = relay.format(key);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const upstream = send(target, { method: req.method, headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on("error", () => res.headersSent ? res.end() : res.writeHead(502).end("Relay upstream error\n"));
  req.pipe(upstream);
  return true;
}

/**
 * A minimal HTTPS egress proxy: it only opens CONNECT tunnels to allowed hosts on port 443.
 * Runs inside the sandbox network so a solver can reach its model API and nothing else.
 */
export function isAllowed(target: string, allow: string[]): boolean {
  const m = target.match(/^([a-z0-9.-]+):(\d+)$/i);
  if (!m || m[2] !== "443") return false;
  const host = m[1].toLowerCase();
  return allow.some((a) => {
    const rule = a.trim().toLowerCase();
    return rule.startsWith("*.") ? host.endsWith(rule.slice(1)) : host === rule;
  });
}

export function startEgressProxy(
  port: number,
  allow: string[],
  host = "0.0.0.0",
  relays: ApiRelay[] = [],
  env: NodeJS.ProcessEnv = process.env,
): Promise<Server> {
  const server = createServer((req, res) => {
    if (relayRequest(req, res, relays, env)) return;
    res.writeHead(403).end("Only HTTPS CONNECT to allowed hosts, or /relay/<name>/ for API relays\n");
  });
  server.on("connect", (req, client, head) => {
    const target = req.url ?? "";
    if (!isAllowed(target, allow)) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const [h, p] = target.split(":");
    const upstream = connect(Number(p), h, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
    client.on("error", () => upstream.destroy());
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
