/**
 * A small Markdown renderer for the site's pages written in Markdown (the charter): headings,
 * paragraphs, lists, tables, bold, inline code and links. Everything is escaped first, so the
 * source cannot inject HTML. Not a general Markdown implementation.
 */

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Links to repository files (CHARTER.md, TECHNICAL.md) point to GitHub; absolute and anchor links stay. */
function href(url: string, repoBase: string): string {
  if (/^(https?:|\/|#)/.test(url)) return url;
  return `${repoBase}/${url}`;
}

function inline(text: string, repoBase: string): string {
  return escape(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) => `<a href="${escape(href(url.replace(/&amp;/g, "&"), repoBase))}">${label}</a>`);
}

export function renderMarkdown(md: string, repoBase = "https://github.com/tteze/troqo/blob/main/docs"): string {
  const out: string[] = [];
  const lines = md.replace(/\r/g, "").split("\n");
  let i = 0;
  const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const html = inline(h[2], repoBase);
      out.push(`<h${level} id="${slug(html)}">${html}</h${level}>`);
      i++;
      continue;
    }
    if (line.trim().startsWith("|") && lines[i + 1]?.trim().match(/^\|[\s:|-]+\|$/)) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
      out.push(
        `<div class="tablewrap"><table><thead><tr>${head.map((c) => `<th>${inline(c, repoBase)}</th>`).join("")}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, repoBase)}</td>`).join("")}</tr>`).join("") +
          "</tbody></table></div>",
      );
      continue;
    }
    const list = line.match(/^(\s*)(-|\d+\.)\s+/);
    if (list) {
      const ordered = /\d/.test(list[2]);
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^\s*(-|\d+\.)\s+/)) {
        let item = lines[i].replace(/^\s*(-|\d+\.)\s+/, "");
        i++;
        while (i < lines.length && lines[i].trim() && !lines[i].match(/^\s*(-|\d+\.)\s+/) && lines[i].startsWith("  ")) item += " " + lines[i++].trim();
        items.push(`<li>${inline(item, repoBase)}</li>`);
      }
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !lines[i].match(/^(#{1,4}\s|\s*(-|\d+\.)\s+|\|)/)) para.push(lines[i++].trim());
    out.push(`<p>${inline(para.join(" "), repoBase)}</p>`);
  }
  return out.join("\n");
}
