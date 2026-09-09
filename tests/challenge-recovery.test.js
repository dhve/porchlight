import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createClient, probeAddress } from '../server/lib/http.js';
import { runRecon } from '../server/checks/recon.js';
import { observeCheck } from '../server/provenance.js';
import { createRetestRouter } from '../server/retest.js';

const challenge = '<html><head><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?check=1"></head></html>';
const htmlHeaders = { 'content-type': 'text/html' };

for (const headFirst of [true, false]) test(`HTTP 200 challenge is blocked with headFirst=${headFirst}`, async t => {
  t.mock.method(globalThis, 'fetch', async (_url, { method }) => new Response(method === 'HEAD' ? null : challenge, { status: 200, headers: htmlHeaders }));
  const result = await probeAddress(createClient(), 'https://fixture.example/page', { headFirst });
  assert.equal(result.verdict, 'blocked');
  assert.equal(result.reason, 'challenge');
});

for (const [contentType, body] of [['text/html', '<html><body>Ordinary page</body></html>'], ['application/json', '{"ok":true}']]) {
  test(`ordinary successful ${contentType} response remains working`, async t => {
    t.mock.method(globalThis, 'fetch', async (_url, { method }) => new Response(method === 'HEAD' ? null : body, { status: 200, headers: { 'content-type': contentType } }));
    assert.equal((await probeAddress(createClient(), 'https://fixture.example/page')).verdict, 'ok');
  });
}

test('successful HTML challenge inspection reads a bounded prefix and cancels', async t => {
  let pulled = 0, cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    pull(controller) { pulled++; controller.enqueue(new TextEncoder().encode('x'.repeat(4096))); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { status: 200, headers: htmlHeaders }));
  assert.equal((await probeAddress(createClient(), 'https://fixture.example/page', { headFirst: false })).verdict, 'ok');
  assert.ok(pulled > 0, 'the HTML body must be inspected');
  assert.ok(pulled <= 3, 'at most the chunks needed for the 8193-byte prefix are requested');
  assert.equal(cancelled, true);
});

test('secondary recon challenge retains run facts and stops later discovery', async t => {
  const paths = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const path = new URL(url).pathname; paths.push(path);
    if (path === '/') return new Response('<html><a href="/first">First</a><a href="/second">Second</a></html>', { status: 200, headers: htmlHeaders });
    if (path === '/robots.txt') return new Response('User-agent: *\n', { status: 200, headers: { 'content-type': 'text/plain' } });
    return new Response(path === '/first' ? challenge : '<html>Second page</html>', { status: path === '/first' ? 202 : 200, headers: htmlHeaders });
  });
  const result = await observeCheck('recon', runRecon, { client: createClient(), url: new URL('https://fixture.example/') });
  assert.equal(result.coverage.status, 'inconclusive');
  assert.match(result.out.facts.challenged || '', /bot check/i);
  assert.match(result.coverage.reason, /bot check/i);
  assert.deepEqual(paths, ['/', '/robots.txt', '/first']);
  assert.deepEqual(result.out.passes, []);
});

test('a robots challenge stops the crawl and is preserved without an observer', async t => {
  const paths = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const path = new URL(url).pathname; paths.push(path);
    return new Response(path === '/' ? '<html><a href="/later">Later</a></html>' : challenge, { status: 200, headers: htmlHeaders });
  });
  const result = await runRecon({ client: createClient(), url: new URL('https://fixture.example/') });
  assert.equal(result.status, 'inconclusive');
  assert.match(result.facts.challenged || '', /bot check/i);
  assert.deepEqual(paths, ['/', '/robots.txt']);
});

test('the observer attaches a body challenge to facts created by the check', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(challenge, { status: 200, headers: htmlHeaders }));
  const result = await observeCheck('recon', async ctx => {
    await (await ctx.client.get('https://fixture.example/')).text();
    return { findings: [], passes: [], facts: { reachable: true } };
  }, { client: createClient() });
  assert.match(result.out.facts.challenged || '', /bot check/i);
  assert.match(result.coverage.reason, /bot check/i);
});

test('a 200 HTML challenge cannot turn a recorded 404 into a repair', async t => {
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async () => new Response(challenge, { status: 200, headers: htmlHeaders }));
  const app = express(); app.use(express.json());
  app.use(createRetestRouter({ dbOn: () => true, loadReport: async () => ({ findings: [{ id: 'broken-links', evidence: { items: [{ url: 'https://fixture.example/missing', status: 404 }] } }] }),
    resolve: async () => ({ ok: true }), consumeFn: () => ({ ok: true }), saveAttempt: async () => null }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await nativeFetch(`http://127.0.0.1:${server.address().port}/api/reports/fixture1/retest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ findingId: 'broken-links' }) });
  const result = await response.json();
  assert.equal(result.items[0].classification, 'inconclusive');
  assert.equal(result.items[0].changed, null);
  assert.equal(result.items[0].reason, 'challenge');
});
