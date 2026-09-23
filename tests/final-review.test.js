import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewProof } from '../server/finalReview.js';

const original = {id:'console-errors',source:'scripted',severity:'watch',title:'JavaScript errors were recorded',meaning:'An error was logged; its effect was not tested.',
  provenance:{check:'browser'},evidence:{lines:['Error: fixture at https://fixture.test/app.js:1:5'],pages:['https://fixture.test/'],runtimeErrors:[{message:'Error: fixture',page:'https://fixture.test/',source:{url:'https://fixture.test/app.js',line:1,column:5}}]}};
const input = findings => ({target:'fixture.test',summary:'Fixture draft summary',findings,passes:['Recorded pass'],coverage:[{check:'browser',status:'completed'}],assessment:{status:'complete'},proof:{shots:[],skipped:null}});
const answer = decisions => new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({reportSupported:true,decisions})}}]}),{headers:{'content-type':'application/json'}});
test.beforeEach(t=>{
  const old=process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY='fixture-key';
  t.after(()=>{if(old===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=old;});
});
test('final review sees final evidence and available images while preserving original observations',async t=>{
  const finding=structuredClone(original);finding.evidence.shots=[{key:'s1',page:'https://fixture.test/'}];
  const before=structuredClone(finding);
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    const content=JSON.parse(options.body).messages[1].content;
    const payload=JSON.parse(content.find(p=>p.type==='text').text);
    assert.equal(payload.summary,'Fixture draft summary');
    assert.equal(payload.findings[0].evidence.shots[0].available,true);
    assert.equal(content.filter(p=>p.type==='image_url').length,1);
    return answer([{id:'console-errors',status:'supported',reasonCode:'observation-supported'}]);
  });
  const result=await reviewProof({...input([finding]),proof:{shots:[{key:'s1',mime:'image/jpeg',bytes:Buffer.from('fixture-image')}],skipped:null}});
  assert.equal(result.review.status,'completed');assert.equal(result.findings[0].proofReview.status,'supported');
  const {proofReview,...measured}=result.findings[0];assert.deepEqual(measured,before);assert.deepEqual(finding,before);
  assert.doesNotMatch(JSON.stringify(result),/fixture-image|base64/);
});
test('final review includes all six proof images and three agent images within the stored image budget',async t=>{
  const shots=Array.from({length:9},(_,i)=>({key:'s'+(i+1),mime:'image/jpeg',bytes:Buffer.from('fixture-image'),page:'https://fixture.test/'}));
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    const content=JSON.parse(options.body).messages[1].content;
    assert.equal(content.filter(part=>part.type==='image_url').length,9);
    return answer([]);
  });
  assert.equal((await reviewProof({...input([]),proof:{shots}})).review.status,'completed');
});
test('a model cannot certify a broken button from a runtime error without measured interaction evidence',async t=>{
  const finding={...original,title:'The menu button is broken',meaning:'The menu button does not work.',evidence:{...original.evidence,interactions:[]}};
  t.mock.method(globalThis,'fetch',async()=>answer([{id:finding.id,status:'supported',reasonCode:'observation-supported'}]));
  const result=await reviewProof(input([finding]));
  assert.equal(result.findings[0].proofReview.status,'needs-verification');
  assert.match(result.findings[0].proofReview.reason,/interaction|action/i);
});
test('missing decisions or invented ids cannot count as a completed review',async t=>{
  for(const decisions of [[],[{id:'invented',status:'supported',reasonCode:'observation-supported'}]]){
    t.mock.method(globalThis,'fetch',async()=>answer(decisions));
    const result=await reviewProof(input([original]));
    assert.equal(result.review.status,'incomplete');assert.equal(result.findings[0].proofReview.status,'needs-verification');
  }
});
test('model-added severity, evidence, or prose confirmations are rejected',async t=>{
  t.mock.method(globalThis,'fetch',async()=>answer([{id:original.id,status:'supported',reasonCode:'observation-supported',severity:'urgent',evidence:{lines:['invented']},reason:'I clicked every button.'}]));
  const result=await reviewProof(input([original]));
  assert.equal(result.review.status,'incomplete');assert.equal(result.findings[0].severity,'watch');assert.deepEqual(result.findings[0].evidence,original.evidence);
  assert.doesNotMatch(JSON.stringify(result),/clicked every button|invented/);
});
test('provider failure and missing credentials cannot be shown as supported evidence',async t=>{
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('private provider detail');});
  assert.equal((await reviewProof(input([original]))).review.status,'incomplete');
  delete process.env.OPENAI_API_KEY;
  const result=await reviewProof(input([original]));
  assert.equal(result.review.status,'unavailable');assert.equal(result.findings[0].proofReview.status,'needs-verification');
  assert.doesNotMatch(JSON.stringify(result),/private provider detail/);
});
test('empty clean candidates still receive the final AI review',async t=>{
  let called=false;t.mock.method(globalThis,'fetch',async()=>{called=true;return answer([]);});
  assert.equal((await reviewProof(input([]))).review.status,'completed');assert.equal(called,true);
});
test('a missing report-level decision cannot complete even an empty review',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({choices:[{message:{content:'{"decisions":[]}'}}]})));
  assert.equal((await reviewProof(input([]))).review.status,'incomplete');
});
test('a screenshot reference without bytes is reported as unavailable and cannot substitute for evidence',async t=>{
  const finding={id:'empty',severity:'watch',evidence:{shots:[{key:'s1'}]}};
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    const payload=JSON.parse(JSON.parse(options.body).messages[1].content[0].text);
    assert.equal(payload.findings[0].evidence.shots[0].available,false);
    return answer([{id:'empty',status:'supported',reasonCode:'observation-supported'}]);
  });
  assert.equal((await reviewProof(input([finding]))).findings[0].proofReview.status,'needs-verification');
});
