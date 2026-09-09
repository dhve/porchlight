import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { setTimeout as delay } from 'node:timers/promises';
import { disposablePostgres } from './helpers/feedback-db.mjs';
import { initDb, sql, saveReport } from '../server/db.js';
import { feedbackRouter, ensureFeedbackSchema, disputesForHost } from '../server/feedback.js';
import { createRetestRouter } from '../server/retest.js';

let db, server, base, network = 0;
const original = {
  id: 'report01', target: 'example.invalid', url: 'https://example.invalid/', grade: 'B', score: 84,
  scannedAt: '2026-09-09T00:00:00.000Z', userId: 'PRIVATE_SUBMITTER',
  engine: { model: 'fixture-model', version: 'fixture-build' },
  findings: [
    { id: 'broken-links', severity: 'watch', title: 'A link failed', evidence: { items: [{ url: 'https://example.invalid/missing', status: 404, kind: 'link' }] }, disputed: { notes: [{ text: 'PRIVATE_OLD_NOTE' }] } },
    { id: 'missing-sri', severity: 'minor', title: 'A script has no integrity hash', evidence: { lines: ['Script tag observation'] } },
    { id: 'missing-header', severity: 'minor', title: 'A header was absent', evidence: { lines: ['Header observation'] } },
  ],
};

