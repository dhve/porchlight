// app.js — Sutros frontend
// Drives the three screens (home, live run, report), streams the checkup over
// Server-Sent Events, and renders the report from the API's JSON.

const REDUCED = window.matchMedia("(prefers-reduced-motion:reduce)").matches;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// Escape everything that comes from the server / scanned site before it hits
// innerHTML. Evidence lines can contain arbitrary text from the target site.
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

const RING_CIRC = 2 * Math.PI * 66; // r=66 in the scorecard SVG
let ringEl = null;
let ringTarget = RING_CIRC;
let currentReport = null;

const SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
const MOON = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';
const ICON_SPIN = '<svg class="spin" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 12a9 9 0 1 1-6.2-8.6" stroke-linecap="round"/></svg>';
const ICON_CHECK = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>';


/* ---------------- navigation ---------------- */
function go(name) {
  $$(".screen").forEach((s) => s.classList.remove("is-active"));
  $("#screen-" + name).classList.add("is-active");
  window.scrollTo({ top: 0, behavior: REDUCED ? "auto" : "smooth" });
  if (name === "home" && location.pathname !== "/") history.replaceState(null, "", "/");
  if (name === "report") applyRing();
}
function scrollToId(id) {
  setTimeout(() => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth" });
  }, 60);
}

