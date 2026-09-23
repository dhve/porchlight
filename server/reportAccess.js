import { dbEnabled, sql } from './db.js';

const ID_RE = /^[A-Za-z0-9_-]{6,20}$/;

export async function loadReportAccess(id) {
  if (!dbEnabled()) return null;
  const [row] = await sql(`SELECT r.id, r.user_id,
    (SELECT p.id FROM bulletin_posts p WHERE p.report_id=r.id AND p.deleted_at IS NULL) AS bulletin_post_id
    FROM reports r WHERE r.id=$1`, [id]);
  return row || null;
}

export function canReadReport(row, viewer) {
  return Boolean(row && (row.bulletin_post_id ||
    (viewer?.id && (row.user_id === viewer.id || viewer.role === 'admin'))));
}

// Mounted before all report-derived routers. A report id is never a read token.
export async function requireReportAccess(req, res, next) {
  res.set('Cache-Control', 'private, no-store');
  const id = String(req.params.id || '');
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'Bad report id.' });
  try {
    const row = await loadReportAccess(id);
    if (!canReadReport(row, req.user)) return res.status(404).json({ error: "We couldn't find that report." });
    req.reportAccess = row;
    next();
  } catch {
    res.status(500).json({ error: 'Could not load that report.' });
  }
}
