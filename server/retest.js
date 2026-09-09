// Recheck recorded HTTP availability claims. Attempts stay separate from signed
// originals and from human review decisions.
import express from 'express';
import { getReport, dbEnabled, sql, newId } from './db.js';
import { createClient, statusText, classifyError, sleep, BROKEN_STATUSES, inspectChallenge } from './lib/http.js';
import { resolveTarget } from './safety.js';
import { consume, ip } from './ratelimit.js';

const ID_RE = /^[A-Za-z0-9_-]{6,20}$/;
const MAX_ITEMS = 8;
const MAX_HOPS = 5;
const SCOPE = 'http-availability';
const VERSION = 'http-availability-v1';

export function retestCapability(finding) {
  const id = String(finding?.id || '');
  if (finding?.source === 'agent' || id.startsWith('agent-') ||
      !(/^(broken-links|broken-images)$/.test(id) || /^flow-(error|missing)-.+/.test(id))) {
    return { supported: false, scope: null, reason: 'An HTTP availability recheck cannot verify this finding. Its original browser observation or specific test must be repeated.' };
  }
  if (!itemsOf(finding).length) return { supported: false, scope: null, reason: 'This finding has no usable recorded HTTP addresses to recheck.' };
  return { supported: true, scope: SCOPE, reason: 'This recheck measures whether the recorded addresses load over HTTP. It does not repeat a browser interaction.' };
}

export async function ensureRetestSchema() {
  if (!dbEnabled()) return false;
  await sql(`CREATE TABLE IF NOT EXISTS finding_rechecks (
    id TEXT PRIMARY KEY, report_id TEXT NOT NULL, finding_id TEXT NOT NULL,
    scope TEXT NOT NULL, verifier_version TEXT NOT NULL,
    checked_at TIMESTAMPTZ NOT NULL, result JSONB NOT NULL
  )`);
  await sql('CREATE INDEX IF NOT EXISTS finding_rechecks_finding_idx ON finding_rechecks (report_id, finding_id, checked_at DESC)');
  return true;
}

