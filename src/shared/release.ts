import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Signed releases. The maintainer keeps an Ed25519 release key away from the server; every published
 * package is signed with it, and the public key is published in the repository (RELEASE_PUBLIC_KEY
 * below and docs/release-public.pem). A compromised server can replace troqo.tgz but cannot sign it.
 *
 * Anyone can check a download without trusting the package itself, with OpenSSL 3:
 *   openssl pkeyutl -verify -pubin -inkey release-public.pem -rawin -in troqo.tgz -sigfile troqo.tgz.sig
 */

/** The maintainer's release public key (PEM). Empty until the first signed release. */
export const RELEASE_PUBLIC_KEY = "";

export function generateReleaseKey(dir: string): { privateFile: string; publicFile: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateFile = join(dir, "release-private.pem");
  const publicFile = join(dir, "release-public.pem");
  writeFileSync(privateFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  writeFileSync(publicFile, publicKey.export({ type: "spki", format: "pem" }));
  return { privateFile, publicFile };
}

/** Signs a file; writes `<file>.sig` (raw Ed25519 signature, as OpenSSL expects). */
export function signRelease(file: string, privateKeyPem: string): string {
  const signature = sign(null, readFileSync(file), createPrivateKey(privateKeyPem));
  writeFileSync(`${file}.sig`, signature);
  return `${file}.sig`;
}

export function verifyRelease(file: string, signatureFile: string, publicKeyPem = RELEASE_PUBLIC_KEY): boolean {
  if (!publicKeyPem) throw new Error("No release public key: pass --key release-public.pem");
  try {
    return verify(null, readFileSync(file), createPublicKey(publicKeyPem), readFileSync(signatureFile));
  } catch {
    return false;
  }
}
