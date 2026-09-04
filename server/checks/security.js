// security.js
// Step 3: security hygiene from the response headers and page content.
//  - each standard security header, with a note on quality (not just presence)
//  - Content-Security-Policy weaknesses (missing, or unsafe-inline / wildcard)
//  - CORS misconfiguration (wildcard origin, or reflected origin with creds)
//  - insecure (http) content loaded on a secure (https) page
//
// Deterministic. Uses the homepage response fetched by recon, plus one extra
// request to test CORS behavior.
//
// Every finding carries evidence.pages (where on the site it was found) and
// evidence.method (how we tested it). The mixed content finding also carries
// evidence.items: each http address, with the status it answered when it is on
// this site's own domain (addresses on other domains are listed, not loaded).
// A subdomain is looked up through the safety guard before it is requested,
// so the checker never follows a page's markup to a private address.

import { resolveTarget } from "../safety.js";

const BLOCKED = new Set([401, 403, 405, 406, 429, 503]);
const STATUS_TEXT = {
  200: "OK", 201: "Created", 204: "No Content", 301: "Moved Permanently", 302: "Found", 304: "Not Modified",
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
  406: "Not Acceptable", 408: "Request Timeout", 410: "Gone", 429: "Too Many Requests",
  500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
};

export async function runSecurity(ctx) {
  const { facts, client } = ctx;
  const findings = [];
  const passes = [];
  const headers = facts.headers;
  if (!headers) return { findings, passes };
  const homepage = homepageOf(facts);
  const throttle = { count: 0, stop: false };

  // ---- security headers, only where they change something for visitors ----
  // Most brochure sites lack these headers and are none the worse for it, so we only
  // speak up when the site has logins or sessions, and only about the two headers
  // that protect those visitors: HSTS (keeps them on https) and framing protection.
  const hasLogin = (facts.forms || []).some((f) => f && (f.hasPassword || /login|signin|sign-in|account/i.test(String(f.action || "") + String(f.page || ""))));
  const setCookies = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie")].filter(Boolean);
  const hasSession = setCookies.some((c) => /^(?:[^=]*(?:sess|sid|auth|token|login|user|csrf|xsrf)[^=]*)=/i.test(String(c)));
  const missing = [];
  if (facts.isHttps && !headers.get("strict-transport-security")) {
    missing.push({ name: "Strict-Transport-Security", plain: "No Strict-Transport-Security header. A visitor who types the address without https can be sent to the unprotected http version first, where a login could be read on the network." });
  }
  if (!headers.get("x-frame-options") && !/frame-ancestors/i.test(headers.get("content-security-policy") || "")) {
    missing.push({ name: "X-Frame-Options or frame-ancestors", plain: "No framing protection. Another website can load this site's pages inside a hidden frame and trick a signed-in visitor into clicking something they cannot see." });
  }

  if ((hasLogin || hasSession) && missing.length) {
    findings.push({
      id: "missing-security-headers",
      category: "hardening",
      severity: "minor",
      title: missing.length === 1 ? "One protection for signed-in visitors is switched off" : "Two protections for signed-in visitors are switched off",
      meaning:
        "This site has logins or sessions, so two small server settings matter more than they would on a plain brochure site. " +
        (missing.length === 1 ? "One of them is missing." : "Both are missing.") +
        " Each is a single line in the server or hosting settings.",
      fix: [
        `Add ${missing.map((m) => m.name).join(" and ")} in the web server settings, the hosting control panel, or a security plugin.`,
        "Afterwards, confirm at securityheaders.com.",
      ],
      who: "The owner's web person, or a security plugin.",
      evidence: {
        lines: missing.map((m) => m.plain),
        note: "Read from the homepage response headers. Only checked because the site has logins or sessions.",
        method: "We loaded the homepage and read the response headers the server sent with it. Because the site sets session cookies or has a login form, we checked for the two headers that protect signed-in visitors.",
        pages: [homepage],
      },
    });
  } else if (!missing.length && facts.isHttps) {
    passes.push("The site keeps visitors on https and blocks other sites from framing its pages.");
  }

  // ---- CSP quality ----
  const csp = headers.get("content-security-policy");
  if (csp) {
    const weak = [];
    if (/'unsafe-inline'/i.test(csp)) weak.push("allows 'unsafe-inline' scripts/styles");
    if (/'unsafe-eval'/i.test(csp)) weak.push("allows 'unsafe-eval'");
    if (/(script-src|default-src)[^;]*\*(?!\.)/i.test(csp)) weak.push("uses a wildcard * source");
    if (weak.length) {
      findings.push({
        id: "weak-csp",
        category: "hardening",
        severity: "minor",
        title: "Your content security policy has gaps",
        meaning:
          "You have a Content-Security-Policy, which is good, but it's loose enough that it may not stop a script-injection attack the way a tight policy would.",
        fix: [
          "Where it lives: the Content-Security-Policy header in your server settings or security plugin.",
          `Tighten it by fixing: ${weak.join("; ")}. Limit script sources to your own domain plus the few services you actually use.`,
        ],
        who: "Your web person.",
        evidence: {
          lines: weak.map((w) => `CSP ${w}`),
          note: `policy: ${csp.slice(0, 160)}`,
          method: "We read the Content-Security-Policy header the server sent with the homepage and looked for the settings that weaken it: unsafe-inline, unsafe-eval, and wildcard sources.",
          pages: [homepage],
        },
      });
    } else {
      passes.push("You have a solid Content-Security-Policy.");
    }
  }

  // ---- CORS misconfiguration ----
  try {
    const res = await client.get(facts.baseOrigin + "/"); // cheap re-check with default headers is fine
    noteStatus(facts, throttle, res.status);
    release(res);
    // A 401, 403, 429, or 503 answer comes from whatever refused our checker,
    // not from the site's own pages, so its headers say nothing about the site.
    const acao = BLOCKED.has(res.status) ? null : res.headers.get("access-control-allow-origin");
    const acac = BLOCKED.has(res.status) ? null : res.headers.get("access-control-allow-credentials");
    if (acao === "*" && /true/i.test(acac || "")) {
      findings.push({
        id: "cors-wildcard-creds",
        category: "hardening",
        severity: "serious",
        title: "Your site shares data too openly with other websites",
        meaning:
          "Your site allows any other website to read responses while sending credentials. That combination can let a malicious site act on your users' behalf.",
        fix: ["Ask your web person to restrict cross-origin sharing to only the sites that truly need it, and not combine a wildcard with credentials."],
        who: "Your web person.",
        evidence: {
          lines: [`Access-Control-Allow-Origin: ${acao}`, `Access-Control-Allow-Credentials: ${acac}`],
          note: "Overly broad CORS policy.",
          method: "We requested the homepage once more and read the Access-Control-Allow-Origin and Access-Control-Allow-Credentials headers in the answer. Both values are quoted above exactly as the server sent them.",
          pages: [homepage],
        },
      });
    } else if (acao === "*") {
      findings.push({
        id: "cors-wildcard",
        category: "hardening",
        severity: "minor",
        title: "Your site allows any website to read its responses",
        meaning: "Your pages are readable cross-origin by any site. Usually harmless for public content, but worth confirming nothing sensitive is served this way.",
        fix: ["Ask your web person to confirm no private data is served with a wildcard CORS header."],
        who: "Your web person.",
        evidence: {
          lines: [`Access-Control-Allow-Origin: *`],
          note: "Wildcard CORS.",
          method: "We requested the homepage once more and read the Access-Control-Allow-Origin header in the answer. The value is quoted above exactly as the server sent it.",
          pages: [homepage],
        },
      });
    }
  } catch {}

  // ---- active mixed content: scripts/styles/frames on an https page that use
  // an http address. Browsers BLOCK these, so whatever they power breaks.
  // (Images over http are auto-upgraded by browsers and are not reported.)
  if (facts.isHttps) {
    const blocked = new Map(); // http url -> first page that references it
    for (const page of facts.pages || []) {
      if (!page.html) continue;
      for (const m of page.html.matchAll(/<(?:script|iframe)[^>]+src=["'](http:\/\/[^"']+)["']|<link[^>]+rel=["']stylesheet["'][^>]+href=["'](http:\/\/[^"']+)["']/gi)) {
        const u = m[1] || m[2];
        if (u && !/^http:\/\/(localhost|127\.)/.test(u) && !blocked.has(u)) blocked.set(u, href(page.url));
      }
    }
    const unique = [...blocked.keys()].slice(0, 6);
    if (unique.length) {
      const items = [];
      for (const u of unique) {
        const item = { url: u, status: 0, statusText: "not requested", page: blocked.get(u), kind: "resource" };
        if (client && !throttle.stop && (await allowedOnSite(u, facts))) {
          try {
            const res = await client.get(u);
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
        id: "blocked-insecure-script",
        category: "quality",
        severity: "watch",
        title: "Browsers are blocking one of your site's scripts",
        meaning:
          "Your site itself is secure (https). But one of the scripts or stylesheets it tries to load still uses an old http:// address, and modern browsers refuse to load it. Whatever that file powers may quietly not work.",
        fix: ["Change that file's address from http:// to https:// (the same file is almost always available over https)."],
        who: "Your web person; usually a one-word change.",
        evidence: {
          lines: unique.map((u) => u.slice(0, 100)),
          note: "Active content blocked by browsers on a secure page.",
          method: "We read the source of each https page we loaded and listed every script, stylesheet, or frame that still points to an http address, which browsers refuse to load on a secure page. For addresses on this site's own domain we also requested the file once to record how it answers.",
          pages: uniq(unique.map((u) => blocked.get(u)), homepage),
          items,
        },
      });
    }
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

// Distinct, non-empty entries in order, at most six; fall back to the homepage.
function uniq(list, fallback, max = 6) {
  const out = [];
  for (const x of list) {
    if (x && !out.includes(x)) out.push(x);
    if (out.length >= max) break;
  }
  return out.length ? out : (fallback ? [fallback] : []);
}
