import test from 'node:test';
import assert from 'node:assert/strict';
import { explain } from '../server/explain.js';

test('connection-only evidence selects a limitation instead of a server-error explanation', () => {
  for (const id of ['flow-error-contact','flow-missing-contact','broken-images','broken-links']) {
    const finding = {id,evidence:{items:[{url:'https://fixture.example/page',status:0,statusText:'connection refused'}]}};
    const explanation = explain(finding);
    assert.match(explanation.why,/no HTTP response/i,id);
    assert.doesNotMatch(explanation.why,/server answered|dead end for every|not a case of|counts as really broken/i,id);
  }
});

test('the explanation uses the recorded HTTP status rather than guessing from a finding id', () => {
  const explanation = explain({id:'flow-error-contact',evidence:{items:[{url:'https://fixture.example/page',status:404}]}});
  assert.match(explanation.why,/404/);
  assert.doesNotMatch(explanation.why,/5xx|every visitor|failure repeats on every attempt/);
});

test('a successful or absent HTTP observation cannot supply an error explanation', () => {
  for (const evidence of [{items:[{url:'https://fixture.example/',status:200}]}, {items:[]}]) {
    const explanation = explain({id:'broken-links',evidence});
    assert.match(explanation.why,/does not establish an HTTP error/i);
  }
});
