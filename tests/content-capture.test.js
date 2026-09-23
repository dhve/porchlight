import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { aliasedSession } from '../test/helpers/fixture.js';
import { observeRecordedPage } from '../server/wekupBrowser.js';

let server, session, port;
const hits = [];
test.before(async () => {
  session = await aliasedSession('screening.test 127.0.0.1');
  server = http.createServer((req, res) => {
    hits.push({ method: req.method, path: req.url });
    res.setHeader('content-type', 'text/html');
    if (req.url === '/challenge') { res.setHeader('cf-mitigated', 'challenge'); return res.end('<html><title>Just a moment...</title><body>Checking your browser before accessing the site.</body></html>'); }
    if (req.url === '/loading') return res.end('<html><body><div role="progressbar">Loading</div></body></html>');
    if (req.url === '/delayed') return res.end('<html><body><div id="root">Loading</div><script>setTimeout(()=>document.getElementById("root").innerHTML="<h1>Ready for visitors</h1>",5000)</script></body></html>');
    return res.end('<html><body><h1>Public page</h1><div style="height:2200px;background:linear-gradient(#66c,#fff)">A harmless illustration</div><script>fetch("/post",{method:"POST",body:"x"}).catch(()=>{});fetch("http://private.test/private").catch(()=>{})</script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
test.after(async () => { await session?.close(); await new Promise(resolve => server?.close(resolve)); });
const observe = (path, options = {}) => observeRecordedPage({
  url: `http://screening.test:${port}${path}`, siteHost: 'screening.test', view: 'desktop', session,
  resolve: async url => url.hostname === 'screening.test' ? { ok: true, addresses: ['127.0.0.1'] } : { ok: false },
  allowPort: value => value === String(port), budgetMs: 20_000, ...options,
});

test('image samples are opt-in, ephemeral and bounded; browser requests stay guarded', async () => {
  assert.equal((await observe('/')).screening, undefined);
  const result = await observe('/', { captureScreening: true });
  assert.equal(result.screening.status, 'captured');
  assert.equal(result.screening.images.length, 3);
  for (const image of result.screening.images) {
    assert.match(image, /^data:image\/jpeg;base64,/);
    assert.ok(image.length < 2_000_000);
    assert.equal(Buffer.from(image.split(',')[1], 'base64').subarray(0, 2).toString('hex'), 'ffd8');
  }
  assert.equal(hits.some(hit => hit.method !== 'GET' || ['/post', '/private'].includes(hit.path)), false);
});

test('content screening waits for a delayed application before capturing it', async () => {
  const result = await observe('/delayed', { captureScreening: true });
  assert.equal(result.screening.status, 'captured');
  assert.match(result.text, /Ready for visitors/);
  assert.equal(result.screening.readiness.status, 'ready');
  assert.ok(result.screening.readiness.elapsedMs >= 4900);
});

test('a persistent loading shell cannot be treated as a screened website', async () => {
  const result = await observe('/loading', { captureScreening: true });
  assert.equal(result.screening.status, 'unavailable');
  assert.deepEqual(result.screening.images, []);
  assert.equal(result.screening.readiness.status, 'timed-out');
  assert.equal(result.screening.readiness.budgetMs, 7000);
});

test('a bot challenge is not sent to image moderation as website content', async () => {
  const result = await observe('/challenge', { captureScreening: true });
  assert.ok(result.challenged);
  assert.equal(result.screening.status, 'unavailable');
  assert.deepEqual(result.screening.images, []);
});
