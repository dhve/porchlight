// proof.js
// Pictures for the technical proof. After the checks have run, we open the
// pages where problems were found in a real browser, outline broken links and
// images in red, and take a small JPEG of each. The pictures are stored with
// the report and served back to the report page.
//
// Exports:
//   ensureProofSchema()                  creates the report_shots table
//   captureProof({ facts, findings, onEvent }) -> { shots, skipped }
//   saveShots(reportId, shots)           stores the pictures (duplicates ignored)
//   sweepOldShots(days = 60)             removes pictures of old reports
//   proofRouter                          GET /api/reports/:id/shots/:key
//
// captureProof never throws. It has a hard budget: one browser, at most six
// pictures, 12 s per page, 25 s in total, and no picture larger than 350 KB.

import express from "express";
import { sql, dbEnabled } from "./db.js";
import { openBrowser } from "./lib/browserConnect.js";
import { resolveTarget, isPrivateIp } from "./safety.js";
import { CHROME_USER_AGENT } from "./checks/browser.js";
import { isChallenge, isChallengeUrl, CHALLENGE_REASON, headerValue } from "./lib/challenge.js";
import { classifyStylesheetResponse, assessStyling } from "./lib/styling.js";

export const proofRouter = express.Router();

const ID_RE = /^[A-Za-z0-9_-]{6,20}$/;
const KEY_RE = /^s[1-9]$/;

const MAX_SHOTS = 6;
/** Pictures are kept this long (sweepOldShots). */
export const SHOT_RETENTION_DAYS = 60;

/**
 * Headers for a stored picture. Pictures are never cached: the earlier
 * "public, max-age=31536000, immutable" let browsers and proxies keep showing a picture for a
 * year after the sweep had removed it, and would defeat a takedown during the retention
 * window. private, no-store matches the API responses.
 */
export const SHOT_CACHE_CONTROL = "private, no-store";
export function shotHeaders(mime) {
  const type = /^image\/[a-z0-9.+-]+$/i.test(mime || "") ? mime : "image/jpeg";
  return { "Content-Type": type, "X-Content-Type-Options": "nosniff", "Cache-Control": SHOT_CACHE_CONTROL };
}
const VIEWPORT = { width: 1100, height: 760 };
const PAGE_TIMEOUT_MS = 12_000;
const TOTAL_BUDGET_MS = 25_000;
const SETTLE_MS = 800;
const JPEG_QUALITY = 58;
const JPEG_QUALITY_RETRY = 40;
const MAX_BYTES = 350 * 1024;
const SEVERITY_RANK = { urgent: 0, serious: 1, watch: 2, minor: 3 };

// ---- schema ----

export async function ensureProofSchema() {
  if (!dbEnabled()) return false;
  await sql(`
    CREATE TABLE IF NOT EXISTS report_shots (
      report_id  TEXT NOT NULL,
      key        TEXT NOT NULL,
      page_url   TEXT,
      mime       TEXT,
      bytes      BYTEA,
      width      INT,
      height     INT,
      created_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (report_id, key)
    )`);
  await sql(`CREATE INDEX IF NOT EXISTS report_shots_created_idx ON report_shots (created_at)`);
  return true;
}

// ---- capture ----

/**
 * Take up to six pictures of the pages named in the findings' evidence.
 * Sets finding.evidence.shots = [{ key, page, caption, highlighted }] on the
 * findings it pictured. Never throws.
 */
