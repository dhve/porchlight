import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const publicRoot = new URL('../public/', import.meta.url);
const addresses = Array.from({length:13}, (_, i) => ({url:`https://fixture.example/picture-${i+1}.png`,
  status:0, statusText:'connection refused', page:'https://fixture.example/', kind:'image',
  text:i === 12 ? '<img src=x onerror=alert(1)>' : ''}));
const report = {id:'evidence13',target:'fixture.example',url:'https://fixture.example/',
  scannedAt:'2026-09-09T16:23:53.000Z',grade:'D',score:56,ringPercent:56,gradeLabel:'Needs care',
  summary:'The old report claimed an urgent server failure.',tally:{urgent:1,watch:1},passes:[],
  findings:[{id:'flow-error-contact',severity:'urgent',category:'broken-flow',title:'The contact page leads to an error',
    meaning:'The page returned a server error.',fix:['Repair the server.'],evidence:{
      why:'The server returned a 5xx error for every visitor.',method:'Requested twice.',
      lines:['connection refused /contact'],items:[{url:'https://fixture.example/contact',status:0,statusText:'connection refused',kind:'page'}]}},
    {id:'broken-images',severity:'watch',category:'quality',title:'13 images do not load',meaning:'Visitors see broken images.',
      evidence:{lines:[...addresses.slice(0,8).map(it=>`${it.statusText} ${new URL(it.url).pathname}`),'and 5 more'],items:addresses,
        why:'The images are broken for every visitor.',method:'Requested twice.'}}],engine:{reporter:'template'}};

