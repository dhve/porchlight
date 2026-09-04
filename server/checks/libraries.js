// libraries.js
// Step 3: find front-end libraries running known-vulnerable versions. This is
// the idea behind Retire.js: read the version out of the script URL (or inline),
// and compare it against a bundled list of versions with public advisories.
//
// Deterministic. Detection only: we report the version and the known issue, we
// do not attempt to exploit anything.
//
// Every finding carries evidence.pages (the pages that load the script),
// evidence.method (how we tested it), and evidence.items (the script address).
// A script on this site's own domain is requested once so the item carries the
// status it answered; a script on another domain is listed with status 0 and
// "not requested", since our checker only loads addresses on the site being
// checked. After two 429 answers we stop requesting and set facts.throttled.
// A subdomain is looked up through the safety guard before it is requested,
// so the checker never follows a page's markup to a private address.

import { inRange } from "../lib/semver.js";
import { resolveTarget } from "../safety.js";

// A curated set of popular libraries with known-vulnerable version ranges.
// `below` is exclusive. Each entry is worded for a non-technical owner.
const KNOWN = [
  { name: "jQuery", re: /jquery[-.]?(\d+\.\d+(?:\.\d+)?)(?:\.min)?\.js/i, ranges: [
    { below: "3.5.0", severity: "serious", note: "Versions before 3.5.0 have a known cross-site scripting (XSS) weakness (CVE-2020-11022/11023)." },
    { below: "1.9.0", severity: "serious", note: "Very old jQuery has multiple known security issues." },
  ]},
  { name: "jQuery UI", re: /jquery-ui[-.]?(\d+\.\d+(?:\.\d+)?)(?:\.min)?\.js/i, ranges: [
    { below: "1.13.2", severity: "serious", note: "Versions before 1.13.2 have a known XSS issue (CVE-2022-31160)." },
  ]},
  { name: "Bootstrap", re: /bootstrap[-.]?(\d+\.\d+(?:\.\d+)?)(?:\.min)?\.js/i, ranges: [
    { atLeast: "4.0.0", below: "4.3.1", severity: "serious", note: "Bootstrap 4 before 4.3.1 has a known XSS issue (CVE-2019-8331)." },
    { below: "3.4.1", severity: "serious", note: "Bootstrap 3 before 3.4.1 has known XSS issues." },
  ]},
  { name: "AngularJS", re: /angular[-.]?(\d+\.\d+(?:\.\d+)?)(?:\.min)?\.js/i, ranges: [
    { below: "1.8.0", severity: "serious", note: "AngularJS (1.x) before 1.8 has multiple XSS/sandbox-bypass issues, and 1.x is end-of-life." },
  ]},
  { name: "Lodash", re: /lodash[-.]?(\d+\.\d+(?:\.\d+)?)(?:\.min)?\.js/i, ranges: [
    { below: "4.17.21", severity: "serious", note: "Lodash before 4.17.21 has prototype-pollution and ReDoS issues (CVE-2021-23337 and others)." },
  ]},
  { name: "Moment.js", re: /moment[-.]?(\d+\.\d+(?:\.\d+)?)(?:\.min)?\.js/i, ranges: [
    { below: "2.29.4", severity: "watch", note: "Moment before 2.29.4 has a path-traversal / ReDoS issue, and Moment is no longer actively developed." },
  ]},
  { name: "Handlebars", re: /handlebars[-.]?(\d+\.\d+(?:\.\d+)?)(?:\.min)?\.js/i, ranges: [
    { below: "4.7.7", severity: "serious", note: "Handlebars before 4.7.7 has prototype-pollution / RCE issues in template compilation." },
  ]},
  { name: "DOMPurify", re: /(?:purify|dompurify)[-.]?(\d+\.\d+(?:\.\d+)?)(?:\.min)?\.js/i, ranges: [
    { below: "2.4.0", severity: "serious", note: "DOMPurify before 2.4.0 has known sanitizer-bypass issues." },
  ]},
  { name: "Axios", re: /axios[-.]?(\d+\.\d+(?:\.\d+)?)(?:\.min)?\.js/i, ranges: [
    { below: "0.21.2", severity: "watch", note: "Axios before 0.21.2 has a server-side request forgery (SSRF) issue." },
  ]},
  { name: "Select2", re: /select2[-.]?(\d+\.\d+(?:\.\d+)?)(?:\.min)?\.js/i, ranges: [
    { below: "4.0.6", severity: "watch", note: "Select2 before 4.0.6 has a known XSS issue." },
  ]},
];

const STATUS_TEXT = {
  200: "OK", 201: "Created", 204: "No Content", 301: "Moved Permanently", 302: "Found", 304: "Not Modified",
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
  406: "Not Acceptable", 408: "Request Timeout", 410: "Gone", 429: "Too Many Requests",
  500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
};

