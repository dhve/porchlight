// index.js
// The Sutros web server.
//  - serves the frontend from /public
//  - GET  /api/checkup/stream  live progress + report over Server-Sent Events
//  - POST /api/checkup         the same checkup, returned as one JSON response
//
// Both endpoints require an explicit consent flag and pass every target through
// the safety guards before any request is made.

import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

loadEnv(path.join(ROOT, ".env"));

// Imported after env is loaded so the modules see OPENAI_API_KEY.
const { normalizeUrl, resolveTarget } = await import("./safety.js");
const { runCheckup } = await import("./pipeline.js");
const { llmEnabled, modelName } = await import("./llm.js");
const { initDb, dbEnabled, getReport, listReports, saveNomination, addHelper, listHelpers } = await import("./db.js");
const { setupRouter } = await import("./setup.js");

const app = express();
app.use(express.json({ limit: "16kb" }));
app.use(setupRouter(ROOT));
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
  const target = await prepare(req.query.url, req.query.consent);

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  if (!target.ok) {
    send("error", { message: target.error });
    return res.end();
  }

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
  try {
    const report = await runCheckup(target, () => {});
    res.json(report);
  } catch (err) {
    console.error("checkup error:", err);
    res.status(500).json({ error: "Something went wrong during the checkup. Please try again." });
  }
});

// ---- saved reports (when a database is configured) ----
app.get("/api/reports", async (_req, res) => {
  try {
    res.json({ db: dbEnabled(), reports: await listReports(20) });
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
    res.json(report);
  } catch (err) {
    console.error("get report:", err);
    res.status(500).json({ error: "Could not load that report." });
  }
});

// Share links render the app, which then fetches the saved report by id.
app.get("/r/:id", (_req, res) => res.sendFile(path.join(ROOT, "public", "index.html")));

// ---- nominate a local business (records it, returns a shareable invite) ----
app.post("/api/nominate", async (req, res) => {
  const norm = normalizeUrl(req.body?.url);
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
app.listen(PORT, () => {
  console.log(`\n  Sutros is on at http://localhost:${PORT}`);
  console.log(`  LLM: ${llmEnabled() ? "enabled (" + modelName() + ")" : "off - using rule-based fallback (add OPENAI_API_KEY to .env to enable)"}`);
  console.log(`  DB:  ${dbOn ? "connected - reports are saved" : "off - set DATABASE_URL in .env to save reports"}\n`);
});

// ---- helpers ----

/** Validate consent + URL + scope. Returns {ok, url, display} or {ok:false, error}. */
async function prepare(rawUrl, consent) {
  const consented = consent === true || consent === "true" || consent === "1" || consent === 1;
  if (!consented) {
    return { ok: false, error: "Please confirm you own this website or have permission to check it." };
  }
  const norm = normalizeUrl(rawUrl);
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