let server, browser, origin;
test.before(async () => {
  server = createServer(async (req,res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    const json = value => {res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));};
    if (pathname === '/api/reports/evidence13') return json(report);
    if (pathname === '/api/me') return json({user:null});
    if (pathname === '/api/config') return json({requireAccount:false,google:false,github:false});
    if (pathname === '/api/reports') return json({db:true,reports:[]});
    if (pathname === '/api/reports/evidence13/feedback') return json({findings:{},mine:{},policy:{}});
    if (pathname === '/api/feedback/progress') return json({signals:{total:0},cases:{reviewed:0,confirmed:0,incorrect:0,inconclusive:0},limitation:'Synthetic fixture'});
    const file = pathname === '/r/evidence13' || pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!/^[a-z0-9.-]+$/i.test(file)) {res.writeHead(404);res.end();return;}
    try {
      const body = await readFile(new URL(file, publicRoot));
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
      res.writeHead(200,{'content-type':type});res.end(body);
    } catch {res.writeHead(404);res.end();}
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({headless:true});
});
test.after(async () => {
  await browser?.close();
  if (server) {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
async function openReport(t, fixture = report, viewer = null, onRequest = () => {}, configure = async () => {}) {
  const page = await browser.newPage({viewport:{width:390,height:844}});
  t.after(()=>page.close());
  page.on('request',onRequest);
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  if (fixture !== report) await page.route(origin+'/api/reports/evidence13', route => route.fulfill({json:fixture}));
  if (viewer) await page.route(origin+'/api/me', route => route.fulfill({json:{user:viewer}}));
  await configure(page);
  await page.goto(origin+'/r/evidence13');
  await page.locator('#screen-report.is-active').waitFor();
  await page.locator('.finding, .minor-notes').first().waitFor();
  return page;
}

test('review, loading times and exact runtime source locations are readable on phones', async t => {
  const source = `https://fixture.example/${'folder/'.repeat(35)}framework.js`;
  const fixture = {...report,grade:'A',score:100,assessment:{status:'complete'},tally:{minor:1},
    engine:{reporter:'llm',browser:{pageLoads:[{page:report.url,status:'ready',elapsedMs:5200,budgetMs:7000}]},proof:{review:{status:'completed',summary:'Recorded evidence reviewed.',counts:{supported:1,needsVerification:0}}}},
    findings:[{id:'runtime-errors',severity:'minor',title:'A browser runtime error was recorded',proofReview:{status:'supported',reason:'Observed error only.'},evidence:{runtimeErrors:[{page:report.url,message:'Minified React error #418',hydration:true,source:{url:source,line:17,column:46459},stack:'at render'}]}}]};
  const page = await openReport(t, fixture);
  await page.locator('.final-proof-review > summary').click();
  assert.match(await page.locator('.final-proof-review').innerText(), /does not guarantee correctness/);
  await page.locator('.page-loads > summary').click();
  assert.match(await page.locator('.page-loads').innerText(), /Ready after 5\.2 seconds/);
  await page.locator('.minor-notes > summary').click();
  await page.locator('details.proof > summary').click();
  const location = page.locator('.runtime-location');
  assert.equal(await location.locator(`a[href="${source}"]`).count(), 1);
  assert.match(await location.innerText(), /line 17, column 46459/);
  assert.match(await location.innerText(), /affected HTML element was not identified/);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
});

test('an unsupported finding is separated from instructions to fix confirmed issues', async t => {
  const fixture = {...report,grade:'A',score:100,tally:{},findings:[{id:'unconfirmed-control',severity:'urgent',title:'A menu may be broken',meaning:'Impact was not observed.',proofReview:{status:'needs-verification',reason:'No failed interaction recorded.'},evidence:{lines:['Runtime message observed.']}}]};
  const page = await openReport(t, fixture);
  assert.match(await page.locator('#findingsRoot').innerText(), /Observations needing verification/i);
  assert.doesNotMatch(await page.locator('#findingsRoot').innerText(), /Fix these first/i);
  await page.locator('details.proof > summary').click();
  assert.match(await page.locator('#findingsRoot').innerText(), /Adds no numeric penalty/);
});

test('feedback processes automatically and polling preserves an unfinished correction', async t => {
  let answer = null;
  let processed = false;
  const auto = () => ({ status: processed ? 'processed' : 'queued', outcome: processed ? 'unsupported' : null,
    summary: processed ? 'The recorded connection failure did not support this claim.' : 'Automatic processing is waiting.',
    lessons: processed ? [{ id: 'availability-transport-not-broken', scope: 'site', text: 'Treat failed connections as inconclusive.' }] : [] });
  const page = await openReport(t, report, null, () => {}, async page => {
    await page.route(origin+'/api/reports/evidence13/feedback', async route => {
      if (route.request().method() === 'POST') {
        answer = route.request().postDataJSON().verdict;
        return route.fulfill({ json: { findingId: 'flow-error-contact', right: 1, wrong: 0, mine: answer, auto: auto() } });
      }
      return route.fulfill({ json: { findings: answer ? { 'flow-error-contact': { right: 1, wrong: 0, auto: auto() } } : {},
        mine: answer ? { 'flow-error-contact': answer } : {} } });
    });
  });
  const slot = page.locator('.f-slot[data-finding="flow-error-contact"]');
  await slot.getByRole('button', { name: 'Yes', exact: true }).click();
  await slot.getByText('Automatic processing is waiting.', { exact: true }).waitFor();
  await slot.getByRole('button', { name: 'Change my answer' }).click();
  await slot.getByRole('button', { name: 'No', exact: true }).click();
  await slot.locator('textarea').fill('My unfinished correction');
  processed = true;
  await slot.getByText('The recorded connection failure did not support this claim.', { exact: true }).waitFor();
  assert.equal(await slot.locator('textarea').inputValue(), 'My unfinished correction');
  assert.equal(await slot.getByText('Treat failed connections as inconclusive.', { exact: true }).isVisible(), true);
  assert.doesNotMatch(await slot.textContent(), /await review|needs a human|Reviewer confirmed/);
});

test('an unconfirmed account sees verification instructions before scans or rechecks start', async t => {
  let requests = 0;
  const page = await openReport(t, report, { id: 'fixture-unconfirmed', emailVerified: false }, request => {
    const path = new URL(request.url()).pathname;
    if (path.includes('/api/checkup') || path.endsWith('/retest')) requests++;
  });
  const card = page.locator('.finding').filter({ has: page.locator('[data-finding="flow-error-contact"]') });
  await card.locator('details.proof > summary').click();
  await card.getByRole('button', { name: 'Recheck these addresses', exact: true }).click();
  await card.locator('.retest-out').getByText('Please confirm your email first. Check your inbox for the confirmation link.', { exact: true }).waitFor();
  await page.locator('#brandBtn').click();
  await page.locator('#urlInput').fill('https://fixture.example/');
  await page.locator('#startBtn').click();
  await page.locator('#formErr.show').waitFor();
  assert.match(await page.locator('#formErr').textContent(), /confirm your email/);
  assert.equal(requests, 0);
});

test('an old polling response cannot replace a newly submitted correction', async t => {
  let answer = null, reads = 0, releaseOld;
  const oldRead = new Promise(resolve => { releaseOld = resolve; });
  let notifyHeld;
  const held = new Promise(resolve => { notifyHeld = resolve; });
  const auto = (status, summary) => ({ status, summary, outcome: status === 'processed' ? 'feedback-only' : null, lessons: [] });
  const page = await openReport(t, report, null, () => {}, async page => {
    await page.route(origin+'/api/reports/evidence13/feedback', async route => {
      if (route.request().method() === 'POST') {
        answer = route.request().postDataJSON().verdict;
        return route.fulfill({ json: { right: answer === 'right' ? 1 : 0, wrong: answer === 'wrong' ? 1 : 0, mine: answer,
          auto: auto('queued', answer === 'right' ? 'First response queued.' : 'Correction queued.') } });
      }
      reads++;
      if (reads === 1) return route.fulfill({ json: { findings: {}, mine: {} } });
      if (reads === 2) {
        notifyHeld(); await oldRead;
        return route.fulfill({ json: { findings: { 'flow-error-contact': { right: 1, wrong: 0, auto: auto('processed', 'Old response processed.') } }, mine: { 'flow-error-contact': 'right' } } });
      }
      return route.fulfill({ json: { findings: { 'flow-error-contact': { right: 0, wrong: 1, auto: auto('processed', 'New correction processed.') } }, mine: { 'flow-error-contact': 'wrong' } } });
    });
  });
  t.after(() => releaseOld());
  const slot = page.locator('.f-slot[data-finding="flow-error-contact"]');
  await slot.getByRole('button', { name: 'Yes', exact: true }).click();
  await held;
  await slot.getByRole('button', { name: 'Change my answer' }).click();
  await slot.getByRole('button', { name: 'No', exact: true }).click();
  await slot.locator('textarea').fill('The earlier answer was mistaken.');
  await slot.getByRole('button', { name: 'Send', exact: true }).click();
  await slot.getByText('Correction queued.', { exact: true }).waitFor();
  releaseOld();
  await slot.getByText('New correction processed.', { exact: true }).waitFor();
  assert.equal(await slot.getByText('Old response processed.', { exact: true }).count(), 0);
  assert.ok(reads >= 3);
});

test('all recorded image addresses are available beyond the old eight-line cutoff', async t => {
  const page = await openReport(t);
  const card = page.locator('.finding').filter({has:page.locator('[data-finding="broken-images"]')});
  await card.locator('details.proof > summary').click();
  const expansion = card.getByText('Show all 13 recorded addresses',{exact:true});
  assert.equal(await expansion.count(),1);
  await expansion.click();
  assert.equal(await card.locator('.proof-addresses a').count(),13);
  assert.equal(await card.getByRole('link',{name:'/picture-13.png',exact:true}).isVisible(),true);
  assert.equal(await card.locator('.proof-addresses img').count(),0);
  assert.equal(await card.locator('.proof-addresses').getByText('<img src=x onerror=alert(1)>',{exact:true}).isVisible(),true);
  assert.equal(await card.getByText('and 5 more',{exact:true}).count(),0);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
});

test('a minor saved finding with malformed item data still renders', async t => {
  const fixture = {...report,findings:[{id:'broken-links',severity:'minor',category:'quality',
    title:'Recorded minor note',meaning:'Original explanation',
    evidence:{items:{url:'https://fixture.example/a',status:0}}}]};
  const page = await openReport(t, fixture);
  await page.locator('.minor-notes > summary').click();
  assert.equal(await page.getByText('Recorded minor note',{exact:true}).isVisible(),true);
});

test('an old refused connection is clarified before its original urgent claim and grade', async t => {
  const page = await openReport(t);
  assert.equal(await page.getByRole('heading',{name:'This report needs verification',exact:true}).isVisible(),true);
  assert.match(await page.locator('#scorecard .glabel').innerText(),/original grade/i);
  assert.equal(await page.locator('#scorecard .letter').innerText(),'D');
  assert.equal(await page.locator('#scorecard .tally.urgent').count(),0);
  assert.equal(await page.locator('.finding.urgent').count(),0);
  const contact = page.locator('.finding').filter({has:page.locator('[data-finding="flow-error-contact"]')});
  assert.match(await contact.locator('.sev-chip').innerText(),/needs verification/i);
  assert.match(await contact.locator('.f-mean').innerText(),/no HTTP response/i);
  const original = contact.getByText('Original finding and suggested fixes',{exact:true});
  assert.equal(await original.count(),1);
  await original.click();
  assert.equal(await contact.getByText('The contact page leads to an error',{exact:true}).isVisible(),true);
  await contact.locator('details.proof > summary').click();
  assert.equal(await contact.locator('.proof-why').isVisible(),false);
  await contact.getByText('Original interpretation and testing notes',{exact:true}).click();
  assert.equal(await contact.locator('.proof-why').isVisible(),true);
  assert.match(await contact.locator('.proof-why').innerText(),/The server returned a 5xx error for every visitor\./);
});

test('a successful recheck of an old connection failure says loaded without claiming a fix', async t => {
  const page = await openReport(t, report, {id:'fixture-user',name:'Fixture reader',emailVerified:true});
  await page.route(origin+'/api/reports/evidence13/retest', route => route.fulfill({json:{
    checkedAt:new Date().toISOString(),scope:'http-availability',items:[{
      url:'https://fixture.example/contact',status:200,statusText:'OK',
      classification:'working',changed:null,comparisonReason:'unknown-baseline'}]}}));
  const contact = page.locator('.finding').filter({has:page.locator('[data-finding="flow-error-contact"]')});
  await contact.locator('details.proof > summary').click();
  await contact.getByRole('button',{name:'Recheck these addresses',exact:true}).click();
  await contact.locator('.retest-line').waitFor();
  const text = await contact.locator('.retest-line').innerText();
  assert.match(text,/Address loaded/);
  assert.match(text,/200 OK/);
  assert.match(text,/does not establish a change/);
  assert.doesNotMatch(text,/unknown-baseline|same as|fixed|Could not confirm/);
});

test('an anonymous recheck opens sign-in before any recheck request', async t => {
  const page = await openReport(t);
  let rechecks = 0;
  page.on('request', req => {if (new URL(req.url()).pathname.endsWith('/retest')) rechecks++;});
  const contact = page.locator('.finding').filter({has:page.locator('[data-finding="flow-error-contact"]')});
  await contact.locator('details.proof > summary').click();
  await contact.getByRole('button',{name:'Recheck these addresses',exact:true}).click();
  await page.waitForURL('**/login?**',{timeout:3000});
  assert.equal(await page.locator('#auLoginBtn').isVisible(),true);
  const destination = new URL(page.url());
  assert.equal(destination.pathname,'/login');
  assert.equal(destination.searchParams.get('next'),'/r/evidence13');
  assert.equal(rechecks,0);
});

test('an anonymous scan opens sign-in with the website address retained', async t => {
  const page = await openReport(t);
  let scans = 0;
  page.on('request', req => {if (new URL(req.url()).pathname.startsWith('/api/checkup')) scans++;});
  await page.getByRole('button',{name:'SUTROS home',exact:true}).click();
  await page.locator('#urlInput').fill('https://fixture.example/contact');
  await page.locator('#checkForm button[type="submit"]').click();
  await page.waitForURL('**/login?**',{timeout:3000});
  assert.equal(await page.locator('#auLoginBtn').isVisible(),true);
  const destination = new URL(page.url());
  assert.equal(destination.pathname,'/login');
  assert.equal(destination.searchParams.get('next'),'/?url=https%3A%2F%2Ffixture.example%2Fcontact');
  assert.equal(scans,0);
});
