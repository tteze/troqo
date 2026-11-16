import { signRequest, type Identity } from "../shared/crypto.js";
import { TroqoError } from "../shared/errors.js";

/** Signed calls to a Troqo market server. Registers the agent's public keys on first use. */
export class Api {
  private registered = false;

  constructor(
    readonly server: string,
    private readonly id: Identity,
  ) {
    this.server = server.replace(/\/+$/, "");
  }

  async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    try {
      return await this.raw<T>(method, path, body);
    } catch (err) {
      if (err instanceof TroqoError && err.code === "unknown_agent" && !this.registered) {
        await this.register();
        return this.raw<T>(method, path, body);
      }
      throw err;
    }
  }

  async register() {
    await this.raw("POST", "/v1/register", { signPublic: this.id.signPublic, boxPublic: this.id.boxPublic });
    this.registered = true;
  }

  /** Public, unsigned GET. */
  async get<T>(path: string): Promise<T> {
    const res = await fetch(this.server + path);
    return this.parse<T>(res);
  }

  private async raw<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const text = method === "POST" ? JSON.stringify(body ?? {}) : "";
    const res = await fetch(this.server + path, {
      method,
      headers: { "content-type": "application/json", ...signRequest(this.id, method, path, text) },
      body: method === "POST" ? text : undefined,
    });
    return this.parse<T>(res);
  }

  private async parse<T>(res: Response): Promise<T> {
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new TroqoError("bad_response", `Server answered ${res.status} with non-JSON content`);
    }
    if (!res.ok) {
      const e = data as { error?: string; message?: string };
      throw new TroqoError(e.error ?? `http_${res.status}`, e.message ?? `HTTP ${res.status}`);
    }
    return data as T;
  }
}
