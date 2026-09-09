import { sql, dbEnabled, newId } from './db.js';
import { canonicalize, sha256Hex } from './signing.js';

export const REVIEW_STATUSES = ['confirmed', 'incorrect', 'inconclusive'];
export const SELECTION_NOTE = 'These are selected cases reviewed by a person. Agreement on these cases is not overall model accuracy. Votes and inconclusive reviews are not evaluation labels.';
const key = (reportId, findingId) => reportId + '\0' + findingId;
const iso = (value) => new Date(value).toISOString();
export function caseId(reportId, findingId) { return 'fc_' + sha256Hex(key(reportId, findingId)).slice(0, 32); }
export function publicReview(row) { return row ? { status: row.status, reason: row.reason, reviewedAt: iso(row.reviewed_at) } : null; }

export async function ensureReviewSchema() {
  if (!dbEnabled()) return false;
  await sql(`CREATE TABLE IF NOT EXISTS finding_feedback_reviews (
    id TEXT PRIMARY KEY, sequence BIGSERIAL UNIQUE NOT NULL,
    report_id TEXT NOT NULL, finding_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('confirmed','incorrect','inconclusive')),
    reason TEXT NOT NULL, reviewer_id TEXT NOT NULL,
    reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    report_snapshot JSONB NOT NULL, finding_snapshot JSONB NOT NULL,
    finding_digest TEXT NOT NULL
  )`);
  await sql('CREATE INDEX IF NOT EXISTS finding_feedback_reviews_case_idx ON finding_feedback_reviews (report_id, finding_id, sequence DESC)');
  return true;
}
export async function latestReviews(reportId = null) {
  return sql(`SELECT DISTINCT ON (report_id, finding_id) * FROM finding_feedback_reviews
    ${reportId ? 'WHERE report_id=$1' : ''} ORDER BY report_id, finding_id, sequence DESC`, reportId ? [reportId] : []);
}
function pick(value, fields) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const field of fields) if (Object.hasOwn(value, field)) out[field] = structuredClone(value[field]);
  return out;
}
// Old disputed.notes and submitter metadata must not reappear in a snapshot.
export function findingSnapshot(finding) {
  const out = pick(finding, ['id', 'source', 'severity', 'category', 'title', 'meaning', 'fix', 'who', 'observedAt', 'detector', 'check']);
  if (finding?.evidence) out.evidence = pick(finding.evidence, ['lines', 'note', 'method', 'pages', 'items', 'shots', 'why', 'confirm', 'observedAt', 'detector', 'check', 'source']);
  return out;
}
function reportSnapshot(report) {
  const out = pick(report, ['id', 'target', 'url', 'scannedAt', 'grade', 'gradeLabel', 'score', 'summary', 'passes']);
  if (report.assessment) out.assessment = pick(report.assessment, ['status', 'reason']);
  if (Array.isArray(report.coverage)) out.coverage = report.coverage.map((entry) => pick(entry, ['check', 'status', 'reason']));
  if (report.engine) out.engine = pick(report.engine, ['llm', 'model', 'version', 'implementationVersion', 'orchestrator', 'reporter', 'focus', 'checksRun']);
  return out;
}
export async function appendReview({ report, finding, status, reason, reviewerId }) {
  const snapshot = findingSnapshot(finding);
  const rows = await sql(`INSERT INTO finding_feedback_reviews
    (id,report_id,finding_id,status,reason,reviewer_id,report_snapshot,finding_snapshot,finding_digest)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
  [newId(), report.id, finding.id, status, reason, reviewerId, JSON.stringify(reportSnapshot(report)), JSON.stringify(snapshot), sha256Hex(canonicalize(snapshot))]);
  return publicReview(rows[0]);
}
export async function reviewQueue({ limit = 50, offset = 0 } = {}) {
  const selected = await sql(`WITH activity AS (
    SELECT report_id,finding_id,updated_at AS at FROM finding_feedback
    UNION ALL SELECT report_id,finding_id,reviewed_at AS at FROM finding_feedback_reviews
  ), cases AS (SELECT report_id,finding_id,max(at) AS last_at FROM activity GROUP BY report_id,finding_id)
  SELECT c.report_id,c.finding_id,c.last_at,r.report FROM cases c JOIN reports r ON r.id=c.report_id
  ORDER BY c.last_at DESC,c.report_id,c.finding_id LIMIT $1 OFFSET $2`, [limit + 1, offset]);
  const page = selected.slice(0, limit);
  const ids = [...new Set(page.map((row) => row.report_id))];
  if (!ids.length) return { cases: [], pagination: { limit, offset, hasMore: false } };
  const counts = await sql(`SELECT report_id,finding_id,
    count(*) FILTER (WHERE verdict='right')::int AS right,
    count(*) FILTER (WHERE verdict='wrong')::int AS wrong
    FROM finding_feedback WHERE report_id=ANY($1::text[]) GROUP BY report_id,finding_id`, [ids]);
  const notes = await sql(`SELECT * FROM (SELECT report_id,finding_id,note,updated_at,
    row_number() OVER (PARTITION BY report_id,finding_id ORDER BY updated_at DESC,id) AS n
    FROM finding_feedback WHERE report_id=ANY($1::text[]) AND note IS NOT NULL AND note<>'') ranked WHERE n<=20`, [ids]);
  const reviews = await sql(`SELECT DISTINCT ON (report_id,finding_id) * FROM finding_feedback_reviews
    WHERE report_id=ANY($1::text[]) ORDER BY report_id,finding_id,sequence DESC`, [ids]);
  const countsByKey = new Map(counts.map((row) => [key(row.report_id, row.finding_id), { right: row.right, wrong: row.wrong }]));
  const reviewsByKey = new Map(reviews.map((row) => [key(row.report_id, row.finding_id), publicReview(row)]));
  return {
    cases: page.map((row) => {
      const k = key(row.report_id, row.finding_id);
      const report = { ...row.report, id: row.report_id };
      const finding = (Array.isArray(report.findings) ? report.findings : []).find((f) => f?.id === row.finding_id);
      return { caseId: caseId(row.report_id, row.finding_id), reportId: row.report_id, findingId: row.finding_id,
        report: reportSnapshot(report), finding: finding ? findingSnapshot(finding) : null,
        reviewable: row.finding_id !== '_report' && Boolean(finding), counts: countsByKey.get(k) || { right: 0, wrong: 0 },
        notes: notes.filter((n) => key(n.report_id, n.finding_id) === k).map((n) => ({ text: n.note, submittedAt: iso(n.updated_at) })),
        review: reviewsByKey.get(k) || null };
    }), pagination: { limit, offset, hasMore: selected.length > limit },
  };
}
export async function feedbackProgress() {
  const [signals] = await sql(`SELECT count(*)::int AS total,
    count(*) FILTER (WHERE verdict='right')::int AS right,
    count(*) FILTER (WHERE verdict='wrong')::int AS wrong FROM finding_feedback`);
  const [totals] = await sql(`WITH submitted AS (SELECT DISTINCT report_id,finding_id FROM finding_feedback WHERE finding_id<>'_report'),
    latest AS (SELECT DISTINCT ON (report_id,finding_id) report_id,finding_id,status FROM finding_feedback_reviews ORDER BY report_id,finding_id,sequence DESC)
    SELECT (SELECT count(*)::int FROM submitted) AS submitted,
    (SELECT count(*)::int FROM latest) AS reviewed,
    (SELECT count(*)::int FROM submitted s WHERE NOT EXISTS (SELECT 1 FROM latest l WHERE l.report_id=s.report_id AND l.finding_id=s.finding_id)) AS pending,
    (SELECT count(*)::int FROM latest WHERE status='confirmed') AS confirmed,
    (SELECT count(*)::int FROM latest WHERE status='incorrect') AS incorrect,
    (SELECT count(*)::int FROM latest WHERE status='inconclusive') AS inconclusive`);
  return { signals, cases: totals, signalsBasis: 'Current saved votes. Changing an answer replaces its previous vote. Review progress covers individual findings; report-wide votes remain separate signals.',
    limitation: 'These totals describe submitted feedback and human review, not overall model accuracy. Feedback does not automatically train a model or change production prompts.' };
}
export async function evaluationCases() {
  const rows = await sql(`WITH latest AS (SELECT DISTINCT ON (report_id,finding_id) * FROM finding_feedback_reviews
    ORDER BY report_id,finding_id,sequence DESC)
    SELECT * FROM latest WHERE status IN ('confirmed','incorrect') AND finding_id<>'_report' ORDER BY report_id,finding_id LIMIT 10001`);
  if (rows.length > 10000) throw Object.assign(new Error('The export exceeds 10,000 cases. Please export a smaller reviewed collection.'), { status: 413 });
  return { schemaVersion: 1, exportedAt: new Date().toISOString(), selectionNote: SELECTION_NOTE,
    cases: rows.map((row) => ({ caseId: caseId(row.report_id, row.finding_id), reportId: row.report_id, findingId: row.finding_id,
      expected: row.status === 'confirmed' ? 'present' : 'absent', report: row.report_snapshot, finding: row.finding_snapshot,
      provenance: { reviewId: row.id, status: row.status, reason: row.reason, reviewedAt: iso(row.reviewed_at), findingDigest: row.finding_digest } })) };
}
