import type { ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

/**
 * Sending the website and API bodies: compressed when the client accepts it, with an ETag so a browser
 * that already has a file gets a 304 instead of the file again.
 */

const COMPRESSIBLE = /^(text\/|application\/(json|xml|javascript)|image\/svg\+xml)/;
/** Below this, compressing costs more than it saves. */
const MIN_COMPRESS = 1024;

type Encoding = "br" | "gzip";

function encodingFor(res: ServerResponse): Encoding | null {
  const accept = String(res.req?.headers["accept-encoding"] ?? "");
  if (/\bbr\b/.test(accept)) return "br";
  if (/\bgzip\b/.test(accept)) return "gzip";
  return null;
}

function compress(body: Buffer, encoding: Encoding, best: boolean): Buffer {
  return encoding === "br"
    ? brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: best ? 11 : 4, [constants.BROTLI_PARAM_SIZE_HINT]: body.length } })
    : gzipSync(body, { level: best ? 9 : 6 });
}

/** A body that does not change between requests (a file, a rendered page): hashed and compressed once. */
export interface StaticBody {
  body: Buffer;
  etag: string;
  encoded: Partial<Record<Encoding, Buffer>>;
}

export function staticBody(body: Buffer | string): StaticBody {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return { body: buf, etag: `"${createHash("sha256").update(buf).digest("base64url").slice(0, 22)}"`, encoded: {} };
}

/** Sends a static body: 304 when the client has it, else compressed (best level, computed once) if worth it. */
export function replyStatic(res: ServerResponse, s: StaticBody, headers: Record<string, string>) {
  const type = headers["content-type"] ?? "";
  const h: Record<string, string> = { ...headers, etag: s.etag };
  const compressible = COMPRESSIBLE.test(type) && s.body.length >= MIN_COMPRESS;
  if (compressible) h.vary = "Accept-Encoding";
  const match = String(res.req?.headers["if-none-match"] ?? "");
  if (match && match.split(",").some((t) => t.trim().replace(/^W\//, "") === s.etag)) {
    res.writeHead(304, h).end();
    return;
  }
  let out = s.body;
  const enc = compressible ? encodingFor(res) : null;
  if (enc) {
    out = s.encoded[enc] ??= compress(s.body, enc, true);
    h["content-encoding"] = enc;
  }
  h["content-length"] = String(out.length);
  res.writeHead(200, h).end(res.req?.method === "HEAD" ? undefined : out);
}

/** Sends a dynamic body (an API answer), compressed quickly when it is large enough to be worth it. */
export function replyDynamic(res: ServerResponse, status: number, body: string, headers: Record<string, string>) {
  let out: Buffer | string = body;
  const h = { ...headers };
  if (body.length >= MIN_COMPRESS && COMPRESSIBLE.test(h["content-type"] ?? "")) {
    h.vary = "Accept-Encoding";
    const enc = encodingFor(res);
    if (enc) {
      out = compress(Buffer.from(body), enc, false);
      h["content-encoding"] = enc;
    }
  }
  res.writeHead(status, h).end(out);
}
