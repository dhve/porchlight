// Automatic feedback processing. Reader answers enter a persistent queue, are
// re-measured where a recorded HTTP address allows it, and are turned into fixed
// verification lessons for later checkups. Signed reports are never rewritten;
// human reviews remain separate, optional records. Notes stay private: the only
// place they travel is a bounded, delimited model prompt with no identity.
import { randomBytes } from 'node:crypto';
import { sql, dbEnabled, newId } from './db.js';
import { llmEnabled, chatJSON } from './llm.js';
import { observeRecordedAddress } from './retest.js';
import { publicGuidance, LESSON_CATALOG } from './feedbackLessons.js';
import { feedbackRevision, summarizeFeedback, planCase, availabilityOutcome, ruleLessons, validateModelLessons, buildModelPrompt, mergeLessons, summaryFor } from './feedbackAnalysis.js';

const REPORT_LEVEL = '_report';
const DAY = 24 * 3600000;
const STATUSES = ['queued', 'processing', 'processed', 'failed'];
const OUTCOMES = ['unsupported', 'reproduced', 'different-now', 'inconclusive', 'feedback-only'];
export const DEFAULTS = Object.freeze({
  leaseMs: 5 * 60_000, // beyond two 8-second requests with five redirect hops each plus one 90-second model call
  maxAttempts: 3,
  retryDelayMs: 2 * 60_000,
  lessonDays: 90,
  generalHosts: 3,
  generalAccounts: 3,
  budget: Object.freeze({ globalPerDay: 200, hostPerDay: 12 }),
  reconcileLimit: 200,
  maxPerTick: 5,
});

