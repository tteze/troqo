import { spawn } from "node:child_process";

/**
 * Runs the solver (e.g. `claude -p`) on a prompt read from stdin. With "docker", the process runs in
 * a throwaway container that can only reach the network through an egress proxy allowing the model
 * API, never the local network; it gets no host files except the mounts you list (read-only).
 */
export interface DockerSandbox {
  /** Image with the solver CLI installed (see deploy/Dockerfile.solver). */
  image: string;
  /** Internal Docker network with no route out except the egress proxy. */
  network: string;
  /** Egress proxy URL on that network. */
  proxy: string;
  memory: string;
  cpus: string;
  /** host:container[:ro] — e.g. the solver's credentials. Always mounted read-only. */
  mounts: string[];
  /** Names of environment variables passed through (e.g. ANTHROPIC_API_KEY). */
  env: string[];
}

export interface SolverConfig {
  command: string[];
  sandbox: "docker" | "none";
  docker?: Partial<DockerSandbox>;
  timeoutSeconds?: number;
}

export const DEFAULT_DOCKER: DockerSandbox = {
  image: "troqo-solver",
  network: "troqo-sandbox",
  proxy: "http://troqo-egress:3128",
  memory: "1g",
  cpus: "1",
  mounts: [],
  env: [],
};

export function dockerArgs(command: string[], options: Partial<DockerSandbox> = {}): string[] {
  const o = { ...DEFAULT_DOCKER, ...options };
  const args = [
    "run", "--rm", "-i",
    "--network", o.network,
    "--read-only",
    "--tmpfs", "/tmp:rw,size=256m",
    "--tmpfs", "/home/solver:rw,size=256m,uid=1000,gid=1000",
    "--memory", o.memory,
    "--cpus", o.cpus,
    "--pids-limit", "256",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--user", "1000:1000",
    "-e", "HOME=/home/solver",
    "-e", `HTTPS_PROXY=${o.proxy}`,
    "-e", `HTTP_PROXY=${o.proxy}`,
    "-e", "NO_PROXY=",
  ];
  for (const m of o.mounts) {
    const [host, container] = m.split(":");
    if (!host || !container) throw new Error(`Invalid mount "${m}": expected host:container`);
    args.push("-v", `${host}:${container}:ro`);
  }
  for (const name of o.env) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error(`Invalid env var name "${name}"`);
    args.push("-e", name);
  }
  args.push(o.image, ...command);
  return args;
}

/** Commands that create the isolated network and the egress proxy. Run once per machine. */
export function sandboxSetupCommands(allowHosts: string[], options: Partial<DockerSandbox> = {}): string[][] {
  const o = { ...DEFAULT_DOCKER, ...options };
  return [
    ["docker", "network", "create", "--internal", o.network],
    [
      "docker", "run", "-d", "--name", "troqo-egress", "--restart", "unless-stopped",
      "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      o.image, "troqo", "egress-proxy", "--port", "3128", "--allow", allowHosts.join(","),
    ],
    ["docker", "network", "connect", o.network, "troqo-egress"],
  ];
}

export function runSolver(solver: SolverConfig, prompt: string): Promise<string> {
  const [cmd, ...args] =
    solver.sandbox === "docker" ? ["docker", ...dockerArgs(solver.command, solver.docker)] : solver.command;
  const timeoutMs = (solver.timeoutSeconds ?? 600) * 1000;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Solver timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      out += d;
      if (out.length > 5_000_000) child.kill("SIGKILL");
    });
    child.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`Solver exited with ${code}: ${err.trim().slice(-500)}`));
    });
    child.stdin.end(prompt);
  });
}
