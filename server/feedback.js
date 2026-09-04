// feedback.js
// Readers say whether a finding was right or wrong, with an optional note.
// No account is needed. Anonymous voters get a stable key from the session
// secret, their IP, and their browser, so one person gets one vote per finding
// and can change their mind. Votes are stored per report and per site host, so
// a later checkup of the same site can show that visitors disputed a finding.
//
// Routes (JSON; index.js already puts /api under csrfGuard and attachUser):
//   GET  /api/reports/:id/feedback              counts, recent notes, and my votes
//   POST /api/reports/:id/feedback              { findingId, verdict, note?, website? }
//   GET  /api/feedback/summary                  admins only, last 90 days
//
// Exports: feedbackRouter, ensureFeedbackSchema(), disputesForHost(host, { sinceDays })

import express from "express";
import { sql, dbEnabled, newId } from "./db.js";
import { sha256Hex } from "./signing.js";
import { consume, ip } from "./ratelimit.js";

export const feedbackRouter = express.Router();

const ID_RE = /^[A-Za-z0-9_-]{6,20}$/;
const REPORT_LEVEL = "_report";
const VERDICTS = ["right", "wrong"];
const FINDING_ID_MAX = 120;
const NOTE_MAX = 400;
const NOTES_SHOWN = 5;
const DISPUTE_NOTES = 3;
const SUMMARY_NOTES = 3;
const VOTES_PER_HOUR = 40;
const HOUR_MS = 60 * 60_000;
const SUMMARY_DAYS = 90;
const NO_DB = "Feedback is not available right now because the database is not set up.";

// ---- schema ----
export async function ensureFeedbackSchema() {
  if (!dbEnabled()) return false;
  await sql(`
    CREATE TABLE IF NOT EXISTS finding_feedback (
      id          TEXT PRIMARY KEY,
      report_id   TEXT NOT NULL,
      target_host TEXT NOT NULL,
      finding_id  TEXT NOT NULL,
      user_id     TEXT,
      voter_key   TEXT NOT NULL,
      verdict     TEXT NOT NULL CHECK (verdict IN ('right','wrong')),
      note        TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (report_id, finding_id, voter_key)
    )`);
  await sql(`CREATE INDEX IF NOT EXISTS finding_feedback_host_idx ON finding_feedback (target_host, finding_id)`);
  await sql(`CREATE INDEX IF NOT EXISTS finding_feedback_created_idx ON finding_feedback (created_at)`);
  return true;
}

// ---- small helpers ----
function normHost(host) {
  return String(host || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
}

function iso(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function firstName(name) {
  const s = String(name || "").trim();
  if (!s) return null;
  return s.split(/\s+/)[0].slice(0, 40);
}

/** Who is voting: the user id when signed in, else a hash that stays the same for one browser on one connection. */
function voterKey(req) {
  if (req.user && req.user.id) return String(req.user.id);
  const secret = String(process.env.SESSION_SECRET || "");
  const agent = String(req.get("user-agent") || "");
  return "anon:" + sha256Hex(secret + "|" + ip(req) + "|" + agent).slice(0, 32);
}

/** Trim, normalise line breaks, and drop control characters. Returns "" when there is nothing left. */
function cleanNote(raw) {
  if (raw == null) return "";
  if (typeof raw !== "string") return null;
  let s = raw.replace(/\r\n?|[\u2028\u2029]/g, "\n");
  s = s.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

function needDb(_req, res, next) {
  if (!dbEnabled()) return res.status(503).json({ error: NO_DB });
  next();
}

/** Wrap an async handler so a thrown error becomes a plain 500 instead of a hung request. */
function safe(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      console.error("feedback:", err && err.message ? err.message : err);
      if (!res.headersSent) res.status(500).json({ error: "Something went wrong on our side. Please try again." });
    });
  };
}

// ---- reading state ----
/**
 * Counts, recent notes, and the caller's own votes for one report.
 * When findingId is given, only that finding is loaded.
 * Returns { findings: { [findingId]: { right, wrong, notes } }, mine: { [findingId]: verdict } }.
 */
