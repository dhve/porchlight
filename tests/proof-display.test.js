import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/evidence-view.js';
const view = globalThis.SutrosEvidence;

test('the review display keeps supported observations distinct from verification and guarantees', () => {
  const html = view.reviewCard({engine:{proof:{review:{status:'completed',counts:{supported:2,needsVerification:1},summary:'Examined the recorded evidence.'}}}});
  assert.match(html, /2 supported/);
  assert.match(html, /1 need further verification/);
  assert.match(html, /does not guarantee/);
  assert.equal(view.reviewCard({}), '');
  assert.match(view.findingReview({proofReview:{status:'needs-verification',reason:'No interaction tested.'}}), /Adds no numeric penalty/);
});
test('load results show elapsed time, seven-second limit, and page address without claiming timeouts loaded', () => {
  const html = view.pageLoadsCard({engine:{browser:{pageLoads:[{page:'https://example.com/',status:'ready',elapsedMs:5200,budgetMs:7000}]}},agent:{pageLoads:[{page:'https://example.com/contact',status:'timed-out',elapsedMs:7200,budgetMs:7000,reason:'Still loading'}]}});
  assert.match(html, /Ready after 5\.2 seconds/);
  assert.match(html, /Still loading after 7\.2 seconds/);
  assert.match(html, /7-second/);
  assert.match(html, /https:\/\/example.com\/contact/);
});
test('runtime display preserves full script coordinates and admits unknown HTML or visitor impact', () => {
  const path = `https://example.com/${'long-folder/'.repeat(25)}app.js`;
  const html = view.runtimeLocations({evidence:{runtimeErrors:[{page:'https://example.com/page',message:'Minified React error #418',hydration:true,source:{url:path,line:17,column:46459},stack:'at render',domLocation:null,html:null,impact:'not-tested'}]}});
  assert.ok(html.includes(path));
  assert.match(html, /line 17, column 46459/);
  assert.match(html, /affected HTML element was not identified/);
  assert.match(html, /does not establish that a button/);
  assert.match(html, /recover/);
});
test('report proof markup escapes untrusted text and refuses unsafe links', () => {
  const html = view.runtimeLocations({evidence:{runtimeErrors:[{page:'javascript:alert(1)',message:'<img src=x onerror=alert(1)>',source:{url:'javascript:alert(1)',line:1,column:1},html:'<script>bad()</script>',domLocation:'<b>test</b>'}]}});
  assert.doesNotMatch(html, /href="javascript:|<img|<script>|<b>test/);
  assert.match(html, /&lt;img/);
  const review = view.reviewCard({engine:{proof:{review:{status:'incomplete',summary:'<script>bad()</script>',counts:{}}}}});
  assert.doesNotMatch(review, /<script>/);
});
test('A+ has its own bounded clean-check headline', () => {
  assert.equal(view.assessment({grade:'A+',score:100}).headline, 'No issues found in these checks');
});
test('a rejected report is explained as a withheld grade rather than a failed reviewer',()=>{
  const html=view.reviewCard({engine:{proof:{review:{status:'incomplete',reason:'unsupported-report',summary:'The review found unsupported claims.',counts:{}}}}});
  assert.match(html,/Final evidence review withheld the overall grade/);
  assert.doesNotMatch(html,/could not finish/);
});
