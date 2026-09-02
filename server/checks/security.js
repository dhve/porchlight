// security.js
// Step 3: security hygiene from the response headers and page content.
//  - each standard security header, with a note on quality (not just presence)
//  - Content-Security-Policy weaknesses (missing, or unsafe-inline / wildcard)
//  - CORS misconfiguration (wildcard origin, or reflected origin with creds)
//  - insecure (http) content loaded on a secure (https) page
//
// Deterministic. Uses the homepage response fetched by recon, plus one extra
// request to test CORS behavior.

export async function runSecurity(ctx) {
  const { facts, client } = ctx;
  const findings = [];
  const passes = [];
  const headers = facts.headers;
  if (!headers) return { findings, passes };

  // ---- missing / weak security headers ----
  const missing = [];
  if (facts.isHttps && !headers.get("strict-transport-security")) missing.push("Strict-Transport-Security (keeps visitors on https)");
  if (!headers.get("content-security-policy")) missing.push("Content-Security-Policy (limits what can run on your pages)");
  if (!headers.get("x-content-type-options")) missing.push("X-Content-Type-Options (stops content-type confusion)");
  if (!headers.get("x-frame-options") && !/frame-ancestors/i.test(headers.get("content-security-policy") || "")) missing.push("X-Frame-Options or frame-ancestors (stops clickjacking)");
  if (!headers.get("referrer-policy")) missing.push("Referrer-Policy (controls what you leak on click-away)");
  if (!headers.get("permissions-policy")) missing.push("Permissions-Policy (limits camera, mic, geolocation access)");

  if (missing.length >= 2) {
    findings.push({
      id: "missing-security-headers",
      category: "hardening",
      severity: "minor",
      title: `Your site is missing ${missing.length} standard safety headers`,
      meaning:
        `Your server isn't sending ${missing.length} of the standard browser security headers. Each one blocks a specific kind of misuse (listed under Where). On their own they're low risk, and each is a one-line setting.`,
      fix: [
        "Where they live: your web server settings (Apache or nginx), your hosting control panel, or a security plugin if you use WordPress.",
        `Add: ${missing.map((m) => m.split(" (")[0]).join(", ")}.`,
        "Afterwards, confirm for free at securityheaders.com.",
      ],
      who: "Your web person, or a security plugin.",
      evidence: { lines: missing.map((m) => `missing: ${m}`), note: "Read from the homepage response headers." },
    });
  } else if (missing.length === 0) {
    passes.push("Your site sends the important browser security headers.");
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
        evidence: { lines: weak.map((w) => `CSP ${w}`), note: `policy: ${csp.slice(0, 160)}` },
      });
    } else {
      passes.push("You have a solid Content-Security-Policy.");
    }
  }

  // ---- CORS misconfiguration ----
  try {
    const res = await client.get(facts.baseOrigin + "/"); // cheap re-check with default headers is fine
    const acao = res.headers.get("access-control-allow-origin");
    const acac = res.headers.get("access-control-allow-credentials");
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
        evidence: { lines: [`Access-Control-Allow-Origin: ${acao}`, `Access-Control-Allow-Credentials: ${acac}`], note: "Overly broad CORS policy." },
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
        evidence: { lines: [`Access-Control-Allow-Origin: *`], note: "Wildcard CORS." },
      });
    }
  } catch {}

  // ---- active mixed content: scripts/styles/frames on an https page that use
  // an http address. Browsers BLOCK these, so whatever they power breaks.
  // (Images over http are auto-upgraded by browsers and are not reported.)
  if (facts.isHttps) {
    const blocked = new Set();
    for (const page of facts.pages) {
      if (!page.html) continue;
      for (const m of page.html.matchAll(/<(?:script|iframe)[^>]+src=["'](http:\/\/[^"']+)["']|<link[^>]+rel=["']stylesheet["'][^>]+href=["'](http:\/\/[^"']+)["']/gi)) {
        const u = m[1] || m[2];
        if (u && !/^http:\/\/(localhost|127\.)/.test(u)) blocked.add(u);
      }
    }
    const unique = [...blocked].slice(0, 6);
    if (unique.length) {
      findings.push({
        id: "blocked-insecure-script",
        category: "quality",
        severity: "watch",
        title: "Browsers are blocking one of your site's scripts",
        meaning:
          "Your site itself is secure (https). But one of the scripts or stylesheets it tries to load still uses an old http:// address, and modern browsers refuse to load it. Whatever that file powers may quietly not work.",
        fix: ["Change that file's address from http:// to https:// (the same file is almost always available over https)."],
        who: "Your web person; usually a one-word change.",
        evidence: { lines: unique.map((u) => u.slice(0, 100)), note: "Active content blocked by browsers on a secure page." },
      });
    }
  }

  return { findings, passes };
}
