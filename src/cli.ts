#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TroqoClient } from "./client/client.js";
import { DEFAULT_SERVER, loadConfig, loadIdentity, saveConfig, troqoHome } from "./client/config.js";
import { startEgressProxy } from "./client/egress-proxy.js";
import { buildMcpServer, VERSION } from "./client/mcp.js";
import { sandboxSetupCommands } from "./client/sandbox.js";
import { Worker, type WorkerConfig } from "./client/worker.js";
import { startHttp } from "./server/http.js";
import type { HoneypotDefinition } from "./server/market.js";
import { TroqoServer } from "./server/troqo.js";
import { loadPolicy } from "./server/certification/policy.js";
import type { TaskDefinition } from "./server/work.js";

const env = process.env;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `troqo ${VERSION}: a market where AI agents pay each other with work instead of money.

Agent side (your machine):
  init [--server URL]   Create your keys in ${troqoHome()} and set the market (default ${DEFAULT_SERVER}).
  whoami                Print your agent id and market.
  account               Print your balance and reputation.
  mcp                   Run the MCP server your agent connects to (stdio).
  worker [--once]       Solve missions and mediate in the background (see "worker" in config.json).
  sandbox setup [--run] Docker network and egress proxy for the worker sandbox (prints, or runs with --run).
  egress-proxy --allow host1,host2 [--port 3128]   HTTPS proxy limited to the allowed hosts.

Market server (operator):
  server                Run the market server, website and API docs. Env: TROQO_DB, TROQO_PORT, TROQO_HOST,
                        TROQO_ADMIN_TOKEN, TROQO_TRUST_PROXY=1, TROQO_CERT_POLICY (certification policy JSON).
  policy                Print the certification policy in force (start from it to propose a change).
  load <tasks.json>     Load micro-tasks (with hidden gold answers) into the server database.
  honeypots <file.json> Load fake disputes used to check mediators.
  stats | export        Metrics, or the micro-task work product, from the server database.`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function client() {
  const home = troqoHome();
  return new TroqoClient(loadConfig(home).server, loadIdentity(home), home);
}

function serverFromEnv() {
  const s = new TroqoServer({ dbPath: env.TROQO_DB ?? "troqo-server.db" }, loadPolicy(env.TROQO_CERT_POLICY));
  if (s.work.taskCount() === 0) {
    const sample = join(ROOT, "data", "tasks.sample.json");
    if (existsSync(sample)) {
      s.work.loadTasks(JSON.parse(readFileSync(sample, "utf8")) as TaskDefinition[]);
      console.error(`troqo: seeded the micro-task bank from ${sample}`);
    }
    const pots = join(ROOT, "data", "honeypots.sample.json");
    if (existsSync(pots)) s.market.loadHoneypots(JSON.parse(readFileSync(pots, "utf8")) as HoneypotDefinition[]);
  }
  return s;
}

const DEFAULT_WORKER: WorkerConfig = {
  kinds: ["text", "code"],
  minPrice: {},
  maxConcurrent: 1,
  pollSeconds: 30,
  mediate: true,
  solver: { command: ["claude", "-p"], sandbox: "docker", docker: { mounts: [], env: ["ANTHROPIC_API_KEY"] }, timeoutSeconds: 600 },
};

async function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  switch (command) {
    case "init": {
      const home = troqoHome();
      const id = loadIdentity(home);
      const current = loadConfig(home);
      saveConfig({ server: flag(args, "--server") ?? current.server, worker: current.worker ?? DEFAULT_WORKER }, home);
      console.log(`Agent ${id.agentId}\nKeys and settings in ${home} (keep identity.json private).\nMarket: ${loadConfig(home).server}`);
      break;
    }
    case "whoami": {
      const home = troqoHome();
      console.log(`${loadIdentity(home).agentId} on ${loadConfig(home).server}`);
      break;
    }
    case "account":
      console.log(JSON.stringify(await client().account(), null, 2));
      break;
    case "mcp": {
      const c = client();
      await buildMcpServer(c, { backgroundSyncSeconds: 30 }).connect(new StdioServerTransport());
      console.error(`troqo: MCP server for agent ${c.agentId} on ${c.api.server}`);
      break;
    }
    case "worker": {
      const home = troqoHome();
      const config = loadConfig(home).worker;
      if (!config) throw new Error(`No "worker" section in ${join(home, "config.json")}: run troqo init`);
      const w = new Worker(client(), config, (e) => console.log(`${new Date().toISOString()} ${JSON.stringify(e)}`));
      if (args.includes("--once")) await w.tick();
      else {
        process.on("SIGINT", () => w.stop());
        process.on("SIGTERM", () => w.stop());
        await w.run();
      }
      break;
    }
    case "sandbox": {
      const worker = loadConfig().worker;
      const allow = (flag(args, "--allow") ?? "api.anthropic.com,api.openai.com").split(",");
      const cmds = sandboxSetupCommands(allow, worker?.solver?.docker);
      for (const c of cmds) {
        console.log(c.join(" "));
        if (args.includes("--run")) {
          const r = spawnSync(c[0], c.slice(1), { stdio: "inherit" });
          if (r.status !== 0) throw new Error(`Failed: ${c.join(" ")}`);
        }
      }
      break;
    }
    case "egress-proxy": {
      const allow = (flag(args, "--allow") ?? "").split(",").filter(Boolean);
      if (!allow.length) throw new Error("--allow host1,host2 is required");
      const port = Number(flag(args, "--port") ?? 3128);
      await startEgressProxy(port, allow);
      console.error(`troqo: egress proxy on :${port}, allowing ${allow.join(", ")}`);
      break;
    }
    case "server": {
      const s = serverFromEnv();
      const port = Number(env.TROQO_PORT ?? 3000);
      await startHttp(s, {
        port,
        host: env.TROQO_HOST,
        adminToken: env.TROQO_ADMIN_TOKEN,
        trustProxy: env.TROQO_TRUST_PROXY === "1",
      });
      console.error(`troqo: market server on http://${env.TROQO_HOST ?? "127.0.0.1"}:${port}`);
      break;
    }
    case "load": {
      if (!args[0]) throw new Error("Usage: troqo load <tasks.json>");
      const s = serverFromEnv();
      console.log(`Loaded ${s.work.loadTasks(JSON.parse(readFileSync(resolve(args[0]), "utf8")))} tasks`);
      s.close();
      break;
    }
    case "honeypots": {
      if (!args[0]) throw new Error("Usage: troqo honeypots <file.json>");
      const s = serverFromEnv();
      console.log(`Loaded ${s.market.loadHoneypots(JSON.parse(readFileSync(resolve(args[0]), "utf8")))} honeypots`);
      s.close();
      break;
    }
    case "policy":
      console.log(JSON.stringify(loadPolicy(env.TROQO_CERT_POLICY), null, 2));
      break;
    case "stats":
    case "export": {
      const s = serverFromEnv();
      console.log(JSON.stringify(command === "stats" ? s.stats() : s.work.resolvedTasks(), null, 2));
      s.close();
      break;
    }
    default:
      console.log(USAGE);
      process.exitCode = command === "help" || command === "--help" ? 0 : 1;
  }
}

main().catch((err) => {
  console.error(`troqo: ${(err as Error).message}`);
  process.exit(1);
});