export async function runLibraries(ctx) {
  const { facts, client } = ctx;
  const findings = [];
  const passes = [];
  const scripts = facts.scripts || [];
  if (!scripts.length && !facts.html) return { findings, passes };
  const homepage = homepageOf(facts);
  const throttle = { count: 0, stop: false };

  const hits = [];
  const sources = scripts.map((s) => String((s && s.src) || "")).filter(Boolean);
  // also scan inline references in page HTML for version comments
  for (const lib of KNOWN) {
    let found = null;
    let src = null;
    for (const s of sources) {
      const m = s.match(lib.re);
      if (m) { found = m[1]; src = s; break; }
    }
    if (!found && facts.html) {
      const m = facts.html.match(lib.re);
      if (m) found = m[1];
    }
    if (!found) continue;
    for (const range of lib.ranges) {
      if (inRange(found, range)) {
        hits.push({ name: lib.name, version: found, src, ...range });
        break; // report the first (most relevant) matching range
      }
    }
  }

  if (!hits.length) {
    if (scripts.length) passes.push("The front-end libraries we could identify are up to date.");
    return { findings, passes };
  }

  for (const h of hits) {
    const items = [];
    let pages = [homepage];
    let requested = false; // did we actually load the script once
    if (h.src) {
      pages = pagesReferencing(facts, [h.src], homepage);
      const item = { url: h.src, status: 0, statusText: "not requested", page: pages[0], kind: "resource" };
      if (client && !throttle.stop && (await allowedOnSite(h.src, facts))) {
        requested = true;
        try {
          const res = await client.get(h.src);
          noteStatus(facts, throttle, res.status);
          release(res);
          item.status = res.status;
          item.statusText = statusTextOf(res);
        } catch {
          item.statusText = "did not load";
        }
      }
      items.push(item);
    }
    findings.push({
      id: `vuln-lib-${h.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      category: "vulnerable-component",
      severity: h.severity,
      title: `${h.name} ${h.version} has a known security weakness`,
      meaning: `Your site loads ${h.name} version ${h.version}. ${h.note} Attackers actively scan for outdated libraries like this because the weakness is public.`,
      fix: [
        `Update ${h.name} to its latest version.`,
        "If a plugin or theme bundles this library, update that too, or ask your web person which one ships it.",
      ],
      who: "Your web person.",
      evidence: {
        lines: [`Detected ${h.name} ${h.version}`, `Known issue: ${h.note}`],
        note: "Version read from the script URL or page source.",
        method: h.src
          ? `We read the address of every script this site loads and compared the version number in the file name of ${h.name} with published security advisories. ${requested ? "Because the script is on this site's own domain, we also requested it once to record how it answers." : sameHost(h.src, facts) ? "We listed the script's address without loading it." : "The script is hosted on another domain, so we listed its address without loading it."}`
          : `We read the homepage source and found a reference to ${h.name} ${h.version}, then compared that version with published security advisories. We did not run or load the script.`,
        pages,
        items,
      },
    });
  }

  return { findings, passes };
}

// ---- helpers ----

// Count 429 answers; after two, stop probing in this check and tell the pipeline.
function noteStatus(facts, throttle, status) {
  if (status !== 429) return;
  throttle.count++;
  if (throttle.count >= 2) {
    throttle.stop = true;
    facts.throttled = true;
  }
}

function statusTextOf(res) {
  return (res && res.statusText) || statusWords(res && res.status);
}

// Human words for a status code, always a string.
function statusWords(code) {
  const n = Number(code);
  if (STATUS_TEXT[n]) return STATUS_TEXT[n];
  if (n >= 200 && n < 300) return "OK";
  if (n >= 300 && n < 400) return "Redirect";
  if (n >= 400 && n < 500) return "Client Error";
  if (n >= 500 && n < 600) return "Server Error";
  return "";
}

// Let go of a body we are not going to read, so the connection is released.
function release(res) {
  try { if (res && typeof res.discard === "function") res.discard(); } catch {}
}

function href(u) {
  if (!u) return "";
  if (typeof u === "string") return u;
  return u.href || String(u);
}

function homepageOf(facts) {
  return href(facts.finalUrl) || href(facts.pages && facts.pages[0] && facts.pages[0].url) || (facts.baseOrigin ? facts.baseOrigin + "/" : "");
}

// The hostname of the site being checked, lowercase; "" when unknown.
function siteHost(facts) {
  try {
    return (facts.finalUrl && facts.finalUrl.hostname ? facts.finalUrl.hostname : new URL(facts.baseOrigin).hostname).toLowerCase();
  } catch {
    return "";
  }
}

// True when the address is on the site's own host or a subdomain of it (no network).
function sameHost(u, facts) {
  try {
    const host = new URL(u).hostname.toLowerCase();
    const site = siteHost(facts);
    return Boolean(site) && (host === site || host.endsWith("." + site));
  } catch {
    return false;
  }
}

// True when we may request this address: an http(s) address on the site's own
// host, or on a subdomain of it that the safety guard confirms is public. The
// site host itself was checked before the checkup began; a subdomain named in
// the page's markup has not been, and could point at a private network.
async function allowedOnSite(u, facts) {
  let target;
  try { target = new URL(u); } catch { return false; }
  if (!/^https?:$/.test(target.protocol)) return false;
  const site = siteHost(facts);
  const host = target.hostname.toLowerCase();
  if (!site || !host) return false;
  if (host === site) return true;
  if (!host.endsWith("." + site)) return false;
  try {
    const r = await resolveTarget(target);
    return Boolean(r && r.ok);
  } catch {
    return false;
  }
}

// The crawled pages whose <script src> resolves to one of the given URLs.
function pagesReferencing(facts, urls, fallback) {
  const want = new Set(urls);
  const out = [];
  for (const page of facts.pages || []) {
    if (!page || !page.url) continue;
    let hit = false;
    if (page.$) {
      page.$("script[src]").each((_, el) => {
        if (hit) return;
        let abs;
        try { abs = new URL(page.$(el).attr("src") || "", page.url).href; } catch { return; }
        if (want.has(abs)) hit = true;
      });
    } else if (page.html) {
      hit = [...want].some((u) => page.html.includes(u));
    }
    const u = href(page.url);
    if (hit && !out.includes(u)) out.push(u);
    if (out.length >= 6) break;
  }
  return out.length ? out : [fallback];
}
