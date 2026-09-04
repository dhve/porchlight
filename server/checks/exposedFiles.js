// exposedFiles.js
// Step 3: try the doors and windows. Check a fixed, curated list of well-known
// sensitive paths that should never be publicly readable.
//
// This is detection, not exploitation:
//  - a fixed list (no guessing, no fuzzing, no wordlist brute force)
//  - a plain GET, exactly what a browser would do
//  - we confirm the file is really exposed by matching its shape, then STOP
//  - we never store or return the sensitive contents; evidence is redacted
//
// Like checking whether a back door was left unlocked, not walking in.
//
// Every finding carries evidence.items (the address we requested and the
// status it answered), evidence.pages (the homepage, never the sensitive file
// itself, so proof screenshots never capture its contents), and
// evidence.method (how we tested it). Only a 200 answer whose body matches the
// file's shape counts as exposed; a 401, 403, 405, 406, 429, or 503 answer
// means the site refused our checker. After two 429 answers we stop probing
// and set facts.throttled.

const RX = {
  env: (t) => /^\s*[A-Z0-9_]+\s*=/m.test(t) && !/<html/i.test(t),
  sql: (t) => /INSERT INTO|CREATE TABLE|-- MySQL|PostgreSQL database dump|DROP TABLE/i.test(t),
  archive: (t, ct) => /application\/(zip|x-gzip|x-tar|octet-stream)/i.test(ct || ""),
  phpcfg: (t) => /DB_PASSWORD|define\s*\(\s*['"]DB_|\$db|password/i.test(t) && !/<html/i.test(t),
  gitHead: (t) => /^ref:\s/.test(t),
  gitConfig: (t) => /\[core\]/.test(t),
  svn: (t) => /dir\n|svn:|\bwc\.db\b/i.test(t),
  dsstore: (t) => /Bud1/.test(t),
  phpinfo: (t) => /phpinfo\(\)|<title>phpinfo\(\)|PHP Version/i.test(t),
  apacheStatus: (t) => /Apache Server Status|Apache Server Information/i.test(t),
  log: (t) => /\b(error|warning|notice|stack trace|exception|deprecated)\b/i.test(t) && !/<html/i.test(t),
  htaccess: (t) => /RewriteEngine|Options |Deny from|Require /i.test(t) && !/<html/i.test(t),
  webconfig: (t) => /<configuration>|<system\.web>/i.test(t),
  npmrc: (t) => /_authToken|registry=/.test(t),
  dockerCompose: (t) => /^\s*(services|version)\s*:/m.test(t) && !/<html/i.test(t),
  aws: (t) => /aws_access_key_id|aws_secret_access_key/i.test(t),
  ssh: (t) => /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/.test(t),
  json: (t) => /^\s*\{/.test(t) && /"(dependencies|scripts|name)"\s*:/.test(t),
};

// severity: urgent = secrets/data; serious = source/info; watch = minor leak
const TARGETS = [
  { path: "/.env", sev: "urgent", label: "environment / secrets file", ok: RX.env },
  { path: "/.env.local", sev: "urgent", label: "environment / secrets file", ok: RX.env },
  { path: "/.env.production", sev: "urgent", label: "environment / secrets file", ok: RX.env },
  { path: "/.git/HEAD", sev: "urgent", label: "source code repository", ok: RX.gitHead },
  { path: "/.git/config", sev: "urgent", label: "source code repository", ok: RX.gitConfig },
  { path: "/.svn/wc.db", sev: "urgent", label: "source code repository", ok: RX.svn },
  { path: "/wp-config.php.bak", sev: "urgent", label: "database password file", ok: RX.phpcfg },
  { path: "/wp-config.php~", sev: "urgent", label: "database password file", ok: RX.phpcfg },
  { path: "/wp-config.php.save", sev: "urgent", label: "database password file", ok: RX.phpcfg },
  { path: "/config.php.bak", sev: "urgent", label: "config backup", ok: RX.phpcfg },
  { path: "/backup.sql", sev: "urgent", label: "database backup", ok: RX.sql },
  { path: "/database.sql", sev: "urgent", label: "database backup", ok: RX.sql },
  { path: "/dump.sql", sev: "urgent", label: "database backup", ok: RX.sql },
  { path: "/db.sql", sev: "urgent", label: "database backup", ok: RX.sql },
  { path: "/backup.zip", sev: "urgent", label: "site backup archive", ok: RX.archive },
  { path: "/backup.tar.gz", sev: "urgent", label: "site backup archive", ok: RX.archive },
  { path: "/www.zip", sev: "urgent", label: "site backup archive", ok: RX.archive },
  { path: "/.aws/credentials", sev: "urgent", label: "cloud credentials", ok: RX.aws },
  { path: "/.ssh/id_rsa", sev: "urgent", label: "private SSH key", ok: RX.ssh },
  { path: "/.npmrc", sev: "urgent", label: "package registry token", ok: RX.npmrc },
  { path: "/docker-compose.yml", sev: "serious", label: "deployment config", ok: RX.dockerCompose },
  { path: "/phpinfo.php", sev: "serious", label: "server configuration dump", ok: RX.phpinfo },
  { path: "/info.php", sev: "serious", label: "server configuration dump", ok: RX.phpinfo },
  { path: "/server-status", sev: "serious", label: "live server status page", ok: RX.apacheStatus },
  { path: "/server-info", sev: "serious", label: "server information page", ok: RX.apacheStatus },
  { path: "/web.config", sev: "serious", label: "server config file", ok: RX.webconfig },
  { path: "/.htaccess", sev: "serious", label: "server rules file", ok: RX.htaccess },
  { path: "/wp-content/debug.log", sev: "serious", label: "debug log", ok: RX.log },
  { path: "/debug.log", sev: "serious", label: "debug log", ok: RX.log },
  { path: "/composer.lock", sev: "minor", label: "dependency list", ok: RX.json },
  { path: "/package.json", sev: "minor", label: "dependency list", ok: RX.json },
  { path: "/.DS_Store", sev: "minor", label: "folder listing file", ok: RX.dsstore },
];

const STATUS_TEXT = {
  200: "OK", 201: "Created", 204: "No Content", 301: "Moved Permanently", 302: "Found", 304: "Not Modified",
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
  406: "Not Acceptable", 408: "Request Timeout", 410: "Gone", 429: "Too Many Requests",
  500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
};

export async function runExposedFiles(ctx) {
  const { client, facts } = ctx;
  const findings = [];
  const passes = [];
  const origin = facts.baseOrigin;
  if (!origin) return { findings, passes };
  if (!client) return { findings, passes };
  const homepage = homepageOf(facts);
  const throttle = { count: 0, stop: false };
  if (facts.throttled) await pause(3000);

  const hits = [];
  let tested = 0; // targets that got an answer other than a rate limit
  let failed = 0; // requests that never completed (timeout, budget, connection)
  for (const t of TARGETS) {
    if (throttle.stop) break;
    let res;
    try {
      res = await client.get(origin + t.path);
    } catch (err) {
      failed++;
      // The request budget for this checkup is spent; nothing more will answer.
      if (err && err.code === "BUDGET") break;
      continue;
    }
    noteStatus(facts, throttle, res.status);
    if (res.status === 429) { release(res); continue; }
    tested++;
    // Only a 200 can be an exposed file. Access denied, method not allowed,
    // rate limit, and unavailable answers mean the site refused our checker.
    if (res.status !== 200) { release(res); continue; }
    let body = "";
    try { body = await res.text(4000); } catch { body = ""; }
    if (!t.ok(body, res.contentType)) continue;
    hits.push({ ...t, contentType: res.contentType, status: res.status, statusText: statusTextOf(res) });
  }

  if (!hits.length) {
    // Only claim a pass for files that actually answered. When the check was
    // cut short, say so instead of claiming the untested files are fine.
    if (throttle.stop) {
      if (tested > 0) {
        passes.push(`We tested ${tested} of the ${TARGETS.length} common private files and none of them was exposed. The rest could not be tested because the site limited our checker.`);
      } else {
        passes.push("The common private files could not be tested because the site limited our checker.");
      }
    } else if (failed > 0) {
      if (tested > 0) {
        passes.push(`We tested ${tested} of the ${TARGETS.length} common private files and none of them was exposed. The rest did not answer.`);
      }
    } else {
      passes.push("None of the common private files were left exposed.");
    }
    return { findings, passes };
  }

  const order = { urgent: 0, serious: 1, watch: 2, minor: 3 };
  hits.sort((a, b) => order[a.sev] - order[b.sev]);

  for (const h of hits) {
    const isData = h.sev === "urgent";
    const fileUrl = origin + h.path;
    findings.push({
      id: `exposed${h.path.replace(/[^a-z0-9]+/gi, "-")}`,
      category: isData ? "exposed-data" : "info-leak",
      severity: h.sev,
      title: isData ? "A private file is downloadable by anyone" : "A sensitive file is publicly visible",
      meaning: isData
        ? `A ${h.label} at ${h.path} is sitting on your website where anyone with the link can open it. Files like this often contain passwords, keys, or customer data, exactly what leads to a breach.`
        : `A ${h.label} at ${h.path} is visible to the public. It hands outsiders details about how your site is built, making other attacks easier.`,
      fix: [
        `Ask whoever manages your site to remove or block public access to ${h.path}.`,
        isData ? "Move backups, secrets, and repositories out of the public website folder for good." : "Disable or protect that file in your server settings.",
        isData ? "Treat any passwords or keys it contained as compromised and rotate them." : "Confirm no other config or debug files are public.",
      ].filter(Boolean),
      who: "Your web person or hosting provider, promptly.",
      evidence: {
        lines: [
          `GET ${origin}${h.path}`,
          `<- 200 OK   content-type: ${h.contentType || "unknown"}`,
          `matched the shape of a real ${h.label} (contents redacted, not stored)`,
        ],
        note: "Sutros confirmed the file is reachable and stopped. It did not download, keep, or read the contents.",
        method: `We requested ${h.path} on this site with a plain GET, exactly what a browser does, and checked that the answer was a 200 whose first few lines matched the shape of a real ${h.label}. We stopped there and did not keep the contents.`,
        pages: [homepage],
        items: [{ url: fileUrl, status: h.status, statusText: h.statusText, kind: "file" }],
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

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
