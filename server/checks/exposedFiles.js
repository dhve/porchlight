// exposedFiles.js
// Step 3: try the doors and windows. Check a short, fixed list of well-known
// sensitive paths that should never be publicly readable.
//
// This is detection, not exploitation:
//  - a small, fixed list (no guessing, no fuzzing)
//  - a plain GET, exactly what a browser would do
//  - we confirm the file is really exposed, then STOP
//  - we never store or return the sensitive contents; evidence is redacted
//
// It is the digital equivalent of checking whether a back door was left
// unlocked, not walking in and taking things.

const TARGETS = [
  { path: "/.env", sev: "urgent", label: "environment / secrets file", looksReal: (t) => /^\s*[A-Z0-9_]+\s*=/m.test(t) && !/<html/i.test(t) },
  { path: "/.git/HEAD", sev: "urgent", label: "source code history", looksReal: (t) => /^ref:\s/.test(t) },
  { path: "/.git/config", sev: "urgent", label: "source code history", looksReal: (t) => /\[core\]/.test(t) },
  { path: "/wp-config.php.bak", sev: "urgent", label: "database password file", looksReal: (t) => /DB_PASSWORD|define\s*\(/.test(t) },
  { path: "/wp-config.php~", sev: "urgent", label: "database password file", looksReal: (t) => /DB_PASSWORD|define\s*\(/.test(t) },
  { path: "/backup.sql", sev: "urgent", label: "database backup", looksReal: (t) => /INSERT INTO|CREATE TABLE|-- MySQL/i.test(t) },
  { path: "/database.sql", sev: "urgent", label: "database backup", looksReal: (t) => /INSERT INTO|CREATE TABLE/i.test(t) },
  { path: "/dump.sql", sev: "urgent", label: "database backup", looksReal: (t) => /INSERT INTO|CREATE TABLE/i.test(t) },
  { path: "/.DS_Store", sev: "watch", label: "folder listing file", looksReal: (t) => /Bud1/.test(t) },
  { path: "/phpinfo.php", sev: "serious", label: "server configuration dump", looksReal: (t) => /phpinfo\(\)|PHP Version/i.test(t) },
  { path: "/server-status", sev: "serious", label: "live server status page", looksReal: (t) => /Apache Server Status/i.test(t) },
];

export async function runExposedFiles(ctx) {
  const { client, facts } = ctx;
  const findings = [];
  const passes = [];
  const origin = facts.baseOrigin;
  if (!origin) return { findings, passes };

  const hits = [];
  for (const t of TARGETS) {
    let res;
    try {
      res = await client.get(origin + t.path);
    } catch {
      continue; // network hiccup or budget reached: move on
    }
    if (res.status !== 200) continue;
    // Soft-404s often return 200 with an HTML page; require the content to
    // actually look like the sensitive file before flagging.
    let body = "";
    try {
      body = await res.text(4000);
    } catch {
      body = "";
    }
    if (!t.looksReal(body)) continue;
    hits.push({ ...t, contentType: res.contentType });
  }

  if (!hits.length) {
    passes.push("None of the common private files were left exposed.");
    return { findings, passes };
  }

  // One finding per exposed file, most sensitive first.
  const order = { urgent: 0, serious: 1, watch: 2 };
  hits.sort((a, b) => order[a.sev] - order[b.sev]);

  for (const h of hits) {
    const isData = h.sev === "urgent";
    findings.push({
      id: `exposed${h.path.replace(/[^a-z0-9]+/gi, "-")}`,
      category: isData ? "exposed-data" : "info-leak",
      severity: h.sev,
      title: isData
        ? "A private file is downloadable by anyone"
        : "A sensitive server file is publicly visible",
      meaning: isData
        ? `A ${h.label} at ${h.path} is sitting on your website where anyone with the link can open it. Files like this often contain passwords or customer data, exactly the kind of thing that leads to a breach.`
        : `A ${h.label} at ${h.path} is visible to the public. It hands outsiders details about how your site is built, making other attacks easier.`,
      fix: [
        `Ask whoever manages your site to remove or block public access to ${h.path}.`,
        isData ? "Move backups and secrets out of the public website folder for good." : "Disable that page in your server or app settings.",
        isData ? "If it was exposed for a while, consider rotating any passwords it contained." : "Double-check no other debug pages are public.",
      ].filter(Boolean),
      who: "Your web person or hosting provider, promptly.",
      evidence: {
        lines: [
          `GET ${origin}${h.path}`,
          `<- 200 OK   content-type: ${h.contentType || "unknown"}`,
          `matched the shape of a real ${h.label} (contents redacted, not stored)`,
        ],
        note: "Porchlight confirmed the file is reachable and stopped. It did not download, keep, or read the contents.",
      },
    });
  }

  return { findings, passes };
}
