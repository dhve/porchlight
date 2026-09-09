import test from 'node:test';
import assert from 'node:assert/strict';
import { writeReport } from '../server/reporter.js';
import { scoreReport } from '../server/scoring.js';

const observation = {
  id: 'form-missing-csrf', source: 'scripted', severity: 'minor', category: 'auth',
  title: 'No visible form token', meaning: 'A token was not detected in this markup.',
  fix: ['Ask the maintainer to inspect the form.'], who: 'The maintainer',
  evidence: { lines: ['POST form on /login'], note: 'Heuristic; server defenses were not tested.',
    method: 'Read form markup without submitting it.', pages: ['https://fixture.test/login'],
    why: 'Other defenses may exist.', confirm: 'Inspect server protections.',
    render: { viewport: { width: 390, height: 844 }, usable: true } },
};

test('the writer adds separate advice without changing observations, passes, or the health summary', async (t) => {
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-provider-boundary';
  t.after(() => { if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey; });
  let writerInput;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    writerInput = JSON.parse(JSON.parse(options.body).messages[1].content);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      summary: 'Invented clean health summary', passes: ['Invented successful test'],
      findings: [{ ...observation, title: 'Invented confirmed attack', meaning: 'Attacker proven',
        severity: 'urgent', evidence: { lines: ['invented'] }, fix: ['Review existing defenses.'],
        why: 'Ask a maintainer to inspect this observation.', confirm: 'Check the server configuration.' },
      { id: 'invented', title: 'Never measured', fix: ['Do something'] }],
    }) } }] }), { headers: { 'content-type': 'application/json' } });
  });
  const findings = structuredClone([observation]);
  const passes = ['A measured successful check'];
  const result = await writeReport({ target: 'fixture.test', facts: {}, findings, passes,
    ...scoreReport(findings), assessment: { status: 'complete', reason: 'Required checks completed.' } });
  assert.equal(result.findings.length, 1);
  const { aiAdvice, ...measured } = result.findings[0];
  assert.deepEqual(measured, observation);
  assert.deepEqual(findings, [observation]);
  assert.deepEqual(result.passes, passes);
  assert.notEqual(result.summary, 'Invented clean health summary');
  assert.ok(aiAdvice && typeof aiAdvice === 'object');
  assert.deepEqual(aiAdvice.fix, ['Review existing defenses.']);
  assert.equal(writerInput.findings[0].source, 'scripted');
  assert.equal(writerInput.findings[0].evidence.note, observation.evidence.note);
  assert.equal(writerInput.findings[0].evidence.method, observation.evidence.method);
});

test('an incomplete empty report makes no clean checkup claim', async (t) => {
  const key = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => { if (key !== undefined) process.env.OPENAI_API_KEY = key; });
  const assessment = { status: 'incomplete', reason: 'The homepage check failed.' };
  const result = await writeReport({ target: 'fixture.test', facts: {}, findings: [], passes: [],
    ...scoreReport([], assessment), assessment });
  assert.match(result.summary, /incomplete|could not complete/i);
  assert.doesNotMatch(result.summary, /passed|good news|no problems|doors are locked/i);
  assert.deepEqual(result.passes, []);
});

test('agent notes cannot affect penalties or grade caps even with urgent severity', () => {
  const scripted = [{ id: 'measured', source: 'scripted', severity: 'watch' }];
  const baseline = scoreReport(scripted);
  for (const notes of [
    [{ id: 'agent-note', severity: 'urgent' }, { id: 'agent-other', severity: 'urgent' }],
    [{ id: 'malformed-title-id', source: 'agent', severity: 'serious' }],
  ]) {
    const result = scoreReport([...scripted, ...notes]);
    assert.equal(result.score, baseline.score);
    assert.equal(result.grade, baseline.grade);
    assert.equal(result.ringPercent, baseline.ringPercent);
  }
});
