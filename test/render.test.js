// Render reliability: the browsing agent, the browser check, the modernization check, and
// the proof pictures against a local fixture site, in a real Chromium. These are the
// regressions for the thelindgrengroup.com/quality/ case (a hosting bot check answered the
// stylesheet, the page rendered unstyled, and the agent reported it as the site's problem)
// and its neighbours: a document-level challenge, a stylesheet that is really missing, one
// that fails once, a slow one, and a page with none.
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

async function agentRun(path, note, opts = {}) {
  const facts = await factsFor(fx.origin, path);
  const model = scriptedModel(note);
  const ctx = { url: new URL(path, fx.origin), facts, onEvent: () => {}, agentModel: model, ...opts };
  const out = await runAgentBrowse(ctx);
  return { out, facts, model };
}

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

test("agent: a content note on an unstyled page is kept, but without a misleading picture", async () => {
  const { out } = await agentRun("/sgcss", contentNote(fx.origin + "/sgcss"));
  assert.equal(out.findings.length, 1);
  assert.deepEqual(out.findings[0].evidence.shots, []);
  assert.equal(out.agent.shots.length, 0);
});

test("agent: a stylesheet that really is missing is allowed as evidence only after an independent retry agrees", async () => {
  const { out, model } = await agentRun("/broken", appearanceNote(fx.origin + "/broken"));
  assert.equal(out.findings.length, 1, model.noteResult());
  const f = out.findings[0];
  assert.ok(f.evidence.lines.some((l) => /404 Not Found twice/.test(l)), JSON.stringify(f.evidence.lines));
  assert.ok(f.evidence.items.some((it) => /\/missing\.css$/.test(it.url) && it.status === 404), JSON.stringify(f.evidence.items));
  assert.ok(fx.hits("/missing.css") >= 2, `expected an independent retry, saw ${fx.hits("/missing.css")} request(s)`);
});

test("agent: a stylesheet that fails once and then works is not proof of anything", async () => {
  fx.resetFlaky();
  const { out, model } = await agentRun("/flaky", appearanceNote(fx.origin + "/flaky"));
  assert.equal(out.findings.length, 0);
  assert.match(model.noteResult(), /did not fully load/);
  assert.ok(fx.hits("/flaky.css") >= 2);
});

test("agent: slow, bare, and healthy pages carry no styling warning", async () => {
  for (const path of ["/slow", "/bare", "/healthy"]) {
    const { out, model } = await agentRun(path, appearanceNote(fx.origin + path));
    assert.doesNotMatch(model.observations(), /did not load|had not loaded|Do not judge/, `${path}: ${model.observations().slice(0, 300)}`);
    assert.equal(out.findings.length, 1, `${path}: the scripted note should go through on a reliably rendered page`);
  }
});

test("agent: a bot check for the document itself ends the run honestly", async () => {
  for (const path of ["/sgdoc", "/cfdoc"]) {
    const { out, facts } = await agentRun(path, appearanceNote(fx.origin + path));
    assert.equal(out.skipped, true, path);
    assert.match(String(out.reason), /bot check/, path);
    assert.ok(facts.challenged, path);
  }
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

test("browser check: a bot check for the homepage skips the pass with the reason", async () => {
  const facts = await factsFor(fx.origin, "/sgdoc");
  const out = await runBrowser({ url: new URL("/sgdoc", fx.origin), facts, client: null });
  assert.equal(out.skipped, true);
  assert.match(String(out.reason), /bot check/);
  assert.ok(facts.challenged);
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
      { path: "/sgdoc", shots: 0, declined: /bot check/ },
      { path: "/sgcss", shots: 0, declined: /stylesheet/ },
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

test("proof guard: loopback and private addresses are refused even as the site's own host", async () => {
  // The pure guard.
  assert.equal(stayedOnSite("http://127.0.0.1:8080/healthy", "127.0.0.1"), false, "loopback own host");
  assert.equal(stayedOnSite("http://10.0.0.5/admin", "10.0.0.5"), false, "private own host");
  assert.equal(stayedOnSite("http://169.254.169.254/latest/meta-data/", "169.254.169.254"), false, "metadata address");
  assert.equal(stayedOnSite("http://[::1]/", "[::1]"), false, "ipv6 loopback");
  assert.equal(stayedOnSite("http://fixture.test/healthy", "fixture.test"), true, "hostname on the site");
  assert.equal(stayedOnSite("http://other.example/healthy", "fixture.test"), false, "off site");
  // End to end: a checkup whose site is the loopback gets no picture, with the reason recorded.
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
