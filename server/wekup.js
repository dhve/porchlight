// wekup conversations: a signed-in reader talks privately about one finding of a
// saved checkup. Each turn is a durable job. A challenge is re-measured through
// the addresses recorded in the finding, never through anything in the chat, and
// the result is appended as an assessment beside the untouched signed report.
// Reader words are untrusted data; the model can explain and classify, not decide.
import express from 'express';
import { randomBytes } from 'node:crypto';
import { sql, dbEnabled, newId } from './db.js';
import { requireVerified } from './auth.js';
import { consume } from './ratelimit.js';
import { llmEnabled, chatJSON } from './llm.js';
import { observeRecordedAddress } from './retest.js';
import { accountVoterKey } from './feedback.js';
import { enqueueFeedbackCase } from './feedbackAuto.js';
import { mergeLessons } from './feedbackAnalysis.js';
import { observeRecordedPage, siteOptedOut } from './wekupBrowser.js';
import { classifyIntent, requestsRecheck, verificationPlan, assessAvailability, assessPage, ruleLessonsFor, buildTurnPrompt, validateModelTurn, composeReply, publicAssessment, SUMMARIES, MAX_TURNS_IN_PROMPT } from './wekupTurn.js';

const ID_RE = /^[A-Za-z0-9_-]{6,20}$/;
const REQUEST_RE = /^[A-Za-z0-9_-]{1,128}$/;
const REPORT_LEVEL = '_report';
const HOUR = 3600000;
const MAX_MESSAGE = 1600;
const HISTORY = 30;
const JOB_ERROR = 'The check could not be completed. Please try again later.';
const STAGES = Object.freeze({ queued: 'Waiting to start', reading: 'Reading the saved finding', http: 'Checking the recorded addresses', page: 'Opening the recorded page in a browser', writing: 'Writing the reply', done: 'Done' });
export const DEFAULTS = Object.freeze({
  leaseMs: 5 * 60_000, maxAttempts: 3, retryDelayMs: 2 * 60_000, turnsPerHour: 12,
  budget: Object.freeze({ globalPerDay: 300, hostPerDay: 20, accountPerDay: 30 }), maxPerTick: 3,
});

