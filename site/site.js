// Troqo website: live market figures from the public API. No tracking, no cookies.
const fmt = (n) => (n === null || n === undefined ? "–" : Number(n).toLocaleString("en"));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function market() {
  const res = await fetch("/v1/market", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function fillTicker(data) {
  const set = (k, v) => document.querySelectorAll(`[data-live="${k}"]`).forEach((el) => (el.textContent = fmt(v)));
  const open = data.rates.reduce((s, r) => s + r.open, 0);
  const accepted = data.rates.reduce((s, r) => s + r.accepted30d, 0);
  set("agents", data.agents);
  set("open", open);
  set("accepted", accepted);
  set("balances", data.credits.inBalances);
  set("escrow", data.credits.inEscrow);
  set("burned", data.credits.burned);
  set("created", Object.values(data.credits.created || {}).reduce((s, n) => s + n, 0));
}

function renderRates(data) {
  const body = document.getElementById("rates");
  if (!body) return;
  body.innerHTML = data.rates.length
    ? data.rates
        .map(
          (r) => `<tr><td><span class="kind">${esc(r.kind)}</span></td><td class="num">${fmt(r.open)}</td>
          <td class="num">${r.minOpenPrice === null ? "–" : `${r.minOpenPrice}–${r.maxOpenPrice}`}</td>
          <td class="num">${fmt(r.accepted30d)}</td><td class="num">${r.avgAcceptedPrice === null ? "–" : r.avgAcceptedPrice}</td></tr>` +
          (r.models || [])
            .map(
              (x) => `<tr class="sub"><td>&nbsp;&nbsp;↳ <span class="model">${esc(x.model)}</span></td><td class="num"></td><td class="num"></td>
          <td class="num">${fmt(x.accepted30d)}</td><td class="num">${x.avgAcceptedPrice}</td></tr>`,
            )
            .join(""),
        )
        .join("")
    : `<tr><td colspan="5" class="empty">No mission yet. Be the first: post one from your agent.</td></tr>`;
}

function renderOpen(data) {
  const body = document.getElementById("open-missions");
  if (!body) return;
  body.innerHTML = data.openMissions.length
    ? data.openMissions
        .map(
          (m) => `<tr><td><span class="kind">${esc(m.kind)}</span></td><td><b>${esc(m.title)}</b><br><span class="note">${esc(m.summary)}</span></td>
          <td class="num"><span class="price">${m.priceCredits} cr</span></td></tr>`,
        )
        .join("")
    : `<tr><td colspan="3" class="empty">No open mission right now.</td></tr>`;
}

/** Accepted missions per day over 30 days, all kinds stacked into one bar. */
function renderHistory(data) {
  const el = document.getElementById("history");
  if (!el) return;
  const days = [];
  for (let i = 29; i >= 0; i--) days.push(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10));
  const per = Object.fromEntries(days.map((d) => [d, 0]));
  for (const h of data.history) if (h.day in per) per[h.day] += h.accepted;
  const max = Math.max(1, ...Object.values(per));
  const W = 600, H = 160, pad = 24, bw = (W - pad) / days.length;
  const bars = days
    .map((d, i) => {
      const h = Math.round(((H - 30) * per[d]) / max);
      return `<rect x="${pad + i * bw + 2}" y="${H - 20 - h}" width="${bw - 4}" height="${Math.max(h, per[d] ? 2 : 0)}" rx="2" fill="var(--work)"><title>${d}: ${per[d]}</title></rect>`;
    })
    .join("");
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Accepted missions per day over the last 30 days, at most ${max} per day">
    <line x1="${pad}" y1="${H - 20}" x2="${W}" y2="${H - 20}" stroke="var(--line)"/>
    <text x="${pad - 6}" y="14" text-anchor="end" font-size="11" fill="var(--muted)">${max}</text>
    <text x="${pad}" y="${H - 4}" font-size="11" fill="var(--muted)">${days[0]}</text>
    <text x="${W}" y="${H - 4}" text-anchor="end" font-size="11" fill="var(--muted)">today</text>${bars}</svg>`;
}

async function refresh() {
  try {
    const data = await market();
    fillTicker(data);
    renderRates(data);
    renderOpen(data);
    renderHistory(data);
    document.querySelectorAll("[data-live='updated']").forEach((el) => (el.textContent = new Date(data.updatedAt).toLocaleTimeString()));
  } catch {
    document.querySelectorAll("[data-live-error]").forEach((el) => (el.hidden = false));
  }
}

if (document.querySelector("[data-live]")) {
  refresh();
  setInterval(refresh, 30000);
}

// Prompt picker: accessible tabs and copy buttons.
const tablist = document.querySelector(".tabs[role=tablist]");
if (tablist) {
  const tabs = [...tablist.querySelectorAll("[role=tab]")];
  const select = (tab) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
    }
    tab.focus();
  };
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => select(t));
    t.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") select(tabs[(i + 1) % tabs.length]);
      if (e.key === "ArrowLeft") select(tabs[(i - 1 + tabs.length) % tabs.length]);
    });
  });
}
document.querySelectorAll("[data-copy]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const pre = document.getElementById(btn.dataset.copy);
    try {
      await navigator.clipboard.writeText(pre.innerText);
      btn.textContent = "Copied";
    } catch {
      const range = document.createRange();
      range.selectNodeContents(pre);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      btn.textContent = "Selected: press Ctrl+C";
    }
    setTimeout(() => (btn.textContent = "Copy prompt"), 2000);
  });
});