export async function captureProof({ facts, findings, onEvent, session: givenSession = null } = {}) {
  const emit = typeof onEvent === "function" ? onEvent : () => {};
  const started = Date.now();
  const deadline = started + TOTAL_BUDGET_MS;
  const remaining = () => deadline - Date.now();

  const homepage = facts ? String((facts.finalUrl && facts.finalUrl.href) || facts.finalUrl || "") : "";
  const siteHost = hostOf(homepage);
  if (!siteHost) return { shots: [], skipped: "No site address to picture." };
  let targets = pickTargets(findings, siteHost);
  // The site's own host was cleared by the safety guard when the checkup began. A page on
  // another host of the site (a subdomain) is resolved once and must be public too.
  const allowed = hostGuard(homepage);
  for (const t of targets) t.pages = (await Promise.all(t.pages.map(async (p) => ((await allowed(p)) ? p : null)))).filter(Boolean);
  targets = targets.filter((t) => t.pages.length);
  if (!targets.length) return { shots: [], skipped: "No finding names a page to picture." };

  // Tests may hand in a browser they launched themselves (for example with a host alias so a
  // local fixture answers under a public-looking name); production always opens its own.
  let session = givenSession;
  try {
    if (!session) session = await openBrowser({ purpose: "proof" });
  } catch (err) {
    const reason = err && err.code === "NO_PLAYWRIGHT"
      ? "Playwright not installed (run: npm run enable-browser)"
      : `Browser unavailable: ${String((err && err.message) || err).slice(0, 120)}`;
    emit("log", { mark: "📸", text: `No pictures this time: ${reason}` });
    return { shots: [], skipped: reason };
  }

  const shots = [];
  const plainByPage = new Map(); // page -> shot ref, reused by findings that need no highlight
  const declined = []; // { page, reason }: pages we refused to picture, and why
  let skipped = null;

  try {
    // One desktop page for most pictures, and a real phone context (mobile identity,
    // touch, viewport emulation) opened only when a finding is about phones. Resizing
    // the desktop page would not do: Chromium only honors the viewport meta tag, the
    // thing a "not mobile friendly" picture must show, when the context is mobile.
    async function openPage(phone) {
      const ctx = await session.browser.newContext({
        userAgent: phone ? PHONE_USER_AGENT : CHROME_USER_AGENT,
        viewport: phone ? PHONE : VIEWPORT,
        deviceScaleFactor: 1,
        isMobile: phone,
        hasTouch: phone,
        acceptDownloads: false,
        reducedMotion: "reduce",
        extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
      });
      const pg = await ctx.newPage();
      pg.setDefaultTimeout(PAGE_TIMEOUT_MS);
      pg.on("dialog", (d) => d.dismiss().catch(() => {}));
      watchRender(pg);
      // Stay on the site: a top-level navigation to another domain is not followed. (Redirect
      // hops do not pass through here, so takeShot checks where the page really ended up.)
      await pg.route("**/*", (route) => {
        const req = route.request();
        let leaving = false;
        try { leaving = req.isNavigationRequest() && req.frame() === pg.mainFrame() && !sameSite(req.url(), siteHost); } catch {}
        return (leaving ? route.abort() : route.continue()).catch(() => {});
      }).catch(() => {});
      return pg;
    }
    const page = await openPage(false);
    let phonePage = null;
    const getPhonePage = async () => phonePage || (phonePage = await openPage(true));

    // A 429 while picturing means the site asked us to slow down: we stop and say so.
    let limited = false;
    const onLimited = () => { limited = true; if (facts) facts.throttled = true; };
    const onChallenged = (reason) => { if (facts && !facts.challenged) facts.challenged = reason || CHALLENGE_REASON; };

    for (const t of targets) {
      if (shots.length >= MAX_SHOTS) break;
      if (remaining() < 3000) { skipped = skipped || "Ran out of time before every page was pictured."; break; }
      const opts = { shots, plainByPage, remaining, onLimited, onChallenged, declined, siteHost, getPhonePage };
      const ref = t.needsHighlight ? await shootHighlighted(page, t, opts) : await shootPlain(page, t, opts);
      if (ref) t.finding.evidence.shots = [ref];
      if (limited) { skipped = "The site limited our checker"; break; }
    }
  } catch (err) {
    skipped = `Pictures stopped early: ${String((err && err.message) || err).slice(0, 100)}`;
  } finally {
    if (!givenSession) await withTimeout(session.close(), 5000).catch(() => {});
  }

  const n = shots.length;
  if (!n && !skipped && declined.length) skipped = declined[0].reason;
  emit("log", {
    mark: "📸",
    text: n
      ? `Took ${n} picture${n === 1 ? "" : "s"} of the page${n === 1 ? "" : "s"} where problems were found.${declined.length ? ` ${declined.length} page${declined.length === 1 ? " was" : "s were"} not pictured because ${declined[0].reason.replace(/^The /, "the ")}.` : ""}`
      : `No pictures this time: ${skipped || "the pages did not load in time."}`,
  });
  return { shots, skipped: n ? null : (skipped || "The pages did not load in time."), declined };
}

