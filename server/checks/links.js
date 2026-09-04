// links.js
// Step 4: check for broken links and broken images, the small stuff that makes
// a site feel neglected. We sample a bounded number so we stay polite.
//
// Honest by design (round 3):
//  - links and images are gathered from every crawled page, and we remember
//    the first page that referenced each address and its link text or alt text
//  - HEAD first (cheap), GET when HEAD is not allowed
//  - any error answer gets one more look with standard browser headers, so a
//    site that only refuses automated checkers is never reported as broken
//  - only 404, 410, 500, 502, 504 (twice) or a failed connection count as broken;
//    401, 403, 405, 406, 429, 503 mean the site limited our checker
//  - after two answers of 429 from one host we stop and say so
//  - 250 ms between requests, and the whole check stops after a time budget
//  - images on another host are only requested when the safety guard says
//    that host is public (same rule as the site itself)

import { config, resolveTarget } from "../safety.js";
import { probeAddress, createThrottleGuard, sleep } from "../lib/http.js";

const PACE_MS = 250;
const MAX_LINES = 8;
const MAX_PAGES = 6;
const CHECK_BUDGET_MS = 60_000;

export async function runLinks(ctx) {
  const { client, facts } = ctx;
  const findings = [];
  const passes = [];
  const origin = facts && facts.baseOrigin;
  const pages = crawledPages(facts);
  if (!client || !origin || !pages.length) return { findings, passes };

  // ---- gather, homepage first, remembering where each address was seen ----
  const links = new Map(); // href -> { url, kind, page, text }
  const images = new Map();
  for (const page of pages) {
    const $ = page.$;
    if (!$ || typeof $ !== "function") continue;
    const pageUrl = typeof page.url === "string" && page.url ? page.url : origin + "/";
    $("a[href]").each((_, el) => {
      const abs = absolute($(el).attr("href"), pageUrl);
      if (!abs || abs.origin !== origin) return;
      abs.hash = "";
      if (!links.has(abs.href)) links.set(abs.href, { url: abs.href, kind: "link", page: pageUrl, text: linkText($, el) });
    });
    $("img[src], img[data-src]").each((_, el) => {
      const abs = absolute($(el).attr("data-src"), pageUrl) || absolute($(el).attr("src"), pageUrl);
      if (!abs) return;
      abs.hash = "";
      if (!images.has(abs.href)) images.set(abs.href, { url: abs.href, kind: "image", page: pageUrl, text: clip($(el).attr("alt")) });
    });
  }

  // Budget the samples: favor images (visitors see those immediately).
  const imgSample = [...images.values()].slice(0, Math.ceil(config.maxLinks / 2));
  const linkSample = [...links.values()].slice(0, config.maxLinks - imgSample.length);
  if (!imgSample.length && !linkSample.length) return { findings, passes };

  // ---- test, politely ----
  if (facts.throttled) await sleep(3000); // an earlier check already saw the site limiting us
  const throttle = createThrottleGuard(facts, 2);
  const deadline = Date.now() + CHECK_BUDGET_MS;
  const hostOk = hostGuard(origin, typeof ctx.resolveTarget === "function" ? ctx.resolveTarget : resolveTarget);
  let sent = 0;
  let outOfBudget = false;
  const pace = async () => {
    if (sent++ > 0) await sleep(PACE_MS);
  };

  const results = { image: [], link: [] }; // { item, verdict, status, statusText }
  for (const item of [...imgSample, ...linkSample]) {
    if (throttle.stopped) {
      results[item.kind].push({ item, verdict: "untested", status: 0, statusText: "not tested" });
      continue;
    }
    if (outOfBudget || Date.now() > deadline) {
      results[item.kind].push({ item, verdict: "untried", status: 0, statusText: "not tested" });
      continue;
    }
    // Same-origin addresses were cleared when the checkup started. Anything else
    // (an image on another host) goes through the same public-address guard first.
    if (!(await hostOk(item.url))) {
      results[item.kind].push({ item, verdict: "skipped", status: 0, statusText: "not tested" });
      continue;
    }
    const r = await probeAddress(client, item.url, { headFirst: true, throttle, pace });
    if (r.reason === "budget") outOfBudget = true;
    results[item.kind].push({ item, verdict: r.reason === "budget" ? "untried" : r.verdict, status: r.status, statusText: r.statusText, retried: r.retried });
  }

  const imgStats = summarize(results.image);
  const linkStats = summarize(results.link);

  if (imgStats.broken.length) {
    const n = imgStats.broken.length;
    findings.push({
      id: "broken-images",
      category: "quality",
      severity: "watch",
      title: `${n} image${n > 1 ? "s are" : " is"} broken`,
      meaning:
        "Some images on this site don't load, so visitors see a broken-image icon instead. Most people browse on phones, and a missing photo is often the first thing they notice.",
      fix: ["Re-upload the missing images, or fix the addresses pointing to them."],
      who: "You can often do this yourself.",
      evidence: buildEvidence(imgStats, "image", origin),
    });
  }
  if (linkStats.broken.length) {
    const n = linkStats.broken.length;
    findings.push({
      id: "broken-links",
      category: "quality",
      severity: "watch",
      title: `${n} link${n > 1 ? "s lead" : " leads"} nowhere`,
      meaning:
        "Some links on this site point to pages that no longer exist. Visitors who click them get an error page instead, and a site with links that go nowhere looks unattended.",
      fix: ["Update or remove the broken links so every one goes somewhere real."],
      who: "You or your web person.",
      evidence: buildEvidence(linkStats, "link", origin),
    });
  }

  const worked = imgStats.ok + linkStats.ok;
  const limited = imgStats.limited + linkStats.limited;
  if (!imgStats.broken.length && !linkStats.broken.length && worked > 0) {
    const parts = [];
    if (linkStats.ok) parts.push(`${linkStats.ok} link${linkStats.ok === 1 ? "" : "s"}`);
    if (imgStats.ok) parts.push(`${imgStats.ok} image${imgStats.ok === 1 ? "" : "s"}`);
    let text = `The ${parts.join(" and ")} we tested ${worked === 1 ? "works" : "all work"}`;
    if (limited > 0) text += `, ${limited} could not be tested because the site limited our checker`;
    passes.push(text + ".");
  }

  return { findings, passes };
}

