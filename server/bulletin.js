// bulletin.js
// The community bulletin: people post a finished checkup so others can offer
// to help fix what came up. Posts point at a saved report; offers hang off a
// post. List views only carry severity and title for each finding, never the
// evidence. The detail view returns the stored report as is.
//
// Routes (all JSON):
//   GET    /api/bulletin?sort=new|worst&page=1
//   GET    /api/bulletin/:id
//   POST   /api/bulletin                       { reportId, note? }     verified, 10/day
//   PATCH  /api/bulletin/:id                   { status }              poster or admin
//   POST   /api/bulletin/:id/offers            { message, contact }    verified, 20/day
//   DELETE /api/bulletin/:id/offers/:offerId                           offer owner, poster, or admin

import express from "express";
import { sql, newId, dbEnabled } from "./db.js";
import { requireAuth, requireVerified, csrfGuard } from "./auth.js";

export const bulletinRouter = express.Router();

const PAGE_SIZE = 20;
const DAY_MS = 24 * 60 * 60_000;
const POSTS_PER_DAY = 10;
const OFFERS_PER_DAY = 20;
const OFFERS_SHOWN = 200;
const STATUSES = ["open", "claimed", "resolved"];
// Every severity that counts as a finding. "good" entries are passes, not findings.
const PROBLEM_SEVERITIES = ["urgent", "serious", "watch", "minor"];
const ID_RE = /^[A-Za-z0-9_-]{6,20}$/;

