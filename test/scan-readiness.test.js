import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runBrowser } from '../server/checks/browser.js';
import { runAgentBrowse } from '../server/checks/agentBrowse.js';
import { observeCheck } from '../server/provenance.js';
import { captureProof } from '../server/proof.js';
import { factsFor, scriptedModel, aliasedSession } from './helpers/fixture.js';

let server, origin;
const longScript = '/' + 'long-source-path-'.repeat(12) + '.js';
test.before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/redirect') {res.writeHead(302,{location:'/errors'});return res.end();}
    res.setHeader('content-type', req.url === longScript ? 'text/javascript' : 'text/html');
    if (req.url === longScript) return res.end('throw new Error("Minified React error #418; fixture hydration mismatch");');
    if (req.url === '/errors') return res.end('<!doctype html><body><p>A working page.</p><button onclick="this.textContent=\'Opened\'">Menu</button><script>console.error("Fixture console at first line");</script><script src="' + longScript + '"></script></body>');
    if (req.url === '/sparse') return res.end('<!doctype html><body><img alt="A logo" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2220%22 height=%2220%22/%3E"></body>');
    const later = req.url === '/delayed' ? '<script>setTimeout(() => { document.querySelector("main").textContent="The real page is ready for visitors."; document.querySelector("main").setAttribute("aria-busy","false"); },5000);</script>' : '';
    res.end('<!doctype html><body><main aria-busy="true">Loading...</main>' + later + '</body>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
});

test('runtime findings identify the document after a redirect', async () => {
  const result=await browserAt('/redirect');
  const finding=result.out.findings.find(f=>f.id==='console-errors');
  assert.deepEqual(finding.evidence.pages,[origin+'/errors']);
  assert.equal(result.out.pageLoads[0].page,origin+'/errors');
  assert.equal(result.out.pageLoads[0].requestedUrl,origin+'/redirect');
});
test.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
async function browserAt(path) {
  return observeCheck('browser', runBrowser, {url:new URL(path,origin),facts:await factsFor(origin,path)});
}

test('browser waits for a five second application loading screen and reports content-ready elapsed time', async () => {
  const result = await browserAt('/delayed');
  assert.equal(result.coverage.status, 'completed');
  const load = result.out.pageLoads?.[0];
  assert.equal(load?.status, 'ready');
  assert.ok(load.elapsedMs >= 4900, JSON.stringify(load));
  assert.ok(load.elapsedMs < 8500, JSON.stringify(load));
  assert.ok(result.out.findings.some(f => f.id === 'slow-load'));
});

test('a persistent loading shell is inconclusive and creates no healthy pass or broken-page claim', async () => {
  const result = await browserAt('/persistent');
  assert.equal(result.coverage.status, 'inconclusive');
  assert.equal(result.out.pageLoads?.[0]?.status, 'timed-out');
  assert.deepEqual(result.out.passes, []);
  assert.deepEqual(result.out.findings, []);
});

test('agent waits for the real content before its first observation', async () => {
  const model = scriptedModel(null);
  const result = await runAgentBrowse({url:new URL('/delayed',origin),facts:await factsFor(origin,'/delayed'),agentModel:model});
  assert.match(model.observationFor('/delayed')?.text || '', /real page is ready/);
  assert.equal(result.agent?.pageLoads?.[0]?.status, 'ready');
  assert.ok(result.agent.pageLoads[0].elapsedMs >= 4900);
});

test('reading a ready page again does not erase its measured initial load time',async()=>{
  let turn=0;
  const model=async()=>({message:{role:'assistant',content:'',tool_calls:[{id:'step-'+(++turn),type:'function',function:{name:turn===1?'scroll':'finish',arguments:JSON.stringify(turn===1?{direction:'down'}:{summary:'Finished observing.'})}}]},finishReason:'tool_calls'});
  const result=await runAgentBrowse({url:new URL('/delayed',origin),facts:await factsFor(origin,'/delayed'),agentModel:model});
  assert.equal(result.agent.pageLoads[0].status,'ready');
  assert.ok(result.agent.pageLoads[0].elapsedMs>=4900,JSON.stringify(result.agent.pageLoads));
});

test('proof capture waits for content and declines a persistent loading screen',async()=>{
  const publicOrigin='http://fixture.test:'+server.address().port;
  const session=await aliasedSession('fixture.test');
  try {
    for(const [path,expected] of [['/delayed',1],['/persistent',0]]) {
      const facts=await factsFor(origin,path,publicOrigin);
      const finding={id:'verbose-errors',severity:'watch',evidence:{lines:['Recorded text'],pages:[publicOrigin+path]}};
      const started=Date.now();
      const proof=await captureProof({facts,findings:[finding],session});
      assert.equal(proof.shots.length,expected,JSON.stringify(proof.declined));
      if(expected) assert.ok(Date.now()-started>=4900);
      else assert.match(proof.declined[0].reason,/loading screen/i);
    }
  } finally {await session.close();}
});

test('agent refuses a complaint inferred from a persistent loading shell', async () => {
  const note = {title:'The page is blank',what:'The page only says Loading.',where:origin+'/persistent',quote:'Loading...',severity:'watch',category:'quality',why:'Visitors cannot see content.',fix:'Repair the page.'};
  const model = scriptedModel(note);
  const result = await observeCheck('agent',runAgentBrowse,{url:new URL('/persistent',origin),facts:await factsFor(origin,'/persistent'),agentModel:model});
  assert.equal(result.coverage.status,'inconclusive');
  assert.deepEqual(result.out.findings,[]);
  assert.deepEqual(result.out.passes,[]);
  assert.equal(result.out.agent.pageLoads[0].status,'timed-out');
});

test('a sparse image page does not spend seven seconds waiting for text', async () => {
  const started = Date.now();
  const result = await browserAt('/sparse');
  assert.equal(result.out.pageLoads?.[0]?.status,'ready');
  assert.ok(Date.now()-started < 4000);
});

test('runtime evidence preserves long paths, one-based line and column, and no invented DOM impact', async () => {
  const result = await browserAt('/errors');
  const finding = result.out.findings.find(f=>f.id==='console-errors');
  assert.ok(finding);
  const errors = finding.evidence.runtimeErrors;
  assert.ok(Array.isArray(errors));
  const logged = errors.find(e=>e.kind==='console');
  assert.equal(logged.source.line,1);
  assert.ok(logged.source.column > 1);
  const thrown = errors.find(e=>e.kind==='pageerror');
  assert.equal(thrown.source.url,origin+longScript);
  assert.equal(thrown.source.line,1);
  assert.ok(thrown.source.column > 0);
  assert.equal(thrown.page,origin+'/errors');
  assert.equal(thrown.hydration,true);
  assert.equal(thrown.domLocation,null);
  assert.equal(thrown.html,null);
  assert.equal(thrown.impact,'not-tested');
  assert.doesNotMatch(finding.meaning,/menu.*stop|button.*stop|visitors.*cannot/i);
});
