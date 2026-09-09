import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/evidence-view.js';
const view = globalThis.SutrosEvidence;

test('incomplete and legacy unknown reports never receive a reassuring headline', () => {
  for (const report of [
    {grade:'A',score:100,assessment:{status:'incomplete',reason:'Recon failed'}},
    {grade:'?',score:null},
  ]) {
    assert.equal(view.assessment(report).incomplete, true);
    assert.equal(view.assessment(report).headline, 'This checkup is incomplete');
  }
});
test('an old boolean result, timeout, or unknown baseline stays inconclusive', () => {
  for (const item of [{ok:true,status:200}, {classification:'inconclusive',status:0,changed:false}]) {
    const result = view.recheckState(item);
    assert.equal(result.classification, 'inconclusive');
    assert.equal(result.label, 'Could not confirm');
    assert.doesNotMatch(result.detail, /same|works now/);
  }
});
test('explicit working and broken observations keep their limited scope', () => {
  assert.equal(view.recheckState({classification:'working',changed:true}).label, 'Address loaded');
  assert.equal(view.recheckState({classification:'broken',changed:false}).label, 'This request received an error');
});
test('only supported HTTP availability findings offer a recheck', () => {
  const evidence = {items:[{url:'https://example.com/page',status:404}]};
  assert.equal(view.retestSupported({id:'broken-links',evidence}), true);
  assert.equal(view.retestSupported({id:'flow-error-contact',evidence}), true);
  for (const id of ['not-mobile-friendly','leaked-secret','broken-images-render','failed-resources','agent-broken-links']) {
    assert.equal(view.retestSupported({id,evidence}), false, id);
  }
  assert.equal(view.retestSupported({id:'broken-links',source:'agent',evidence}), false);
  assert.equal(view.retestSupported({id:'broken-links',evidence:{items:[{url:'javascript:alert(1)'}]}}), false);
});

test('stored transport-only failures make the old grade unverified without changing the report', () => {
  const report = {grade:'D',score:56,findings:[{id:'flow-error-contact',severity:'urgent',
    evidence:{items:[{url:'https://fixture.example/contact',status:0,statusText:'connection refused'}]}}]};
  const original = structuredClone(report);
  const result = view.assessment(report);
  assert.equal(result.networkLimited, true);
  assert.equal(result.incomplete, true);
  assert.deepEqual(report, original);
});

test('actual HTTP errors keep their ordinary assessment and separate security findings are unaffected', () => {
  const report = {grade:'D',score:56,findings:[
    {id:'flow-error-contact',severity:'urgent',evidence:{items:[{url:'https://fixture.example/contact',status:500}]}},
    {id:'tls-error',severity:'serious',evidence:{items:[{url:'https://fixture.example/',status:0}]}},
  ]};
  assert.equal(Boolean(view.assessment(report).networkLimited), false);
  assert.equal(view.assessment(report).incomplete, false);
});

test('malformed legacy evidence cannot stop report assessment', () => {
  for (const items of [{url:'https://fixture.example/a',status:0}, 'unstructured old evidence']) {
    const finding = {id:'broken-links',severity:'minor',evidence:{items}};
    assert.equal(view.retestSupported(finding), false);
    assert.equal(view.connectionLimitation(finding), null);
    assert.equal(view.assessment({grade:'B',score:85,findings:[finding]}).networkLimited, false);
  }
});

test('recheck limitations explain the result without internal reason codes', () => {
  for (const reason of ['unknown-baseline','response-read-failed','redirect-loop','not-allowed']) {
    const state = view.recheckState({classification:'inconclusive',reason});
    assert.notEqual(state.detail, reason);
    assert.match(state.detail,/\s/);
  }
});
