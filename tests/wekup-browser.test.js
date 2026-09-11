import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startFixture, aliasedSession } from '../test/helpers/fixture.js';
import { observeRecordedPage, siteOptedOut, guardedFetch } from '../server/wekupBrowser.js';

// Real Chromium visits to local fixture sites under public-looking names. Every request the
// page makes goes through the guarded fetch path in Node, pinned to the resolver's answer,
// so the safety guard is exercised rather than weakened: the resolver marks private.test as
// private and everything else as public at 127.0.0.1.
const SITE = 'fixture.test';
let fixture, session, extra, extraPort, available = true;
const seen = []; // { method, host, path } for every request the extra server received

test.before(async () => {
  try { session = await aliasedSession(`${SITE} 127.0.0.1, MAP cdn.test 127.0.0.1, MAP private.test`); } catch { available = false; return; }
  fixture = await startFixture();
  extra = http.createServer((req, res) => {
    seen.push({ method: req.method, host: String(req.headers.host || '').split(':')[0], path: req.url });
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'text/html', ...headers }); res.end(body); };
    const page = (body, head = '') => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>extra</title>${head}</head><body>${body}</body></html>`;
    const p = new URL(req.url, 'http://x');
    switch (p.pathname) {
      case '/overlay': return send(200, page('<p>Welcome</p><div style="position:fixed;inset:0;background:rgba(0,0,0,.6)"><div style="background:#fff;margin:40px;padding:20px">We use cookies <button>Accept</button> <button aria-label="Close">x</button></div></div>'));
      case '/wide': return send(200, page('<table style="width:1200px"><tr><td>Schedule</td></tr></table>'));
      case '/noviewport': return send(200, '<!doctype html><html><head><title>old</title></head><body><p>Old page</p></body></html>');
      case '/leave': return send(302, '', { location: `http://private.test:${extraPort}/landing` });
      case '/hop': return send(302, '', { location: '/hop2' });
      case '/start': return send(302, '', { location: '/nested/page' });
      case '/nested/page': return send(200, page('<p>Nested page</p>', '<link rel="stylesheet" href="style.css">'));
      case '/nested/style.css': return send(200, 'body{background:#321}', { 'content-type': 'text/css' });
      case '/loop': return send(302, '', { location: '/loop' });
      case '/pics-blocked': return send(200, page('<img src="/limited.png" alt="limited"><img src="/forbidden.png" alt="forbidden"><img src="/gone.png" alt="gone">'));
      case '/limited.png': return send(429, '', { 'content-type': 'image/png', 'retry-after': '30' });
      case '/forbidden.png': return send(403, '', { 'content-type': 'text/html' });
      case '/gone.png': return send(410, '', { 'content-type': 'text/html' });
      case '/hop2': return send(200, page('<p>Second hop</p>'));
      case '/pics': return send(200, page('<img src="/missing.png" alt="gone"><img src="/ok.png" alt="fine">'));
      case '/redirected-style': return send(200, page('<p>Redirected stylesheet</p>', '<link rel="stylesheet" href="/style-start.css">'));
      case '/style-start.css': return send(302, '', { location: '/nested/style.css' });
      case '/valid-pics': return send(200, page('<img src="/valid.png"><img src="/ok.png">'));
      case '/valid.png': res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=', 'base64'));
      case '/resource-hops': return send(200, page(Array.from({ length: 8 }, (_, i) => '<img src="/asset0?i=' + i + '">').join('')));
      case '/asset0': case '/asset1': case '/asset2': case '/asset3': case '/asset4': return send(302, '', { location: '/asset' + (Number(p.pathname.slice(-1)) + 1) + p.search });
      case '/asset5': res.writeHead(404); return res.end('missing');
      case '/slow-images': return send(200, page(Array.from({ length: 7 }, (_, i) => '<img src="/slow-img?i=' + i + '">').join('')));
      case '/slow-img': return setTimeout(() => send(200, 'x', { 'content-type': 'image/png' }), 1200);
      case '/parallel-styles': return send(200, page('<p>Parallel styles</p>', Array.from({ length: 10 }, (_, i) => '<link rel="stylesheet" href="/style.css?i=' + i + '">').join('')));
      case '/parallel-bytes': return send(200, page(Array.from({ length: 8 }, (_, i) => '<img src="/medium?i=' + i + '">').join('')));
      case '/medium': res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.alloc(400_000));
      case '/ok.png': res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.from('89504e470d0a1a0a', 'hex'));
      case '/style.css': return send(200, 'body{background:#123}', { 'content-type': 'text/css' });
      case '/app.js': return send(200, 'window.loaded = 1;', { 'content-type': 'application/javascript' });
      case '/unsafe': return send(200, page(`<p>Unsafe page</p>
        <img src="http://private.test:${extraPort}/private.png">
        <iframe src="http://private.test:${extraPort}/frame"></iframe>
        <img src="/redirect-private-img">
        <form id="f" method="post" action="/form-post"><input name="a" value="b"></form>
        <script>
          fetch('http://private.test:${extraPort}/api').catch(() => {});
          fetch('/post-target', { method: 'POST', body: 'x' }).catch(() => {});
          fetch('/redirect-private').catch(() => {});
          navigator.sendBeacon('/beacon', 'x');
          try { new WebSocket('ws://${SITE}:${extraPort}/ws'); } catch (e) {}
          try { navigator.serviceWorker.register('/sw.js'); } catch (e) {}
          setTimeout(() => document.getElementById('f').submit(), 200);
        </script>`, `<link rel="stylesheet" href="http://cdn.test:${extraPort}/style.css"><script src="http://cdn.test:${extraPort}/app.js"></script>`));
      case '/redirect-private': return send(302, '', { location: `http://private.test:${extraPort}/api` });
      case '/redirect-private-img': return send(302, '', { location: `http://private.test:${extraPort}/landing.png` });
      case '/many': return send(200, page(Array.from({ length: 60 }, (_, i) => `<img src="/dot?i=${i}">`).join('')));
      case '/dot': res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.from('89504e470d0a1a0a', 'hex'));
      case '/bigpage': return send(200, page('<p>Big</p><img src="/big">'));
      case '/big': res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(3_000_000) }); return res.end(Buffer.alloc(3_000_000));
      case '/robots.txt': return send(200, 'User-agent: SutrosBot\nDisallow: /\n', { 'content-type': 'text/plain' });
      case '/robots-hop': return send(302, '', { location: `http://private.test:${extraPort}/robots.txt` });
      default: return send(404, page('<h1>Not Found</h1>'));
    }
  });
  extra.listen(0, '127.0.0.1');
  await new Promise((done) => extra.once('listening', done));
  extraPort = extra.address().port;
});
test.after(async () => {
  if (session) await session.close();
  if (fixture) await fixture.close();
  if (extra) await new Promise((done) => extra.close(done));
});
test.beforeEach(() => { seen.length = 0; });

