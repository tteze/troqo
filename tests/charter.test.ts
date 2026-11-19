import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { CHARTER_VERSION, MEDIATION_RULES, MODERATION_RULES } from "../src/shared/charter.js";
import { mediationPrompt, moderationPrompt } from "../src/client/prompts.js";
import { market, type TestMarket } from "./helpers.js";

let m: TestMarket;
afterEach(() => m?.close());

const doc = readFileSync("docs/CHARTER.md", "utf8");
const plain = (s: string) => s.replace(/\*\*/g, "").replace(/\s+/g, " ").toLowerCase();

describe("the charter", () => {
  it("says the same thing in the document and in the rules agents receive", () => {
    expect(doc).toContain(`Version \`${CHARTER_VERSION}\``);
    for (const [id, rule] of [...MEDIATION_RULES, ...MODERATION_RULES]) {
      const row = doc.split("\n").find((l) => l.startsWith(`| **${id}** |`));
      expect(row, id).toBeDefined();
      // Same rule, up to the capital and the quoted example the agents' version adds.
      const core = rule.split(", e.g.")[0].replace(/\.$/, "").replace(/^REFUSE|^ACCEPT|^REMOVE|^KEEP/, (w) => w.toLowerCase());
      expect(plain(row!), id).toContain(plain(core).slice(0, 60));
    }
  });

  it("goes to mediators and moderators with each case, and is served at /charter.md", async () => {
    const spec = { spec: "s", acceptance: "a" };
    expect(mediationPrompt({ kind: "code", title: "t", contestReason: "r", spec, delivery: { mime: "text/plain", content: "d" } })).toContain("M4.");
    expect(moderationPrompt({ kind: "code", title: "t", summary: "s", reason: "" })).toContain("P3.");
    m = await market();
    const res = await fetch(`${m.url}/charter.md`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("# The Troqo charter");
  });
});

describe("the charter page", () => {
  it("is rendered on the site from the same Markdown, escaped", async () => {
    m = await market();
    const html = await (await fetch(`${m.url}/charter`)).text();
    expect(html).toContain("<title>The Troqo charter: rules for mediation and moderation</title>");
    expect(html).toContain('<h1 id="the-troqo-charter">The Troqo charter</h1>');
    for (const [id] of [...MEDIATION_RULES, ...MODERATION_RULES]) expect(html).toContain(`<td><strong>${id}</strong></td>`);
    expect(html).toContain('href="#changing-the-charter"');
    expect(html).toContain('href="https://github.com/tteze/troqo/blob/main/docs/TECHNICAL.md"');
  });

  it("has a sibling: the contribute page, rendered from docs/CONTRIBUTING.md", async () => {
    m = await market();
    const html = await (await fetch(`${m.url}/contribute`)).text();
    expect(html).toContain("<title>Contribute to Troqo</title>");
    expect(html).toContain('<h1 id="contributing-to-troqo">Contributing to Troqo</h1>');
    expect(html).toContain("<pre><code>git clone");
    expect(html).not.toContain("<!-- MARKDOWN -->");
  });

  it("never lets the Markdown inject HTML", async () => {
    const { renderMarkdown } = await import("../src/server/markdown.js");
    const out = renderMarkdown('# Title <script>alert(1)</script>\n\nText with <img src=x onerror=alert(1)> and [a](javascript:alert(1)).\n\n| a | b |\n| --- | --- |\n| <b>x</b> | **y** |');
    expect(out).not.toMatch(/<script|<img|<b>/);
    expect(renderMarkdown("```\n<script>x</script>\n```")).toBe("<pre><code>&lt;script&gt;x&lt;/script&gt;</code></pre>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain('href="javascript:');
  });
});
