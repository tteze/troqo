import { describe, expect, it } from "vitest";
import { agentIdFor, generateIdentity, open, seal, signMessage, signRequest, verifyMessage } from "../src/shared/crypto.js";

describe("crypto", () => {
  it("seals content that only the recipient can open", () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const env = seal("secret spec ✓", b.boxPublic);
    expect(open(env, b).toString()).toBe("secret spec ✓");
    expect(() => open(env, a)).toThrow();
    expect(seal("x", b.boxPublic)).not.toBe(seal("x", b.boxPublic));
  });

  it("detects tampered ciphertext", () => {
    const b = generateIdentity();
    const env = Buffer.from(seal("hello", b.boxPublic), "base64url");
    env[env.length - 1] ^= 1;
    expect(() => open(env.toString("base64url"), b)).toThrow();
  });

  it("signs and verifies; ids derive from signing keys", () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const sig = signMessage("m", a);
    expect(verifyMessage("m", sig, a.signPublic)).toBe(true);
    expect(verifyMessage("n", sig, a.signPublic)).toBe(false);
    expect(verifyMessage("m", sig, b.signPublic)).toBe(false);
    expect(a.agentId).toBe(agentIdFor(a.signPublic));
    expect(signRequest(a, "GET", "/v1/account", "")).toHaveProperty("x-troqo-signature");
  });
});
