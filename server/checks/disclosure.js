// disclosure.js
// Step 3: information leaks. Things a site accidentally exposes that help an
// attacker: secrets in the page source, published source maps, directory
// listings, verbose error pages, and internal addresses.
//
// Deterministic and read-only. Any matched secret is REDACTED in the report.

const SECRET_PATTERNS = [
  { re: /AKIA[0-9A-Z]{16}/g, label: "AWS access key id" },
  { re: /AIza[0-9A-Za-z_\-]{35}/g, label: "Google API key" },
  { re: /sk_live_[0-9A-Za-z]{16,}/g, label: "Stripe live secret key" },
  { re: /gh[pousr]_[0-9A-Za-z]{20,}/g, label: "GitHub token" },
  { re: /xox[baprs]-[0-9A-Za-z-]{10,}/g, label: "Slack token" },
  { re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, label: "private key" },
  { re: /eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g, label: "JSON Web Token" },
];

export async function runDisclosure(ctx) {
  const { facts, client } = ctx;
  const findings = [];
  const passes = [];
  const origin = facts.baseOrigin;

  // ---- secrets in page source (homepage + crawled pages) ----
  const secretHits = new Map(); // label -> count
  for (const page of facts.pages || []) {
    if (!page.html) continue;
    for (const p of SECRET_PATTERNS) {
      const matches = page.html.match(p.re);
      if (matches) secretHits.set(p.label, (secretHits.get(p.label) || 0) + matches.length);
    }
  }
  if (secretHits.size) {
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
      evidence: { lines: [...secretHits.entries()].map(([label, n]) => `${label}: ${n} match(es) (value redacted)`), note: "Actual secret values were detected but not stored or shown." },
    });
  }

  // ---- exposed source maps (reveal your original source code) ----
  const mapHits = [];
  for (const s of (facts.scripts || []).slice(0, 12)) {
    if (s.external) continue;
    try {
      const res = await client.get(s.src + ".map");
      if (res.status === 200) {
        const body = await res.text(2000);
        if (/"version"\s*:|"sources"\s*:|"mappings"\s*:/.test(body)) mapHits.push(s.src + ".map");
      }
    } catch {}
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
      evidence: { lines: mapHits.map((u) => u.replace(origin, "")), note: "Source map files were reachable." },
    });
  }

  // ---- directory listing enabled ----
  const dirs = new Set(["/wp-content/uploads/", "/uploads/", "/images/", "/assets/", "/files/", "/backup/"]);
  const listing = [];
  for (const d of dirs) {
    try {
      const res = await client.get(origin + d);
      if (res.status === 200) {
        const body = await res.text(3000);
        if (/<title>\s*Index of \//i.test(body) || /Directory listing for/i.test(body)) listing.push(d);
      }
    } catch {}
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
      evidence: { lines: listing.map((d) => `Index listing at ${d}`), note: "Folders returned a browsable file list." },
    });
  }

  // ---- verbose error / stack traces ----
  const errHits = [];
  for (const page of (facts.pages || []).slice(0, 4)) {
    if (!page.html) continue;
    if (/(Fatal error|Warning: |Notice: |Stack trace:|Traceback \(most recent call last\)|at [\w.$]+\([^)]*:\d+:\d+\)|SQLSTATE\[|You have an error in your SQL syntax|Whoops, looks like something went wrong)/.test(page.html)) {
      errHits.push(page.url.replace(origin, "") || "/");
    }
  }
  if (errHits.length) {
    findings.push({
      id: "verbose-errors",
      category: "info-leak",
      severity: "serious",
      title: "Your site is showing detailed error messages",
      meaning:
        "Some pages display technical error details (stack traces or database errors). These reveal how your site is built and can hand attackers a map of where to push.",
      fix: ["Ask your web person to turn off detailed errors in production and show a friendly error page instead."],
      who: "Your web person.",
      evidence: { lines: errHits.slice(0, 5).map((u) => `error text on ${u}`), note: "Error or stack-trace text found in page content." },
    });
  }

  // ---- sensitive paths disclosed in robots.txt ----
  if (facts.robots) {
    const juicy = [...facts.robots.matchAll(/^\s*disallow:\s*(\S+)/gim)]
      .map((m) => m[1])
      .filter((p) => /admin|login|backup|config|private|db|sql|secret|internal|staging|api/i.test(p));
    if (juicy.length) {
      findings.push({
        id: "robots-discloses-paths",
        category: "info-leak",
        severity: "minor",
        title: "Your robots.txt points to sensitive areas",
        meaning:
          "Your robots.txt asks search engines to skip some folders, but attackers read that file specifically to find the interesting areas you'd rather hide.",
        fix: ["Don't rely on robots.txt to hide admin or private areas. Protect them with a login instead, and remove the hints if they aren't needed."],
        who: "Your web person.",
        evidence: { lines: juicy.slice(0, 8).map((p) => `Disallow: ${p}`), note: "From robots.txt." },
      });
    }
  }

  if (!findings.length) passes.push("We didn't find secrets, source code, or error details leaking in your pages.");
  return { findings, passes };
}
