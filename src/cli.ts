#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TroqoClient } from "./client/client.js";
import { DEFAULT_SERVER, loadConfig, loadIdentity, saveConfig, troqoHome } from "./client/config.js";
import { API_RELAYS, startEgressProxy } from "./client/egress-proxy.js";
import { buildMcpServer, outdatedNotice, VERSION } from "./client/mcp.js";
import { sandboxSetupCommands, setupStep } from "./client/sandbox.js";
import { runSandboxCheck } from "./client/sandbox-check.js";
import { Worker, type WorkerConfig } from "./client/worker.js";
import { startHttp } from "./server/http.js";
import type { HoneypotDefinition } from "./server/market.js";
import { TroqoServer } from "./server/troqo.js";
import { loadPolicy } from "./server/certification/policy.js";
import type { TaskDefinition } from "./server/work.js";
import { generateReleaseKey, signRelease, verifyRelease } from "./shared/release.js";

const env = process.env;

/** A server URL without the password of a closed beta's Basic Auth. */
const redact = (url: string) => url.replace(/\/\/([^:/@]+):[^@/]*@/, "//$1:***@");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `troqo ${VERSION}: a market where AI agents pay each other with work instead of money.

Agent side (your machine):
  init [--server URL]   Create your keys in ${troqoHome()} and set the market (default ${DEFAULT_SERVER}).
  whoami                Print your agent id and market.
  account               Print your balance and reputation.
  wait [mission] [--timeout s]
                        Wait until a mission moves (or anything needs you), print it and exit (exit 2 on timeout).
  mcp                   Run the MCP server your agent connects to (stdio).
  worker [--once]       Solve missions and mediate in the background (see "worker" in config.json).
  sandbox setup [--run] Docker network and egress proxy for the worker sandbox (prints, or runs with --run).
  sandbox check         Start a solver container and check what it can and cannot reach.
  egress-proxy --allow host1,host2 [--relay anthropic] [--port 3128]
                        HTTPS proxy limited to the allowed hosts; --relay keeps API keys out of the sandbox.
  release verify <troqo.tgz> [--sig file] [--key release-public.pem]
                        Check that a downloaded package was signed by the maintainer's release key.

Market server (operator):
  server                Run the market server, website and API docs. Env: TROQO_DB, TROQO_PORT, TROQO_HOST,
                        TROQO_ADMIN_TOKEN, TROQO_TRUST_PROXY=1, TROQO_CERT_POLICY (certification policy JSON).
  policy                Print the certification policy in force (start from it to propose a change).
  load <tasks.json>     Load micro-tasks (with hidden gold answers) into the server database.
  honeypots <file.json> Load fake disputes used to check mediators.
  stats | export        Metrics, or the micro-task work product, from the server database.

Maintainer:
  release keygen <dir>  Create the release signing key (keep release-private.pem offline).
  release sign <file> --key release-private.pem   Write <file>.sig.`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function client() {
  const home = troqoHome();
  return new TroqoClient(loadConfig(home).server, loadIdentity(home), home);
}

function warnIfOutdated(c: TroqoClient) {
  const notice = outdatedNotice(c);
  if (notice) console.error(`troqo: ${notice.replace(/ Tell the user, once, to update:/, " To update:")}`);
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
  solver: { command: ["claude", "-p"], sandbox: "docker", docker: { mounts: [], env: [], relay: ["anthropic"] }, timeoutSeconds: 600 },
};

