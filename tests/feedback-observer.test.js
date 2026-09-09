import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { observeRecordedAddress } from '../server/retest.js';

let server, port, log = [];
test.before(async () => {
  server = http.createServer((req, res) => {
    log.push(req.url);
    const send = (status, headers = {}, body = '') => { res.writeHead(status, { 'content-type': 'text/html', ...headers }); res.end(body); };
    switch (req.url) {
      case '/ok': return send(200, {}, '<h1>ok</h1>');
      case '/missing': return send(404, {}, '<h1>Not Found</h1>');
      case '/challenge': return send(503, { 'cf-mitigated': 'challenge', server: 'cloudflare' }, '<title>Just a moment...</title>');
      case '/private-redirect': return send(302, { location: 'http://target.private/' });
      case '/self-redirect': return send(302, { location: '/self-redirect' });
      default: return send(500, {}, 'error');
    }
  });
  server.listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  port = server.address().port;
});
test.after(() => new Promise((done) => server.close(done)));
test.beforeEach(() => { log = []; });

const resolve = async (url) => ({ ok: url.hostname === '127.0.0.1' });
const allowPort = (p) => String(p) === String(port);
const at = (path) => `http://127.0.0.1:${port}${path}`;

test('a loaded address is observed as working now', async () => {
  const seen = await observeRecordedAddress(at('/ok'), { resolve, allowPort });
  assert.equal(seen.classification, 'working');
  assert.equal(seen.status, 200);
  assert.equal(seen.url, at('/ok'));
  assert.ok(seen.observedAt);
  assert.equal('changed' in seen, false, 'the observer never compares with a baseline');
  assert.equal('previous' in seen, false);
});

test('a 404 is observed as broken on this request only', async () => {
  const seen = await observeRecordedAddress(at('/missing'), { resolve, allowPort });
  assert.equal(seen.classification, 'broken');
  assert.equal(seen.status, 404);
});

test('a refused connection stays inconclusive with its transport reason', async () => {
  const closed = http.createServer();
  closed.listen(0, '127.0.0.1');
  await new Promise((done) => closed.once('listening', done));
  const closedPort = closed.address().port;
  await new Promise((done) => closed.close(done));
  const seen = await observeRecordedAddress(`http://127.0.0.1:${closedPort}/x`, { resolve, allowPort: (p) => String(p) === String(closedPort) });
  assert.equal(seen.classification, 'inconclusive');
  assert.equal(seen.reason, 'refused');
  assert.equal(seen.transport, true);
  assert.equal(seen.status, 0);
});

test('a bot check answer stays inconclusive', async () => {
  const seen = await observeRecordedAddress(at('/challenge'), { resolve, allowPort });
  assert.equal(seen.classification, 'inconclusive');
  assert.equal(seen.reason, 'challenge');
});

test('a redirect to a private address is not followed', async () => {
  const seen = await observeRecordedAddress(at('/private-redirect'), { resolve, allowPort });
  assert.equal(seen.classification, 'inconclusive');
  assert.equal(seen.reason, 'not-allowed');
  assert.deepEqual(log, ['/private-redirect']);
});

test('a redirect loop cannot become working', async () => {
  const seen = await observeRecordedAddress(at('/self-redirect'), { resolve, allowPort });
  assert.equal(seen.classification, 'inconclusive');
  assert.equal(seen.reason, 'redirect-loop');
});

test('production port rules refuse a non-standard port before any request', async () => {
  const seen = await observeRecordedAddress(at('/ok'), { resolve });
  assert.equal(seen.classification, 'inconclusive');
  assert.equal(seen.reason, 'not-allowed');
  assert.deepEqual(log, []);
});

test('addresses that are not public HTTP addresses are refused without a request', async () => {
  for (const raw of ['ftp://example.invalid/', 'not a url', 'https://user:pw@example.invalid/', '', null]) {
    const seen = await observeRecordedAddress(raw, { resolve, allowPort });
    assert.equal(seen.classification, 'inconclusive', String(raw));
    assert.equal(seen.reason, 'invalid-address', String(raw));
  }
  const privateHost = await observeRecordedAddress('http://target.private/', { resolve, allowPort: () => true });
  assert.equal(privateHost.reason, 'not-allowed');
  assert.deepEqual(log, []);
});
