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
  });
  es.addEventListener("error", (e) => {
    let msg = "Something went wrong during the checkup. Please try again.";
    try { if (e.data) msg = JSON.parse(e.data).message; } catch {}
    es.close();
    if (!gotReport) onRunError(msg);
  });
  es.addEventListener("done", () => es.close());
  es.onerror = () => {
    es.close();
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

function renderReport(r) {
  const color = GRADE_COLOR[r.grade] || "var(--watch)";
  ringTarget = RING_CIRC * (1 - Math.max(0, Math.min(100, r.ringPercent || 0)) / 100);

  const chips = [];
  if (r.tally.urgent) chips.push(chip("urgent", r.tally.urgent, "urgent"));
  if (r.tally.serious) chips.push(chip("serious", r.tally.serious, "serious"));
  if (r.tally.watch) chips.push(chip("watch", r.tally.watch, "worth a look"));
  const goodCount = (r.passes || []).length;
  if (goodCount) chips.push(chip("good", goodCount, "looking good"));
  if (r.tally.minor) chips.push(chip("minor", r.tally.minor, "minor"));

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
      <div class="sc-tally">${chips.join("")}</div>
    </div>`;
  ringEl = $("#gradeRing");

  // engine badge
  const badge = $("#engineBadge");
  const usingLLM = r.engine && r.engine.reporter === "llm";
  badge.classList.toggle("off", !usingLLM);
  $("#engineText").textContent = usingLLM ? `AI report (${r.engine.model || "llm"})` : "Rule-based report";
  badge.title = r.engine
    ? `planner: ${r.engine.orchestrator}; writer: ${r.engine.reporter}; checks: ${(r.engine.checksRun || []).join(", ")}`
    : "";

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
  const fixFirst = r.findings.filter((f) => f.severity === "urgent" || f.severity === "serious");
  const watchList = r.findings.filter((f) => f.severity === "watch");
  const hasMajor = fixFirst.length > 0;
  let html = "";
  if (hasMajor) {
    // Lead with the things that actually matter.
    html += `<p class="eyebrow">Fix these first</p>` + fixFirst.map(findingCard).join("");
    if (watchList.length) html += `<p class="eyebrow" style="margin-top:14px;">Then, smaller things worth a look</p>` + watchList.map(findingCard).join("");
  } else {
    // No urgent or serious problems: reassure first, then frame the rest as optional.
    html += reassureBanner(watchList.length > 0);
    if (watchList.length) html += `<p class="eyebrow" style="margin-top:14px;">Optional improvements (nice to have, not urgent)</p>` + watchList.map(findingCard).join("");
  }
  if (goodCount) {
    html += `<p class="eyebrow" style="margin-top:14px;">Looking good</p>` + goodCard(r.passes);
  }
  const minorList = r.findings.filter((f) => f.severity === "minor");
  if (minorList.length) html += minorNotes(minorList);
  if (!r.findings.length && !goodCount && !minorList.length) {
    html += reassureBanner(false);
  }
  $("#findingsRoot").innerHTML = html;
}

function chip(cls, n, label) {
  return `<span class="tally ${cls}"><span class="n">${esc(n)}</span> ${esc(label)}</span>`;
}

function findingCard(f) {
  const meta = SEV[f.severity] || SEV.watch;
  const fixes = (f.fix || []).map((step) => `<li>${esc(step)}</li>`).join("");
  const ev = f.evidence;
  const proof = ev
    ? `<details class="proof"><summary><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/></svg> Show the technical proof <svg class="chev" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M9 18l6-6-6-6"/></svg></summary><div class="proof-body">${ev.why ? `<p class="proof-why"><b>Why this is a problem.</b> ${esc(ev.why)}</p>` : ""}<p class="proof-k">What we observed</p><pre>${esc((ev.lines || []).join("\n"))}</pre>${ev.confirm ? `<p class="proof-confirm"><b>See it yourself.</b> ${esc(ev.confirm)}</p>` : ""}<p class="proof-note">${esc(ev.note || "")}</p></div></details>`
    : "";
  return `
    <div class="finding ${esc(f.severity)}">
      <div class="f-head">
        <span class="sev-chip ${esc(f.severity)}">${meta.icon}${esc(meta.label)}</span>
        <div class="f-main">
          <h3>${esc(f.title)}</h3>
          <p class="f-mean">${esc(f.meaning)}</p>
        </div>
      </div>
      ${fixes ? `<div class="f-fix"><div class="fx-label">${WRENCH}How to fix it</div><ol>${fixes}</ol>${f.who ? `<div class="who">${PERSON} ${esc(f.who)}</div>` : ""}</div>` : ""}
      ${proof}
    </div>`;
}

function goodCard(passes) {
  const list = passes.map((p) => esc(p.replace(/\.+$/, ""))).join(". ") + ".";
  return `<div class="finding good"><div class="f-head"><span class="sev-chip good">${SEV.good.icon}All clear</span><div class="f-main"><h3>${passes.length} thing${passes.length > 1 ? "s are" : " is"} working well</h3><p class="f-mean">${list}</p></div></div></div>`;
}

function minorNotes(list) {
  const items = list.map((f) => {
    const where = f.evidence && f.evidence.lines && f.evidence.lines.length
      ? `<div class="mn-block"><span class="mn-k">Where</span><ul class="mn-where">${f.evidence.lines.slice(0, 5).map((l) => `<li>${esc(l)}</li>`).join("")}</ul></div>`
      : "";
    const fix = f.fix && f.fix.length
      ? `<div class="mn-block"><span class="mn-k">How to fix it</span><ol class="mn-fix">${f.fix.map((st) => `<li>${esc(st)}</li>`).join("")}</ol>${f.who ? `<div class="mn-who">${PERSON} ${esc(f.who)}</div>` : ""}</div>`
      : "";
    const whyTech = f.evidence && f.evidence.why ? `<div class="mn-block"><span class="mn-k">Why it's flagged</span><p class="mn-whytech">${esc(f.evidence.why)}</p></div>` : "";
    return `<div class="mn-item"><h4>${esc(f.title)}</h4><p class="mn-why">${esc(f.meaning)}</p>${where}${whyTech}${fix}</div>`;
  }).join("");
  return `<details class="minor-notes"><summary><span>${list.length} minor note${list.length > 1 ? "s" : ""}</span> <span class="mn-hint">low priority. Each one says where it is, why it matters, and how to fix it.</span> <svg class="chev" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M9 18l6-6-6-6"/></svg></summary><div class="mn-body">${items}</div></details>`;
}

function reassureBanner(hasMinor) {
  return `<div class="reassure-banner">
    <div class="rb-icon">${SEV.good.icon}</div>
    <div class="rb-body">
      <h3>No major issues found</h3>
      <p>${hasMinor
        ? "Your website is in good shape. There's nothing urgent to fix. The items below are small, optional improvements you can get to whenever it's convenient."
        : "Your website is in good shape and nothing needs your attention right now. Nice work."}</p>
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
  if (r.grade === "A") return "Your website is in great shape";
  if (r.grade === "B") return "Your website is in good shape";
  if (r.grade === "C") return "Your website needs some care";
  if (r.grade === "D") return "Your website needs some work";
  return "Your website needs urgent help";
}
function whenText(iso) {
  if (!iso) return "just now";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  const mins = Math.round(diff / 60_000);
  return mins < 60 ? `${mins} min ago` : "today";
}

/* ---------------- sample (offline demo) ---------------- */
const SAMPLE = {
  target: "rosastaqueria.com",
  url: "https://rosastaqueria.com",
  scannedAt: new Date().toISOString(),
  grade: "C", gradeLabel: "Needs care", score: 62, ringPercent: 62,
  tally: { urgent: 2, serious: 1, watch: 3, good: 0 },
  summary: "Your site works for most visitors, but we found two urgent problems: a private file with customer info is visible to anyone, and your online order button leads to an error. The good news is both are fixable, and we've written down exactly how.",
  findings: [
    { id: "s1", severity: "urgent", category: "exposed-data", title: "A private file with customer info is visible to anyone", meaning: "A database backup is sitting on your website where anyone with the link can download it. It looks like it contains customer names, emails, and past orders. This is the kind of thing that leads to data leaks and scam emails to your customers.", fix: ["Ask whoever manages your site to delete the file backup-db.sql from the server.", "Move future backups somewhere private, not inside the public website folder.", "If it was exposed a while, consider letting customers know as a precaution."], who: "A web person can do this in about 10 minutes.", evidence: { lines: ["GET https://rosastaqueria.com/backup-db.sql", "<- 200 OK   content-type: application/sql   size: 4.2 MB", "matched the shape of a real database backup (contents redacted, not stored)"], note: "Sutros confirmed the file is reachable and stopped. It did not download, keep, or read the contents." } },
    { id: "s2", severity: "urgent", category: "broken-flow", title: 'Your "Order Online" button leads to an error', meaning: "When we tried to place an order the way a customer would, the page returned a server error instead of taking the order. You may be losing sales right now without knowing it.", fix: ["Open your order page yourself to confirm the error.", "Show your web person this report; a server error usually points to a broken plugin.", "Ask them to test a full order end to end before calling it fixed."], who: "Your web person.", evidence: { lines: ["GET https://rosastaqueria.com/order", "<- 500 Internal Server Error"], note: 'Reproduced while following the "ordering" link from your homepage.', why: "A 500 status means the server's own code failed while handling the order. The console error 'cart.total is not a function' points at the ordering plugin: the code it expects is missing or a different version, so checkout cannot complete for anyone until it is repaired.", confirm: "Open the order page and try to place an order; you will see the error. Press F12 to see the same message in the Console tab." } },
    { id: "s3", severity: "serious", category: "outdated", title: "Your website software looks out of date", meaning: "Your site appears to run WordPress 5.8, an older version. Old software has publicly known break-in methods, like a lock everyone already knows how to pick.", fix: ["Back up your site first.", "Update WordPress and all add-ons to their latest versions.", "Turn on automatic updates so it doesn't drift out of date again."], who: "You (from the dashboard) or your web person.", evidence: { lines: ["Detected: WordPress 5.8", "generator tag: WordPress 5.8", "Current major version is around 6.x"], note: "Version read from the page.", why: "Each WordPress release fixes security holes that are then publicly documented, so 5.8 means known, unpatched holes on this site. The contact-form add-on version also matches a published advisory. Attackers scan for these exact version strings and apply the matching exploit automatically.", confirm: "Log in to the WordPress dashboard; the Updates page shows the current version and pending updates." } },
    { id: "s4", severity: "watch", category: "tls", title: "The padlock can break on some pages", meaning: "Your site is secure, but the order page loads one image over an unprotected connection. Browsers may show a 'Not secure' warning there, right before someone pays.", fix: ["Update that image to load over https instead of http."], who: "Your web person; a quick fix.", evidence: { lines: ["http://rosastaqueria.com/img/menu-3.jpg on a secure page"], note: "Insecure resource referenced on a secure page." } },
    { id: "s5", severity: "watch", category: "quality", title: "2 images are broken on mobile", meaning: "On phones, the tacos and horchata photos show a broken-image icon. Since most of your visitors are on phones, this is often the first thing they see.", fix: ["Re-upload the two menu photos; the originals were moved or deleted."], who: "You can likely do this yourself.", evidence: { lines: ["/img/tacos.jpg", "/img/horchata.jpg"], note: "2 broken of 10 images sampled." } },
    { id: "s6", severity: "watch", category: "performance", title: "Your site is slow to load on a phone", meaning: "Your homepage takes about 6 seconds to appear on a typical phone. Many people leave after three. The main cause is very large photos.", fix: ["Compress the homepage photos, or ask your web person to add an image optimizer."], who: "A web person; free tools can automate it.", evidence: { lines: ["homepage load: 6.1s on a simulated phone"], note: "Measured in a headless browser." } },
  ],
  passes: ["Your homepage looks great and loads without errors", "Your phone number and hours are correct and clickable", "The mobile menu opens smoothly", "Your contact form sends properly", "None of the common private files were left exposed"],
  engine: { llm: true, model: "sample", orchestrator: "llm", reporter: "llm", focus: "Focusing on data exposure and the ordering flow.", checksRun: ["tls", "security", "exposedFiles", "flows", "links", "browser"], browser: { ran: true, skippedReason: null } },
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
$("#printBtn").addEventListener("click", () => window.print());
$("#emailBtn").addEventListener("click", emailReport);
$("#helpersBtn").addEventListener("click", openHelpers);
$("#helpersBack").addEventListener("click", () => go(currentReport ? "report" : "home"));
$("#copyInvite").addEventListener("click", copyInvite);
$("#helperForm").addEventListener("submit", submitHelper);

$("#checkForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const url = $("#urlInput").value.trim();
  const consent = $("#consent").checked;
  const err = $("#formErr");
  if (!url || !consent) {
    err.textContent = "Please enter a website and confirm you have permission.";
    err.classList.add("show");
    return;
  }
  err.classList.remove("show");
  startLive(url);
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not create the invite.");
    const link = `${location.origin}/?url=${encodeURIComponent(data.target)}`;
    inviteText =
      `Hi! I came across your website and ran it through Sutros, a free tool that gives a small-business site a quick, safe checkup (it only looks, never changes anything). ` +
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
      headers: { "Content-Type": "application/json" },
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
