// The live checkup screen: a stage-based progress bar that never reaches 100% before the
// report is delivered, a review stage before delivery, step icons that reset for every new
// checkup, a lock for the security step, and A+ rendered with the A color.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const publicRoot = new URL('../public/', import.meta.url);
const report = (grade) => ({ id: 'runreport' + grade.replace('+', 'plus'), target: 'fixture.example', url: 'https://fixture.example/',
  scannedAt: '2026-09-23T12:00:00.000Z', grade, score: grade === 'C' ? 74 : 100, ringPercent: grade === 'C' ? 74 : 100,
  gradeLabel: grade === 'C' ? 'Worth a look' : 'Looking great', summary: 'Summary for grade ' + grade, tally: {}, passes: ['Homepage answered.'], findings: [], engine: { reporter: 'template' } });

let server, browser, origin;
const streams = []; // open SSE responses, newest last
const streamOpened = []; // resolvers waiting for the next stream
function sse(event, data) {
  const res = streams[streams.length - 1];
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
const nextStream = () => new Promise(resolve => streamOpened.push(resolve));

test.before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = data => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (url.pathname === '/api/checkup/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write(': open\n\n');
      streams.push(res);
      streamOpened.splice(0).forEach(fn => fn());
      return;
    }
    if (url.pathname === '/api/me') return json({ user: { id: 'runner1', emailVerified: true } });
    if (url.pathname === '/api/config') return json({ requireAccount: true, providers: {}, mail: { configured: false }, agent: true });
    if (url.pathname === '/api/reports/runreportAplus') return json(report('A+'));
    if (url.pathname.endsWith('/assessments')) return json({ assessments: {} });
    if (url.pathname.endsWith('/feedback')) return json({ findings: {}, mine: {} });
    if (url.pathname.startsWith('/api/')) return json({ reports: [], count: 0, signals: {}, automatic: {}, posts: [] });
    const file = url.pathname === '/' || url.pathname.startsWith('/r/') ? 'index.html' : url.pathname.slice(1);
    if (!/^[a-z0-9.-]+$/i.test(file)) { res.writeHead(404); return res.end(); }
    try {
      const body = await readFile(new URL(file, publicRoot));
      res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
test.after(async () => {
  for (const res of streams) res.end();
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
});
async function homePage(t) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.setDefaultTimeout(5000); t.after(() => page.close());
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(origin + '/');
  await page.locator('#screen-home.is-active').waitFor();
  return page;
}
async function startCheckup(page) {
  const opened = nextStream();
  await page.locator('#urlInput').fill('fixture.example');
  await page.locator('#startBtn').click();
  await page.locator('#screen-run.is-active').waitFor();
  await opened;
}
const progress = page => page.getByRole('progressbar', { name: 'Checkup progress' });
const value = async page => Number(await progress(page).getAttribute('aria-valuenow'));
const row = (page, key) => page.locator(`#checklist .check-row[data-key="${key}"]`);

test('the progress bar advances by stage and only reaches 100% when the report arrives', async t => {
  const page = await homePage(t);
  await startCheckup(page);
  await progress(page).waitFor();
  assert.equal(await value(page), 0);
  const seen = [];
  for (const key of ['recon', 'plan', 'probe', 'customer', 'report', 'review']) {
    sse('step', { key, status: 'start' });
    await row(page, key).and(page.locator('.active')).waitFor();
    seen.push(await value(page));
    sse('step', { key, status: 'done' });
    await row(page, key).and(page.locator('.done')).waitFor();
    seen.push(await value(page));
  }
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], `progress must not move backwards (${seen.join(', ')})`);
  assert.ok(seen[seen.length - 1] > 80 && seen[seen.length - 1] < 100, `every stage done is still under 100% before delivery (${seen.join(', ')})`);
  assert.ok(await row(page, 'review').locator('.t').textContent(), 'the review stage has a label');
  sse('report', report('C'));
  await page.locator('#runCta.show').waitFor();
  assert.equal(await value(page), 100);
  sse('done', {});
});

test('a report delivered while a stage is still running completes the bar and every row', async t => {
  const page = await homePage(t);
  await startCheckup(page);
  sse('step', { key: 'recon', status: 'start' });
  sse('step', { key: 'recon', status: 'done' });
  sse('step', { key: 'plan', status: 'start' });
  await row(page, 'plan').and(page.locator('.active')).waitFor();
  assert.ok(await value(page) < 100);
  sse('report', report('C'));
  await page.locator('#runCta.show').waitFor();
  assert.equal(await value(page), 100);
  assert.equal(await page.locator('#checklist .check-row.active').count(), 0);
  assert.equal(await page.locator('#checklist .check-row:not(.done)').count(), 0);
  sse('done', {});
});