/* ---------------- helpers ---------------- */
function displayHost(input) {
  try {
    const u = new URL(/^https?:\/\//i.test(input) ? input : "https://" + input);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return String(input).replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  }
}

/* ---------------- live checkup ---------------- */
function resetRun() {
  $$("#checklist .check-row").forEach((row) => {
    row.classList.remove("active", "done");
    $("[data-status]", row).textContent = "waiting";
  });
  $("#runLog").innerHTML = "";
  $("#runCta").classList.remove("show");
  $("#house").classList.remove("lit");
  setAgentHint(false);
}

// The quiet line under the live log. Shown only while a checkup is running.
function setAgentHint(show) {
  const hint = $("#runAgentHint");
  if (hint) hint.hidden = !show;
}

function onStep(data) {
  const row = $(`#checklist .check-row[data-key="${data.key}"]`);
  if (!row) return;
  const icon = $("[data-icon]", row);
  const status = $("[data-status]", row);
  if (data.status === "start") {
    row.classList.add("active");
    row.classList.remove("done");
    status.textContent = "checking";
    icon.innerHTML = ICON_SPIN;
    if (data.key === "recon") setTimeout(() => $("#house").classList.add("lit"), 150);
  } else if (data.status === "done") {
    row.classList.remove("active");
    row.classList.add("done");
    status.textContent = data.detail === "skipped" ? "skipped" : "done";
    icon.innerHTML = ICON_CHECK;
    if (data.detail && data.detail !== "skipped") $("[data-sub]", row).textContent = data.detail;
  }
}

function addLog({ mark, text }) {
  const log = $("#runLog");
  const d = document.createElement("div");
  d.className = "line";
  d.innerHTML = `<span class="mk">${esc(mark || "•")}</span><span>${esc(text || "")}</span>`;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
}

function onRunError(message) {
  go("home");
  const err = $("#formErr");
  err.textContent = message;
  err.classList.add("show");
}

function startLive(url) {
  resetRun();
  $("#runHost").textContent = displayHost(url);
  currentReport = null;
  go("run");
  setAgentHint(true);

  let gotReport = false;
  const es = new EventSource(`/api/checkup/stream?url=${encodeURIComponent(url)}&consent=1`);

  es.addEventListener("step", (e) => onStep(JSON.parse(e.data)));
  es.addEventListener("log", (e) => addLog(JSON.parse(e.data)));
  es.addEventListener("report", (e) => {
    gotReport = true;
    currentReport = JSON.parse(e.data);
    renderReport(currentReport);
    if (currentReport.id) history.replaceState(null, "", "/r/" + currentReport.id);
    $("#runCta").classList.add("show");
    setAgentHint(false);
  });
  es.addEventListener("error", (e) => {
    let msg = "Something went wrong during the checkup. Please try again.";
    try { if (e.data) msg = JSON.parse(e.data).message; } catch {}
    es.close();
    setAgentHint(false);
    if (!gotReport) onRunError(msg);
  });
  es.addEventListener("done", () => { es.close(); setAgentHint(false); });
  es.onerror = () => {
    es.close();
    setAgentHint(false);
    if (!gotReport) onRunError("Lost connection to the checkup. Please try again.");
  };
}

/* ---------------- report rendering ---------------- */
const GRADE_COLOR = { A: "var(--good)", B: "var(--good)", C: "var(--watch)", D: "var(--serious)", F: "var(--urgent)" };
const SEV = {
  urgent: { label: "Urgent", icon: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>' },
  serious: { label: "Serious", icon: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>' },
  watch: { label: "Worth a look", icon: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>' },
  good: { label: "All clear", icon: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>' },
};
const PERSON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
const WRENCH = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>';
const FLAG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 22V3M5 3h13l-2.5 4.5L18 12H5"/></svg>';
const PROOF_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/></svg>';
const CHEV = '<svg class="chev" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M9 18l6-6-6-6"/></svg>';
const SHIELD = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>';
const COMPASS = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="12" cy="12" r="10"/><path d="M16.2 7.8l-2.1 6.3-6.3 2.1 2.1-6.3z"/></svg>';
const COMPASS_LG = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><path d="M16.2 7.8l-2.1 6.3-6.3 2.1 2.1-6.3z"/></svg>';
const PLAY = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="12" cy="12" r="10"/><path d="M10 8l6 4-6 4z"/></svg>';

// Shown above the findings. The server sends the same text as r.proofPromise; this
// copy is the fallback for older saved reports and the offline sample.
const PROOF_PROMISE_FALLBACK = "Every finding in this report comes from a direct, scripted test that we ran against this site. The AI only writes the wording. It cannot add, remove, or change a finding. Each proof shows the request we sent, the answer we received, and where on the site we found it.";

// Same shapes the server accepts for report ids and screenshot keys.
const REPORT_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;
const SHOT_KEY_RE = /^s[1-9]$/;

function renderReport(r) {
  const color = GRADE_COLOR[r.grade] || "var(--watch)";
  ringTarget = RING_CIRC * (1 - Math.max(0, Math.min(100, r.ringPercent || 0)) / 100);
  const findings = Array.isArray(r.findings) ? r.findings : [];
  const tally = r.tally || {};

  const chips = [];
  if (tally.urgent) chips.push(chip("urgent", tally.urgent, "urgent"));
  if (tally.serious) chips.push(chip("serious", tally.serious, "serious"));
  if (tally.watch) chips.push(chip("watch", tally.watch, "worth a look"));
  const goodCount = (r.passes || []).length;
  if (goodCount) chips.push(chip("good", goodCount, "looking good"));
  if (tally.minor) chips.push(chip("minor", tally.minor, "minor"));

  const throttled = r.engine && r.engine.throttled
    ? `<p class="sc-throttled">The site limited our checker partway through, so some checks were shortened.</p>`
    : "";

  $("#scorecard").innerHTML = `
    <div class="sc-glow"></div>
    <div class="grade">
      <svg width="150" height="150" viewBox="0 0 150 150" aria-hidden="true">
        <circle cx="75" cy="75" r="66" fill="none" stroke="var(--border)" stroke-width="9"/>
        <circle id="gradeRing" cx="75" cy="75" r="66" fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round"
          stroke-dasharray="${RING_CIRC.toFixed(1)}" stroke-dashoffset="${RING_CIRC.toFixed(1)}"
          style="transition:stroke-dashoffset 1.1s var(--step);"/>
      </svg>
      <span class="letter" style="color:${color};">${esc(r.grade)}</span>
      <span class="glabel">${esc(r.gradeLabel || "")}</span>
    </div>
    <div class="sc-body">
      <h1>${esc(gradeHeadline(r))}</h1>
      <p class="host">${esc(r.target)} &middot; checked ${esc(whenText(r.scannedAt))}</p>
      <p class="sc-summary">${esc(r.summary || "")}</p>
      ${throttled}
      <div class="sc-tally">${chips.join("")}</div>
    </div>`;
  ringEl = $("#gradeRing");

  // engine badge
  const badge = $("#engineBadge");
  const usingLLM = r.engine && r.engine.reporter === "llm";
  badge.classList.toggle("off", !usingLLM);
  $("#engineText").textContent = usingLLM ? `AI report (${r.engine.model || "llm"})` : "Rule-based report";
  const titleParts = [];
  if (r.engine) titleParts.push(`planner: ${r.engine.orchestrator}; writer: ${r.engine.reporter}; checks: ${(r.engine.checksRun || []).join(", ")}`);
  if (r.agent && typeof r.agent.steps === "number" && Number.isFinite(r.agent.steps)) titleParts.push(`agent: ${r.agent.steps} steps`);
  badge.title = titleParts.join("; ");

  // share link (only when the report was saved to the database)
  const share = $("#shareBox");
  if (r.id) {
    const link = `${location.origin}/r/${r.id}`;
    $("#shareLink").textContent = link;
    share.dataset.link = link;
    share.classList.add("show");
  } else {
    share.classList.remove("show");
  }

  // Findings, ordered by what the owner should do first.
  const fixFirst = findings.filter((f) => f.severity === "urgent" || f.severity === "serious");
  const watchList = findings.filter((f) => f.severity === "watch");
  const minorList = findings.filter((f) => f.severity === "minor");
  const hasMajor = fixFirst.length > 0;
  const promise = findings.length ? proofPromise(r) : "";
  // What the browsing agent did, when it ran. Nothing when it did not.
  let html = agentCard(r);
  if (hasMajor) {
    // Lead with the things that actually matter.
    html += promise + `<p class="eyebrow">Fix these first</p>` + fixFirst.map((f) => findingCard(f, r)).join("");
    if (watchList.length) html += `<p class="eyebrow" style="margin-top:14px;">Then, smaller things worth a look</p>` + watchList.map((f) => findingCard(f, r)).join("");
  } else {
    // No urgent or serious problems: reassure first, then frame the rest as optional.
    html += reassureBanner(watchList.length > 0) + promise;
    if (watchList.length) html += `<p class="eyebrow" style="margin-top:14px;">Optional improvements (nice to have, not urgent)</p>` + watchList.map((f) => findingCard(f, r)).join("");
  }
  if (goodCount) {
    html += `<p class="eyebrow" style="margin-top:14px;">Looking good</p>` + goodCard(r.passes);
  }
  if (minorList.length) html += minorNotes(minorList, r);
  // feedback-ui.js fills this (and every .f-slot) once the report has an id.
  html += `<div id="reportFeedbackSlot"></div>`;
  $("#findingsRoot").innerHTML = html;
  try { if (window.Sutros) Sutros.onReportRendered(r); } catch (e) { console.error(e); }
}

function chip(cls, n, label) {
  return `<span class="tally ${cls}"><span class="n">${esc(n)}</span> ${esc(label)}</span>`;
}

function proofPromise(r) {
  const text = r.proofPromise && String(r.proofPromise).trim() ? String(r.proofPromise).trim() : PROOF_PROMISE_FALLBACK;
  return `<div class="proof-promise"><span class="pp-icon">${SHIELD}</span><p>${esc(text)}</p></div>`;
}

function findingCard(f, r) {
  const meta = SEV[f.severity] || SEV.watch;
  const fixes = (f.fix || []).map((step) => `<li>${esc(step)}</li>`).join("");
  return `
    <div class="finding ${esc(f.severity)}">
      <div class="f-head">
        <div class="f-chips">
          <span class="sev-chip ${esc(f.severity)}">${meta.icon}${esc(meta.label)}</span>
          ${agentChip(f)}
          ${disputeChip(f)}
        </div>
        <div class="f-main">
          <h3>${esc(f.title)}</h3>
          <p class="f-mean">${esc(f.meaning)}</p>
        </div>
      </div>
      ${fixes ? `<div class="f-fix"><div class="fx-label">${WRENCH}How to fix it</div><ol>${fixes}</ol>${f.who ? `<div class="who">${PERSON} ${esc(f.who)}</div>` : ""}</div>` : ""}
      ${proofPanel(f, r)}
      <div class="f-slot" data-finding="${esc(f.id)}"></div>
    </div>`;
}

// The technical proof panel. Order: why, how we tested, what we observed, found on,
// screenshots, check again, see it yourself, note, what visitors said.
function proofPanel(f, r) {
  const ev = f.evidence;
  const said = disputeBlock(f);
  if (!ev && !said) return "";
  const e = ev || {};
  const lines = cleanLines(e.lines);
  const body =
    (e.why ? `<p class="proof-why"><b>Why this is a problem.</b> ${esc(e.why)}</p>` : "") +
    (e.method ? `<p class="proof-method"><b>How we tested this.</b> ${esc(e.method)}</p>` : "") +
    (lines.length ? `<p class="proof-k">What we observed</p><pre>${lines.map((l) => linkifyLine(l, r)).join("\n")}</pre>` : "") +
    pagesList(e, r) +
    shotsBlock(e, r) +
    retestBlock(f, e, r) +
    (e.confirm ? `<p class="proof-confirm"><b>See it yourself.</b> ${esc(e.confirm)}</p>` : "") +
    (e.note ? `<p class="proof-note">${esc(e.note)}</p>` : "") +
    said;
  return `<details class="proof"><summary>${PROOF_ICON} Show the technical proof ${CHEV}</summary><div class="proof-body">${body}</div></details>`;
}

function cleanLines(lines) {
  return (Array.isArray(lines) ? lines : []).filter((l) => l != null && String(l).trim() !== "").map(String);
}

// Base for resolving site paths: the report's final URL, else https:// plus the target host.
function reportBase(r) {
  const cands = [r && r.url, r && r.target ? "https://" + String(r.target).replace(/^https?:\/\//i, "") : null];
  for (const c of cands) {
    if (!c) continue;
    try { const u = new URL(String(c)); if (/^https?:$/.test(u.protocol)) return u.href; } catch {}
  }
  return null;
}

// Returns the normalized href when s is an absolute http(s) URL, else null.
function isHttpUrl(s) {
  if (s == null) return null;
  try { const u = new URL(String(s)); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; }
}

// Absolute http(s) URLs link as they are; tokens that start with a single "/" resolve
// against the report's origin. Anything else is left as plain text.
function linkTarget(tok, base) {
  try {
    if (/^https?:\/\/\S+$/i.test(tok)) return isHttpUrl(tok);
    if (base && /^\/(?!\/)\S*$/.test(tok)) {
      const u = new URL(tok, base);
      return /^https?:$/.test(u.protocol) && u.origin === new URL(base).origin ? u.href : null;
    }
  } catch {}
  return null;
}

// Escape an evidence line and turn URLs and site paths into links.
function linkifyLine(line, r) {
  const base = reportBase(r);
  return String(line).split(/(\s+)/).map((tok) => {
    if (!tok || /^\s+$/.test(tok)) return esc(tok);
    const m = tok.match(/^([("'\[<]*)(.*?)([)"'\]>,.;:!?]*)$/);
    const lead = m ? m[1] : "";
    const core = m ? m[2] : tok;
    const tail = m ? m[3] : "";
    const href = linkTarget(core, base);
    if (!href) return esc(tok);
    return `${esc(lead)}<a href="${esc(href)}" target="_blank" rel="noopener">${esc(core)}</a>${esc(tail)}`;
  }).join("");
}

// Short label for a URL: its path on this site, "the homepage" for "/", host plus path elsewhere.
function pathLabel(url, r) {
  try {
    const u = new URL(url);
    const base = reportBase(r);
    const path = (u.pathname || "/") + (u.search || "");
    const strip = (h) => String(h || "").toLowerCase().replace(/^www\./, "");
    const sameSite = base && strip(u.host) === strip(new URL(base).host);
    if (!sameSite) return u.host + path;
    return path === "/" ? "the homepage" : path;
  } catch {
    return String(url);
  }
}

function pageLink(url, r) {
  return `<a href="${esc(url)}" title="${esc(url)}" target="_blank" rel="noopener">${esc(pathLabel(url, r))}</a>`;
}

function pagesList(e, r) {
  const seen = new Set();
  const pages = [];
  for (const p of Array.isArray(e.pages) ? e.pages : []) {
    const href = isHttpUrl(p);
    if (href && !seen.has(href)) { seen.add(href); pages.push(href); }
    if (pages.length >= 6) break;
  }
  if (!pages.length) return "";
  return `<p class="proof-k">Found on</p><ul class="proof-pages">${pages.map((p) => `<li>${pageLink(p, r)}</li>`).join("")}</ul>`;
}

function shotsBlock(e, r) {
  if (!r.id || !REPORT_ID_RE.test(String(r.id))) return "";
  const shots = (Array.isArray(e.shots) ? e.shots : []).filter((s) => s && SHOT_KEY_RE.test(String(s.key))).slice(0, 3);
  if (!shots.length) return "";
  const figs = shots.map((s) => {
    const src = `/api/reports/${r.id}/shots/${s.key}`;
    const page = isHttpUrl(s.page);
    const cap = s.caption && String(s.caption).trim() ? String(s.caption).trim() : "The page as a visitor sees it";
    return `<figure class="proof-shot"><a class="proof-shot-link" href="${esc(src)}" target="_blank" rel="noopener"><img loading="lazy" decoding="async" src="${esc(src)}" alt="${esc(cap)}"></a><figcaption><span class="cap">${esc(cap)}</span>${page ? ` &middot; ${pageLink(page, r)}` : ""}</figcaption></figure>`;
  }).join("");
  return `<p class="proof-k">What we saw on the page</p><div class="proof-shots">${figs}</div>`;
}

function retestBlock(f, e, r) {
  if (!r.id || !REPORT_ID_RE.test(String(r.id))) return "";
  const n = (Array.isArray(e.items) ? e.items : []).filter((it) => it && isHttpUrl(it.url)).length;
  if (!n) return "";
  return `<div class="proof-retest"><button type="button" class="btn btn-ghost btn-sm retest-btn" data-finding="${esc(f.id)}">Check this again right now</button><div class="retest-out" aria-live="polite"></div></div>`;
}

/* ---------------- the browsing agent ---------------- */
// Shown on findings the browsing agent noted. Its notes count in the tally but never move the grade.
function agentChip(f) {
  if (!f || f.source !== "agent") return "";
  return `<span class="agent-chip" title="Noted by our browsing agent while it explored this site in a real browser">${COMPASS}Browsing agent</span>`;
}

// Returns the normalized href when s is an absolute https URL, else null.
function isHttpsUrl(s) {
  if (s == null) return null;
  try { const u = new URL(String(s)); return u.protocol === "https:" ? u.href : null; } catch { return null; }
}

// The same page with and without a "#section" is one page in the list.
function dropFragment(href) {
  if (!href) return null;
  try { const u = new URL(href); u.hash = ""; return u.href; } catch { return null; }
}

const AGENT_SUMMARY_FALLBACK = "Our browsing agent opened this site in a real browser on a phone-sized screen and read it the way a visitor would.";
const AGENT_NOTES_LINE = "Its notes are labeled Browsing agent below. They count in the list but never change the grade.";

// The card under the scorecard: what the agent did, the pages it opened, and the session replay when there is one.
function agentCard(r) {
  const a = r && r.agent;
  if (!a || !a.ran) return "";
  const summary = a.summary != null && String(a.summary).trim() ? String(a.summary).trim() : AGENT_SUMMARY_FALLBACK;
  const base = reportBase(r);
  const seen = new Set();
  const pages = [];
  for (const v of Array.isArray(a.visited) ? a.visited : []) {
    if (v == null) continue;
    const href = dropFragment(isHttpUrl(v) || linkTarget(String(v).trim(), base));
    if (href && !seen.has(href)) { seen.add(href); pages.push(href); }
    if (pages.length >= 8) break;
  }
  const list = pages.length
    ? `<p class="agent-k">Pages it opened:</p><ul class="agent-pages">${pages.map((p) => `<li>${pageLink(p, r)}</li>`).join("")}</ul>`
    : "";
  const replay = isHttpsUrl(a.replayUrl);
  const watch = replay ? `<a class="agent-replay" href="${esc(replay)}" target="_blank" rel="noopener">${PLAY}Watch the session</a>` : "";
  // Agent notes are the model's own judgment, unlike the scripted findings the proof promise describes. Say so.
  const noted = (Array.isArray(r.findings) ? r.findings : []).some((f) => f && f.source === "agent");
  const note = noted ? `<p class="agent-note">${esc(AGENT_NOTES_LINE)}</p>` : "";
  return `<div class="agent-card"><span class="ac-icon">${COMPASS_LG}</span><div class="ac-body"><p class="eyebrow">Our browsing agent</p><p class="agent-summary">${esc(summary)}</p>${note}${list}${watch}</div></div>`;
}

function disputeChip(f) {
  if (!f.disputed) return "";
  return `<span class="dispute-chip">${FLAG}Visitors disputed this on earlier checkups</span>`;
}

function disputeBlock(f) {
  const d = f.disputed;
  if (!d) return "";
  const wrong = Number(d.wrong) || 0;
  const right = Number(d.right) || 0;
  const notes = (Array.isArray(d.notes) ? d.notes : []).filter((n) => n && String(n.text || "").trim()).slice(0, 3);
  const people = (n) => `${n} ${n === 1 ? "person" : "people"}`;
  const sum = `On earlier checkups of this site, ${people(wrong)} said this finding was wrong and ${people(right)} said it was right.`;
  const list = notes.length
    ? `<ul class="proof-said-list">${notes.map((n) => `<li><span class="q">${esc(String(n.text).trim())}</span>${n.when && agoText(n.when) ? ` <span class="when">${esc(agoText(n.when))}</span>` : ""}</li>`).join("")}</ul>`
    : "";
  return `<div class="proof-said"><p class="proof-k">What visitors said</p><p class="proof-said-sum">${esc(sum)}</p>${list}</div>`;
}

/* ---------------- check again right now ---------------- */
async function apiPost(path, body) {
  if (window.Sutros && typeof Sutros.api === "function") return Sutros.api(path, { method: "POST", body });
  const res = await fetch(path, {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
    body: JSON.stringify(body),
  });
  let data = null; try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error((data && data.error) || "Something went wrong.");
  return data;
}

async function retestFinding(btn) {
  const r = currentReport;
  const findingId = btn.dataset.finding;
  const out = btn.parentElement ? btn.parentElement.querySelector(".retest-out") : null;
  if (!r || !r.id || !findingId || !out) return;
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = "Checking...";
  out.innerHTML = "";
  try {
    const data = await apiPost(`/api/reports/${encodeURIComponent(r.id)}/retest`, { findingId });
    out.innerHTML = retestLines(data, r);
  } catch (err) {
    out.innerHTML = `<p class="retest-err">${esc((err && err.message) || "We could not check this right now. Please try again in a minute.")}</p>`;
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

function retestLines(data, r) {
  const items = Array.isArray(data && data.items) ? data.items : [];
  if (!items.length) return `<p class="retest-note">There was nothing to check again for this finding.</p>`;
  const lines = items.map((it) => {
    const href = isHttpUrl(it.url);
    const ref = href ? pageLink(href, r) : esc(it.url || "this address");
    const status = Number(it.status) || 0;
    const now = status ? `${status} ${it.statusText || ""}`.trim() : (it.statusText || "did not load");
    const tail = it.changed ? (it.ok ? "this one works now" : "this one worked when we checked") : "same as when we checked";
    return `<li class="retest-line ${it.ok ? "ok" : "bad"}">Right now: ${esc(now)} for ${ref} (${esc(tail)})</li>`;
  }).join("");
  const when = agoText(data.checkedAt) || "just now";
  return `<p class="retest-note">Checked ${esc(when)}.</p><ul class="retest-list">${lines}</ul>`;
}

function goodCard(passes) {
  const list = passes.map((p) => esc(String(p == null ? "" : p).replace(/\.+$/, ""))).join(". ") + ".";
  return `<div class="finding good"><div class="f-head"><span class="sev-chip good">${SEV.good.icon}All clear</span><div class="f-main"><h3>${passes.length} thing${passes.length > 1 ? "s are" : " is"} working well</h3><p class="f-mean">${list}</p></div></div></div>`;
}

function minorNotes(list, r) {
  const items = list.map((f) => {
    const ev = f.evidence || {};
    const lines = cleanLines(ev.lines);
    const where = lines.length
      ? `<div class="mn-block"><span class="mn-k">Where</span><ul class="mn-where">${lines.slice(0, 5).map((l) => `<li>${linkifyLine(l, r)}</li>`).join("")}</ul></div>`
      : "";
    const fix = f.fix && f.fix.length
      ? `<div class="mn-block"><span class="mn-k">How to fix it</span><ol class="mn-fix">${f.fix.map((st) => `<li>${esc(st)}</li>`).join("")}</ol>${f.who ? `<div class="mn-who">${PERSON} ${esc(f.who)}</div>` : ""}</div>`
      : "";
    const whyTech = ev.why ? `<div class="mn-block"><span class="mn-k">Why it's flagged</span><p class="mn-whytech">${esc(ev.why)}</p></div>` : "";
    return `<div class="mn-item"><h4>${esc(f.title)}${agentChip(f)}${disputeChip(f)}</h4><p class="mn-why">${esc(f.meaning)}</p>${where}${whyTech}${fix}${disputeBlock(f)}<div class="f-slot" data-finding="${esc(f.id)}"></div></div>`;
  }).join("");
  return `<details class="minor-notes"><summary><span>${list.length} minor note${list.length > 1 ? "s" : ""}</span> <span class="mn-hint">low priority. Each one says where it is, why it matters, and how to fix it.</span> ${CHEV}</summary><div class="mn-body">${items}</div></details>`;
}

function reassureBanner(hasMinor) {
  return `<div class="reassure-banner">
    <div class="rb-icon">${SEV.good.icon}</div>
    <div class="rb-body">
      <h3>No major issues found</h3>
      <p>${hasMinor
        ? "This website is in good shape. There is nothing urgent to fix. The items below are small, optional improvements that can wait for a convenient time."
        : "This website is in good shape and nothing needs attention right now. Nice work."}</p>
    </div>
  </div>`;
}

function applyRing() {
  if (!ringEl) return;
  ringEl.style.strokeDashoffset = String(RING_CIRC);
  requestAnimationFrame(() =>
    requestAnimationFrame(() => { ringEl.style.strokeDashoffset = String(ringTarget); })
  );
}

function gradeHeadline(r) {
  if (r.grade === "A") return "This website is in great shape";
  if (r.grade === "B") return "This website is in good shape";
  if (r.grade === "C") return "This website needs some care";
  if (r.grade === "D") return "This website needs some work";
  return "This website needs urgent help";
}
function whenText(iso) {
  if (!iso) return "just now";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  const mins = Math.round(diff / 60_000);
  return mins < 60 ? `${mins} min ago` : "today";
}
// "just now", "12 min ago", "3 hours ago", "2 days ago", "4 months ago". Empty for bad input.
function agoText(iso) {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const m = Math.round(Math.max(0, Date.now() - t) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  const mo = Math.round(d / 30);
  return `${mo} month${mo === 1 ? "" : "s"} ago`;
}

/* ---------------- printing: open every proof and load the screenshots first ---------------- */
let printOpened = null;
function prepareForPrint() {
  if (printOpened) return; // printReport() already ran this before window.print() fired beforeprint
  printOpened = $$("details.proof:not([open]), details.minor-notes:not([open])");
  printOpened.forEach((d) => { d.open = true; });
  $$(".proof-shot img").forEach((img) => { if (img.loading === "lazy") img.loading = "eager"; });
}
function restoreAfterPrint() {
  (printOpened || []).forEach((d) => { d.open = false; });
  printOpened = null;
}
async function printReport() {
  prepareForPrint();
  const pending = $$(".proof-shot img").filter((img) => !img.complete).map((img) =>
    new Promise((resolve) => { img.addEventListener("load", resolve, { once: true }); img.addEventListener("error", resolve, { once: true }); })
  );
  if (pending.length) await Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, 2500))]);
  window.print();
}
window.addEventListener("beforeprint", prepareForPrint);
window.addEventListener("afterprint", restoreAfterPrint);

/* ---------------- sample (offline demo) ---------------- */
const SAMPLE = {
  target: "rosastaqueria.com",
  url: "https://rosastaqueria.com",
  scannedAt: new Date().toISOString(),
  grade: "C", gradeLabel: "Needs care", score: 62, ringPercent: 62,
  tally: { urgent: 2, serious: 1, watch: 4, good: 0 },
  summary: "This site works for most visitors, but we found two urgent problems: a private file with customer info is visible to anyone, and the online order button leads to an error. The good news is both are fixable, and we've written down exactly how.",
  findings: [
    { id: "s1", severity: "urgent", category: "exposed-data", title: "A private file with customer info is visible to anyone", meaning: "A database backup is sitting on this site where anyone with the link can download it. It looks like it contains customer names, emails, and past orders. This is the kind of thing that leads to data leaks and scam emails to customers.", fix: ["Ask whoever manages the site to delete the file backup-db.sql from the server.", "Move future backups somewhere private, not inside the public website folder.", "If it was exposed a while, consider letting customers know as a precaution."], who: "A web person can do this in about 10 minutes.", evidence: { lines: ["GET https://rosastaqueria.com/backup-db.sql", "<- 200 OK   content-type: application/sql   size: 4.2 MB", "matched the shape of a real database backup (contents redacted, not stored)"], note: "Sutros confirmed the file is reachable and stopped. It did not download, keep, or read the contents.", method: "We requested /backup-db.sql directly, the way any visitor's browser would, and looked at the status and the first few bytes of the answer.", pages: ["https://rosastaqueria.com/"], items: [{ url: "https://rosastaqueria.com/backup-db.sql", status: 200, statusText: "OK", kind: "file" }], why: "The file is served to anyone who requests that exact address, and automated scanners request well-known backup paths like this one constantly. A database dump typically contains customer records and often password hashes, so one download is a full data breach.", confirm: "Open the address in a private browser window; the file downloads. Then have it removed." } },
    { id: "s2", severity: "urgent", category: "broken-flow", title: 'The "Order Online" button leads to an error', meaning: "When we tried to place an order the way a customer would, the page returned a server error instead of taking the order. The site may be losing sales right now without anyone knowing it.", fix: ["Open the order page to confirm the error.", "Show your web person this report; a server error usually points to a broken plugin.", "Ask them to test a full order end to end before calling it fixed."], who: "Your web person.", evidence: { lines: ["GET https://rosastaqueria.com/order", "<- 500 Internal Server Error"], note: 'Reproduced while following the "ordering" link from the homepage.', method: "We followed the Order Online link from the homepage and requested the order page with standard browser headers, then tried once more after a short wait.", pages: ["https://rosastaqueria.com/"], items: [{ url: "https://rosastaqueria.com/order", status: 500, statusText: "Internal Server Error", page: "https://rosastaqueria.com/", text: "Order Online", kind: "page" }], why: "A 500 status means the server's own code failed while handling the order. The console error 'cart.total is not a function' points at the ordering plugin: the code it expects is missing or a different version, so checkout cannot complete for anyone until it is repaired.", confirm: "Open the order page and try to place an order; you will see the error. Press F12 to see the same message in the Console tab." } },
    { id: "s3", severity: "serious", category: "outdated", title: "The website software looks out of date", meaning: "This site appears to run WordPress 5.8, an older version. Old software has publicly known break-in methods, and attackers try them automatically.", fix: ["Back up the site first.", "Update WordPress and all add-ons to their latest versions.", "Turn on automatic updates so it doesn't drift out of date again."], who: "The site owner from the WordPress dashboard, or a web person.", evidence: { lines: ["Detected: WordPress 5.8", "generator tag: WordPress 5.8", "Current major version is around 6.x"], note: "Version read from the page.", why: "Each WordPress release fixes security holes that are then publicly documented, so 5.8 means known, unpatched holes on this site. The contact-form add-on version also matches a published advisory. Attackers scan for these exact version strings and apply the matching exploit automatically.", confirm: "Log in to the WordPress dashboard; the Updates page shows the current version and pending updates." } },
    { id: "s4", severity: "watch", category: "tls", title: "The padlock can break on some pages", meaning: "The site is secure, but the order page loads one image over an unprotected connection. Browsers may show a 'Not secure' warning there, right before someone pays.", fix: ["Update that image to load over https instead of http."], who: "Your web person; a quick fix.", evidence: { lines: ["http://rosastaqueria.com/img/menu-3.jpg on a secure page"], note: "Insecure resource referenced on a secure page." } },
    { id: "s5", severity: "watch", category: "quality", title: "2 images are broken on mobile", meaning: "On phones, the tacos and horchata photos show a broken-image icon. Since most visitors are on phones, this is often the first thing they see.", fix: ["Re-upload the two menu photos; the originals were moved or deleted."], who: "The site owner can likely do this without help.", evidence: { lines: ["404 Not Found  /img/tacos.jpg  (image \"Tacos al pastor\" on /menu)", "404 Not Found  /img/horchata.jpg  (image \"Horchata\" on /menu)"], note: "2 broken of 10 images tested.", method: "We collected every image address on the pages we crawled, requested each one, and retried any refusal with standard browser headers before calling it broken.", pages: ["https://rosastaqueria.com/menu", "https://rosastaqueria.com/"], items: [{ url: "https://rosastaqueria.com/img/tacos.jpg", status: 404, statusText: "Not Found", page: "https://rosastaqueria.com/menu", text: "Tacos al pastor", kind: "image" }, { url: "https://rosastaqueria.com/img/horchata.jpg", status: 404, statusText: "Not Found", page: "https://rosastaqueria.com/menu", text: "Horchata", kind: "image" }] } },
    { id: "s6", severity: "watch", category: "performance", title: "This site is slow to load on a phone", meaning: "The homepage takes about 6 seconds to appear on a typical phone. Many people leave after three. The main cause is very large photos.", fix: ["Compress the homepage photos, or ask your web person to add an image optimizer."], who: "A web person; free tools can automate it.", evidence: { lines: ["homepage load: 6.1s on a simulated phone"], note: "Measured in a headless browser." } },
    { id: "agent-menu-photos-cover-the-prices-on-a-phone", source: "agent", severity: "watch", category: "quality", title: "Menu photos cover the prices on a phone", meaning: "On a phone-sized screen, each photo on the menu page sits on top of the price under it, so a visitor cannot see what things cost without turning the phone sideways.", fix: ["Ask the web person to check the menu page on a phone and let each photo stack above its price instead of over it."], who: "The owner or their web person.", evidence: { lines: ["https://rosastaqueria.com/menu", "Seen: the price under each photo was partly hidden on a 390 pixel wide screen"], pages: ["https://rosastaqueria.com/menu"], method: "Our browsing agent opened this page in a real browser on a phone-sized screen and read it the way a visitor would. It never typed or submitted anything.", note: "Seen by the browsing agent." } },
  ],
  passes: ["The homepage looks great and loads without errors", "The phone number and hours are correct and clickable", "The mobile menu opens smoothly", "The contact form sends properly", "None of the common private files were left exposed"],
  engine: { llm: true, model: "sample", orchestrator: "llm", reporter: "llm", focus: "Focusing on data exposure and the ordering flow.", checksRun: ["tls", "security", "exposedFiles", "flows", "links", "browser", "agent"], browser: { ran: true, skippedReason: null } },
  agent: { ran: true, mode: "local", steps: 8, visited: ["https://rosastaqueria.com/", "https://rosastaqueria.com/menu", "https://rosastaqueria.com/order", "https://rosastaqueria.com/contact"], summary: "This site works on a phone for the most part. The menu and hours are easy to find and the phone number can be tapped. The order page shows a server error, and the menu photos cover the prices on a small screen.", replayUrl: null },
};
function loadSample() {
  currentReport = SAMPLE;
  renderReport(SAMPLE);
  go("report");
}

/* ---------------- wiring ---------------- */
$("#brandBtn").addEventListener("click", () => go("home"));
$("#backBtn").addEventListener("click", () => go("home"));
$("#viewReportBtn").addEventListener("click", () => go("report"));
$("#sampleNav").addEventListener("click", loadSample);
$("#sampleBtn").addEventListener("click", loadSample);
$("#techBtn").addEventListener("click", () => {
  const p = $("#techPanel");
  p.classList.toggle("show");
  $("#techBtn").innerHTML = p.classList.contains("show") ? "Hide the technical version &uarr;" : "Show the technical version &rarr;";
});
$$("[data-nav]").forEach((b) =>
  b.addEventListener("click", () => { go("home"); scrollToId(b.dataset.nav); })
);
$("#nominateBtn").addEventListener("click", nominate);
$("#printBtn").addEventListener("click", printReport);
$("#findingsRoot").addEventListener("click", (e) => {
  const btn = e.target.closest && e.target.closest(".retest-btn");
  if (btn) retestFinding(btn);
});
$("#emailBtn").addEventListener("click", emailReport);
$("#helpersBtn").addEventListener("click", openHelpers);
$("#helpersBack").addEventListener("click", () => go(currentReport ? "report" : "home"));
$("#copyInvite").addEventListener("click", copyInvite);
$("#helperForm").addEventListener("submit", submitHelper);

$("#checkForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const url = $("#urlInput").value.trim();
  const err = $("#formErr");
  if (!url) {
    err.textContent = "Please enter a website address.";
    err.classList.add("show");
    return;
  }
  err.classList.remove("show");
  if (window.Sutros && Sutros.config && Sutros.config.requireAccount && !Sutros.requireLogin("/?url=" + encodeURIComponent(url))) return;
  const host = displayHost(url);
  Promise.resolve(window.Sutros ? Sutros.beforeCheckup(host) : true).then((ok) => { if (ok) startLive(url); });
});

$("#shareCopy").addEventListener("click", async () => {
  const link = $("#shareBox").dataset.link || "";
  try {
    await navigator.clipboard.writeText(link);
    $("#shareCopy").textContent = "Copied";
    setTimeout(() => { $("#shareCopy").textContent = "Copy"; }, 1500);
  } catch {
    prompt("Copy this link:", link);
  }
});

// Deep link: /r/<id> opens a saved report.
(function loadFromPath() {
  const m = location.pathname.match(/^\/r\/([A-Za-z0-9_-]{6,20})$/);
  if (!m) return;
  fetch(`/api/reports/${m[1]}`)
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error("not found"))))
    .then((report) => { currentReport = report; renderReport(report); go("report"); })
    .catch(() => {
      $("#formErr").textContent = "We couldn't find that saved report. It may have been removed.";
      $("#formErr").classList.add("show");
    });
})();


/* ---------------- nominate a business ---------------- */
let inviteText = "";
async function nominate() {
  const input = $("#nominateUrl");
  const url = (input.value || "").trim();
  const box = $("#nominateResult");
  if (!url) { input.focus(); return; }
  const btn = $("#nominateBtn");
  btn.disabled = true; btn.textContent = "Creating...";
  try {
    const res = await fetch("/api/nominate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not create the invite.");
    const link = `${location.origin}/?url=${encodeURIComponent(data.target)}`;
    inviteText =
      `Hi. I came across your website and ran it through Sutros, a free tool that gives a small-business site a quick, safe checkup (it only looks, never changes anything). ` +
      `You can run your own checkup here: ${link} . Thought it might be useful.`;
    $("#inviteMsg").textContent = inviteText;
    $("#inviteLink").href = link;
    box.hidden = false;
    box.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "nearest" });
  } catch (err) {
    $("#inviteMsg").textContent = "Sorry, that didn't work: " + err.message;
    box.hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = "Create an invite";
  }
}
async function copyInvite() {
  try { await navigator.clipboard.writeText(inviteText); $("#copyInvite").textContent = "Copied"; setTimeout(() => ($("#copyInvite").textContent = "Copy invite"), 1500); }
  catch { prompt("Copy this invite:", inviteText); }
}

/* ---------------- email this report ---------------- */
function emailReport() {
  const r = currentReport;
  if (!r) return;
  const link = r.id ? `${location.origin}/r/${r.id}` : location.href;
  const top = (r.findings || []).slice(0, 6).map((f) => `- [${sevWord(f.severity)}] ${f.title}`).join("\n");
  const subject = `Website checkup for ${r.target} (grade ${r.grade})`;
  const body =
    `Here is the Sutros checkup for ${r.target}.\n\n` +
    `Overall grade: ${r.grade} (${r.gradeLabel})\n\n` +
    `${r.summary}\n\n` +
    (top ? `Main findings:\n${top}\n\n` : "") +
    (r.id ? `Full report with fixes: ${link}\n` : "");
  window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
function sevWord(s) { return ({ urgent: "Urgent", serious: "Serious", watch: "Worth a look" }[s] || s); }

/* ---------------- helper directory ---------------- */
function openHelpers() { go("helpers"); loadHelpers(); }

async function loadHelpers() {
  const list = $("#helpersList");
  list.innerHTML = `<p class="helpers-empty">Loading...</p>`;
  try {
    const res = await fetch("/api/helpers");
    const data = await res.json();
    const helpers = data.helpers || [];
    if (!helpers.length) {
      list.innerHTML = `<div class="helpers-empty"><p>No helpers are listed yet. If you build or fix small-business websites, be the first below. In the meantime, you can email your report straight to your own web person from the report page.</p></div>`;
      return;
    }
    list.innerHTML = helpers.map(helperCard).join("");
  } catch {
    list.innerHTML = `<p class="helpers-empty">Could not load the directory right now.</p>`;
  }
}
function helperCard(h) {
  const isEmail = /^\S+@\S+\.\S+$/.test(h.contact || "");
  const href = isEmail ? `mailto:${esc(h.contact)}` : (/^https?:\/\//i.test(h.contact) ? esc(h.contact) : "#");
  return `<div class="helper-card">
    <div class="helper-head"><h3>${esc(h.name)}</h3>${h.area ? `<span class="helper-area">${esc(h.area)}</span>` : ""}</div>
    ${h.blurb ? `<p class="helper-blurb">${esc(h.blurb)}</p>` : ""}
    <a class="helper-contact" href="${href}"${isEmail ? "" : ' target="_blank" rel="noopener"'}>${esc(h.contact)}</a>
  </div>`;
}
async function submitHelper(e) {
  e.preventDefault();
  const err = $("#helperErr");
  const payload = {
    name: $("#hfName").value.trim(),
    contact: $("#hfContact").value.trim(),
    area: $("#hfArea").value.trim(),
    blurb: $("#hfBlurb").value.trim(),
  };
  if (!payload.name || !payload.contact) { err.textContent = "Please include a name and a way to reach you."; err.classList.add("show"); return; }
  err.classList.remove("show");
  try {
    const res = await fetch("/api/helpers", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not add you.");
    $("#helperForm").reset();
    loadHelpers();
  } catch (e2) {
    err.textContent = e2.message;
    err.classList.add("show");
  }
}

/* ---------------- prefill from an invite link (?url=) ---------------- */
(function prefillFromQuery() {
  const q = new URLSearchParams(location.search).get("url");
  if (q && $("#urlInput")) {
    $("#urlInput").value = q.replace(/^https?:\/\//i, "");
    history.replaceState(null, "", location.pathname);
  }
})();

/* ---------------- ambient palm leaves (sutras were written on palm leaves) ---------------- */
(function leaves() {
  const canvas = $("#leaves");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const COLORS = ["rgba(30,140,99,0.16)", "rgba(36,160,115,0.13)", "rgba(217,166,43,0.15)", "rgba(154,107,11,0.10)"];
  let W = 0, H = 0, dpr = 1, items = [], raf = 0, t = 0;

  function size() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function make(fresh) {
    const s = 16 + Math.random() * 26;
    return {
      x: fresh ? -60 : Math.random() * W,
      y: Math.random() * H,
      s,
      vx: 0.12 + Math.random() * 0.22,
      vy: 0.03 + Math.random() * 0.06,
      amp: 10 + Math.random() * 18,
      ph: Math.random() * Math.PI * 2,
      fq: 0.004 + Math.random() * 0.004,
      rot: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 0.006,
      c: COLORS[Math.floor(Math.random() * COLORS.length)],
    };
  }
  function leaf(l) {
    ctx.save();
    ctx.translate(l.x, l.y + Math.sin(t * l.fq + l.ph) * l.amp);
    ctx.rotate(l.rot + Math.sin(t * l.fq * 0.6 + l.ph) * 0.25);
    const s = l.s;
    ctx.beginPath();
    ctx.moveTo(0, -s);                                   // tip
    ctx.bezierCurveTo(s * 0.9, -s * 0.55, s * 0.75, s * 0.55, 0, s * 0.95);   // right edge
    ctx.bezierCurveTo(-s * 0.75, s * 0.55, -s * 0.9, -s * 0.55, 0, -s);       // left edge
    ctx.closePath();
    ctx.fillStyle = l.c;
    ctx.fill();
    ctx.beginPath();                                     // midrib
    ctx.moveTo(0, -s * 0.85); ctx.lineTo(0, s * 0.8);
    ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }
  function frame() {
    t += 1;
    ctx.clearRect(0, 0, W, H);
    for (const l of items) {
      l.x += l.vx; l.y += l.vy; l.rot += l.spin;
      if (l.x > W + 60 || l.y > H + 60) Object.assign(l, make(true), { y: Math.random() * H * 0.9 });
      leaf(l);
    }
    raf = requestAnimationFrame(frame);
  }
  function start() {
    size();
    const count = Math.max(8, Math.min(16, Math.round(W / 110)));
    items = Array.from({ length: count }, () => make(false));
    if (REDUCED) { ctx.clearRect(0, 0, W, H); items.forEach(leaf); return; } // static, no motion
    cancelAnimationFrame(raf);
    frame();
  }
  window.addEventListener("resize", () => { size(); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) cancelAnimationFrame(raf); else if (!REDUCED) frame();
  });
  start();
})();