async function loadFeedback(reportId, key, findingId = null) {
  const params = [reportId];
  let where = "f.report_id = $1";
  if (findingId != null) { params.push(findingId); where += ` AND f.finding_id = $${params.length}`; }

  const counts = await sql(
    `SELECT f.finding_id, f.verdict, count(*)::int AS n FROM finding_feedback f WHERE ${where} GROUP BY f.finding_id, f.verdict`,
    params);
  const notes = await sql(
    `SELECT t.finding_id, t.note, t.created_at, t.name
       FROM (SELECT f.finding_id, f.note, f.created_at, u.name,
                    row_number() OVER (PARTITION BY f.finding_id ORDER BY f.created_at DESC, f.id) AS rn
               FROM finding_feedback f LEFT JOIN users u ON u.id = f.user_id
              WHERE ${where} AND f.note IS NOT NULL AND f.note <> '') t
      WHERE t.rn <= ${NOTES_SHOWN}
      ORDER BY t.finding_id, t.created_at DESC`,
    params);
  const mineParams = [...params, key];
  const mineRows = await sql(
    `SELECT f.finding_id, f.verdict FROM finding_feedback f WHERE ${where} AND f.voter_key = $${mineParams.length}`,
    mineParams);

  const findings = {};
  const entry = (id) => (findings[id] ||= { right: 0, wrong: 0, notes: [] });
  for (const row of counts) {
    const e = entry(row.finding_id);
    if (row.verdict === "right") e.right = row.n;
    else if (row.verdict === "wrong") e.wrong = row.n;
  }
  for (const row of notes) {
    entry(row.finding_id).notes.push({ text: row.note, when: iso(row.created_at), by: firstName(row.name) });
  }
  const mine = {};
  for (const row of mineRows) mine[row.finding_id] = row.verdict;
  return { findings, mine };
}

/** The POST response shape for one finding. */
function oneFinding(state, findingId) {
  const f = state.findings[findingId] || { right: 0, wrong: 0, notes: [] };
  return { findingId, right: f.right, wrong: f.wrong, mine: state.mine[findingId] || null, notes: f.notes };
}

// ---- routes ----
feedbackRouter.get("/api/reports/:id/feedback", needDb, safe(async (req, res) => {
  const id = req.params.id;
  if (!ID_RE.test(id)) return res.status(400).json({ error: "Bad report id." });
  const exists = await sql(`SELECT 1 FROM reports WHERE id = $1`, [id]);
  if (!exists.length) return res.status(404).json({ error: "We couldn't find that checkup." });
  const state = await loadFeedback(id, voterKey(req));
  res.json(state);
}));

feedbackRouter.post("/api/reports/:id/feedback", needDb, safe(async (req, res) => {
  const id = req.params.id;
  if (!ID_RE.test(id)) return res.status(400).json({ error: "Bad report id." });
  const body = req.body && typeof req.body === "object" ? req.body : {};

  const findingId = typeof body.findingId === "string" ? body.findingId.trim() : "";
  if (!findingId || findingId.length > FINDING_ID_MAX || /[\u0000-\u001F\u007F-\u009F]/.test(findingId)) {
    return res.status(400).json({ error: "Please say which finding this is about." });
  }
  const verdict = typeof body.verdict === "string" ? body.verdict.trim().toLowerCase() : "";
  if (!VERDICTS.includes(verdict)) return res.status(400).json({ error: "Please answer yes or no." });
  const note = cleanNote(body.note);
  if (note === null) return res.status(400).json({ error: "The note should be plain text." });
  if (note.length > NOTE_MAX) return res.status(400).json({ error: `Please keep the note to ${NOTE_MAX} characters or fewer.` });

  const rows = await sql(`SELECT report, target_host FROM reports WHERE id = $1`, [id]);
  if (!rows.length) return res.status(404).json({ error: "We couldn't find that checkup." });
  const report = rows[0].report && typeof rows[0].report === "object" ? rows[0].report : {};
  const inReport = findingId === REPORT_LEVEL ||
    (Array.isArray(report.findings) && report.findings.some((f) => f && String(f.id) === findingId));
  if (!inReport) return res.status(400).json({ error: "That finding is not part of this checkup." });
  const host = normHost(rows[0].target_host || report.target || "");
  if (!host) return res.status(400).json({ error: "This checkup has no site to attach feedback to." });

  const key = voterKey(req);

  // Honeypot: a filled "website" field means a bot. Answer normally, store nothing.
  // Anything that is not empty counts, whatever type the bot sent it as.
  if (body.website != null && body.website !== false && String(body.website).trim()) {
    const state = await loadFeedback(id, key, findingId);
    return res.json(oneFinding(state, findingId));
  }

  const rl = consume("feedback", key, VOTES_PER_HOUR, HOUR_MS);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(Math.ceil(rl.retryAfterMs / 1000)));
    return res.status(429).json({ error: "That is a lot of feedback in one hour. Please try again a little later." });
  }

  await sql(
    `INSERT INTO finding_feedback (id, report_id, target_host, finding_id, user_id, voter_key, verdict, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (report_id, finding_id, voter_key) DO UPDATE
        SET verdict = EXCLUDED.verdict, note = EXCLUDED.note, user_id = EXCLUDED.user_id, created_at = now()`,
    [newId(), id, host, findingId, req.user && req.user.id ? String(req.user.id) : null, key, verdict, note || null]);

  const state = await loadFeedback(id, key, findingId);
  res.json(oneFinding(state, findingId));
}));

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") return res.status(403).json({ error: "Only admins can see this." });
  next();
}

