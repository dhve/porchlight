// cookies.js
// Step 3: look at every cookie the site set (across the crawled pages) and flag
// ones missing Secure, HttpOnly, or SameSite. Session cookies without these are
// easier to steal or misuse. Deterministic, cookie VALUES are never stored.

export async function runCookies(ctx) {
  const { facts } = ctx;
  const findings = [];
  const passes = [];
  if (!facts.setCookies || !facts.setCookies.length) return { findings, passes };

  // Split combined Set-Cookie strings into individual cookies (best effort).
  const cookies = [];
  for (const entry of facts.setCookies) {
    for (const c of splitCookies(entry.raw)) {
      const name = (c.split("=")[0] || "").trim();
      if (name && !cookies.some((x) => x.name === name)) cookies.push({ name, raw: c });
    }
  }

  const problems = [];
  const looksSession = (n) => /sess|sid|auth|token|login|jwt|csrf/i.test(n);
  for (const c of cookies) {
    const flags = [];
    if (facts.isHttps && !/;\s*secure/i.test(c.raw)) flags.push("Secure");
    if (!/;\s*httponly/i.test(c.raw)) flags.push("HttpOnly");
    if (!/;\s*samesite/i.test(c.raw)) flags.push("SameSite");
    if (flags.length) problems.push({ name: c.name, flags, session: looksSession(c.name) });
  }

  if (!problems.length) {
    passes.push("Your cookies are set with the recommended safety flags.");
    return { findings, passes };
  }

  const anySession = problems.some((p) => p.session);
  findings.push({
    id: "insecure-cookies",
    category: "hardening",
    severity: anySession ? "serious" : "minor",
    title: anySession ? "A login cookie is missing key protections" : "Some cookies are missing safety flags",
    meaning: anySession
      ? "A cookie that looks like it keeps people logged in is missing protections that stop it being stolen or sent from other sites. That can lead to account takeover."
      : "Some cookies your site sets are missing recommended safety flags, which makes them a little easier to misuse.",
    fix: [
      "Ask your web person to add Secure, HttpOnly, and SameSite to your cookies, especially session and login cookies.",
    ],
    who: "Your web person.",
    evidence: { lines: problems.slice(0, 8).map((p) => `${p.name}${p.session ? " (session-like)" : ""}: missing ${p.flags.join(", ")}`), note: "Cookie names only. Values were not stored." },
  });

  return { findings, passes };
}

function splitCookies(raw) {
  // Set-Cookie can be one header with commas inside Expires. Split on commas
  // that are followed by "name=" (the start of a new cookie).
  return String(raw).split(/,(?=\s*[^;,\s]+=)/g);
}
