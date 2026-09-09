import test, { mock, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { publicReport } from '../server/publicReport.js';

// Ephemeral key; no real signing key or database is read.
const { privateKey } = crypto.generateKeyPairSync('ed25519');
process.env.SIGNING_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
let stored;
mock.module('../server/db.js', { namedExports: { sql: async () => [stored] } });
const { signReport, verifyRouter } = await import('../server/verify.js');
const { canonicalize, publicKeyInfo, verify } = await import('../server/signing.js');
const app = express();
app.use(verifyRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
after(() => new Promise((resolve) => server.close(resolve)));

function fixture() {
  return {
    id: 'signed1', target: 'fixture.test', url: 'https://fixture.test/',
    scannedAt: '2026-09-09T12:00:00.000Z', grade: '?', score: null, gradeLabel: 'Not rated', ringPercent: 0,
    findings: [{ id: 'broken-links', severity: 'watch', title: 'A link did not load', source: 'scripted',
      meaning: 'We received a 404 response.', evidence: { lines: ['404 /old'], pages: ['https://fixture.test/'],
        items: [{ url: 'https://fixture.test/old', status: 404 }],
        shots: [{ key: 's1', sha256: 'fixture-content-hash' }] },
      provenance: { check: 'links', observedAt: '2026-09-09T12:00:00.000Z', scannerVersion: 'fixture-1' } }],
    passes: ['The homepage answered.'], summary: 'The checkup is incomplete.',
    coverage: [{ check: 'links', status: 'completed' }, { check: 'tls', status: 'failed', reason: 'Check failed.' }],
    assessment: { status: 'incomplete', reason: 'A required check failed.' },
    engine: { version: 'fixture-1', checksRun: ['links'], model: null },
    userId: 'private-account-id', contact: { emails: ['site-contact@fixture.test'] },
  };
}

async function assess(report) {
  stored = { id: report.id, target: report.target, grade: report.grade, score: report.score, report };
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/verify/${report.id}`);
  assert.equal(res.status, 200);
  return res.json();
}

test('new reports use v2 and survive the JSON storage boundary', async () => {
  const report = fixture();
  report.findings[0].evidence.optional = undefined;
  report.attestation = signReport(report);
  assert.equal(report.attestation.v, 2);
  const result = await assess(JSON.parse(JSON.stringify(report)));
  assert.equal(result.valid, true);
  assert.equal(result.report.score, null);
  assert.match(result.scope, /evidence/i);
  assert.match(result.limits, /correct|accuracy/i);
});

for (const [field, mutate] of [
  ['evidence', (r) => { r.findings[0].evidence.lines[0] = '200 /old'; }],
  ['source', (r) => { r.findings[0].source = 'agent'; }],
  ['meaning', (r) => { r.findings[0].meaning = 'Changed interpretation'; }],
  ['summary', (r) => { r.summary = 'All healthy'; }],
  ['passes', (r) => { r.passes.push('Fabricated pass'); }],
  ['coverage', (r) => { r.coverage[1].status = 'completed'; }],
  ['assessment', (r) => { r.assessment.status = 'complete'; }],
  ['engine version', (r) => { r.engine.version = 'replacement'; }],
  ['artifact hash', (r) => { r.findings[0].evidence.shots[0].sha256 = 'replacement'; }],
]) {
  test(`changing ${field} invalidates the v2 report signature`, async () => {
    const report = fixture();
    report.attestation = signReport(report);
    mutate(report);
    const result = await assess(report);
    assert.equal(result.valid, false);
    assert.match(result.reason, /contents|match/i);
  });
}

test('v2 signatures exclude ownership and contact but verify the public report', async () => {
  const report = fixture();
  report.findings[0].userId = 'private-reader';
  report.findings[0].disputed = { wrong: 2, right: 0, notes: ['private feedback'] };
  report.attestation = signReport(report);
  const before = report.attestation.signature;
  const view = publicReport(report, { id: 'private-account-id', emailVerified: true });
  delete view.contact;
  assert.equal(signReport(view).signature, before);
  const result = await assess(view);
  assert.equal(result.valid, true);
  assert.doesNotMatch(JSON.stringify(view), /private-reader|private feedback|private-account|site-contact/);
  assert.doesNotMatch(result.canonical, /private-account|site-contact/);
});

test('a separately signed v1 fixture retains its historical limited verification scope', async () => {
  // This payload is built without signReport, payloadFor, or canonicalize.
  // The digest is independently computed from the exact legacy finding bytes.
  const legacyFindingBytes = '[{"id":"broken-links","severity":"watch","title":"A link did not load"}]';
  const digest = crypto.createHash('sha256').update(legacyFindingBytes).digest('hex');
  const bytes = `{"findingsDigest":"${digest}","grade":"?","id":"signed1","scannedAt":"2026-09-09T12:00:00.000Z","score":null,"target":"fixture.test","url":"https://fixture.test/","v":1}`;
  const report = fixture();
  report.attestation = { v: 1, payload: JSON.parse(bytes), keyId: publicKeyInfo().keyId,
    signature: crypto.sign(null, Buffer.from(bytes), privateKey).toString('base64url') };
  assert.equal(verify(bytes, report.attestation.signature), true);
  report.findings[0].evidence.lines = ['Legacy evidence was never signed'];
  const result = await assess(report);
  assert.equal(result.valid, true);
  assert.equal(result.payload.v, 1);
  assert.match(result.scope, /id|title|severity/i);
  assert.match(result.limits, /does not|not cover/i);
});

test('canonical JSON follows storage semantics for missing properties and array entries', () => {
  assert.equal(canonicalize({ z: undefined, a: [undefined, null, { b: 1, a: 2 }] }), '{"a":[null,null,{"a":2,"b":1}]}');
});
