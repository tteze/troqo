import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import type { DeliveryBundle, SpecBundle } from "../shared/protocol.js";

/**
 * A capability answers missions of one kind without an LLM solver, e.g. image generation through
 * an API. This is how an operator acts as a market maker: an ordinary worker, an ordinary peer.
 */
export interface Capability {
  kind: string;
  execute(spec: SpecBundle): Promise<DeliveryBundle>;
}

export interface ImageCapabilityConfig {
  /** "openai" (any OpenAI-compatible images API) or "mock" (deterministic placeholder PNG). */
  provider: "openai" | "mock";
  apiKeyEnv?: string;
  baseUrl?: string;
  model?: string;
  size?: string;
}

export function imageCapability(cfg: ImageCapabilityConfig): Capability {
  if (cfg.provider === "mock") {
    return { kind: "image", execute: async (spec) => ({ mime: "image/png", content: placeholderPng(spec.spec) }) };
  }
  const key = process.env[cfg.apiKeyEnv ?? "TROQO_IMAGE_API_KEY"];
  if (!key) throw new Error(`Set ${cfg.apiKeyEnv ?? "TROQO_IMAGE_API_KEY"} to serve image missions`);
  const base = (cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  return {
    kind: "image",
    async execute(spec) {
      const res = await fetch(`${base}/images/generations`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: cfg.model ?? "gpt-image-1", prompt: spec.spec.slice(0, 4000), size: cfg.size ?? "1024x1024", n: 1 }),
      });
      if (!res.ok) throw new Error(`Image API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
      const item = json.data?.[0];
      if (item?.b64_json) return { mime: "image/png", content: item.b64_json };
      if (item?.url) {
        const img = await fetch(item.url);
        return { mime: img.headers.get("content-type") ?? "image/png", content: Buffer.from(await img.arrayBuffer()).toString("base64") };
      }
      throw new Error("Image API returned no image");
    },
  };
}

/** Deterministic 64x64 gradient PNG derived from the prompt. For tests and demos. */
export function placeholderPng(seed: string): string {
  const h = createHash("sha256").update(seed).digest();
  const size = 64;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const i = y * (size * 3 + 1) + 1 + x * 3;
      raw[i] = (h[0] + x * 3) & 255;
      raw[i + 1] = (h[1] + y * 3) & 255;
      raw[i + 2] = (h[2] + x + y) & 255;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}
