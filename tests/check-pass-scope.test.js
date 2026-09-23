import test from 'node:test';
import assert from 'node:assert/strict';
import { runModernization } from '../server/checks/modernization.js';
import { runSecurity } from '../server/checks/security.js';
import { runExposedFiles } from '../server/checks/exposedFiles.js';

const origin = 'https://fixture.test';
const facts = () => ({ baseOrigin: origin, finalUrl: new URL(origin), isHttps: true, forms: [], pages: [] });
const client = { get: async () => new Response('', { status: 404 }) };

test('a viewport tag reports source presence without claiming that a wide page works on phones', async () => {
  const html = '<html><head><meta name="viewport" content="width=device-width"></head><body><div style="width:4000px">Wide content</div></body></html>';
  const result = await runModernization({ facts: { ...facts(), pages: [{ url: origin, status: 200, html }] } });
  assert.equal(result.findings.length, 0);
  assert.match(result.passes.join(' '), /homepage.*viewport meta tag/i);
  assert.doesNotMatch(result.passes.join(' '), /set up to work properly|is mobile.friendly|works on phones/i);
});

test('a CSP with only frame rules reports the checked patterns without vouching for script protection', async () => {
  const result = await runSecurity({ client, facts: { ...facts(), headers: new Headers({ 'content-security-policy': "frame-ancestors 'none'" }) } });
  const pass = result.passes.find(value => /Content-Security-Policy/.test(value));
  assert.equal(result.findings.length, 0);
  assert.match(pass, /three.*patterns.*unsafe-inline.*unsafe-eval.*wildcard/i);
  assert.doesNotMatch(pass, /solid|secure policy|prevents/i);
});

test('presence-only header checks do not claim that HTTPS and framing protection were exercised', async () => {
  const result = await runSecurity({ client, facts: { ...facts(), headers: new Headers({ 'strict-transport-security': 'max-age=0', 'x-frame-options': 'DENY' }) } });
  assert.equal(result.findings.length, 0);
  assert.match(result.passes.join(' '), /homepage response.*Strict-Transport-Security.*framing/i);
  assert.doesNotMatch(result.passes.join(' '), /keeps visitors|blocks other sites/i);
});

test('missing file responses describe only the actual sample of known paths', async () => {
  const requested = [];
  const result = await runExposedFiles({ facts: facts(), client: { get: async url => { requested.push(url); return new Response('', { status: 404 }); } } });
  assert.ok(requested.length > 0);
  assert.equal(result.findings.length, 0);
  assert.match(result.passes.join(' '), new RegExp(`${requested.length} of ${requested.length} sampled known sensitive-file paths`));
  assert.match(result.passes.join(' '), /pattern.*detected|detected.*pattern/i);
  assert.doesNotMatch(result.passes.join(' '), /none.*files.*exposed/i);
});

test('a partly unanswered file sample retains the measured count and uncertainty', async () => {
  let requested = 0;
  const result = await runExposedFiles({ facts: facts(), client: { get: async () => {
    if (++requested === 1) throw new Error('fixture connection failure');
    return new Response('', { status: 404 });
  } } });
  assert.equal(result.findings.length, 0);
  assert.match(result.passes.join(' '), new RegExp(`${requested - 1} of ${requested} sampled known sensitive-file paths`));
  assert.match(result.passes.join(' '), /rest did not answer/i);
  assert.doesNotMatch(result.passes.join(' '), /none.*files.*exposed/i);
});