const ready = (t) => { if (!available) { t.skip('Playwright Chromium is not available.'); return false; } return true; };
const resolve = async (u) => (u.hostname === 'private.test' ? { ok: false, error: 'private' } : { ok: true, addresses: ['127.0.0.1'] });
const ports = () => [String(fixture.port), String(extraPort)];
const observe = (path, view = 'phone', port = fixture.port, more = {}) => observeRecordedPage({ url: `http://${SITE}:${port}${path}`, view, siteHost: SITE, session, resolve,
  allowPort: (p) => ports().includes(String(p)), budgetMs: 20_000, ...more });

test('a healthy page is observed with its text, render state, and phone measurements', async (t) => {
  if (!ready(t)) return;
  const o = await observe('/healthy');
  assert.equal(o.status, 200);
  assert.equal(o.challenged, null);
  assert.deepEqual([o.render.reliable, o.render.linked, o.render.applied], [true, 1, 1]);
  assert.match(o.text, /Welcome to the fixture site/);
  assert.equal(o.viewportMeta, true);
  assert.equal(o.overflow.innerWidth, 390);
  assert.equal(o.overflow.scrollWidth <= 398, true);
  assert.equal(o.overlay.present, false);
  assert.equal(o.view, 'phone');
  assert.ok(o.controls.some((c) => c.text === 'Contact'));
  assert.equal(fixture.hits('/healthy'), 1, 'one visit');
  assert.equal(o.finalUrl, `http://${SITE}:${fixture.port}/healthy`);
});

