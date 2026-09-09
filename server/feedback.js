// Visitor signals are private review inputs. Counts and explicit reviewer
// decisions are public; neither votes nor rechecks alter signed reports.
import express from 'express';
import { createHmac, randomBytes } from 'node:crypto';
import { sql, dbEnabled, newId } from './db.js';
import { consume, ip } from './ratelimit.js';
import { ensureRetestSchema } from './retest.js';
import { ensureReviewSchema, latestReviews, publicReview, appendReview, reviewQueue, feedbackProgress, evaluationCases, REVIEW_STATUSES } from './feedbackReview.js';

export const feedbackRouter = express.Router();
const ID_RE = /^[A-Za-z0-9_-]{6,20}$/;
const REPORT_LEVEL = '_report';
const HOUR = 3600000;
const COOKIE = 'sutros_feedback';
let storedIdentityKey = null;
export const FEEDBACK_POLICY = {
  votes: 'Votes are unverified reader responses, not verified unique people or confirmed findings.',
  notes: 'Your note is private to authorized reviewers. Counts and a reviewer\'s separate explanation are public.',
  identity: 'A functional browser cookie lets you change your answer. A separate connection limit helps prevent abuse.',
  learning: 'A person reviews evidence before a case can be used for evaluation. Votes do not automatically train a model.',
};

export async function ensureFeedbackSchema() {
  if (!dbEnabled()) return false;
  // Keep the anonymous browser digest stable across workers and restarts even
  // when the operator has not configured an environment secret. This one-row
  // table is private server configuration and is never part of an API response.
  await sql(`CREATE TABLE IF NOT EXISTS feedback_identity_key (
    id INTEGER PRIMARY KEY CHECK (id=1),
    secret TEXT NOT NULL CHECK (secret ~ '^[A-Za-z0-9_-]{43}$')
  )`);
  await sql('INSERT INTO feedback_identity_key (id,secret) VALUES (1,$1) ON CONFLICT (id) DO NOTHING', [randomBytes(32).toString('base64url')]);
  const [identity] = await sql('SELECT secret FROM feedback_identity_key WHERE id=1');
  if (!identity || !/^[A-Za-z0-9_-]{43}$/.test(identity.secret)) throw new Error('The feedback identity key could not be initialized.');
  storedIdentityKey = identity.secret;
  await sql(`CREATE TABLE IF NOT EXISTS finding_feedback (
    id TEXT PRIMARY KEY, report_id TEXT NOT NULL, target_host TEXT NOT NULL,
    finding_id TEXT NOT NULL, user_id TEXT, voter_key TEXT NOT NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('right','wrong')), note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (report_id,finding_id,voter_key)
  )`);
  await sql('ALTER TABLE finding_feedback ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ');
  await sql('UPDATE finding_feedback SET updated_at=created_at WHERE updated_at IS NULL');
  await sql('ALTER TABLE finding_feedback ALTER COLUMN updated_at SET DEFAULT now(), ALTER COLUMN updated_at SET NOT NULL');
  await sql('CREATE INDEX IF NOT EXISTS finding_feedback_host_idx ON finding_feedback (target_host,finding_id)');
  await sql('CREATE INDEX IF NOT EXISTS finding_feedback_created_idx ON finding_feedback (created_at)');
  await ensureReviewSchema();
  await ensureRetestSchema();
  return true;
}

