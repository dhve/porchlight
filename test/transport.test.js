// Transport failures versus real HTTP answers.
//
// Regressions for the cs4il.org report (2qXw9zeZ5p): every request after the homepage was
// refused at the TCP level from the scanner's own network, and the checker reported "N of N
// broken" links and images, an urgent "server error" for the contact page, and a recheck that
// confirmed it. A connection that fails without an HTTP answer says nothing about what
// visitors see. It must never count as broken, never become a server-error finding, and a
// recheck of it must stay inconclusive with changed: null. Genuine 404 and 500 answers must
// keep being detected.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import express from "express";

process.env.REQUEST_TIMEOUT_MS = "700"; // short client timeout for the hanging-server case
const { classifyError, probeAddress, createClient, createThrottleGuard } = await import("../server/lib/http.js");
const { runLinks } = await import("../server/checks/links.js");
const { runFlows } = await import("../server/checks/flows.js");
const { createRetestRouter } = await import("../server/retest.js");
const cheerio = await import("cheerio");

// ---- local hosts that fail in every transport way, plus one that answers ----
async function listen(server) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${server.address().port}`;
}
async function refusedOrigin() {
  const s = net.createServer();
  const origin = await listen(s);
  await new Promise((r) => s.close(r)); // the port is closed again: every connection is refused
  return origin;
}
async function resetServer() {
  const s = net.createServer((socket) => socket.destroy()); // accept, then slam the door
  return { origin: await listen(s), close: () => new Promise((r) => s.close(r)) };
}
async function hangingServer() {
  const sockets = new Set();
  const s = net.createServer((socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); }); // never answers
  return { origin: await listen(s), close: () => { for (const x of sockets) x.destroy(); return new Promise((r) => s.close(r)); } };
}
async function answeringServer() {
  const hits = [];
  const s = http.createServer((req, res) => {
    hits.push(req.method + " " + req.url);
    const send = (status, type, body) => { res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body) }); res.end(body); };
    if (req.url.startsWith("/missing")) return send(404, "text/html", "<h1>Not Found</h1>");
    if (req.url.startsWith("/error")) return send(500, "text/html", "<h1>Whoops</h1>");
    if (req.url.startsWith("/ok.png")) return send(200, "image/png", "png");
    return send(200, "text/html; charset=utf-8", "<!doctype html><html><body><h1>ok</h1></body></html>");
  });
  return { origin: await listen(s), hits, close: () => new Promise((r) => s.close(r)) };
}
const DNS_URL = "http://no-such-host.invalid/page";

function factsFor(origin, html) {
  const $ = cheerio.load(html);
  return { reachable: true, baseOrigin: origin, finalUrl: new URL(origin + "/"), $, pages: [{ url: origin + "/", status: 200, html, $ }] };
}

// ---------------------------------------------------------------------------
test("classifyError: refused, reset, timed out, and unresolved connections are inconclusive, never broken", () => {
  for (const code of ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_SOCKET"]) {
    const c = classifyError(Object.assign(new Error(code), { code }));
    assert.equal(c.verdict, "inconclusive", code);
    assert.ok(c.transport, `${code} is a transport failure`);
  }
  const t = classifyError(Object.assign(new Error("t"), { code: "TIMEOUT" }));
  assert.equal(t.verdict, "inconclusive");
  assert.equal(classifyError(Object.assign(new Error("b"), { code: "BUDGET" })).reason, "budget");
});

test("probeAddress: transport failures stay inconclusive with their reason; real answers keep their verdicts", async () => {
  const client = createClient();
  const refused = await refusedOrigin();
  const r = await probeAddress(client, refused + "/x", { headFirst: true });
  assert.equal(r.verdict, "inconclusive", JSON.stringify(r));
  assert.equal(r.reason, "refused");
  assert.equal(r.status, 0);
  assert.equal(r.statusText, "connection refused");

  const reset = await resetServer();
  const rr = await probeAddress(client, reset.origin + "/x", { headFirst: true });
  await reset.close();
  assert.equal(rr.verdict, "inconclusive", JSON.stringify(rr));
  assert.ok(["reset", "refused"].includes(rr.reason), rr.reason);

  const d = await probeAddress(client, DNS_URL, { headFirst: true });
  assert.equal(d.verdict, "inconclusive");
  assert.equal(d.reason, "dns");

  const hang = await hangingServer();
  const h = await probeAddress(client, hang.origin + "/x", { headFirst: true });
  await hang.close();
  assert.equal(h.verdict, "inconclusive");
  assert.equal(h.reason, "timeout");

  const site = await answeringServer();
  try {
    assert.equal((await probeAddress(client, site.origin + "/ok", { headFirst: true })).verdict, "ok");
    const missing = await probeAddress(client, site.origin + "/missing", { headFirst: true });
    assert.equal(missing.verdict, "broken");
    assert.equal(missing.status, 404);
    const error = await probeAddress(client, site.origin + "/error", { headFirst: false });
    assert.equal(error.verdict, "broken");
    assert.equal(error.status, 500);
  } finally {
    await site.close();
  }
});

test("guard: consecutive connection failures to the site stop the check and are recorded for the pipeline", async () => {
  const facts = {};
  const guard = createThrottleGuard(facts, 2);
  const client = createClient();
  const refused = await refusedOrigin();
  for (let i = 0; i < 3; i++) await probeAddress(client, `${refused}/p${i}`, { headFirst: true, throttle: guard });
  assert.equal(guard.stopped, true, "stopped after repeated refusals");
  assert.equal(guard.reason, "unreachable");
  assert.match(String(facts.connectionLost || ""), /connection refused/);
  assert.notEqual(facts.throttled, true, "a refusal is not a rate limit");
});

test("links: refused connections produce no broken findings, an honest coverage gap, and no pass", async () => {
  const refused = await refusedOrigin();
  const html = `<html><body><a href="/about/">About</a><a href="/services/">Services</a><a href="/events/">Events</a><img src="/wp-content/uploads/logo.png"><img src="/wp-content/uploads/hero.webp"></body></html>`;
  const facts = factsFor(refused, html);
  const out = await runLinks({ client: createClient(), facts });
  assert.deepEqual(out.findings, [], JSON.stringify(out.findings.map((f) => f.id)));
  assert.deepEqual(out.passes, []);
  assert.equal(out.status, "inconclusive");
  assert.match(out.reason, /could not connect|stopped accepting connections/i);
  assert.match(out.reason, /does not show what visitors see/i);
  assert.ok(facts.connectionLost, "the pipeline is told the site stopped accepting our connections");
});

test("links: genuine 404 answers are still reported, with every item kept", async () => {
  const site = await answeringServer();
  try {
    const html = `<html><body><a href="/ok">Fine</a><a href="/missing-1">Gone one</a><a href="/missing-2">Gone two</a><img src="/ok.png"><img src="/missing.png"></body></html>`;
    const facts = factsFor(site.origin, html);
    const out = await runLinks({ client: createClient(), facts });
    const links = out.findings.find((f) => f.id === "broken-links");
    const images = out.findings.find((f) => f.id === "broken-images");
    assert.ok(links, "broken-links finding");
    assert.equal(links.evidence.items.length, 2);
    assert.ok(links.evidence.items.every((it) => it.status === 404));
    assert.ok(images, "broken-images finding");
    assert.equal(images.evidence.items[0].status, 404);
    assert.doesNotMatch(links.evidence.method, /connection failed both times/);
    assert.equal(out.status, "completed");
  } finally {
    await site.close();
  }
});

test("flows: a refused contact page is inconclusive, not an urgent server error", async () => {
  const refused = await refusedOrigin();
  const facts = factsFor(refused, `<html><body><a href="/contact-us/">Contact Us</a></body></html>`);
  const out = await runFlows({ client: createClient(), facts });
  assert.deepEqual(out.findings, [], JSON.stringify(out.findings.map((f) => f.id)));
  assert.equal(out.status, "inconclusive");
  assert.match(out.reason, /could not connect|stopped accepting connections/i);
  assert.match(out.reason, /does not show what visitors see/i);
});

test("flows: a real 500 and a real 404 on customer pages are still findings", async () => {
  const site = await answeringServer();
  try {
    const facts = factsFor(site.origin, `<html><body><a href="/error">Contact Us</a><a href="/missing">Order</a></body></html>`);
    const out = await runFlows({ client: createClient(), facts });
    const ids = out.findings.map((f) => f.id).sort();
    assert.deepEqual(ids, ["flow-error-contact", "flow-missing-ordering"]);
    const err = out.findings.find((f) => f.id === "flow-error-contact");
    assert.equal(err.severity, "urgent");
    assert.equal(err.evidence.items[0].status, 500);
    assert.match(err.evidence.method, /both tries/);
  } finally {
    await site.close();
  }
});

// ---- rechecks ----
async function retestApp(report, extra = {}) {
  const app = express();
  app.use(express.json());
  app.use(createRetestRouter({
    loadReport: async () => report, dbOn: () => true, resolve: async () => ({ ok: true }),
    consumeFn: () => ({ ok: true }), ipFn: () => "test", gapMs: 0, saveAttempt: async () => null,
    allowPort: () => true, ...extra,
  }));
  const server = http.createServer(app);
  const origin = await listen(server);
  return { origin, close: () => new Promise((r) => server.close(r)) };
}
async function recheck(appOrigin, findingId) {
  const res = await fetch(`${appOrigin}/api/reports/abcdefgh12/retest`, { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "fetch" }, body: JSON.stringify({ findingId }) });
  return { status: res.status, body: await res.json() };
}

test("recheck: connection failures are inconclusive with changed null, whatever the recorded baseline", async () => {
  const refused = await refusedOrigin();
  const hang = await hangingServer();
  const report = { id: "abcdefgh12", findings: [
    { id: "flow-error-contact", evidence: { items: [{ url: refused + "/contact-us/", status: 0, statusText: "connection refused", kind: "page" }] } },
    { id: "broken-links", evidence: { items: [
      { url: refused + "/about/", status: 404, statusText: "Not Found", kind: "link" },
      { url: DNS_URL, status: 404, statusText: "Not Found", kind: "link" },
      { url: hang.origin + "/slow", status: 404, statusText: "Not Found", kind: "link" },
    ] } },
  ] };
  const app = await retestApp(report);
  try {
    const a = await recheck(app.origin, "flow-error-contact");
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.items[0].classification, "inconclusive");
    assert.equal(a.body.items[0].changed, null);
    assert.equal(a.body.items[0].ok, null);
    assert.equal(a.body.items[0].status, 0);
    const b = await recheck(app.origin, "broken-links");
    assert.equal(b.status, 200, JSON.stringify(b.body));
    for (const it of b.body.items) {
      assert.equal(it.classification, "inconclusive", JSON.stringify(it));
      assert.equal(it.changed, null, JSON.stringify(it));
      assert.equal(it.ok, null);
      assert.ok(["refused", "reset", "dns", "timeout"].includes(it.reason), JSON.stringify(it));
    }
  } finally {
    await app.close();
    await hang.close();
  }
});

test("recheck: real answers still resolve to working or broken with an honest changed flag", async () => {
  const site = await answeringServer();
  const report = { id: "abcdefgh12", findings: [
    { id: "broken-links", evidence: { items: [
      { url: site.origin + "/ok", status: 404, statusText: "Not Found", kind: "link" },
      { url: site.origin + "/missing", status: 404, statusText: "Not Found", kind: "link" },
      { url: site.origin + "/error", status: 500, statusText: "Internal Server Error", kind: "link" },
    ] } },
  ] };
  const app = await retestApp(report);
  try {
    const r = await recheck(app.origin, "broken-links");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [ok, missing, error] = r.body.items;
    assert.equal(ok.classification, "working"); assert.equal(ok.changed, true);
    assert.equal(missing.classification, "broken"); assert.equal(missing.changed, false);
    assert.equal(error.classification, "broken"); assert.equal(error.changed, false);
  } finally {
    await app.close();
    await site.close();
  }
});
