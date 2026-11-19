/**
 * Renders the site's diagrams (site/diagrams/*.mmd, Mermaid) to static SVG, once, in a light and a dark
 * version: the pages then show plain images instead of loading Mermaid (3.3 MB of JavaScript) in every
 * visitor's browser. Run it after changing a diagram and commit the SVG files:
 *
 *   node scripts/render-diagrams.mjs            # needs Google Chrome or Chromium
 *
 * Mermaid is fetched at a pinned version and checked against its hash before it runs.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MERMAID = "https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js";
const MERMAID_SHA384 = "WmdflGW9aGfoBdHc4rRyWzYuAjEmDwMdGdiPNacbwfGKxBW/SO6guzuQ76qjnSlr";
const DIR = "site/diagrams";
// Labels are plain SVG text (no HTML inside foreignObject), so the files are valid standalone images.
// SVG shown as an image cannot load web fonts: a font with the same metrics everywhere keeps labels in their boxes.
const FONT = "Arial, Helvetica, sans-serif";

const chrome = ["google-chrome", "chromium", "chromium-browser"].find((c) => {
  try {
    execFileSync(c, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
});
if (!chrome) throw new Error("Google Chrome or Chromium is needed to render the diagrams");

const lib = Buffer.from(await (await fetch(MERMAID)).arrayBuffer());
if (createHash("sha384").update(lib).digest("base64") !== MERMAID_SHA384) throw new Error("Mermaid does not match its pinned hash");

const work = mkdtempSync(join(tmpdir(), "troqo-diagrams-"));
const sources = readdirSync(DIR).filter((f) => f.endsWith(".mmd"));
const jobs = sources.flatMap((f) => ["light", "dark"].map((theme) => ({ name: f.replace(/\.mmd$/, ""), theme, code: readFileSync(join(DIR, f), "utf8") })));
writeFileSync(join(work, "mermaid.min.js"), lib);
writeFileSync(
  join(work, "index.html"),
  `<!doctype html><meta charset="utf-8"><body><script src="mermaid.min.js"></script><script>
  const jobs = ${JSON.stringify(jobs)};
  (async () => {
    for (const [i, j] of jobs.entries()) {
      mermaid.initialize({ startOnLoad: false, theme: j.theme === "dark" ? "dark" : "neutral", fontFamily: ${JSON.stringify(FONT)}, securityLevel: "strict", htmlLabels: false, flowchart: { htmlLabels: false } });
      const { svg } = await mermaid.render("d" + i, j.code);
      const out = document.createElement("textarea");
      out.id = "out" + i;
      out.textContent = svg;
      document.body.append(out);
    }
    document.body.dataset.done = "1";
  })();
  </script>`,
);
const dom = execFileSync(
  chrome,
  ["--headless=new", "--disable-gpu", "--no-sandbox", "--allow-file-access-from-files", "--virtual-time-budget=20000", "--dump-dom", `file://${join(work, "index.html")}`],
  { maxBuffer: 64 * 1024 * 1024 },
).toString();
rmSync(work, { recursive: true, force: true });
if (!dom.includes('data-done="1"')) throw new Error("Mermaid did not finish rendering");

const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
for (const [i, j] of jobs.entries()) {
  const m = dom.match(new RegExp(`<textarea id="out${i}">([\\s\\S]*?)</textarea>`));
  if (!m) throw new Error(`No output for ${j.name} (${j.theme})`);
  // A standalone file: Mermaid's inline style element stays (it is inside the SVG), its max-width does not.
  const svg = unescape(m[1]).replace(/ style="max-width: [^"]*"/, "");
  writeFileSync(join(DIR, `${j.name}-${j.theme}.svg`), svg);
  console.log(`${DIR}/${j.name}-${j.theme}.svg  ${(svg.length / 1024).toFixed(1)} KB`);
}
