import { signBoxKey, signRequest, type Identity } from "../shared/crypto.js";
import { TroqoError } from "../shared/errors.js";
import { solvePow, type PowChallenge } from "../shared/pow.js";

/** Signed calls to a Troqo market server. Registers the agent's public keys on first use. */
export class Api {
  private registered = false;
  /** Basic Auth in front of the server (a closed beta), from credentials in the server URL. */
  private readonly basic: Record<string, string> = {};

  constructor(
    readonly server: string,
    private readonly id: Identity,
  ) {
    const url = new URL(server);
    if (url.username) {
      const user = decodeURIComponent(url.username);
      const pass = decodeURIComponent(url.password);
      this.basic = { authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` };
      url.username = "";
      url.password = "";
    }
    this.server = url.toString().replace(/\/+$/, "");
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

  /** Registers the public keys, with the proof of work the market asks for (about 2 seconds, once). */
  async register() {
    for (let attempt = 0; ; attempt++) {
      const challenge = await this.get<PowChallenge>("/v1/pow");
      const pow = await solvePow(this.id.signPublic, challenge);
      try {
        await this.raw("POST", "/v1/register", {
          signPublic: this.id.signPublic,
          boxPublic: this.id.boxPublic,
          boxSignature: signBoxKey(this.id),
          pow,
        });
        break;
      } catch (err) {
        // The difficulty rose while we were working: solve again.
        if (!(err instanceof TroqoError && err.code === "pow_required" && attempt < 2)) throw err;
      }
    }
    this.registered = true;
  }

  /** Public, unsigned GET. */
  async get<T>(path: string): Promise<T> {
    const res = await fetch(this.server + path, { headers: this.basic });
    return this.parse<T>(res);
  }

  private async raw<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const text = method === "POST" ? JSON.stringify(body ?? {}) : "";
    const res = await fetch(this.server + path, {
      method,
      headers: { "content-type": "application/json", ...this.basic, ...signRequest(this.id, method, path, text) },
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