test('a second checkup starts with every icon, status, and the bar reset', async t => {
  const page = await homePage(t);
  await startCheckup(page);
  for (const key of ['recon', 'plan', 'probe', 'customer', 'report', 'review']) { sse('step', { key, status: 'start' }); sse('step', { key, status: 'done' }); }
  sse('report', report('C'));
  await page.locator('#runCta.show').waitFor();
  sse('done', {});
  assert.equal(await page.locator('#checklist .check-row.done').count(), 6);
  const doneIcons = await page.locator('#checklist .check-icon svg path[d^="M20 6L9 17"]').count();
  assert.equal(doneIcons, 6, 'every row shows a checkmark after the first checkup');
  await page.locator('#viewReportBtn').click();
  await page.locator('#screen-report.is-active').waitFor();
  await page.locator('#backBtn').click();
  await page.locator('#screen-home.is-active').waitFor();
  await startCheckup(page);
  assert.equal(await page.locator('#checklist .check-row.done').count(), 0);
  assert.equal(await page.locator('#checklist .check-row.active').count(), 0);
  assert.equal(await page.locator('#checklist .check-icon svg path[d^="M20 6L9 17"]').count(), 0, 'no checkmark from the earlier checkup persists');
  assert.deepEqual(await page.locator('#checklist [data-status]').allTextContents(), ['waiting', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting']);
  assert.equal(await value(page), 0);
  assert.equal(await page.locator('#runCta.show').count(), 0);
  sse('step', { key: 'probe', status: 'start' });
  await row(page, 'probe').and(page.locator('.active')).waitFor();
  assert.equal(await row(page, 'probe').locator('.check-icon svg.spin').count(), 1, 'the active row shows its spinner again');
  sse('report', report('C'));
  await page.locator('#runCta.show').waitFor();
  sse('done', {});
});

test('the security step is drawn with a lock, and it is restored after a checkup', async t => {
  const page = await homePage(t);
  const lock = () => page.locator('#checklist .check-row[data-key="probe"] .check-icon svg[data-icon-name="lock"]');
  assert.equal(await lock().count(), 1, 'the security row starts with a lock icon');
  assert.equal(await page.locator('#checklist .check-icon svg path[d^="M3 9l9-7"]').count(), 0, 'no house icon remains');
  await startCheckup(page);
  sse('step', { key: 'probe', status: 'start' });
  sse('step', { key: 'probe', status: 'done' });
  sse('report', report('C'));
  await page.locator('#runCta.show').waitFor();
  sse('done', {});
  assert.equal(await lock().count(), 0, 'a completed row shows the checkmark');
  await page.locator('#viewReportBtn').click();
  await page.locator('#screen-report.is-active').waitFor();
  await page.locator('#backBtn').click();
  await page.locator('#screen-home.is-active').waitFor();
  await startCheckup(page);
  assert.equal(await lock().count(), 1, 'the lock is restored for the next checkup');
  sse('report', report('C'));
  await page.locator('#runCta.show').waitFor();
  sse('done', {});
});

test('an A+ grade renders its letter and ring in the A color', async t => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.setDefaultTimeout(5000); t.after(() => page.close());
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(origin + '/r/runreportAplus');
  await page.locator('#screen-report.is-active').waitFor();
  assert.equal(await page.locator('#scorecard .letter').textContent(), 'A+');
  const good = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--good').trim());
  const colors = await page.evaluate(() => ({ letter: getComputedStyle(document.querySelector('#scorecard .letter')).color, ring: getComputedStyle(document.querySelector('#gradeRing')).stroke }));
  const rgb = await page.evaluate(hex => { const d = document.createElement('div'); d.style.color = hex; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; }, good);
  assert.equal(colors.letter, rgb);
  assert.equal(colors.ring, rgb);
});

// ---- report privacy across a session change ----
async function reportPage(t, configure = async () => {}) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.setDefaultTimeout(5000); t.after(() => page.close());
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await configure(page);
  return page;
}
const privateReport = { ...report('C'), id: 'privatereport', visibility: 'private', summary: 'PRIVATE_SUMMARY of the checkup.',
  findings: [{ id: 'broken-links', severity: 'watch', title: 'PRIVATE_FINDING title', meaning: 'A private detail.', source: 'scripted', evidence: { items: [{ url: 'https://fixture.example/contact', status: 404 }], lines: ['404 /contact'] } }] };

test('signing out clears the open report, its address, and its share link', async t => {
  let viewer = { id: 'owner1', emailVerified: true };
  const page = await reportPage(t, async page => {
    await page.route(origin + '/api/me', route => route.fulfill({ json: { user: viewer } }));
    await page.route(origin + '/api/reports/privatereport', route => route.fulfill({ json: privateReport }));
  });
  await page.goto(origin + '/r/privatereport');
  await page.locator('#screen-report.is-active').waitFor();
  await page.getByRole('heading', { name: 'PRIVATE_FINDING title', exact: true }).waitFor();
  assert.match(await page.locator('#shareLink').textContent(), /\/r\/privatereport$/);
  viewer = null;
  await page.evaluate(() => window.Sutros.refreshMe());
  await page.locator('#screen-home.is-active').waitFor();
  assert.equal(new URL(page.url()).pathname, '/');
  assert.equal(await page.getByText('PRIVATE_', { exact: false }).count(), 0, 'no private text remains anywhere on the page');
  assert.equal(await page.locator('#scorecard').innerHTML(), '');
  assert.equal(await page.locator('#findingsRoot').innerHTML(), '');
  assert.equal(await page.locator('#shareLink').textContent(), '');
  assert.equal(await page.evaluate(() => window.Sutros.report), null);
  await page.locator('#viewReportBtn').evaluate(el => el.click());
  assert.equal(await page.getByText('PRIVATE_', { exact: false }).count(), 0, 'the report screen holds nothing after the change');
});