function appUrl() {
  return String(process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
}

// ---- shared SQL ----
// One projection for every place a post is returned, so list, detail, create
// and update all agree on the shape. topFindings is built inside Postgres from
// severity and title only, so evidence never leaves the database for list views.
const POST_FIELDS = `
  p.id, p.note, p.status, p.created_at, p.updated_at, p.user_id,
  u.name AS by_name, u.avatar_url AS by_avatar,
  r.id AS report_id, r.target, r.grade, r.score,
  r.report->'tally' AS tally,
  r.report->>'summary' AS summary,
  COALESCE(r.contact, r.report->'contact') AS contact,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('severity', f.value->>'severity', 'title', f.value->>'title') ORDER BY f.ord), '[]'::jsonb)
     FROM (SELECT e.value, e.ordinality AS ord
             FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.report->'findings') = 'array' THEN r.report->'findings' ELSE '[]'::jsonb END)
                  WITH ORDINALITY AS e
            WHERE e.value->>'severity' = ANY($POSTFIELDS_SEV)
            ORDER BY e.ordinality
            LIMIT 3) f) AS top_findings,
  (SELECT count(*)::int FROM bulletin_offers o WHERE o.post_id = p.id) AS offers_count`;

const POST_FROM = `
  FROM bulletin_posts p
  JOIN reports r ON r.id = p.report_id
  LEFT JOIN users u ON u.id = p.user_id`;

/**
 * Select posts with the shared projection. `$POSTFIELDS_SEV` is replaced with
 * the placeholder index of the severity array, which is always appended last.
 */
async function selectPosts({ where = "", order = "p.created_at DESC, p.id", limit = null, offset = 0, params = [], withReport = false }) {
  const all = [...params, PROBLEM_SEVERITIES];
  const sevIdx = all.length;
  const fields = POST_FIELDS.replace("$POSTFIELDS_SEV", `$${sevIdx}`) + (withReport ? ", r.report AS full_report" : "");
  let text = `SELECT ${fields} ${POST_FROM}`;
  if (where) text += ` WHERE ${where}`;
  text += ` ORDER BY ${order}`;
  if (limit != null) {
    all.push(limit);
    text += ` LIMIT $${all.length}`;
    all.push(offset);
    text += ` OFFSET $${all.length}`;
  }
  return sql(text, all);
}

async function loadPost(id, withReport = false) {
  const rows = await selectPosts({ where: "p.id = $1", params: [id], withReport });
  return rows[0] || null;
}

// ---- shaping ----
function iso(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function shapeContact(c) {
  const src = c && typeof c === "object" ? c : {};
  const strs = (arr) => (Array.isArray(arr) ? arr.filter((x) => typeof x === "string" && x.trim()).slice(0, 20) : []);
  return { emails: strs(src.emails), pages: strs(src.pages) };
}

function shapeTally(t) {
  const src = t && typeof t === "object" ? t : {};
  const n = (k) => (Number.isFinite(Number(src[k])) ? Number(src[k]) : 0);
  return { urgent: n("urgent"), serious: n("serious"), watch: n("watch"), minor: n("minor"), good: n("good") };
}

function shapeTopFindings(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((f) => f && typeof f === "object")
    .map((f) => ({ severity: String(f.severity || ""), title: String(f.title || "") }))
    .slice(0, 3);
}

function shapeBy(id, name, avatarUrl) {
  return { id: id || null, name: name || null, avatarUrl: avatarUrl || null };
}

function shapePost(row) {
  return {
    id: row.id,
    note: row.note || null,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    by: shapeBy(row.user_id, row.by_name, row.by_avatar),
    offersCount: Number(row.offers_count) || 0,
    report: {
      id: row.report_id,
      target: row.target,
      grade: row.grade,
      score: Number(row.score),
      tally: shapeTally(row.tally),
      summary: row.summary || "",
      topFindings: shapeTopFindings(row.top_findings),
      contact: shapeContact(row.contact),
    },
  };
}

function shapeOffer(row) {
  return {
    id: row.id,
    message: row.message,
    contact: row.contact,
    createdAt: iso(row.created_at),
    by: shapeBy(row.user_id, row.by_name, row.by_avatar),
  };
}

// ---- the intro message ----
const SEVERITY_WORDS = { urgent: "needs attention soon", serious: "serious", watch: "worth a look", minor: "minor" };

function sentence(text) {
  const t = String(text || "").trim();
  if (!t) return "";
  return /[.!?]$/.test(t) ? t : t + ".";
}

function fixSteps(finding) {
  const raw = finding?.fix;
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return arr.map((s) => String(s).trim()).filter(Boolean);
}

/**
 * A ready-to-send note the helper can paste into an email. Greets the site,
 * says where the writer found it, names the top findings in plain words, says
 * what the report suggests for the first one, offers help, links the report.
 */
export function buildIntro({ post, report, writerName }) {
  const base = appUrl();
  const target = String(report?.target || post?.report?.target || "there").trim();
  const findings = Array.isArray(report?.findings) ? report.findings : [];
  const top = findings.filter((f) => f && PROBLEM_SEVERITIES.includes(f.severity)).slice(0, 3);

  const lines = [];
  lines.push(`Hello ${target} team,`);
  lines.push("");
  lines.push(
    `I came across your website on the Sutros community bulletin (${base}/b/${post.id}). ` +
      `Sutros runs free, read only checkups of small business websites, and people on the bulletin offer to help with what the checkup finds.`
  );
  lines.push("");

  if (top.length) {
    lines.push(top.length === 1 ? "The checkup found one thing worth your attention:" : "The checkup found a few things worth your attention:");
    lines.push("");
    top.forEach((f, i) => {
      const label = SEVERITY_WORDS[f.severity] || f.severity;
      lines.push(`${i + 1}. ${String(f.title || "").trim()} (${label})`);
    });
    lines.push("");
    const first = top[0];
    const steps = fixSteps(first);
    if (steps.length) {
      const what = steps.length === 1 ? sentence(steps[0]) : sentence(steps[0]) + " " + sentence(steps[1]);
      lines.push(`For the first one, the report suggests: ${what}`);
    } else if (first.meaning) {
      lines.push(`About the first one, the report says: ${sentence(first.meaning)}`);
    }
    lines.push("");
    lines.push(
      "I would be glad to help with any of these, or to walk through the report with you if that is useful. " +
        "If you already have someone who looks after the site, feel free to pass this along to them."
    );
  } else {
    lines.push("The checkup came back in good shape, with nothing that needs fixing right now.");
    lines.push("");
    lines.push("If you ever want a hand keeping the site in good shape, I would be glad to help.");
  }

  lines.push("");
  lines.push(`You can read the full report here: ${base}/r/${report?.id || post.report.id}`);
  lines.push("");
  lines.push("Warm regards,");
  lines.push(writerName ? String(writerName).trim() : "[your name]");
  return lines.join("\n");
}

// ---- validation ----
function clean(v, max) {
  return String(v == null ? "" : v).trim().slice(0, max);
}

function isEmail(s) {
  return /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/.test(s);
}

function isHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function pageNumber(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 10_000);
}

function isAdmin(user) {
  return Boolean(user && user.role === "admin");
}

// ---- plumbing ----
function needDb(_req, res, next) {
  if (!dbEnabled()) return res.status(503).json({ error: "The bulletin needs a database, which isn't set up here yet." });
  next();
}

function guard(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      console.error("bulletin:", err && err.message ? err.message : err);
      if (!res.headersSent) res.status(500).json({ error: "Something went wrong on our side. Please try again." });
    }
  };
}

function badId(res, what = "post") {
  return res.status(400).json({ error: `That ${what} link doesn't look right.` });
}

// ---- daily limits ----
// Counted from the table itself rather than an in-memory bucket, so the limit
// holds across restarts and always covers a full 24 hours.
const DAILY_TABLES = { post: "bulletin_posts", offer: "bulletin_offers" };

