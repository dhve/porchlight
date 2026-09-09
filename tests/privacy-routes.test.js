import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { registerHooks } from "node:module";
import { once } from "node:events";
import dns from "node:dns/promises";
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
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(input);
    if (url.hostname.endsWith(".example") && url.pathname === "/robots.txt") return new Response("", { headers: { "content-type": "text/plain" } });
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
  await db.sql("UPDATE reports SET created_at = now() - interval '2 days'");
  await db.sql("INSERT INTO bulletin_posts (id, report_id, user_id, note) VALUES ('post123456','report1234','owner12345','Public request for help')");
  await db.sql("INSERT INTO bulletin_offers (id, post_id, user_id, message, contact) VALUES ('offer12345','post123456','other12345','A public offer to help with this site.','public-contact@example.test')");

  async function request(route, { viewer = null, method = "GET", body, stream = false } = {}) {
    const response = await fetch(base + route, {
      method, headers: { "X-Requested-With": "fetch", ...(viewer ? { Cookie: `sutros_session=${viewer.cookie}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}), ...(stream ? { Accept: "text/event-stream" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, cache: response.headers.get("cache-control"), body: stream ? await response.text() : await response.json() };
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

  await t.test("saved detail, history, and recent lists omit account data for every viewer", async () => {
    for (const viewer of [null, people[0], people[1]]) {
      for (const route of ["/api/reports/report1234", "/api/reports?limit=5", "/api/checks?host=fixture.example"]) {
        const reply = await request(route, { viewer });
        assert.equal(reply.status, 200);
        assertNoPrivateIdentity(assert, reply.body);
        assert.match(reply.cache, /private.*no-store/);
      }
    }
    const detail = (await request("/api/reports/report1234", { viewer: people[0] })).body;
    assert.equal(detail.canPostToBulletin, true);
    assert.deepEqual(detail.findings[0].evidence, stored.findings[0].evidence);
    assert.deepEqual(detail.attestation, stored.attestation);
    assert.equal((await db.getReport("report1234")).userId, "owner12345", "Internal ownership remains available");
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

  await t.test("an account may post an anonymous report without taking report ownership", async () => {
    const reply = await request("/api/bulletin", { viewer: people[1], method: "POST", body: { reportId: "anon123456", note: "Public anonymous report discussion" } });
    assert.equal(reply.status, 201);
    assert.equal(reply.body.post.canManage, true);
    assertNoPrivateIdentity(assert, reply.body);
    assert.equal((await db.getReport("anon123456")).userId, null);
  });

  await t.test("unrated results can be stored without manufacturing a numeric score", async () => {
    await assert.doesNotReject(db.saveReport({ ...stored, id: "unrated123", score: null, grade: "?" }));
    const reply = await request("/api/reports/unrated123");
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
});