const iso = (v) => (v == null ? null : new Date(v).toISOString());
const normHost = (host) => String(host || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
const cleanText = (v) => String(v == null ? '' : v).replace(/\r\n?|[\u2028\u2029]/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '').trim();
const errorCode = (err) => String(err?.code || err?.name || 'error').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'error';
const dayOf = (date) => date.toISOString().slice(0, 10);

export async function ensureWekupSchema() {
  if (!dbEnabled()) return false;
  const [feedback] = await sql("SELECT to_regclass('finding_feedback') AS name");
  if (!feedback?.name) throw new Error('The finding_feedback table must exist before the wekup schema is initialized.');
  await sql(`CREATE TABLE IF NOT EXISTS wekup_conversations (
    id TEXT PRIMARY KEY, report_id TEXT NOT NULL, finding_id TEXT NOT NULL, user_id TEXT NOT NULL, target_host TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (report_id, finding_id, user_id)
  )`);
  await sql(`CREATE TABLE IF NOT EXISTS wekup_messages (
    id TEXT PRIMARY KEY, sequence BIGSERIAL UNIQUE NOT NULL, conversation_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user','assistant')), text TEXT NOT NULL, request_id TEXT,
    verdict TEXT CHECK (verdict IN ('right','wrong')), intent TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (conversation_id, request_id)
  )`);
  await sql('CREATE INDEX IF NOT EXISTS wekup_messages_conversation_idx ON wekup_messages (conversation_id, sequence)');
  await sql(`CREATE TABLE IF NOT EXISTS wekup_jobs (
    message_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','processing','completed','failed')), stage TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, claim_token TEXT, lease_until TIMESTAMPTZ, next_run_at TIMESTAMPTZ NOT NULL,
    error_code TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await sql('CREATE INDEX IF NOT EXISTS wekup_jobs_due_idx ON wekup_jobs (status, next_run_at)');
  await sql(`CREATE UNIQUE INDEX IF NOT EXISTS wekup_jobs_active_idx ON wekup_jobs (conversation_id) WHERE status IN ('queued','processing')`);
  await sql(`CREATE TABLE IF NOT EXISTS wekup_assessments (
    id TEXT PRIMARY KEY, sequence BIGSERIAL UNIQUE NOT NULL, report_id TEXT NOT NULL, finding_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('supported','not-reproduced','inconclusive','unsupported')),
    summary_code TEXT NOT NULL, method_code TEXT NOT NULL, evidence JSONB NOT NULL, lesson_ids TEXT[] NOT NULL,
    checked_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await sql('CREATE INDEX IF NOT EXISTS wekup_assessments_finding_idx ON wekup_assessments (report_id, finding_id, checked_at DESC)');
  await sql(`CREATE TABLE IF NOT EXISTS wekup_budget (day TEXT NOT NULL, scope TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, scope))`);
  return true;
}

// ---- storage helpers ----
async function loadReport(id) {
  const [row] = await sql('SELECT report, target_host FROM reports WHERE id=$1', [id]);
  return row ? { report: { ...row.report, id }, host: normHost(row.target_host || row.report?.target) } : null;
}
function findingOf(report, findingId) {
  if (findingId === REPORT_LEVEL) return { id: REPORT_LEVEL, title: 'This checkup as a whole', evidence: { lines: [] } };
  return (Array.isArray(report?.findings) ? report.findings : []).find((f) => f?.id === findingId) || null;
}
async function latestAssessments(reportId) {
  return sql(`SELECT DISTINCT ON (finding_id) * FROM wekup_assessments WHERE report_id=$1 ORDER BY finding_id, checked_at DESC, sequence DESC`, [reportId]);
}
async function conversationState({ reportId, findingId, userId }) {
  const [conv] = await sql('SELECT * FROM wekup_conversations WHERE report_id=$1 AND finding_id=$2 AND user_id=$3', [reportId, findingId, userId]);
  const [assessmentRow] = await sql(`SELECT * FROM wekup_assessments WHERE report_id=$1 AND finding_id=$2 ORDER BY checked_at DESC, sequence DESC LIMIT 1`, [reportId, findingId]);
  const assessment = assessmentRow ? publicAssessment(assessmentRow) : null;
  if (!conv) return { conversationId: null, reportId, findingId, revision: 0, messages: [], job: null, assessment };
  const messages = (await sql('SELECT id, role, text, created_at FROM wekup_messages WHERE conversation_id=$1 ORDER BY sequence DESC LIMIT $2', [conv.id, HISTORY])).reverse();
  const [job] = await sql('SELECT status, stage FROM wekup_jobs WHERE conversation_id=$1 ORDER BY created_at DESC, message_id DESC LIMIT 1', [conv.id]);
  return {
    conversationId: conv.id, reportId, findingId, revision: conv.revision,
    messages: messages.map((m) => ({ id: m.id, role: m.role, text: m.text, createdAt: iso(m.created_at) })),
    job: job ? { status: job.status, stage: job.stage, ...(job.status === 'failed' ? { error: JOB_ERROR } : {}) } : null,
    assessment,
  };
}

// ---- routes ----
export const wekupRouter = express.Router();
function needDb(_req, res, next) { if (!dbEnabled()) return res.status(503).json({ error: 'Conversations are unavailable because the database is not configured.' }); next(); }
function safe(handler) {
  return (req, res) => Promise.resolve(handler(req, res)).catch((err) => {
    if (!res.headersSent) { console.error('wekup: request failed (' + errorCode(err) + ')'); res.status(500).json({ error: 'The conversation could not be loaded right now. Please try again later.' }); }
  });
}
const validFindingId = (v) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= 120 && !/[\u0000-\u001F\u007F-\u009F]/.test(v);
async function resolveCase(req, res, findingIdRaw) {
  const id = String(req.params.id || '');
  if (!ID_RE.test(id)) { res.status(400).json({ error: 'Bad report id.' }); return null; }
  if (!validFindingId(findingIdRaw)) { res.status(400).json({ error: 'Please say which finding this is about.' }); return null; }
  const loaded = await loadReport(id);
  if (!loaded) { res.status(404).json({ error: 'We could not find that checkup.' }); return null; }
  const findingId = findingIdRaw.trim();
  const finding = findingOf(loaded.report, findingId);
  if (!finding) { res.status(400).json({ error: 'That finding is not part of this checkup.' }); return null; }
  if (!loaded.host) { res.status(400).json({ error: 'This checkup has no website to talk about.' }); return null; }
  return { reportId: id, findingId, finding, ...loaded };
}

wekupRouter.get('/api/reports/:id/wekup', requireVerified, needDb, safe(async (req, res) => {
  const c = await resolveCase(req, res, typeof req.query.findingId === 'string' ? req.query.findingId : '');
  if (!c) return;
  res.setHeader('Cache-Control', 'private, no-store');
  res.json(await conversationState({ reportId: c.reportId, findingId: c.findingId, userId: req.user.id }));
}));

wekupRouter.post('/api/reports/:id/wekup', requireVerified, needDb, safe(async (req, res) => {
  const body = req.body || {};
  const c = await resolveCase(req, res, body.findingId);
  if (!c) return;
  if (typeof body.requestId !== 'string' || !REQUEST_RE.test(body.requestId)) return res.status(400).json({ error: 'Each message needs a request id.' });
  if (typeof body.message !== 'string') return res.status(400).json({ error: 'The message must be plain text.' });
  const message = cleanText(body.message);
  if (!message.length || message.length > MAX_MESSAGE) return res.status(400).json({ error: 'Please write between 1 and 1,600 characters.' });
  let verdict = null;
  if (body.verdict != null) {
    verdict = typeof body.verdict === 'string' ? body.verdict.trim().toLowerCase() : '';
    if (!['right', 'wrong'].includes(verdict)) return res.status(400).json({ error: 'The answer must be right or wrong.' });
  }
  const userId = req.user.id;
  const state = () => conversationState({ reportId: c.reportId, findingId: c.findingId, userId });
  await sql(`INSERT INTO wekup_conversations (id, report_id, finding_id, user_id, target_host) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (report_id, finding_id, user_id) DO NOTHING`,
    [newId(), c.reportId, c.findingId, userId, c.host]);
  const [conv] = await sql('SELECT id FROM wekup_conversations WHERE report_id=$1 AND finding_id=$2 AND user_id=$3', [c.reportId, c.findingId, userId]);
  res.setHeader('Cache-Control', 'private, no-store');
  const [repeat] = await sql('SELECT id FROM wekup_messages WHERE conversation_id=$1 AND request_id=$2', [conv.id, body.requestId]);
  if (repeat) return res.status(202).json(await state());
  const limit = consume('wekup-turns', userId, DEFAULTS.turnsPerHour, HOUR);
  if (!limit.ok) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))));
    return res.status(429).json({ error: 'You have sent many messages this hour. Please wait a little before the next one.' });
  }
  let queued;
  try {
    // The message, its job, and the revision bump are one statement, so a crash cannot
    // leave a turn without its job. The partial unique index refuses a second active turn.
    [queued] = await sql(`WITH m AS (INSERT INTO wekup_messages (id, conversation_id, role, text, request_id, verdict) VALUES ($1,$2,'user',$3,$4,$5) RETURNING id),
      j AS (INSERT INTO wekup_jobs (message_id, conversation_id, status, stage, attempts, next_run_at) SELECT id, $2, 'queued', $6, 0, now() FROM m RETURNING message_id)
      UPDATE wekup_conversations SET revision = revision + 1, updated_at = now() WHERE id=$2 AND EXISTS (SELECT 1 FROM j) RETURNING revision`,
    [newId(), conv.id, message, body.requestId, verdict, STAGES.queued]);
  } catch (err) {
    if (err?.code === '23505') return res.status(409).json({ error: 'This conversation is still working on your last message. Please wait a moment and try again.' });
    throw err;
  }
  if (!queued) return res.status(409).json({ error: 'This conversation is still working on your last message. Please wait a moment and try again.' });
  res.status(202).json(await state());
}));

