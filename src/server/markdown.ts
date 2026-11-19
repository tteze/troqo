/**
 * A small Markdown renderer for the site's pages written in Markdown (the charter): headings,
 * paragraphs, lists (with nested blocks), quotes, tables, code blocks, bold, inline code and links. Everything is escaped first, so the
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
  const ITEM = /^(\s*)(-|\d+\.)\s+/;
  const indentOf = (l: string) => l.length - l.trimStart().length;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.trimStart().startsWith("```")) {
      const indent = indentOf(line);
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) code.push(lines[i++].slice(Math.min(indent, indentOf(lines[i - 1]))));
      i++;
      out.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`);
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
    if (line.startsWith(">")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) quote.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${renderMarkdown(quote.join("\n"), repoBase)}</blockquote>`);
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
    const list = line.match(ITEM);
    if (list) {
      const ordered = /\d/.test(list[2]);
      const base = list[1].length;
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(ITEM);
        if (!m || m[1].length !== base) break;
        // An item: its first line, then every following line indented under it, blank lines included
        // when more indented content follows (a second paragraph, a code block, a nested list).
        const body = [lines[i].slice(m[0].length)];
        const inner = m[0].length;
        i++;
        while (i < lines.length) {
          const l = lines[i];
          if (l.trim() && indentOf(l) > base && !(indentOf(l) === base && ITEM.test(l))) {
            body.push(l.slice(Math.min(inner, indentOf(l))));
            i++;
          } else if (!l.trim() && i + 1 < lines.length && lines[i + 1].trim() && indentOf(lines[i + 1]) > base) {
            body.push("");
            i++;
          } else if (l.trim() && !ITEM.test(l) && indentOf(l) <= base && body[body.length - 1] !== "" && !/^(#|\||```|>)/.test(l.trim())) {
            body.push(l.trim()); // a lazy continuation of the item's text
            i++;
          } else break;
        }
        const blocks = body.join("\n");
        const simple = !body.some((b, k) => k > 0 && (!b.trim() || ITEM.test(b) || b.trimStart().startsWith("```")));
        items.push(`<li>${simple ? inline(body.map((b) => b.trim()).join(" "), repoBase) : renderMarkdown(blocks, repoBase)}</li>`);
        if (i < lines.length && !lines[i].trim() && lines[i + 1]?.match(ITEM)?.[1].length === base) i++; // loose list
      }
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !lines[i].match(/^(#{1,4}\s|\s*(-|\d+\.)\s+|\||\s*```|>)/)) para.push(lines[i++].trim());
    out.push(`<p>${inline(para.join(" "), repoBase)}</p>`);
  }
  return out.join("\n");
}
