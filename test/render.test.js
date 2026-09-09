// Render reliability: the browsing agent, the browser check, the modernization check, and
// the proof pictures against a local fixture site, in a real Chromium. These are the
// regressions for the thelindgrengroup.com/quality/ case (a hosting bot check answered the
// stylesheet, the page rendered unstyled, and the agent reported it as the site's problem)
// and its neighbours: a document-level challenge, a stylesheet that is really missing, one
// that fails once, a slow one, a page with none, alternate/disabled/frame stylesheets, a
// stylesheet on another host, a challenged script, and challenges that must not leak from
// one document into the next.
import test from "node:test";
import assert from "node:assert/strict";
import { startFixture, factsFor, scriptedModel, aliasedSession } from "./helpers/fixture.js";
import { runAgentBrowse } from "../server/checks/agentBrowse.js";
import { runBrowser } from "../server/checks/browser.js";
import { runModernization } from "../server/checks/modernization.js";
import { captureProof, stayedOnSite, shotHeaders, SHOT_CACHE_CONTROL } from "../server/proof.js";

const appearanceNote = (where) => ({
  title: "The page appears unstyled on a phone",
  what: "The page shows plain blue links and a bulleted menu with no colors or layout.",
  where,
  severity: "watch",
  category: "modernization",
  why: "A visitor would think the site is broken.",
  fix: "Check that the stylesheet loads.",
});
const contentNote = (where) => ({
  title: "The menu has no link to a prices page",
  what: 'The menu lists "Home", "About", and "Contact" only.',
  where,
  quote: "Contact",
  severity: "minor",
  category: "quality",
  why: "A visitor looking for prices has nowhere to go.",
  fix: "Add a prices page to the menu.",
});

let fx;
test.before(async () => { fx = await startFixture(); });
test.after(async () => { if (fx) await fx.close(); });

async function agentRun(path, note, { opens = [] } = {}) {
  const facts = await factsFor(fx.origin, path);
  const model = scriptedModel(note, { opens: opens.map((p) => fx.origin + p) });
  const ctx = { url: new URL(path, fx.origin), facts, onEvent: () => {}, agentModel: model };
  const out = await runAgentBrowse(ctx);
  return { out, facts, model };
}
const STYLE_WARNING = /did not load|had not loaded|Do not judge|when our browser asked/;

test("agent: a stylesheet answered by a hosting bot check never becomes an appearance note", async () => {
  const { out, facts, model } = await agentRun("/sgcss", appearanceNote(fx.origin + "/sgcss"));
  assert.equal(out.skipped, undefined, `agent should run, got ${out.reason}`);
  assert.equal(out.findings.length, 0, "no appearance finding");
  assert.match(model.observations(), /stylesheet \/sg\.css did not load/);
  assert.match(model.observations(), /bot check/);
  assert.match(model.noteResult(), /did not fully load/);
  assert.ok(facts.challenged, "facts.challenged is set for the pipeline");
  assert.ok(out.agent && out.agent.challenged, "agent.challenged is reported");
});

test("agent: a content note on an unstyled page is kept, with the observed failure and no picture", async () => {
  const { out } = await agentRun("/sgcss", contentNote(fx.origin + "/sgcss"));
  assert.equal(out.findings.length, 1);
  assert.deepEqual(out.findings[0].evidence.shots, []);
  assert.equal(out.agent.shots.length, 0);
  assert.ok(out.findings[0].evidence.lines.some((l) => /Our browser's request for the page's stylesheet \/sg\.css answered 202/.test(l)), JSON.stringify(out.findings[0].evidence.lines));
  assert.ok(out.findings[0].evidence.lines.some((l) => /does not show what visitors see/.test(l)));
});

test("agent: a missing stylesheet is inconclusive, recorded as our observation, and never retried", async () => {
  const { out, model } = await agentRun("/broken", appearanceNote(fx.origin + "/broken"));
  assert.equal(out.findings.length, 0, "an appearance note is refused: one 404 for our browser proves nothing about visitors");
  assert.match(model.observations(), /stylesheet \/missing\.css answered 404 Not Found when our browser asked for it/);
  assert.doesNotMatch(model.observations(), /twice|standard browser headers/);
  assert.equal(fx.hits("/missing.css"), 1, "no independent retry request is made");
  // The observed failure still travels as evidence with a content note about the same page.
  const second = await agentRun("/broken", contentNote(fx.origin + "/broken"));
  assert.equal(second.out.findings.length, 1, second.model.noteResult());
  const f = second.out.findings[0];
  assert.ok(f.evidence.lines.some((l) => /stylesheet \/missing\.css answered 404 Not Found/.test(l) && /does not show what visitors see/.test(l)), JSON.stringify(f.evidence.lines));
  assert.ok(f.evidence.items.some((it) => /\/missing\.css$/.test(it.url) && it.status === 404 && it.kind === "resource"), JSON.stringify(f.evidence.items));
  assert.deepEqual(f.evidence.shots, []);
  assert.equal(fx.hits("/missing.css"), 2, "one request per page load, still no retry");
});

