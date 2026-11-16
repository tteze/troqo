import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import type { CapabilityProvider, CapabilityResult } from "./types.js";

// ---------------------------------------------------------------- mock image

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Deterministic gradient PNG derived from the prompt: no external call, no cost. */
export function placeholderPng(prompt: string, size = 256): Buffer {
  const h = createHash("sha256").update(prompt).digest();
  const [r1, g1, b1, r2, g2, b2] = h;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * size);
      const i = row + 1 + x * 3;
      raw[i] = Math.round(r1 + (r2 - r1) * t);
      raw[i + 1] = Math.round(g1 + (g2 - g1) * t);
      raw[i + 2] = Math.round(b1 + (b2 - b1) * t);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function mockImageProvider(priceCredits = 4): CapabilityProvider {
  return {
    id: "image.mock",
    description: "Placeholder image generator (deterministic gradient PNG). For testing the barter loop at zero cost.",
    priceCredits,
    estimatedCostUsd: 0,
    async execute(prompt): Promise<CapabilityResult> {
      return { mimeType: "image/png", data: placeholderPng(prompt).toString("base64"), costUsd: 0 };
    },
  };
}

// ---------------------------------------------------------------- OpenAI-compatible image API

export interface OpenAIImageOptions {
  apiKey: string;
  /** Defaults to https://api.openai.com/v1 — any OpenAI-compatible endpoint works. */
  baseUrl?: string;
  model?: string;
  size?: string;
  /** Your actual cost per image, used for the spending cap and metrics. */
  costUsd: number;
  priceCredits?: number;
  timeoutMs?: number;
}

export function openAIImageProvider(opts: OpenAIImageOptions): CapabilityProvider {
  const baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const model = opts.model ?? "gpt-image-1";
  return {
    id: "image.generate",
    description: `Text-to-image generation (${model}). Returns a PNG.`,
    priceCredits: opts.priceCredits ?? 4,
    estimatedCostUsd: opts.costUsd,
    async execute(prompt): Promise<CapabilityResult> {
      const res = await fetch(`${baseUrl}/images/generations`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({ model, prompt, size: opts.size ?? "1024x1024", n: 1 }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
      const item = body.data?.[0];
      let data = item?.b64_json;
      if (!data && item?.url) {
        const img = await fetch(item.url, { signal: AbortSignal.timeout(60_000) });
        if (!img.ok) throw new Error(`Image download failed: HTTP ${img.status}`);
        data = Buffer.from(await img.arrayBuffer()).toString("base64");
      }
      if (!data) throw new Error("Provider returned no image");
      return { mimeType: "image/png", data, costUsd: opts.costUsd };
    },
  };
}

/** Builds providers from environment variables. The mock is always available. */
export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): CapabilityProvider[] {
  const providers = [mockImageProvider(Number(env.TROQO_MOCK_PRICE_CREDITS ?? 4))];
  if (env.TROQO_IMAGE_API_KEY) {
    providers.push(
      openAIImageProvider({
        apiKey: env.TROQO_IMAGE_API_KEY,
        baseUrl: env.TROQO_IMAGE_BASE_URL,
        model: env.TROQO_IMAGE_MODEL,
        size: env.TROQO_IMAGE_SIZE,
        costUsd: Number(env.TROQO_IMAGE_COST_USD ?? 0.04),
        priceCredits: env.TROQO_IMAGE_PRICE_CREDITS ? Number(env.TROQO_IMAGE_PRICE_CREDITS) : undefined,
      }),
    );
  }
  return providers;
}
