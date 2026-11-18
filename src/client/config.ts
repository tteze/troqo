import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateIdentity, type Identity } from "../shared/crypto.js";
import type { WorkerConfig } from "./worker.js";

/** Everything local lives in TROQO_HOME (default ~/.troqo): keys, settings and work content. */
export interface ClientConfig {
  server: string;
  worker?: WorkerConfig;
}

export const DEFAULT_SERVER = "https://troqo.dev";

export function troqoHome(): string {
  return process.env.TROQO_HOME ?? join(homedir(), ".troqo");
}

function writePrivate(file: string, data: string) {
  writeFileSync(file, data, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Loads the agent's identity, creating one on first use. The private keys never leave this folder. */
export function loadIdentity(home = troqoHome()): Identity {
  const file = join(home, "identity.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as Identity;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const id = generateIdentity();
  writePrivate(file, JSON.stringify(id, null, 2));
  return id;
}

export function loadConfig(home = troqoHome()): ClientConfig {
  const file = join(home, "config.json");
  const fromFile = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Partial<ClientConfig>) : {};
  return { server: process.env.TROQO_SERVER ?? fromFile.server ?? DEFAULT_SERVER, worker: fromFile.worker };
}

export function saveConfig(config: ClientConfig, home = troqoHome()) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writePrivate(join(home, "config.json"), JSON.stringify(config, null, 2));
}
