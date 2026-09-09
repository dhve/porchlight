import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const cases = {
  schemaVersion: 1, exportedAt: '2026-09-09T00:00:00.000Z', selectionNote: 'Selected reviewed cases, not overall model accuracy.',
  cases: [['p1', 'present'], ['p2', 'present'], ['n1', 'absent'], ['n2', 'absent'], ['p3', 'present']].map(([caseId, expected]) => ({
    caseId, expected, reportId: 'report01', findingId: caseId,
    report: { id: 'report01', target: 'example.invalid', scannedAt: '2026-09-09T00:00:00.000Z' },
    finding: { id: caseId, severity: 'watch', evidence: { lines: ['Recorded fixture observation'] } },
    provenance: { reviewId: 'review01', status: expected === 'present' ? 'confirmed' : 'incorrect', reviewedAt: '2026-09-09T00:00:00.000Z', reason: 'A reviewer checked the original observation against the fixture.', findingDigest: 'a'.repeat(64) },
  })),
};
const candidate = { schemaVersion: 1, candidateVersion: 'candidate-1', decisions: { p1: 'present', p2: 'absent', n1: 'present', n2: 'absent' } };

async function cli({ data = cases, decisions = candidate, baseline, extra = [], rawCandidate, output = false } = {}) {
  const dir = await mkdtemp(resolve('../feedback-eval-'));
  try {
    const paths = { cases: join(dir, 'cases.json'), candidate: join(dir, 'candidate.json'), baseline: join(dir, 'baseline.json'), out: join(dir, 'out.json') };
    await writeFile(paths.cases, JSON.stringify(data));
    await writeFile(paths.candidate, rawCandidate ?? JSON.stringify(decisions));
    const args = ['scripts/evaluate-feedback.js', '--cases', paths.cases, '--candidate', paths.candidate];
    if (baseline) { await writeFile(paths.baseline, JSON.stringify(baseline)); args.push('--baseline', paths.baseline); }
    if (output) args.push('--out', paths.out);
    const result = spawnSync(process.execPath, [...args, ...extra], { cwd: resolve('.'), encoding: 'utf8' });
    let body = null;
    try { body = JSON.parse(output && result.status === 0 ? await readFile(paths.out, 'utf8') : result.stdout); } catch {}
    return { ...result, body };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('evaluation counts both error directions and missing cases with explicit denominators', async () => {
  const result = await cli();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.body.candidate.counts, { truePositive: 1, falsePositive: 1, trueNegative: 1, falseNegative: 1, inconclusive: 1, missing: 1, explicitInconclusive: 0 });
  assert.deepEqual(result.body.candidate.decidedCoverage, { numerator: 4, denominator: 5, value: 0.8 });
  assert.deepEqual(result.body.candidate.agreementOnDecided, { numerator: 2, denominator: 4, value: 0.5 });
  assert.deepEqual(result.body.candidate.agreementAcrossReviewed, { numerator: 2, denominator: 5, value: 0.4 });
  assert.deepEqual(result.body.candidate.recallOnReviewedPositives, { numerator: 1, denominator: 3, value: 1 / 3 });
  assert.match(result.body.limitation, /not.*accuracy/i);
});

test('explicit abstention is counted separately from a missing answer', async () => {
  const result = await cli({ decisions: { ...candidate, decisions: { ...candidate.decisions, p3: 'inconclusive' } } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.body.candidate.counts.explicitInconclusive, 1);
  assert.equal(result.body.candidate.counts.missing, 0);
  assert.equal(result.body.candidate.agreementAcrossReviewed.denominator, 5);
});

test('baseline comparison uses the same cases and separates regressions from improvements', async () => {
  const baseline = { schemaVersion: 1, candidateVersion: 'baseline-1', decisions: { p1: 'absent', p2: 'absent', n1: 'absent', n2: 'absent', p3: 'inconclusive' } };
  const result = await cli({ baseline, output: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.body.comparison.commonDecided, 4);
  assert.equal(result.body.comparison.improved, 1);
  assert.equal(result.body.comparison.regressed, 1);
  assert.equal(result.body.comparison.bothAgree, 1);
  assert.equal(result.body.comparison.bothDisagree, 1);
  assert.equal(result.body.comparison.neitherDecided, 1);
});

test('zero reviewed cases never yields a success percentage', async () => {
  const result = await cli({ data: { ...cases, cases: [] }, decisions: { ...candidate, decisions: {} } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.body.candidate.decidedCoverage, { numerator: 0, denominator: 0, value: null });
  assert.equal(result.body.candidate.agreementAcrossReviewed.value, null);
});

for (const [name, decisions] of [
  ['an unknown case', { ...candidate, decisions: { invented: 'present' } }],
  ['an unknown decision', { ...candidate, decisions: { p1: 'right' } }],
  ['a missing candidate version', { schemaVersion: 1, decisions: {} }],
  ['a decision array', { ...candidate, decisions: [] }],
  ['a boolean decision', { ...candidate, decisions: { p1: true } }],
  ['unknown top-level fields', { ...candidate, success: true }],
]) test(`evaluation rejects ${name}`, async () => {
  const result = await cli({ decisions });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid|invalid|Unknown|unknown|required/i);
  assert.equal(result.body, null);
});

test('evaluation rejects duplicate case IDs and inconclusive review labels', async () => {
  for (const entries of [[cases.cases[0], cases.cases[0]], [{ ...cases.cases[0], expected: 'inconclusive' }]]) {
    const result = await cli({ data: { ...cases, cases: entries } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /duplicate|expected|Invalid/i);
  }
});

test('evaluation rejects duplicate JSON keys rather than silently replacing a decision', async () => {
  const rawCandidate = '{"schemaVersion":1,"candidateVersion":"v1","decisions":{"p1":"present","p1":"absent"}}';
  const result = await cli({ rawCandidate });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /duplicate/i);
});

test('evaluation rejects unknown or repeated CLI flags', async () => {
  for (const extra of [['--allow-missing'], ['--cases', 'another.json']]) {
    const result = await cli({ extra });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /argument|flag|Unknown|Duplicate/i);
  }
});
