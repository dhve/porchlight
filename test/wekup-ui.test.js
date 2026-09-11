import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const publicRoot = new URL('../public/', import.meta.url);
const report = { id: 'wekupreport', target: 'fixture.example', url: 'https://fixture.example/',
  scannedAt: '2026-09-11T12:00:00.000Z', grade: 'C', score: 74, ringPercent: 74,
  gradeLabel: 'Worth a look', summary: 'An address returned an error.', tally: { watch: 1 }, passes: [],
  findings: [{ id: 'broken-links', severity: 'watch', title: 'A link returned an error',
    meaning: 'The contact address returned 404 during the check.', source: 'scripted',
    evidence: { items: [{ url: 'https://fixture.example/contact', status: 404 }], lines: ['404 /contact'] } }],
  engine: { reporter: 'template' } };
const assessment = { id: 'newassessment', findingId: 'broken-links', status: 'not-reproduced',
  summary: 'The sampled address loaded during this check.', checkedAt: '2026-09-11T13:00:00.000Z',
  method: 'Requested the recorded address.', evidence: [{ url: 'https://fixture.example/contact', detail: 'HTTP 200' }],
  lessons: [{ id: 'availability-history-not-rewritten', scope: 'site', text: 'Separate current observations from earlier evidence.' }] };
const empty = () => ({ conversationId: null, reportId: report.id, findingId: 'broken-links', revision: 0, messages: [], job: null, assessment: null });
let server, browser, origin;
test.before(async () => {
  server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const json = data => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (pathname === '/api/reports/' + report.id) return json(report);
    if (pathname === '/api/me') return json({ user: { id: 'reader1', emailVerified: true } });
    if (pathname === '/api/config') return json({ requireAccount: true, providers: {}, mail: { configured: false } });
    if (pathname.endsWith('/assessments')) return json({ assessments: {} });
    if (pathname.endsWith('/wekup')) return json(empty());
    if (pathname.endsWith('/feedback')) return json({ findings: {}, mine: {} });
    if (pathname.startsWith('/api/')) return json({ reports: [], signals: {}, automatic: {}, posts: [] });
    const file = pathname === '/' || pathname.startsWith('/r/') ? 'index.html' : pathname.slice(1);
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
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
});
async function pageFor(t, configure = async () => {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(4000); t.after(() => page.close());
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await configure(page);
  await page.goto(origin + '/r/' + report.id);
  await page.locator('#screen-report.is-active').waitFor();
  return page;
}
async function discuss(page) {
  await page.getByRole('button', { name: 'Discuss with wekup', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'wekup', exact: true });
  await panel.waitFor(); return panel;
}

test('a private challenge updates the finding live, keeps the original and preserves the next draft', async t => {
  let state = empty(), sent, finish = false;
  const page = await pageFor(t, async page => {
    await page.route(origin + '/api/reports/wekupreport/wekup*', async route => {
      if (route.request().method() === 'POST') {
        sent = route.request().postDataJSON();
        state = { ...empty(), conversationId: 'convo1', revision: 1,
          messages: [{ id: 'user1', role: 'user', text: sent.message, createdAt: '2026-09-11T12:59:00Z' }],
          job: { status: 'queued', stage: 'Waiting to verify the evidence' } };
        return route.fulfill({ status: 202, json: state });
      }
      if (finish) state = { ...state, revision: 2, job: { status: 'completed', stage: 'Check complete' }, assessment,
        messages: [...state.messages.filter(m => m.role === 'user'), { id: 'reply1', role: 'assistant',
          text: 'The address works now. That does not prove the earlier 404 was wrong.', createdAt: '2026-09-11T13:00:00Z' }] };
      return route.fulfill({ json: state });
    });
  });
  const panel = await discuss(page);
  await panel.getByLabel('Message wekup').fill('This link works on my laptop. <img src=x onerror=alert(1)>');
  await panel.getByRole('button', { name: 'Send message', exact: true }).click();
  await panel.getByText('Waiting to verify the evidence', { exact: true }).waitFor();
  assert.equal(sent.findingId, 'broken-links');
  assert.match(sent.requestId, /^[0-9a-f-]{36}$/i);
  await panel.getByLabel('Message wekup').fill('Please also check the menu.');
  finish = true;
  await panel.getByText('The address works now. That does not prove the earlier 404 was wrong.', { exact: true }).waitFor();
  assert.equal(await panel.getByLabel('Message wekup').inputValue(), 'Please also check the menu.');
  assert.equal(await panel.locator('img').count(), 0);
  assert.equal(await page.locator('.wekup-assessment[data-finding="broken-links"]').getByText(assessment.summary, { exact: true }).isVisible(), true);
  assert.equal(await page.locator('#scorecard .letter').textContent(), 'C');
  assert.equal(await page.getByRole('heading', { name: 'A link returned an error', exact: true }).count(), 1);
  const box = await panel.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844);
  const send = await panel.getByRole('button', { name: 'Send message', exact: true }).boundingBox();
  assert.ok(send.y + send.height <= 844, 'composer must fit on a phone');
});

