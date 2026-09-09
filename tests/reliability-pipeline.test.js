import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// The pipeline, writer, and scoring run unchanged. Replace external work and
// simulate checker exceptions at the same boundary where the pipeline sees them.
let scenario = 'recon-throws';
let persisted;
let browserRuns = 0;
const fixtureFinding = {
  id: 'mobile-observation', severity: 'minor', category: 'modernization',
  title: 'Measured mobile layout', meaning: 'The captured page has this measurement.',
  evidence: { lines: ['content width: 390'], render: { usable: true, viewport: { width: 390, height: 844 } },
    observedAt: '2026-09-09T12:00:00.000Z', method: 'Phone browser render',
    shots: [{ key: 's1', page: 'https://fixture.test/', caption: 'Phone page' }] },
};

mock.module('../server/db.js', { namedExports: {
  newId: () => 'fixture1', saveReport: async (r) => { persisted = structuredClone(r); },
  sql: async () => [], dbEnabled: () => false,
} });
mock.module('../server/feedback.js', { namedExports: { disputesForHost: async () => new Map() } });
mock.module('../server/lib/http.js', { namedExports: { createClient: () => ({}) } });
mock.module('../server/orchestrator.js', { namedExports: {
  planCheckup: async () => ({ focus: 'Fixture checklist', checks: [{ id: 'security' }, { id: 'browser' }], llm: false }),
} });
mock.module('../server/proof.js', { namedExports: {
  captureProof: async () => ({ shots: [{ key: 's1', bytes: Buffer.from('fixture picture'), mime: 'image/jpeg' }], skipped: null }),
  saveShots: async () => 1,
} });
mock.module('../server/checks/recon.js', { namedExports: { runRecon: async () => {
  if (scenario === 'recon-throws') throw new Error('checker failed with private internal details');
  if (scenario === 'unreachable') return { facts: { reachable: false }, findings: [], passes: [] };
  return { facts: { reachable: true, finalUrl: new URL('https://fixture.test/'), pages: [] }, findings: [], passes: ['Homepage responded.'] };
} } });
mock.module('../server/checks/security.js', { namedExports: { runSecurity: async ctx => {
  if (scenario === 'required-challenge') { ctx.facts.challenged = 'Hosting bot challenge'; return {findings:[],passes:[],inconclusive:true,reason:'Hosting bot challenge'}; }
  if (scenario === 'required-throws') throw new Error('required checker failed');
  if (scenario === 'required-inconclusive') return { findings: [], passes: ['Must not claim success'], inconclusive: true, reason: 'Page was blocked.' };
  return { findings: [structuredClone(fixtureFinding)], passes: ['Measured security check completed.'] };
} } });
mock.module('../server/checks/browser.js', { namedExports: {
  runBrowser: async () => { browserRuns++; return scenario === 'browser-inconclusive'
    ? { findings: [], passes: [], inconclusive: true, reason: 'Page was not usable.', render: { usable: false } }
    : { findings: [], passes: ['Must not claim success'], skipped: true, reason: 'Browser unavailable.', browserMode: 'local' }; },
  CHROME_USER_AGENT: 'fixture',
} });
mock.module('../server/checks/agentBrowse.js', { namedExports: {
  runAgentBrowse: async ctx => {
    if (scenario === 'agent-challenged') {
      ctx.facts.challenged = 'The hosting put a bot check in front of our checker.';
      return { findings: [{id:'agent-note',source:'agent',severity:'serious'}], passes: ['Unsafe agent pass'],
        agent: {ran:true,steps:2,visited:['https://fixture.test/'],challenged:ctx.facts.challenged,unreliablePages:1,
          summary:'Our browsing agent opened 1 page and found nothing in the way.'} };
    }
    return { findings: [], passes: [], skipped: true, reason: 'AI is disabled.' };
  },
} });
// These modules are imported by the pipeline but not scheduled in this fixture.
for (const [file, name] of [['tls', 'runTls'], ['cookies', 'runCookies'], ['exposedFiles', 'runExposedFiles'],
  ['libraries', 'runLibraries'], ['disclosure', 'runDisclosure'], ['forms', 'runForms'], ['flows', 'runFlows'],
  ['links', 'runLinks'], ['reflection', 'runReflection'], ['modernization', 'runModernization']]) {
  mock.module(`../server/checks/${file}.js`, { namedExports: { [name]: async () => { throw new Error('Unplanned fixture check'); } } });
}
delete process.env.OPENAI_API_KEY;
delete process.env.SIGNING_PRIVATE_KEY;
const { runCheckup } = await import('../server/pipeline.js');

