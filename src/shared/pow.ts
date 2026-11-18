import { scrypt as scryptCb, scryptSync } from "node:crypto";
import { promisify } from "node:util";

/**
 * Proof of work paid once per identity, at registration. It is bound to the signing key, so a
 * solution cannot be reused for another identity. scrypt makes it memory-bound: an attacker gains
 * little from a GPU. With the default cost (4096) and 8 bits, it takes about 2 seconds on average on one core.
 */

export interface PowChallenge {
  /** Leading zero bits required in scrypt(signPublic:nonce). */
  bits: number;
  /** scrypt cost parameter N (r = 8, p = 1). */
  cost: number;
}

const SALT = "troqo-pow-v1";
const scrypt = promisify(scryptCb) as (pw: string, salt: string, len: number, opts: object) => Promise<Buffer>;

const opts = (cost: number) => ({ N: cost, r: 8, p: 1, maxmem: 256 * cost * 8 + 1024 * 1024 });

export function leadingZeroBits(buf: Buffer): number {
  let n = 0;
  for (const byte of buf) {
    if (byte === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(byte) - 24;
  }
  return n;
}

export function verifyPow(signPublic: string, nonce: string, c: PowChallenge): boolean {
  if (c.bits <= 0) return true;
  if (typeof nonce !== "string" || !/^[0-9a-z]{1,16}$/.test(nonce)) return false;
  return leadingZeroBits(scryptSync(`${signPublic}:${nonce}`, SALT, 32, opts(c.cost))) >= c.bits;
}

/** Finds a nonce. Asynchronous, so an MCP server keeps answering while it works. */
export async function solvePow(signPublic: string, c: PowChallenge): Promise<string> {
  for (let i = 0; ; i++) {
    const nonce = i.toString(36);
    if (c.bits <= 0) return nonce;
    const h = await scrypt(`${signPublic}:${nonce}`, SALT, 32, opts(c.cost));
    if (leadingZeroBits(h) >= c.bits) return nonce;
  }
}