wekupRouter.get('/api/reports/:id/assessments', needDb, safe(async (req, res) => {
  const id = String(req.params.id || '');
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'Bad report id.' });
  if (!(await loadReport(id))) return res.status(404).json({ error: 'We could not find that checkup.' });
  const assessments = Object.create(null);
  for (const row of await latestAssessments(id)) assessments[row.finding_id] = publicAssessment(row);
  res.json({ assessments });
}));

// ---- the worker ----
async function claim({ now, leaseMs, maxAttempts }) {
  const at = now();
  await sql(`UPDATE wekup_jobs SET status='failed', claim_token=NULL, lease_until=NULL, error_code=COALESCE(error_code,'attempts-exhausted'), updated_at=$1
    WHERE attempts >= $2 AND ((status='queued' AND next_run_at <= $1) OR (status='processing' AND lease_until < $1))`, [at, maxAttempts]);
  const token = randomBytes(12).toString('base64url');
  const [row] = await sql(`UPDATE wekup_jobs j SET status='processing', claim_token=$1, lease_until=$2, attempts=j.attempts+1, stage=$5, updated_at=$3
    WHERE j.message_id = (SELECT message_id FROM wekup_jobs WHERE attempts < $4 AND ((status='queued' AND next_run_at <= $3) OR (status='processing' AND lease_until < $3))
      ORDER BY next_run_at, created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING j.*`, [token, new Date(at.getTime() + leaseMs), at, maxAttempts, STAGES.reading]);
  return row ? { ...row, token } : null;
}
async function setStage(job, stage, now) {
  await sql('UPDATE wekup_jobs SET stage=$3, updated_at=$4 WHERE message_id=$1 AND claim_token=$2', [job.message_id, job.token, stage, now()]).catch(() => {});
}
async function release(job, { status, now, nextRunAt = null, error = null }) {
  await sql(`UPDATE wekup_jobs SET status=$4, claim_token=NULL, lease_until=NULL, next_run_at=COALESCE($5, next_run_at), error_code=$6, stage=$7, updated_at=$8
    WHERE message_id=$1 AND claim_token=$3 AND conversation_id=$2`, [job.message_id, job.conversation_id, job.token, status, nextRunAt, error, status === 'failed' ? STAGES.done : STAGES.queued, now()]);
  await sql('UPDATE wekup_conversations SET revision = revision + 1, updated_at=$2 WHERE id=$1', [job.conversation_id, now()]).catch(() => {});
}
async function takeUnit(day, scope, cap) {
  await sql('INSERT INTO wekup_budget (day,scope,used) VALUES ($1,$2,0) ON CONFLICT (day,scope) DO NOTHING', [day, scope]);
  return (await sql('UPDATE wekup_budget SET used=used+1 WHERE day=$1 AND scope=$2 AND used < $3 RETURNING used', [day, scope, cap])).length > 0;
}
// One unit is one turn that visits the site or calls the model. Each scope is a
// conditional increment, so concurrent workers cannot exceed a cap; taken units are
// returned when a later scope refuses.
async function reserveUnit({ now, budget, host, userId }) {
  const day = dayOf(now());
  const scopes = [['global', budget?.globalPerDay], ['host:' + host, budget?.hostPerDay], ['account:' + accountVoterKey(userId).slice(8, 40), budget?.accountPerDay]];
  const taken = [];
  for (const [scope, cap] of scopes) {
    if (await takeUnit(day, scope, Math.max(0, Math.floor(Number(cap)) || 0))) { taken.push(scope); continue; }
    for (const s of taken) await sql('UPDATE wekup_budget SET used=GREATEST(0, used-1) WHERE day=$1 AND scope=$2', [day, s]);
    return false;
  }
  return true;
}
const voteFor = (intent, verdict) => verdict || (intent === 'challenge' ? 'wrong' : intent === 'agreement' ? 'right' : null);
const defaultModel = () => (llmEnabled() ? (prompt) => chatJSON({ system: prompt.system, user: prompt.user, temperature: 0.3, maxTokens: 700 }) : null);
const recordedUrls = (finding, plan) => [...new Set([...(plan.addresses || []), plan.page, ...((finding?.evidence?.pages) || []), ...((finding?.evidence?.items) || []).map((i) => i?.url)].filter((u) => typeof u === 'string'))];
const EMPTY_MODEL = Object.freeze({ intent: null, lessons: [], reply: '' });

