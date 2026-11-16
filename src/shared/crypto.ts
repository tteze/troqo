import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign as edSign,
  verify as edVerify,
} from "node:crypto";

/**
 * An agent's identity: an Ed25519 key pair to sign requests and an X25519 key pair to receive
 * encrypted content. Private keys never leave the agent's machine; the server only sees public keys.
 * All keys are raw 32-byte values encoded in base64url (JWK "x" and "d").
 */
export interface Identity {
  agentId: string;
  signPublic: string;
  signPrivate: string;
  boxPublic: string;
  boxPrivate: string;
}

export interface PublicKeys {
  agentId: string;
  signPublic: string;
  boxPublic: string;
}

const b64 = (b: Buffer) => b.toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url");

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Public id of an agent: derived from its signing key, so nobody can claim someone else's id. */
export function agentIdFor(signPublic: string): string {
  return `ag_${sha256(unb64(signPublic)).slice(0, 24)}`;
}

export function generateIdentity(): Identity {
  const s = generateKeyPairSync("ed25519");
  const x = generateKeyPairSync("x25519");
  const sj = s.privateKey.export({ format: "jwk" }) as { x: string; d: string };
  const xj = x.privateKey.export({ format: "jwk" }) as { x: string; d: string };
  return { agentId: agentIdFor(sj.x), signPublic: sj.x, signPrivate: sj.d, boxPublic: xj.x, boxPrivate: xj.d };
}

const okp = (crv: "Ed25519" | "X25519", x: string, d?: string) =>
  d
    ? createPrivateKey({ key: { kty: "OKP", crv, x, d }, format: "jwk" })
    : createPublicKey({ key: { kty: "OKP", crv, x }, format: "jwk" });

export function isPublicKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function signMessage(message: string, id: Pick<Identity, "signPublic" | "signPrivate">): string {
  return b64(edSign(null, Buffer.from(message), okp("Ed25519", id.signPublic, id.signPrivate)));
}

export function verifyMessage(message: string, signature: string, signPublic: string): boolean {
  try {
    return edVerify(null, Buffer.from(message), okp("Ed25519", signPublic), unb64(signature));
  } catch {
    return false;
  }
}

const SEAL_VERSION = 1;

/**
 * Encrypts for one recipient (ECIES): ephemeral X25519 key, HKDF-SHA256, AES-256-GCM.
 * Layout: version(1) | ephemeral public key(32) | iv(12) | tag(16) | ciphertext.
 */
export function seal(plaintext: Buffer | string, recipientBoxPublic: string): string {
  const eph = generateKeyPairSync("x25519");
  const ephPub = unb64((eph.publicKey.export({ format: "jwk" }) as { x: string }).x);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: okp("X25519", recipientBoxPublic) });
  const key = Buffer.from(
    hkdfSync("sha256", shared, Buffer.concat([ephPub, unb64(recipientBoxPublic)]), "troqo-seal-v1", 32),
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(typeof plaintext === "string" ? Buffer.from(plaintext) : plaintext), cipher.final()]);
  return b64(Buffer.concat([Buffer.from([SEAL_VERSION]), ephPub, iv, cipher.getAuthTag(), body]));
}

export function open(envelope: string, id: Pick<Identity, "boxPublic" | "boxPrivate">): Buffer {
  const raw = unb64(envelope);
  if (raw.length < 61 || raw[0] !== SEAL_VERSION) throw new Error("Not a Troqo envelope");
  const ephPub = raw.subarray(1, 33);
  const iv = raw.subarray(33, 45);
  const tag = raw.subarray(45, 61);
  const shared = diffieHellman({
    privateKey: okp("X25519", id.boxPublic, id.boxPrivate),
    publicKey: okp("X25519", b64(ephPub)),
  });
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.concat([ephPub, unb64(id.boxPublic)]), "troqo-seal-v1", 32));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(raw.subarray(61)), decipher.final()]);
}

/** The string an agent signs for each API request. */
export function requestSigningString(method: string, path: string, timestamp: string, nonce: string, body: string) {
  return [method.toUpperCase(), path, timestamp, nonce, sha256(body)].join("\n");
}

export const HEADERS = {
  agent: "x-troqo-agent",
  timestamp: "x-troqo-timestamp",
  nonce: "x-troqo-nonce",
  signature: "x-troqo-signature",
} as const;

export function signRequest(id: Identity, method: string, path: string, body: string): Record<string, string> {
  const timestamp = new Date().toISOString();
  const nonce = randomBytes(12).toString("base64url");
  return {
    [HEADERS.agent]: id.agentId,
    [HEADERS.timestamp]: timestamp,
    [HEADERS.nonce]: nonce,
    [HEADERS.signature]: signMessage(requestSigningString(method, path, timestamp, nonce, body), id),
  };
}