function identityKey() {
  const key = process.env.FEEDBACK_COOKIE_SECRET || process.env.SESSION_SECRET || storedIdentityKey;
  if (!key) throw Object.assign(new Error('Feedback identity is unavailable. Please try again later.'), { status: 503 });
  return key;
}
function digest(value) { return createHmac('sha256', identityKey()).update(value).digest('hex'); }
function voterKey(req, res) {
  identityKey(); // Fail before issuing a cookie if startup did not initialize it.
  const raw = String(req.get('cookie') || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(COOKIE + '='));
  let token = raw?.slice(COOKIE.length + 1);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    token = randomBytes(32).toString('base64url');
    res.cookie(COOKIE, token, { httpOnly: true, secure: Boolean(req.secure), sameSite: 'lax', path: '/', maxAge: 90 * 24 * HOUR });
  }
  return 'browser:' + digest(token);
}
function normHost(host) { return String(host || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, ''); }
function cleanText(value) { return value.replace(/\r\n?|[\u2028\u2029]/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '').trim(); }
function validFindingId(value) { return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 120 && !/[\u0000-\u001F\u007F-\u009F]/.test(value); }
function needDb(_req, res, next) { if (!dbEnabled()) return res.status(503).json({ error: 'Feedback is unavailable because the database is not configured.' }); next(); }
function requireAdmin(req, res, next) { if (!req.user?.id || req.user.role !== 'admin') return res.status(403).json({ error: 'Only authorized reviewers can access this.' }); next(); }
function safe(handler) { return (req, res) => Promise.resolve(handler(req, res)).catch((err) => {
  const status = [413, 503].includes(err.status) ? err.status : 500;
  if (status === 500) console.error('feedback: request failed');
  if (!res.headersSent) res.status(status).json({ error: status === 500 ? 'Feedback could not be processed right now. Please try again later.' : err.message });
}); }
async function loadReport(id) {
  const [row] = await sql('SELECT report,target_host FROM reports WHERE id=$1', [id]);
  return row ? { ...row, report: { ...row.report, id } } : null;
}
async function loadFeedback(reportId, voter) {
  const rows = await sql(`SELECT finding_id,verdict,count(*)::int AS n FROM finding_feedback WHERE report_id=$1 GROUP BY finding_id,verdict`, [reportId]);
  const own = await sql('SELECT finding_id,verdict FROM finding_feedback WHERE report_id=$1 AND voter_key=$2', [reportId, voter]);
  const findings = Object.create(null);
  const entry = (id) => (findings[id] ||= { right: 0, wrong: 0, notes: [] });
  for (const row of rows) entry(row.finding_id)[row.verdict] = row.n;
  for (const row of await latestReviews(reportId)) entry(row.finding_id).review = publicReview(row);
  return { findings, mine: Object.fromEntries(own.map((row) => [row.finding_id, row.verdict])), policy: FEEDBACK_POLICY };
}

feedbackRouter.get('/api/reports/:id/feedback', needDb, safe(async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Bad report id.' });
  if (!(await loadReport(req.params.id))) return res.status(404).json({ error: 'We could not find that checkup.' });
  res.setHeader('Cache-Control', 'private, no-store');
  res.json(await loadFeedback(req.params.id, voterKey(req, res)));
}));

feedbackRouter.post('/api/reports/:id/feedback', needDb, safe(async (req, res) => {
  const id = req.params.id;
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'Bad report id.' });
  const body = req.body || {};
  if (!validFindingId(body.findingId)) return res.status(400).json({ error: 'Please say which finding this is about.' });
  const findingId = body.findingId.trim();
  const verdict = typeof body.verdict === 'string' ? body.verdict.trim().toLowerCase() : '';
  if (!['right', 'wrong'].includes(verdict)) return res.status(400).json({ error: 'Please answer yes or no.' });
  if (body.note != null && typeof body.note !== 'string') return res.status(400).json({ error: 'The note must be plain text.' });
  const note = cleanText(body.note || '');
  if (note.length > 400) return res.status(400).json({ error: 'Please keep the private note to 400 characters or fewer.' });
  const row = await loadReport(id);
  if (!row) return res.status(404).json({ error: 'We could not find that checkup.' });
  if (findingId !== REPORT_LEVEL && !(Array.isArray(row.report.findings) && row.report.findings.some((f) => f?.id === findingId))) return res.status(400).json({ error: 'That finding is not part of this checkup.' });
  const host = normHost(row.target_host || row.report.target);
  if (!host) return res.status(400).json({ error: 'This checkup has no website to attach feedback to.' });
  const voter = voterKey(req, res);
  const limits = [consume('feedback-ip', digest('ip:' + ip(req)), 80, HOUR), consume('feedback-browser', voter, 40, HOUR)];
  const limited = limits.find((entry) => !entry.ok);
  if (limited) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(limited.retryAfterMs / 1000))));
    return res.status(429).json({ error: 'Too much feedback was submitted recently from this browser or connection. Please try again later.' });
  }
  const honeypot = body.website != null && body.website !== false && String(body.website).trim();
  let receiptId = newId();
  if (!honeypot) {
    const [saved] = await sql(`INSERT INTO finding_feedback (id,report_id,target_host,finding_id,user_id,voter_key,verdict,note)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (report_id,finding_id,voter_key)
      DO UPDATE SET verdict=EXCLUDED.verdict,note=EXCLUDED.note,user_id=EXCLUDED.user_id,updated_at=now() RETURNING id`,
    [receiptId, id, host, findingId, req.user?.id || null, voter, verdict, note || null]);
    receiptId = saved.id;
  }
  const state = await loadFeedback(id, voter);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ findingId, ...(state.findings[findingId] || { right: 0, wrong: 0, notes: [] }), mine: state.mine[findingId] || null,
    received: true, receipt: { id: receiptId, status: 'received' }, policy: FEEDBACK_POLICY });
}));

