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
//  - only 404, 410, 500, 502, 504 (twice) count as broken; a connection that never
//    got an answer is a coverage gap, never a broken link or image;
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

  const results = { image: [], link: [] }; // { item, verdict, status, statusText, reason }
  for (const item of [...imgSample, ...linkSample]) {
    if (throttle.stopped) {
      results[item.kind].push({ item, verdict: "untested", status: 0, statusText: "not tested", reason: throttle.reason });
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
    results[item.kind].push({ item, verdict: r.reason === "budget" ? "untried" : r.verdict, status: r.status, statusText: r.statusText, retried: r.retried, reason: r.reason, transport: r.transport, firstStatus: r.firstStatus, firstText: r.firstText });
  }

  const stopReason = throttle.reason;
  const imgStats = summarize(results.image, stopReason);
  const linkStats = summarize(results.link, stopReason);
  const stats = summarize([...results.image, ...results.link], stopReason);
  const complete = stats.ok + stats.broken.length === stats.sampled;

  if (imgStats.broken.length) {
    const n = imgStats.broken.length;
    findings.push({
      id: "broken-images",
      category: "quality",
      severity: "watch",
      title: `${n} image${n > 1 ? "s" : ""} answered with an error`,
      meaning:
        `When Sutros asked for ${n === 1 ? "this image address" : "these image addresses"}, the server answered with an error status both times, once with standard browser headers. That usually means a picture is missing at that address, but it is what our checker received, not a measurement of every visitor's screen.`,
      fix: [
        "Open the page listed and look at that spot, then open the image address directly in a browser to see what it returns for you.",
        "If it is missing for you too, re-upload the image or fix the address pointing to it.",
      ],
      who: "You can often check and fix this yourself.",
      evidence: buildEvidence(imgStats, "image", origin),
    });
  }
  if (linkStats.broken.length) {
    const n = linkStats.broken.length;
    findings.push({
      id: "broken-links",
      category: "quality",
      severity: "watch",
      title: `${n} link${n > 1 ? "s" : ""} answered with an error`,
      meaning:
        `When Sutros followed ${n === 1 ? "this link" : "these links"}, the destination answered with an error status both times, once with standard browser headers. That usually means the page is missing or failing at that address, but it is what our checker received, not a measurement of every visitor's experience.`,
      fix: [
        "Select each link on the page listed and see what it opens for you.",
        "If it reaches an error for you too, update or remove the link.",
      ],
      who: "You or your web person.",
      evidence: buildEvidence(linkStats, "link", origin),
    });
  }

  const worked = imgStats.ok + linkStats.ok;
  if (complete && !imgStats.broken.length && !linkStats.broken.length && worked > 0) {
    const parts = [];
    if (linkStats.ok) parts.push(`${linkStats.ok} link${linkStats.ok === 1 ? "" : "s"}`);
    if (imgStats.ok) parts.push(`${imgStats.ok} image${imgStats.ok === 1 ? "" : "s"}`);
    passes.push(`The ${parts.join(" and ")} we tested ${worked === 1 ? "works" : "all work"}.`);
  }

  if (complete) return { findings, passes, status: "completed" };
  const reason = `${stats.ok + stats.broken.length} of ${stats.sampled} sampled links and images gave conclusive results (${stats.ok} working, ${stats.broken.length} broken).${limitations(stats)}`;
  return { findings, passes, status: "inconclusive", reason };
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

function summarize(list, stopReason = "") {
  const out = { sampled: list.length, ok: 0, broken: [], limited: 0, inconclusive: 0, inconsistent: [], unreachable: 0, unreachableText: "", untried: 0, untested: 0, skipped: 0, tested: 0, stopReason };
  for (const r of list) {
    if (r.verdict === "skipped") { out.skipped++; continue; }
    if (r.verdict === "untried") { out.untried++; continue; }
    if (r.verdict === "untested") { out.untested++; continue; }
    out.tested++;
    if (r.verdict === "ok") out.ok++;
    else if (r.verdict === "broken") out.broken.push(r);
    else if (r.verdict === "blocked") out.limited++;
    else if (r.transport) { out.unreachable++; out.unreachableText = out.unreachableText || r.statusText; }
    else if (r.reason === "mismatch" || r.reason === "single-error") out.inconsistent.push(r);
    else out.inconclusive++;
  }
  return out;
}

function limitations(stats) {
  let text = "";
  if (stats.limited) text += ` Refused or blocked by the site: ${stats.limited}.`;
  if (stats.unreachable) text += ` Could not connect from our network: ${stats.unreachable} (${stats.unreachableText}). A connection that fails without an answer does not show what visitors see.`;
  if (stats.inconsistent.length) text += ` Error answers that did not repeat: ${stats.inconsistent.length} (${describeAttempts(stats.inconsistent[0])}); one error answer is not confirmation.`;
  if (stats.inconclusive) text += ` No conclusive answer: ${stats.inconclusive}.`;
  if (stats.untested) {
    text += stats.stopReason === "unreachable"
      ? ` Left untested after repeated connection failures: ${stats.untested}.`
      : ` Left untested after a site limit: ${stats.untested}.`;
  }
  if (stats.untried) text += ` Left untested after the time or request budget: ${stats.untried}.`;
  if (stats.skipped) text += ` Not requested because of the safety guard: ${stats.skipped}.`;
  return text;
}

/** "404 then 500", or "connection refused then 500" when the first try never got an answer. */
function describeAttempts(r) {
  const first = r.firstStatus ? String(r.firstStatus) : (r.firstText || "no answer");
  return `${first} then ${r.status}`;
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

  const note = `${stats.broken.length} broken among ${stats.sampled} sampled ${plural}; ${stats.ok + stats.broken.length} gave conclusive results.${limitations(stats)}`;

  const method =
    `We selected ${stats.sampled} ${kind} addresses and attempted requests for ${stats.tested}, sending a HEAD request first and a GET when the server does not allow HEAD. ` +
    `Any address that answered with an error was requested once more with standard browser headers after a short wait, and it counts as broken only when both answers were the same 404, 410, 500, 502, or 504 status. ` +
    `A connection that failed without an answer is never counted as broken; it is listed as a gap in what we could test, because a failure between our network and the site does not show what visitors see.`;

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
