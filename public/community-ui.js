// community-ui.js  Community bulletin, verify page, recent checkups, dedup prompt, and report extras.
// Runs after core.js, app.js, and auth-ui.js. Everything it puts into innerHTML goes through esc().
(function () {
  const S = window.Sutros;
  if (!S) return;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const ID_RE = "([A-Za-z0-9_-]{6,40})";
  const TEN_MIN = 10 * 60_000;

  /* ---------------- small helpers ---------------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }
  function safeUrl(u) {
    const s = String(u || "").trim();
    return /^https?:\/\/[^\s"'<>]+$/i.test(s) && s.length <= 500 ? s : null;
  }
  function safeEmail(e) {
    const s = String(e || "").trim();
    return /^[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+$/.test(s) && s.length <= 200 ? s : null;
  }
  function safePath(p) {
    const s = String(p || "");
    return /^\/(?!\/)[A-Za-z0-9_\-./?=&%]*$/.test(s) ? s : "/";
  }
  function publicOrigin() {
    const fromConfig = S.config && typeof S.config.appUrl === "string" ? S.config.appUrl.trim().replace(/\/+$/, "") : "";
    return /^https?:\/\/[^\s"'<>]+$/i.test(fromConfig) ? fromConfig : location.origin;
  }
  function clip(s, n) {
    s = String(s == null ? "" : s);
    return s.length > n ? s.slice(0, n - 1).trimEnd() + "..." : s;
  }
  function fmtDate(iso) {
    const d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  function ago(iso) {
    const d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return "";
    const diff = Date.now() - d.getTime();
    if (diff < 60_000) return "just now";
    const mins = Math.round(diff / 60_000);
    if (mins < 60) return mins + " min ago";
    const hours = Math.round(mins / 60);
    if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
    const days = Math.round(hours / 24);
    if (days < 7) return days + (days === 1 ? " day ago" : " days ago");
    return fmtDate(iso);
  }
  function gradeLetter(g) {
    const l = String(g || "").toUpperCase();
    return /^[A-F]$/.test(l) ? l : "?";
  }
  function gradeChip(g, small) {
    const l = gradeLetter(g);
    return `<span class="cu-grade cu-grade-${l}${small ? " sm" : ""}" aria-label="Grade ${esc(l)}">${esc(l)}</span>`;
  }
  const SEV_LABEL = { urgent: "Urgent", serious: "Serious", watch: "Worth a look", minor: "Minor", good: "All clear" };
  const SEV_ORDER = { urgent: 0, serious: 1, watch: 2, minor: 3, good: 4 };
  function sevChip(sev) {
    const s = SEV_LABEL[sev] ? sev : "watch";
    return `<span class="sev-chip ${esc(s)}">${esc(SEV_LABEL[s])}</span>`;
  }
  function topFindings(findings, n) {
    return (Array.isArray(findings) ? findings.slice() : [])
      .filter((f) => f && f.severity !== "good")
      .sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9))
      .slice(0, n);
  }
  const STATUS_LABEL = { open: "Open", claimed: "Someone is on it", resolved: "Resolved" };
  function statusPill(status) {
    const s = STATUS_LABEL[status] ? status : "open";
    return `<span class="cu-status cu-status-${esc(s)}">${esc(STATUS_LABEL[s])}</span>`;
  }
  function personName(by) {
    return (by && by.name && String(by.name).trim()) || "A Sutros member";
  }
  function avatar(by) {
    const url = by && safeUrl(by.avatarUrl);
    if (url) return `<img class="cu-avatar" src="${esc(url)}" alt="" referrerpolicy="no-referrer">`;
    const initial = personName(by).trim().charAt(0).toUpperCase() || "S";
    return `<span class="cu-avatar-fallback" aria-hidden="true">${esc(initial)}</span>`;
  }
  function plural(n, one, many) {
    n = Number(n) || 0;
    return n + " " + (n === 1 ? one : many);
  }
  function isAdmin() { return Boolean(S.user && S.user.role === "admin"); }
  function isVerified() { return Boolean(S.user && S.user.emailVerified); }
  async function copyText(text, btn, doneLabel) {
    const label = btn ? btn.textContent : "";
    try {
      await navigator.clipboard.writeText(text);
      if (btn) { btn.textContent = doneLabel || "Copied"; setTimeout(() => { btn.textContent = label; }, 1600); }
    } catch {
      prompt("Copy this:", text);
    }
  }
  function b64ToBytes(s) {
    s = String(s || "").replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
    while (s.length % 4) s += "=";
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const ICON_BACK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>';
  const ICON_OK = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>';
  const ICON_BAD = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>';

  /* ---------------- module styles ---------------- */
  const style = document.createElement("style");
  style.id = "communityUiStyles";
  style.textContent = `
.cu-head{max-width:640px;margin:0 0 26px}
.cu-head h2{font-size:clamp(26px,3.6vw,34px);margin-bottom:10px}
.cu-head p{color:var(--ink-soft);font-size:17px}
.cu-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:20px}
.cu-sort{display:inline-flex;background:var(--surface-2);border:1px solid var(--border);border-radius:100px;padding:4px}
.cu-sort button{border:0;background:none;font-weight:700;font-size:14px;color:var(--ink-soft);padding:8px 16px;border-radius:100px;cursor:pointer}
.cu-sort button[aria-pressed="true"]{background:var(--surface);color:var(--ink);box-shadow:0 2px 8px rgb(var(--shadow)/.12)}
.cu-hint{font-size:14px;color:var(--ink-soft)}
.cu-hint a{color:var(--brand);font-weight:600}
a.back-btn{text-decoration:none}
.cu-list{display:flex;flex-direction:column;gap:16px}
.cu-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:22px 24px;display:flex;flex-direction:column;gap:14px}
.cu-card-top{display:flex;gap:16px;align-items:flex-start}
.cu-card-main{flex:1;min-width:0}
.cu-card-main h3{font-size:20px;margin-bottom:4px;word-break:break-word}
.cu-card-main h3 a{text-decoration:none}
.cu-card-main h3 a:hover{color:var(--brand)}
.cu-meta{font-size:13.5px;color:var(--ink-faint);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cu-grade{flex:none;width:46px;height:46px;border-radius:12px;display:grid;place-items:center;font-weight:700;font-size:22px;color:#fff;background:var(--ink-faint);line-height:1}
.cu-grade.sm{width:34px;height:34px;font-size:16px;border-radius:9px}
.cu-grade-A,.cu-grade-B{background:var(--good)}
.cu-grade-C{background:var(--watch);color:var(--watch-text)}
.cu-grade-D{background:var(--serious)}
.cu-grade-F{background:var(--urgent)}
.cu-status{flex:none;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:6px 11px;border-radius:100px;background:var(--ground-2);color:var(--ink-soft);white-space:nowrap}
.cu-status-claimed{background:var(--watch-bg);color:var(--watch-text)}
.cu-status-resolved{background:var(--good-bg);color:var(--good)}
.cu-note{font-size:15.5px;color:var(--ink);background:var(--surface-2);border-left:3px solid var(--glow);padding:10px 14px;border-radius:0 10px 10px 0;white-space:pre-wrap;word-break:break-word}
.cu-findings{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.cu-findings li{display:flex;gap:10px;align-items:center;font-size:15px;color:var(--ink-soft)}
.cu .sev-chip.minor{background:var(--ground-2);color:var(--ink-faint)}
.cu-card-foot{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;font-size:14px;color:var(--ink-soft);border-top:1px solid var(--border);padding-top:14px}
.btn-sm{padding:9px 16px;font-size:14px;border-radius:10px}
.cu-empty{color:var(--ink-soft);font-size:15.5px;background:var(--surface-2);border:1px dashed var(--border-strong);border-radius:var(--radius);padding:26px;text-align:center}
.cu-more{margin-top:22px;text-align:center}
.cu-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:start}
.cu-stack{display:flex;flex-direction:column;gap:20px;min-width:0}
.cu-panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:22px 24px;min-width:0}
.cu-panel h3{font-size:19px;margin-bottom:8px}
.cu-panel > p{color:var(--ink-soft);font-size:15px;margin-bottom:12px}
.cu-panel .eyebrow{margin-bottom:8px}
.cu-textarea,.cu-input,.cu-select{width:100%;background:var(--surface-2);border:1.5px solid var(--border-strong);border-radius:10px;padding:12px 14px;font-size:15px;color:var(--ink);outline:none;font-family:inherit}
.cu-textarea{min-height:120px;resize:vertical;line-height:1.5}
.cu-textarea:focus,.cu-input:focus,.cu-select:focus{border-color:var(--glow)}
.cu-select{width:auto;padding:8px 12px;font-weight:600}
.cu-form{display:flex;flex-direction:column;gap:12px}
.cu-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:12px}
.cu-contacts{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;font-size:15px}
.cu-contacts a{color:var(--brand);font-weight:600;word-break:break-all}
.cu-offer{border-top:1px solid var(--border);padding:14px 0}
.cu-offer:first-child{border-top:0;padding-top:0}
.cu-offer:last-child{padding-bottom:0}
.cu-offer-head{display:flex;align-items:center;gap:10px;font-size:14px;color:var(--ink-faint);margin-bottom:6px;flex-wrap:wrap}
.cu-offer-head b{color:var(--ink)}
.cu-offer-head .cu-link-btn{margin-left:auto}
.cu-offer p{white-space:pre-wrap;word-break:break-word;font-size:15px;color:var(--ink-soft)}
.cu-offer .cu-offer-contact{margin-top:6px;font-size:14px}
.cu-offer .cu-offer-contact a{color:var(--brand);font-weight:600;word-break:break-all}
.cu-avatar{width:24px;height:24px;border-radius:50%;object-fit:cover;background:var(--ground-2);flex:none}
.cu-avatar-fallback{width:24px;height:24px;border-radius:50%;display:inline-grid;place-items:center;background:var(--ground-2);color:var(--ink-soft);font-size:12px;font-weight:700;flex:none}
.cu-link-btn{background:none;border:0;color:var(--ink-faint);font-size:13.5px;font-weight:600;cursor:pointer;padding:4px 0;text-decoration:underline;font-family:inherit}
.cu-link-btn:hover{color:var(--ink)}
.cu-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:12px 14px;white-space:pre-wrap;word-break:break-all;color:var(--ink);margin:0;line-height:1.5}
.cu-extras{margin-top:24px;display:grid;grid-template-columns:1fr 1fr;gap:16px}
.cu-badge-preview{display:inline-block;margin:0 0 12px;line-height:0}
.cu-badge-preview img{height:40px;width:auto;max-width:100%}
.cu-verify-status{display:flex;gap:14px;align-items:flex-start;border-radius:var(--radius);padding:20px 22px;border:1px solid var(--border);background:var(--surface);margin-bottom:20px}
.cu-verify-status .ic{flex:none;width:38px;height:38px;border-radius:50%;display:grid;place-items:center;background:var(--ground-2);color:var(--ink-soft)}
.cu-verify-status.ok{background:var(--good-bg);border-color:color-mix(in srgb,var(--good) 30%,transparent)}
.cu-verify-status.ok .ic{background:color-mix(in srgb,var(--good) 22%,transparent);color:var(--good)}
.cu-verify-status.ok h2{color:var(--good)}
.cu-verify-status.bad{background:var(--serious-bg);border-color:color-mix(in srgb,var(--serious) 30%,transparent)}
.cu-verify-status.bad .ic{background:color-mix(in srgb,var(--serious) 18%,transparent);color:var(--serious)}
.cu-verify-status.bad h2{color:var(--serious)}
.cu-verify-status h2{font-size:22px;margin-bottom:6px}
.cu-verify-status p{color:var(--ink-soft);font-size:15px}
.cu-kv{display:grid;grid-template-columns:max-content 1fr;gap:8px 18px;font-size:15px;margin:0}
.cu-kv dt{color:var(--ink-faint);font-weight:600}
.cu-kv dd{margin:0;word-break:break-all}
.cu-kv dd a{color:var(--brand);font-weight:600}
.cu-dedup{margin-top:16px;padding:16px;background:var(--surface-2);border:1px solid var(--glow);border-radius:12px;font-size:14.5px;color:var(--ink-soft);line-height:1.5}
.cu-dedup b{color:var(--ink)}
.cu-dedup-row{display:flex;align-items:center;gap:12px;margin:12px 0}
.cu-dedup-row .cu-meta{font-size:13.5px}
.checkcard .cu-dedup .btn{margin-top:0;width:auto}
.cu-recent-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px}
.cu-recent{display:flex;gap:12px;align-items:center;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:14px 16px;text-decoration:none;color:inherit;transition:border-color .2s,transform .15s var(--step);min-width:0}
.cu-recent:hover{border-color:var(--glow);transform:translateY(-2px)}
.cu-recent .rb{min-width:0}
.cu-recent .t{font-weight:700;font-size:15px;word-break:break-all;line-height:1.3}
.cu-recent .m{font-size:12.5px;color:var(--ink-faint)}
.cu-inline-msg{font-size:14px;color:var(--ink-soft);margin-top:10px}
.cu-inline-msg.ok{color:var(--good);font-weight:600}
.cu-inline-msg.bad{color:var(--serious);font-weight:600}
.cu-signin{background:var(--surface-2);border:1px dashed var(--border-strong);border-radius:12px;padding:18px;text-align:center;font-size:15px;color:var(--ink-soft);display:flex;flex-direction:column;gap:12px;align-items:center}
.cu-status-ctl{display:flex;align-items:center;gap:10px;font-size:14px;font-weight:600;color:var(--ink-soft);flex-wrap:wrap}
.cu-summary{font-size:16px;color:var(--ink-soft);margin:12px 0 0}
.cu-tally{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
.cu-target{font-size:clamp(22px,3vw,28px);word-break:break-all;margin-bottom:6px}
@media(max-width:820px){.cu-grid,.cu-extras{grid-template-columns:1fr}}
@media(max-width:540px){.cu-card-top{flex-wrap:wrap}.cu-kv{grid-template-columns:1fr;gap:2px 0}.cu-kv dd{margin-bottom:8px}}
@media print{.cu-extras{display:none !important}}
`;
  document.head.appendChild(style);

  /* ---------------- screens ---------------- */
  function screen(id) {
    let el = document.getElementById(id);
    if (el) return el;
    el = document.createElement("div");
    el.className = "screen";
    el.id = id;
    const host = document.getElementById("screens-extra") || document.body;
    host.appendChild(el);
    return el;
  }
  const bulletinScreen = screen("screen-bulletin");
  const postScreen = screen("screen-bulletin-post");
  const verifyScreen = screen("screen-verify");

  function shell(inner) {
    return `<section class="report"><div class="wrap cu">${inner}</div></section>`;
  }
  function backLink(href, label) {
    return `<a class="back-btn" href="${esc(safePath(href))}" data-spa>${ICON_BACK} ${esc(label)}</a>`;
  }
  function isActive(el) { return el.classList.contains("is-active"); }

  // In-app links: <a data-spa href="/path"> use the router instead of a full page load.
  document.addEventListener("click", (e) => {
    const a = e.target && e.target.closest ? e.target.closest("a[data-spa]") : null;
    if (!a) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    const href = a.getAttribute("href") || "";
    if (!href.startsWith("/") || href.startsWith("//")) return;
    e.preventDefault();
    S.navigate(href);
  });

  /* ---------------- opening a saved report inside the SPA ---------------- */
  let bootDispatchPending = true;
  S.ready.then(() => Promise.resolve().then(() => { bootDispatchPending = false; }));

  async function openReport(id) {
    const canRender = typeof window.renderReport === "function" && typeof window.go === "function";
    if (!canRender) { location.href = "/r/" + id; return; }
    try {
      if (typeof currentReport !== "undefined" && currentReport && currentReport.id === id) { go("report"); return; }
    } catch {}
    try {
      const report = await S.api("/api/reports/" + encodeURIComponent(id));
      try { currentReport = report; } catch {}
      renderReport(report);
      go("report");
    } catch (err) {
      S.toast(err.status === 404 ? "We couldn't find that report. It may have been removed." : "We couldn't load that report right now.");
    }
  }

  /* ---------------- routes ---------------- */
  S.route(/^\/$/, () => {
    if (typeof window.go === "function") go("home"); else S.showScreen("screen-home");
  });
  S.route(new RegExp("^/r/" + ID_RE + "/?$"), (m) => {
    if (bootDispatchPending) return; // app.js already loads a report from the URL on first paint
    openReport(m[1]);
  });
  S.route(/^\/bulletin\/?$/, (_m, q) => renderBulletin(q.get("sort") === "worst" ? "worst" : "new"));
  S.route(new RegExp("^/b/" + ID_RE + "/?$"), (m) => renderPost(m[1]));
  S.route(new RegExp("^/verify/" + ID_RE + "/?$"), (m) => renderVerify(m[1]));

  /* ================= BULLETIN LIST ================= */
  // token changes on every render; a fetch that finishes with a stale token is ignored
  const bulletinState = { sort: "new", page: 1, hasMore: false, loading: false, posts: [], token: 0 };

  function bulletinCard(p) {
    const r = p.report || {};
    const findings = Array.isArray(r.topFindings) ? r.topFindings.slice(0, 3) : [];
    const note = p.note && String(p.note).trim();
    const score = Number.isFinite(Number(r.score)) ? Number(r.score) : null;
    return `
      <article class="cu-card">
        <div class="cu-card-top">
          ${gradeChip(r.grade)}
          <div class="cu-card-main">
            <h3><a href="/b/${esc(p.id)}" data-spa>${esc(r.target || "Unknown site")}</a></h3>
            <div class="cu-meta">
              ${score !== null ? `<span>Score ${esc(score)} of 100</span><span>&middot;</span>` : ""}
              <span>Posted ${esc(ago(p.createdAt))} by ${esc(personName(p.by))}</span>
            </div>
          </div>
          ${statusPill(p.status)}
        </div>
        ${note ? `<p class="cu-note">${esc(clip(note, 500))}</p>` : ""}
        ${findings.length ? `<ul class="cu-findings">${findings.map((f) => `<li>${sevChip(f.severity)}<span>${esc(f.title)}</span></li>`).join("")}</ul>` : `<p class="cu-summary" style="margin:0">${esc(clip(r.summary || "No major issues were listed for this site.", 240))}</p>`}
        <div class="cu-card-foot">
          <span>${esc(plural(p.offersCount, "offer to help", "offers to help"))}</span>
          <a class="btn btn-ghost btn-sm" href="/b/${esc(p.id)}" data-spa>See details and offer help</a>
        </div>
      </article>`;
  }

  function renderBulletin(sort) {
    bulletinState.sort = sort;
    bulletinState.page = 1;
    bulletinState.posts = [];
    bulletinState.loading = false;
    const token = ++bulletinState.token;
    bulletinScreen.innerHTML = shell(`
      <div class="report-top">
        ${backLink("/", "Home")}
        <span class="eyebrow" style="margin:0;">Community bulletin</span>
      </div>
      <div class="cu-head">
        <h2>Sites that could use a hand</h2>
        <p>People post checkups here for local sites that need some care. If you build or fix websites, pick one and offer to help. The site owner decides what happens next.</p>
      </div>
      <div class="cu-toolbar">
        <div class="cu-sort" role="group" aria-label="Sort the bulletin">
          <button type="button" data-sort="new" aria-pressed="${sort === "new"}">Newest</button>
          <button type="button" data-sort="worst" aria-pressed="${sort === "worst"}">Needs the most help</button>
        </div>
        <p class="cu-hint">Want to add a site? <a href="/" data-spa>Run a checkup</a>, then post it from the report page.</p>
      </div>
      <div id="cuBulletinList" class="cu-list"><p class="cu-empty">Loading the bulletin...</p></div>
      <div class="cu-more"><button class="btn btn-ghost" id="cuMore" type="button" hidden>Show more</button></div>
    `);
    S.showScreen("screen-bulletin");
    bulletinScreen.querySelectorAll("[data-sort]").forEach((b) =>
      b.addEventListener("click", () => {
        const next = b.dataset.sort === "worst" ? "worst" : "new";
        if (next === bulletinState.sort) return;
        history.replaceState(null, "", next === "new" ? "/bulletin" : "/bulletin?sort=worst");
        renderBulletin(next);
      })
    );
    $("#cuMore", bulletinScreen).addEventListener("click", () => loadBulletinPage(bulletinState.page + 1));
    loadBulletinPage(1, token);
  }

  async function loadBulletinPage(page, token) {
    // Page 1 always runs (a fresh render may be replacing an in-flight one).
    // "Show more" is guarded by the disabled button plus the loading flag.
    if (page > 1 && bulletinState.loading) return;
    if (token === undefined) token = bulletinState.token;
    bulletinState.loading = true;
    const list = $("#cuBulletinList", bulletinScreen);
    const more = $("#cuMore", bulletinScreen);
    const sort = bulletinState.sort;
    if (more) { more.disabled = true; more.textContent = "Loading..."; }
    const stale = () => token !== bulletinState.token || !isActive(bulletinScreen);
    try {
      const d = await S.api(`/api/bulletin?sort=${encodeURIComponent(sort)}&page=${encodeURIComponent(page)}`);
      if (stale()) return;
      const posts = Array.isArray(d.posts) ? d.posts : [];
      bulletinState.page = page;
      bulletinState.hasMore = Boolean(d.hasMore);
      bulletinState.posts = page === 1 ? posts : bulletinState.posts.concat(posts);
      if (!bulletinState.posts.length) {
        list.innerHTML = `<div class="cu-empty"><p>Nothing is posted yet. Run a checkup on a site that needs some care, then post it here from the report page.</p></div>`;
      } else if (page === 1) {
        list.innerHTML = bulletinState.posts.map(bulletinCard).join("");
      } else {
        list.insertAdjacentHTML("beforeend", posts.map(bulletinCard).join(""));
      }
      if (more) { more.hidden = !bulletinState.hasMore; more.disabled = false; more.textContent = "Show more"; }
    } catch (err) {
      if (stale()) return;
      if (page === 1) list.innerHTML = `<p class="cu-empty">${esc(err.message || "We couldn't load the bulletin right now.")}</p>`;
      else S.toast(err.message || "We couldn't load more right now.");
      if (more) { more.disabled = false; more.textContent = "Show more"; }
    } finally {
      if (token === bulletinState.token) bulletinState.loading = false;
    }
  }

  /* ================= BULLETIN POST ================= */
  let currentPost = null; // { id, post, report, offers, intro }

  function canManagePost(post) {
    return Boolean(S.user && post && post.by && (post.by.id === S.user.id || isAdmin()));
  }
  function canDeleteOffer(offer, post) {
    return Boolean(S.user && ((offer.by && offer.by.id === S.user.id) || canManagePost(post)));
  }
  function fallbackIntro(post, report) {
    const target = report.target || (post.report && post.report.target) || "your website";
    const found = topFindings(report.findings, 3);
    const lines = [
      `Hello ${target} team,`,
      "",
      `I came across your website on the Sutros community bulletin (${publicOrigin()}/b/${post.id}). Sutros is a free website checkup. It looks at a site and points out what could be fixed.`,
    ];
    if (found.length) {
      lines.push("", "The main things it found:");
      found.forEach((f, i) => lines.push(`${i + 1}. ${f.title}`));
      const first = found[0];
      if (first.fix && first.fix.length) lines.push("", `For the first one, the report suggests: ${first.fix[0]}`);
    }
    lines.push("", "I would be glad to help with any of this. The full report with plain steps is here:", `${publicOrigin()}/r/${report.id || post.report.id}`, "", "Best,");
    return lines.join("\n");
  }

  function contactHints(contact) {
    const pages = (contact && Array.isArray(contact.pages) ? contact.pages : []).map(safeUrl).filter(Boolean).slice(0, 6);
    const emails = (contact && Array.isArray(contact.emails) ? contact.emails : []).map(safeEmail).filter(Boolean).slice(0, 6);
    if (!pages.length && !emails.length) {
      return `<p class="cu-inline-msg" style="margin:0">We did not find a public contact page or email on this site. Try the site's own contact page or a phone number listed on it.</p>`;
    }
    return `<ul class="cu-contacts">
      ${emails.map((e) => `<li>Email: <a href="mailto:${esc(e)}">${esc(e)}</a></li>`).join("")}
      ${pages.map((u) => `<li>Contact page: <a href="${esc(u)}" target="_blank" rel="noopener">${esc(clip(u.replace(/^https?:\/\//i, ""), 70))}</a></li>`).join("")}
    </ul>`;
  }

  function offerItem(offer, post) {
    const email = safeEmail(offer.contact);
    const url = !email && safeUrl(offer.contact);
    const contact = email
      ? `<a href="mailto:${esc(email)}">${esc(email)}</a>`
      : url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(clip(url, 70))}</a>` : esc(clip(offer.contact, 70));
    return `<div class="cu-offer" data-offer="${esc(offer.id)}">
      <div class="cu-offer-head">${avatar(offer.by)}<b>${esc(personName(offer.by))}</b><span>${esc(ago(offer.createdAt))}</span>
        ${canDeleteOffer(offer, post) ? `<button type="button" class="cu-link-btn" data-remove-offer="${esc(offer.id)}">Remove</button>` : ""}
      </div>
      <p>${esc(offer.message)}</p>
      <div class="cu-offer-contact">Reach them at ${contact}</div>
    </div>`;
  }

  function offersHtml(data) {
    const offers = Array.isArray(data.offers) ? data.offers : [];
    if (!offers.length) return `<p class="cu-inline-msg" style="margin:0">No one has offered yet. You could be the first.</p>`;
    return offers.map((o) => offerItem(o, data.post)).join("");
  }

  function offerFormHtml(data) {
    const post = data.post;
    if (!S.user) {
      return `<div class="cu-signin"><span>Sign in to offer help. It takes a minute and keeps the bulletin friendly.</span><button type="button" class="btn btn-primary btn-sm" data-signin>Sign in</button></div>`;
    }
    if (!isVerified()) {
      return `<div class="cu-signin"><span>Please confirm your email first, then you can offer help here. Check your inbox for the link from Sutros.</span></div>`;
    }
    if (post.status === "resolved") {
      return `<p class="cu-inline-msg" style="margin:0">This one is marked resolved, so it does not need more offers right now.</p>`;
    }
    const contactDefault = S.user.contact && (safeEmail(S.user.contact) || safeUrl(S.user.contact)) ? S.user.contact : (S.user.email || "");
    return `<form class="cu-form" id="cuOfferForm" novalidate>
      <label class="field-label" for="cuOfferMsg">Your message</label>
      <textarea class="cu-textarea" id="cuOfferMsg" maxlength="1500" placeholder="Say what you can help with and roughly how. Keep it short and friendly." required></textarea>
      <label class="field-label" for="cuOfferContact">How the site owner can reach you</label>
      <input class="cu-input" id="cuOfferContact" type="text" maxlength="200" placeholder="Email or website link" value="${esc(contactDefault)}" required>
      <p class="err" id="cuOfferErr"></p>
      <div><button class="btn btn-primary" type="submit">Offer to help</button></div>
    </form>`;
  }

  function statusControlHtml(post) {
    if (!canManagePost(post)) return "";
    const s = STATUS_LABEL[post.status] ? post.status : "open";
    return `<label class="cu-status-ctl">Status
      <select class="cu-select" id="cuStatusSelect">
        ${Object.keys(STATUS_LABEL).map((k) => `<option value="${esc(k)}"${k === s ? " selected" : ""}>${esc(STATUS_LABEL[k])}</option>`).join("")}
      </select>
    </label>`;
  }

  function renderPost(id) {
    currentPost = null;
    postScreen.innerHTML = shell(`
      <div class="report-top">${backLink("/bulletin", "Bulletin")}<span class="eyebrow" style="margin:0;">Community bulletin</span></div>
      <p class="cu-empty">Loading this post...</p>`);
    S.showScreen("screen-bulletin-post");
    S.api("/api/bulletin/" + encodeURIComponent(id))
      .then((d) => {
        if (!isActive(postScreen) || !location.pathname.startsWith("/b/" + id)) return;
        if (!d || !d.post) throw new Error("We couldn't find that post.");
        currentPost = { id, post: d.post, report: d.report || {}, offers: Array.isArray(d.offers) ? d.offers : [], intro: d.intro || "" };
        drawPost();
      })
      .catch((err) => {
        postScreen.innerHTML = shell(`
          <div class="report-top">${backLink("/bulletin", "Bulletin")}<span class="eyebrow" style="margin:0;">Community bulletin</span></div>
          <p class="cu-empty">${esc(err.status === 404 ? "We couldn't find that post. It may have been removed." : err.message || "We couldn't load that post right now.")}</p>`);
      });
  }

  function drawPost() {
    const data = currentPost;
    if (!data) return;
    const post = data.post;
    const r = data.report && data.report.target ? data.report : Object.assign({}, post.report || {});
    const reportId = r.id || (post.report && post.report.id) || "";
    const tally = r.tally || (post.report && post.report.tally) || {};
    const findings = Array.isArray(r.findings) && r.findings.length
      ? topFindings(r.findings, 5)
      : (post.report && Array.isArray(post.report.topFindings) ? post.report.topFindings : []);
    const contact = r.contact || (post.report && post.report.contact) || null;
    const chips = [];
    if (tally.urgent) chips.push(`<span class="tally urgent"><span class="n">${esc(tally.urgent)}</span> urgent</span>`);
    if (tally.serious) chips.push(`<span class="tally serious"><span class="n">${esc(tally.serious)}</span> serious</span>`);
    if (tally.watch) chips.push(`<span class="tally watch"><span class="n">${esc(tally.watch)}</span> worth a look</span>`);
    const intro = data.intro || fallbackIntro(post, r);
    const note = post.note && String(post.note).trim();
    const score = Number.isFinite(Number(r.score)) ? Number(r.score) : null;

    postScreen.innerHTML = shell(`
      <div class="report-top">
        ${backLink("/bulletin", "Bulletin")}
        <span class="eyebrow" style="margin:0;">Community bulletin</span>
      </div>
      <div class="cu-panel" style="margin-bottom:20px;">
        <div class="cu-card-top">
          ${gradeChip(r.grade)}
          <div class="cu-card-main">
            <h2 class="cu-target">${esc(r.target || "Unknown site")}</h2>
            <div class="cu-meta">
              ${score !== null ? `<span>Score ${esc(score)} of 100</span><span>&middot;</span>` : ""}
              ${r.scannedAt || r.created_at ? `<span>Checked ${esc(fmtDate(r.scannedAt || r.created_at))}</span><span>&middot;</span>` : ""}
              <span>Posted ${esc(ago(post.createdAt))} by ${esc(personName(post.by))}</span>
            </div>
          </div>
          <div id="cuStatusWrap">${canManagePost(post) ? statusControlHtml(post) : statusPill(post.status)}</div>
        </div>
        ${note ? `<p class="cu-note" style="margin-top:14px;">${esc(note)}</p>` : ""}
        ${r.summary ? `<p class="cu-summary">${esc(r.summary)}</p>` : ""}
        ${chips.length ? `<div class="cu-tally">${chips.join("")}</div>` : ""}
        ${findings.length ? `<ul class="cu-findings" style="margin-top:16px;">${findings.map((f) => `<li>${sevChip(f.severity)}<span>${esc(f.title)}</span></li>`).join("")}</ul>` : ""}
        <div class="cu-actions">
          ${reportId ? `<a class="btn btn-ghost btn-sm" href="/r/${esc(reportId)}" data-spa>Read the full report</a>` : ""}
          ${reportId ? `<a class="cu-link-btn" href="/verify/${esc(reportId)}" data-spa>Check that this report is genuine</a>` : ""}
        </div>
      </div>

      <div class="cu-grid">
        <div class="cu-stack">
          <div class="cu-panel">
            <p class="eyebrow">Reach the site</p>
            <h3>Ways to contact them</h3>
            <p>These were found on the site itself during the checkup.</p>
            ${contactHints(contact)}
          </div>
          <div class="cu-panel">
            <p class="eyebrow">Ready to send</p>
            <h3>Intro message</h3>
            <p>A short note you can send to the site owner. Edit it however you like.</p>
            <textarea class="cu-textarea" id="cuIntro" style="min-height:220px;" aria-label="Intro message">${esc(intro)}</textarea>
            <div class="cu-actions"><button type="button" class="btn btn-ghost btn-sm" id="cuIntroCopy">Copy the message</button></div>
          </div>
        </div>
        <div class="cu-stack">
          <div class="cu-panel">
            <p class="eyebrow">Offer to help</p>
            <h3>Lend a hand</h3>
            <p>Tell the site owner what you can do. Your message and contact will be visible on this page.</p>
            <div id="cuOfferWrap">${offerFormHtml(data)}</div>
          </div>
          <div class="cu-panel">
            <p class="eyebrow">Offers so far</p>
            <h3>${esc(plural(data.offers.length, "offer to help", "offers to help"))}</h3>
            <div id="cuOffers">${offersHtml(data)}</div>
          </div>
        </div>
      </div>
    `);
    wirePost();
  }

  function wirePost() {
    const data = currentPost;
    if (!data) return;
    const copyBtn = $("#cuIntroCopy", postScreen);
    if (copyBtn) copyBtn.addEventListener("click", () => copyText($("#cuIntro", postScreen).value, copyBtn, "Copied"));
    wireOfferForm();
    wireStatusControl();
    wireOfferRemoval();
  }

  function wireOfferForm() {
    const data = currentPost;
    const wrap = $("#cuOfferWrap", postScreen);
    if (!wrap || !data) return;
    const signin = $("[data-signin]", wrap);
    if (signin) signin.addEventListener("click", () => S.requireLogin("/b/" + data.id));
    const form = $("#cuOfferForm", wrap);
    if (!form) return;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = $("#cuOfferErr", form);
      const message = $("#cuOfferMsg", form).value.trim();
      const contact = $("#cuOfferContact", form).value.trim();
      const showErr = (t) => { err.textContent = t; err.classList.add("show"); };
      err.classList.remove("show");
      if (message.length < 20) return showErr("Please write at least a couple of sentences so the owner knows what you can help with.");
      if (message.length > 1500) return showErr("Please keep your message under 1500 characters.");
      if (!safeEmail(contact) && !safeUrl(contact)) return showErr("Please add an email address or a website link starting with http.");
      if (contact.length > 200) return showErr("Please use a shorter contact, under 200 characters.");
      const btn = $("button[type=submit]", form);
      btn.disabled = true; btn.textContent = "Sending...";
      try {
        const d = await S.api("/api/bulletin/" + encodeURIComponent(data.id) + "/offers", { method: "POST", body: { message, contact } });
        if (d && d.offer) data.offers.push(d.offer);
        S.toast("Thanks. Your offer is posted.");
        drawPost();
      } catch (e2) {
        if (e2.status === 401) {
          // The session may have ended while this tab still had a user. Refresh first so
          // requireLogin sees the real state and sends the person to sign in.
          btn.disabled = false; btn.textContent = "Offer to help";
          S.refreshMe().then(() => S.requireLogin("/b/" + data.id));
          return;
        }
        showErr(e2.message || "We couldn't post your offer right now.");
        btn.disabled = false; btn.textContent = "Offer to help";
      }
    });
  }

  function wireStatusControl() {
    const data = currentPost;
    const sel = $("#cuStatusSelect", postScreen);
    if (!sel || !data) return;
    sel.addEventListener("change", async () => {
      const status = STATUS_LABEL[sel.value] ? sel.value : "open";
      const previous = data.post.status;
      sel.disabled = true;
      try {
        const d = await S.api("/api/bulletin/" + encodeURIComponent(data.id), { method: "PATCH", body: { status } });
        data.post.status = (d && d.post && d.post.status) || status;
        S.toast("Status updated.");
        drawPost();
      } catch (err) {
        sel.value = previous;
        sel.disabled = false;
        S.toast(err.message || "We couldn't change the status right now.");
      }
    });
  }

  function wireOfferRemoval() {
    const data = currentPost;
    const list = $("#cuOffers", postScreen);
    if (!list || !data) return;
    list.querySelectorAll("[data-remove-offer]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const offerId = btn.dataset.removeOffer;
        if (!confirm("Remove this offer?")) return;
        btn.disabled = true;
        try {
          await S.api("/api/bulletin/" + encodeURIComponent(data.id) + "/offers/" + encodeURIComponent(offerId), { method: "DELETE" });
          data.offers = data.offers.filter((o) => o.id !== offerId);
          S.toast("Offer removed.");
          drawPost();
        } catch (err) {
          btn.disabled = false;
          S.toast(err.message || "We couldn't remove that offer right now.");
        }
      })
    );
  }

  /* ================= VERIFY ================= */
  async function browserVerify(d) {
    if (!d.signature) return "nosig";
    if (!d.publicKeySpkiBase64 || !d.canonical) return "nokey";
    if (!window.crypto || !crypto.subtle) return "unsupported";
    try {
      const key = await crypto.subtle.importKey("spki", b64ToBytes(d.publicKeySpkiBase64), { name: "Ed25519" }, false, ["verify"]);
      const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, b64ToBytes(d.signature), new TextEncoder().encode(String(d.canonical)));
      return ok ? "ok" : "bad";
    } catch {
      return "unsupported";
    }
  }

  function renderVerify(id) {
    verifyScreen.innerHTML = shell(`
      <div class="report-top">${backLink("/", "Home")}<span class="eyebrow" style="margin:0;">Verify a checkup</span></div>
      <p class="cu-empty">Checking this report...</p>`);
    S.showScreen("screen-verify");
    S.api("/api/verify/" + encodeURIComponent(id))
      .then(async (d) => {
        if (!isActive(verifyScreen) || !location.pathname.startsWith("/verify/" + id)) return;
        const rep = d.report || {};
        const payload = d.payload || {};
        const valid = Boolean(d.valid);
        const reason = d.reason && String(d.reason);
        const target = rep.target || payload.target || "";
        const grade = rep.grade || payload.grade || "";
        const score = Number.isFinite(Number(rep.score ?? payload.score)) ? Number(rep.score ?? payload.score) : null;
        const scannedAt = rep.scannedAt || payload.scannedAt || "";
        verifyScreen.innerHTML = shell(`
          <div class="report-top">${backLink("/", "Home")}<span class="eyebrow" style="margin:0;">Verify a checkup</span></div>
          <div class="cu-verify-status ${valid ? "ok" : "bad"}" role="status">
            <div class="ic">${valid ? ICON_OK : ICON_BAD}</div>
            <div>
              <h2>${valid ? "This checkup is genuine" : "This checkup could not be verified"}</h2>
              <p>${valid
                ? "Sutros signed this report when the checkup finished, and the report on file still matches what was signed."
                : esc(reason || "The report is not signed, or it has changed since it was signed. Treat the badge as unconfirmed.")}</p>
              <p class="cu-inline-msg" id="cuBrowserCheck">Checking the signature in your browser too...</p>
            </div>
          </div>
          <div class="cu-grid">
            <div class="cu-panel">
              <p class="eyebrow">What was checked</p>
              <div class="cu-card-top" style="margin-bottom:14px;">
                ${gradeChip(grade)}
                <div class="cu-card-main">
                  <h3 class="cu-target" style="font-size:22px;">${esc(target || "Unknown site")}</h3>
                  <div class="cu-meta">${rep.gradeLabel ? `<span>${esc(rep.gradeLabel)}</span><span>&middot;</span>` : ""}${score !== null ? `<span>Score ${esc(score)} of 100</span>` : ""}</div>
                </div>
              </div>
              <dl class="cu-kv">
                <dt>Checked on</dt><dd>${esc(fmtDate(scannedAt) || "Unknown")}</dd>
                <dt>Report id</dt><dd>${esc(rep.id || id)}</dd>
                <dt>Signing key</dt><dd>${esc(d.keyId || "Not signed")}</dd>
                <dt>Full report</dt><dd><a href="/r/${esc(rep.id || id)}" data-spa>${esc(location.host)}/r/${esc(rep.id || id)}</a></dd>
              </dl>
            </div>
            <div class="cu-panel">
              <p class="eyebrow">How this works</p>
              <h3>What the badge means</h3>
              <p>When a checkup finishes, Sutros signs the site name, grade, score, date, and the list of findings with its private key. This page checks that signature against the Sutros public key. If anything in the report changed after signing, the check fails.</p>
              <p>The public key is published at <a href="/.well-known/sutros-signing-key.json" target="_blank" rel="noopener" style="color:var(--brand);font-weight:600;">/.well-known/sutros-signing-key.json</a>, so anyone can run the same check.</p>
              ${valid ? `<a class="cu-badge-preview" href="/badge/${esc(rep.id || id)}.svg" target="_blank" rel="noopener"><img alt="Checked by SUTROS" src="/badge/${esc(rep.id || id)}.svg"></a>` : ""}
            </div>
          </div>
        `);
        const line = $("#cuBrowserCheck", verifyScreen);
        const result = await browserVerify(d);
        if (!line || !isActive(verifyScreen)) return;
        if (result === "ok") {
          line.textContent = valid
            ? "Verified in your browser. Your browser checked the signature itself using the published public key."
            : "The signature itself checks out in your browser, but the report on file no longer matches what was signed.";
          line.classList.add(valid ? "ok" : "bad");
        } else if (result === "bad") {
          line.textContent = "Your browser could not confirm this signature. The result above comes from the Sutros server.";
          line.classList.add("bad");
        } else if (result === "nosig") {
          line.textContent = "There is no signature to check for this report.";
        } else if (result === "nokey") {
          line.textContent = "The server did not publish a public key for this report, so it could not be checked in your browser.";
        } else {
          line.textContent = "Your browser cannot check this kind of signature itself, so the result above comes from the Sutros server.";
        }
      })
      .catch((err) => {
        verifyScreen.innerHTML = shell(`
          <div class="report-top">${backLink("/", "Home")}<span class="eyebrow" style="margin:0;">Verify a checkup</span></div>
          <p class="cu-empty">${esc(err.status === 404 ? "We couldn't find a report with that id." : err.message || "We couldn't check that report right now.")}</p>`);
      });
  }

  /* ================= RECENT PUBLIC CHECKUPS (home) ================= */
  function recentCard(r) {
    return `<a class="cu-recent" href="/r/${esc(r.id)}" data-spa>
      ${gradeChip(r.grade, true)}
      <div class="rb">
        <div class="t">${esc(r.target || "Unknown site")}</div>
        <div class="m">${esc(ago(r.created_at || r.scannedAt))}${r.by && r.by.name ? ` &middot; by ${esc(r.by.name)}` : ""}</div>
      </div>
    </a>`;
  }
  async function renderRecent() {
    const sec = document.getElementById("recentChecks");
    if (!sec) return;
    try {
      const d = await S.api("/api/reports?limit=8");
      const reports = Array.isArray(d.reports) ? d.reports.filter((r) => r && r.id) : [];
      if (!reports.length) { sec.hidden = true; return; }
      sec.innerHTML = `<div class="wrap cu">
        <div class="sec-head">
          <p class="eyebrow">Recent public checkups</p>
          <h2>Checked lately</h2>
          <p>Every checkup is public. Here are the latest ones from the community.</p>
        </div>
        <div class="cu-recent-grid">${reports.map(recentCard).join("")}</div>
        <p class="cu-hint" style="text-align:center;margin-top:22px;">Know a site that needs a hand? <a href="/bulletin" data-spa>See the community bulletin</a></p>
      </div>`;
      sec.hidden = false;
    } catch {
      sec.hidden = true;
    }
  }

  /* ================= DEDUP PROMPT (before a checkup) ================= */
  let pendingDedup = null;
  function settleDedup(value) {
    if (pendingDedup) { const r = pendingDedup; pendingDedup = null; r(value); }
    const slot = document.getElementById("dedupSlot");
    if (slot) slot.innerHTML = "";
  }
  const urlInput = document.getElementById("urlInput");
  if (urlInput) urlInput.addEventListener("input", () => { if (pendingDedup) settleDedup(false); });

  S.beforeCheckup = async function (host) {
    settleDedup(false);
    const slot = document.getElementById("dedupSlot");
    if (!slot || !host) return true;
    let data;
    try { data = await S.api("/api/checks?host=" + encodeURIComponent(host)); } catch { return true; }
    const reports = data && Array.isArray(data.reports) ? data.reports.filter((r) => r && r.id) : [];
    const count = Math.max(Number(data && data.count) || 0, reports.length);
    if (!count || !reports.length) return true;
    const latest = reports.slice().sort((a, b) => new Date(b.scannedAt).getTime() - new Date(a.scannedAt).getTime())[0];
    const age = Date.now() - new Date(latest.scannedAt).getTime();
    const fresh = Number.isFinite(age) && age < TEN_MIN;
    const waitMin = fresh ? Math.max(1, Math.ceil((TEN_MIN - age) / 60_000)) : 0;

    return new Promise((resolve) => {
      pendingDedup = resolve;
      slot.innerHTML = `<div class="cu-dedup" role="status">
        <div><b>${esc(host)}</b> has been checked ${esc(plural(count, "time", "times"))} already.
        ${fresh
          ? ` The latest checkup is only ${esc(plural(Math.max(1, Math.round(age / 60_000)), "minute", "minutes"))} old, so you can read it right now. A fresh one can run in about ${esc(plural(waitMin, "minute", "minutes"))}.`
          : " You can read the latest checkup or run a fresh one."}</div>
        <div class="cu-dedup-row">
          ${gradeChip(latest.grade, true)}
          <span class="cu-meta">Latest: grade ${esc(gradeLetter(latest.grade))}${Number.isFinite(Number(latest.score)) ? `, score ${esc(latest.score)}` : ""} &middot; ${esc(ago(latest.scannedAt))}${latest.by && latest.by.name ? ` by ${esc(latest.by.name)}` : ""}</span>
        </div>
        <div class="cu-actions" style="margin-top:6px;">
          <button type="button" class="btn btn-primary btn-sm" data-dedup="view">View latest</button>
          ${fresh ? "" : `<button type="button" class="btn btn-ghost btn-sm" data-dedup="fresh">Run a fresh checkup</button>`}
          <button type="button" class="cu-link-btn" data-dedup="cancel">Not now</button>
        </div>
      </div>`;
      $("[data-dedup=view]", slot).addEventListener("click", () => { settleDedup(false); S.navigate("/r/" + latest.id); });
      const freshBtn = $("[data-dedup=fresh]", slot);
      if (freshBtn) freshBtn.addEventListener("click", () => settleDedup(true));
      $("[data-dedup=cancel]", slot).addEventListener("click", () => settleDedup(false));
    });
  };

  /* ================= REPORT EXTRAS (bulletin post + badge) ================= */
  let lastReport = null;
  const postedByReport = new Map(); // reportId -> post id

  function extractPostId(err) {
    const d = err && err.data;
    if (!d) return null;
    return d.postId || d.id || (d.post && d.post.id) || (d.existing && d.existing.id) || null;
  }

  function postPanelBody(report) {
    const posted = postedByReport.get(report.id);
    if (posted) {
      return `<p class="cu-inline-msg ok" style="margin-top:0;">This checkup is on the bulletin.</p>
        <div class="cu-actions"><a class="btn btn-ghost btn-sm" href="/b/${esc(posted)}" data-spa>See the post</a></div>`;
    }
    if (!S.user) {
      return `<div class="cu-signin"><span>Sign in to post this checkup.</span><button type="button" class="btn btn-primary btn-sm" data-signin>Sign in</button></div>`;
    }
    if (!isVerified()) {
      return `<p class="cu-inline-msg" style="margin-top:0;">Please confirm your email first, then you can post. Check your inbox for the link from Sutros.</p>`;
    }
    return `<form class="cu-form" id="cuPostForm" novalidate>
      <textarea class="cu-textarea" id="cuPostNote" maxlength="500" style="min-height:84px;" placeholder="Optional note, for example who runs this site or why it matters to you" aria-label="Note for the bulletin"></textarea>
      <p class="err" id="cuPostErr"></p>
      <div><button class="btn btn-primary btn-sm" type="submit">Post to the bulletin</button></div>
    </form>`;
  }

  function renderExtras(report) {
    const root = document.getElementById("reportExtras");
    if (!root) return;
    root.innerHTML = "";
    if (!report || !report.id) return; // the sample and unsaved reports have nothing to post or verify
    const id = String(report.id);
    const origin = publicOrigin();
    const snippet = `<a href="${origin}/verify/${id}"><img alt="Checked by SUTROS" src="${origin}/badge/${id}.svg"></a>`;
    root.innerHTML = `<div class="cu-extras cu">
      <div class="cu-panel" id="cuPostPanel">
        <p class="eyebrow">Community bulletin</p>
        <h3>Post this checkup to the community bulletin</h3>
        <p>People who fix websites read the bulletin and offer to help. Posting shares this report and the public contact details found on the site.</p>
        <div id="cuPostBody">${postPanelBody(report)}</div>
      </div>
      <div class="cu-panel">
        <p class="eyebrow">Show it off</p>
        <h3>Add the Checked by SUTROS badge</h3>
        <p>The badge shows the grade and the date, and links to a page where anyone can confirm this checkup is genuine.</p>
        <a class="cu-badge-preview" href="/verify/${esc(id)}" data-spa><img alt="Checked by SUTROS" src="/badge/${esc(id)}.svg"></a>
        <pre class="cu-code" id="cuBadgeCode">${esc(snippet)}</pre>
        <div class="cu-actions">
          <button type="button" class="btn btn-ghost btn-sm" id="cuBadgeCopy">Copy the code</button>
          <a class="cu-link-btn" href="/verify/${esc(id)}" data-spa>See the verify page</a>
        </div>
      </div>
    </div>`;
    $("#cuBadgeCopy", root).addEventListener("click", (e) => copyText(snippet, e.currentTarget, "Copied"));
    wirePostPanel(report);
  }

  function wirePostPanel(report) {
    const body = document.getElementById("cuPostBody");
    if (!body) return;
    const signin = $("[data-signin]", body);
    if (signin) signin.addEventListener("click", () => S.requireLogin("/r/" + report.id));
    const form = $("#cuPostForm", body);
    if (!form) return;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = $("#cuPostErr", form);
      const note = $("#cuPostNote", form).value.trim();
      err.classList.remove("show");
      if (note.length > 500) { err.textContent = "Please keep the note under 500 characters."; err.classList.add("show"); return; }
      const btn = $("button[type=submit]", form);
      btn.disabled = true; btn.textContent = "Posting...";
      try {
        const d = await S.api("/api/bulletin", { method: "POST", body: note ? { reportId: report.id, note } : { reportId: report.id } });
        const postId = d && d.post && d.post.id;
        if (postId) postedByReport.set(report.id, postId);
        S.toast("Posted to the bulletin.");
        renderExtras(report);
      } catch (e2) {
        const existing = e2.status === 409 ? extractPostId(e2) : null;
        if (existing) { postedByReport.set(report.id, existing); renderExtras(report); return; }
        if (e2.status === 401) {
          btn.disabled = false; btn.textContent = "Post to the bulletin";
          S.refreshMe().then(() => S.requireLogin("/r/" + report.id));
          return;
        }
        err.textContent = e2.message || "We couldn't post this right now.";
        err.classList.add("show");
        btn.disabled = false; btn.textContent = "Post to the bulletin";
      }
    });
  }

  S.onReportRendered = function (report) {
    lastReport = report || null;
    try { renderExtras(report); } catch (e) { console.error(e); }
  };

  /* ---------------- react to sign in / sign out ---------------- */
  S.onUser(() => {
    const reportScreen = document.getElementById("screen-report");
    if (lastReport && reportScreen && isActive(reportScreen)) renderExtras(lastReport);
    if (currentPost && isActive(postScreen)) drawPost();
  });

  /* ---------------- boot ---------------- */
  renderRecent();
})();
