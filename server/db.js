// db.js
// Optional Postgres persistence. When DATABASE_URL is set:
//  - every checkup is saved for its owner at /r/<id>
//  - business nominations are recorded
//  - the community helper directory is stored
// When it is not set, the app still runs, these features just say so.

import pg from "pg";
import crypto from "node:crypto";

let pool = null;

export function dbEnabled() {
  return Boolean(pool);
}

export async function initDb() {
  const url = process.env.DATABASE_URL;
  if (!url) return false;
  pool = new pg.Pool({
    connectionString: url,
    max: 5,
    ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined,
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id         TEXT PRIMARY KEY,
      target     TEXT NOT NULL,
      url        TEXT NOT NULL,
      grade      TEXT NOT NULL,
      score      INTEGER,
      report     JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS reports_created_at_idx ON reports (created_at DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nominations (
      id         TEXT PRIMARY KEY,
      target     TEXT NOT NULL,
      note       TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS helpers (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      contact    TEXT NOT NULL,
      area       TEXT,
      blurb      TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS helpers_created_at_idx ON helpers (created_at DESC)`);
  // ---- accounts ----
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id             TEXT PRIMARY KEY,
      email          TEXT UNIQUE NOT NULL,
      email_verified BOOLEAN NOT NULL DEFAULT false,
      password_hash  TEXT,
      name           TEXT,
      avatar_url     TEXT,
      about          TEXT,
      contact        TEXT,
      role           TEXT NOT NULL DEFAULT 'user',
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login_at  TIMESTAMPTZ
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_accounts (
      provider         TEXT NOT NULL,
      provider_user_id TEXT NOT NULL,
      user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email            TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (provider, provider_user_id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      ip         TEXT,
      user_agent TEXT
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auth_tokens (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL,
      token_hash TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at    TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  // ---- reports: ownership, dedup, attestation, contact hints ----
  for (const stmt of [
    `ALTER TABLE reports ALTER COLUMN score DROP NOT NULL`,
    `ALTER TABLE reports ADD COLUMN IF NOT EXISTS user_id TEXT`,
    `ALTER TABLE reports ADD COLUMN IF NOT EXISTS target_host TEXT`,
    `ALTER TABLE reports ADD COLUMN IF NOT EXISTS signature TEXT`,
    `ALTER TABLE reports ADD COLUMN IF NOT EXISTS key_id TEXT`,
    `ALTER TABLE reports ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ`,
    `ALTER TABLE reports ADD COLUMN IF NOT EXISTS contact JSONB`,
    `CREATE INDEX IF NOT EXISTS reports_host_idx ON reports (target_host, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS reports_user_idx ON reports (user_id, created_at DESC)`,
    `UPDATE reports SET target_host = lower(regexp_replace(target, '^www\\.', '')) WHERE target_host IS NULL`,
  ]) await pool.query(stmt);
  // ---- community bulletin ----
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bulletin_posts (
      id         TEXT PRIMARY KEY,
      report_id  TEXT UNIQUE NOT NULL REFERENCES reports(id),
      user_id    TEXT REFERENCES users(id),
      note       TEXT,
      status     TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS bulletin_posts_created_idx ON bulletin_posts (created_at DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bulletin_offers (
      id         TEXT PRIMARY KEY,
      post_id    TEXT NOT NULL REFERENCES bulletin_posts(id) ON DELETE CASCADE,
      user_id    TEXT REFERENCES users(id),
      message    TEXT NOT NULL,
      contact    TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS bulletin_offers_post_idx ON bulletin_offers (post_id, created_at)`);
  // Keep withdrawn rows for creation limits, while allowing a later explicit post.
  await pool.query(`ALTER TABLE bulletin_posts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS bulletin_posts_active_report_idx ON bulletin_posts (report_id) WHERE deleted_at IS NULL`);
  await pool.query(`ALTER TABLE bulletin_posts DROP CONSTRAINT IF EXISTS bulletin_posts_report_id_key`);
  await pool.query(`ALTER TABLE bulletin_offers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE helpers ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id)`);
  await pool.query(`ALTER TABLE helpers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
  await pool.query(`CREATE INDEX IF NOT EXISTS helpers_user_idx ON helpers (user_id, created_at DESC)`);
  return true;
}

export function newId() {
  return crypto.randomBytes(8).toString("base64url").slice(0, 10);
}

/** Run a query; resolves rows. Throws when no database is configured. */
export async function sql(text, params = []) {
  if (!pool) throw new Error("Database is not configured.");
  const { rows } = await pool.query(text, params);
  return rows;
}

/** Serialize one account's community quota checks and writes across server processes. */
export async function withCommunityAccountLock(userId, work) {
  if (!pool) throw new Error("Database is not configured.");
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['community:' + userId]);
    const query = async (text, params = []) => (await client.query(text, params)).rows;
    const result = await work(query);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

// ---- reports ----
export async function saveReport(report) {
  if (!pool) return null;
  const id = report.id || newId();
  const host = String(report.target || "").toLowerCase().replace(/^www\./, "");
  const att = report.attestation || null;
  await pool.query(
    `INSERT INTO reports (id, target, url, grade, score, report, user_id, target_host, signature, key_id, signed_at, contact)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, report.target, report.url, report.grade, report.score, JSON.stringify({ ...report, id }),
     report.userId || null, host, att ? att.signature : null, att ? att.keyId : null, att ? att.signedAt : null,
     report.contact ? JSON.stringify(report.contact) : null]
  );
  return id;
}

/** Latest reports for a host (dedup prompt). */
export async function reportsForHost(host, limit = 10, { userId } = {}) {
  if (!pool || !userId) return [];
  const { rows } = await pool.query(
    `SELECT r.id, r.grade, r.score, r.created_at, r.user_id,
       (SELECT p.id FROM bulletin_posts p WHERE p.report_id=r.id AND p.deleted_at IS NULL) AS bulletin_post_id
       FROM reports r
      WHERE r.target_host = $1 AND r.user_id = $3 ORDER BY r.created_at DESC LIMIT $2`,
    [host, Math.max(1, Math.min(100, limit)), userId]);
  return rows;
}
export async function getReport(id) {
  if (!pool) return null;
  const { rows } = await pool.query(`SELECT r.id, r.report, r.user_id,
    (SELECT p.id FROM bulletin_posts p WHERE p.report_id=r.id AND p.deleted_at IS NULL) AS bulletin_post_id
    FROM reports r WHERE r.id = $1`, [id]);
  if (!rows.length) return null;
  return { ...rows[0].report, id: rows[0].id, userId: rows[0].user_id || null, bulletinPostId: rows[0].bulletin_post_id || null };
}
export async function listReports(limit = 20, { host, userId } = {}) {
  if (!pool || !userId) return [];
  const where = []; const params = [];
  if (host) { params.push(host); where.push(`r.target_host = $${params.length}`); }
  if (userId) { params.push(userId); where.push(`r.user_id = $${params.length}`); }
  params.push(Math.max(1, Math.min(100, limit)));
  const { rows } = await pool.query(
    `SELECT r.id, r.target, r.grade, r.score, r.created_at, r.user_id,
       (SELECT p.id FROM bulletin_posts p WHERE p.report_id=r.id AND p.deleted_at IS NULL) AS bulletin_post_id
       FROM reports r
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY r.created_at DESC LIMIT $${params.length}`, params);
  return rows;
}

// ---- nominations ----
export async function saveNomination(target, note) {
  if (!pool) return null;
  const id = newId();
  await pool.query(`INSERT INTO nominations (id, target, note) VALUES ($1,$2,$3)`, [id, target, note || null]);
  return id;
}

// ---- helpers directory ----
export async function addHelper({ name, contact, area, blurb, userId }) {
  if (!pool) return null;
  return withCommunityAccountLock(userId, async query => {
    const [usage] = await query("SELECT count(*)::int AS n FROM helpers WHERE user_id=$1 AND created_at > now() - interval '1 day'", [userId]);
    if (usage.n >= 10) return null;
    const [row] = await query(
      `INSERT INTO helpers (id, name, contact, area, blurb, user_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [newId(), name, contact, area || null, blurb || null, userId]
    );
    return row;
  });
}
export async function listHelpers(limit = 50, { userId, offset = 0 } = {}) {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT h.id, h.name, h.contact, h.area, h.blurb, h.created_at, h.user_id
       FROM helpers h JOIN users u ON u.id=h.user_id
      WHERE h.deleted_at IS NULL AND ${userId ? 'h.user_id=$2' : 'u.email_verified=true'}
      ORDER BY h.created_at DESC, h.id LIMIT $1 OFFSET $${userId ? 3 : 2}`,
    [Math.max(1, Math.min(100, limit)), ...(userId ? [userId] : []), Math.max(0, Math.min(500000, Number(offset) || 0))]
  );
  return rows;
}