test('a desktop view uses a desktop width', async (t) => {
  if (!ready(t)) return;
  const o = await observe('/healthy', 'desktop');
  assert.equal(o.view, 'desktop');
  assert.ok(o.overflow.innerWidth >= 1200);
});

test('bot checks, unrendered pages, error pages, and rate limits are reported as such', async (t) => {
  if (!ready(t)) return;
  const challenged = await observe('/sgdoc');
  assert.ok(challenged.challenged, 'a SiteGround interstitial is recognised');
  const unrendered = await observe('/broken');
  assert.equal(unrendered.status, 200);
  assert.equal(unrendered.render.reliable, false);
  assert.match(unrendered.render.reason, /404|stylesheet/i);
  assert.equal((await observe('/error')).status, 500);
  assert.equal((await observe('/limited')).status, 429);
  const bare = await observe('/bare');
  assert.deepEqual([bare.render.reliable, bare.render.linked], [true, 0]);
});

test('overlays, overflow, missing viewport settings, and image failures are measured', async (t) => {
  if (!ready(t)) return;
  const overlay = await observe('/overlay', 'phone', extraPort);
  assert.equal(overlay.overlay.present, true);
  assert.ok(overlay.overlay.coversPercent >= 40);
  assert.equal(overlay.overlay.closeControl, true);
  const wide = await observe('/wide', 'phone', extraPort);
  assert.ok(wide.overflow.scrollWidth > wide.overflow.innerWidth + 8);
  const old = await observe('/noviewport', 'phone', extraPort);
  assert.equal(old.viewportMeta, false);
  const pics = await observe('/pics', 'desktop', extraPort, { images: [`http://${SITE}:${extraPort}/missing.png`, `http://${SITE}:${extraPort}/ok.png`] });
  assert.deepEqual(pics.images.map((i) => [i.status, i.outcome]), [[404, 'broken'], [200, 'unavailable']], 'the short PNG fixture does not decode despite its HTTP success');
  const blocked = await observe('/pics-blocked', 'desktop', extraPort, { images: ['/limited.png', '/forbidden.png', '/gone.png'].map((p) => `http://${SITE}:${extraPort}${p}`) });
  assert.deepEqual(blocked.images.map((i) => i.outcome), ['unavailable', 'unavailable', 'broken'], 'rate limits and refusals are not broken images');
  const cut = await observe('/bigpage', 'phone', extraPort, { maxResponseBytes: 200_000, images: [`http://${SITE}:${extraPort}/big`] });
  assert.deepEqual(cut.images.map((i) => i.outcome), ['unavailable'], 'an image the checker itself cut off is not a broken image');
});

test('every request is guarded: no private host, no redirect to one, no method but GET or HEAD, no sockets', async (t) => {
  if (!ready(t)) return;
  const o = await observe('/unsafe', 'phone', extraPort);
  assert.equal(o.status, 200);
  assert.match(o.text, /Unsafe page/);
  assert.deepEqual([o.render.reliable, o.render.linked, o.render.applied], [true, 1, 1], 'the public cross-origin stylesheet loaded');
  assert.ok(seen.some((r) => r.host === 'cdn.test' && r.path === '/style.css'));
  assert.ok(seen.some((r) => r.host === 'cdn.test' && r.path === '/app.js'));
  assert.deepEqual(seen.filter((r) => r.host === 'private.test'), [], 'nothing reached the private host, directly or through a redirect');
  assert.deepEqual(seen.filter((r) => r.method !== 'GET' && r.method !== 'HEAD'), [], 'no POST reached the site');
  for (const path of ['/post-target', '/beacon', '/form-post', '/ws', '/sw.js', '/landing.png', '/api', '/landing']) assert.equal(seen.some((r) => r.path === path), false, path);
  assert.ok(o.requests.denied >= 3, 'denied requests are counted');
  assert.equal(o.finalUrl, `http://${SITE}:${extraPort}/unsafe`, 'the form submission did not navigate the page');
});