test('a report fetch still in flight when the account changes is never shown', async t => {
  let viewer = { id: 'owner1', emailVerified: true }, release, started;
  const held = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { started = resolve; });
  t.after(() => release());
  let requests = 0;
  const page = await reportPage(t, async page => {
    await page.route(origin + '/api/me', route => route.fulfill({ json: { user: viewer } }));
    // Only the page's own first fetch is held. (community-ui may fetch the same report again
    // from its boot dispatch; that path is owned elsewhere and answers at once here.)
    await page.route(origin + '/api/reports/privatereport', async route => {
      if (++requests > 1) return route.fulfill({ json: privateReport });
      started(); await held; await route.fulfill({ json: privateReport }).catch(() => {});
    });
  });
  await page.goto(origin + '/r/privatereport');
  await requested;
  viewer = { id: 'someoneelse', emailVerified: true };
  await page.evaluate(() => window.Sutros.refreshMe());
  release();
  await page.locator('#screen-home.is-active').waitFor();
  // Let the released answer settle through any handler before checking.
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 150)));
  assert.equal(await page.getByText('PRIVATE_', { exact: false }).count(), 0);
  assert.equal(await page.locator('#screen-report.is-active').count(), 0);
  assert.equal(await page.evaluate(() => window.Sutros.report), null);
  assert.equal(new URL(page.url()).pathname, '/');
});

test('a live checkup stops and its findings leave the screen when the session changes', async t => {
  let viewer = { id: 'owner1', emailVerified: true };
  const page = await reportPage(t, async page => {
    await page.route(origin + '/api/me', route => route.fulfill({ json: { user: viewer } }));
  });
  await page.goto(origin + '/');
  await page.locator('#screen-home.is-active').waitFor();
  await startCheckup(page);
  sse('step', { key: 'recon', status: 'start' });
  sse('log', { mark: '!', text: 'PRIVATE_LIVE finding text' });
  await page.getByText('PRIVATE_LIVE finding text', { exact: true }).waitFor();
  viewer = null;
  await page.evaluate(() => window.Sutros.refreshMe());
  await page.locator('#screen-home.is-active').waitFor();
  assert.equal(await page.getByText('PRIVATE_LIVE', { exact: false }).count(), 0);
  sse('report', privateReport);
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 200)));
  assert.equal(await page.getByText('PRIVATE_', { exact: false }).count(), 0, 'a late report on the closed stream is not shown');
  assert.equal(await page.evaluate(() => window.Sutros.report), null);
});

test('a helper listing is bound to the account that opened the form', async t => {
  let viewer = { id: 'helper1', emailVerified: true };
  const posts = [];
  const page = await reportPage(t, async page => {
    await page.route(origin + '/api/me', route => route.fulfill({ json: { user: viewer } }));
    await page.route(origin + '/api/helpers', route => {
      if (route.request().method() !== 'POST') return route.fulfill({ json: { helpers: [], page: 1, hasMore: false } });
      const expected = route.request().headers()['x-sutros-account'] || null;
      posts.push({ expected, body: route.request().postDataJSON() });
      if (expected && expected !== viewer.id) return route.fulfill({ status: 401, json: { error: 'Your sign-in changed. Reopen the form to continue.', code: 'account-changed' } });
      return route.fulfill({ json: { ok: true, helper: { id: 'h1' } } });
    });
  });
  await page.goto(origin + '/');
  await page.locator('#screen-home.is-active').waitFor();
  await page.evaluate(() => window.openHelpers());
  await page.locator('#screen-helpers.is-active').waitFor();
  await page.locator('#hfName').fill('Pat Helper');
  await page.locator('#hfContact').fill('helper@fixture.example');
  viewer = { id: 'helper2', emailVerified: true };
  await page.evaluate(() => window.Sutros.refreshMe());
  await page.locator('#helperForm button[type="submit"]').click();
  await page.locator('#helperErr.show').waitFor();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].expected, 'helper1', 'the submission names the account that opened the form');
  assert.equal(posts[0].body.name, 'Pat Helper');
  assert.match(await page.locator('#helperErr').textContent(), /sign-in changed/i);
  assert.equal(await page.locator('#hfName').inputValue(), 'Pat Helper', 'the draft is kept for the person to review');
  // Reopening the form binds it to the account now signed in, and the same draft can be sent.
  await page.evaluate(() => window.openHelpers());
  await page.locator('#helperForm button[type="submit"]').click();
  await page.waitForFunction(() => document.getElementById('hfName').value === '');
  assert.equal(posts.length, 2);
  assert.equal(posts[1].expected, 'helper2');
});

