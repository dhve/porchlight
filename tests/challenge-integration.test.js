import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, probeAddress } from '../server/lib/http.js';
import { runRecon } from '../server/checks/recon.js';
import { observeCheck } from '../server/provenance.js';
import { createRetestRouter } from '../server/retest.js';
import express from 'express';

const challenge = '<html><head><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?check=1"></head></html>';
test('an accepted hosting challenge never becomes a working address', async t => {
  const methods = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    methods.push(options.method);
    return new Response(options.method === 'HEAD' ? null : challenge, {status:202,headers:{'content-type':'text/html'}});
  });
  const result = await probeAddress(createClient(), 'https://example.com/quality/');
  assert.equal(result.verdict, 'blocked');
  assert.equal(result.reason, 'challenge');
  assert.ok(methods.includes('GET'), 'a HEAD202 requires the response body to identify the challenge');
});
test('a challenged homepage stops discovery and reports the limitation', async t => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(String(url));
    return new Response(challenge, {status:202,headers:{'content-type':'text/html'}});
  });
  const result = await runRecon({client:createClient(),url:new URL('https://example.com/')});
  assert.equal(result.status, 'inconclusive');
  assert.ok(result.facts.challenged);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.passes, []);
  assert.equal(urls.length, 1, 'do not crawl more pages after the homepage was challenged');
});
test('a legitimate accepted JSON response is not a bot challenge', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{"accepted":true}', {status:202,headers:{'content-type':'application/json'}}));
  const result = await probeAddress(createClient(), 'https://example.com/status', {headFirst:false});
  assert.equal(result.verdict, 'ok');
});
for (const status of [200, 204]) test(`an empty HTTP${status} homepage cannot support a checkup`, async t => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(String(url));
    return new Response(status === 204 ? null : '   ', {status,headers:{'content-type':'text/html'}});
  });
  const result = await runRecon({client:createClient(),url:new URL('https://example.com/')});
  assert.equal(result.status, 'inconclusive');
  assert.deepEqual(result.passes, []);
  assert.equal(urls.length, 1);
});
test('a successful GET retry resolves a refused HEAD at the same address', async () => {
  const response = status => ({status});
  const client = {head:async () => response(503),get:async () => response(200)};
  const result = await observeCheck('links', async ctx => {
    await ctx.client.head('https://example.com/page');
    await ctx.client.get('https://example.com/page');
    return {findings:[],passes:['The sampled address loaded.']};
  }, {client});
  assert.equal(result.coverage.status, 'completed');
});
test('a recheck cannot turn a hosting challenge into a repaired address', async t => {
  const app = express(); app.use(express.json());
  app.use(createRetestRouter({
    dbOn:()=>true,loadReport:async()=>({findings:[{id:'broken-links',evidence:{items:[{url:'https://example.com/missing',status:404}]}}]}),
    resolve:async()=>({ok:true}),consumeFn:()=>({ok:true}),saveAttempt:async()=>null,
    makeClient:()=>({get:async()=>({status:202,headers:new Headers({'content-type':'text/html'}),text:async()=>challenge,discard(){}})}),
  }));
  const server = app.listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/reports/fixture1/retest`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({findingId:'broken-links'})});
  const result = await response.json();
  assert.equal(result.items[0].classification,'inconclusive');
  assert.equal(result.items[0].changed,null);
  assert.equal(result.items[0].reason,'challenge');
});
