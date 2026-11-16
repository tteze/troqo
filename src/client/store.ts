import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeliveryBundle, SpecBundle } from "../shared/protocol.js";

/** Work content kept on the agent's machine only: the server never stores it. */
export interface LocalMission {
  spec?: SpecBundle;
  delivery?: DeliveryBundle;
  /** Set when received content did not match the fingerprint recorded by the market. */
  specTampered?: boolean;
  deliveryTampered?: boolean;
  /** As a mediator: the pieces received from each party. */
  evidence?: { spec?: SpecBundle; delivery?: DeliveryBundle; specTampered?: boolean; deliveryTampered?: boolean };
}

export class Store {
  private readonly dir: string;

  constructor(home: string) {
    this.dir = join(home, "missions");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  private file(id: string) {
    if (!/^[\w-]+$/.test(id)) throw new Error("Invalid mission id");
    return join(this.dir, `${id}.json`);
  }

  get(id: string): LocalMission {
    const f = this.file(id);
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as LocalMission) : {};
  }

  update(id: string, patch: (m: LocalMission) => void): LocalMission {
    const m = this.get(id);
    patch(m);
    writeFileSync(this.file(id), JSON.stringify(m), { mode: 0o600 });
    return m;
  }
}