/**
 * Claim and process at most one turn. Injected boundaries: `observer(url)` for HTTP
 * answers, `observePage({url, view, siteHost, images})` for the browser visit,
 * `model(prompt)` for the private reply (at most two calls per turn), `optOut(host)`,
 * and `now()`. The vote, the reply, the assessment, and the job status are written in
 * one claim-guarded statement, so a stale worker changes nothing.
 */
export async function processWekupJob(options = {}) {
  const { now = () => new Date(), observer = observeRecordedAddress, observePage = observeRecordedPage, model = defaultModel(), optOut = siteOptedOut,
    leaseMs = DEFAULTS.leaseMs, maxAttempts = DEFAULTS.maxAttempts, retryDelayMs = DEFAULTS.retryDelayMs, budget = DEFAULTS.budget } = options;
  if (!dbEnabled()) return { result: 'idle', reason: 'no-database' };
  const job = await claim({ now, leaseMs, maxAttempts });
  if (!job) return { result: 'idle' };
  const base = { conversationId: job.conversation_id, messageId: job.message_id, attempts: job.attempts };
  try {
    const [conv] = await sql('SELECT * FROM wekup_conversations WHERE id=$1', [job.conversation_id]);
    const [message] = await sql('SELECT * FROM wekup_messages WHERE id=$1', [job.message_id]);
    if (!conv || !message) return supersede(job, base, now);
    const loaded = await loadReport(conv.report_id);
    const report = loaded?.report || null;
    const finding = report ? findingOf(report, conv.finding_id) : null;
    const plan = verificationPlan(finding);
    let unitTaken = false, modelCalls = 0;
    const askModel = async (verification) => {
      if (typeof model !== 'function' || modelCalls >= 2) return EMPTY_MODEL;
      if (!unitTaken && !(unitTaken = await reserveUnit({ now, budget, host: conv.target_host, userId: conv.user_id }))) return EMPTY_MODEL;
      modelCalls++;
      const history = (await sql('SELECT role, text FROM wekup_messages WHERE conversation_id=$1 ORDER BY sequence DESC LIMIT $2', [conv.id, MAX_TURNS_IN_PROMPT])).reverse();
      try { return validateModelTurn(await model(buildTurnPrompt({ finding, turns: history, verification, report })), { allowedUrls: recordedUrls(finding, plan) }); }
      catch { return EMPTY_MODEL; }
    };

    // Intent: the reader's verdict or plain words first; when they leave it open, one
    // model call may recognise a challenge or agreement before anything is measured.
    let intent = classifyIntent({ message: message.text, verdict: message.verdict });
    let modelOut = EMPTY_MODEL;
    if (intent === 'question' && !message.verdict) {
      const first = await askModel(null);
      if (first.intent && first.intent !== 'question') intent = first.intent; else modelOut = first;
    }
    const voteVerdict = voteFor(intent, message.verdict);

    // Verification: for a challenge, a recheck request, or an agreement that also asks to
    // check again; only through what the finding recorded.
    let verification = null, assessment = null, reason = null, methodCode = 'none', observedAt = null;
    if (intent === 'challenge' || intent === 'recheck' || (intent === 'agreement' && requestsRecheck(message.text))) {
      if (plan.kind === 'none') reason = 'none';
      else if (await optOut(conv.target_host)) reason = 'opted-out';
      else if (plan.unsupported || plan.unknownEvidence) { assessment = assessAvailability({ unsupported: plan.unsupported, unknownEvidence: plan.unknownEvidence }); methodCode = 'http'; observedAt = now(); }
      else if (!unitTaken && !(unitTaken = await reserveUnit({ now, budget, host: conv.target_host, userId: conv.user_id }))) reason = 'budget';
      else if (plan.kind === 'availability') {
        await setStage(job, STAGES.http, now);
        const observations = [];
        for (const url of plan.addresses) observations.push(await observer(url));
        observedAt = now();
        assessment = assessAvailability({ observations });
        methodCode = 'http';
      } else {
        await setStage(job, STAGES.page, now);
        const observation = await observePage({ url: plan.page, view: plan.view, siteHost: conv.target_host, images: plan.images });
        observedAt = now();
        assessment = assessPage({ plan, observation });
        methodCode = 'page-' + (plan.view || 'phone');
      }
      if (assessment) verification = { ...assessment, summary: SUMMARIES[assessment.summaryCode], limits: assessment.limits || [] };
    }

    // The private reply, written after the facts are known. The model can only classify,
    // pick catalog ids, and write words; nothing it says becomes a fact or a status.
    await setStage(job, STAGES.writing, now);
    if (intent !== 'question' && !modelOut.reply) modelOut = await askModel(verification);
    const lessons = mergeLessons(ruleLessonsFor({ intent, kind: plan.kind, status: assessment?.status || null, findingId: conv.finding_id, claim: plan.claim }), modelOut.lessons);
    const reply = composeReply({ intent, finding, verification, modelReply: modelOut.reply, reason, report });

    // Publish only while the claim is still ours: job, vote, reply, assessment, and revision in one statement.
    const p = [];
    const add = (v) => { p.push(v); return '$' + p.length; };
    const [pMessage, pToken, pConv, pNow, pDone] = [job.message_id, job.token, conv.id, now(), STAGES.done].map(add);
    let sqlText = `WITH done AS (UPDATE wekup_jobs SET status='completed', stage=${pDone}, claim_token=NULL, lease_until=NULL, error_code=NULL, updated_at=${pNow}
        WHERE message_id=${pMessage} AND claim_token=${pToken} RETURNING message_id),
      m AS (INSERT INTO wekup_messages (id, conversation_id, role, text, intent, created_at) SELECT ${add(newId())}, ${pConv}, 'assistant', ${add(reply)}, ${add(intent)}, ${pNow} FROM done RETURNING id)`;
    if (voteVerdict) {
      sqlText += `, v AS (INSERT INTO finding_feedback (id,report_id,target_host,finding_id,user_id,voter_key,verdict,note)
        SELECT ${add(newId())}, ${add(conv.report_id)}, ${add(conv.target_host)}, ${add(conv.finding_id)}, ${add(conv.user_id)}, ${add(accountVoterKey(conv.user_id))}, ${add(voteVerdict)}, ${add(message.text.slice(0, 400) || null)} FROM done
        ON CONFLICT (report_id,finding_id,voter_key) DO UPDATE SET verdict=EXCLUDED.verdict, note=EXCLUDED.note, user_id=EXCLUDED.user_id, updated_at=now() RETURNING id)`;
    }
    if (assessment) {
      sqlText += `, a AS (INSERT INTO wekup_assessments (id, report_id, finding_id, conversation_id, status, summary_code, method_code, evidence, lesson_ids, checked_at, created_at)
        SELECT ${add(newId())}, ${add(conv.report_id)}, ${add(conv.finding_id)}, ${pConv}, ${add(assessment.status)}, ${add(assessment.summaryCode)}, ${add(methodCode)}, ${add(JSON.stringify(assessment.evidence || []))}::jsonb, ${add(lessons)}::text[], ${add(observedAt || now())}, ${pNow} FROM done RETURNING id)`;
    }
    sqlText += ` UPDATE wekup_conversations SET revision = revision + 1, updated_at=${pNow} WHERE id=${pConv} AND EXISTS (SELECT 1 FROM m) RETURNING revision`;
    const published = await sql(sqlText, p);
    if (!published.length) return { ...base, result: 'superseded' };
    if (voteVerdict) await enqueueFeedbackCase(conv.report_id, conv.finding_id).catch(() => console.error('wekup: feedback queue reconciliation deferred'));
    return { ...base, result: 'processed', intent, vote: voteVerdict, modelCalls, assessment: assessment ? { status: assessment.status, summaryCode: assessment.summaryCode } : null, lessons };
  } catch (err) {
    const code = errorCode(err);
    if (job.attempts >= maxAttempts) { await release(job, { status: 'failed', now, error: code }); return { ...base, result: 'failed', error: code }; }
    await release(job, { status: 'queued', now, nextRunAt: new Date(now().getTime() + retryDelayMs * job.attempts), error: code });
    return { ...base, result: 'retry', error: code };
  }
}
async function supersede(job, base, now) {
  await sql(`UPDATE wekup_jobs SET status='failed', claim_token=NULL, lease_until=NULL, error_code='missing-turn', stage=$3, updated_at=$4 WHERE message_id=$1 AND claim_token=$2`, [job.message_id, job.token, STAGES.done, now()]);
  return { ...base, result: 'superseded' };
}