/**
 * How many rows this user added to a table in the last 24 hours, plus the
 * oldest one in that window so a Retry-After can be worked out.
 */
async function dailyUsage(kind, userId) {
  const table = DAILY_TABLES[kind];
  if (!table) throw new Error(`Unknown daily limit kind: ${kind}`);
  const rows = await sql(
    `SELECT count(*)::int AS n, min(created_at) AS oldest
       FROM ${table}
      WHERE user_id = $1 AND created_at > now() - interval '1 day'`,
    [userId]
  );
  const row = rows[0] || {};
  return { n: Number(row.n) || 0, oldest: row.oldest || null };
}

function retryAfterSeconds(oldest) {
  const at = oldest ? new Date(oldest).getTime() : NaN;
  const ms = Number.isFinite(at) ? at + DAY_MS - Date.now() : DAY_MS;
  return Math.max(1, Math.ceil(ms / 1000));
}

/** True when the response has been sent because the user is over the daily limit. */
async function overDailyLimit(res, kind, userId, max, message) {
  const usage = await dailyUsage(kind, userId);
  if (usage.n < max) return false;
  res.setHeader("Retry-After", String(retryAfterSeconds(usage.oldest)));
  res.status(429).json({ error: message });
  return true;
}

// ---- routes ----

// List posts. Newest first by default; "worst" puts the lowest scores first.
bulletinRouter.get(
  "/api/bulletin",
  guard(async (req, res) => {
    const sort = req.query.sort === "worst" ? "worst" : "new";
    const page = pageNumber(req.query.page);
    if (!dbEnabled()) return res.json({ posts: [], page, hasMore: false, sort, db: false });

    const order = sort === "worst" ? "r.score ASC, p.created_at DESC, p.id" : "p.created_at DESC, p.id";
    const rows = await selectPosts({ order, limit: PAGE_SIZE + 1, offset: (page - 1) * PAGE_SIZE });
    const hasMore = rows.length > PAGE_SIZE;
    res.json({ posts: rows.slice(0, PAGE_SIZE).map(shapePost), page, hasMore, sort, db: true });
  })
);

// One post with the full stored report, its offers, and a ready-to-send intro.
bulletinRouter.get(
  "/api/bulletin/:id",
  needDb,
  guard(async (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return badId(res);
    const row = await loadPost(id, true);
    if (!row) return res.status(404).json({ error: "We couldn't find that bulletin post." });

    const post = shapePost(row);
    const report = row.full_report && typeof row.full_report === "object" ? { ...row.full_report, id: row.report_id } : null;
    const offerRows = await sql(
      `SELECT o.id, o.message, o.contact, o.created_at, o.user_id, u.name AS by_name, u.avatar_url AS by_avatar
         FROM bulletin_offers o LEFT JOIN users u ON u.id = o.user_id
        WHERE o.post_id = $1
        ORDER BY o.created_at ASC, o.id
        LIMIT $2`,
      [id, OFFERS_SHOWN]
    );
    const intro = buildIntro({ post, report, writerName: req.user ? req.user.name : null });
    res.json({ post, report, offers: offerRows.map(shapeOffer), intro });
  })
);

// Post a checkup to the bulletin. One post per report.
bulletinRouter.post(
  "/api/bulletin",
  requireVerified,
  csrfGuard,
  needDb,
  guard(async (req, res) => {
    const body = req.body || {};
    const reportId = clean(body.reportId, 40);
    if (!ID_RE.test(reportId)) return res.status(400).json({ error: "Please include the checkup you want to post." });
    const noteRaw = body.note == null ? "" : String(body.note).trim();
    if (noteRaw.length > 500) return res.status(400).json({ error: "Please keep the note to 500 characters." });
    const note = noteRaw || null;

    const reportRows = await sql(`SELECT id, user_id FROM reports WHERE id = $1`, [reportId]);
    if (!reportRows.length) return res.status(404).json({ error: "We couldn't find that checkup." });
    if (reportRows[0].user_id && reportRows[0].user_id !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only the account that ran this checkup can post it." });
    }

    const existing = await sql(`SELECT id FROM bulletin_posts WHERE report_id = $1`, [reportId]);
    if (existing.length) {
      return res.status(409).json({ error: "This checkup is already on the bulletin.", postId: existing[0].id });
    }

    if (
      await overDailyLimit(
        res,
        "post",
        req.user.id,
        POSTS_PER_DAY,
        `You've posted ${POSTS_PER_DAY} checkups today, which is the daily limit. Please try again tomorrow.`
      )
    ) return;

    const id = newId();
    const inserted = await sql(
      `INSERT INTO bulletin_posts (id, report_id, user_id, note)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (report_id) DO NOTHING
       RETURNING id`,
      [id, reportId, req.user.id, note]
    );
    if (!inserted.length) {
      // Someone posted the same report a moment ago.
      const again = await sql(`SELECT id FROM bulletin_posts WHERE report_id = $1`, [reportId]);
      return res.status(409).json({ error: "This checkup is already on the bulletin.", postId: again[0] ? again[0].id : null });
    }

    const row = await loadPost(id);
    res.status(201).json({ post: shapePost(row) });
  })
);

