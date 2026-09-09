// Offline evaluation of explicit candidate decisions against reviewed cases.
// No network, database, model calls, or production changes occur here.
import { createHash } from 'node:crypto';

const LABELS = ['present', 'absent', 'inconclusive'];
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (message) => { throw new Error('Invalid evaluation input: ' + message); };

function fields(value, allowed, name) {
  if (!object(value)) invalid(name + ' must be an object.');
  for (const field of Object.keys(value)) if (!allowed.includes(field)) invalid('Unknown ' + name + ' field: ' + field);
}
function text(value, name, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max) invalid(name + ' is required and must be bounded text.');
}
function timestamp(value, name) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid(name + ' must be an ISO timestamp.');
}

export function validateCases(data) {
  fields(data, ['schemaVersion', 'exportedAt', 'selectionNote', 'cases'], 'cases file');
  if (data.schemaVersion !== 1) invalid('cases schemaVersion must be 1.');
  timestamp(data.exportedAt, 'exportedAt');
  text(data.selectionNote, 'selectionNote', 2000);
  if (!Array.isArray(data.cases) || data.cases.length > 10000) invalid('cases must be an array of at most 10,000 reviewed cases.');
  const seen = new Set();
  for (const entry of data.cases) {
    fields(entry, ['caseId', 'reportId', 'findingId', 'expected', 'report', 'finding', 'provenance'], 'case');
    if (typeof entry.caseId !== 'string' || !ID.test(entry.caseId)) invalid('caseId must be a bounded identifier.');
    if (seen.has(entry.caseId)) invalid('Duplicate caseId: ' + entry.caseId);
    seen.add(entry.caseId);
    text(entry.reportId, 'reportId', 120);
    text(entry.findingId, 'findingId', 120);
    if (!['present', 'absent'].includes(entry.expected)) invalid('expected must be present or absent.');
    if (!object(entry.report) || entry.report.id !== entry.reportId || !object(entry.finding) || entry.finding.id !== entry.findingId) invalid('report and finding snapshots must match their identifiers.');
    fields(entry.provenance, ['reviewId', 'status', 'reason', 'reviewedAt', 'findingDigest'], 'provenance');
    text(entry.provenance.reviewId, 'reviewId', 120);
    text(entry.provenance.reason, 'review reason', 2000);
    timestamp(entry.provenance.reviewedAt, 'reviewedAt');
    if (entry.provenance.status !== (entry.expected === 'present' ? 'confirmed' : 'incorrect')) invalid('Only matching conclusive review decisions are labels.');
    if (typeof entry.provenance.findingDigest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.provenance.findingDigest)) invalid('findingDigest must be a SHA-256 digest.');
  }
  return data;
}

export function validateCandidate(candidate, cases) {
  fields(candidate, ['schemaVersion', 'candidateVersion', 'decisions'], 'candidate');
  if (candidate.schemaVersion !== 1) invalid('candidate schemaVersion must be 1.');
  text(candidate.candidateVersion, 'candidateVersion');
  if (!object(candidate.decisions)) invalid('decisions must be an object keyed by caseId.');
  const known = new Set(cases.map((entry) => entry.caseId));
  for (const [id, decision] of Object.entries(candidate.decisions)) {
    if (!known.has(id)) invalid('Unknown caseId in candidate: ' + id);
    if (!LABELS.includes(decision)) invalid('Unknown decision for ' + id + '. Use present, absent, or inconclusive.');
  }
  return candidate;
}

const ratio = (numerator, denominator) => ({ numerator, denominator, value: denominator ? numerator / denominator : null });
function metrics(cases, candidate) {
  const counts = { truePositive: 0, falsePositive: 0, trueNegative: 0, falseNegative: 0, inconclusive: 0, missing: 0, explicitInconclusive: 0 };
  let expectedPresent = 0;
  for (const entry of cases) {
    if (entry.expected === 'present') expectedPresent++;
    const missing = !Object.hasOwn(candidate.decisions, entry.caseId);
    const decision = missing ? 'inconclusive' : candidate.decisions[entry.caseId];
    if (decision === 'inconclusive') {
      counts.inconclusive++;
      counts[missing ? 'missing' : 'explicitInconclusive']++;
    } else if (decision === 'present') counts[entry.expected === 'present' ? 'truePositive' : 'falsePositive']++;
    else counts[entry.expected === 'absent' ? 'trueNegative' : 'falseNegative']++;
  }
  const decided = cases.length - counts.inconclusive;
  const agree = counts.truePositive + counts.trueNegative;
  return { candidateVersion: candidate.candidateVersion, totalCases: cases.length,
    expected: { present: expectedPresent, absent: cases.length - expectedPresent }, counts,
    decidedCoverage: ratio(decided, cases.length), agreementOnDecided: ratio(agree, decided), agreementAcrossReviewed: ratio(agree, cases.length),
    precisionOnDecided: ratio(counts.truePositive, counts.truePositive + counts.falsePositive),
    recallOnReviewedPositives: ratio(counts.truePositive, expectedPresent) };
}