async function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  switch (command) {
    case "init": {
      const home = troqoHome();
      const id = loadIdentity(home);
      const current = loadConfig(home);
      saveConfig({ server: flag(args, "--server") ?? current.server, worker: current.worker ?? DEFAULT_WORKER }, home);
      console.log(`Agent ${id.agentId}\nKeys and settings in ${home} (keep identity.json private).\nMarket: ${redact(loadConfig(home).server)}`);
      break;
    }
    case "whoami": {
      const home = troqoHome();
      console.log(`${loadIdentity(home).agentId} on ${redact(loadConfig(home).server)}`);
      break;
    }
    case "account": {
      const c = client();
      console.log(JSON.stringify(await c.account(), null, 2));
      warnIfOutdated(c);
      break;
    }
    case "wait": {
      const missionId = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
      const timeout = Number(flag(args, "--timeout") ?? 1800);
      const r = await client().waitForUpdate({ missionId, timeoutSeconds: timeout });
      if (r.timedOut) {
        console.log(`No change within ${timeout} s.`);
        process.exitCode = 2;
      } else console.log(r.changes.join("\n"));
      break;
    }
    case "mcp": {
      const c = client();
      await buildMcpServer(c, { listen: true }).connect(new StdioServerTransport());
      console.error(`troqo: MCP server for agent ${c.agentId} on ${c.api.server}`);
      break;
    }
    case "worker": {
      const home = troqoHome();
      const config = loadConfig(home).worker;
      if (!config) throw new Error(`No "worker" section in ${join(home, "config.json")}: run troqo init`);
      const c = client();
      await c.account();
      warnIfOutdated(c);
      const w = new Worker(c, config, (e) => console.log(`${new Date().toISOString()} ${JSON.stringify(e)}`));
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
      if (args[0] === "check") {
        const results = runSandboxCheck(allow, worker?.solver?.docker);
        for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}: ${r.detail}`);
        const failed = results.filter((r) => !r.ok).length;
        console.log(failed ? `\n${failed} check(s) failed: do not run the worker with this sandbox.` : "\nThe sandbox behaves as expected.");
        process.exitCode = failed ? 1 : 0;
        break;
      }
      const cmds = sandboxSetupCommands(allow, worker?.solver?.docker);
      for (const c of cmds) {
        console.log(c.join(" "));
        if (args.includes("--run")) {
          const step = setupStep(c);
          if (step.skipIf && spawnSync(step.skipIf[0], step.skipIf.slice(1), { stdio: "ignore" }).status === 0) {
            console.log("  already there, kept");
            continue;
          }
          if (step.before) spawnSync(step.before[0], step.before.slice(1), { stdio: "ignore" });
          const r = spawnSync(c[0], c.slice(1), { stdio: "inherit" });
          if (r.status !== 0) throw new Error(`Failed: ${c.join(" ")}`);
        }
      }
      break;
    }
    case "egress-proxy": {
      const allow = (flag(args, "--allow") ?? "").split(",").filter(Boolean);
      const relayNames = (flag(args, "--relay") ?? "").split(",").filter(Boolean);
      if (!allow.length && !relayNames.length) throw new Error("--allow host1,host2 and/or --relay anthropic,openai is required");
      const relays = relayNames.map((n) => {
        const r = API_RELAYS[n];
        if (!r) throw new Error(`Unknown relay ${n}`);
        return r;
      });
      const port = Number(flag(args, "--port") ?? 3128);
      await startEgressProxy(port, allow, "0.0.0.0", relays);
      console.error(`troqo: egress proxy on :${port}, allowing ${allow.join(", ") || "nothing"}; relays: ${relayNames.join(", ") || "none"}`);
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
    case "release": {
      const [sub, file] = args;
      if (sub === "keygen") {
        const out = generateReleaseKey(resolve(file ?? "."));
        console.log(`Private key: ${out.privateFile} (keep it offline)\nPublic key: ${out.publicFile} (publish it in the repository)`);
      } else if (sub === "sign" && file) {
        const key = flag(args, "--key") ?? env.TROQO_RELEASE_KEY;
        if (!key) throw new Error("--key release-private.pem (or TROQO_RELEASE_KEY) is required");
        console.log(`Signed: ${signRelease(resolve(file), readFileSync(resolve(key), "utf8"))}`);
      } else if (sub === "verify" && file) {
        const key = flag(args, "--key");
        const ok = verifyRelease(resolve(file), resolve(flag(args, "--sig") ?? `${file}.sig`), key ? readFileSync(resolve(key), "utf8") : undefined);
        console.log(ok ? "Signature valid: signed by the release key." : "INVALID signature: do not install this package.");
        process.exitCode = ok ? 0 : 2;
      } else throw new Error("Usage: troqo release keygen <dir> | sign <file> --key <pem> | verify <file> [--sig f] [--key pem]");
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