test.before(async () => {
  db = await disposablePostgres();
  if (!db) return;
  process.env.DATABASE_URL = db.url;
  process.env.SESSION_SECRET = 'synthetic-feedback-test-key';
  await initDb();
  await ensureFeedbackSchema();
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use((req, _res, next) => { if (req.get('x-test-role')) req.user = { id: 'reviewer01', role: req.get('x-test-role') }; next(); });
  app.use(feedbackRouter);
  app.use(createRetestRouter({ resolve: async () => ({ ok: true }), makeClient: () => ({ get: async () => ({ status: 200, headers: new Headers(), discard() {} }) }), gapMs: 0 }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(async () => {
  if (!db) return;
  network++;
  await sql('DELETE FROM finding_feedback');
  await sql('DELETE FROM reports');
  for (const table of ['finding_feedback_reviews', 'finding_rechecks']) {
    const rows = await sql('SELECT to_regclass($1) AS name', [table]);
    if (rows[0].name) await sql(`DELETE FROM ${table}`);
  }
  await saveReport(original);
});

test.after(async () => {
  if (server) await new Promise((done) => server.close(done));
  // db.js owns its pool and exports no close hook. Let pg's 10 second idle timeout
  // close fixture connections before stopping the disposable server.
  if (db) { await delay(10_100); await db.close(); }
});

async function request(path, { role, cookie, body, agent = 'fixture-browser' } = {}) {
  const headers = { 'x-forwarded-for': `198.51.100.${network}`, 'user-agent': agent };
  if (role) headers['x-test-role'] = role;
  if (cookie) headers.cookie = cookie;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const path = '/api/reports/report01/feedback';
const vote = (note = 'PRIVATE_VISITOR_NOTE') => ({ findingId: 'broken-links', verdict: 'wrong', note });
const review = (findingId = 'broken-links', status = 'confirmed') => ({ findingId, status, reason: 'A reviewer repeated the recorded check under the same conditions.' });
function available(t) { if (!db) { t.skip('Local PostgreSQL tools are not available.'); return false; } return true; }

test('public feedback preserves counts while keeping notes and names private', async (t) => {
  if (!available(t)) return;
  const posted = await request(path, { body: vote() });
  assert.equal(posted.status, 200);
  assert.equal(posted.body.received, true);
  assert.equal(posted.body.receipt.status, 'received');
  assert.equal(JSON.stringify(posted.body).includes('PRIVATE_VISITOR_NOTE'), false);
  const read = await request(path, { cookie: posted.cookie });
  assert.equal(read.body.findings['broken-links'].wrong, 1);
  assert.equal(read.body.mine['broken-links'], 'wrong');
  assert.deepEqual(read.body.findings['broken-links'].notes, []);
  assert.ok(read.body.policy);
  const queue = await request('/api/feedback/review-queue', { role: 'admin' });
  assert.equal(queue.status, 200);
  assert.equal(queue.body.cases[0].notes[0].text, 'PRIVATE_VISITOR_NOTE');
});

test('two anonymous browsers on one network remain separate voters', async (t) => {
  if (!available(t)) return;
  const first = await request(path);
  const second = await request(path);
  assert.ok(first.cookie);
  assert.ok(second.cookie);
  assert.notEqual(first.cookie, second.cookie);
  await request(path, { cookie: first.cookie, body: vote() });
  await request(path, { cookie: second.cookie, body: vote() });
  const read = await request(path, { cookie: first.cookie });
  assert.equal(read.body.findings['broken-links'].wrong, 2);
  await request(path, { cookie: first.cookie, body: { findingId: 'broken-links', verdict: 'right' } });
  const changed = await request(path, { cookie: first.cookie });
  assert.equal(changed.body.findings['broken-links'].wrong, 1);
  assert.equal(changed.body.findings['broken-links'].right, 1);
  const keys = await sql('SELECT voter_key FROM finding_feedback');
  assert.equal(keys.some((x) => x.voter_key.includes(first.cookie.split('=')[1])), false);
});

test('unauthorized readers cannot read the queue, export cases, or adjudicate', async (t) => {
  if (!available(t)) return;
  for (const role of [undefined, 'user']) {
    for (const endpoint of ['/api/feedback/review-queue', '/api/feedback/evaluation-cases']) assert.equal((await request(endpoint, { role })).status, 403);
    assert.equal((await request(path + '/review', { role, body: review() })).status, 403);
  }
});

test('reviews append history and do not rewrite the signed original', async (t) => {
  if (!available(t)) return;
  const before = (await sql('SELECT report FROM reports WHERE id=$1', ['report01']))[0].report;
  for (const status of ['confirmed', 'inconclusive', 'incorrect']) {
    const result = await request(path + '/review', { role: 'admin', body: review('broken-links', status) });
    assert.equal(result.status, 201);
    assert.equal(result.body.review.status, status);
  }
  const history = await sql('SELECT status FROM finding_feedback_reviews ORDER BY sequence');
  assert.deepEqual(history.map((x) => x.status), ['confirmed', 'inconclusive', 'incorrect']);
  const after = (await sql('SELECT report FROM reports WHERE id=$1', ['report01']))[0].report;
  assert.deepEqual(after, before);
  const state = await request(path);
  assert.equal(state.body.findings['broken-links'].review.status, 'incorrect');
  assert.equal(JSON.stringify(state.body).includes('reviewer01'), false);
});

test('reviews require an existing finding and a substantive public reason', async (t) => {
  if (!available(t)) return;
  for (const body of [review('invented'), review('_report'), { ...review(), status: 'right' }, { ...review(), reason: 'ok' }, { ...review(), reason: ' '.repeat(40) }]) {
    assert.equal((await request(path + '/review', { role: 'admin', body })).status, 400);
  }
});

test('only the latest conclusive reviews become stable evaluation labels', async (t) => {
  if (!available(t)) return;
  await request(path, { body: vote() });
  for (const [id, status] of [['broken-links', 'confirmed'], ['missing-sri', 'incorrect'], ['missing-header', 'inconclusive']]) {
    assert.equal((await request(path + '/review', { role: 'admin', body: review(id, status) })).status, 201);
  }
  const exported = await request('/api/feedback/evaluation-cases', { role: 'admin' });
  assert.equal(exported.status, 200);
  assert.equal(exported.body.cases.length, 2);
  assert.deepEqual(exported.body.cases.map((x) => x.expected).sort(), ['absent', 'present']);
  assert.ok(exported.body.cases.every((x) => x.provenance.reviewId && x.provenance.findingDigest));
  assert.equal(JSON.stringify(exported.body).includes('PRIVATE_'), false);
  assert.equal(JSON.stringify(exported.body).includes('reviewer01'), false);
  const stable = exported.body.cases.find((x) => x.findingId === 'broken-links').caseId;
  await request(path + '/review', { role: 'admin', body: review('broken-links', 'incorrect') });
  const changed = await request('/api/feedback/evaluation-cases', { role: 'admin' });
  assert.equal(changed.body.cases.find((x) => x.findingId === 'broken-links').caseId, stable);
  await request(path + '/review', { role: 'admin', body: review('broken-links', 'inconclusive') });
  assert.equal((await request('/api/feedback/evaluation-cases', { role: 'admin' })).body.cases.length, 1);
});

test('public progress counts submitted and reviewed cases without exposing notes', async (t) => {
  if (!available(t)) return;
  await request(path, { body: vote() });
  await request(path + '/review', { role: 'admin', body: review() });
  const result = await request('/api/feedback/progress');
  assert.equal(result.status, 200);
  assert.equal(result.body.signals.total, 1);
  assert.equal(result.body.cases.confirmed, 1);
  assert.equal(result.body.cases.pending, 0);
  assert.match(result.body.limitation, /not.*accuracy/i);
  assert.equal(JSON.stringify(result.body).includes('PRIVATE_'), false);
  const disputes = await disputesForHost('example.invalid');
  assert.deepEqual(disputes.get('broken-links').notes, []);
});

test('rotating browser identity cannot bypass the separate IP abuse limit', async (t) => {
  if (!available(t)) return;
  let limited = false;
  for (let i = 0; i < 85; i++) {
    const result = await request(path, { body: vote(''), agent: `rotating-browser-${i}` });
    if (result.status === 429) { limited = true; break; }
  }
  assert.equal(limited, true);
});

test('an availability recheck persists without creating a human review', async (t) => {
  if (!available(t)) return;
  const result = await request('/api/reports/report01/retest', { body: { findingId: 'broken-links' } });
  assert.equal(result.status, 200);
  assert.ok(result.body.attemptId);
  const attempts = await sql('SELECT result FROM finding_rechecks WHERE id=$1', [result.body.attemptId]);
  assert.equal(attempts[0].result.items[0].classification, 'working');
  assert.equal((await sql('SELECT count(*)::int AS n FROM finding_feedback_reviews'))[0].n, 0);
  assert.deepEqual((await sql('SELECT report FROM reports WHERE id=$1', ['report01']))[0].report.findings, original.findings);
});

test('legacy feedback migration preserves the original submission date', async (t) => {
  if (!available(t)) return;
  await sql('ALTER TABLE finding_feedback DROP COLUMN updated_at');
  await sql(`INSERT INTO finding_feedback (id,report_id,target_host,finding_id,voter_key,verdict,created_at)
    VALUES ('legacy01','report01','example.invalid','broken-links','legacy-voter','wrong','2020-01-01T00:00:00Z')`);
  await ensureFeedbackSchema();
  const [row] = await sql('SELECT updated_at FROM finding_feedback WHERE id=$1', ['legacy01']);
  assert.equal(row.updated_at.toISOString(), '2020-01-01T00:00:00.000Z');
});

test('finding identifiers cannot alter object prototypes or disappear from counts', async (t) => {
  if (!available(t)) return;
  await sql('UPDATE reports SET report=$1 WHERE id=$2', [JSON.stringify({ ...original, findings: [{ id: '__proto__', severity: 'minor', title: 'Fixture' }] }), 'report01']);
  try {
    const result = await request(path, { body: { findingId: '__proto__', verdict: 'wrong' } });
    assert.equal(result.status, 200);
    const read = await request(path, { cookie: result.cookie });
    assert.equal(Object.hasOwn(read.body.findings, '__proto__'), true);
    assert.equal(Object.prototype.wrong, undefined);
  } finally { delete Object.prototype.wrong; delete Object.prototype.right; }
});

test('report-wide votes do not inflate pending individual finding reviews', async (t) => {
  if (!available(t)) return;
  await request(path, { body: { findingId: '_report', verdict: 'wrong' } });
  const progress = await request('/api/feedback/progress');
  assert.equal(progress.body.signals.total, 1);
  assert.equal(progress.body.cases.submitted, 0);
  assert.equal(progress.body.cases.pending, 0);
  const queue = await request('/api/feedback/review-queue', { role: 'admin' });
  assert.equal(queue.body.cases[0].findingId, '_report');
  assert.equal(queue.body.cases[0].reviewable, false);
});