test('anonymous readers can open wekup, then sign in with the finding return path', async t => {
  let chatRequests = 0;
  const page = await pageFor(t, async page => {
    await page.route(origin + '/api/me', route => route.fulfill({ json: { user: null } }));
    page.on('request', req => { if (new URL(req.url()).pathname.endsWith('/wekup')) chatRequests++; });
  });
  const panel = await discuss(page);
  await panel.getByRole('button', { name: 'Sign in to talk', exact: true }).click();
  assert.match(new URL(page.url()).pathname, /^\/login$/);
  assert.equal(new URL(page.url()).searchParams.get('next'), '/r/wekupreport?wekup=broken-links');
  assert.equal(chatRequests, 0);
});

test('keyboard dismissal returns focus and reopening preserves the unsent message', async t => {
  const page = await pageFor(t);
  const panel = await discuss(page);
  await panel.getByLabel('Message wekup').fill('An unfinished question');
  await panel.getByLabel('Message wekup').press('Escape');
  assert.equal(await panel.isVisible(), false);
  assert.equal(await page.getByRole('button', { name: 'Discuss with wekup', exact: true }).evaluate(el => el === document.activeElement), true);
  await discuss(page);
  assert.equal(await panel.getByLabel('Message wekup').inputValue(), 'An unfinished question');
});

test('public assessments are visible without access to private conversation messages', async t => {
  const page = await pageFor(t, async page => {
    await page.route(origin + '/api/me', route => route.fulfill({ json: { user: null } }));
    await page.route(origin + '/api/reports/wekupreport/assessments', route => route.fulfill({ json: { assessments: { 'broken-links': assessment } } }));
  });
  await page.locator('.wekup-assessment[data-finding="broken-links"]').getByText(assessment.summary, { exact: true }).waitFor();
  assert.equal(await page.locator('#scorecard .letter').textContent(), 'C');
  assert.equal(await page.getByText('Private messages from another account').count(), 0);
});

test('an account change clears private history and rejects a delayed conversation response', async t => {
  let viewer = { id: 'reader1', emailVerified: true }, release;
  const held = new Promise(resolve => { release = resolve; });
  let started; const requested = new Promise(resolve => { started = resolve; });
  const page = await pageFor(t, async page => {
    await page.route(origin + '/api/me', route => route.fulfill({ json: { user: viewer } }));
    await page.route(origin + '/api/reports/wekupreport/wekup*', async route => {
      started(); await held;
      await route.fulfill({ json: { ...empty(), revision: 4, messages: [{ id: 'private1', role: 'user', text: 'A private account detail' }] } }).catch(() => {});
    });
  });
  const panel = await discuss(page); await requested;
  viewer = null;
  await page.evaluate(() => window.Sutros.refreshMe());
  release();
  await panel.getByRole('button', { name: 'Sign in to talk', exact: true }).waitFor();
  assert.equal(await page.getByText('A private account detail', { exact: true }).count(), 0);
});