test("agent: a stylesheet that fails once is inconclusive too, without a second request", async () => {
  fx.resetFlaky();
  const { out, model } = await agentRun("/flaky", appearanceNote(fx.origin + "/flaky"));
  assert.equal(out.findings.length, 0);
  assert.match(model.noteResult(), /did not fully load/);
  assert.equal(fx.hits("/flaky.css"), 1);
});

test("agent: an extensionless stylesheet address that fails is still detected", async () => {
  const { out, model } = await agentRun("/extless", appearanceNote(fx.origin + "/extless"));
  assert.match(model.observations(), /stylesheet \/theme\?v=1 answered 404 Not Found/);
  assert.equal(out.findings.length, 0);
});

test("agent: slow, bare, healthy, and mixed (alternate, disabled, print, framed) pages carry no styling warning", async () => {
  for (const path of ["/slow", "/bare", "/healthy", "/mixed"]) {
    const { out, model } = await agentRun(path, appearanceNote(fx.origin + path));
    assert.doesNotMatch(model.observations(), STYLE_WARNING, `${path}: ${model.observations().slice(0, 400)}`);
    assert.equal(out.findings.length, 1, `${path}: the scripted note should go through on a reliably rendered page`);
  }
});

test("agent: a bot check on another host makes the page inconclusive without blaming this site's hosting", async () => {
  const { out, facts, model } = await agentRun("/thirdparty", appearanceNote(fx.origin + "/thirdparty"));
  // Chromium's opaque-response blocking hides the other host's HTML answer from the page, so
  // what our browser sees is a refused stylesheet; either way the page is inconclusive.
  assert.match(model.observations(), /stylesheet \/sg\.css did not load \((that file's host put a bot check|the browser refused an answer from that host)/);
  assert.equal(out.findings.length, 0);
  assert.equal(facts.challenged, undefined, "facts.challenged is about this site's hosting only");
  assert.equal(out.agent.challenged, null);
});

test("agent: a bot check for the document itself ends the run honestly", async () => {
  for (const path of ["/sgdoc", "/cfdoc"]) {
    const { out, facts } = await agentRun(path, appearanceNote(fx.origin + path));
    assert.equal(out.skipped, true, path);
    assert.match(String(out.reason), /bot check/, path);
    assert.ok(facts.challenged, path);
  }
});

test("agent: challenges without a challenge-shaped status are recognised on documents", async () => {
  for (const path of ["/cf200doc", "/sg200doc"]) {
    const { out, facts } = await agentRun(path, appearanceNote(fx.origin + path));
    assert.equal(out.skipped, true, `${path}: ${JSON.stringify(out.findings)}`);
    assert.match(String(out.reason), /bot check|Cloudflare challenge/, path);
    assert.ok(facts.challenged, path);
  }
});

test("agent: a 429 for the document still ends the run as limited", async () => {
  const { out, facts } = await agentRun("/limited", appearanceNote(fx.origin + "/limited"));
  assert.equal(out.skipped, true);
  assert.match(String(out.reason), /limited our checker/);
  assert.equal(facts.throttled, true);
});

test("agent: a challenge does not carry over to the next document", async () => {
  // Home is fine; the agent then opens a bot check page, then a real 500 page, and notes the error.
  const note = { ...contentNote(fx.origin + "/error"), title: "The page shows a server error", what: 'The page says "Whoops, looks like something went wrong."', quote: "Whoops, looks like something went wrong." };
  const { out, model } = await agentRun("/healthy", note, { opens: ["/sgdoc", "/error"] });
  const errObs = model.observationFor("/error");
  assert.ok(errObs, "the /error observation was shown to the model");
  assert.doesNotMatch(JSON.stringify(errObs.warnings), /bot check/, JSON.stringify(errObs.warnings));
  assert.match(JSON.stringify(errObs.warnings), /status 500/);
  assert.equal(out.findings.length, 1, model.noteResult());
  assert.equal(out.findings[0].evidence.pages[0], fx.origin + "/error");
});

test("agent: a note naming a bot check page is refused wherever the agent is standing", async () => {
  const { out, model } = await agentRun("/healthy", contentNote(fx.origin + "/sgdoc"), { opens: ["/sgdoc", "/about"] });
  assert.equal(out.findings.length, 0);
  assert.match(model.noteResult(), /bot check/);
  // An address the agent never opened is not quietly re-attributed to the current page.
  const other = await agentRun("/healthy", contentNote(fx.origin + "/never-opened"), { opens: ["/about"] });
  assert.equal(other.out.findings.length, 0);
  assert.match(other.model.noteResult(), /not one of the pages you opened/);
});

test("agent: a note about an earlier page never photographs the page the agent is on", async () => {
  // Standing on a bot check page, the model notes the (reliable) homepage: the picture kept
  // is the homepage's own observation picture, never a fresh shot of the check.
  const { out } = await agentRun("/healthy", appearanceNote(fx.origin + "/healthy"), { opens: ["/sgdoc"] });
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].evidence.shots.length, 1);
  assert.equal(out.findings[0].evidence.shots[0].page, fx.origin + "/healthy");
  assert.equal(out.agent.shots[0].page, fx.origin + "/healthy");
});

test("agent: a late-arriving challenge body does not contaminate the next document's ledger", async () => {
  const { out, model } = await agentRun("/slowbody", appearanceNote(fx.origin + "/healthy"), { opens: ["/healthy"] });
  const healthy = model.observationFor("/healthy");
  assert.ok(healthy, "the /healthy observation was shown");
  assert.doesNotMatch(JSON.stringify(healthy.warnings), STYLE_WARNING, JSON.stringify(healthy.warnings));
  assert.equal(out.findings.length, 1, model.noteResult());
});

test("browser check: challenged sub-resources are held back, not loaded and not broken", async () => {
  const facts = await factsFor(fx.origin, "/sgcss");
  const out = await runBrowser({ url: new URL("/sgcss", fx.origin), facts, client: null });
  assert.equal(out.skipped, undefined, out.reason);
  assert.ok(out.challenged >= 1, "held-back count");
  assert.ok(!out.findings.some((f) => f.id === "failed-resources"), "no failed-resources finding");
  assert.ok(!out.passes.some((p) => /files? the homepage asked for|All \d+ files/.test(p)), `no all-files-loaded pass: ${JSON.stringify(out.passes)}`);
  assert.ok(facts.challenged);
});

test("browser check: a script answered by a bot check is not reported as the site's own error", async () => {
  const facts = await factsFor(fx.origin, "/sgjs");
  const out = await runBrowser({ url: new URL("/sgjs", fx.origin), facts, client: null });
  assert.equal(out.skipped, undefined, out.reason);
  assert.ok(out.challenged >= 1);
  assert.ok(!out.findings.some((f) => f.id === "console-errors"), JSON.stringify(out.findings.map((f) => f.id)));
  assert.ok(!out.findings.some((f) => f.id === "failed-resources"));
});

test("browser check: Cloudflare's ordinary detection script on a normal page is not a challenge", async () => {
  const facts = await factsFor(fx.origin, "/cfjsd");
  const out = await runBrowser({ url: new URL("/cfjsd", fx.origin), facts, client: null });
  assert.equal(out.skipped, undefined, out.reason);
  assert.equal(out.challenged, 0);
  assert.equal(facts.challenged, undefined);
});

test("browser check: a bot check on another host does not blame this site's hosting", async () => {
  const facts = await factsFor(fx.origin, "/thirdparty");
  const out = await runBrowser({ url: new URL("/thirdparty", fx.origin), facts, client: null });
  assert.equal(out.skipped, undefined, out.reason);
  assert.equal(facts.challenged, undefined, "another host's check says nothing about this site's hosting");
  assert.ok(!out.findings.some((f) => f.id === "failed-resources"), "a refused cross-origin answer is not a broken file");
});

test("browser check: a bot check for the homepage skips the pass with the reason", async () => {
  for (const path of ["/sgdoc", "/cf200doc", "/sg200doc"]) {
    const facts = await factsFor(fx.origin, path);
    const out = await runBrowser({ url: new URL(path, fx.origin), facts, client: null });
    assert.equal(out.skipped, true, path);
    assert.match(String(out.reason), /bot check|Cloudflare challenge/, path);
    assert.ok(facts.challenged, path);
  }
});

test("modernization: a challenge page is never judged for its viewport or design", async () => {
  const facts = await factsFor(fx.origin, "/sgdoc");
  const out = await runModernization({ facts });
  assert.equal(out.skipped, true);
  assert.equal(out.findings.length, 0);
  assert.equal(out.passes.length, 0);
});

// The proof guard refuses loopback and private addresses, so the fixture is presented under a
// public-looking name that only this test's browser maps to the loopback (a host-resolver
// alias handed in through captureProof's session injection). Production opens its own browser.
const ALIAS = "fixture.test";

test("proof: pictures are taken only of pages that rendered for us", async () => {
  const publicOrigin = `http://${ALIAS}:${fx.port}`;
  const session = await aliasedSession(ALIAS);
  try {
    const cases = [
      { path: "/healthy", shots: 1 },
      { path: "/mixed", shots: 1 },
      { path: "/sgdoc", shots: 0, declined: /bot check/ },
      { path: "/cf200doc", shots: 0, declined: /bot check|Cloudflare challenge/ },
      { path: "/sg200doc", shots: 0, declined: /bot check/ },
      { path: "/sgcss", shots: 0, declined: /stylesheet/ },
      { path: "/broken", shots: 0, declined: /stylesheet \/missing\.css answered 404/ },
    ];
    for (const c of cases) {
      const facts = await factsFor(fx.origin, c.path, publicOrigin);
      const finding = { id: "verbose-errors", severity: "watch", evidence: { lines: ["x"], pages: [publicOrigin + c.path] } };
      const out = await captureProof({ facts, findings: [finding], onEvent: () => {}, session });
      assert.equal(out.shots.length, c.shots, `${c.path}: ${JSON.stringify(out.declined || out.skipped)}`);
      if (c.declined) assert.ok((out.declined || []).some((d) => c.declined.test(d.reason)), `${c.path}: ${JSON.stringify(out.declined)}`);
    }
  } finally {
    await session.close();
  }
});

test("proof: a challenge on one target does not block the picture of the next", async () => {
  const publicOrigin = `http://${ALIAS}:${fx.port}`;
  const session = await aliasedSession(ALIAS);
  try {
    const facts = await factsFor(fx.origin, "/healthy", publicOrigin);
    const findings = [
      { id: "flow-error-order", severity: "watch", evidence: { lines: ["x"], pages: [publicOrigin + "/"], items: [{ url: publicOrigin + "/sgdoc", status: 202, kind: "page" }] } },
      { id: "verbose-errors", severity: "watch", evidence: { lines: ["x"], pages: [publicOrigin + "/error"] } },
    ];
    const out = await captureProof({ facts, findings, onEvent: () => {}, session });
    assert.equal(out.shots.length, 1, JSON.stringify(out.declined || out.skipped));
    assert.equal(out.shots[0].page, publicOrigin + "/error");
    assert.ok((out.declined || []).some((d) => /bot check/.test(d.reason)));
  } finally {
    await session.close();
  }
});

test("proof guard: loopback and private addresses are refused even as the site's own host", async () => {
  assert.equal(stayedOnSite("http://127.0.0.1:8080/healthy", "127.0.0.1"), false, "loopback own host");
  assert.equal(stayedOnSite("http://10.0.0.5/admin", "10.0.0.5"), false, "private own host");
  assert.equal(stayedOnSite("http://169.254.169.254/latest/meta-data/", "169.254.169.254"), false, "metadata address");
  assert.equal(stayedOnSite("http://[::1]/", "[::1]"), false, "ipv6 loopback");
  assert.equal(stayedOnSite("http://fixture.test/healthy", "fixture.test"), true, "hostname on the site");
  assert.equal(stayedOnSite("http://other.example/healthy", "fixture.test"), false, "off site");
  const facts = await factsFor(fx.origin, "/healthy");
  const finding = { id: "verbose-errors", severity: "watch", evidence: { lines: ["x"], pages: [fx.origin + "/healthy"] } };
  const out = await captureProof({ facts, findings: [finding], onEvent: () => {} });
  assert.equal(out.shots.length, 0);
  assert.ok((out.declined || []).some((d) => /private address/.test(d.reason)), JSON.stringify(out.declined || out.skipped));
});

test("proof: picture responses are never cached", () => {
  assert.equal(SHOT_CACHE_CONTROL, "private, no-store");
  const h = shotHeaders("image/jpeg");
  assert.equal(h["Cache-Control"], "private, no-store");
  assert.equal(h["Content-Type"], "image/jpeg");
  assert.equal(h["X-Content-Type-Options"], "nosniff");
  assert.equal(shotHeaders("text/html")["Content-Type"], "image/jpeg", "a stored mime that is not an image falls back to jpeg");
  assert.equal(shotHeaders(undefined)["Content-Type"], "image/jpeg");
});