const iso = (value) => (value == null ? null : new Date(value).toISOString());
const normHost = (host) => String(host || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
const dayOf = (date) => date.toISOString().slice(0, 10);
const nextDay = (date) => new Date(Date.parse(dayOf(date) + 'T00:00:00.000Z') + DAY);
// Only short fixed codes are stored about failures; messages may carry addresses or secrets.
const errorCode = (err) => String(err?.code || err?.name || 'error').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'error';

export async function ensureAutoFeedbackSchema() {
  if (!dbEnabled()) return false;
  const [existing] = await sql("SELECT to_regclass('finding_feedback') AS name");
  if (!existing?.name) throw new Error('The finding_feedback table must exist before the automatic feedback schema is initialized.');
  await sql(`CREATE TABLE IF NOT EXISTS feedback_auto_jobs (
    report_id TEXT NOT NULL, finding_id TEXT NOT NULL, target_host TEXT NOT NULL,
    revision TEXT NOT NULL, feedback_seen_at TIMESTAMPTZ,
    status TEXT NOT NULL CHECK (status IN ('queued','processing','processed','failed')),
    attempts INTEGER NOT NULL DEFAULT 0, claim_token TEXT, lease_until TIMESTAMPTZ,
    next_run_at TIMESTAMPTZ NOT NULL, last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (report_id, finding_id)
  )`);
  await sql('CREATE INDEX IF NOT EXISTS feedback_auto_jobs_due_idx ON feedback_auto_jobs (status, next_run_at)');
  await sql('CREATE INDEX IF NOT EXISTS feedback_auto_jobs_host_idx ON feedback_auto_jobs (target_host)');
  await sql(`CREATE TABLE IF NOT EXISTS feedback_auto_results (
    id TEXT PRIMARY KEY, sequence BIGSERIAL UNIQUE NOT NULL,
    report_id TEXT NOT NULL, finding_id TEXT NOT NULL, target_host TEXT NOT NULL, revision TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('unsupported','reproduced','different-now','inconclusive','feedback-only')),
    summary_code TEXT NOT NULL, lesson_ids TEXT[] NOT NULL, evidence JSONB NOT NULL,
    method TEXT NOT NULL, network_requests INTEGER NOT NULL DEFAULT 0, model_calls INTEGER NOT NULL DEFAULT 0,
    processed_at TIMESTAMPTZ NOT NULL
  )`);
  await sql('CREATE INDEX IF NOT EXISTS feedback_auto_results_case_idx ON feedback_auto_results (report_id, finding_id, sequence DESC)');
  await sql('CREATE INDEX IF NOT EXISTS feedback_auto_results_host_idx ON feedback_auto_results (target_host, processed_at DESC)');
  await sql(`CREATE TABLE IF NOT EXISTS feedback_auto_budget (
    day TEXT NOT NULL, scope TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, scope)
  )`);
  return true;
}

// The same content digest as feedbackRevision() in feedbackAnalysis.js, computed by
// the database inside the statement that uses it, so a queue revision and a
// publication guard always describe one consistent snapshot of the feedback rows.
const REVISION_SQL = `encode(sha256(convert_to(coalesce(string_agg(voter_key||E'\\x1F'||verdict||E'\\x1F'||coalesce(note,''), E'\\x1E' ORDER BY voter_key COLLATE "C"), ''), 'UTF8')), 'hex')`;
const CASE_SQL = (where) => `SELECT ${REVISION_SQL} AS revision, max(updated_at) AS seen_at, count(*)::int AS n FROM finding_feedback ${where}`;

async function feedbackRows(reportId, findingId) {
  return sql('SELECT voter_key, verdict, note, user_id FROM finding_feedback WHERE report_id=$1 AND finding_id=$2 ORDER BY voter_key COLLATE "C"', [reportId, findingId]);
}
async function loadReport(reportId) {
  const [row] = await sql('SELECT report, target_host FROM reports WHERE id=$1', [reportId]);
  return row ? { report: { ...row.report, id: reportId }, host: normHost(row.target_host || row.report?.target) } : null;
}

// Parameters: $1 report id, $2 finding id, $3 host, $4 timestamp, $5 force. The
// revision and the snapshot marker come from the rows this statement sees. A route
// enqueue ($5 false) touches an existing job only when its snapshot is at least as
// new as the one the job holds, so a delayed enqueue cannot overwrite a newer
// revision with an older one. Reconciliation ($5 true) has already compared content
// against the queue, so it applies regardless of timestamps: a row that committed
// late with an older timestamp is still brought in. Identical content leaves the job
// as it is; changed content resets it to queued and clears any claim, so a worker
// still holding the old revision cannot publish.
export const ENQUEUE_SQL = `INSERT INTO feedback_auto_jobs (report_id,finding_id,target_host,revision,feedback_seen_at,status,attempts,next_run_at,created_at,updated_at)
  SELECT $1,$2,$3,${REVISION_SQL},max(updated_at),'queued',0,$4,$4,$4 FROM finding_feedback WHERE report_id=$1 AND finding_id=$2 HAVING count(*)>0
  ON CONFLICT (report_id,finding_id) DO UPDATE SET
    feedback_seen_at=EXCLUDED.feedback_seen_at,
    revision=EXCLUDED.revision,
    status=CASE WHEN feedback_auto_jobs.revision=EXCLUDED.revision THEN feedback_auto_jobs.status ELSE 'queued' END,
    attempts=CASE WHEN feedback_auto_jobs.revision=EXCLUDED.revision THEN feedback_auto_jobs.attempts ELSE 0 END,
    claim_token=CASE WHEN feedback_auto_jobs.revision=EXCLUDED.revision THEN feedback_auto_jobs.claim_token ELSE NULL END,
    lease_until=CASE WHEN feedback_auto_jobs.revision=EXCLUDED.revision THEN feedback_auto_jobs.lease_until ELSE NULL END,
    next_run_at=CASE WHEN feedback_auto_jobs.revision=EXCLUDED.revision THEN feedback_auto_jobs.next_run_at ELSE EXCLUDED.next_run_at END,
    last_error=CASE WHEN feedback_auto_jobs.revision=EXCLUDED.revision THEN feedback_auto_jobs.last_error ELSE NULL END,
    updated_at=EXCLUDED.updated_at
  WHERE $5::boolean OR feedback_auto_jobs.feedback_seen_at IS NULL OR feedback_auto_jobs.feedback_seen_at <= EXCLUDED.feedback_seen_at
  RETURNING status, revision`;

// Reconcile one case with the current content of its feedback.
export async function enqueueFeedbackCase(reportId, findingId, { now = () => new Date(), force = false } = {}) {
  if (!dbEnabled()) return { reportId, findingId, queued: false, changed: false, reason: 'no-database' };
  const [existing] = await sql('SELECT revision FROM feedback_auto_jobs WHERE report_id=$1 AND finding_id=$2', [reportId, findingId]);
  const loaded = await loadReport(reportId);
  if (!loaded?.host) return { reportId, findingId, queued: false, changed: false, reason: 'unknown-report' };
  const [saved] = await sql(ENQUEUE_SQL, [reportId, findingId, loaded.host, now(), force === true]);
  if (!saved) {
    const [current] = await sql(CASE_SQL('WHERE report_id=$1 AND finding_id=$2'), [reportId, findingId]);
    return { reportId, findingId, queued: false, changed: false, reason: current?.n ? 'stale-snapshot' : 'no-feedback' };
  }
  return { reportId, findingId, revision: saved.revision, queued: saved.status === 'queued', changed: !existing || existing.revision !== saved.revision };
}

// Cases whose current content differs from what the queue holds: an enqueue may have
// been lost (a restart, an older release, a late commit), so every pass compares
// content for every case rather than trusting timestamps.
export async function reconcileFeedbackQueue({ limit = DEFAULTS.reconcileLimit, now = () => new Date() } = {}) {
  if (!dbEnabled()) return 0;
  const cases = await sql(`SELECT c.report_id, c.finding_id FROM (SELECT report_id, finding_id, ${REVISION_SQL} AS revision, max(updated_at) AS at FROM finding_feedback GROUP BY report_id, finding_id) c
    LEFT JOIN feedback_auto_jobs j ON j.report_id=c.report_id AND j.finding_id=c.finding_id
    WHERE j.report_id IS NULL OR j.revision <> c.revision
    ORDER BY c.at DESC LIMIT $1`, [Math.max(1, Math.min(1000, limit))]);
  let queued = 0;
  for (const c of cases) if ((await enqueueFeedbackCase(c.report_id, c.finding_id, { now, force: true })).queued) queued++;
  return queued;
}

// Claim one due case. The subquery lock and the status change happen in one
// statement, so two workers cannot take the same case; an expired lease is
// claimable again until the attempt limit is reached.
async function claim({ now, leaseMs, maxAttempts }) {
  const at = now();
  await sql(`UPDATE feedback_auto_jobs SET status='failed', claim_token=NULL, lease_until=NULL, last_error=COALESCE(last_error,'attempts-exhausted'), updated_at=$1
    WHERE attempts >= $2 AND ((status='queued' AND next_run_at <= $1) OR (status='processing' AND lease_until < $1))`, [at, maxAttempts]);
  const token = randomBytes(12).toString('base64url');
  const [row] = await sql(`UPDATE feedback_auto_jobs j SET status='processing', claim_token=$1, lease_until=$2, attempts=j.attempts+1, updated_at=$3
    WHERE (j.report_id, j.finding_id) = (SELECT report_id, finding_id FROM feedback_auto_jobs
      WHERE attempts < $4 AND ((status='queued' AND next_run_at <= $3) OR (status='processing' AND lease_until < $3))
      ORDER BY next_run_at, created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING j.*`, [token, new Date(at.getTime() + leaseMs), at, maxAttempts]);
  return row ? { ...row, token } : null;
}

// One unit is one job that may make up to two requests and one model call. Each
// scope is taken with a single conditional increment, which the database applies
// against the latest row version, so concurrent workers cannot exceed a limit. When
// the host limit refuses after the global unit was taken, the global unit is returned.
async function takeUnit(day, scope, cap) {
  await sql('INSERT INTO feedback_auto_budget (day,scope,used) VALUES ($1,$2,0) ON CONFLICT (day,scope) DO NOTHING', [day, scope]);
  const rows = await sql('UPDATE feedback_auto_budget SET used=used+1 WHERE day=$1 AND scope=$2 AND used < $3 RETURNING used', [day, scope, cap]);
  return rows.length > 0;
}
async function reserveBudget({ now, budget, host }) {
  const day = dayOf(now());
  const globalCap = Math.max(0, Math.floor(Number(budget?.globalPerDay)) || 0);
  const hostCap = Math.max(0, Math.floor(Number(budget?.hostPerDay)) || 0);
  if (!(await takeUnit(day, 'global', globalCap))) return false;
  if (await takeUnit(day, 'host:' + host, hostCap)) return true;
  await sql('UPDATE feedback_auto_budget SET used=GREATEST(0, used-1) WHERE day=$1 AND scope=$2', [day, 'global']);
  return false;
}

async function release(job, { status, now, nextRunAt = null, error = null, attemptsDelta = 0 }) {
  const rows = await sql(`UPDATE feedback_auto_jobs SET status=$4, claim_token=NULL, lease_until=NULL, next_run_at=COALESCE($5, next_run_at),
    last_error=$6, attempts=GREATEST(0, attempts+$7), updated_at=$8 WHERE report_id=$1 AND finding_id=$2 AND claim_token=$3 RETURNING attempts`,
  [job.report_id, job.finding_id, job.token, status, nextRunAt, error, attemptsDelta, now()]);
  return rows.length > 0;
}

const defaultModel = () => (llmEnabled() ? (prompt) => chatJSON({ system: prompt.system, user: prompt.user, temperature: 0, maxTokens: 400 }) : null);

// Claim and process at most one case. Every decision comes from saved report data,
// the current feedback, and at most two fresh observations; the model can only pick
// catalog lesson ids. Publishing is guarded by the claim token and the revision, so a
// late worker cannot publish a result for feedback that changed meanwhile.
export async function processFeedbackJob(options = {}) {
  const { now = () => new Date(), observer = observeRecordedAddress, model = defaultModel(), leaseMs = DEFAULTS.leaseMs,
    maxAttempts = DEFAULTS.maxAttempts, retryDelayMs = DEFAULTS.retryDelayMs, budget = DEFAULTS.budget } = options;
  if (!dbEnabled()) return { result: 'idle', reason: 'no-database' };
  const job = await claim({ now, leaseMs, maxAttempts });
  if (!job) return { result: 'idle' };
  const base = { reportId: job.report_id, findingId: job.finding_id, attempts: job.attempts };
  // The feedback no longer matches this job's revision: bring the queue up to date
  // with the current content and give the case back, so it is neither published for
  // stale feedback nor left holding a claim until the lease expires.
  const supersede = async (extra = {}) => {
    const reconciled = await enqueueFeedbackCase(job.report_id, job.finding_id, { now, force: true });
    if (reconciled.queued) await release(job, { status: 'queued', now, attemptsDelta: -1 });
    return { ...base, result: 'superseded', ...extra };
  };
  try {
    const rows = await feedbackRows(job.report_id, job.finding_id);
    if (!rows.length || feedbackRevision(rows) !== job.revision) return supersede();
    const loaded = await loadReport(job.report_id);
    const findings = Array.isArray(loaded?.report?.findings) ? loaded.report.findings : [];
    const finding = job.finding_id === REPORT_LEVEL ? null : findings.find((f) => f?.id === job.finding_id) || null;
    const counts = summarizeFeedback(rows);
    const plan = planCase({ findingId: job.finding_id, finding, counts });
    const wantsNetwork = plan.addresses.length > 0;
    const wantsModel = plan.disputed && plan.kind !== 'missing' && counts.notes.length > 0 && typeof model === 'function';
    let funded = false;
    if (wantsNetwork || wantsModel) funded = await reserveBudget({ now, budget, host: job.target_host });
    if (wantsNetwork && !funded) {
      await release(job, { status: 'queued', now, nextRunAt: nextDay(now()), attemptsDelta: -1 });
      return { ...base, result: 'deferred', nextRunAt: nextDay(now()).toISOString() };
    }
    const evidence = { observations: [], addressesRecorded: plan.addresses.length };
    let outcome, summaryCode, method = 'rules', networkRequests = 0, modelCalls = 0;
    if (plan.kind === 'report') { outcome = 'feedback-only'; summaryCode = 'feedback-only-report'; }
    else if (plan.kind === 'missing') { outcome = 'feedback-only'; summaryCode = 'feedback-only-missing'; }
    else if (!plan.disputed) { outcome = 'feedback-only'; summaryCode = 'feedback-only-agreement'; }
    else if (plan.kind === 'other') { outcome = 'feedback-only'; summaryCode = 'feedback-only-no-recheck'; }
    else if (plan.unsupported) { outcome = 'unsupported'; summaryCode = 'unsupported-no-http-answer'; }
    else {
      method = 'observation';
      for (const url of plan.addresses) {
        networkRequests++;
        const seen = await observer(url);
        evidence.observations.push({ url: String(seen?.url || url).slice(0, 500), status: Number(seen?.status) || 0, classification: String(seen?.classification || 'inconclusive'),
          ...(seen?.reason ? { reason: String(seen.reason).slice(0, 40) } : {}), ...(seen?.transport ? { transport: true } : {}), observedAt: iso(seen?.observedAt || now()) });
      }
      ({ outcome, summaryCode } = availabilityOutcome(evidence.observations));
    }
    let modelLessons = [];
    if (wantsModel && funded) {
      modelCalls = 1;
      method += '+model';
      try { modelLessons = validateModelLessons(await model(buildModelPrompt({ finding, counts, notes: counts.notes }), { reportId: job.report_id, findingId: job.finding_id })); }
      catch { modelLessons = []; evidence.modelFailed = true; }
    }
    const lessons = mergeLessons(ruleLessons({ kind: plan.kind, findingId: job.finding_id, outcome, disputed: plan.disputed }), modelLessons);
    const resultId = newId();
    // Publish only while this worker still holds the claim, the queue still carries the
    // processed revision, and the feedback rows as they exist in this same statement
    // still digest to that revision. A vote that committed meanwhile, with or without
    // its enqueue, makes the guard fail and nothing is written.
    const published = await sql(`WITH live AS (${CASE_SQL('WHERE report_id=$2 AND finding_id=$3')}),
      done AS (UPDATE feedback_auto_jobs j SET status='processed', claim_token=NULL, lease_until=NULL, last_error=NULL, updated_at=$11 FROM live
        WHERE j.report_id=$2 AND j.finding_id=$3 AND j.claim_token=$12 AND j.revision=$5 AND live.revision=$5 RETURNING j.revision)
      INSERT INTO feedback_auto_results (id,report_id,finding_id,target_host,revision,outcome,summary_code,lesson_ids,evidence,method,network_requests,model_calls,processed_at)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8::text[],$9::jsonb,$10,$13,$14,$11 FROM done RETURNING id`,
    [resultId, job.report_id, job.finding_id, job.target_host, job.revision, outcome, summaryCode, lessons, JSON.stringify(evidence), method, now(), job.token, networkRequests, modelCalls]);
    if (!published.length) return supersede({ networkRequests, modelCalls });
    return { ...base, result: 'processed', outcome, summaryCode, lessons, resultId, networkRequests, modelCalls };
  } catch (err) {
    const code = errorCode(err);
    if (job.attempts >= maxAttempts) { await release(job, { status: 'failed', now, error: code }); return { ...base, result: 'failed', error: code }; }
    await release(job, { status: 'queued', now, nextRunAt: new Date(now().getTime() + retryDelayMs * job.attempts), error: code });
    return { ...base, result: 'retry', error: code };
  }
}

// Bounded polling. Nothing starts on import; the caller starts one worker per
// process after the schema exists. Each tick reconciles missed cases, then
// processes a few due cases. Ticks never overlap.
export function startFeedbackWorker({ intervalMs = 5000, maxPerTick = DEFAULTS.maxPerTick, reconcileLimit = DEFAULTS.reconcileLimit, ...deps } = {}) {
  let stopped = false, running = null, timer = null;
  const tick = async () => {
    if (stopped) return { queued: 0, processed: 0 };
    if (running) return running;
    running = (async () => {
      const summary = { queued: 0, processed: 0, results: [] };
      try {
        summary.queued = await reconcileFeedbackQueue({ limit: reconcileLimit, now: deps.now });
        for (let i = 0; i < maxPerTick && !stopped; i++) {
          const result = await processFeedbackJob(deps);
          if (result.result === 'idle') break;
          summary.results.push(result);
          if (result.result === 'processed') summary.processed++;
        }
      } catch (err) { console.error('feedback worker: tick failed (' + errorCode(err) + ')'); }
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

const currentResultsSql = (where) => `SELECT r.* FROM (SELECT DISTINCT ON (report_id, finding_id) * FROM feedback_auto_results ${where} ORDER BY report_id, finding_id, sequence DESC) r
  JOIN feedback_auto_jobs j ON j.report_id=r.report_id AND j.finding_id=r.finding_id AND j.revision=r.revision`;

export async function autoFeedbackForReport(reportId) {
  const out = Object.create(null);
  if (!dbEnabled() || typeof reportId !== 'string') return out;
  const jobs = await sql('SELECT finding_id, status FROM feedback_auto_jobs WHERE report_id=$1', [reportId]);
  const results = await sql(currentResultsSql('WHERE report_id=$1'), [reportId]);
  const byFinding = new Map(results.map((row) => [row.finding_id, row]));
  for (const job of jobs) {
    const status = STATUSES.includes(job.status) ? job.status : 'queued';
    const result = job.status === 'processed' ? byFinding.get(job.finding_id) : null;
    out[job.finding_id] = {
      status, outcome: result && OUTCOMES.includes(result.outcome) ? result.outcome : null,
      processedAt: result ? iso(result.processed_at) : null,
      summary: summaryFor(result ? result.summary_code : status),
      lessons: result ? publicGuidance(result.lesson_ids.map((id) => ({ id, scope: 'site' }))) : [],
    };
  }
  return out;
}

export async function autoFeedbackProgress({ lessonDays = DEFAULTS.lessonDays } = {}) {
  if (!dbEnabled()) return { submitted: 0, processed: 0, pending: 0, failed: 0, lessonsActive: 0, mode: 'automatic' };
  const [counts] = await sql(`SELECT (SELECT count(*)::int FROM (SELECT DISTINCT report_id, finding_id FROM finding_feedback) s) AS submitted,
    (SELECT count(*)::int FROM feedback_auto_jobs WHERE status='processed') AS processed,
    (SELECT count(*)::int FROM feedback_auto_jobs WHERE status='failed') AS failed`);
  const [active] = await sql(`SELECT count(DISTINCT lesson_id)::int AS n FROM (SELECT unnest(lesson_ids) AS lesson_id FROM (${currentResultsSql('WHERE processed_at >= $1')}) c) l`,
    [new Date(Date.now() - lessonDays * DAY)]);
  return { submitted: counts.submitted, processed: counts.processed, pending: Math.max(0, counts.submitted - counts.processed - counts.failed), failed: counts.failed,
    lessonsActive: active.n, mode: 'automatic' };
}

// Lessons for the next scan of a host: site lessons from any current result for that
// host, general lessons only when the same id appears on enough distinct hosts and was
// supported by enough distinct signed-in accounts. Superseded and expired results are
// ignored; identity is counted here and never returned.
export async function lessonsFor({ host, limit = 8, lessonDays = DEFAULTS.lessonDays, generalHosts = DEFAULTS.generalHosts, generalAccounts = DEFAULTS.generalAccounts } = {}) {
  if (!dbEnabled()) return [];
  const normalized = normHost(host);
  const since = new Date(Date.now() - lessonDays * DAY);
  const cap = Math.max(1, Math.min(8, Math.floor(Number(limit)) || 8));
  const site = normalized ? await sql(`SELECT lesson_id, max(processed_at) AS last_at FROM (SELECT unnest(lesson_ids) AS lesson_id, processed_at FROM (${currentResultsSql('WHERE processed_at >= $1 AND target_host=$2')}) c) l
    GROUP BY lesson_id ORDER BY last_at DESC, lesson_id`, [since, normalized]) : [];
  const general = await sql(`SELECT l.lesson_id, count(DISTINCT l.target_host)::int AS hosts, count(DISTINCT f.user_id)::int AS accounts, max(l.processed_at) AS last_at
    FROM (SELECT report_id, finding_id, target_host, processed_at, unnest(lesson_ids) AS lesson_id FROM (${currentResultsSql('WHERE processed_at >= $1')}) c) l
    LEFT JOIN finding_feedback f ON f.report_id=l.report_id AND f.finding_id=l.finding_id AND f.user_id IS NOT NULL
    GROUP BY l.lesson_id HAVING count(DISTINCT l.target_host) >= $2 AND count(DISTINCT f.user_id) >= $3 ORDER BY last_at DESC, l.lesson_id`, [since, generalHosts, generalAccounts]);
  const chosen = [];
  for (const row of site) if (Object.hasOwn(LESSON_CATALOG, row.lesson_id)) chosen.push({ id: row.lesson_id, scope: 'site' });
  for (const row of general) if (Object.hasOwn(LESSON_CATALOG, row.lesson_id) && !chosen.some((c) => c.id === row.lesson_id)) chosen.push({ id: row.lesson_id, scope: 'general' });
  return publicGuidance(chosen).slice(0, cap);
}