test('an older conversation read cannot overwrite a newly submitted result', async t => {
  let release, started, reads = 0;
  const held = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { started = resolve; });
  t.after(() => release());
  const newer = { ...empty(), conversationId: 'convo1', revision: 3, assessment,
    messages: [{ id: 'latest', role: 'assistant', text: 'The new observation is available.' }], job: { status: 'completed' } };
  const page = await pageFor(t, async page => {
    await page.route(origin + '/api/reports/wekupreport/wekup*', async route => {
      if (route.request().method() === 'POST') return route.fulfill({ status: 202, json: newer });
      if (++reads === 1) { started(); await held; return route.fulfill({ json: { ...empty(), revision: 1, messages: [{ id: 'old', role: 'assistant', text: 'Outdated conversation' }] } }).catch(() => {}); }
      return route.fulfill({ json: newer });
    });
  });
  const panel = await discuss(page); await requested;
  await panel.getByLabel('Message wekup').fill('Please check again.');
  await panel.getByRole('button', { name: 'Send message', exact: true }).click();
  await panel.getByText('The new observation is available.', { exact: true }).waitFor();
  release();
  // Another DOM action allows the held request to settle without a timing sleep.
  await panel.getByLabel('Message wekup').fill('My next question');
  assert.equal(await panel.getByText('Outdated conversation', { exact: true }).count(), 0);
  assert.equal(await panel.getByText('The new observation is available.', { exact: true }).isVisible(), true);
});

test('retrying an uncertain submission after reopening uses the same request id', async t => {
  const requests = [];
  const page = await pageFor(t, async page => {
    await page.route(origin + '/api/reports/wekupreport/wekup*', route => {
      if (route.request().method() === 'POST') {
        requests.push(route.request().postDataJSON());
        if (requests.length === 1) return route.abort('failed');
        return route.fulfill({ status: 202, json: { ...empty(), revision: 1,
          messages: [{ id: 'saved', role: 'user', text: requests[0].message }], job: { status: 'queued', stage: 'Request recovered' } } });
      }
      return route.fulfill({ json: empty() });
    });
  });
  const panel = await discuss(page);
  await panel.getByLabel('Message wekup').fill('It works for me.');
  await panel.getByRole('button', { name: 'Send message', exact: true }).click();
  await panel.getByRole('alert').waitFor();
  await panel.getByRole('button', { name: 'Close wekup', exact: true }).click();
  await discuss(page);
  assert.equal(await panel.getByLabel('Message wekup').inputValue(), 'It works for me.');
  await panel.getByRole('button', { name: 'Send message', exact: true }).click();
  await panel.getByText('Request recovered', { exact: true }).waitFor();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].requestId, requests[0].requestId, 'an ambiguous network failure must not create duplicate verification work');
});

test('technical terms in a wekup reply open their definition without losing the conversation', async t => {
  const page = await pageFor(t, async page => {
    await page.route(origin + '/api/reports/wekupreport/wekup*', route => route.fulfill({ json: {
      ...empty(), revision: 2, messages: [{ id: 'termreply', role: 'assistant', text: 'The robots.txt file gives crawlers instructions.' }],
    } }));
  });
  const panel = await discuss(page);
  await panel.getByRole('button', { name: 'Define robots.txt', exact: true }).click();
  const definition = page.locator('.definition-dialog');
  assert.equal(await definition.isVisible(), true);
  await definition.getByRole('button', { name: 'Close definition' }).click();
  assert.equal(await panel.isVisible(), true);
  assert.equal(await panel.getByText('The robots.txt file gives crawlers instructions.', { exact: true }).isVisible(), true);
});

test('a cached report is attached when the chat script finishes loading later', async t => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.setDefaultTimeout(4000); t.after(() => page.close());
  let release; const held = new Promise(resolve => { release = resolve; }); t.after(() => release());
  await page.route(origin + '/wekup-ui.js', async route => { await held; await route.continue().catch(() => {}); });
  const navigation = page.goto(origin + '/r/' + report.id);
  await page.locator('#screen-report.is-active').waitFor();
  release(); await navigation;
  await page.getByRole('button', { name: 'Discuss with wekup', exact: true }).waitFor();
  const panel = await discuss(page);
  assert.equal(await panel.getByLabel('Message wekup').isVisible(), true);
});