feedbackRouter.get("/api/feedback/summary", requireAdmin, needDb, safe(async (req, res) => {
  const since = new Date(Date.now() - SUMMARY_DAYS * 24 * HOUR_MS);

  const rows = await sql(
    `SELECT finding_id,
            count(*) FILTER (WHERE verdict = 'wrong')::int AS n_wrong,
            count(*) FILTER (WHERE verdict = 'right')::int AS n_right,
            count(DISTINCT target_host)::int AS n_hosts
       FROM finding_feedback
      WHERE created_at >= $1
      GROUP BY finding_id
      ORDER BY n_wrong DESC, n_right DESC, finding_id`,
    [since]);
  const notes = await sql(
    `SELECT t.finding_id, t.target_host, t.note, t.created_at
       FROM (SELECT finding_id, target_host, note, created_at,
                    row_number() OVER (PARTITION BY finding_id ORDER BY created_at DESC, id) AS rn
               FROM finding_feedback
              WHERE created_at >= $1 AND verdict = 'wrong' AND note IS NOT NULL AND note <> '') t
      WHERE t.rn <= ${SUMMARY_NOTES}
      ORDER BY t.finding_id, t.created_at DESC`,
    [since]);

  const byId = new Map();
  for (const row of notes) {
    if (!byId.has(row.finding_id)) byId.set(row.finding_id, []);
    byId.get(row.finding_id).push({ host: row.target_host, text: row.note, when: iso(row.created_at) });
  }
  res.json({
    since: since.toISOString(),
    findings: rows.map((r) => ({
      findingId: r.finding_id,
      wrong: r.n_wrong,
      right: r.n_right,
      hosts: r.n_hosts,
      latestNotes: byId.get(r.finding_id) || [],
    })),
  });
}));

// ---- for the pipeline ----
/**
 * Votes on every earlier checkup of a site, so a new report can say a finding was disputed.
 * Resolves Map<findingId, { wrong, right, notes: [{ text, when }] }>; notes are the most recent
 * "wrong" notes (max 3). Resolves an empty Map when there is no database.
 */
export async function disputesForHost(host, { sinceDays = SUMMARY_DAYS } = {}) {
  const out = new Map();
  const h = normHost(host);
  if (!h || !dbEnabled()) return out;
  const days = Math.max(1, Math.min(3650, Math.floor(Number(sinceDays)) || SUMMARY_DAYS));
  const since = new Date(Date.now() - days * 24 * HOUR_MS);

  const counts = await sql(
    `SELECT finding_id, verdict, count(*)::int AS n
       FROM finding_feedback
      WHERE target_host = $1 AND created_at >= $2
      GROUP BY finding_id, verdict`,
    [h, since]);
  const entry = (id) => {
    if (!out.has(id)) out.set(id, { wrong: 0, right: 0, notes: [] });
    return out.get(id);
  };
  for (const row of counts) {
    const e = entry(row.finding_id);
    if (row.verdict === "wrong") e.wrong = row.n;
    else if (row.verdict === "right") e.right = row.n;
  }
  if (!out.size) return out;

  const notes = await sql(
    `SELECT t.finding_id, t.note, t.created_at
       FROM (SELECT finding_id, note, created_at,
                    row_number() OVER (PARTITION BY finding_id ORDER BY created_at DESC, id) AS rn
               FROM finding_feedback
              WHERE target_host = $1 AND created_at >= $2 AND verdict = 'wrong' AND note IS NOT NULL AND note <> '') t
      WHERE t.rn <= ${DISPUTE_NOTES}
      ORDER BY t.finding_id, t.created_at DESC`,
    [h, since]);
  for (const row of notes) entry(row.finding_id).notes.push({ text: row.note, when: iso(row.created_at) });
  return out;
}
