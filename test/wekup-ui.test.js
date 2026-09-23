import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const publicRoot = new URL('../public/', import.meta.url);
// A published report: any reader may view it, while each account keeps its own conversation.
const report = { id: 'wekupreport', target: 'fixture.example', url: 'https://fixture.example/', visibility: 'public',
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
  await panel.waitFor();
  // Measurements must not catch the opening animation mid-flight.
  await panel.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)).catch(() => {}));
  return panel;
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
  await panel.locator('.wekup-message.from-user').getByText('This link works on my laptop. <img src=x onerror=alert(1)>', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('status').filter({ hasText: 'Thinking…' }).isVisible(), true, 'a queued turn shows Thinking…');
  assert.equal(await panel.getByText('Waiting to verify the evidence', { exact: true }).count(), 0, 'internal job stages are never shown');
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
  await panel.locator('.wekup-message.from-user').getByText('It works for me.', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('status').filter({ hasText: 'Thinking…' }).isVisible(), true);
  assert.equal(await panel.getByText('Request recovered', { exact: true }).count(), 0, 'internal job stages are never shown');
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

// ---- window controls: transparency, moving, resizing, the launcher ----
const inside = (box, width, height) => box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 0.5 && box.y + box.height <= height + 0.5;
async function dragBy(page, locator, dx, dy, pointerType = 'mouse') {
  const box = await locator.boundingBox();
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  if (pointerType === 'mouse') {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 4 });
    await page.mouse.move(from.x + dx, from.y + dy, { steps: 4 });
    await page.mouse.up();
    return;
  }
  // A touch drag: the same pointer events a finger produces, delivered to the element.
  const fire = (type, x, y) => locator.dispatchEvent(type, { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, button: 0, buttons: 1, bubbles: true, composed: true });
  await fire('pointerdown', from.x, from.y);
  await fire('pointermove', from.x + dx / 2, from.y + dy / 2);
  await fire('pointermove', from.x + dx, from.y + dy);
  await fire('pointerup', from.x + dx, from.y + dy);
}

test('the transparency toggle makes the window translucent while text and controls stay opaque', async t => {
  const page = await pageFor(t);
  await page.setViewportSize({ width: 1100, height: 800 });
  const panel = await discuss(page);
  const toggle = panel.getByRole('button', { name: 'Make wekup see-through', exact: true });
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
  const alpha = async () => page.evaluate(() => { const m = getComputedStyle(document.getElementById('wekupDialog')).backgroundColor.match(/rgba?\(([^)]+)\)/); const parts = m[1].split(',').map(Number); return parts.length === 4 ? parts[3] : 1; });
  assert.equal(await alpha(), 1);
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
  assert.ok(await alpha() < 0.95 && await alpha() > 0.3, 'the background is translucent but not invisible');
  const textAlpha = await page.evaluate(() => { const m = getComputedStyle(document.querySelector('#wekupDialog .wekup-intro h3')).color.match(/rgba?\(([^)]+)\)/); const parts = m[1].split(',').map(Number); return parts.length === 4 ? parts[3] : 1; });
  assert.equal(textAlpha, 1, 'text keeps full opacity');
  assert.equal(await panel.getByLabel('Message wekup').evaluate(el => getComputedStyle(el).opacity), '1');
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(await alpha(), 1);
  await toggle.click();
  await panel.getByRole('button', { name: 'Close wekup', exact: true }).click();
  await discuss(page);
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true', 'the choice is kept for the next opening');
});

test('the window moves by its header with the mouse and stays inside the viewport', async t => {
  const page = await pageFor(t);
  await page.setViewportSize({ width: 1100, height: 800 });
  const panel = await discuss(page);
  const before = await panel.boundingBox();
  await dragBy(page, panel.locator('.wekup-header h2'), -300, 40);
  const after = await panel.boundingBox();
  assert.ok(Math.abs((before.x - after.x) - 300) < 3 && Math.abs((after.y - before.y) - 40) < 3, `moved by the drag distance (${JSON.stringify({ before, after })})`);
  await dragBy(page, panel.locator('.wekup-header h2'), -2000, -2000);
  const clamped = await panel.boundingBox();
  assert.ok(inside(clamped, 1100, 800), 'a drag past the edge keeps the window on screen');
  assert.ok(clamped.x <= 1 && clamped.y <= 1, 'it settles at the top-left edge');
  await dragBy(page, panel.locator('.wekup-header h2'), 5000, 5000);
  const corner = await panel.boundingBox();
  assert.ok(inside(corner, 1100, 800));
  assert.ok(corner.x + corner.width >= 1099 && corner.y + corner.height >= 799, 'it settles at the bottom-right edge');
  assert.equal(await panel.getByLabel('Message wekup').isVisible(), true);
});