test('switching accounts in another tab clears a draft before resuming or sending', async t => {
  let viewer = { id: 'reader1', emailVerified: true };
  const sent = [];
  const page = await pageFor(t, async page => {
    await page.route(origin + '/api/me', route => route.fulfill({ json: { user: viewer } }));
    await page.route(origin + '/api/reports/wekupreport/wekup*', route => {
      if (route.request().method() === 'POST') sent.push({ account: viewer.id, ...route.request().postDataJSON() });
      return route.fulfill({ json: { ...empty(), revision: 1, messages: [{ id: viewer.id, role: 'assistant', text: 'History for ' + viewer.id }] } });
    });
  });
  const panel = await discuss(page);
  await panel.getByText('History for reader1', { exact: true }).waitFor();
  await panel.getByLabel('Message wekup').fill('Reader one private draft');
  viewer = { id: 'reader2', emailVerified: true };
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await panel.getByText('History for reader2', { exact: true }).waitFor();
  assert.equal(await panel.getByLabel('Message wekup').inputValue(), '');
  assert.equal(await panel.getByText('History for reader1', { exact: true }).count(), 0);
  await panel.getByLabel('Message wekup').fill('Reader two private draft');
  viewer = { id: 'reader3', emailVerified: true };
  await panel.getByRole('button', { name: 'Send message', exact: true }).click();
  await panel.getByText('History for reader3', { exact: true }).waitFor();
  assert.equal(await panel.getByLabel('Message wekup').inputValue(), '');
  assert.deepEqual(sent, [], 'a stale draft must never be posted into the replacement session');
});

test('short landscape screens keep the close control and composer visible', async t => {
  const page = await pageFor(t);
  await page.setViewportSize({ width: 568, height: 320 });
  const panel = await discuss(page);
  const close = await panel.getByRole('button', { name: 'Close wekup', exact: true }).boundingBox();
  const input = await panel.getByLabel('Message wekup').boundingBox();
  const send = await panel.getByRole('button', { name: 'Send message', exact: true }).boundingBox();
  for (const [name, box] of [['close', close], ['input', input], ['send', send]]) {
    assert.ok(box.y >= 0 && box.y + box.height <= 320, name + ' must remain inside the screen');
  }
  await panel.getByRole('button', { name: 'Close wekup', exact: true }).click();
  assert.equal(await panel.isVisible(), false);
});

test('a slow session check sends the clicked message and preserves edits made afterward', async t => {
  let hold = false, release, started;
  const held = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { started = resolve; });
  t.after(() => release());
  const sent = [];
  const page = await pageFor(t, async page => {
    await page.route(origin + '/api/me', async route => {
      if (hold) { started(); await held; }
      await route.fulfill({ json: { user: { id: 'reader1', emailVerified: true } } });
    });
    await page.route(origin + '/api/reports/wekupreport/wekup*', route => {
      if (route.request().method() === 'POST') {
        sent.push(route.request().postDataJSON());
        return route.fulfill({ status: 202, json: { ...empty(), revision: 2, messages: [{ id: 'accepted', role: 'assistant', text: 'Message accepted.' }], job: { status: 'completed' } } });
      }
      return route.fulfill({ json: empty() });
    });
  });
  const panel = await discuss(page);
  await panel.getByLabel('Message wekup').fill('The message I clicked Send on');
  hold = true;
  await panel.getByRole('button', { name: 'Send message', exact: true }).click();
  await requested;
  await panel.getByLabel('Message wekup').fill('My next unsent draft');
  await panel.getByLabel('Message wekup').press('Enter');
  release();
  await panel.getByText('Message accepted.', { exact: true }).waitFor();
  assert.deepEqual(sent.map(r => r.message), ['The message I clicked Send on']);
  assert.equal(await panel.getByLabel('Message wekup').inputValue(), 'My next unsent draft');
});