const PHONE = { width: 390, height: 844 };
const PHONE_USER_AGENT = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36";

/**
 * A picture is only worth showing when it makes the problem visible. Headers, cookies,
 * keys in source, and console errors have nothing to look at, so they get no picture.
 * Returns null, or { caption, phone, highlight }.
 */
function pictureRule(f) {
  const id = String((f && f.id) || "");
  if (/^broken-(links|images)(-render)?$/.test(id)) return { caption: null, phone: false, highlight: true }; // caption comes from what was outlined
  if (id === "verbose-errors") return { caption: "The error text visitors can see on this page", phone: false, highlight: false, errorPage: true };
  if (id === "directory-listing") return { caption: "The folder listing anyone can open", phone: false, highlight: false };
  if (/^flow-(error|missing)-/.test(id)) return { caption: "The error page visitors get", phone: false, highlight: false, errorPage: true };
  if (id === "not-mobile-friendly" || id === "dated-design") return { caption: "The page on a phone-sized screen", phone: true, highlight: false };
  return null;
}

/** Decide which (finding, pages) pairs deserve a picture, most severe first. */
function pickTargets(findings, siteHost) {
  const list = Array.isArray(findings) ? findings : [];
  const ranked = list
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f && f.evidence && Array.isArray(f.evidence.pages) && f.evidence.pages.length && f.severity in SEVERITY_RANK)
    .filter(({ f }) => !(Array.isArray(f.evidence.shots) && f.evidence.shots.length)) // already pictured by its own check
    .filter(({ f }) => pictureRule(f) !== null)
    .sort((a, b) => (SEVERITY_RANK[a.f.severity] - SEVERITY_RANK[b.f.severity]) || (a.i - b.i));
  const targets = [];
  for (const { f } of ranked) {
    const rule = pictureRule(f);
    // A flow finding's pages say where the link was found; the page to picture is the address that failed.
    const source = rule.errorPage && /^flow-/.test(String(f.id))
      ? (Array.isArray(f.evidence.items) ? f.evidence.items : []).filter((it) => it && it.kind === "page" && it.url).map((it) => it.url)
      : f.evidence.pages;
    const pages = [...new Set(source.map((p) => String(p || "")))].filter((p) => okUrl(p, siteHost)).slice(0, 6);
    if (!pages.length) continue;
    const items = (Array.isArray(f.evidence.items) ? f.evidence.items : [])
      .filter((it) => it && (it.kind === "link" || it.kind === "image") && okUrl(it.url, null));
    const links = items.filter((it) => it.kind === "link").map((it) => it.url);
    const images = items.filter((it) => it.kind === "image").map((it) => it.url);
    targets.push({ finding: f, rule, pages, links, images, needsHighlight: rule.highlight && links.length + images.length > 0 });
  }
  return targets;
}

async function shootPlain(page, t, { shots, plainByPage, remaining, onLimited, onChallenged, declined, siteHost, getPhonePage }) {
  if (!t.rule || t.rule.highlight) return null; // a highlight finding with nothing to outline shows nothing
  const cacheKey = (url) => `${t.rule.phone ? "phone" : "desk"}|${t.rule.caption}|${url}`;
  for (const url of t.pages.slice(0, 2)) {
    if (plainByPage.has(cacheKey(url))) return plainByPage.get(cacheKey(url));
    if (shots.length >= MAX_SHOTS || remaining() < 3000) return null;
    const pg = t.rule.phone && getPhonePage ? await getPhonePage() : page;
    const shot = await takeShot(pg, url, null, { remaining, onLimited, onChallenged, declined, siteHost, phone: t.rule.phone, allowErrorPage: Boolean(t.rule.errorPage) });
    if (!shot) continue;
    const ref = register(shots, shot, url, t.rule.caption, 0);
    plainByPage.set(cacheKey(url), ref);
    return ref;
  }
  return null;
}

