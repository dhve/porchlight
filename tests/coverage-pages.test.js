import test from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { runFlows } from '../server/checks/flows.js';
import { runLinks } from '../server/checks/links.js';
import { observeCheck, assessmentFor } from '../server/provenance.js';
import { scoreReport } from '../server/scoring.js';
import { config } from '../server/safety.js';

const origin = 'https://fixture.test';
function factsFor(html) {
  const $ = cheerio.load(html);
  return { baseOrigin: origin, finalUrl: new URL(origin + '/'), $, pages: [{ url: origin + '/', html, $ }] };
}
function fixtureClient(answers) {
  const requests = [];
  const send = async (method, url) => {
    const path = new URL(url).pathname;
    assert.ok(Object.hasOwn(answers, path), `Unexpected request: ${method} ${path}`);
    requests.push({ method, path });
    const answer = typeof answers[path] === 'function' ? answers[path](method) : answers[path];
    if (answer instanceof Error) throw answer;
    return { status: answer, retryAfterMs: 0, discard() {} };
  };
  return { requests, get: (url) => send('GET', url), head: (url) => send('HEAD', url) };
}
function assertIncomplete(out, reasonPattern) {
  assert.ok(out.status === 'inconclusive' || out.partial === true, 'the detector must expose its incomplete sample');
  assert.match(out.reason, reasonPattern);
  assert.deepEqual(out.passes, [], 'an incomplete sample must not create a pass');
}

for (const [check, run] of [['flows', runFlows], ['links', runLinks]]) {
  test(`${check}: all refused requests leave the required check unrated`, async () => {
    const client = fixtureClient({ '/contact': 403 });
    const result = await observeCheck(check, run, { facts: factsFor('<a href="/contact">Contact</a>'), client });
    assertIncomplete(result.out, /refus|block|access/i);
    assert.equal(result.coverage.status, 'inconclusive');
    const score = scoreReport(result.out.findings, assessmentFor([result.coverage], [check]));
    assert.equal(score.grade, '?');
    assert.equal(score.score, null);
    assert.deepEqual(result.out.findings, []);
  });

  test(`${check}: working and refused samples do not become a blanket pass`, async () => {
    const out = await run({ facts: factsFor('<a href="/contact">Contact</a><a href="/order">Order</a>'),
      client: fixtureClient({ '/contact': 200, '/order': 403 }) });
    assertIncomplete(out, /refus|block|access/i);
    assert.match(out.reason, /1.*2|2.*1/, 'the explanation states the successful subset and sample total');
    assert.deepEqual(out.findings, []);
  });

  for (const [code, pattern] of [['TIMEOUT', /time|answer|inconclusive/i], ['BUDGET', /budget|limit|untested/i]]) {
    test(`${check}: ${code.toLowerCase()} after a working sample leaves coverage incomplete`, async () => {
      const client = fixtureClient({ '/contact': 200, '/order': Object.assign(new Error('Fixture failure'), { code }) });
      const out = await run({ facts: factsFor('<a href="/contact">Contact</a><a href="/order">Order</a>'), client });
      assertIncomplete(out, pattern);
      assert.match(out.reason, /1.*2|2.*1/);
    });
  }

  test(`${check}: a rate limit leaves the remaining samples explicitly untested`, async () => {
    const client = fixtureClient({ '/contact': 429 });
    const out = await run({ facts: factsFor('<a href="/contact">Contact</a><a href="/order">Order</a>'), client });
    assertIncomplete(out, /limit|block|refus/i);
    assert.match(out.reason, /untested|not requested/i);
    assert.ok(client.requests.every((r) => r.path === '/contact'));
  });

  test(`${check}: a measured 404 stays visible alongside an inconclusive sample`, async () => {
    const out = await run({ facts: factsFor('<a href="/contact">Contact</a><a href="/order">Order</a>'),
      client: fixtureClient({ '/contact': 404, '/order': 403 }) });
    assertIncomplete(out, /refus|block|access/i);
    assert.equal(out.findings.length, 1);
    assert.equal(out.findings[0].evidence.items[0].url, origin + '/contact');
    assert.equal(out.findings[0].evidence.items[0].status, 404);
  });

  test(`${check}: successful and confirmed 404 samples are conclusive`, async () => {
    const result = await observeCheck(check, run, {
      facts: factsFor('<a href="/contact">Contact</a><a href="/order">Order</a>'),
      client: fixtureClient({ '/contact': 200, '/order': 404 }),
    });
    assert.equal(result.coverage.status, 'completed');
    assert.equal(result.out.findings.length, 1);
    assert.equal(result.out.findings[0].evidence.items[0].status, 404);
    assert.deepEqual(result.out.passes, []);
  });
}

test('links: a safety-refused image stays unrequested and makes the sample inconclusive', async () => {
  const client = fixtureClient({ '/contact': 200 });
  const out = await runLinks({ facts: factsFor('<a href="/contact">Contact</a><img src="https://private.example/picture.jpg">'),
    client, resolveTarget: async () => ({ ok: false }) });
  assertIncomplete(out, /safety|guard|private/i);
  assert.match(out.reason, /1.*2|2.*1/);
  assert.deepEqual(out.findings, []);
  assert.deepEqual(client.requests.map((r) => r.path), ['/contact']);
});

test('links: the time budget cannot silently omit a selected sample', async (t) => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const client = fixtureClient({ '/one': () => { now += 61_000; return 200; } });
  const out = await runLinks({ facts: factsFor('<a href="/one">One</a><a href="/two">Two</a>'), client });
  assertIncomplete(out, /time|budget|limit/i);
  assert.deepEqual(client.requests.map((r) => r.path), ['/one']);
});

test('flows: complete bounded samples describe only the sampled customer pages', async () => {
  const html = Array.from({ length: 8 }, (_, i) => `<a href="/contact/${i}">Contact ${i}</a>`).join('');
  const answers = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`/contact/${i}`, 200]));
  const client = fixtureClient(answers);
  const result = await observeCheck('flows', runFlows, { facts: factsFor(html), client });
  assert.equal(result.coverage.status, 'completed');
  assert.equal(client.requests.length, 6);
  assert.match(result.out.passes[0], /6.*sampl|sampl.*6/i);
  assert.doesNotMatch(result.out.passes[0], /Your key customer pages/i);
});

test('links: the configured sample limit does not make a complete bounded check inconclusive', async (t) => {
  const originalMax = config.maxLinks;
  config.maxLinks = 2;
  t.after(() => { config.maxLinks = originalMax; });
  const client = fixtureClient({ '/one': 200, '/two': 200 });
  const result = await observeCheck('links', runLinks, {
    facts: factsFor('<a href="/one">One</a><a href="/two">Two</a><a href="/three">Three</a>'), client,
  });
  assert.equal(result.coverage.status, 'completed');
  assert.equal(client.requests.length, 2);
  assert.match(result.out.passes[0], /2.*link/i);
});
