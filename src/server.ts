import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { TroqoError, type SubmitOutcome, type Troqo } from "./engine.js";
import type { RequestView } from "./types.js";

export const VERSION = "0.1.0";

/** Resolves which agent is calling. stdio: a fixed id; HTTP: derived from the bearer token. */
export type AgentResolver = (extra: { authInfo?: { clientId?: string } }) => string;

export interface ServerOptions {
  /** If set, delivered results also include a URL: `${publicUrl}/results/<id>`. */
  publicUrl?: string;
}

const text = (s: string) => ({ type: "text" as const, text: s });

function failure(err: unknown): CallToolResult {
  if (err instanceof TroqoError) return { isError: true, content: [text(`${err.code}: ${err.message}`)] };
  return { isError: true, content: [text(`internal_error: ${(err as Error).message}`)] };
}

function describeTasks(request: RequestView, ttlMinutes: number): string {
  return [
    `Request ${request.requestId} for "${request.capability}" is waiting for your work.`,
    `Complete the ${request.tasks.length} micro-tasks below, then call submit_tasks with one answer per task.`,
    `Each answer must be exactly one of the task's options. Some tasks are quality checks:`,
    `answer every task carefully — a wrong check answer rejects the whole batch and grants no credits.`,
    `If the user has not yet agreed in this conversation to spend tokens on Troqo micro-tasks, ask them and wait`,
    `for their answer before doing the work.`,
    `The request expires ${ttlMinutes} minutes after creation; call cancel_request if you give up.`,
    "",
    JSON.stringify(request.tasks, null, 2),
  ].join("\n");
}

function deliveredContent(
  outcome: SubmitOutcome | { result: { resultId: string; mimeType: string; data: string } },
  summary: string,
  opts: ServerOptions,
): CallToolResult {
  const r = outcome.result!;
  const url = opts.publicUrl ? `${opts.publicUrl.replace(/\/$/, "")}/results/${r.resultId}` : undefined;
  return {
    content: [
      text(summary + (url ? `\nResult URL: ${url}` : "")),
      { type: "image", data: r.data, mimeType: r.mimeType },
    ],
  };
}

function outcomeContent(outcome: SubmitOutcome, opts: ServerOptions): CallToolResult {
  const checks = `Quality checks: ${outcome.goldCorrect}/${outcome.goldTotal} correct.`;
  if (outcome.status === "delivered") {
    return deliveredContent(
      outcome,
      `Delivered. ${checks} Credits earned: ${outcome.creditsEarned}, balance after payment: ${outcome.creditsBalance}.`,
      opts,
    );
  }
  return {
    isError: outcome.status !== "rejected" ? true : undefined,
    content: [text(`Status: ${outcome.status}. ${checks} ${outcome.error ?? ""} Balance: ${outcome.creditsBalance}.`)],
  };
}

export function buildServer(engine: Troqo, resolveAgent: AgentResolver, opts: ServerOptions = {}): McpServer {
  const ttl = engine.config.requestTtlMinutes;
  const server = new McpServer(
    { name: "troqo", version: VERSION },
    {
      instructions:
        "Troqo lets you obtain capabilities you lack (e.g. image generation) by completing small, verifiable " +
        "micro-tasks instead of paying money. Call list_capabilities, then request_capability, complete the " +
        "returned tasks and call submit_tasks. Doing the tasks consumes some of the user's tokens: the first time in " +
          "a conversation, ask the user for permission and wait for their answer before doing any task.",
    },
  );

  server.registerTool(
    "list_capabilities",
    {
      title: "List capabilities",
      description: "Lists capabilities available through Troqo, with their price in micro-tasks.",
      annotations: { readOnlyHint: true },
    },
    async () => ({ content: [text(JSON.stringify(engine.listCapabilities(), null, 2))] }),
  );

  server.registerTool(
    "request_capability",
    {
      title: "Request a capability",
      description:
        "Asks for a capability (e.g. image generation). If you already hold enough credits it is delivered " +
        "immediately; otherwise you receive a batch of micro-tasks to complete with submit_tasks.",
      inputSchema: {
        capability: z.string().describe("Capability id from list_capabilities, e.g. image.mock"),
        prompt: z.string().describe("What to produce, e.g. the image description"),
      },
    },
    async ({ capability, prompt }, extra) => {
      try {
        const { request, outcome } = await engine.requestCapability(resolveAgent(extra), capability, prompt);
        if (outcome) return outcomeContent(outcome, opts);
        return { content: [text(describeTasks(request, ttl))] };
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "submit_tasks",
    {
      title: "Submit completed micro-tasks",
      description:
        "Submits answers for every task of a request. If quality checks pass, credits are granted and the " +
        "capability is executed; the result is returned.",
      inputSchema: {
        request_id: z.string(),
        answers: z
          .array(z.object({ task_id: z.string(), answer: z.string() }))
          .describe("One entry per task, answer exactly one of its options"),
      },
    },
    async ({ request_id, answers }, extra) => {
      try {
        const outcome = await engine.submitTasks(
          resolveAgent(extra),
          request_id,
          answers.map((a) => ({ taskId: a.task_id, answer: a.answer })),
        );
        return outcomeContent(outcome, opts);
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "get_request",
    {
      title: "Get a request",
      description: "Returns a request's status, its pending tasks, or its result if delivered.",
      inputSchema: { request_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ request_id }, extra) => {
      try {
        const request = engine.getRequest(resolveAgent(extra), request_id);
        if (request.status === "awaiting_work") return { content: [text(describeTasks(request, ttl))] };
        const result = request.resultId ? engine.getResult(request.resultId) : undefined;
        if (request.status === "delivered" && result) {
          return deliveredContent(
            { result: { resultId: request.resultId!, ...result } },
            `Request ${request_id} was delivered.`,
            opts,
          );
        }
        return { content: [text(`Request ${request_id}: ${request.status}. ${request.error ?? ""}`)] };
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "cancel_request",
    {
      title: "Cancel a request",
      description:
        "Cancels a request you no longer want to complete, freeing one of your open-request slots. " +
        "Its tasks will not be offered to you again.",
      inputSchema: { request_id: z.string() },
    },
    async ({ request_id }, extra) => {
      try {
        engine.cancelRequest(resolveAgent(extra), request_id);
        return { content: [text(`Request ${request_id} cancelled.`)] };
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "get_account",
    {
      title: "Get account",
      description: "Returns your credit balance and quality reputation.",
      annotations: { readOnlyHint: true },
    },
    async (extra) => ({ content: [text(JSON.stringify(engine.account(resolveAgent(extra)), null, 2))] }),
  );

  return server;
}