test('the window resizes from its corner handle and honours minimum and viewport bounds', async t => {
  const page = await pageFor(t);
  await page.setViewportSize({ width: 1100, height: 800 });
  const panel = await discuss(page);
  const handle = panel.getByRole('button', { name: 'Resize wekup', exact: true });
  const before = await panel.boundingBox();
  await dragBy(page, handle, 120, 60);
  const bigger = await panel.boundingBox();
  assert.ok(bigger.width - before.width > 100 && bigger.height - before.height > 40, `grew with the drag (${JSON.stringify({ before, bigger })})`);
  assert.ok(inside(bigger, 1100, 800));
  await dragBy(page, handle, -2000, -2000);
  const smallest = await panel.boundingBox();
  assert.ok(smallest.width >= 280 && smallest.height >= 300, `never below the minimum size (${JSON.stringify(smallest)})`);
  assert.equal(await panel.getByRole('button', { name: 'Close wekup', exact: true }).isVisible(), true);
  assert.equal(await panel.getByRole('button', { name: 'Send message', exact: true }).isVisible(), true);
  await dragBy(page, handle, 5000, 5000);
  const largest = await panel.boundingBox();
  assert.ok(inside(largest, 1100, 800), 'growing past the viewport is clamped');
});

test('the keyboard moves and resizes the window in steps and stays inside the viewport', async t => {
  const page = await pageFor(t);
  await page.setViewportSize({ width: 1100, height: 800 });
  const panel = await discuss(page);
  const move = panel.getByRole('button', { name: 'Move wekup', exact: true });
  await move.focus();
  const before = await panel.boundingBox();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowUp');
  const after = await panel.boundingBox();
  assert.ok(before.x - after.x >= 10 && before.y - after.y >= 10, 'arrow keys move the window');
  for (let i = 0; i < 80; i++) await page.keyboard.press('Shift+ArrowLeft');
  for (let i = 0; i < 80; i++) await page.keyboard.press('Shift+ArrowUp');
  assert.ok(inside(await panel.boundingBox(), 1100, 800), 'keyboard movement is clamped');
  const resize = panel.getByRole('button', { name: 'Resize wekup', exact: true });
  await resize.focus();
  const sized = await panel.boundingBox();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  const grown = await panel.boundingBox();
  assert.ok(grown.width - sized.width >= 10 && grown.height - sized.height >= 10, 'arrow keys resize the window');
  for (let i = 0; i < 80; i++) await page.keyboard.press('Shift+ArrowLeft');
  const shrunk = await panel.boundingBox();
  assert.ok(shrunk.width >= 280, 'keyboard shrinking stops at the minimum');
  assert.equal(await panel.getByLabel('Message wekup').isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await panel.isVisible(), false, 'Escape still closes from the window controls');
});

test('touch drags move the window and clamp on a small phone', async t => {
  const page = await pageFor(t);
  const panel = await discuss(page);
  const before = await panel.boundingBox();
  await dragBy(page, panel.locator('.wekup-header h2'), 0, -3000, 'touch');
  const after = await panel.boundingBox();
  assert.ok(after.y < before.y, 'a finger drag moved the window');
  assert.ok(inside(after, 390, 844), 'the window stays inside the phone screen');
  const send = await panel.getByRole('button', { name: 'Send message', exact: true }).boundingBox();
  assert.ok(send.y + send.height <= 844 && send.y >= 0);
  await panel.getByLabel('Message wekup').fill('A draft during the move');
  assert.equal(await panel.getByLabel('Message wekup').inputValue(), 'A draft during the move');
});

