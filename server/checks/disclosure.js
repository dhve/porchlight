// disclosure.js
// Step 3: information leaks. Things a site accidentally exposes that help an
// attacker: secrets in the page source, published source maps, directory
// listings, verbose error pages, and internal addresses.
//
// Deterministic and read-only. Any matched secret is REDACTED in the report.
//
// Every finding carries evidence.pages (where on the site it was found),
// evidence.method (how we tested it), and, where a concrete address was
// requested, evidence.items (the address and the status it answered with).
// A 401, 403, 405, 406, 429, or 503 answer means the site refused our checker;
// it is never read as an exposed file, a listing, or an error page. After two
// 429 answers we stop probing and set facts.throttled.

const SECRET_PATTERNS = [
  { re: /AKIA[0-9A-Z]{16}/g, label: "AWS access key id" },
  { re: /AIza[0-9A-Za-z_\-]{35}/g, label: "Google API key" },
  { re: /sk_live_[0-9A-Za-z]{16,}/g, label: "Stripe live secret key" },
  { re: /gh[pousr]_[0-9A-Za-z]{20,}/g, label: "GitHub token" },
  { re: /xox[baprs]-[0-9A-Za-z-]{10,}/g, label: "Slack token" },
  { re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, label: "private key" },
  { re: /eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g, label: "JSON Web Token" },
];

const BLOCKED = new Set([401, 403, 405, 406, 429, 503]);
const STATUS_TEXT = {
  200: "OK", 201: "Created", 204: "No Content", 301: "Moved Permanently", 302: "Found", 304: "Not Modified",
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
  406: "Not Acceptable", 408: "Request Timeout", 410: "Gone", 429: "Too Many Requests",
  500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
};