async function shootHighlighted(page, t, { shots, plainByPage, remaining, onLimited, onChallenged, declined, siteHost }) {
  const marks = { links: t.links, images: t.images };
  let fallback = null; // a picture of the page with nothing outlined
  for (const url of t.pages.slice(0, 2)) {
    if (shots.length >= MAX_SHOTS || remaining() < 3000) break;
    const shot = await takeShot(page, url, marks, { remaining, onLimited, onChallenged, declined, siteHost });
    if (!shot) continue;
    if (shot.highlighted > 0) {
      return register(shots, shot, url, captionFor(shot), shot.highlighted);
    }
    fallback = fallback || { shot, url };
  }
  void fallback; // nothing was outlined on any page, so no picture is kept: it would not show the problem
  return null;
}

function register(shots, shot, url, caption, highlighted) {
  const key = "s" + (shots.length + 1);
  shots.push({ key, page: url, caption, highlighted, mime: "image/jpeg", bytes: shot.bytes, width: shot.width || VIEWPORT.width, height: shot.height || VIEWPORT.height });
  return { key, page: url, caption, highlighted };
}

function captionFor(shot) {
  const l = shot.links || 0;
  const i = shot.images || 0;
  if (l && i) return "Broken links and images outlined in red";
  if (l) return l === 1 ? "Broken link outlined in red" : "Broken links outlined in red";
  return i === 1 ? "Broken image outlined in red" : "Broken images outlined in red";
}

/**
 * Load one page and photograph it. marks = { links: [urls], images: [urls] } or null.
 * Resolves { bytes, highlighted, links, images } or null when the page could not be pictured.
 */
async function takeShot(page, url, marks, { remaining, onLimited, onChallenged = () => {}, declined = [], siteHost, phone = false, allowErrorPage = false }) {
  try {
    const size = phone ? PHONE : VIEWPORT; // the page handed in already has this viewport
    const navTimeout = Math.max(1000, Math.min(PAGE_TIMEOUT_MS, remaining() - 1500));
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: navTimeout });
    const status = res ? res.status() : 0;
    if (status === 429) {
      onLimited();
      return null;
    }
    // A bot check that answered instead of the page is not a picture of the site. The
    // page's ledger read the document eagerly; the URL the browser ended up on counts too.
    if (page.__render && page.__render.pending.length) {
      const pending = page.__render.pending.splice(0);
      await withTimeout(Promise.allSettled(pending), 1500).catch(() => {});
    }
    const ledgerChallenge = page.__render && page.__render.docChallenge;
    const c = ledgerChallenge || isChallenge({ url: page.url(), status, headers: res ? res.headers() : undefined });
    if (c) {
      onChallenged(c.reason);
      declined.push({ page: url, reason: `${c.reason} (${c.detail})` });
      return null;
    }
    if (status >= 400 && !allowErrorPage) return null; // an error page is not what the finding is about
    // A script, stylesheet, or data file renders as a wall of text; only pages are pictured.
    const ctype = res ? String((res.headers() || {})["content-type"] || "") : "";
    if (ctype && !/text\/html|application\/xhtml/i.test(ctype)) return null;
    // A redirect may have carried the page off the site or onto a private address; that is not
    // a picture of the site's page, so it is not taken.
    if (!stayedOnSite(page.url(), siteHost)) {
      declined.push({ page: url, reason: "the page is not on the site or is on a private address" });
      return null;
    }
    await page.waitForTimeout(Math.max(0, Math.min(SETTLE_MS, remaining() - 1200)));

    // A page whose stylesheets did not load for us would be pictured unstyled, which shows
    // our checker being refused rather than the site. Such a page is not pictured.
    const render = await renderState(page, remaining);
    if (render.unreliable) {
      if (render.challenged) onChallenged(CHALLENGE_REASON);
      declined.push({ page: url, reason: render.reason });
      return null;
    }

    let hl = { links: 0, images: 0, visible: 0 };
    if (marks && (marks.links.length || marks.images.length)) {
      hl = await withTimeout(page.evaluate(outlineInPage, marks), 3000).catch(() => hl);
      if (hl.visible) await page.waitForTimeout(150);
    }

    let bytes = await page.screenshot({ type: "jpeg", quality: JPEG_QUALITY, timeout: Math.max(1000, Math.min(8000, remaining())) });
    if (bytes.length > MAX_BYTES) {
      bytes = await page.screenshot({ type: "jpeg", quality: JPEG_QUALITY_RETRY, timeout: Math.max(1000, Math.min(8000, remaining())) });
    }
    if (bytes.length > MAX_BYTES) return null;
    return { bytes, highlighted: hl.visible, links: hl.links, images: hl.images, width: size.width, height: size.height };
  } catch {
    return null;
  }
}

