import test from 'node:test';
import assert from 'node:assert/strict';
import { observeCheck } from '../server/provenance.js';
import { runForms } from '../server/checks/forms.js';
import { explain } from '../server/explain.js';
import { runExposedFiles } from '../server/checks/exposedFiles.js';
import { runTls } from '../server/checks/tls.js';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';

test('observation provenance preserves capture time separately from pipeline record time', async () => {
  const started = Date.now();
  const { out } = await observeCheck('forms', async () => ({ findings: [{ id: 'fixture',
    evidence: { observedAt: '2026-09-09T12:00:00.000Z', value: 23 } }], passes: [] }));
  assert.equal(out.findings[0].provenance.observedAt, '2026-09-09T12:00:00.000Z');
  assert.ok(Date.parse(out.findings[0].provenance.recordedAt) >= started);
});

test('the real form heuristic retains its uncertainty in the deterministic explanation', async () => {
  const { findings } = await runForms({ facts: { isHttps: true, finalUrl: new URL('https://fixture.test/'),
    forms: [{ page: 'https://fixture.test/login', action: 'https://fixture.test/login',
      method: 'post', hasPassword: true, hasCsrf: false }] } });
  const finding = findings.find((f) => f.id === 'form-missing-csrf');
  assert.match(finding.evidence.note, /heuristic/i);
  const explanation = explain(finding);
  assert.match(explanation.why, /heuristic|not establish|not prove/i);
  assert.match(explanation.why, /other|server/i);
});

test('a challenge response cannot count as completed recon even when HTTP responded', async () => {
  const { coverage } = await observeCheck('recon', async () => ({
    facts: { reachable: true, challenged: 'Site verification page' }, findings: [], passes: [],
  }));
  assert.equal(coverage.status, 'inconclusive');
  assert.match(coverage.reason, /challenge|verification/i);
});

test('a request budget error swallowed by the real file checker still makes coverage incomplete', async () => {
  const result = await observeCheck('exposedFiles', runExposedFiles, {
    facts: { baseOrigin: 'https://fixture.test', finalUrl: new URL('https://fixture.test/') },
    client: { get: async () => { throw Object.assign(new Error('Request budget exceeded'), { code: 'BUDGET' }); } },
  });
  assert.equal(result.coverage.status, 'inconclusive');
  assert.match(result.coverage.reason, /request|budget/i);
  assert.deepEqual(result.out.passes, []);
});

test('a successful retry clears the earlier request failure from check coverage', async () => {
  let tries = 0;
  const result = await observeCheck('links', async ({ client }) => {
    await client.get('https://fixture.test/page').catch(() => {});
    await client.get('https://fixture.test/page');
    return { findings: [], passes: ['The retried page answered.'] };
  }, { client: { get: async () => {
    if (++tries === 1) throw new Error('Connection reset');
    return { status: 200 };
  } } });
  assert.equal(result.coverage.status, 'completed');
});

test('the real TLS checker cannot silently turn a failed handshake into completed coverage', async (t) => {
  t.mock.method(tls, 'connect', () => {
    const socket = new EventEmitter();
    socket.destroy = () => {};
    socket.setTimeout = () => {};
    process.nextTick(() => socket.emit('error', new Error('Fixture handshake failed')));
    return socket;
  });
  const result = await observeCheck('tls', runTls, {
    facts: { isHttps: true, finalUrl: new URL('https://fixture.test/') },
  });
  assert.equal(result.coverage.status, 'inconclusive');
  assert.match(result.coverage.reason, /certificate|TLS/i);
  assert.deepEqual(result.out.passes, []);
});