// ---- helpers ----

/** Every crawled page as { url, $ }, homepage first; falls back to the homepage facts alone. */
function crawledPages(facts) {
  if (!facts) return [];
  if (Array.isArray(facts.pages) && facts.pages.length) return facts.pages.filter((p) => p && p.$);
  if (facts.$) return [{ url: (facts.finalUrl && facts.finalUrl.href) || facts.baseOrigin + "/", $: facts.$ }];
  return [];
}

/**
 * A yes/no for "may we request this address?". The site's own origin was
 * cleared by the safety guard before the checkup began; any other host is
 * resolved once and must be public. Only standard web ports.
 */
function hostGuard(origin, resolve = resolveTarget) {
  const cache = new Map(); // hostname -> boolean
  return async (url) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (u.origin === origin) return true;
    if (u.port && u.port !== "80" && u.port !== "443") return false;
    const host = u.hostname.toLowerCase();
    if (cache.has(host)) return cache.get(host);
    let ok = false;
    try {
      const r = await resolve(u);
      ok = Boolean(r && r.ok);
    } catch {
      ok = false;
    }
    cache.set(host, ok);
    return ok;
  };
}

function summarize(list) {
  const out = { ok: 0, broken: [], limited: 0, inconclusive: 0, untried: 0, tested: 0 };
  for (const r of list) {
    if (r.verdict === "skipped") continue; // never requested, so it is not part of the count
    out.tested++;
    if (r.verdict === "ok") out.ok++;
    else if (r.verdict === "broken") out.broken.push(r);
    else if (r.verdict === "blocked" || r.verdict === "untested") out.limited++;
    else if (r.verdict === "untried") out.untried++;
    else out.inconclusive++;
  }
  return out;
}

function buildEvidence(stats, kind, origin) {
  const plural = kind === "image" ? "images" : "links";
  const lines = stats.broken.slice(0, MAX_LINES).map((r) => lineFor(r, origin));
  if (stats.broken.length > MAX_LINES) lines.push(`and ${stats.broken.length - MAX_LINES} more`);

  const items = stats.broken.map((r) => ({
    url: r.item.url,
    status: r.status,
    statusText: r.statusText,
    page: r.item.page,
    text: r.item.text || "",
    kind: r.item.kind,
  }));

  const pages = [];
  for (const r of stats.broken) {
    if (r.item.page && !pages.includes(r.item.page)) pages.push(r.item.page);
    if (pages.length >= MAX_PAGES) break;
  }

  let note = `${stats.broken.length} broken of ${stats.tested} ${plural} tested.`;
  if (stats.limited > 0) note += ` ${stats.limited} could not be tested because the site limited our checker.`;
  if (stats.inconclusive > 0) note += ` ${stats.inconclusive} gave no answer in time, so we could not tell either way.`;
  if (stats.untried > 0) note += ` ${stats.untried} were left untested because this checkup ran out of time.`;

  const method =
    `We requested each of the ${stats.tested} ${kind} addresses ourselves, sending a HEAD request first and a GET when the server does not allow HEAD. ` +
    `Any address that answered with an error or failed to connect was requested once more with standard browser headers after a short wait, and it counts as broken only when the second answer was also 404, 410, 500, 502, or 504, or when the connection failed both times.`;

  return { lines, items, pages, method, note };
}

/** `404 Not Found  /en/download/  (link "Download" on /)` */
function lineFor(r, origin) {
  const status = r.status > 0 ? `${r.status} ${r.statusText}` : r.statusText;
  const where = r.item.text ? `${r.item.kind} "${r.item.text}" on ${pathOf(r.item.page, origin)}` : `${r.item.kind} on ${pathOf(r.item.page, origin)}`;
  return `${status}  ${shorten(r.item.url, origin)}  (${where})`;
}

function absolute(href, base) {
  if (!href || typeof href !== "string") return null;
  const h = href.trim();
  if (!h || h.startsWith("#") || /^(mailto|tel|sms|javascript|data|blob|about):/i.test(h)) return null;
  try {
    const u = new URL(h, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u;
  } catch {
    return null;
  }
}

/** Visible link text, falling back to an aria-label, title, or the alt text of an image inside the link. */
function linkText($, el) {
  const own = clip($(el).text());
  if (own) return own;
  return clip($(el).attr("aria-label")) || clip($(el).attr("title")) || clip($(el).find("img[alt]").first().attr("alt"));
}

function clip(s) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, 60);
}

/** Site path for same-origin addresses, the full address otherwise. */
function shorten(u, origin) {
  try {
    const x = new URL(u);
    if (x.origin === origin) return (x.pathname + x.search).slice(0, 80) || "/";
    return x.href.slice(0, 80);
  } catch {
    return String(u).slice(0, 80);
  }
}

function pathOf(u, origin) {
  try {
    const x = new URL(u);
    if (x.origin === origin) return (x.pathname + x.search) || "/";
    return x.href;
  } catch {
    return "/";
  }
}