test('redirects are validated before they are followed, hop by hop', async (t) => {
  if (!ready(t)) return;
  const left = await observe('/leave', 'phone', extraPort);
  assert.equal(left.blocked, 'not-allowed');
  assert.equal(seen.some((r) => r.path === '/landing'), false);
  const hopped = await observe('/hop', 'phone', extraPort);
  assert.equal(hopped.status, 200);
  assert.equal(hopped.finalUrl, `http://${SITE}:${extraPort}/hop2`);
  assert.match(hopped.text, /Second hop/);
});

test('after a validated redirect the browser resolves relative addresses against the final page', async (t) => {
  if (!ready(t)) return;
  const o = await observe('/start', 'phone', extraPort);
  assert.equal(o.status, 200);
  assert.equal(o.finalUrl, `http://${SITE}:${extraPort}/nested/page`);
  assert.match(o.text, /Nested page/);
  assert.ok(seen.some((r) => r.path === '/nested/style.css'), 'the stylesheet was fetched relative to the redirected page');
  assert.equal(seen.some((r) => r.path === '/style.css'), false, 'nothing was fetched relative to the original address');
  assert.deepEqual([o.render.reliable, o.render.linked, o.render.applied], [true, 1, 1]);
});

test('a redirect loop is cut off after a bounded number of hops', async (t) => {
  if (!ready(t)) return;
  const o = await observe('/loop', 'phone', extraPort);
  assert.ok(o.blocked || o.error, 'the loop does not produce a page');
  assert.ok(seen.filter((r) => r.path === '/loop').length <= 7, 'hops are bounded');
});

test('addresses outside the site, on other ports, or without a public answer are never visited', async (t) => {
  if (!ready(t)) return;
  const other = await observeRecordedPage({ url: 'http://other.invalid/', view: 'phone', siteHost: SITE, session, resolve, allowPort: () => true, budgetMs: 5000 });
  assert.equal(other.blocked, 'not-allowed');
  const port = await observeRecordedPage({ url: `http://${SITE}:${fixture.port}/healthy`, view: 'phone', siteHost: SITE, session, resolve, budgetMs: 5000 });
  assert.equal(port.blocked, 'not-allowed', 'production port rules refuse a non-standard port');
  assert.equal((await observeRecordedPage({ url: 'ftp://x/', view: 'phone', siteHost: SITE, session, resolve })).blocked, 'not-allowed');
  const before = fixture.hits('/healthy');
  const unresolved = await observeRecordedPage({ url: `http://${SITE}:${fixture.port}/healthy`, view: 'phone', siteHost: SITE, session, resolve: async () => ({ ok: true }), allowPort: () => true, budgetMs: 5000 });
  assert.equal(unresolved.blocked, 'not-allowed', 'a resolver answer without an address pins nothing and is refused');
  assert.equal(fixture.hits('/healthy'), before, 'no request was made for any refused address');
});

test('request counts, response bytes, and the total time are bounded', async (t) => {
  if (!ready(t)) return;
  const many = await observe('/many', 'phone', extraPort, { maxRequests: 12 });
  assert.equal(many.status, 200);
  assert.ok(many.requests.count <= 12);
  assert.ok(many.requests.aborted >= 1);
  const big = await observe('/bigpage', 'phone', extraPort, { maxResponseBytes: 200_000 });
  assert.equal(big.status, 200);
  assert.ok(big.requests.aborted >= 1, 'the oversized image was cut off');
  const started = Date.now();
  const late = await observe('/healthy', 'phone', fixture.port, { budgetMs: 1 });
  assert.equal(late.error, 'timeout');
  assert.ok(Date.now() - started < 5000);
});

