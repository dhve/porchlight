// db.js
// Optional Postgres persistence. When DATABASE_URL is set, every checkup is
// saved so the owner gets a shareable link (/r/<id>) and past reports can be
// listed. When it is not set, everything still works, reports just aren't kept.

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
  return true;
}

/** Short, URL-safe id for share links (64^10 possibilities). */
function newId() {
  return crypto.randomBytes(8).toString("base64url").slice(0, 10);
}

export async function saveReport(report) {
  if (!pool) return null;
  const id = newId();
  await pool.query(
    `INSERT INTO reports (id, target, url, grade, score, report) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, report.target, report.url, report.grade, report.score, JSON.stringify({ ...report, id })]
  );
  return id;
}

export async function getReport(id) {
  if (!pool) return null;
  const { rows } = await pool.query(`SELECT id, report, created_at FROM reports WHERE id = $1`, [id]);
  if (!rows.length) return null;
  return { ...rows[0].report, id: rows[0].id };
}

export async function listReports(limit = 20) {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT id, target, grade, score, created_at FROM reports ORDER BY created_at DESC LIMIT $1`,
    [Math.max(1, Math.min(100, limit))]
  );
  return rows;
}
