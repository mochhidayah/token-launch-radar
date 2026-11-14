"use strict";
/* Token Launch Radar dashboard — reads window.RADAR (written by main.ts
   from the sealed snapshot), renders the board, the filters and the detail
   view. No network, no framework. State lives in the URL hash so a view
   (a filter, a sort, a protocol) is a link. */

const R = window.RADAR;
const $ = (s) => document.querySelector(s);
const rowsEl = $("#rows");
const emptyEl = $("#empty");
const countEl = $("#count");
const dialog = $("#detail");

/* ------------------------------------------------------------------ */
/* formatting                                                          */
/* ------------------------------------------------------------------ */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function money(n) {
  if (n == null || !isFinite(n)) return "—";
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2).replace(/\.00$/, "") + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return "$" + Math.round(n).toLocaleString("en-US");
}

function moneyFull(n) {
  if (n == null || !isFinite(n)) return "—";
  return "$" + Math.round(n).toLocaleString("en-US");
}

function pct(n) {
  if (n == null || !isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return sign + n.toFixed(2) + "%";
}

function pctClass(n) {
  if (n == null || !isFinite(n)) return "";
  return n > 0 ? "pos" : n < 0 ? "neg" : "";
}

function ageText(days) {
  if (days == null || !isFinite(days)) return "unknown";
  if (days < 30) return days + "d";
  if (days < 365) return Math.floor(days / 30) + "mo";
  const y = Math.floor(days / 365);
  const m = Math.floor((days % 365) / 30);
  return m > 0 ? y + "y " + m + "mo" : y + "y";
}

function mult(x) {
  return "×" + x.toFixed(2);
}

/* ------------------------------------------------------------------ */
/* state (URL hash)                                                    */
/* ------------------------------------------------------------------ */

const DEFAULTS = { tab: "pre", q: "", category: "", chain: "", minTvl: "0", watchlist: false, sort: "implied", p: "" };

function readHash() {
  const state = { ...DEFAULTS };
  const hash = location.hash.replace(/^#/, "");
  if (!hash) return state;
  for (const part of hash.split("&")) {
    const [k, v] = part.split("=");
    if (!k) continue;
    const val = decodeURIComponent(v || "");
    if (k === "tab" && (val === "pre" || val === "live")) state.tab = val;
    else if (k === "q") state.q = val;
    else if (k === "category") state.category = val;
    else if (k === "chain") state.chain = val;
    else if (k === "minTvl") state.minTvl = val;
    else if (k === "watchlist") state.watchlist = val === "1";
    else if (k === "sort") state.sort = val;
    else if (k === "p") state.p = val;
  }
  return state;
}

function writeHash(state) {
  const parts = [];
  if (state.tab !== "pre") parts.push("tab=" + state.tab);
  if (state.q) parts.push("q=" + encodeURIComponent(state.q));
  if (state.category) parts.push("category=" + encodeURIComponent(state.category));
  if (state.chain) parts.push("chain=" + encodeURIComponent(state.chain));
  if (state.minTvl !== "0") parts.push("minTvl=" + state.minTvl);
  if (state.watchlist) parts.push("watchlist=1");
  if (state.sort !== "implied") parts.push("sort=" + state.sort);
  if (state.p) parts.push("p=" + encodeURIComponent(state.p));
  const next = parts.length ? "#" + parts.join("&") : "";
  if (location.hash !== next) history.replaceState(null, "", next || location.pathname + location.search);
}

let state = readHash();

/* ------------------------------------------------------------------ */
/* data                                                                */
/* ------------------------------------------------------------------ */

const WATCH = new Set(R.watchlist || []);
const maxImplied = Math.max(1, ...R.rows.map((r) => r.implied_value_usd));
const categories = [...new Set(R.rows.map((r) => r.category).filter(Boolean))].sort();
const chains = [...new Set(R.rows.flatMap((r) => r.chains || []))].sort();

function visibleRows() {
  const q = state.q.trim().toLowerCase();
  const minTvl = Number(state.minTvl) || 0;
  let list = state.tab === "live" ? R.live : R.rows;
  list = list.filter((r) => {
    if (q) {
      const hay = ((r.name || "") + " " + r.slug + " " + (r.category || "")).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (state.category && r.category !== state.category) return false;
    if (state.chain && !(r.chains || []).includes(state.chain)) return false;
    if (minTvl && (r.tvl || 0) < minTvl) return false;
    if (state.watchlist && !WATCH.has(r.slug)) return false;
    return true;
  });
  const sort = state.sort;
  const sorted = [...list];
  if (state.tab === "live") {
    if (sort === "tvl") sorted.sort((a, b) => (b.tvl || 0) - (a.tvl || 0));
    else if (sort === "growth") sorted.sort((a, b) => (b.change_7d ?? -Infinity) - (a.change_7d ?? -Infinity));
    else if (sort === "age") sorted.sort((a, b) => (b.age_days ?? -1) - (a.age_days ?? -1));
    else if (sort === "name") sorted.sort((a, b) => (a.name || a.slug).localeCompare(b.name || b.slug));
    else sorted.sort((a, b) => (b.mcap || 0) - (a.mcap || 0));
  } else if (sort === "tvl") sorted.sort((a, b) => (b.tvl || 0) - (a.tvl || 0));
  else if (sort === "growth") sorted.sort((a, b) => (b.change_7d ?? -Infinity) - (a.change_7d ?? -Infinity));
  else if (sort === "age") sorted.sort((a, b) => (b.age_days ?? -1) - (a.age_days ?? -1));
  else if (sort === "name") sorted.sort((a, b) => (a.name || a.slug).localeCompare(b.name || b.slug));
  else sorted.sort((a, b) => a.rank - b.rank);
  return sorted;
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

function renderStats() {
  const watchRows = R.rows.filter((r) => WATCH.has(r.slug)).length;
  const earlyRows = R.rows.length - watchRows;
  const stats = [
    [R.rows.length, "protocols ranked"],
    [watchRows + " / " + R.watchlist.length, "watchlist covered"],
    [earlyRows, "ranked beyond the watchlist"],
    [R.live.length, "already trading, set aside"],
    [R.excluded_count, "excluded as wrapped / staked"],
  ];
  $("#stats").innerHTML = stats.map(([v, l]) =>
    `<div class="stat"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`).join("");
  $("#asof").textContent = R.as_of;
}

function renderOptions() {
  const cat = $("#category");
  for (const c of categories) {
    const o = document.createElement("option");
    o.value = c; o.textContent = c; cat.appendChild(o);
  }
  const ch = $("#chain");
  for (const c of chains) {
    const o = document.createElement("option");
    o.value = c; o.textContent = c; ch.appendChild(o);
  }
}

function rowHtml(r) {
  const isLive = state.tab === "live";
  const rankCell = isLive ? "—" : "#" + r.rank;
  const impliedCell = isLive
    ? `<td class="num">${money(r.mcap)}<div class="bar" style="visibility:hidden"><i></i></div></td>`
    : `<td class="num">${money(r.implied_value_usd)}<div class="bar"><i style="width:${Math.max(2, Math.round((r.implied_value_usd / maxImplied) * 100))}%"></i></div></td>`;
  const modelCell = isLive
    ? `<td class="model-cell">market cap</td>`
    : `<td class="model-cell">${mult(r.cat_mult)} · ${mult(r.growth_mult)} · ${mult(r.maturity_mult)} · ${mult(r.chain_mult)}</td>`;
  const watchBadge = WATCH.has(r.slug) ? `<span class="badge">WATCHLIST</span>` : "";
  const chainText = (r.chains || []).slice(0, 3).join(", ") + ((r.chains || []).length > 3 ? " +" + ((r.chains || []).length - 3) : "");
  return `<tr data-slug="${esc(r.slug)}">
    <td class="num">${rankCell}</td>
    <td><span class="name">${esc(r.name)}</span>${watchBadge}<br><span class="slug">${esc(r.slug)}</span></td>
    <td>${esc(r.category || "—")}</td>
    <td>${esc(chainText || "—")}</td>
    <td class="num">${money(r.tvl)}</td>
    <td class="num ${pctClass(r.change_7d)}">${pct(r.change_7d)}</td>
    <td class="num">${ageText(r.age_days)}</td>
    ${impliedCell}
    ${modelCell}
  </tr>`;
}

function renderBoard() {
  const list = visibleRows();
  rowsEl.innerHTML = list.map(rowHtml).join("");
  emptyEl.hidden = list.length > 0;
  const total = state.tab === "live" ? R.live.length : R.rows.length;
  countEl.textContent = list.length === total
    ? `Showing ${list.length} of ${total} ${state.tab === "live" ? "live protocols" : "ranked protocols"}. Click a row for the detail view and farm plan.`
    : `Showing ${list.length} of ${total} ${state.tab === "live" ? "live protocols" : "ranked protocols"}.`;
  // Tabs.
  $("#tab-pre").classList.toggle("active", state.tab === "pre");
  $("#tab-live").classList.toggle("active", state.tab === "live");
  $("#tab-pre").setAttribute("aria-selected", String(state.tab === "pre"));
  $("#tab-live").setAttribute("aria-selected", String(state.tab === "live"));
  // Controls reflect state.
  $("#q").value = state.q;
  $("#category").value = state.category;
  $("#chain").value = state.chain;
  $("#minTvl").value = state.minTvl;
  $("#watchlist").checked = state.watchlist;
  $("#sort").value = state.sort;
  // The implied-value column is the market cap on the live tab.
  document.querySelector("#board thead tr th:nth-child(8)").textContent =
    state.tab === "live" ? "Market cap" : "Implied launch value";
  document.querySelector("#board thead tr th:nth-child(9)").textContent =
    state.tab === "live" ? "Source" : "Model";
}

function renderDetail(slug) {
  const r = R.rows.find((x) => x.slug === slug) || R.live.find((x) => x.slug === slug);
  if (!r) return;
  const isLive = !R.rows.includes(r);
  const base = Math.round(r.tvl * 0.3);
  const body = $("#detail-body");
  const watchBadge = WATCH.has(r.slug) ? `<span class="badge">WATCHLIST</span>` : "";
  const chainText = (r.chains || []).join(", ") || "—";
  let html = `<h2>${esc(r.name)} ${watchBadge}</h2>
    <p class="dsub">${esc(r.slug)} · ${esc(r.category || "no category")} · ${esc(chainText)}</p>
    <div class="kv">
      <div><div class="k">TVL</div><div class="v">${moneyFull(r.tvl)}</div></div>
      <div><div class="k">7-day change</div><div class="v ${pctClass(r.change_7d)}">${pct(r.change_7d)}</div></div>
      <div><div class="k">Age</div><div class="v">${ageText(r.age_days)}</div></div>
      <div><div class="k">${isLive ? "Market cap" : "Implied launch value"}</div><div class="v">${moneyFull(isLive ? r.mcap : r.implied_value_usd)}</div></div>
    </div>`;
  if (!isLive) {
    html += `<h3>How the implied value is worked out</h3>
    <table class="break">
      <tr><td>TVL × 0.30</td><td class="num">${moneyFull(base)}</td></tr>
      <tr><td>× category ${esc(r.category || "—")} (${mult(r.cat_mult)})</td><td class="num">${moneyFull(base * r.cat_mult)}</td></tr>
      <tr><td>× growth (${pct(r.change_7d)} → ${mult(r.growth_mult)})</td><td class="num">${moneyFull(base * r.cat_mult * r.growth_mult)}</td></tr>
      <tr><td>× maturity (${ageText(r.age_days)} → ${mult(r.maturity_mult)})</td><td class="num">${moneyFull(base * r.cat_mult * r.growth_mult * r.maturity_mult)}</td></tr>
      <tr><td>× chains (${(r.chains || []).length} → ${mult(r.chain_mult)})</td><td class="num"><b>${moneyFull(r.implied_value_usd)}</b></td></tr>
    </table>
    <h3>Farm plan — 7 steps</h3>
    <ol>${r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
    <p class="warn" style="color:var(--muted);font-size:13px">The farm plan is a suggestion for positioning if a token ever launches. It is not a promise that one will, and never pay to claim a token.</p>`;
  } else {
    html += `<p style="color:var(--muted)">${esc(r.name)} already trades, so it is set aside here at the market&rsquo;s own value. It is not a launch candidate and has no farm plan on this board.</p>`;
  }
  body.innerHTML = html;
  if (!dialog.open) dialog.showModal();
  // showModal() can focus the Close button at the bottom and scroll the
  // dialog down; the detail view must open at the top.
  dialog.scrollTop = 0;
}

/* ------------------------------------------------------------------ */
/* events                                                              */
/* ------------------------------------------------------------------ */

function syncFromControls() {
  state.q = $("#q").value;
  state.category = $("#category").value;
  state.chain = $("#chain").value;
  state.minTvl = $("#minTvl").value;
  state.watchlist = $("#watchlist").checked;
  state.sort = $("#sort").value;
  writeHash(state);
  renderBoard();
}

$("#q").addEventListener("input", syncFromControls);
$("#category").addEventListener("change", syncFromControls);
$("#chain").addEventListener("change", syncFromControls);
$("#minTvl").addEventListener("change", syncFromControls);
$("#watchlist").addEventListener("change", syncFromControls);
$("#sort").addEventListener("change", syncFromControls);
$("#tab-pre").addEventListener("click", () => { state.tab = "pre"; state.p = ""; writeHash(state); renderBoard(); });
$("#tab-live").addEventListener("click", () => { state.tab = "live"; state.p = ""; writeHash(state); renderBoard(); });

rowsEl.addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-slug]");
  if (!tr) return;
  state.p = tr.dataset.slug;
  writeHash(state);
  renderDetail(state.p);
});

dialog.addEventListener("close", () => {
  if (state.p) { state.p = ""; writeHash(state); }
});

window.addEventListener("hashchange", () => {
  state = readHash();
  renderBoard();
  if (state.p) renderDetail(state.p);
  else if (dialog.open) dialog.close();
});

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */

renderStats();
renderOptions();
renderBoard();
if (state.p) renderDetail(state.p);
