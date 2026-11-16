#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Troqo } from "./engine.js";
import { parseAgentKeys, startHttp } from "./http.js";
import { providersFromEnv } from "./providers.js";
import { buildServer } from "./server.js";
import type { TaskDefinition } from "./types.js";

const env = process.env;
const SAMPLE_TASKS = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "tasks.sample.json");

const USAGE = `troqo <command>

Commands:
  stdio            Run the MCP server over stdio (default). Agent id: TROQO_AGENT_ID (default "local").
  http             Run the MCP server over HTTP at /mcp. Requires TROQO_AGENT_KEYS="token:agentId,...".
  load <file.json> Load or update micro-tasks from a JSON file.
  stats            Print metrics (pass rate, tokens per batch, spend, resolved tasks).
  export           Print resolved tasks (the work product) as JSON.

Environment: TROQO_DB, TROQO_MAX_SPEND_USD, TROQO_GOLD_PER_BATCH, TROQO_PORT, TROQO_HOST,
TROQO_PUBLIC_URL, TROQO_ADMIN_TOKEN, TROQO_IMAGE_API_KEY (+ _BASE_URL, _MODEL, _SIZE, _COST_USD, _PRICE_CREDITS).`;

function engineFromEnv(): Troqo {
  const engine = new Troqo(
    {
      dbPath: env.TROQO_DB ?? "troqo.db",
      maxSpendUsd: env.TROQO_MAX_SPEND_USD ? Number(env.TROQO_MAX_SPEND_USD) : undefined,
      goldPerBatch: env.TROQO_GOLD_PER_BATCH ? Number(env.TROQO_GOLD_PER_BATCH) : undefined,
    },
    providersFromEnv(env),
  );
  // Seed with the sample bank on first run so the loop works out of the box.
  const count = engine.db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number };
  if (count.n === 0 && existsSync(SAMPLE_TASKS)) {
    engine.loadTasks(JSON.parse(readFileSync(SAMPLE_TASKS, "utf8")) as TaskDefinition[]);
    console.error(`troqo: seeded task bank from ${SAMPLE_TASKS}`);
  }
  return engine;
}

async function main() {
  const [command = "stdio", arg] = process.argv.slice(2);
  switch (command) {
    case "stdio": {
      const engine = engineFromEnv();
      const agentId = env.TROQO_AGENT_ID ?? "local";
      await buildServer(engine, () => agentId, { publicUrl: env.TROQO_PUBLIC_URL }).connect(
        new StdioServerTransport(),
      );
      console.error(`troqo: MCP server on stdio (agent "${agentId}")`);
      break;
    }
    case "http": {
      const engine = engineFromEnv();
      const port = Number(env.TROQO_PORT ?? 3000);
      await startHttp(engine, {
        port,
        host: env.TROQO_HOST,
        agentKeys: parseAgentKeys(env.TROQO_AGENT_KEYS),
        adminToken: env.TROQO_ADMIN_TOKEN,
        publicUrl: env.TROQO_PUBLIC_URL,
      });
      console.error(`troqo: MCP server on http://${env.TROQO_HOST ?? "127.0.0.1"}:${port}/mcp`);
      break;
    }
    case "load": {
      if (!arg) throw new Error("Usage: troqo load <file.json>");
      const engine = engineFromEnv();
      const n = engine.loadTasks(JSON.parse(readFileSync(resolve(arg), "utf8")) as TaskDefinition[]);
      console.log(`Loaded ${n} tasks`);
      engine.close();
      break;
    }
    case "stats":
    case "export": {
      const engine = engineFromEnv();
      console.log(JSON.stringify(command === "stats" ? engine.stats() : engine.resolvedTasks(), null, 2));
      engine.close();
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
