// cookies.js
// Step 3: look at every cookie the site set (across the crawled pages) and flag
// ones missing Secure, HttpOnly, or SameSite. Session cookies without these are
// easier to steal or misuse. Deterministic, cookie VALUES are never stored.
//
// The finding carries evidence.pages (the pages that set the flagged cookies,
// session-like cookies first) and evidence.method (how we tested it). Nothing
// here requests an address, so there are no evidence.items.

export async function runCookies(ctx) {
  const { facts } = ctx;
  const findings = [];
  const passes = [];
  if (!facts.setCookies || !facts.setCookies.length) return { findings, passes };
  const homepage = homepageOf(facts);

  // Split combined Set-Cookie strings into individual cookies (best effort).
  const cookies = [];
  for (const entry of facts.setCookies) {
    for (const c of splitCookies(entry.raw)) {
      const name = (c.split("=")[0] || "").trim();
      if (name && !cookies.some((x) => x.name === name)) cookies.push({ name, raw: c, page: href(entry.page) });
    }
  }

  const problems = [];
  const looksSession = (n) => /sess|sid|auth|token|login|jwt|csrf/i.test(n);
  for (const c of cookies) {
    const flags = [];
    if (facts.isHttps && !/;\s*secure/i.test(c.raw)) flags.push("Secure");
    if (!/;\s*httponly/i.test(c.raw)) flags.push("HttpOnly");
    if (!/;\s*samesite/i.test(c.raw)) flags.push("SameSite");
    if (flags.length) problems.push({ name: c.name, flags, session: looksSession(c.name), page: c.page });
  }

  if (!problems.length) {
    passes.push("Your cookies are set with the recommended safety flags.");
    return { findings, passes };
  }

  const anySession = problems.some((p) => p.session);
  const pageCount = new Set(facts.setCookies.map((e) => href(e.page)).filter(Boolean)).size || facts.setCookies.length;
  findings.push({
    id: "insecure-cookies",
    category: "hardening",
    severity: anySession ? "serious" : "minor",
    title: anySession ? "A login cookie is missing key protections" : "Some cookies are missing safety flags",
    meaning: anySession
      ? "A cookie that looks like it keeps people logged in is missing protections that stop it being stolen or sent from other sites. That can lead to account takeover."
      : "Some cookies your site sets are missing recommended safety flags, which makes them a little easier to misuse.",
    fix: [
      "Where: wherever these cookies are set, usually your site's code, your CMS or plugin settings, or your CDN (Cloudflare has a one-click option).",
      "Add the Secure, HttpOnly, and SameSite flags, starting with the session cookies listed under Where.",
    ],
    who: "Your web person.",
    evidence: {
      lines: problems.slice(0, 8).map((p) => `${p.name}${p.session ? " (session-like)" : ""}: missing ${p.flags.join(", ")}`),
      note: "Cookie names only. Values were not stored.",
      method: `We read the Set-Cookie headers the server sent with the ${pageCount === 1 ? "page" : pageCount + " pages"} we loaded and checked each cookie for the Secure, HttpOnly, and SameSite flags. Only the cookie names were kept.`,
      pages: uniq([...problems.filter((p) => p.session), ...problems.filter((p) => !p.session)].map((p) => p.page), homepage),
    },
  });

  return { findings, passes };
}

function splitCookies(raw) {
  // Set-Cookie can be one header with commas inside Expires. Split on commas
  // that are followed by "name=" (the start of a new cookie).
  return String(raw).split(/,(?=\s*[^;,\s]+=)/g);
}

// ---- evidence helpers ----

function href(u) {
  if (!u) return "";
  if (typeof u === "string") return u;
  return u.href || String(u);
}

function homepageOf(facts) {
  return href(facts.finalUrl) || href(facts.pages && facts.pages[0] && facts.pages[0].url) || (facts.baseOrigin ? facts.baseOrigin + "/" : "");
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