function compare(cases, candidate, baseline) {
  const result = { totalCases: cases.length, commonDecided: 0, improved: 0, regressed: 0, bothAgree: 0, bothDisagree: 0, candidateOnlyDecided: 0, baselineOnlyDecided: 0, neitherDecided: 0 };
  for (const entry of cases) {
    const c = candidate.decisions[entry.caseId] ?? 'inconclusive';
    const b = baseline.decisions[entry.caseId] ?? 'inconclusive';
    if (c === 'inconclusive' && b === 'inconclusive') result.neitherDecided++;
    else if (c === 'inconclusive') result.baselineOnlyDecided++;
    else if (b === 'inconclusive') result.candidateOnlyDecided++;
    else {
      result.commonDecided++;
      if (c === entry.expected && b === entry.expected) result.bothAgree++;
      else if (c !== entry.expected && b !== entry.expected) result.bothDisagree++;
      else result[c === entry.expected ? 'improved' : 'regressed']++;
    }
  }
  return result;
}

export function evaluateFeedback(data, candidate, baseline = null) {
  validateCases(data);
  validateCandidate(candidate, data.cases);
  if (baseline) validateCandidate(baseline, data.cases);
  const result = { schemaVersion: 1, evaluatedAt: new Date().toISOString(),
    casesDigest: createHash('sha256').update(JSON.stringify(data)).digest('hex'),
    limitation: 'These selected human-reviewed cases are not a representative measure of overall model accuracy. Missing and inconclusive decisions are never counted as agreements. A comparison does not automatically approve a release.',
    candidate: metrics(data.cases, candidate) };
  if (baseline) { result.baseline = metrics(data.cases, baseline); result.comparison = compare(data.cases, candidate, baseline); }
  return result;
}

// JSON.parse accepts duplicate object keys and keeps only the final value. Reject
// duplicates before they can silently replace a candidate decision or a label.
export function parseStrictJSON(source) {
  let index = 0;
  const space = () => { while (/[\t\n\r ]/.test(source[index] || '\0')) index++; };
  const fail = (message) => invalid(message + ' at character ' + index + '.');
  function string() {
    const start = index++;
    while (index < source.length) {
      if (source[index] === '\\') { index += 2; continue; }
      if (source[index++] === '"') {
        try { return JSON.parse(source.slice(start, index)); } catch { fail('Malformed JSON string'); }
      }
    }
    fail('Unterminated JSON string');
  }
  function value(depth) {
    if (depth > 64) fail('JSON nesting is too deep');
    space();
    const token = source[index];
    if (token === '"') return string();
    if (token === '{') {
      index++; space();
      const out = Object.create(null);
      const seen = new Set();
      if (source[index] === '}') { index++; return out; }
      while (index < source.length) {
        space();
        if (source[index] !== '"') fail('Expected an object key');
        const key = string();
        if (seen.has(key)) fail('Duplicate JSON key');
        seen.add(key); space();
        if (source[index++] !== ':') fail('Expected a colon');
        out[key] = value(depth + 1); space();
        const end = source[index++];
        if (end === '}') return out;
        if (end !== ',') fail('Expected a comma or closing brace');
      }
      fail('Unterminated JSON object');
    }
    if (token === '[') {
      index++; space();
      const out = [];
      if (source[index] === ']') { index++; return out; }
      while (index < source.length) {
        out.push(value(depth + 1)); space();
        const end = source[index++];
        if (end === ']') return out;
        if (end !== ',') fail('Expected a comma or closing bracket');
      }
      fail('Unterminated JSON array');
    }
    for (const [literal, parsed] of [['true', true], ['false', false], ['null', null]]) {
      if (source.startsWith(literal, index)) { index += literal.length; return parsed; }
    }
    const match = source.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) fail('Expected a JSON value');
    index += match[0].length;
    const number = Number(match[0]);
    if (!Number.isFinite(number)) fail('JSON numbers must be finite');
    return number;
  }
  const result = value(0);
  space();
  if (index !== source.length) fail('Unexpected trailing JSON content');
  return result;
}
