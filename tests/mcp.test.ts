import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Troqo } from "../src/engine.js";
import { startHttp } from "../src/http.js";
import { mockImageProvider } from "../src/providers.js";
import { buildServer } from "../src/server.js";
import type { TaskDefinition } from "../src/types.js";

const bank: TaskDefinition[] = [
  { id: "r1", kind: "classify", instruction: "Sentiment?", input: "Great!", options: ["positive", "negative"] },
  { id: "r2", kind: "classify", instruction: "Sentiment?", input: "Awful.", options: ["positive", "negative"] },
  { id: "g1", kind: "classify", instruction: "Sentiment?", input: "I love it", options: ["positive", "negative"], gold: "positive" },
];
const golden: Record<string, string> = { r1: "positive", r2: "negative", g1: "positive" };

function engine() {
  const e = new Troqo({ dbPath: ":memory:" }, [mockImageProvider(2)]);
  e.loadTasks(bank);
  return e;
}

type ToolResult = { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean };

async function runLoop(client: Client) {
  const caps = (await client.callTool({ name: "list_capabilities" })) as ToolResult;
  expect(JSON.parse(caps.content[0].text!)[0]).toMatchObject({ id: "image.mock", priceCredits: 2, tasksPerRequest: 3 });

  const req = (await client.callTool({
    name: "request_capability",
    arguments: { capability: "image.mock", prompt: "a lighthouse at dusk" },
  })) as ToolResult;
  const body = req.content[0].text!;
  const requestId = body.match(/Request ([0-9a-f-]{36})/)![1];
  const tasks = JSON.parse(body.slice(body.indexOf("["))) as { taskId: string }[];
  expect(tasks).toHaveLength(3);

  const done = (await client.callTool({
    name: "submit_tasks",
    arguments: { request_id: requestId, answers: tasks.map((t) => ({ task_id: t.taskId, answer: golden[t.taskId] })) },
  })) as ToolResult;
  expect(done.isError).toBeFalsy();
  expect(done.content[0].text).toMatch(/Delivered/);
  expect(done.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });

  const again = (await client.callTool({ name: "get_request", arguments: { request_id: requestId } })) as ToolResult;
  expect(again.content[1].type).toBe("image");
  return { requestId, done };
}

describe("MCP server", () => {
  it("runs the full barter loop over an in-memory transport", async () => {
    const e = engine();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await buildServer(e, () => "agent-1").connect(serverT);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientT);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "cancel_request",
      "get_account",
      "get_request",
      "list_capabilities",
      "request_capability",
      "submit_tasks",
    ]);
    await runLoop(client);

    const bad = (await client.callTool({
      name: "request_capability",
      arguments: { capability: "nope", prompt: "x" },
    })) as ToolResult;
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/unknown_capability/);
  });
});

describe("HTTP server", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  it("authenticates agents by bearer token and serves results", async () => {
    const e = engine();
    server = await startHttp(e, {
      port: 0,
      agentKeys: new Map([["secret-1", "agent-http"]]),
      adminToken: "admin",
      publicUrl: "http://example.test",
    });
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    expect((await fetch(`${base}/mcp`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${base}/stats`)).status).toBe(401);

    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: "Bearer secret-1" } },
      }),
    );
    const { done } = await runLoop(client);
    const resultUrl = done.content[0].text!.match(/http:\/\/example\.test(\/results\/[0-9a-f-]{36})/)![1];

    const img = await fetch(`${base}${resultUrl}`);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(e.account("agent-http").batchesPassed).toBe(1);

    const stats = await fetch(`${base}/stats`, { headers: { authorization: "Bearer admin" } });
    expect(await stats.json()).toMatchObject({ requests: { delivered: 1 } });
    await client.close();
  });
});