// Change a post's status. Only the poster or an admin.
bulletinRouter.patch(
  "/api/bulletin/:id",
  requireAuth,
  csrfGuard,
  needDb,
  guard(async (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return badId(res);
    const status = clean(req.body?.status, 20).toLowerCase();
    if (!STATUSES.includes(status)) {
      return res.status(400).json({ error: "Status should be open, claimed, or resolved." });
    }

    const rows = await sql(`SELECT id, user_id FROM bulletin_posts WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: "We couldn't find that bulletin post." });
    if (rows[0].user_id !== req.user.id && !isAdmin(req.user)) {
      return res.status(403).json({ error: "Only the person who posted this can change its status." });
    }

    await sql(`UPDATE bulletin_posts SET status = $2, updated_at = now() WHERE id = $1`, [id, status]);
    const row = await loadPost(id);
    res.json({ post: shapePost(row) });
  })
);

// Offer to help on a post.
bulletinRouter.post(
  "/api/bulletin/:id/offers",
  requireVerified,
  csrfGuard,
  needDb,
  guard(async (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return badId(res);
    const body = req.body || {};
    const message = String(body.message == null ? "" : body.message).trim();
    const contact = clean(body.contact, 201);

    if (message.length < 20) return res.status(400).json({ error: "Please write at least 20 characters so the owner knows how you can help." });
    if (message.length > 1500) return res.status(400).json({ error: "Please keep your message to 1500 characters." });
    if (!contact) return res.status(400).json({ error: "Please include a way to reach you: an email address or a link." });
    if (contact.length > 200) return res.status(400).json({ error: "Please keep your contact to 200 characters." });
    if (!isEmail(contact) && !isHttpUrl(contact)) {
      return res.status(400).json({ error: "Contact should be an email address or a link that starts with http." });
    }

    const posts = await sql(`SELECT id FROM bulletin_posts WHERE id = $1`, [id]);
    if (!posts.length) return res.status(404).json({ error: "We couldn't find that bulletin post." });

    // One offer per person per post. They can remove theirs and write a new one.
    const mine = await sql(`SELECT id FROM bulletin_offers WHERE post_id = $1 AND user_id = $2 LIMIT 1`, [id, req.user.id]);
    if (mine.length) {
      return res.status(409).json({ error: "You already offered to help on this post.", offerId: mine[0].id });
    }

    if (
      await overDailyLimit(
        res,
        "offer",
        req.user.id,
        OFFERS_PER_DAY,
        `You've sent ${OFFERS_PER_DAY} offers today, which is the daily limit. Please try again tomorrow.`
      )
    ) return;

    const offerId = newId();
    await sql(
      `INSERT INTO bulletin_offers (id, post_id, user_id, message, contact) VALUES ($1, $2, $3, $4, $5)`,
      [offerId, id, req.user.id, message, contact]
    );
    const rows = await sql(
      `SELECT o.id, o.message, o.contact, o.created_at, o.user_id, u.name AS by_name, u.avatar_url AS by_avatar
         FROM bulletin_offers o LEFT JOIN users u ON u.id = o.user_id
        WHERE o.id = $1`,
      [offerId]
    );
    res.status(201).json({ offer: shapeOffer(rows[0]) });
  })
);

// Remove an offer. The offer's owner, the poster, or an admin.
bulletinRouter.delete(
  "/api/bulletin/:id/offers/:offerId",
  requireAuth,
  csrfGuard,
  needDb,
  guard(async (req, res) => {
    const { id, offerId } = req.params;
    if (!ID_RE.test(id)) return badId(res);
    if (!ID_RE.test(offerId)) return badId(res, "offer");

    const rows = await sql(
      `SELECT o.id, o.user_id, p.user_id AS post_user_id
         FROM bulletin_offers o JOIN bulletin_posts p ON p.id = o.post_id
        WHERE o.id = $1 AND o.post_id = $2`,
      [offerId, id]
    );
    if (!rows.length) return res.status(404).json({ error: "We couldn't find that offer." });
    const offer = rows[0];
    const allowed = offer.user_id === req.user.id || offer.post_user_id === req.user.id || isAdmin(req.user);
    if (!allowed) return res.status(403).json({ error: "Only the person who wrote this offer or the poster can remove it." });

    await sql(`DELETE FROM bulletin_offers WHERE id = $1`, [offerId]);
    res.json({ ok: true });
  })
);
