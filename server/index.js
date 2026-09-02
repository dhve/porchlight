// index.js
// The Porchlight web server.
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
const { initDb, dbEnabled, getReport, listReports } = await import("./db.js");

const app = express();
app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(ROOT, "public")));

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

const PORT = parseInt(process.env.PORT || "3000", 10);
const dbOn = await initDb().catch((err) => {
  console.error("  database: " + err.message);
  return false;
});
app.listen(PORT, () => {
  console.log(`\n  Porchlight is on at http://localhost:${PORT}`);
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
