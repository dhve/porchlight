// index.js
// The Sutros web server.
//  - serves the frontend from /public
//  - GET  /api/checkup/stream  live progress + report over Server-Sent Events
//  - POST /api/checkup         the same checkup, returned as one JSON response
//
// Both endpoints validate public input and pass targets through the safety guards.

import express from "express";
import dns from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

loadEnv(path.join(ROOT, ".env"));

// Imported after env is loaded so the modules see OPENAI_API_KEY.
const { normalizePublicUrl, resolveTarget } = await import("./safety.js");
const { publicReport } = await import("./publicReport.js");
const { runCheckup } = await import("./pipeline.js");
const { llmEnabled, modelName } = await import("./llm.js");
const { initDb, dbEnabled, getReport, listReports, saveNomination, addHelper, listHelpers } = await import("./db.js");
const { setupRouter } = await import("./setup.js");
const { reportsForHost } = await import("./db.js");
const { authRouter, attachUser, csrfGuard } = await import("./auth.js");
const { oauthRouter } = await import("./oauth.js");
const { verifyRouter } = await import("./verify.js");
const { bulletinRouter } = await import("./bulletin.js");
const { consume } = await import("./ratelimit.js");
const { mailStatus } = await import("./mail.js");
const { retestRouter } = await import("./retest.js");
const { proofRouter, ensureProofSchema, sweepOldShots } = await import("./proof.js");
const { feedbackRouter, ensureFeedbackSchema } = await import("./feedback.js");

const app = express();
app.set("trust proxy", ["loopback", "172.16.0.0/12"]);
app.use(express.json({ limit: "16kb" }));
// Account state and viewer-specific capabilities must never enter shared caches.
app.use("/api", (_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); });
app.use(setupRouter(ROOT));
app.use(attachUser);
app.use(["/api", "/auth"], csrfGuard);
app.use(authRouter);
app.use(oauthRouter);
app.use(verifyRouter);
app.use(bulletinRouter);
app.use(retestRouter);
app.use(proofRouter);
app.use(feedbackRouter);

const REQUIRE_ACCOUNT = process.env.REQUIRE_ACCOUNT === "1";
const normHost = (h) => String(h || "").toLowerCase().replace(/^www\./, "");

app.get("/api/config", (_req, res) => {
  res.json({
    requireAccount: REQUIRE_ACCOUNT,
    providers: { google: Boolean(process.env.GOOGLE_CLIENT_ID), github: Boolean(process.env.GITHUB_CLIENT_ID) },
    mail: { configured: mailStatus().configured },
    agent: llmEnabled() && process.env.AGENT_BROWSE !== "0",
  });
});

/** Site owners can opt out: a DNS TXT record _sutros.<host> containing "optout",
 *  or a robots.txt group "User-agent: SutrosBot" with "Disallow: /". */
async function optedOut(host) {
  try {
    const txt = await dns.resolveTxt(`_sutros.${host}`);
    if (txt.flat().some((t) => /optout/i.test(t))) return "dns";
  } catch {}
  try {
    const r = await fetch(`https://${host}/robots.txt`, { signal: AbortSignal.timeout(5000), headers: { "User-Agent": "SutrosBot/0.1 (+https://sutros.org)" }, redirect: "follow" });
    if (r.ok && /text\/plain/i.test(r.headers.get("content-type") || "")) {
      const body = (await r.text()).slice(0, 20000);
      let mine = false;
      for (const raw of body.split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, "").trim();
        if (!line) { mine = false; continue; }
        const ua = line.match(/^user-agent:\s*(.+)$/i);
        if (ua) { mine = mine || /^sutrosbot$/i.test(ua[1].trim()); continue; }
        if (mine && /^disallow:\s*\/\s*$/i.test(line)) return "robots";
      }
    }
  } catch {}
  return null;
}

