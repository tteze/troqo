import { createServer, type Server } from "node:http";
import { connect } from "node:net";

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

export function startEgressProxy(port: number, allow: string[], host = "0.0.0.0"): Promise<Server> {
  const server = createServer((_req, res) => {
    res.writeHead(403).end("Only HTTPS CONNECT to allowed hosts\n");
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
