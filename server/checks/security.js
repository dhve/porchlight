// security.js
// Step 3: check for basic safety hygiene using the homepage we already have.
//  - missing standard security headers
//  - cookies set without Secure / HttpOnly
//  - insecure (http) content loaded on a secure (https) page
//
// Deterministic, uses the response already fetched by recon.

export async function runSecurity(ctx) {
  const { facts } = ctx;
  const findings = [];
  const passes = [];
  const headers = facts.headers;
  if (!headers) return { findings, passes };

  // ---- missing security headers (grouped into one friendly finding) ----
  const wanted = [
    { key: "strict-transport-security", label: "keeps visitors on the secure version of your site", onlyHttps: true },
    { key: "content-security-policy", label: "limits what can run on your pages" },
    { key: "x-content-type-options", label: "stops files being mistaken for something they're not" },
    { key: "x-frame-options", label: "stops your site being embedded in a scam page", altKey: "content-security-policy" },
    { key: "referrer-policy", label: "controls what you leak when visitors click away" },
  ];
  const missing = [];
  for (const h of wanted) {
    if (h.onlyHttps && !facts.isHttps) continue;
    const present = headers.get(h.key) || (h.altKey && headers.get(h.altKey));
    if (!present) missing.push(h);
  }
  if (missing.length >= 2) {
    findings.push({
      id: "missing-security-headers",
      category: "hardening",
      severity: "watch",
      title: "Your site is missing some standard safety headers",
      meaning:
        "Browsers support a few simple instructions that make a site harder to abuse. Yours isn't sending several of them. On their own these are low risk, but together they're easy points to tighten up.",
      fix: [
        "Ask your web person to add the missing security headers.",
        "On WordPress and similar platforms, a security plugin can add them with one click.",
      ],
      who: "Your web person, or a security plugin.",
      evidence: {
        lines: missing.map((m) => `missing: ${m.key}  (${m.label})`),
        note: "Read from the homepage response headers.",
      },
    });
  } else {
    passes.push("Your site sends the important browser security headers.");
  }

  // ---- insecure cookies ----
  const setCookie = headers.get("set-cookie") || "";
  if (setCookie) {
    const insecure = [];
    if (facts.isHttps && !/;\s*secure/i.test(setCookie)) insecure.push("Secure");
    if (!/;\s*httponly/i.test(setCookie)) insecure.push("HttpOnly");
    if (insecure.length) {
      findings.push({
        id: "insecure-cookies",
        category: "hardening",
        severity: "watch",
        title: "A cookie is set without full protection",
        meaning:
          "Your site stores a cookie in visitors' browsers without all the recommended safety flags, which makes it easier to steal in some situations.",
        fix: [`Ask your web person to add the ${insecure.join(" and ")} flag${insecure.length > 1 ? "s" : ""} to your cookies.`],
        who: "Your web person.",
        evidence: { lines: [`Set-Cookie is missing: ${insecure.join(", ")}`], note: "Cookie value itself was not stored." },
      });
    }
  }

  // ---- mixed content on a secure page ----
  if (facts.isHttps && facts.html) {
    const mixed = [...facts.html.matchAll(/(?:src|href)=["'](http:\/\/[^"']+)["']/gi)]
      .map((m) => m[1])
      .filter((u) => !/^http:\/\/(localhost|127\.)/.test(u));
    const unique = [...new Set(mixed)].slice(0, 5);
    if (unique.length) {
      findings.push({
        id: "mixed-content",
        category: "tls",
        severity: "watch",
        title: "The padlock can break on some pages",
        meaning:
          "Your site is secure, but it loads some images or scripts over an unprotected connection. Browsers may show a 'Not secure' warning on those pages, which is unsettling right before someone pays.",
        fix: ["Update those few links to load over https instead of http (usually just changing 'http' to 'https')."],
        who: "Your web person; often a quick find-and-replace.",
        evidence: { lines: unique.map((u) => u.slice(0, 90)), note: "Insecure resources referenced on a secure page." },
      });
    }
  }

  return { findings, passes };
}