/**
 * Keep a per-document ledger of stylesheet answers on a page, so a picture is only taken
 * when the page could look the way it does for visitors.
 */
function watchRender(pg) {
  const ledger = { entries: new Map(), pending: [], docChallenge: null, documents: 0 };
  pg.__render = ledger;
  const small = (headers) => { const len = Number(headerValue(headers, "content-length")); return !Number.isFinite(len) || len <= 16384; };
  pg.on("response", (res) => {
    let main = false;
    let mainFrame = false;
    let url = "";
    let status = 0;
    let type = "";
    try {
      const rq = res.request();
      mainFrame = !rq.frame().parentFrame();
      main = rq.isNavigationRequest() && mainFrame;
      url = res.url();
      status = res.status();
      type = rq.resourceType();
    } catch { return; }
    const headers = res.headers();
    const ct = headerValue(headers, "content-type");
    if (main) {
      // Each document starts clean: a fresh ledger and no challenge carried over. The check's
      // own address (a SiteGround refresh target) is recognised on its own.
      const entries = new Map();
      ledger.entries = entries; ledger.pending = [];
      const thisDoc = ++ledger.documents;
      // The check's own address and a challenge header count whatever the status; a small
      // HTML answer (200, 202, 403, 503) is read to tell.
      ledger.docChallenge = isChallenge({ url, status, headers }) || null;
      if (!ledger.docChallenge && (status === 200 || status === 202 || status === 403 || status === 503) && (!ct || /text\/html|application\/xhtml/i.test(ct))) {
        // Full headers first (no request); the small body only when they say nothing.
        ledger.pending.push(res.allHeaders().catch(() => headers).then(async (h) => {
          let c = isChallenge({ url, status, headers: h });
          if (!c && small(h)) {
            const body = await res.text().catch(() => "");
            c = isChallenge({ status, headers: h, bodyStart: String(body || "").slice(0, 8192) });
          }
          if (c && ledger.documents === thisDoc) ledger.docChallenge = c;
        }));
      }
      return;
    }
    if (!mainFrame) return; // a frame's own stylesheets are not the page's
    if (type !== "stylesheet" && !/\.css(?:[?#]|$)/i.test(url)) return;
    // Judged from status and headers only: reading a failed file's body makes the browser
    // request it again on its own. The full header set arrives separately, without a request.
    const entries = ledger.entries;
    entries.set(url, classifyStylesheetResponse({ url, status, contentType: ct, headers }));
    if ((status === 202 || status === 403 || status === 503) && (!ct || /text\/html|application\/xhtml/i.test(ct))) {
      ledger.pending.push(res.allHeaders().then((h) => entries.set(url, classifyStylesheetResponse({ url, status, contentType: ct, headers: h }))).catch(() => {}));
    }
  });
  pg.on("requestfailed", (req) => {
    let url = "";
    let type = "";
    let mainFrame = false;
    try { url = req.url(); type = req.resourceType(); mainFrame = !req.frame().parentFrame(); } catch { return; }
    if (!mainFrame) return;
    if (type !== "stylesheet" && !/\.css(?:[?#]|$)/i.test(url)) return;
    if (ledger.entries.has(url) && ledger.entries.get(url).status) return; // keep the answer's own status
    const errorText = String((req.failure() && req.failure().errorText) || "did not load");
    ledger.entries.set(url, classifyStylesheetResponse({ url, status: 0, errorText }));
  });
}

/** Did the page's stylesheets arrive and apply? Waits briefly for slow ones. */
async function renderState(page, remaining) {
  const ledger = page.__render || { entries: new Map(), pending: [] };
  if (ledger.pending.length) {
    const pending = ledger.pending.splice(0);
    await withTimeout(Promise.allSettled(pending), 1500).catch(() => {});
  }
  let counts = await withTimeout(page.evaluate(countStylesheetsInPage), 1500).catch(() => ({ linked: 0, applied: 0 }));
  const deadline = Date.now() + Math.min(1500, Math.max(0, remaining() - 2500));
  while (counts.linked > counts.applied && Date.now() < deadline) {
    await page.waitForTimeout(250);
    counts = await withTimeout(page.evaluate(countStylesheetsInPage), 1000).catch(() => counts);
  }
  const failures = [...ledger.entries.values()].filter((e) => e.outcome !== "ok");
  const a = assessStyling({ linked: counts.linked, applied: counts.applied, failures });
  const challenged = failures.some((f) => f.outcome === "challenge");
  const reason = a.warnings[0] ? a.warnings[0].replace(/\s*Do not judge its appearance\.$/, "") : "";
  return { unreliable: a.unreliable, challenged, reason: a.unreliable ? (reason || "the page's stylesheets did not load for our checker") : "" };
}

function countStylesheetsInPage() {
  // Only stylesheets the page meant to apply: enabled, not alternate, with an address.
  const linkEls = Array.from(document.querySelectorAll('link[rel~="stylesheet"]')).filter((l) => !l.disabled && !/\balternate\b/i.test(l.rel) && l.getAttribute("href"));
  let applied = 0;
  for (const l of linkEls) { if (l.sheet) applied++; }
  return { linked: linkEls.length, applied };
}

/**
 * Runs inside the page. Outlines every link and image whose resolved address is
 * in the lists, adds a small red label, and scrolls the first visible one into
 * view. Returns how many were outlined (visible ones count).
 */
function outlineInPage({ links, images }) {
  const norm = (u) => {
    try {
      const x = new URL(u, location.href);
      x.hash = "";
      return x.href.replace(/\/$/, "");
    } catch {
      return String(u || "");
    }
  };
  const linkSet = new Set(links.map(norm));
  const imageSet = new Set(images.map(norm));
  const hits = [];
  if (linkSet.size) {
    for (const a of document.querySelectorAll("a[href]")) {
      if (linkSet.has(norm(a.href))) hits.push({ el: a, label: "broken link", kind: "link" });
    }
  }
  if (imageSet.size) {
    for (const img of document.querySelectorAll("img")) {
      const cands = [img.currentSrc, img.src, img.getAttribute("data-src"), img.getAttribute("data-lazy-src")].filter(Boolean).map(norm);
      if (cands.some((c) => imageSet.has(c))) hits.push({ el: img, label: "broken image", kind: "image" });
    }
  }
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  };
  document.documentElement.style.scrollBehavior = "auto";
  const first = hits.find((h) => visible(h.el));
  if (first) {
    try { first.el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }); } catch { first.el.scrollIntoView(); }
  }
  let shown = 0;
  let linksShown = 0;
  let imagesShown = 0;
  for (const h of hits) {
    if (!visible(h.el)) continue;
    h.el.style.setProperty("outline", "3px solid #DC2626", "important");
    h.el.style.setProperty("outline-offset", "2px", "important");
    const r = h.el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) { shown++; if (h.kind === "link") linksShown++; else imagesShown++; continue; }
    const tag = document.createElement("div");
    tag.textContent = h.label;
    tag.setAttribute("data-sutros-proof", "1");
    Object.assign(tag.style, {
      position: "fixed",
      left: Math.max(2, Math.round(r.left)) + "px",
      top: Math.max(2, Math.round(r.top >= 24 ? r.top - 22 : r.bottom + 4)) + "px",
      background: "#DC2626",
      color: "#fff",
      font: "600 12px/1 system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      padding: "4px 7px",
      borderRadius: "3px",
      zIndex: "2147483647",
      pointerEvents: "none",
      whiteSpace: "nowrap",
      boxShadow: "0 1px 3px rgba(0,0,0,.35)",
    });
    document.body.appendChild(tag);
    shown++;
    if (h.kind === "link") linksShown++; else imagesShown++;
  }
  return { visible: shown, links: linksShown, images: imagesShown };
}

// ---- storage ----

/** Store pictures for a report. Duplicate keys are ignored. Resolves the number inserted. */
export async function saveShots(reportId, shots = []) {
  if (!dbEnabled() || !ID_RE.test(String(reportId || ""))) return 0;
  let n = 0;
  for (const s of Array.isArray(shots) ? shots : []) {
    if (!s || !KEY_RE.test(String(s.key || ""))) continue;
    const bytes = Buffer.isBuffer(s.bytes) ? s.bytes : s.bytes instanceof Uint8Array ? Buffer.from(s.bytes) : null;
    if (!bytes || !bytes.length) continue;
    const rows = await sql(
      `INSERT INTO report_shots (report_id, key, page_url, mime, bytes, width, height)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (report_id, key) DO NOTHING RETURNING key`,
      [reportId, s.key, String(s.page || "").slice(0, 2000), s.mime || "image/jpeg", bytes, s.width || null, s.height || null]
    );
    n += rows.length;
  }
  return n;
}

/** Delete pictures of reports older than `days`. Resolves the number of rows removed. */
export async function sweepOldShots(days = SHOT_RETENTION_DAYS) {
  if (!dbEnabled()) return 0;
  const d = Math.max(1, Math.floor(Number(days) || 60));
  const rows = await sql(
    `DELETE FROM report_shots s
      WHERE s.report_id IN (SELECT id FROM reports WHERE created_at < now() - make_interval(days => $1::int))
         OR (s.created_at < now() - make_interval(days => $1::int)
             AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.id = s.report_id))
      RETURNING s.key`,
    [d]
  );
  return rows.length;
}

// ---- route ----

proofRouter.get("/api/reports/:id/shots/:key", async (req, res) => {
  const { id, key } = req.params;
  if (!ID_RE.test(id) || !KEY_RE.test(key)) return res.status(400).json({ error: "Bad picture address." });
  if (!dbEnabled()) return res.status(404).json({ error: "We couldn't find that picture." });
  try {
    const rows = await sql(`SELECT mime, bytes FROM report_shots WHERE report_id = $1 AND key = $2`, [id, key]);
    if (!rows.length || !rows[0].bytes) return res.status(404).json({ error: "We couldn't find that picture." });
    for (const [name, value] of Object.entries(shotHeaders(rows[0].mime))) res.setHeader(name, value);
    res.setHeader("Content-Length", String(rows[0].bytes.length));
    res.end(rows[0].bytes);
  } catch (err) {
    console.error("proof shot:", err && err.message ? err.message : err);
    res.status(500).json({ error: "Could not load that picture." });
  }
});

// ---- helpers ----

function okUrl(u, siteHost) {
  let x;
  try { x = new URL(String(u || "")); } catch { return false; }
  if (x.protocol !== "http:" && x.protocol !== "https:") return false;
  if (siteHost && !sameSite(x.href, siteHost)) return false;
  return true;
}

/** True when the address the browser ended up on is still the site's, and not a private address. */
/**
 * May this address be pictured? It must be on the site and must not be a private or
 * loopback address, whatever host the checkup started on. Exported for the tests.
 */
export function stayedOnSite(u, siteHost) {
  let x;
  try { x = new URL(String(u || "")); } catch { return false; }
  if (!okUrl(x.href, siteHost)) return false;
  const host = x.hostname.replace(/^\[|\]$/g, "");
  if (/^[\d.]+$|:/.test(host) && isPrivateIp(host)) return false;
  return true;
}

/**
 * A yes/no for "may we open a page on this host?". The homepage's own host was
 * cleared by the safety guard before the checkup began; any other host (a
 * subdomain) is resolved once and must be public. Only standard web ports.
 */
function hostGuard(homepage) {
  let home = "";
  try { home = new URL(homepage).hostname.toLowerCase(); } catch {}
  const cache = new Map(); // hostname -> Promise<boolean>
  return async (url) => {
    let u;
    try { u = new URL(String(url || "")); } catch { return false; }
    const host = u.hostname.toLowerCase();
    if (host === home) return true;
    if (u.port && u.port !== "80" && u.port !== "443") return false;
    if (!cache.has(host)) cache.set(host, resolveTarget(u).then((r) => Boolean(r && r.ok)).catch(() => false));
    return cache.get(host);
  };
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

function sameSite(url, siteHost) {
  const h = hostOf(url);
  if (!h) return false;
  if (!siteHost) return true;
  return h === siteHost || h.endsWith("." + siteHost) || siteHost.endsWith("." + h);
}

function withTimeout(promise, ms) {
  let timer;
  const gate = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), ms); });
  return Promise.race([promise, gate]).finally(() => clearTimeout(timer));
}
