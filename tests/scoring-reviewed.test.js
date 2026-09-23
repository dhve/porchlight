import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreReport } from '../server/scoring.js';

const assessment = {status:'complete'};
const eligibility = {review:{status:'completed'},coverage:['recon','browser','agent'].map(check=>({check,status:'completed'}))};
test('a completed reviewed scan with only minor notes earns A+',()=>{
  assert.equal(scoreReport([{id:'minor',severity:'minor'}],assessment,eligibility).grade,'A+');
});
test('an unresolved agent issue prevents A+ without a numeric penalty',()=>{
  const result=scoreReport([{id:'agent-note',source:'agent',severity:'watch'}],assessment,eligibility);
  assert.equal(result.grade,'A'); assert.equal(result.score,100);
});
test('missing review or skipped/inconclusive browser coverage cannot earn A+',()=>{
  for(const options of [{...eligibility,review:{status:'unavailable'}},{...eligibility,coverage:[{check:'browser',status:'inconclusive'},{check:'agent',status:'completed'}]},{}]) {
    assert.notEqual(scoreReport([],assessment,options).grade,'A+');
  }
  assert.equal(scoreReport([],{status:'incomplete'},eligibility).grade,'?');
});
test('an unsupported claim is withheld from penalties but is not a clean A+',()=>{
  const finding={id:'claim',severity:'urgent',proofReview:{status:'needs-verification'}};
  const result=scoreReport([finding],assessment,eligibility);
  assert.equal(result.score,100); assert.equal(result.grade,'A');
});