test('a moved window is pulled back inside when the viewport shrinks to a short landscape screen', async t => {
  const page = await pageFor(t);
  await page.setViewportSize({ width: 1100, height: 800 });
  const panel = await discuss(page);
  await dragBy(page, panel.locator('.wekup-header h2'), 5000, 5000);
  await page.setViewportSize({ width: 568, height: 320 });
  await page.waitForFunction(() => { const b = document.getElementById('wekupDialog').getBoundingClientRect(); return b.right <= 568.5 && b.bottom <= 320.5 && b.left >= 0 && b.top >= 0; });
  const close = await panel.getByRole('button', { name: 'Close wekup', exact: true }).boundingBox();
  const send = await panel.getByRole('button', { name: 'Send message', exact: true }).boundingBox();
  for (const [name, box] of [['close', close], ['send', send]]) assert.ok(box.y >= 0 && box.y + box.height <= 320, name + ' stays on screen');
  // Closed, viewport changed again, reopened: the remembered placement is clamped on opening too.
  await panel.getByRole('button', { name: 'Close wekup', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await discuss(page);
  assert.ok(inside(await panel.boundingBox(), 390, 844), 'a reopened window is inside the new viewport');
  assert.equal(await panel.getByRole('button', { name: 'Send message', exact: true }).isVisible(), true);
});

test('the launcher is narrow and becomes icon-only with its name intact on a cramped screen', async t => {
  const page = await pageFor(t);
  await page.setViewportSize({ width: 1100, height: 800 });
  const launcher = page.getByRole('button', { name: 'Talk to wekup', exact: true });
  const wide = await launcher.boundingBox();
  assert.ok(wide.width <= 160, `the launcher is narrow (${wide.width}px)`);
  await page.setViewportSize({ width: 320, height: 568 });
  const cramped = await launcher.boundingBox();
  assert.ok(cramped.width <= 64, `icon-only on a cramped screen (${cramped.width}px)`);
  assert.equal(await launcher.getAttribute('aria-label'), 'Talk to wekup');
  assert.equal(await launcher.locator('.wekup-launcher-text').isVisible(), false);
  await launcher.click();
  await page.getByRole('dialog', { name: 'wekup', exact: true }).waitFor();
});

// ---- the on-screen keyboard: a visual viewport smaller than the layout viewport ----
// Chromium keeps the layout viewport at the full height while the keyboard is up; only
// window.visualViewport shrinks. The window must fit inside that visible area.
const mockVisualViewport = page => page.addInitScript(() => {
  const target = new EventTarget();
  const vv = { width: 390, height: 844, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1,
    addEventListener: (...a) => target.addEventListener(...a), removeEventListener: (...a) => target.removeEventListener(...a), dispatchEvent: e => target.dispatchEvent(e) };
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
  window.__keyboard = (height, top = 0) => { vv.height = height; vv.offsetTop = top; vv.dispatchEvent(new Event('resize')); };
});
const withinVisual = async (page, panel, top, height) => {
  await page.waitForFunction(([top, height]) => { const b = document.getElementById('wekupDialog').getBoundingClientRect(); return b.top >= top - 0.5 && b.bottom <= top + height + 0.5 && b.left >= -0.5 && b.right <= 390.5; }, [top, height]);
  for (const name of ['Close wekup', 'Send message']) {
    const box = await panel.getByRole('button', { name, exact: true }).boundingBox();
    assert.ok(box.y >= top - 0.5 && box.y + box.height <= top + height + 0.5, name + ' is inside the visible area');
  }
};

test('an on-screen keyboard shrinks the window into the visible area, and moves stay inside it', async t => {
  const page = await pageFor(t, mockVisualViewport);
  const panel = await discuss(page);
  const full = await panel.boundingBox();
  assert.ok(full.y + full.height > 400, 'before the keyboard the window uses the tall screen');
  await page.evaluate(() => window.__keyboard(400));
  await withinVisual(page, panel, 0, 400);
  await panel.getByRole('button', { name: 'Move wekup', exact: true }).focus();
  for (let i = 0; i < 30; i++) await page.keyboard.press('Shift+ArrowDown');
  await withinVisual(page, panel, 0, 400);
  await dragBy(page, panel.locator('.wekup-header h2'), 0, 3000, 'touch');
  await withinVisual(page, panel, 0, 400);
  await panel.getByRole('button', { name: 'Resize wekup', exact: true }).focus();
  for (let i = 0; i < 30; i++) await page.keyboard.press('Shift+ArrowDown');
  await withinVisual(page, panel, 0, 400);
  await panel.getByLabel('Message wekup').fill('Typed while the keyboard is up');
  assert.equal(await panel.getByLabel('Message wekup').inputValue(), 'Typed while the keyboard is up');
  await page.evaluate(() => window.__keyboard(844));
  await withinVisual(page, panel, 0, 844);
});

test('a window opened while the keyboard is already up fits, follows a scrolled visual viewport, and grows back later', async t => {
  const page = await pageFor(t, mockVisualViewport);
  await page.evaluate(() => window.__keyboard(400));
  const panel = await discuss(page);
  await withinVisual(page, panel, 0, 400);
  await page.evaluate(() => window.__keyboard(400, 200));
  await withinVisual(page, panel, 200, 400);
  await page.evaluate(() => window.__keyboard(844, 0));
  await withinVisual(page, panel, 0, 844);
  await page.waitForFunction(() => document.getElementById('wekupDialog').getBoundingClientRect().bottom > 400);
  assert.equal(await panel.getByLabel('Message wekup').isVisible(), true);
});

// ---- a cleared report leaves nothing behind in the chat ----
test('the report-cleared event empties the finding list, conversation, drafts, and caches but keeps window preferences', async t => {
  let viewer = { id: 'reader1', emailVerified: true };
  const privateReport = { ...report, id: 'privatereport', visibility: 'private', summary: 'PRIVATE_SUMMARY',
    findings: [{ ...report.findings[0], id: 'private-link', title: 'PRIVATE_FINDING title', meaning: 'PRIVATE_MEANING' }] };
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(4000); t.after(() => page.close());
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.route(origin + '/api/me', route => route.fulfill({ json: { user: viewer } }));
  await page.route(origin + '/api/reports/privatereport', route => route.fulfill({ json: privateReport }));
  await page.route(origin + '/api/reports/privatereport/assessments', route => route.fulfill({ json: { assessments: { 'private-link': { ...assessment, findingId: 'private-link', summary: 'PRIVATE_ASSESSMENT summary' } } } }));
  await page.route(origin + '/api/reports/privatereport/wekup*', route => route.fulfill({ json: { conversationId: 'c1', reportId: 'privatereport', findingId: 'private-link', revision: 2,
    messages: [{ id: 'm1', role: 'assistant', text: 'PRIVATE_CONVERSATION reply' }], job: null, assessment: null } }));
  await page.goto(origin + '/r/privatereport');
  await page.locator('#screen-report.is-active').waitFor();
  await page.locator('.wekup-assessment[data-finding="private-link"]').getByText('PRIVATE_ASSESSMENT summary', { exact: true }).waitFor();
  const panel = await discuss(page);
  await panel.getByText('PRIVATE_CONVERSATION reply', { exact: true }).waitFor();
  assert.ok((await page.locator('#wekupFinding option').allTextContents()).some(text => text.includes('PRIVATE_FINDING')));
  await panel.getByLabel('Message wekup').fill('PRIVATE_DRAFT text');
  await panel.getByRole('button', { name: 'Make wekup see-through', exact: true }).click();
  await dragBy(page, panel.locator('.wekup-header h2'), 0, -120);
  const placed = await panel.boundingBox();

  // Sign-out: app.js clears its report and goes home, then announces the clearing.
  viewer = null;
  await page.evaluate(async () => { await window.Sutros.refreshMe(); window.Sutros.report = null; document.dispatchEvent(new Event('sutros:report-cleared')); });
  await page.locator('#screen-home.is-active').waitFor();
  assert.equal(await panel.isVisible(), false);
  assert.equal(await page.locator('#wekupFinding option').count(), 0, 'no finding options remain');
  assert.equal((await page.locator('#wekupWidget').innerHTML()).includes('PRIVATE_'), false, 'nothing private remains in the widget markup');
  assert.equal(await page.getByText('PRIVATE_', { exact: false }).count(), 0);

  // Reopening shows the generic introduction, in the same place and still see-through.
  await page.getByRole('button', { name: 'Talk to wekup', exact: true }).click();
  await panel.waitFor();
  await panel.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)).catch(() => {}));
  assert.equal((await panel.innerHTML()).includes('PRIVATE_'), false);
  assert.equal(await panel.getByRole('button', { name: 'Make wekup see-through', exact: true }).getAttribute('aria-pressed'), 'true');
  const reopened = await panel.boundingBox();
  assert.ok(Math.abs(reopened.x - placed.x) < 1.5 && Math.abs(reopened.y - placed.y) < 1.5, 'the chosen placement is kept');
  await panel.getByRole('button', { name: 'Close wekup', exact: true }).click();

  // A later report starts fresh: only its own findings, no draft, no earlier messages.
  viewer = { id: 'reader1', emailVerified: true };
  await page.evaluate(() => window.Sutros.refreshMe());
  await page.evaluate(r => { window.renderReport(r); window.go('report'); }, report);
  await discuss(page);
  assert.deepEqual(await page.locator('#wekupFinding option').allTextContents(), ['Whole checkup', 'A link returned an error']);
  assert.equal(await panel.getByLabel('Message wekup').inputValue(), '');
  assert.equal(await panel.getByText('PRIVATE_', { exact: false }).count(), 0);
  assert.equal(await page.getByText('PRIVATE_', { exact: false }).count(), 0);
});

