import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { evaluate, PROBE, probeInput, type ProbeReport } from "../src/client/sandbox-check.js";

const input = probeInput(["api.anthropic.com"], { relay: ["anthropic"] });

const sealed: ProbeReport = {
  uid: 1000,
  capEff: "0000000000000000",
  rootWritable: false,
  tmpWritable: true,
  dockerSocket: false,
  secrets: [],
  proxy: {
    "api.anthropic.com:443": "200",
    ...Object.fromEntries(input.forbiddenViaProxy.map((t) => [t, "403"])),
  },
  relay: { anthropic: "200" },
  direct: Object.fromEntries(input.forbiddenDirect.map((t) => [t, "ENETUNREACH"])),
};

describe("sandbox check", () => {
  it("passes a sealed container", () => {
    const r = evaluate(sealed, input);
    expect(r.filter((x) => !x.ok)).toEqual([]);
    expect(r.map((x) => x.name)).toContain("API relay: anthropic");
  });

  it("flags every way out and every leak", () => {
    const leaky: ProbeReport = {
      ...sealed,
      uid: 0,
      rootWritable: true,
      secrets: ["ANTHROPIC_API_KEY"],
      proxy: { ...sealed.proxy, "example.com:443": "200" },
      relay: { anthropic: "401" },
      direct: { ...sealed.direct, "192.168.1.1:80": "open" },
    };
    const failed = evaluate(leaky, input).filter((x) => !x.ok).map((x) => x.name);
    expect(failed).toEqual([
      "Unprivileged user",
      "Read-only file system",
      "No secret in the environment",
      "Blocked: example.com:443 through the proxy",
      "API relay: anthropic",
      "Blocked: direct connection to 192.168.1.1:80",
    ]);
  });

  it("runs as plain Node and reports in the expected shape", () => {
    // Outside a container nothing is sealed, but the probe must run and print its report.
    const small = { allowed: [], forbiddenViaProxy: [], forbiddenDirect: ["127.0.0.1:1"], relays: {} };
    const r = spawnSync(process.execPath, ["-e", PROBE, JSON.stringify(small)], {
      encoding: "utf8",
      env: { HTTPS_PROXY: "http://127.0.0.1:1", PATH: process.env.PATH, SOME_TOKEN: "abc" },
      timeout: 20_000,
    });
    const report = JSON.parse(r.stdout.trim()) as ProbeReport;
    expect(report.direct["127.0.0.1:1"]).not.toBe("open");
    expect(report.secrets).toContain("SOME_TOKEN");
    expect(typeof report.uid).toBe("number");
  });
});
