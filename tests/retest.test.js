import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import * as retest from '../server/retest.js';

const address = 'https://example.invalid/missing';
const finding = (overrides = {}) => ({ id: 'broken-links', severity: 'watch', evidence: { items: [{ url: address, status: 404, kind: 'link' }] }, ...overrides });

async function run(f, response) {
  const app = express();
  app.use(express.json());
  const report = { id: 'report01', target: 'example.invalid', url: 'https://example.invalid/', findings: [f] };
  app.use(retest.createRetestRouter({
    loadReport: async () => report, dbOn: () => true,
    resolve: async (u) => ({ ok: !u.hostname.endsWith('.private') }),
    makeClient: () => ({ get: async (url) => {
      if (response instanceof Error) throw response;
      const out = typeof response === 'function' ? response(url) : response;
      return { status: out.status, headers: new Headers(out.headers || {}), discard() {} };
    } }),
    consumeFn: () => ({ ok: true }), ipFn: () => 'fixture', gapMs: 0,
    saveAttempt: async () => 'attempt01',
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/reports/report01/retest`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ findingId: f.id }),
    });
    return { status: res.status, body: await res.json() };
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

for (const [name, status, classification, changed] of [
  ['repeated 404 remains broken', 404, 'broken', false],
  ['404 followed by 200 is working', 200, 'working', true],
  ['access refusal stays inconclusive', 403, 'inconclusive', null],
  ['rate limiting stays inconclusive', 429, 'inconclusive', null],
  ['service refusal stays inconclusive', 503, 'inconclusive', null],
]) test(name, async () => {
  const { status: code, body } = await run(finding(), { status });
  assert.equal(code, 200);
  assert.equal(body.scope, 'http-availability');
  assert.equal(body.items[0].classification, classification);
  assert.equal(body.items[0].changed, changed);
  assert.equal(body.items[0].status, status);
  assert.equal(body.attemptId, 'attempt01');
});

test('a timeout does not claim the original problem persisted', async () => {
  const error = Object.assign(new Error('fixture timeout'), { code: 'TIMEOUT' });
  const { body } = await run(finding(), error);
  assert.equal(body.items[0].classification, 'inconclusive');
  assert.equal(body.items[0].changed, null);
});

test('a loaded address with an unknown original status cannot produce a change verdict', async () => {
  const f = finding({ evidence: { items: [{ url: address, status: 0, kind: 'link' }] } });
  const { body } = await run(f, { status: 200 });
  assert.equal(body.items[0].classification, 'working');
  assert.equal(body.items[0].ok, true);
  assert.equal(body.items[0].changed, null);
  assert.equal(body.items[0].status, 200);
  assert.equal(body.items[0].comparisonReason, 'unknown-baseline');
  assert.equal(body.verifierVersion, 'http-availability-v2');
});

test('an unknown original status preserves current HTTP errors and connection failure reasons', async () => {
  const f = finding({evidence:{items:[{url:address,status:0,kind:'link'}]}});
  const error = (await run(f, {status:404})).body.items[0];
  assert.equal(error.classification, 'broken');
  assert.equal(error.changed, null);
  assert.equal(error.status, 404);
  const timedOut = (await run(f, Object.assign(new Error('fixture timeout'),{code:'TIMEOUT'}))).body.items[0];
  assert.equal(timedOut.classification, 'inconclusive');
  assert.equal(timedOut.changed, null);
  assert.equal(timedOut.reason, 'timeout');
  assert.equal(timedOut.comparisonReason, 'unknown-baseline');
});

test('a redirect cycle cannot produce a working verdict', async () => {
  const { body } = await run(finding(), { status: 302, headers: { location: address } });
  assert.equal(body.items[0].classification, 'inconclusive');
  assert.equal(body.items[0].reason, 'redirect-loop');
  assert.equal(body.items[0].changed, null);
});

test('exhausted redirects cannot produce a working verdict', async () => {
  let hop = 0;
  const { body } = await run(finding(), () => ({ status: 302, headers: { location: `/hop${++hop}` } }));
  assert.equal(body.items[0].classification, 'inconclusive');
  assert.equal(body.items[0].reason, 'redirect-limit');
});

test('every redirect target must pass the public-address guard', async () => {
  const { body } = await run(finding(), { status: 302, headers: { location: 'http://target.private/' } });
  assert.equal(body.items[0].classification, 'inconclusive');
  assert.equal(body.items[0].changed, null);
});

for (const id of ['agent-layout', 'missing-security-headers', 'exposed-env', 'exposed-source-maps', 'broken-images-render', 'slow-load']) {
  test(`${id} cannot be adjudicated with a generic GET`, async () => {
    const { status, body } = await run(finding({ id }), { status: 200 });
    assert.equal(status, 422);
    assert.match(body.error, /availability|recheck|supported/i);
  });
}

test('the capability export rejects an agent even with an availability ID', () => {
  assert.equal(typeof retest.retestCapability, 'function');
  assert.deepEqual(retest.retestCapability(finding()).supported, true);
  assert.equal(retest.retestCapability(finding({ source: 'agent' })).supported, false);
});