/** Turns whose job was lost (a crash between statements in an older release, or a deleted row) get a job again. */
export async function recoverWekupTurns({ now = () => new Date() } = {}) {
  if (!dbEnabled()) return 0;
  const rows = await sql(`INSERT INTO wekup_jobs (message_id, conversation_id, status, stage, attempts, next_run_at, created_at, updated_at)
    SELECT m.id, m.conversation_id, 'queued', $1, 0, $2, $2, $2 FROM wekup_messages m
    WHERE m.role='user'
      AND NOT EXISTS (SELECT 1 FROM wekup_jobs j WHERE j.message_id=m.id)
      AND NOT EXISTS (SELECT 1 FROM wekup_jobs j WHERE j.conversation_id=m.conversation_id AND j.status IN ('queued','processing'))
      AND NOT EXISTS (SELECT 1 FROM wekup_messages r WHERE r.conversation_id=m.conversation_id AND r.sequence > m.sequence)
    ON CONFLICT DO NOTHING RETURNING message_id`, [STAGES.queued, now()]);
  return rows.length;
}

// Bounded polling. Nothing starts on import; index.js starts one worker per process.
export function startWekupWorker({ intervalMs = 3000, maxPerTick = DEFAULTS.maxPerTick, ...deps } = {}) {
  let stopped = false, running = null, timer = null;
  const tick = async () => {
    if (stopped) return { recovered: 0, processed: 0, results: [] };
    if (running) return running;
    running = (async () => {
      const summary = { recovered: 0, processed: 0, results: [] };
      try {
        summary.recovered = await recoverWekupTurns({ now: deps.now });
        for (let i = 0; i < maxPerTick && !stopped; i++) {
          const result = await processWekupJob(deps);
          if (result.result === 'idle') break;
          summary.results.push(result);
          if (result.result === 'processed') summary.processed++;
        }
      } catch (err) { console.error('wekup worker: tick failed (' + errorCode(err) + ')'); }
      finally { running = null; }
      return summary;
    })();
    return running;
  };
  timer = setInterval(() => { tick().catch(() => {}); }, Math.max(250, intervalMs));
  timer.unref?.();
  tick().catch(() => {});
  return { tick, async stop() { stopped = true; clearInterval(timer); if (running) await running.catch(() => {}); } };
}