export async function runDisclosure(ctx) {
  const { facts, client } = ctx;
  const findings = [];
  const passes = [];
  const origin = facts.baseOrigin;
  const homepage = homepageOf(facts);
  const throttle = { count: 0, stop: false };
  if (facts.throttled && client) await pause(3000);

  // ---- secrets in page source (homepage + crawled pages) ----
  const secretHits = []; // { label, path, count, page }
  const browserKeys = []; // Google API keys: designed to sit in page code, only a problem when unrestricted
  for (const page of facts.pages || []) {
    if (!page.html) continue;
    for (const p of SECRET_PATTERNS) {
      const matches = page.html.match(p.re);
      if (!matches) continue;
      const hit = { label: p.label, path: href(page.url).replace(origin, "") || "/", count: matches.length, page: href(page.url) };
      if (p.label === "Google API key") browserKeys.push(hit); else secretHits.push(hit);
    }
  }
  if (browserKeys.length) {
    findings.push({
      id: "google-browser-key",
      category: "hardening",
      severity: "minor",
      title: "A Google API key is visible in the page code",
      meaning:
        "Keys for Google Maps and similar browser services are meant to sit in page code, so this is normal. It only becomes a problem if the key is unrestricted, because anyone could copy it and run up usage on the site's Google account.",
      fix: [
        "In Google Cloud Console, open the key and restrict it to this site's domains (HTTP referrers) and to the APIs it needs.",
        "Set a usage cap or budget alert on the project so a copied key cannot run up a bill.",
      ],
      who: "The owner or their web person, whoever manages the Google account.",
      evidence: {
        lines: browserKeys.slice(0, 4).map((h) => `${h.path}: Google API key (${h.count} match${h.count > 1 ? "es" : ""}, value redacted)`),
        note: "The key itself is not stored or shown. Whether it is restricted can only be seen inside the site's Google Cloud project.",
        method: "We read the source of every page we loaded and looked for the Google API key format. Browser keys like this are expected in page code, so this is a reminder to restrict the key, not a leak.",
        pages: uniq(browserKeys.map((h) => h.page), homepage),
      },
    });
  }
  if (secretHits.length) {
    findings.push({
      id: "secrets-in-source",
      category: "exposed-data",
      severity: "urgent",
      title: "A secret key appears in your website's code",
      meaning:
        "Something that looks like a password or API key is visible in your page source, where anyone can read it. Leaked keys get abused fast, sometimes running up bills or exposing data.",
      fix: [
        "Ask your web person to remove the key from the public code and move it to a server-side setting.",
        "Treat the exposed key as compromised and rotate it (generate a new one, disable the old).",
      ],
      who: "Your web person, promptly.",
      evidence: {
        lines: secretHits.slice(0, 6).map((h) => `${h.path}: ${h.label} (${h.count} match${h.count > 1 ? "es" : ""}, value redacted)`),
        note: "The key itself was detected in that page's source but is not stored or shown here.",
        method: "We read the source of every page we loaded and searched it for the patterns of common key formats, such as AWS, Google, Stripe, GitHub, and Slack keys. The matched value is never stored or shown.",
        pages: uniq(secretHits.map((h) => h.page), homepage),
      },
    });
  }

  // ---- exposed source maps (reveal your original source code) ----
  const mapHits = []; // { url, status, statusText, page }
  for (const s of (facts.scripts || []).slice(0, 12)) {
    if (s.external) continue;
    if (throttle.stop || !client) break;
    const mapUrl = s.src + ".map";
    try {
      const res = await client.get(mapUrl);
      noteStatus(facts, throttle, res.status);
      if (res.status === 200) {
        const body = await res.text(2000);
        if (/"version"\s*:|"sources"\s*:|"mappings"\s*:/.test(body)) {
          mapHits.push({ url: mapUrl, status: res.status, statusText: statusTextOf(res), page: pagesReferencing(facts, [s.src], homepage)[0] });
        }
      } else {
        release(res);
      }
    } catch (err) {
      if (err && err.code === "BUDGET") { throttle.stop = true; } // nothing more will answer this checkup
    }
    if (mapHits.length >= 3) break;
  }
  if (mapHits.length) {
    findings.push({
      id: "exposed-source-maps",
      category: "info-leak",
      severity: "minor",
      title: "Your original source code is downloadable",
      meaning:
        "Your site publishes source maps, which let anyone reconstruct your original (uncompressed) code, comments and all. That can reveal how your site works and sometimes leaks internal details.",
      fix: ["Ask your web person to stop publishing source maps in production, or restrict access to them."],
      who: "Your web person.",
      evidence: {
        lines: mapHits.map((h) => h.url.replace(origin, "")),
        note: "Source map files were reachable.",
        method: "For each script this site loads from its own domain, we requested the same address with .map added on the end and checked whether the answer was a real source map file. Only a 200 answer with source map contents counts.",
        pages: uniq(mapHits.map((h) => h.page), homepage),
        items: mapHits.map((h) => ({ url: h.url, status: h.status, statusText: h.statusText, page: h.page, kind: "file" })),
      },
    });
  }

  // ---- directory listing enabled ----
  const dirs = new Set(["/wp-content/uploads/", "/uploads/", "/images/", "/assets/", "/files/", "/backup/"]);
  const listing = []; // { path, url, status, statusText }
  for (const d of dirs) {
    if (throttle.stop || !client) break;
    const u = origin + d;
    try {
      const res = await client.get(u);
      noteStatus(facts, throttle, res.status);
      if (res.status === 200) {
        const body = await res.text(3000);
        if (/<title>\s*Index of \//i.test(body) || /Directory listing for/i.test(body)) {
          listing.push({ path: d, url: u, status: res.status, statusText: statusTextOf(res) });
        }
      } else {
        release(res);
      }
    } catch (err) {
      if (err && err.code === "BUDGET") { throttle.stop = true; }
    }
    if (listing.length >= 3) break;
  }
  if (listing.length) {
    findings.push({
      id: "directory-listing",
      category: "info-leak",
      severity: "serious",
      title: "Anyone can browse your website's folders",
      meaning:
        "Some folders on your site show a full file listing to visitors. That lets outsiders find files you never linked to, including backups or documents you assumed were private.",
      fix: ["Ask your web person or host to turn off directory listing (often one line in the server config)."],
      who: "Your web person or hosting provider.",
      evidence: {
        lines: listing.map((l) => `Index listing at ${l.path}`),
        note: "Folders returned a browsable file list.",
        method: "We requested a few common folder addresses on this site and checked whether the answer was a browsable file list instead of a normal page or an error. Folders that answered with an access denied or rate limit status were not counted.",
        pages: uniq(listing.map((l) => l.url), homepage),
        items: listing.map((l) => ({ url: l.url, status: l.status, statusText: l.statusText, kind: "page" })),
      },
    });
  }

  // ---- verbose error / stack traces (real signatures only, quoted) ----
  // Plain words like "Warning:" or "Notice:" appear in normal content, so a
  // PHP warning must carry a file path and line number to count.
  const ERR_PATTERNS = [
    /Fatal error:[^<\n]{0,160}/i,
    /(?:Warning|Notice|Deprecated|Parse error):[^<\n]{0,120} in \/[^<\n]{0,80} on line \d+/i,
    /Stack trace:[^<\n]{0,160}/i,
    /Traceback \(most recent call last\)[^<]{0,160}/i,
    /SQLSTATE\[[^<\n]{0,160}/i,
    /You have an error in your SQL syntax[^<\n]{0,160}/i,
    /Uncaught (?:Exception|Error)[^<\n]{0,160}/i,
    /Whoops, looks like something went wrong/i,
    /\bat [\w.$<>]+ \((?:[\w./-]+):\d+:\d+\)/,
  ];
  const errHits = []; // { path, snippet, url, status }
  for (const page of (facts.pages || []).slice(0, 6)) {
    if (!page.html) continue;
    // The site refused our checker for this page; that answer is not an error page.
    if (BLOCKED.has(Number(page.status))) continue;
    for (const re of ERR_PATTERNS) {
      const m = page.html.match(re);
      if (m) {
        const snippet = m[0].replace(/\s+/g, " ").trim().slice(0, 160);
        errHits.push({ path: href(page.url).replace(origin, "") || "/", snippet, url: href(page.url), status: Number(page.status) || 0 });
        break;
      }
    }
  }
  if (errHits.length) {
    findings.push({
      id: "verbose-errors",
      category: "info-leak",
      severity: "serious",
      title: "Your site is showing detailed error messages",
      meaning:
        "Some pages display technical error details (a stack trace or database error). These reveal how your site is built and can hand attackers a map of where to push. The exact text is quoted under the technical proof.",
      fix: ["Ask your web person to turn off detailed errors in production and show a friendly error page instead. The quoted text points to the file and line that failed."],
      who: "Your web person.",
      evidence: {
        lines: errHits.slice(0, 5).map((h) => `${h.path}: "${h.snippet}"`),
        note: "The quoted text is what visitors can see on that page.",
        method: "We read the source of the pages we loaded and looked for the exact wording of common server error messages and stack traces, such as PHP fatal errors, SQL errors, and Python tracebacks. Pages that answered with an access denied or rate limit status were skipped.",
        pages: uniq(errHits.map((h) => h.url), homepage),
        items: errHits.slice(0, 6).map((h) => ({ url: h.url, status: h.status, statusText: statusWords(h.status), kind: "page" })),
      },
    });
  }

  // ---- sensitive paths disclosed in robots.txt ----
  if (facts.robots) {
    const juicy = [...facts.robots.matchAll(/^\s*disallow:\s*(\S+)/gim)]
      .map((m) => m[1])
      .filter((p) => /admin|login|backup|config|private|db|sql|secret|internal|staging|api/i.test(p));
    if (juicy.length) {
      const robotsUrl = origin + "/robots.txt";
      findings.push({
        id: "robots-discloses-paths",
        category: "info-leak",
        severity: "minor",
        title: "Your robots.txt points to sensitive areas",
        meaning:
          "Your robots.txt asks search engines to skip some folders, but attackers read that file specifically to find the interesting areas you'd rather hide.",
        fix: ["Don't rely on robots.txt to hide admin or private areas. Protect them with a login instead, and remove the hints if they aren't needed."],
        who: "Your web person.",
        evidence: {
          lines: juicy.slice(0, 8).map((p) => `Disallow: ${p}`),
          note: "From robots.txt.",
          method: "We requested this site's robots.txt file and read each Disallow line, looking for folder names that suggest admin, login, backup, config, or other private areas.",
          pages: [robotsUrl],
          items: [{ url: robotsUrl, status: 200, statusText: "OK", kind: "file" }],
        },
      });
    }
  }

  if (!findings.length) passes.push("We didn't find secrets, source code, or error details leaking in your pages.");
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

// Distinct, non-empty entries in order, at most six; fall back to the homepage.
function uniq(list, fallback, max = 6) {
  const out = [];
  for (const x of list) {
    if (x && !out.includes(x)) out.push(x);
    if (out.length >= max) break;
  }
  return out.length ? out : (fallback ? [fallback] : []);
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

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
