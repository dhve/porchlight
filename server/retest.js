// retest.js
// "Check this again right now": re-request the concrete addresses behind a
// saved finding so a reader can see whether the problem is still there.
//
//   POST /api/reports/:id/retest   body { findingId }
//   -> 200 { findingId, checkedAt, items: [{ url, previous, status, statusText, ok, changed }] }
//
// Read-only GETs with standard browser headers, at most 8 addresses, 200 ms
// apart, bodies discarded. Only addresses on the report's own host (or a
// subdomain of it) on a standard web port are touched, every one passes the
// safety guard first, and redirects are followed one hop at a time with the
// same checks on each hop, so a redirect can never point us at a private
// address.

import express from "express";
import { getReport, dbEnabled } from "./db.js";
import { createClient, statusText, classifyError, sleep } from "./lib/http.js";
import { resolveTarget } from "./safety.js";
import { consume, ip } from "./ratelimit.js";

const ID_RE = /^[A-Za-z0-9_-]{6,20}$/;
const MAX_ITEMS = 8;
const TIMEOUT_MS = 8000;
const GAP_MS = 200;
const MAX_HOPS = 5;

/**
 * Build the router. Dependencies can be swapped for tests; the defaults are
 * the real modules.
 */
export function createRetestRouter({
  loadReport = getReport,
  dbOn = dbEnabled,
  resolve = resolveTarget,
  makeClient = createClient,
  consumeFn = consume,
  ipFn = ip,
  gapMs = GAP_MS,
} = {}) {
  const router = express.Router();

  router.post("/api/reports/:id/retest", async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      console.error("retest:", err && err.message ? err.message : err);
      if (!res.headersSent) res.status(500).json({ error: "Could not check that right now. Please try again in a minute." });
    }
  });

  async function handle(req, res) {
    const id = String(req.params.id || "");
    if (!ID_RE.test(id)) return res.status(400).json({ error: "Bad report id." });
    const findingId = typeof req.body?.findingId === "string" ? req.body.findingId.trim() : "";
    if (!findingId || findingId.length > 120) return res.status(400).json({ error: "Please say which finding to check again." });

    const perIp = consumeFn("retest-ip", ipFn(req), 20, 3600000);
    if (!perIp.ok) return res.status(429).json({ error: "You have checked a lot of findings in the last hour. Please wait a bit and try again." });
    const perReport = consumeFn("retest-report", id, 6, 600000);
    if (!perReport.ok) return res.status(429).json({ error: "This report was checked again several times in the last few minutes. Please wait a little before trying once more." });

    if (!dbOn()) return res.status(503).json({ error: "Saved reports need a database, which isn't set up here yet." });

    let report;
    try {
      report = await loadReport(id);
    } catch (err) {
      console.error("retest: load report:", err && err.message ? err.message : err);
      return res.status(500).json({ error: "Could not load that report right now. Please try again." });
    }
    if (!report) return res.status(404).json({ error: "We couldn't find that report." });

    const finding = (Array.isArray(report.findings) ? report.findings : []).find((f) => f && f.id === findingId);
    if (!finding) return res.status(400).json({ error: "That finding isn't part of this report." });

    const items = itemsOf(finding).slice(0, MAX_ITEMS);
    if (!items.length) return res.status(422).json({ error: "There is nothing in this finding that we can check again." });

    // The report's own host plus every host the finding already names (an off-site image, for
    // example). Those addresses came from our own saved checkup, not from the client, and every
    // hop still has to pass the safety guard below.
    const host = [reportHost(report), ...items.map((it) => { try { return new URL(it.url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } })].filter(Boolean);
    const client = makeClient();
    const out = [];
    let sent = 0;
    for (const item of items) {
      const previous = Number(item.status) > 0 ? Number(item.status) : 0;
      const wasOk = previous > 0 && previous < 400;
      const target = parseHttpUrl(item.url);
      if (!target || !(await allowed(target, host, resolve))) {
        out.push({ url: item.url, previous, status: 0, statusText: "not allowed", ok: false, changed: wasOk });
        continue;
      }

      if (sent++ > 0) await sleep(gapMs);
      const { status, text } = await fetchStatus(client, target, host, resolve);
      const ok = status >= 200 && status < 400;
      out.push({ url: item.url, previous, status, statusText: text, ok, changed: ok !== wasOk });
    }

    res.json({ findingId, checkedAt: new Date().toISOString(), items: out });
  }

  return router;
}

export const retestRouter = createRetestRouter();

// ---- helpers ----

/**
 * GET one address, following redirects one hop at a time so every hop is held
 * to the same host and safety rules. Returns the final status, or 0 with a
 * short reason when the request never completed or a hop was not allowed.
 */
async function fetchStatus(client, target, host, resolve) {
  let current = target;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    let r;
    try {
      r = await client.get(current.href, { browserLike: true, timeoutMs: TIMEOUT_MS, redirect: "manual" });
    } catch (err) {
      return { status: 0, text: classifyError(err).statusText };
    }
    try { if (r && typeof r.discard === "function") r.discard(); } catch {}
    const status = Number(r && r.status) || 0;
    const location = status >= 300 && status < 400 && r.headers && typeof r.headers.get === "function" ? r.headers.get("location") : null;
    if (!location) return { status, text: statusText(status) };
    if (hop === MAX_HOPS) return { status, text: statusText(status) };
    let next;
    try {
      next = new URL(location, current);
    } catch {
      return { status, text: statusText(status) };
    }
    if (!isHttp(next) || !(await allowed(next, host, resolve))) return { status: 0, text: "not allowed" };
    current = next;
  }
  return { status: 0, text: "did not load" };
}

/** The finding's evidence items that carry an http(s) address. */
function itemsOf(finding) {
  const list = finding && finding.evidence && Array.isArray(finding.evidence.items) ? finding.evidence.items : [];
  return list.filter((i) => i && typeof i.url === "string" && /^https?:\/\//i.test(i.url.trim())).map((i) => ({ ...i, url: i.url.trim() }));
}

function parseHttpUrl(s) {
  try {
    const u = new URL(String(s));
    return isHttp(u) ? u : null;
  } catch {
    return null;
  }
}

function isHttp(u) {
  return u.protocol === "http:" || u.protocol === "https:";
}

/** Same host or a subdomain, standard web port, and the safety guard says the address is public. */
async function allowed(u, host, resolve) {
  const hosts = Array.isArray(host) ? host : [host];
  if (!hosts.some((h) => hostAllowed(u.hostname, h))) return false;
  if (u.port && u.port !== "80" && u.port !== "443") return false;
  try {
    const safe = await resolve(u);
    return Boolean(safe && safe.ok);
  } catch {
    return false;
  }
}

/** The host a report was about, lowercase, without a leading www. */
function reportHost(report) {
  let host = "";
  try {
    host = new URL(String(report.url || "")).hostname;
  } catch {
    host = "";
  }
  if (!host && typeof report.target === "string") host = report.target.trim();
  return host.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

/** True when `hostname` is the report host itself or a subdomain of it. */
function hostAllowed(hostname, host) {
  if (!host) return false;
  const h = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return h === host || h.endsWith("." + host);
}