feedbackRouter.get('/api/feedback/review-queue', requireAdmin, needDb, safe(async (req, res) => {
  const limit = req.query.limit == null ? 50 : Number(req.query.limit);
  const offset = req.query.offset == null ? 0 : Number(req.query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0 || offset > 100000) return res.status(400).json({ error: 'Use a limit from 1 to 200 and a nonnegative offset.' });
  res.setHeader('Cache-Control', 'private, no-store');
  res.json(await reviewQueue({ limit, offset }));
}));

feedbackRouter.post('/api/reports/:id/feedback/review', requireAdmin, needDb, safe(async (req, res) => {
  const id = req.params.id;
  const body = req.body || {};
  if (!ID_RE.test(id) || !validFindingId(body.findingId)) return res.status(400).json({ error: 'Please identify an existing report and finding.' });
  if (!REVIEW_STATUSES.includes(body.status)) return res.status(400).json({ error: 'Review status must be confirmed, incorrect, or inconclusive.' });
  const reason = typeof body.reason === 'string' ? cleanText(body.reason) : '';
  if (reason.length < 20 || reason.length > 2000 || reason.split(/\s+/).length < 4) return res.status(400).json({ error: 'Explain the evidence for the review in at least 20 characters and four words, up to 2,000 characters. This explanation will be public.' });
  const row = await loadReport(id);
  if (!row) return res.status(404).json({ error: 'We could not find that checkup.' });
  const finding = (Array.isArray(row.report.findings) ? row.report.findings : []).find((f) => f?.id === body.findingId.trim());
  if (!finding || body.findingId.trim() === REPORT_LEVEL) return res.status(400).json({ error: 'Reviews apply to individual findings in this checkup.' });
  const limit = consume('feedback-review', digest(req.user.id), 60, HOUR);
  if (!limit.ok) return res.status(429).json({ error: 'Many reviews were submitted recently. Please wait before submitting another.' });
  const review = await appendReview({ report: row.report, finding, status: body.status, reason, reviewerId: req.user.id });
  res.status(201).json({ review });
}));

feedbackRouter.get('/api/feedback/progress', needDb, safe(async (_req, res) => { res.json(await feedbackProgress()); }));
feedbackRouter.get('/api/feedback/evaluation-cases', requireAdmin, needDb, safe(async (_req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.json(await evaluationCases());
}));

// Compatibility summary, with private notes available only to admins.
feedbackRouter.get('/api/feedback/summary', requireAdmin, needDb, safe(async (_req, res) => {
  const since = new Date(Date.now() - 90 * 24 * HOUR);
  const rows = await sql(`SELECT finding_id,count(*) FILTER (WHERE verdict='wrong')::int AS wrong,
    count(*) FILTER (WHERE verdict='right')::int AS right,count(DISTINCT target_host)::int AS hosts
    FROM finding_feedback WHERE updated_at >= $1 GROUP BY finding_id ORDER BY wrong DESC,right DESC,finding_id`, [since]);
  const notes = await sql(`SELECT * FROM (SELECT finding_id,target_host,note,updated_at,
    row_number() OVER (PARTITION BY finding_id ORDER BY updated_at DESC,id) AS n FROM finding_feedback
    WHERE updated_at >= $1 AND verdict='wrong' AND note IS NOT NULL AND note<>'') ranked WHERE n<=3`, [since]);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ since: since.toISOString(), findings: rows.map((row) => ({ findingId: row.finding_id, wrong: row.wrong, right: row.right, hosts: row.hosts,
    latestNotes: notes.filter((note) => note.finding_id === row.finding_id).map((note) => ({ host: note.target_host, text: note.note, when: new Date(note.updated_at).toISOString() })) })) });
}));

export async function disputesForHost(host, { sinceDays = 90 } = {}) {
  const out = new Map();
  const normalized = normHost(host);
  if (!normalized || !dbEnabled()) return out;
  const days = Math.max(1, Math.min(3650, Math.floor(Number(sinceDays)) || 90));
  const rows = await sql(`SELECT finding_id,verdict,count(*)::int AS n FROM finding_feedback
    WHERE target_host=$1 AND updated_at >= $2 GROUP BY finding_id,verdict`, [normalized, new Date(Date.now() - days * 24 * HOUR)]);
  for (const row of rows) {
    if (!out.has(row.finding_id)) out.set(row.finding_id, { right: 0, wrong: 0, notes: [] });
    out.get(row.finding_id)[row.verdict] = row.n;
  }
  return out;
}