/** Account + rate + per-host cooldown gate for running a checkup. Returns an error object or null. */
async function checkupGate(req, host) {
  if (REQUIRE_ACCOUNT) {
    if (!req.user) return { status: 401, error: "Please sign in to run a checkup." };
    if (!req.user.emailVerified) return { status: 403, error: "Please confirm your email first.", code: "unverified" };
    const r = consume("checkups", req.user.id, 20, 24 * 60 * 60_000);
    if (!r.ok) return { status: 429, error: "This account has reached its limit of 20 checkups in 24 hours. Please wait before trying again.", retryAfterMs: r.retryAfterMs };
  } else if (req.user) {
    const r = consume("checkups", req.user.id, 30, 24 * 60 * 60_000);
    if (!r.ok) return { status: 429, error: "This account has reached its limit of 30 checkups in 24 hours. Please wait before trying again.", retryAfterMs: r.retryAfterMs };
  } else {
    // No account needed. Anonymous checkups are paced per connection, and everyone shares a ceiling
    // so a burst of bots cannot run up the bill.
    const r = consume("checkups-ip", req.ip || "x", 12, 60 * 60_000);
    if (!r.ok) return { status: 429, error: "This connection has reached its limit of 12 checkups in an hour. Please wait before trying again.", retryAfterMs: r.retryAfterMs };
    const g = consume("checkups-anon-all", "all", 150, 60 * 60_000);
    if (!g.ok) return { status: 429, error: "Sutros has reached its shared limit for checkups without an account. Please wait before trying again.", retryAfterMs: g.retryAfterMs };
  }
  if (await optedOut(host)) return { status: 403, error: "This site's owner has asked not to be checked by Sutros." };
  try {
    const latest = (await reportsForHost(host, 1))[0];
    if (latest && Date.now() - new Date(latest.created_at).getTime() < 10 * 60_000) {
      return { status: 429, error: "This site was checked less than 10 minutes ago. Here is the latest report.", latestReportId: latest.id, retryAfterMs: 10 * 60_000 - (Date.now() - new Date(latest.created_at).getTime()) };
    }
  } catch {}
  return null;
}
app.use(express.static(path.join(ROOT, "public"), {
  // Always revalidate the app shell so visitors never see a stale copy after a deploy.
  setHeaders: (res, filePath) => {
    if (/\.(html|css|js)$/.test(filePath)) res.setHeader("Cache-Control", "no-cache");
  },
}));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, llm: llmEnabled(), model: llmEnabled() ? modelName() : null, db: dbEnabled() });
});

// ---- streaming checkup (Server-Sent Events) ----
app.get("/api/checkup/stream", async (req, res) => {
  // Only the site's own EventSource may start a checkup here: a typed or linked
  // navigation carries neither the event-stream Accept header nor a cors fetch mode.
  if (req.get("sec-fetch-mode") === "navigate" || !/text\/event-stream/i.test(req.get("accept") || "")) {
    return res.status(400).json({ error: "Please start checkups from the Sutros site." });
  }
  const target = await prepare(req.query.url, req.query.consent);

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "private, no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  const send = (event, data) => {
    const payload = event === "report" ? publicReport(data, req.user) : data;
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  if (!target.ok) {
    send("error", { message: target.error });
    return res.end();
  }
  const gate = await checkupGate(req, target.display);
  if (gate) { send("error", { message: gate.error, code: gate.code, latestReportId: gate.latestReportId, retryAfterSeconds: gate.retryAfterMs == null ? undefined : Math.ceil(gate.retryAfterMs / 1000) }); return res.end(); }
  target.userId = req.user ? req.user.id : null;

  let closed = false;
  req.on("close", () => { closed = true; });

  try {
    await runCheckup(target, (event, data) => {
      if (!closed) send(event, data);
    });
  } catch (err) {
    if (!closed) send("error", { message: "Something went wrong during the checkup. Please try again." });
    console.error("checkup error:", err);
  }
  res.end();
});

// ---- one-shot checkup (JSON) ----
app.post("/api/checkup", async (req, res) => {
  const target = await prepare(req.body?.url, req.body?.consent);
  if (!target.ok) return res.status(400).json({ error: target.error });
  const gate = await checkupGate(req, target.display);
  if (gate) {
    const retryAfterSeconds = gate.retryAfterMs == null ? undefined : Math.ceil(gate.retryAfterMs / 1000);
    if (retryAfterSeconds != null) res.set("Retry-After", String(retryAfterSeconds));
    return res.status(gate.status).json({ error: gate.error, code: gate.code, latestReportId: gate.latestReportId, retryAfterSeconds });
  }
  target.userId = req.user ? req.user.id : null;
  try {
    const report = await runCheckup(target, () => {});
    res.json(publicReport(report, req.user));
  } catch (err) {
    console.error("checkup error:", err);
    res.status(500).json({ error: "Something went wrong during the checkup. Please try again." });
  }
});

// ---- saved reports (when a database is configured) ----
app.get("/api/checks", async (req, res) => {
  const host = normHost(req.query.host);
  if (!host) return res.status(400).json({ error: "Missing host." });
  try {
    const rows = await reportsForHost(host, 10);
    res.json({ host, count: rows.length, reports: rows.map((r) => publicReport({ id: r.id, grade: r.grade, score: r.score, scannedAt: r.created_at, user_id: r.user_id }, req.user)) });
  } catch (err) {
    console.error("checks:", err);
    res.status(500).json({ error: "Could not look up that site." });
  }
});

app.get("/api/reports", async (req, res) => {
  try {
    const opts = {};
    if (req.query.host) opts.host = normHost(req.query.host);
    if (req.query.mine === "1") { if (!req.user) return res.status(401).json({ error: "Please sign in." }); opts.userId = req.user.id; }
    const rows = await listReports(parseInt(req.query.limit, 10) || 20, opts);
    res.json({ db: dbEnabled(), reports: rows.map((r) => publicReport(r, req.user)) });
  } catch (err) {
    console.error("list reports:", err);
    res.status(500).json({ error: "Could not list reports." });
  }
});

