import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
let launches=0, connections=0;
mock.module('playwright',{namedExports:{chromium:{
  launch:async()=>{launches++;return {close:async()=>{}};},
  connectOverCDP:async()=>{connections++;throw new Error('A remotely recorded browser must not receive unscreened images');},
}}});
const {openBrowser}=await import('../server/lib/browserConnect.js');
test('local-only screening never uses a configured hosted browser',async()=>{
  const previous=process.env.BROWSER_WS_ENDPOINT;
  process.env.BROWSER_WS_ENDPOINT='wss://fixture.invalid/browser';
  try{
    const session=await openBrowser({purpose:'content-screening',localOnly:true});
    assert.equal(session.mode,'local');assert.equal(launches,1);assert.equal(connections,0);
    await session.close();
  }finally{if(previous===undefined)delete process.env.BROWSER_WS_ENDPOINT;else process.env.BROWSER_WS_ENDPOINT=previous;}
});