async function saveRetestAttempt(reportId, result) {
  if (!dbEnabled()) return null;
  const id = newId();
  await sql(`INSERT INTO finding_rechecks (id,report_id,finding_id,scope,verifier_version,checked_at,result)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, reportId, result.findingId, result.scope, VERSION, result.checkedAt, JSON.stringify(result)]);
  return id;
}

export function createRetestRouter({
  loadReport = getReport, dbOn = dbEnabled, resolve = resolveTarget,
  makeClient = createClient, consumeFn = consume, ipFn = ip, gapMs = 200,
  saveAttempt = saveRetestAttempt,
} = {}) {
  const router = express.Router();
  router.post('/api/reports/:id/retest', async (req, res) => {
    try {
      const id = String(req.params.id || '');
      if (!ID_RE.test(id)) return res.status(400).json({ error: 'Bad report id.' });
      const findingId = typeof req.body?.findingId === 'string' ? req.body.findingId.trim() : '';
      if (!findingId || findingId.length > 120) return res.status(400).json({ error: 'Please say which finding to recheck.' });
      for (const limit of [consumeFn('retest-ip', ipFn(req), 20, 3600000), consumeFn('retest-report', id, 6, 600000)]) {
        if (!limit.ok) {
          res.setHeader('Retry-After', String(Math.max(1, Math.ceil((limit.retryAfterMs || 60000) / 1000))));
          return res.status(429).json({ error: 'Several rechecks were requested recently. Please wait before trying again.' });
        }
      }
      if (!dbOn()) return res.status(503).json({ error: 'Saved reports are unavailable because the database is not configured.' });
      const report = await loadReport(id);
      if (!report) return res.status(404).json({ error: 'We could not find that report.' });
      const finding = (Array.isArray(report.findings) ? report.findings : []).find((f) => f?.id === findingId);
      if (!finding) return res.status(400).json({ error: 'That finding is not part of this report.' });
      const capability = retestCapability(finding);
      if (!capability.supported) return res.status(422).json({ error: capability.reason, ...capability });
      const client = makeClient();
      const selected = itemsOf(finding).slice(0, MAX_ITEMS);
      const items = [];
      for (const item of selected) {
        if (items.length) await sleep(gapMs);
        const target = parseHttpUrl(item.url);
        const observation = await allowed(target, resolve)
          ? await fetchStatus(client, target, resolve)
          : { status: 0, statusText: 'not allowed', classification: 'inconclusive', reason: 'not-allowed' };
        const previous = Number.isInteger(item.status) && item.status > 0 ? item.status : 0;
        const baseline = classify(previous);
        const unknownBaseline = baseline === 'inconclusive';
        const classification = unknownBaseline ? 'inconclusive' : observation.classification;
        const changed = classification === 'inconclusive' ? null : classification !== baseline;
        items.push({ url: target.href, previous, ...observation, classification, changed,
          ok: classification === 'inconclusive' ? null : classification === 'working',
          ...(unknownBaseline ? { reason: 'unknown-baseline' } : {}) });
      }
      const result = { findingId, scope: SCOPE, checkedAt: new Date().toISOString(), verifierVersion: VERSION, items };
      let attemptId = null;
      try { attemptId = await saveAttempt(id, result); } catch { console.error('retest: could not save the attempt'); }
      res.json({ ...result, attemptId, persisted: Boolean(attemptId), ...(attemptId ? {} : { persistenceNote: 'The measurement completed, but this attempt was not saved.' }) });
    } catch {
      console.error('retest: request failed');
      if (!res.headersSent) res.status(500).json({ error: 'Could not recheck that finding right now. Please try again later.' });
    }
  });
  return router;
}

export const retestRouter = createRetestRouter();

function classify(status) {
  if (status >= 200 && status < 300) return 'working';
  if (BROKEN_STATUSES.has(status)) return 'broken';
  return 'inconclusive';
}

async function fetchStatus(client, target, resolve) {
  let current = target;
  const visited = new Set();
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    visited.add(current.href);
    let response;
    try { response = await client.get(current.href, { browserLike: true, timeoutMs: 8000, redirect: 'manual' }); }
    catch (error) {
      const failure = classifyError(error);
      return { status: 0, statusText: failure.statusText, classification: 'inconclusive', reason: failure.reason || 'request-failed', finalUrl: current.href };
    }
    let challenge;
    try { challenge = await inspectChallenge(response); }
    catch { return {status:Number(response?.status) || 0,statusText:'response could not be read',classification:'inconclusive',reason:'response-read-failed',finalUrl:current.href}; }
    finally { try { response?.discard?.(); } catch {} }
    const status = Number(response?.status) || 0;
    const observed = { status, statusText: statusText(status), finalUrl: current.href };
    if (challenge) return {...observed,classification:'inconclusive',reason:'challenge'};
    if (status < 300 || status >= 400) return { ...observed, classification: classify(status), ...(classify(status) === 'inconclusive' ? { reason: 'access-or-service-refusal' } : {}) };
    const location = response?.headers?.get?.('location');
    let next;
    try { next = location ? new URL(location, current) : null; } catch {}
    if (!next) return { ...observed, classification: 'inconclusive', reason: 'invalid-redirect' };
    next.hash = '';
    if (visited.has(next.href)) return { ...observed, classification: 'inconclusive', reason: 'redirect-loop' };
    if (hop === MAX_HOPS) return { ...observed, classification: 'inconclusive', reason: 'redirect-limit' };
    if (!(await allowed(next, resolve))) return { ...observed, classification: 'inconclusive', reason: 'not-allowed' };
    current = next;
  }
}

function itemsOf(finding) {
  const items = Array.isArray(finding?.evidence?.items) ? finding.evidence.items : [];
  return items.filter((item) => item && parseHttpUrl(item.url));
}
function parseHttpUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) return null;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url;
  } catch { return null; }
}
async function allowed(url, resolve) {
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) return false;
  try { return Boolean((await resolve(url))?.ok); } catch { return false; }
}