app.get("/api/reports/:id", async (req, res) => {
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(req.params.id)) return res.status(400).json({ error: "Bad report id." });
  try {
    const report = await getReport(req.params.id);
    if (!report) return res.status(404).json({ error: "We couldn't find that report." });
    res.json(publicReport(report, req.user));
  } catch (err) {
    console.error("get report:", err);
    res.status(500).json({ error: "Could not load that report." });
  }
});

// Share links render the app, which then fetches the saved report by id.
app.get("/r/:id", (_req, res) => res.sendFile(path.join(ROOT, "public", "index.html")));
app.get(["/login", "/signup", "/forgot", "/reset", "/account", "/bulletin", "/b/:id", "/verify/:id", "/review", "/auth-error"], (_req, res) => res.sendFile(path.join(ROOT, "public", "index.html")));
app.get("/privacy", (_req, res) => res.sendFile(path.join(ROOT, "public", "privacy.html")));
app.get("/terms", (_req, res) => res.sendFile(path.join(ROOT, "public", "terms.html")));

// ---- nominate a local business (records it, returns a shareable invite) ----
app.post("/api/nominate", async (req, res) => {
  const norm = normalizePublicUrl(req.body?.url);
  if (!norm.ok) return res.status(400).json({ error: norm.error });
  const note = String(req.body?.note || "").slice(0, 500) || null;
  try {
    const id = dbEnabled() ? await saveNomination(norm.display, note) : null;
    res.json({ ok: true, id, saved: Boolean(id), target: norm.display });
  } catch (err) {
    console.error("nominate:", err);
    res.status(500).json({ error: "Could not record that nomination." });
  }
});

// ---- community helper directory ----
app.get("/api/helpers", async (_req, res) => {
  try {
    res.json({ db: dbEnabled(), helpers: await listHelpers(50) });
  } catch (err) {
    console.error("list helpers:", err);
    res.status(500).json({ error: "Could not load the helper list." });
  }
});

app.post("/api/helpers", async (req, res) => {
  if (!dbEnabled()) return res.status(503).json({ error: "The helper directory needs a database, which isn't configured here yet." });
  const name = clean(req.body?.name, 80);
  const contact = clean(req.body?.contact, 200);
  const area = clean(req.body?.area, 80);
  const blurb = clean(req.body?.blurb, 400);
  if (!name || !contact) return res.status(400).json({ error: "Please include at least a name and a way to reach you." });
  // Basic contact sanity: an email or an http(s) link.
  if (!/^\S+@\S+\.\S+$/.test(contact) && !/^https?:\/\//i.test(contact)) {
    return res.status(400).json({ error: "Contact should be an email address or a link (starting with http)." });
  }
  try {
    const helper = await addHelper({ name, contact, area, blurb });
    res.json({ ok: true, helper });
  } catch (err) {
    console.error("add helper:", err);
    res.status(500).json({ error: "Could not add you to the directory." });
  }
});

const PORT = parseInt(process.env.PORT || "3000", 10);
const dbOn = await initDb().catch((err) => {
  console.error("  database: " + err.message);
  return false;
});
if (dbOn) {
  await ensureProofSchema().catch((err) => console.error("  proof schema: " + err.message));
  await ensureFeedbackSchema().catch((err) => console.error("  feedback schema: " + err.message));
  const sweep = () => sweepOldShots(60).then((n) => { if (n) console.log(`  swept ${n} old page pictures`); }).catch((err) => console.error("  sweep: " + err.message));
  sweep();
  setInterval(sweep, 24 * 60 * 60_000).unref();
}
app.listen(PORT, () => {
  console.log(`\n  Sutros is on at http://localhost:${PORT}`);
  console.log(`  LLM: ${llmEnabled() ? "enabled (" + modelName() + ")" : "off - using rule-based fallback (add OPENAI_API_KEY to .env to enable)"}`);
  console.log(`  DB:  ${dbOn ? "connected - reports are saved" : "off - set DATABASE_URL in .env to save reports"}\n`);
});

// ---- helpers ----

/** Validate consent + URL + scope. Returns {ok, url, display} or {ok:false, error}. */
async function prepare(rawUrl, consent) {
  void consent; // accepted for compatibility; checkups are public and read-only, no ownership claim is required
  const norm = normalizePublicUrl(rawUrl);
  if (!norm.ok) return norm;
  const scope = await resolveTarget(norm.url);
  if (!scope.ok) return scope;
  return { ok: true, url: norm.url, display: norm.display };
}

/** Trim a string field and cap its length; returns "" for missing/blank. */
function clean(v, max) {
  return String(v == null ? "" : v).trim().slice(0, max);
}

/** Minimal .env loader so there is no dotenv dependency. Existing env wins. */
function loadEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return; // no .env is fine
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}