async function scan(next) {
  scenario = next;
  browserRuns = 0;
  return runCheckup({ url: new URL('https://fixture.test/'), display: 'fixture.test', userId: 'private-owner' });
}

for (const next of ['recon-throws', 'unreachable', 'required-throws', 'required-inconclusive']) {
  test(`${next}: failed required coverage remains unrated and is persisted as incomplete`, async () => {
    const report = await scan(next);
    assert.equal(report.grade, '?');
    assert.equal(report.gradeLabel, 'Not rated');
    assert.equal(report.score, null);
    assert.equal(report.ringPercent, 0);
    assert.equal(report.assessment.status, 'incomplete');
    assert.ok(report.assessment.reason);
    assert.doesNotMatch(report.summary, /passed|good news|no problems worth flagging/i);
    assert.deepEqual(persisted.assessment, report.assessment);
    const expected = next.startsWith('required') ? 'security' : 'recon';
    assert.ok(report.coverage.some((c) => c.check === expected && ['failed', 'inconclusive'].includes(c.status) && c.reason));
    assert.ok(!report.engine.checksRun.includes(expected));
    assert.ok(!report.passes.includes('Must not claim success'));
    assert.doesNotMatch(JSON.stringify(report.coverage), /private internal details/);
  });
}

test('optional skipped checks preserve a completed assessment without adding false passes', async () => {
  const started = Date.now();
  const report = await scan('complete');
  assert.equal(report.assessment?.status, 'complete');
  assert.deepEqual(report.coverage.find((c) => c.check === 'browser'), { check: 'browser', status: 'skipped', reason: 'Browser unavailable.' });
  assert.deepEqual(report.coverage.find((c) => c.check === 'agent'), { check: 'agent', status: 'skipped', reason: 'AI is disabled.' });
  assert.ok(!report.passes.includes('Must not claim success'));
  assert.ok(!report.engine.checksRun.includes('browser'));
  assert.equal(report.findings[0].source, 'scripted');
  assert.equal(report.findings[0].provenance.check, 'security');
  assert.equal(report.findings[0].provenance.observedAt, '2026-09-09T12:00:00.000Z');
  assert.ok(Date.parse(report.findings[0].provenance.recordedAt) >= started);
  assert.equal(report.findings[0].provenance.scannerVersion, report.engine.version);
  assert.deepEqual(report.findings[0].evidence.render, fixtureFinding.evidence.render);
  assert.equal(report.findings[0].evidence.observedAt, '2026-09-09T12:00:00.000Z');
  assert.equal(report.findings[0].evidence.shots[0].sha256, '18a45744b2c7bf3544d5bb6996742036621236448cf5c835e1cd3dfd86fe05a2');
});

test('a known hosting challenge stops later checks and remains visible in coverage', async () => {
  const report = await scan('required-challenge');
  assert.equal(browserRuns, 0);
  assert.equal(report.grade, '?');
  assert.equal(report.coverage.find(c=>c.check === 'browser').status,'skipped');
  assert.match(report.coverage.find(c=>c.check === 'browser').reason,/challenge/i);
});

test('optional incomplete browser rendering stays inconclusive with its metadata intact', async () => {
  const report = await scan('browser-inconclusive');
  assert.equal(report.assessment?.status, 'complete');
  assert.equal(report.coverage.find((c) => c.check === 'browser').status, 'inconclusive');
  assert.deepEqual(report.engine.browser.render, { usable: false });
});

test('an inconclusive agent retains run facts with a limitation instead of reassurance', async () => {
  const report = await scan('agent-challenged');
  assert.equal(report.assessment.status, 'complete', 'the optional agent does not invalidate required coverage');
  assert.equal(report.coverage.find(c => c.check === 'agent').status, 'inconclusive');
  assert.equal(report.agent.ran, true);
  assert.equal(report.agent.steps, 2);
  assert.deepEqual(report.agent.visited, ['https://fixture.test/']);
  assert.match(report.agent.challenged, /bot check/);
  assert.doesNotMatch(report.agent.summary, /found nothing in the way/);
  assert.match(report.agent.summary, /incomplete|inconclusive/i);
  assert.match(report.agent.summary, /bot check/i);
  assert.ok(!report.findings.some(f => f.id === 'agent-note'));
  assert.ok(!report.passes.includes('Unsafe agent pass'));
});
