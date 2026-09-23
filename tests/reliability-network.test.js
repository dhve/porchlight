import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// Exercise every real planned checker with a bounded in-memory HTTP site.
// Only the browser launch and outbound fetch are replaced. No DB or model runs.
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;
delete process.env.SIGNING_PRIVATE_KEY;
mock.module('../server/contentScreening.js',{namedExports:{screenWebsiteContent:async()=>({status:'allowed',scope:'Synthetic image classifier fixture.'})}});
mock.module('../server/lib/browserConnect.js', { namedExports: {
  openBrowser: async () => { throw Object.assign(new Error('Fixture browser unavailable'), { code: 'NO_PLAYWRIGHT' }); },
  browserMode: () => 'local',
} });
const { runCheckup } = await import('../server/pipeline.js');

for (const status of [200, 403, 404, 503]) {
  test(`real pipeline with homepage HTTP ${status} reports only supported coverage`, async (t) => {
    t.mock.method(globalThis, 'fetch', async (value) => {
      const url = new URL(value);
      assert.equal(url.hostname, 'fixture.test');
      if (url.pathname !== '/') return new Response('', { status: 404 });
      return new Response('<!doctype html><html><head><title>Fixture</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><h1>Fixture</h1></body></html>',
        { status, headers: { 'content-type': 'text/html' } });
    });
    const result = await runCheckup({ url: new URL('http://fixture.test/'), display: 'fixture.test' });
    if (status === 200) {
      assert.equal(result.assessment.status, 'incomplete');
      assert.equal(result.grade, '?');
      assert.equal(result.score, null);
      assert.equal(result.engine.proof.review.status,'unavailable');
      assert.equal(result.coverage.find(c=>c.check==='review').status,'inconclusive');
      assert.equal(result.coverage.find((c) => c.check === 'exposedFiles').status, 'completed');
      assert.equal(result.coverage.find((c) => c.check === 'browser').status, 'skipped');
      assert.equal(result.coverage.find((c) => c.check === 'agent').status, 'skipped');
      assert.equal(result.findings.find((f) => f.id === 'no-https').provenance.check, 'recon');
    } else {
      assert.equal(result.assessment.status, 'incomplete');
      assert.equal(result.grade, '?');
      assert.equal(result.score, null);
      assert.equal(result.coverage.find((c) => c.check === 'recon').status, 'inconclusive');
      assert.deepEqual(result.passes, []);
    }
  });
}

test('real pipeline preserves a secondary recon challenge and skips all later work', async t => {
  const paths = [];
  t.mock.method(globalThis, 'fetch', async value => {
    const path = new URL(value).pathname; paths.push(path);
    if (path === '/') return new Response('<html><a href="/first">First</a><a href="/later">Later</a></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    if (path === '/robots.txt') return new Response('User-agent: *\n', { status: 200, headers: { 'content-type': 'text/plain' } });
    return new Response('<html><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?check=1"></html>', { status: 202, headers: { 'content-type': 'text/html' } });
  });
  const report = await runCheckup({ url: new URL('http://fixture.test/'), display: 'fixture.test' });
  assert.equal(report.grade, '?');
  assert.equal(report.score, null);
  assert.match(report.engine.challenged, /bot check/i);
  assert.match(report.coverage.find(c => c.check === 'recon').reason, /bot check/i);
  assert.ok(report.coverage.filter(c => !['recon','review'].includes(c.check)).every(c => c.status === 'skipped'));
  assert.equal(report.engine.proof.review.status,'unavailable');
  assert.deepEqual(report.passes, []);
  assert.deepEqual(paths, ['/', '/robots.txt', '/first']);
});
