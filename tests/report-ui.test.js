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
  assert.equal(view.recheckState({classification:'broken',changed:false}).label, 'Address still failed');
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
