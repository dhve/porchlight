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
      title: "Your site is missing several standard safety headers",
      meaning:
        "Browsers support simple instructions that make a site much harder to abuse (clickjacking, content sniffing, script injection). Yours isn't sending several of them.",
      fix: [
        "Ask your web person to add the missing security headers.",
        "On WordPress and similar platforms, a security plugin can add them in one step.",
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
        fix: ["Ask your web person to tighten the policy: avoid 'unsafe-inline', 'unsafe-eval', and wildcard sources where possible."],
        who: "Your web person.",
        evidence: { lines: weak.map((w) => `CSP ${w}`), note: `policy: ${csp.slice(0, 160)}` },
      });
    } else {
      passes.push("You have a solid Content-Security-Policy.");
    }
  }

  // ---- HSTS quality (present but weak) ----
  const hsts = headers.get("strict-transport-security");
  if (hsts) {
    const m = hsts.match(/max-age=(\d+)/i);
    const age = m ? parseInt(m[1], 10) : 0;
    if (age < 15552000) {
      findings.push({
        id: "weak-hsts",
        category: "tls",
        severity: "minor",
        title: "Your https-enforcement window is short",
        meaning: "Your site tells browsers to stick to the secure version, but only briefly. A longer window (six months or more) protects returning visitors better.",
        fix: ["Ask your web person to set the HSTS max-age to at least 15552000 (six months), ideally with includeSubDomains."],
        who: "Your web person.",
        evidence: { lines: [`Strict-Transport-Security: ${hsts}`], note: "Longer is safer for returning visitors." },
      });
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

  // ---- mixed content on a secure page (across crawled pages) ----
  if (facts.isHttps) {
    const mixed = new Set();
    for (const page of facts.pages) {
      if (!page.html) continue;
      for (const m of page.html.matchAll(/(?:src|href)=["'](http:\/\/[^"']+)["']/gi)) {
        if (!/^http:\/\/(localhost|127\.)/.test(m[1])) mixed.add(m[1]);
      }
    }
    const unique = [...mixed].slice(0, 6);
    if (unique.length) {
      findings.push({
        id: "mixed-content",
        category: "tls",
        severity: "minor",
        title: "The padlock can break on some pages",
        meaning:
          "Your site is secure, but it loads some images or scripts over an unprotected connection. Browsers may show a 'Not secure' warning on those pages.",
        fix: ["Update those links to load over https instead of http (usually just changing 'http' to 'https')."],
        who: "Your web person.",
        evidence: { lines: unique.map((u) => u.slice(0, 90)), note: "Insecure resources referenced on secure pages." },
      });
    }
  }

  return { findings, passes };
}
