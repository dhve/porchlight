import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { registerHooks } from "node:module";
import { once } from "node:events";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import express from "express";
import pg from "pg";
import { reportFixture, assertNoPrivateIdentity } from "./privacy-fixtures.js";

test("public routes preserve private ownership in a disposable local database", async (t) => {
  try { execFileSync("initdb", ["--version"], { stdio: "ignore" }); }
  catch { t.skip("Local PostgreSQL tools are needed for isolated database route checks"); return; }
  const temp = await mkdtemp(path.join(tmpdir(), "sutros-privacy-test-"));
  const dataDir = path.join(temp, "database");
  const socketDir = path.join(temp, "socket");
  await mkdir(socketDir);
  let databaseStarted = false;
  let server;
  const pools = [];
  let hooks;
  t.after(async () => {
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await Promise.all(pools.map((pool) => pool.end()));
    hooks?.deregister();
    if (databaseStarted) execFileSync("pg_ctl", ["-D", dataDir, "-m", "fast", "-w", "stop"], { stdio: "ignore" });
    await rm(temp, { recursive: true, force: true });
    delete globalThis.__privacyReportFixture;
  });
  execFileSync("initdb", ["-D", dataDir, "--auth=trust", "--username=sutros_test", "--no-locale", "-E", "UTF8"], { stdio: "ignore" });
  // A unique Unix socket and no TCP listener prevent use of any existing server.
  execFileSync("pg_ctl", ["-D", dataDir, "-l", path.join(temp, "postgres.log"), "-o", `-F -k ${socketDir} -h '' -p 55439`, "-w", "start"], { stdio: "ignore" });
  databaseStarted = true;
  const originalEnv = { ...process.env };
  Object.assign(process.env, {
    DATABASE_URL: `postgresql://sutros_test@localhost/postgres?host=${encodeURIComponent(socketDir)}&port=55439`,
    PORT: "0", APP_URL: "http://localhost", REQUIRE_ACCOUNT: "0", SETUP_TOKEN: "",
    OPENAI_API_KEY: "", SIGNING_PRIVATE_KEY: "", SMTP_URL: "", GMAIL_USER: "", GMAIL_REFRESH_TOKEN: "",
    GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", GITHUB_CLIENT_ID: "", GITHUB_CLIENT_SECRET: "",
    SESSION_SECRET: "synthetic-local-test-secret",
  });
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]; Object.assign(process.env, originalEnv); });
  const RealPool = pg.Pool;
  pg.Pool = class extends RealPool { constructor(...args) { super(...args); pools.push(this); } };
  t.after(() => { pg.Pool = RealPool; });
  const upgradePool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await upgradePool.query(`CREATE TABLE reports (
    id TEXT PRIMARY KEY, target TEXT NOT NULL, url TEXT NOT NULL,
    grade TEXT NOT NULL, score INTEGER NOT NULL, report JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const nativeListen = express.application.listen;
  t.mock.method(express.application, "listen", function (...args) { server = nativeListen.apply(this, args); return server; });
  let targetLookups = 0;
  t.mock.method(dns, "lookup", async (host, options) => {
    targetLookups++;
    if (!host.endsWith(".example")) throw new Error("Unexpected external DNS request in a privacy test");
    return options?.all ? [{ address: "203.0.113.8", family: 4 }] : { address: "203.0.113.8", family: 4 };
  });
  t.mock.method(dns, "resolveTxt", async () => []);
  // Node's pinned HTTP transport has its own boundary; fetch stubs cannot intercept it.
  for (const transport of [http, https]) t.mock.method(transport, "request", () => { throw new Error("Unexpected Node network request in a privacy test"); });
  const browserModule = await import("../server/wekupBrowser.js");
  const guardedRequests = [];
  const fetchGuarded = async ({ url, ip }) => {
    assert.ok(url.hostname.endsWith(".example"), "Only synthetic website hosts may use this fixture");
    assert.equal(ip, "203.0.113.8", "The fixture must receive the validated public address");
    guardedRequests.push({ url: url.href, ip });
    const robots = url.pathname === "/robots.txt";
    return { status: 200, headers: { "content-type": robots ? "text/plain" : "text/html" }, truncated: false,
      body: Buffer.from(robots ? (url.hostname === "optout.example" ? "User-agent: SutrosBot\nDisallow: /\n" : "") : "<!doctype html><html><title>Fixture</title><body>A working website for the local test.</body></html>") };
  };
  t.mock.module("../server/wekupBrowser.js", { namedExports: { ...browserModule, guardedFetch: fetchGuarded,
    siteOptedOut: (host, options = {}) => browserModule.siteOptedOut(host, { ...options, fetchGuarded }) } });
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(input);
    if (url.hostname !== "127.0.0.1") throw new Error("Unexpected external fetch in a privacy test");
    return nativeFetch(input, options);
  });
  globalThis.__privacyReportFixture = reportFixture;
  const pipelineUrl = new URL("../server/pipeline.js", import.meta.url).href;
  hooks = registerHooks({
    load(url, context, nextLoad) {
      if (url !== pipelineUrl) return nextLoad(url, context);
      return { format: "module", shortCircuit: true, source: `export async function runCheckup(target, onEvent) {
        const report = { ...globalThis.__privacyReportFixture(), url: target.url.href, target: target.display, userId: target.userId };
        onEvent("report", report); onEvent("done", {}); return report;
      }` };
    },
  });
  await import("../server/index.js");
  if (!server.listening) await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_URL = base;
  const db = await import("../server/db.js");
  const people = [
    { id: "owner12345", email: "private@example.test", name: "Private Person", role: "user", cookie: "owner_session_fixture_1234567890" },
    { id: "other12345", email: "other@example.test", name: "Other Person", role: "user", cookie: "other_session_fixture_1234567890" },
    { id: "admin12345", email: "admin@example.test", name: "Reviewer", role: "admin", cookie: "admin_session_fixture_1234567890" },
  ];
  for (const person of people) {
    await db.sql("INSERT INTO users (id, email, email_verified, name, avatar_url, role) VALUES ($1,$2,true,$3,$4,$5)", [person.id, person.email, person.name, "https://example.test/private-avatar", person.role]);
    await db.sql("INSERT INTO sessions (id, user_id, expires_at) VALUES ($1,$2,now() + interval '31 days')", [person.cookie, person.id]);
  }
  const stored = { ...reportFixture(), score: 40, grade: "D" };
  await db.saveReport(stored);
  await db.saveReport({ ...stored, id: "anon123456", userId: null, target: "anonymous.example", url: "https://anonymous.example/" });
  await db.saveReport({ ...stored, id: "private123", target: "private.example", url: "https://private.example/" });
  await db.sql("UPDATE reports SET created_at = now() - interval '2 days'");
  await db.sql("INSERT INTO bulletin_posts (id, report_id, user_id, note) VALUES ('post123456','report1234','owner12345','Public request for help')");
  await db.sql("INSERT INTO bulletin_offers (id, post_id, user_id, message, contact) VALUES ('offer12345','post123456','other12345','A public offer to help with this site.','public-contact@example.test')");
  await db.sql("INSERT INTO report_shots (report_id,key,mime,bytes) VALUES ('private123','s1','image/jpeg',$1)", [Buffer.from('private screenshot fixture')]);
  await db.sql("INSERT INTO helpers (id,name,contact) VALUES ('legacyhelp','Legacy helper','legacy@example.test')");

  async function request(route, { viewer = null, method = "GET", body, stream = false, expectedAccount } = {}) {
    const response = await fetch(base + route, {
      method, headers: { "X-Requested-With": "fetch", ...(viewer ? { Cookie: `sutros_session=${viewer.cookie}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}), ...(stream ? { Accept: "text/event-stream" } : {}), ...(expectedAccount ? { 'X-Sutros-Account': expectedAccount } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, cache: response.headers.get("cache-control"), body: stream || !response.headers.get('content-type')?.includes('application/json') ? await response.text() : await response.json() };
  }

  async function captureBrowserResponse(route) {
    const url = new URL(route.request().url());
    assert.equal(url.origin, base, 'Browser race fixtures only read the disposable local server');
    const response = await nativeFetch(url, { headers: await route.request().allHeaders() });
    return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
  }

  await t.test("accounts are required for scans and rechecks before target network work", async () => {
    const before = targetLookups;
    assert.equal((await request('/api/config')).body.requireAccount,true);
    for (const route of ['/api/checkup','/api/reports/report1234/retest']) {
      const reply = await request(route,{method:'POST',body:{url:'https://gate.example/',findingId:'broken-links'}});
      assert.equal(reply.status,401,route);
    }
    const stream = await request('/api/checkup/stream?url=https%3A%2F%2Fgate.example%2F',{stream:true});
    assert.equal(stream.status,401);
    assert.equal(targetLookups,before,'Account denial happens before DNS resolution');
    await db.sql('UPDATE users SET email_verified=false WHERE id=$1',[people[0].id]);
    try {
      for (const route of ['/api/checkup','/api/reports/report1234/retest']) {
        const reply = await request(route,{viewer:people[0],method:'POST',body:{url:'https://gate.example/',findingId:'broken-links'}});
        assert.equal(reply.status,403);
        assert.equal(reply.body.code,'unverified');
      }
      const unverifiedStream = await request('/api/checkup/stream?url=https%3A%2F%2Fgate.example%2F',{viewer:people[0],stream:true});
      assert.equal(unverifiedStream.status,403);
      assert.equal(JSON.parse(unverifiedStream.body).code,'unverified');
      assert.equal(targetLookups,before,'Unconfirmed accounts are denied before DNS resolution');
    } finally { await db.sql('UPDATE users SET email_verified=true WHERE id=$1',[people[0].id]); }
  });

  await t.test('scan entry points use the pinned robots check before starting work', async () => {
    const before = guardedRequests.length;
    const blocked = await request('/api/checkup', { viewer: people[0], method: 'POST', body: { url: 'https://optout.example/' } });
    assert.equal(blocked.status, 403);
    assert.match(blocked.body.error, /owner has asked not/);
    const streamed = await request('/api/checkup/stream?url=https%3A%2F%2Foptout.example%2F', { viewer: people[0], stream: true });
    assert.match(streamed.body, /owner has asked not/);
    assert.doesNotMatch(streamed.body, /event: report/);
    assert.deepEqual(guardedRequests.slice(before), [
      { url: 'https://optout.example/robots.txt', ip: '203.0.113.8' },
      { url: 'https://optout.example/robots.txt', ip: '203.0.113.8' },
    ]);
  });

  await t.test("saved detail, history, and recent lists omit account data for every viewer", async () => {
    for (const viewer of [null, people[0], people[1]]) {
      for (const route of ["/api/reports/report1234", "/api/reports?limit=5", "/api/checks?host=fixture.example"]) {
        const reply = await request(route, { viewer });
        assert.equal(reply.status, !viewer && route !== '/api/reports/report1234' ? 401 : 200);
        assertNoPrivateIdentity(assert, reply.body);
        assert.match(reply.cache, /private.*no-store/);
      }
    }
    const detail = (await request("/api/reports/report1234", { viewer: people[0] })).body;
    assert.equal(detail.canPostToBulletin, false);
    assert.equal(detail.visibility, 'public');
    assert.equal(detail.bulletinPostId, 'post123456');
    assert.deepEqual(detail.findings[0].evidence, stored.findings[0].evidence);
    assert.deepEqual(detail.attestation, stored.attestation);
    assert.equal((await db.getReport("report1234")).userId, "owner12345", "Internal ownership remains available");
  });

  await t.test('private reports deny all derived endpoints to other accounts and anonymous readers', async () => {
    const routes = ['/api/reports/private123', '/api/verify/private123', '/badge/private123.svg',
      '/api/reports/private123/shots/s1', '/api/reports/private123/feedback', '/api/reports/private123/assessments'];
    for (const route of routes) {
      for (const viewer of [null, people[1]]) assert.equal((await request(route, { viewer })).status, 404, route);
      for (const viewer of [people[0], people[2]]) assert.equal((await request(route, { viewer })).status, 200, route);
    }
    for (const suffix of ['feedback', 'retest', 'wekup']) {
      const denied = await request('/api/reports/private123/' + suffix, { viewer: people[1], method: 'POST', body: { findingId: 'links-broken', verdict: 'wrong', message: 'Explain the private finding', requestId: 'private-attempt' } });
      assert.equal(denied.status, 404, suffix);
    }
    assert.equal((await request('/api/reports/private123/wekup?findingId=_report', { viewer: people[1] })).status, 404);
    const own = await request('/api/reports/private123', { viewer: people[0] });
    assert.equal(own.body.visibility, 'private');
    assert.equal(own.body.bulletinPostId, null);
    assert.equal(own.body.canPostToBulletin, true);
    assertNoPrivateIdentity(assert, own.body);
  });

  await t.test('account history and cooldown never disclose another account private scan', async () => {
    for (const path of ['/api/reports', '/api/reports?mine=1', '/api/reports?host=private.example', '/api/checks?host=private.example']) {
      const other = await request(path, { viewer: people[1] });
      assert.deepEqual(other.body.reports, [], path);
    }
    await db.sql("UPDATE reports SET created_at=now() WHERE id='private123'");
    const other = await request('/api/checkup', { viewer: people[1], method: 'POST', body: { url: 'https://private.example/' } });
    assert.equal(other.status, 200, 'Another account private history must not disclose an id or prevent this account check');
    const own = await request('/api/checkup', { viewer: people[0], method: 'POST', body: { url: 'https://private.example/' } });
    assert.equal(own.status, 429);
    assert.equal(own.body.latestReportId, 'private123');
    await db.sql("UPDATE reports SET created_at=now() - interval '2 days' WHERE id='private123'");
  });

  await t.test('publishing is explicit and deleting a post revokes report access while retaining rate history', async () => {
    assert.equal((await request('/api/bulletin', { viewer: people[1], method: 'POST', body: { reportId: 'private123' } })).status, 403);
    const created = await request('/api/bulletin', { viewer: people[0], method: 'POST', body: { reportId: 'private123', note: 'I would like help with this website.' } });
    assert.equal(created.status, 201);
    const id = created.body.post.id;
    assert.equal(created.body.post.canDelete, true);
    assert.equal((await request('/api/reports/private123')).body.visibility, 'public');
    assert.equal((await request('/api/bulletin?mine=1', { viewer: people[0] })).body.posts.some(p => p.id === id), true);
    assert.equal((await request('/api/bulletin/' + id, { viewer: people[1], method: 'DELETE' })).status, 403);
    assert.equal((await request('/api/bulletin/' + id, { viewer: people[0], method: 'DELETE' })).status, 200);
    assert.equal((await request('/api/bulletin/' + id)).status, 404);
    assert.equal((await request('/api/reports/private123')).status, 404);
    assert.equal((await request('/api/reports/private123', { viewer: people[0] })).body.visibility, 'private');
    const [retained] = await db.sql('SELECT deleted_at FROM bulletin_posts WHERE id=$1', [id]);
    assert.ok(retained.deleted_at, 'The creation row remains for rate accounting');
    const republished = await request('/api/bulletin', { viewer: people[0], method: 'POST', body: { reportId: 'private123' } });
    assert.equal(republished.status, 201, 'A withdrawn report can be explicitly posted again');
    assert.notEqual(republished.body.post.id, id, 'New publication has separate rate accounting');
    await request('/api/bulletin/' + republished.body.post.id, { viewer: people[0], method: 'DELETE' });
  });

  await t.test('helper listings need confirmed ownership and can be deleted only by their owner or admin', async () => {
    const body = { name: 'Verified helper', contact: people[0].email, area: 'Local', blurb: 'I can help with website fixes.' };
    assert.equal((await request('/api/helpers', { method: 'POST', body })).status, 401);
    await db.sql('UPDATE users SET email_verified=false WHERE id=$1', [people[0].id]);
    assert.equal((await request('/api/helpers', { viewer: people[0], method: 'POST', body })).status, 403);
    await db.sql('UPDATE users SET email_verified=true WHERE id=$1', [people[0].id]);
    assert.equal((await request('/api/helpers', { viewer: people[0], method: 'POST', body: { ...body, contact: 'someone-else@example.test' } })).status, 400);
    const created = await request('/api/helpers', { viewer: people[0], method: 'POST', body });
    assert.equal(created.status, 201);
    assert.equal(created.body.helper.canDelete, true);
    assert.equal(Object.hasOwn(created.body.helper, 'user_id'), false);
    const id = created.body.helper.id;
    const listed = (await request('/api/helpers')).body.helpers;
    assert.equal(listed.some(h => h.id === 'legacyhelp'), false, 'Unowned legacy rows are retained but never published');
    assert.equal(listed.find(h => h.id === id).canDelete, false);
    assert.equal((await request('/api/helpers?mine=1', { viewer: people[0] })).body.helpers.some(h => h.id === id), true);
    assert.equal((await request('/api/helpers/' + id, { viewer: people[1], method: 'DELETE' })).status, 403);
    assert.equal((await request('/api/helpers/' + id, { viewer: people[0], method: 'DELETE' })).status, 200);
    assert.equal((await request('/api/helpers')).body.helpers.some(h => h.id === id), false);
    assert.ok((await db.sql('SELECT deleted_at FROM helpers WHERE id=$1', [id]))[0].deleted_at);
  });

  await t.test('a community draft from a previous sign-in cannot be published under the replacement account', async () => {
    const response = await request('/api/helpers', { viewer: people[1], expectedAccount: people[0].id, method: 'POST', body: { name: 'Previous account draft', contact: people[1].email } });
    assert.equal(response.status, 401);
    assert.equal(response.body.code, 'account-changed');
    assert.equal((await db.sql("SELECT id FROM helpers WHERE name='Previous account draft'")).length, 0);
  });

  await t.test('concurrent helper creation cannot overspend the daily allowance, including deleted rows', async () => {
    const viewer = { id: 'quotahelper', email: 'quotahelper@example.test', cookie: 'quotahelper_session_fixture_12345' };
    await db.sql("INSERT INTO users (id,email,email_verified) VALUES ($1,$2,true)", [viewer.id, viewer.email]);
    await db.sql("INSERT INTO sessions (id,user_id,expires_at) VALUES ($1,$2,now()+interval '1 day')", [viewer.cookie, viewer.id]);
    for (let i = 0; i < 9; i++) await db.sql("INSERT INTO helpers (id,name,contact,user_id,deleted_at) VALUES ($1,'Earlier helper',$2,$3,now())", ['quotahelp'+i, viewer.email, viewer.id]);
    // A slow write makes overlapping requests deterministic without mocking SQL.
    await db.sql("CREATE FUNCTION pause_helper_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.1); RETURN NEW; END $$");
    await db.sql("CREATE TRIGGER pause_helper_insert BEFORE INSERT ON helpers FOR EACH ROW EXECUTE FUNCTION pause_helper_insert()");
    let replies;
    try { replies = await Promise.all(Array.from({ length: 8 }, (_, i) => request('/api/helpers', { viewer, method: 'POST', body: { name: 'Concurrent helper ' + i, contact: viewer.email } }))); }
    finally { await db.sql('DROP TRIGGER pause_helper_insert ON helpers'); await db.sql('DROP FUNCTION pause_helper_insert()'); }
    assert.deepEqual(replies.map(r => r.status).sort(), [201,429,429,429,429,429,429,429]);
    assert.equal((await db.sql('SELECT count(*)::int AS n FROM helpers WHERE user_id=$1', [viewer.id]))[0].n, 10);
    const created = replies.find(r => r.status === 201).body.helper.id;
    assert.equal((await request('/api/helpers/'+created, { viewer, method: 'DELETE' })).status, 200);
    assert.equal((await request('/api/helpers', { viewer, method: 'POST', body: { name: 'After removal', contact: viewer.email } })).status, 429);
  });

  await t.test('concurrent bulletin publication counts retained deleted posts toward the daily limit', async () => {
    const viewer = { id: 'quotaposter', email: 'quotaposter@example.test', cookie: 'quotaposter_session_fixture_12345' };
    await db.sql('INSERT INTO users (id,email,email_verified) VALUES ($1,$2,true)', [viewer.id, viewer.email]);
    await db.sql("INSERT INTO sessions (id,user_id,expires_at) VALUES ($1,$2,now()+interval '1 day')", [viewer.cookie, viewer.id]);
    for (let i = 0; i < 8; i++) await db.saveReport({ ...stored, id: 'quotareport'+i, userId: viewer.id });
    for (let i = 0; i < 9; i++) await db.sql("INSERT INTO bulletin_posts (id,report_id,user_id,deleted_at) VALUES ($1,'quotareport0',$2,now())", ['quotapost'+i, viewer.id]);
    await db.sql('CREATE FUNCTION pause_post_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.1); RETURN NEW; END $$');
    await db.sql('CREATE TRIGGER pause_post_insert BEFORE INSERT ON bulletin_posts FOR EACH ROW EXECUTE FUNCTION pause_post_insert()');
    let replies;
    try { replies = await Promise.all(Array.from({ length: 8 }, (_, i) => request('/api/bulletin', { viewer, method: 'POST', body: { reportId: 'quotareport'+i } }))); }
    finally { await db.sql('DROP TRIGGER pause_post_insert ON bulletin_posts'); await db.sql('DROP FUNCTION pause_post_insert()'); }
    assert.deepEqual(replies.map(r => r.status).sort(), [201,429,429,429,429,429,429,429]);
    assert.equal((await db.sql('SELECT count(*)::int AS n FROM bulletin_posts WHERE user_id=$1', [viewer.id]))[0].n, 10);
    const created = replies.find(r => r.status === 201).body.post;
    assert.equal((await request('/api/bulletin/'+created.id, { viewer, method: 'DELETE' })).status, 200);
    assert.equal((await request('/api/bulletin', { viewer, method: 'POST', body: { reportId: created.report.id } })).status, 429);
  });

  await t.test('concurrent offers cannot overspend the daily allowance', async () => {
    const viewer = { id: 'quotaoffer', email: 'quotaoffer@example.test', cookie: 'quotaoffer_session_fixture_12345' };
    await db.sql('INSERT INTO users (id,email,email_verified) VALUES ($1,$2,true)', [viewer.id, viewer.email]);
    await db.sql("INSERT INTO sessions (id,user_id,expires_at) VALUES ($1,$2,now()+interval '1 day')", [viewer.cookie, viewer.id]);
    for (let i = 0; i < 8; i++) {
      await db.saveReport({ ...stored, id: 'offreport'+i, userId: viewer.id });
      await db.sql("INSERT INTO bulletin_posts (id,report_id,user_id,created_at) VALUES ($1,$2,$3,now()-interval '2 days')", ['offpost'+i, 'offreport'+i, viewer.id]);
    }
    await db.saveReport({ ...stored, id: 'offseedrep', userId: viewer.id });
    await db.sql("INSERT INTO bulletin_posts (id,report_id,user_id,created_at) VALUES ('offseedpost','offseedrep',$1,now()-interval '2 days')", [viewer.id]);
    for (let i = 0; i < 19; i++) await db.sql("INSERT INTO bulletin_offers (id,post_id,user_id,message,contact) VALUES ($1,'offseedpost',$2,'Earlier offer to help',$3)", ['quotaoff'+i, viewer.id, viewer.email]);
    await db.sql('CREATE FUNCTION pause_offer_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.1); RETURN NEW; END $$');
    await db.sql('CREATE TRIGGER pause_offer_insert BEFORE INSERT ON bulletin_offers FOR EACH ROW EXECUTE FUNCTION pause_offer_insert()');
    let replies;
    try { replies = await Promise.all(Array.from({ length: 8 }, (_, i) => request('/api/bulletin/offpost'+i+'/offers', { viewer, method: 'POST', body: { message: 'I can help with the site navigation.', contact: viewer.email } }))); }
    finally { await db.sql('DROP TRIGGER pause_offer_insert ON bulletin_offers'); await db.sql('DROP FUNCTION pause_offer_insert()'); }
    assert.deepEqual(replies.map(r => r.status).sort(), [201,429,429,429,429,429,429,429]);
    assert.equal((await db.sql('SELECT count(*)::int AS n FROM bulletin_offers WHERE user_id=$1', [viewer.id]))[0].n, 20);
    const createdIndex = replies.findIndex(r => r.status === 201);
    const created = replies[createdIndex].body.offer;
    const postPath = '/api/bulletin/offpost'+createdIndex;
    assert.equal((await request(postPath+'/offers/'+created.id, { viewer, method: 'DELETE' })).status, 200);
    assert.equal((await request(postPath)).body.offers.length, 0);
    assert.equal((await request(postPath)).body.post.offersCount, 0);
    assert.equal((await db.sql('SELECT count(*)::int AS n FROM bulletin_offers WHERE user_id=$1', [viewer.id]))[0].n, 20, 'Removed offers retain creation accounting');
    assert.equal((await request(postPath+'/offers', { viewer, method: 'POST', body: { message: 'A new offer after removal.', contact: viewer.email } })).status, 429);
  });

  await t.test('community creation refuses unsafe website links and unconfirmed contact email', async () => {
    for (const contact of ['https://127.0.0.1/', 'https://fixture.example:444/', 'https://user:password@fixture.example/']) {
      const reply = await request('/api/helpers', { viewer: people[0], method: 'POST', body: { name: 'Helper', contact } });
      assert.equal(reply.status, 400, contact);
    }
    const offer = await request('/api/bulletin/post123456/offers', { viewer: people[0], method: 'POST', body: { message: 'I can help with the site navigation.', contact: people[1].email } });
    assert.equal(offer.status, 400);
    await db.saveReport({ ...stored, id: 'unsafe1234', url: 'http://127.0.0.1/', target: 'unsafe.example' });
    assert.equal((await request('/api/bulletin', { viewer: people[0], method: 'POST', body: { reportId: 'unsafe1234' } })).status, 400);
  });

  await t.test('badge grade, color, and ring match the report including A+', async () => {
    for (const [grade, ringPercent, color, dash] of [['A+', 100, '#15803D', '0'], ['C', 68, '#CFA23A', '32'], ['D', 40, '#DC2626', '60'], ['F', 12, '#991B1B', '88']]) {
      const id = 'badge' + grade.replace('+', 'plus') + '123';
      await db.saveReport({ ...stored, id, target: id.toLowerCase() + '.example', grade, score: ringPercent, ringPercent, attestation: null });
      const badge = await request('/badge/' + id + '.svg', { viewer: people[0] });
      assert.equal(badge.status, 200);
      assert.match(badge.body, new RegExp('grade ' + grade.replace('+', '\\+')));
      assert.match(badge.body, new RegExp('stroke="' + color + '"'));
      assert.match(badge.body, /pathLength="100"/);
      assert.match(badge.body, new RegExp('stroke-dashoffset="' + dash + '"'));
      assert.match(badge.cache, /private.*no-store/);
    }
  });

  await t.test('wekup is mounted with verified sessions, private histories and automatic processing', async () => {
    const route = '/api/reports/report1234/wekup';
    const before = targetLookups;
    for (const method of ['GET', 'POST']) {
      const response = await fetch(base + route + '?findingId=_report', { method, headers: { 'X-Requested-With': 'fetch' } });
      assert.equal(response.status, 401, 'anonymous chat processing must be denied at the live app route');
    }
    await db.sql('UPDATE users SET email_verified=false WHERE id=$1', [people[0].id]);
    try {
      assert.equal((await request(route + '?findingId=_report', { viewer: people[0] })).status, 403);
    } finally { await db.sql('UPDATE users SET email_verified=true WHERE id=$1', [people[0].id]); }
    const crossSite = await fetch(base + route, { method: 'POST', headers: {
      Cookie: `sutros_session=${people[0].cookie}`, Origin: 'https://untrusted.example', 'Content-Type': 'application/json',
    }, body: JSON.stringify({ findingId: '_report', message: 'Unrequested message', requestId: 'cross-site' }) });
    assert.equal(crossSite.status, 403, 'foreign sites cannot cause a signed-in reader to submit chat');
    for (const method of ['GET', 'POST']) {
      const changedSession = await fetch(base + route + '?findingId=_report', { method, headers: {
        Cookie: `sutros_session=${people[1].cookie}`, 'X-Requested-With': 'fetch',
        'X-Sutros-Account': people[0].id, 'Content-Type': 'application/json',
      }, ...(method === 'POST' ? { body: JSON.stringify({ findingId: '_report', message: 'Previous account private draft', requestId: 'changed-session' }) } : {}) });
      assert.equal(changedSession.status, 401, 'a changed session cannot read or submit under the previous open chat');
      assert.equal((await changedSession.json()).code, 'account-changed');
    }
    const posted = await request(route, { viewer: people[0], method: 'POST', body: {
      findingId: '_report', message: 'PRIVATE_CONVERSATION: What is this checkup about?', requestId: 'mounted-chat-fixture',
    } });
    assert.equal(posted.status, 202);
    assert.match(posted.cache, /private.*no-store/);
    let conversation;
    const deadline = Date.now() + 8000;
    do {
      conversation = await request(route + '?findingId=_report', { viewer: people[0] });
      if (conversation.body.job?.status === 'completed') break;
      await new Promise(done => setTimeout(done, 100));
    } while (Date.now() < deadline);
    assert.equal(conversation.body.job?.status, 'completed', 'startup must initialize and run the durable conversation worker');
    assert.equal(conversation.body.messages.filter(m => m.role === 'assistant').length, 1);
    const other = await request(route + '?findingId=_report&userId=owner12345', { viewer: people[1] });
    assert.deepEqual(other.body.messages, [], 'a client-supplied owner cannot reveal another account conversation');
    const repeated = await request(route, { viewer: people[0], method: 'POST', body: {
      findingId: '_report', message: 'PRIVATE_CONVERSATION: What is this checkup about?', requestId: 'mounted-chat-fixture',
    } });
    assert.equal(repeated.status, 202);
    assert.equal(repeated.body.messages.length, 2, 'retry reuses the existing turn');
    const publicResult = await request('/api/reports/report1234/assessments');
    assert.equal(publicResult.status, 200);
    assert.doesNotMatch(JSON.stringify(publicResult.body), /PRIVATE_CONVERSATION|owner12345|private@example.test/);
    assertNoPrivateIdentity(assert, publicResult.body);
    assert.equal(targetLookups, before, 'a general explanation must not cause website visits');
    const original = await db.sql('SELECT report FROM reports WHERE id=$1', ['report1234']);
    assert.deepEqual(original[0].report.findings, stored.findings);
    assert.deepEqual(original[0].report.attestation, stored.attestation);
  });

  await t.test("completed JSON and SSE checkups use the same public projection", async () => {
    const json = await request("/api/checkup", { viewer: people[0], method: "POST", body: { url: "https://fixture.example/about#private-fragment" } });
    assert.equal(json.status, 200);
    assertNoPrivateIdentity(assert, json.body);
    assert.equal(json.body.url, "https://fixture.example/about");
    assert.equal(json.body.score, null);
    const sse = await request("/api/checkup/stream?url=https%3A%2F%2Ffixture.example%2Fabout", { viewer: people[0], stream: true });
    assert.equal(sse.status, 200);
    assertNoPrivateIdentity(assert, sse.body);
    assert.match(sse.cache, /private.*no-store/);
    const event = sse.body.split("\n\n").find((part) => part.startsWith("event: report\n"));
    const report = JSON.parse(event.split("data: ")[1]);
    assert.deepEqual(report, json.body);
  });

  await t.test("public input boundaries reject credentials and query values", async () => {
    for (const url of ["https://person:password@fixture.example/", "https://fixture.example/reset?token=synthetic"]) {
      for (const route of ["/api/checkup", "/api/nominate"]) {
        const reply = await request(route, { viewer:people[0], method: "POST", body: { url } });
        assert.equal(reply.status, 400);
        assert.equal(JSON.stringify(reply.body).includes("synthetic"), false);
      }
      const stream = await request("/api/checkup/stream?url=" + encodeURIComponent(url), { viewer:people[0], stream: true });
      assert.match(stream.body, /event: error/);
      assert.equal(stream.body.includes("event: report"), false);
    }
  });

  await t.test("bulletin content stays public while capabilities replace private IDs", async () => {
    for (const [viewer, canManage, canDelete] of [[null, false, false], [people[0], true, true], [people[1], false, true], [people[2], true, true]]) {
      const reply = await request("/api/bulletin/post123456", { viewer });
      assert.equal(reply.status, 200);
      assertNoPrivateIdentity(assert, reply.body);
      assert.equal(reply.body.post.canManage, canManage);
      assert.equal(reply.body.offers[0].canDelete, canDelete);
      assert.equal(reply.body.post.note, "Public request for help");
      assert.equal(reply.body.offers[0].contact, "public-contact@example.test");
      assert.deepEqual(reply.body.report.contact, stored.contact);
      assert.match(reply.cache, /private.*no-store/);
      const list = await request("/api/bulletin", { viewer });
      assertNoPrivateIdentity(assert, list.body);
      assert.equal(list.body.posts[0].canManage, canManage);
    }
    assert.equal((await request("/api/bulletin/post123456", { viewer: people[1], method: "PATCH", body: { status: "resolved" } })).status, 403);
    const changed = await request("/api/bulletin/post123456", { viewer: people[0], method: "PATCH", body: { status: "claimed" } });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.post.status, "claimed");
    assert.equal(changed.body.post.canManage, true);
    assertNoPrivateIdentity(assert, changed.body);
  });

  await t.test("an account cannot claim or publish an ownerless report", async () => {
    const reply = await request("/api/bulletin", { viewer: people[1], method: "POST", body: { reportId: "anon123456", note: "Public anonymous report discussion" } });
    assert.equal(reply.status, 403);
    assertNoPrivateIdentity(assert, reply.body);
    assert.equal((await db.getReport("anon123456")).userId, null);
  });

  await t.test("unrated results can be stored without manufacturing a numeric score", async () => {
    await assert.doesNotReject(db.saveReport({ ...stored, id: "unrated123", score: null, grade: "?" }));
    const reply = await request("/api/reports/unrated123", { viewer: people[0] });
    assert.equal(reply.body.score, null);
  });

  await t.test("private account state and account report history remain functional", async () => {
    const me = await request("/api/me", { viewer: people[0] });
    assert.equal(me.body.user.email, "private@example.test");
    assert.equal(me.body.user.id, "owner12345");
    assert.match(me.cache, /private.*no-store/);
    assert.equal((await request("/api/reports?mine=1")).status, 401);
    assert.equal((await request("/api/reports?mine=1", { viewer: people[0] })).body.reports.some((report) => report.id === "report1234"), true);
  });

  await t.test("the bulletin UI uses capabilities and does not prefill private account email", async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      await context.route("**/*", (route) => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
      await context.addCookies([{ name: "sutros_session", value: people[0].cookie, url: base }]);
      const page = await context.newPage();
      await page.goto(base + "/b/post123456");
      await page.locator("#cuOfferForm").waitFor();
      assert.equal(await page.locator("#cuStatusSelect").count(), 1, "The poster must retain status controls without public account IDs");
      assert.equal(await page.locator("#cuOffers [data-remove-offer]").count(), 1);
      assert.equal(await page.locator("#cuOfferContact").inputValue(), "", "An account email is not an explicitly published offer contact");
      await context.addCookies([{ name: "sutros_session", value: people[1].cookie, url: base }]);
      const refreshed = page.waitForResponse((response) => response.url() === base + "/api/bulletin/post123456", { timeout: 3000 });
      await page.evaluate(() => window.Sutros.refreshMe());
      await refreshed;
      await page.waitForFunction(() => !document.getElementById("cuStatusSelect"));
      assert.equal(await page.locator("#cuOffers [data-remove-offer]").count(), 1, "The offer author still retains their own remove control");
      await page.goto(base + "/r/report1234");
      await page.locator("#cuPostPanel").waitFor();
      assert.equal(await page.locator("#cuPostForm").count(), 0, "Another account cannot post an owned report");
    } finally { await browser.close(); }
  });

  await t.test('hidden account content and delayed own-list responses are cleared when the account changes', async () => {
    await db.saveReport({ ...stored, id: 'accountrace', target: 'private-account-race.example', url: 'https://private-account-race.example/' });
    await db.sql("INSERT INTO helpers (id,name,contact,user_id) VALUES ('racehelper','Account race helper',$1,$2)", [people[0].email, people[0].id]);
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    try {
      for (const change of ['signout', 'replacement']) {
        const cookie = 'account_race_' + change + '_session_fixture';
        await db.sql("INSERT INTO sessions (id,user_id,expires_at) VALUES ($1,$2,now()+interval '1 day')", [cookie, people[0].id]);
        const context = await browser.newContext();
        let release;
        try {
          await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
          await context.addCookies([{ name: 'sutros_session', value: cookie, url: base }]);
          const page = await context.newPage();
          const held = [];
          let ready;
          const pending = new Promise(resolve => { ready = resolve; });
          const released = new Promise(resolve => { release = resolve; });
          await page.route(url => url.origin === base && url.searchParams.get('mine') === '1', async route => {
            const response = await captureBrowserResponse(route);
            held.push(new URL(route.request().url()).pathname);
            if (held.length === 3) ready();
            await released;
            await route.fulfill(response).catch(() => {});
          });
          await page.goto(base + '/account');
          await pending;
          assert.deepEqual(held.sort(), ['/api/bulletin','/api/helpers','/api/reports']);
          await page.locator('#auAccountWrap a[data-link]').first().click();
          await page.waitForURL(base + '/');
          if (change === 'signout') {
            await page.locator('#auUserBtn').click();
            await page.locator('#auSignOut').click();
            await page.waitForFunction(() => window.Sutros.user === null);
          } else {
            await context.addCookies([{ name: 'sutros_session', value: people[1].cookie, url: base }]);
            await page.evaluate(() => window.Sutros.refreshMe());
          }
          release();
          await page.waitForLoadState('networkidle');
          assert.doesNotMatch(await page.locator('body').textContent(), /private-account-race\.example/, change + ': an old response must not restore private history');
          assert.equal(await page.locator('#auAccountWrap').innerHTML(), '', change + ': account details must be removed even while hidden');
          if (change === 'replacement') {
            await page.evaluate(() => window.Sutros.navigate('/account'));
            await page.locator('#auAccountWrap .au-who .e').waitFor();
            assert.equal(await page.locator('#auAccountWrap .au-who .e').textContent(), people[1].email);
          }
        } finally { release?.(); await context.close(); await db.sql('DELETE FROM sessions WHERE id=$1', [cookie]); }
      }
    } finally { await browser.close(); await db.sql("DELETE FROM helpers WHERE id='racehelper'"); }
  });

  await t.test('a delayed private verification response cannot render under a replacement account', async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    let release;
    try {
      const context = await browser.newContext();
      await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
      await context.addCookies([{ name: 'sutros_session', value: people[0].cookie, url: base }]);
      const page = await context.newPage();
      let ready;
      const pending = new Promise(resolve => { ready = resolve; });
      const released = new Promise(resolve => { release = resolve; });
      let first = true;
      await page.route('**/api/verify/private123', async route => {
        if (!first) return route.continue();
        first = false;
        const response = await captureBrowserResponse(route);
        ready();
        await released;
        await route.fulfill(response).catch(() => {});
      });
      await page.goto(base + '/verify/private123');
      await pending;
      await context.addCookies([{ name: 'sutros_session', value: people[1].cookie, url: base }]);
      await page.evaluate(() => window.Sutros.refreshMe());
      release();
      await page.waitForLoadState('networkidle');
      assert.doesNotMatch(await page.locator('#screen-verify').textContent(), /private\.example/);
      assert.equal((await request('/api/verify/private123', { viewer: people[1] })).status, 404);
    } finally { release?.(); await browser.close(); }
  });

  await t.test('hidden private verification data and pending browser signature results are cleared on sign-out', async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
      await context.addCookies([{ name: 'sutros_session', value: people[0].cookie, url: base }]);
      await context.addInitScript(() => {
        Object.defineProperty(crypto.subtle, 'importKey', { value: async () => ({}) });
        Object.defineProperty(crypto.subtle, 'verify', { value: () => new Promise(resolve => { window.releaseBrowserVerify = resolve; }) });
      });
      const page = await context.newPage();
      await page.route('**/api/verify/private123', async route => {
        const response = await captureBrowserResponse(route);
        const data = JSON.parse(response.body);
        await route.fulfill({ ...response, body: JSON.stringify({ ...data, signature: 'AA==', publicKeySpkiBase64: 'AA==', canonical: data.canonical || 'fixture' }) });
      });
      await page.goto(base + '/verify/private123');
      await page.waitForFunction(() => typeof window.releaseBrowserVerify === 'function');
      assert.match(await page.locator('#screen-verify').textContent(), /private\.example/);
      await page.evaluate(() => { window.oldBrowserCheck = document.getElementById('cuBrowserCheck'); });
      await page.locator('#screen-verify a[data-spa]').first().click();
      await page.waitForURL(base + '/');
      await context.clearCookies();
      await page.evaluate(() => window.Sutros.refreshMe());
      await page.evaluate(() => window.releaseBrowserVerify(true));
      await page.waitForLoadState('networkidle');
      assert.equal(await page.locator('#screen-verify').innerHTML(), '');
      assert.equal(await page.evaluate(() => window.oldBrowserCheck.textContent), 'Checking the signature in your browser too...');
    } finally { await browser.close(); }
  });

  await t.test('account and bulletin controls remove owned community posts and helper listings', async () => {
    const helper = await request('/api/helpers', { viewer: people[0], method: 'POST', body: { name: 'My helper entry', contact: people[0].email } });
    assert.equal(helper.status, 201);
    const extraPost = await request('/api/bulletin', { viewer: people[0], method: 'POST', body: { reportId: 'private123' } });
    assert.equal(extraPost.status, 201);
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
      await context.addCookies([{ name: 'sutros_session', value: people[0].cookie, url: base }]);
      const page = await context.newPage();
      const recentRequests = [];
      page.on('request', req => { if (req.url().includes('/api/reports?limit=8')) recentRequests.push(req.url()); });
      await page.goto(base + '/');
      await page.waitForLoadState('networkidle');
      assert.equal(recentRequests.length, 0, 'The home page no longer requests public recent scans');
      assert.equal(await page.getByText('Recent public checkups', { exact: true }).count(), 0);
      await page.goto(base + '/account');
      await page.locator('#auCheckups .au-row').first().waitFor();
      assert.equal(await page.locator('#auCommunityPosts').count(), 1);
      assert.equal(await page.locator('#auHelperListings').count(), 1);
      const removeHelper = page.locator('[data-remove-helper="' + helper.body.helper.id + '"]');
      await removeHelper.waitFor();
      const removedReply = page.waitForResponse(response => response.url().endsWith('/api/helpers/' + helper.body.helper.id) && response.request().method() === 'DELETE');
      await removeHelper.click();
      const removed = await removedReply;
      assert.equal(removed.status(), 200, await removed.text());
      await removeHelper.waitFor({ state: 'detached' });
      assert.equal((await request('/api/helpers')).body.helpers.some(h => h.id === helper.body.helper.id), false);
      const removeOwnPost = page.locator('[data-remove-post="' + extraPost.body.post.id + '"]');
      await removeOwnPost.click();
      await removeOwnPost.waitFor({ state: 'detached' });
      assert.equal((await request('/api/reports/private123')).status, 404);
      await page.goto(base + '/b/post123456');
      await page.locator('#cuStatusSelect').waitFor();
      assert.equal(await page.locator('#cuDeletePost').count(), 1);
      await page.locator('#cuDeletePost').click();
      await page.waitForURL(base + '/bulletin');
      assert.equal((await request('/api/reports/report1234')).status, 404);
    } finally { await browser.close(); }
  });

  await t.test('older helper listings remain manageable through account pagination', async () => {
    await db.sql("INSERT INTO helpers (id,name,contact,user_id,created_at) SELECT 'older' || lpad(n::text,5,'0'), 'Older helper ' || n, 'private@example.test', 'owner12345', now() - make_interval(days => n) FROM generate_series(1,52) n");
    const first = (await request('/api/helpers?mine=1', { viewer: people[0] })).body;
    const second = (await request('/api/helpers?mine=1&page=2', { viewer: people[0] })).body;
    assert.equal(first.helpers.length, 50);
    assert.equal(first.hasMore, true);
    assert.equal(second.helpers.length, 2);
    assert.equal(second.hasMore, false);
    assert.equal(second.helpers.every(h => h.canDelete), true);
    assert.equal(first.helpers.some(h => second.helpers.some(other => other.id === h.id)), false);
  });

  await t.test('schema migration can run again without republishing removed content or changing signed reports', async () => {
    const before = await db.getReport('report1234');
    await db.initDb();
    assert.deepEqual((await db.getReport('report1234')).attestation, before.attestation);
    assert.equal((await request('/api/reports/report1234')).status, 404);
    assert.equal((await request('/api/helpers')).body.helpers.some(h => h.id === 'legacyhelp'), false);
  });
});