test('the guarded fetch pins the connection to the resolver answer and bounds bytes', async (t) => {
  if (!ready(t)) return;
  const ok = await guardedFetch({ url: new URL(`http://${SITE}:${extraPort}/style.css`), ip: '127.0.0.1', maxBytes: 1000, timeoutMs: 3000 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.toString(), 'body{background:#123}');
  const cut = await guardedFetch({ url: new URL(`http://${SITE}:${extraPort}/big`), ip: '127.0.0.1', maxBytes: 1000, timeoutMs: 3000 });
  assert.equal(cut.truncated, true);
  await assert.rejects(guardedFetch({ url: new URL(`http://${SITE}:${extraPort}/style.css`), ip: '127.0.0.1', method: 'POST', maxBytes: 1000, timeoutMs: 3000 }), /method/i);
});

test('opt-out lookups validate the host and every redirect instead of following blindly', async (t) => {
  if (!ready(t)) return;
  const fetchFor = (path) => async ({ url }) => { seen.push({ method: 'GET', host: url.hostname, path: url.pathname }); return guardedFetch({ url: new URL(`http://${SITE}:${extraPort}${url.pathname === '/robots.txt' && path ? path : url.pathname}`), ip: '127.0.0.1', maxBytes: 20000, timeoutMs: 3000 }); };
  assert.equal(await siteOptedOut(SITE, { resolveTxt: async () => { throw new Error('none'); }, resolve, fetchGuarded: fetchFor('/robots.txt') }), 'robots');
  assert.equal(await siteOptedOut(SITE, { resolveTxt: async () => [['optout']], resolve, fetchGuarded: async () => { throw new Error('should not fetch'); } }), 'dns');
  seen.length = 0;
  assert.equal(await siteOptedOut(SITE, { resolveTxt: async () => [], resolve, fetchGuarded: fetchFor('/robots-hop') }), null, 'a redirect to a private host is not followed');
  assert.equal(seen.some((r) => r.host === 'private.test'), false);
  assert.equal(await siteOptedOut('private.test', { resolveTxt: async () => [], resolve, fetchGuarded: async () => { throw new Error('should not fetch'); } }), null, 'a host that does not resolve publicly is never fetched');
});

test('a successful image response needs browser decoding before it counts as loaded', async t => {
  if (!ready(t)) return;
  const o = await observe('/valid-pics', 'desktop', extraPort, { images: [`http://${SITE}:${extraPort}/valid.png`, `http://${SITE}:${extraPort}/ok.png`] });
  assert.deepEqual(o.images.map(i => [i.status, i.outcome]), [[200, 'loaded'], [200, 'unavailable']]);
});

test('redirected stylesheets leave rendering inconclusive when resource bases cannot be preserved', async t => {
  if (!ready(t)) return;
  const o = await observe('/redirected-style', 'phone', extraPort);
  assert.equal(o.status, 200);
  assert.equal(o.render.reliable, false);
  assert.match(o.render.reason, /redirect/i);
});

test('resource redirect hops and concurrent responses share the visit budgets', async t => {
  if (!ready(t)) return;
  const styles = await observe('/parallel-styles', 'phone', extraPort, { maxTotalBytes: 1_000_000 });
  assert.deepEqual([styles.render.reliable, styles.render.linked, styles.render.applied], [true, 10, 10]);
  seen.length = 0;
  const hops = await observe('/resource-hops', 'phone', extraPort, { maxRequests: 6 });
  assert.ok(seen.length <= 6, 'each redirected network request counts against the visit limit');
  assert.ok(hops.requests.count <= 6);
  const bytes = await observe('/parallel-bytes', 'phone', extraPort, { maxTotalBytes: 500_000 });
  assert.ok(bytes.requests.bytes <= 500_000, 'parallel downloads cannot overspend the shared byte budget');
  assert.ok(bytes.requests.aborted > 0);
});

test('closing the observation cancels active downloads and never starts waiting requests', async t => {
  if (!ready(t)) return;
  await observe('/slow-images', 'phone', extraPort, { maxTotalBytes: 3000, maxResponseBytes: 1000 });
  const atCompletion = seen.length;
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(seen.length, atCompletion, 'network work must stop when the observation finishes');
});
