// db.js
// Optional Postgres persistence. When DATABASE_URL is set:
//  - every checkup is saved so the owner gets a shareable link (/r/<id>)
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
      score      INTEGER NOT NULL,
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
export async function reportsForHost(host, limit = 10) {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT r.id, r.grade, r.score, r.created_at, u.name AS by_name
       FROM reports r LEFT JOIN users u ON u.id = r.user_id
      WHERE r.target_host = $1 ORDER BY r.created_at DESC LIMIT $2`,
    [host, limit]);
  return rows;
}
export async function getReport(id) {
  if (!pool) return null;
  const { rows } = await pool.query(`SELECT id, report FROM reports WHERE id = $1`, [id]);
  if (!rows.length) return null;
  return { ...rows[0].report, id: rows[0].id };
}
export async function listReports(limit = 20, { host, userId } = {}) {
  if (!pool) return [];
  const where = []; const params = [];
  if (host) { params.push(host); where.push(`r.target_host = $${params.length}`); }
  if (userId) { params.push(userId); where.push(`r.user_id = $${params.length}`); }
  params.push(Math.max(1, Math.min(100, limit)));
  const { rows } = await pool.query(
    `SELECT r.id, r.target, r.grade, r.score, r.created_at, u.name AS by_name
       FROM reports r LEFT JOIN users u ON u.id = r.user_id
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
export async function addHelper({ name, contact, area, blurb }) {
  if (!pool) return null;
  const id = newId();
  await pool.query(
    `INSERT INTO helpers (id, name, contact, area, blurb) VALUES ($1,$2,$3,$4,$5)`,
    [id, name, contact, area || null, blurb || null]
  );
  return { id, name, contact, area, blurb };
}
export async function listHelpers(limit = 50) {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT id, name, contact, area, blurb, created_at FROM helpers ORDER BY created_at DESC LIMIT $1`,
    [Math.max(1, Math.min(100, limit))]
  );
  return rows;
}
