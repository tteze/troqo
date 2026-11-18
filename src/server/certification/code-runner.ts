import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

/**
 * Runs code written by an agent against hidden tests, isolated in three layers:
 *
 * 1. A separate Node process with the permission model on (`--permission`): no file system, no
 *    child processes, no worker threads, no native addons. It gets an empty environment, a small
 *    heap and is killed after a few seconds.
 * 2. Inside it, the code runs in an empty `vm` context: no `require`, `process`, `fetch`, timers or
 *    any other host object, and string code generation (`eval`, `Function`) is disabled. Test
 *    inputs go in as JSON text and results come out as JSON text, so no object crosses between
 *    the context and the process.
 * 3. Each call has its own time limit.
 *
 * Runs are asynchronous and queued (a few at once), so grading never blocks the server's event loop.
 *
 * `vm` alone is not a security boundary; the process around it is what contains an escape, and it
 * has nothing to reach but the network (which Node's permission model does not restrict). Run the
 * server on a host where outbound connections are firewalled if you enable code certification.
 */

export interface CodeTest {
  args: unknown[];
  out: unknown;
}

const RUNNER = `
const vm = require("node:vm");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const { code, tests } = JSON.parse(input);
  const results = [];
  try {
    const ctx = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
    vm.runInContext(code + "\\n;globalThis.__solve = typeof solve === 'function' ? solve : undefined;", ctx, { timeout: 1000 });
    for (const args of tests) {
      try {
        const call = "JSON.stringify(__solve(...JSON.parse(" + JSON.stringify(JSON.stringify(args)) + ")))";
        const out = vm.runInContext(call, ctx, { timeout: 500 });
        results.push(typeof out === "string" ? out.slice(0, 10000) : null);
      } catch {
        results.push(null);
      }
    }
  } catch {
    // no usable solve(): every result stays missing
  }
  process.stdout.write(JSON.stringify(results));
});
`;

/** Extracts the code from a delivery: the first fenced block if there is one, else the whole text. */
export function extractCode(content: string): string {
  const fence = content.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  return (fence ? fence[1] : content).replace(/^\s*export\s+(default\s+)?/gm, "");
}

/** Runs at once at most; the rest wait in a bounded queue. */
const MAX_PARALLEL = 2;
const MAX_QUEUED = 100;
let running = 0;
const queue: (() => void)[] = [];

/** True when the queue is full: callers should retry later rather than pile up work. */
export function runnerBusy(): boolean {
  return queue.length >= MAX_QUEUED;
}

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((resolve) => queue.push(resolve));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    queue.shift()?.();
  }
}

function runOnce(code: string, tests: unknown[][]): Promise<(string | null)[]> {
  const missing = tests.map(() => null);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--permission", "--max-old-space-size=64", "-e", RUNNER], {
      env: {},
      cwd: tmpdir(),
      stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "";
    let done = false;
    const finish = (v: (string | null)[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(v);
    };
    const timer = setTimeout(() => finish(missing), 4000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      out += d;
      if (out.length > 1_000_000) finish(missing);
    });
    child.on("error", () => finish(missing));
    child.on("close", () => {
      try {
        const r = JSON.parse(out) as (string | null)[];
        finish(Array.isArray(r) && r.length === tests.length ? r : missing);
      } catch {
        finish(missing);
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify({ code: code.slice(0, 50_000), tests }));
  });
}

/** Runs `solve(...args)` for each test; resolves each result as JSON text, or null on error or timeout. */
export function runCode(code: string, tests: unknown[][]): Promise<(string | null)[]> {
  return slot(() => runOnce(code, tests));
}
