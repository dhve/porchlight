import test from "node:test";
import assert from "node:assert/strict";
import * as safety from "../server/safety.js";
import { reportFixture, assertNoPrivateIdentity } from "./privacy-fixtures.js";

async function projection() {
  try { return (await import("../server/publicReport.js")).publicReport; }
  catch (err) { if (err.code === "ERR_MODULE_NOT_FOUND") return (report) => report; throw err; }
}

test("public reports omit private identity and old feedback while preserving measured and signed content", async () => {
  const original = reportFixture();
  const before = JSON.stringify(original);
  const report = (await projection())(original);
  assertNoPrivateIdentity(assert, report);
  assert.deepEqual(report.assessment, { status: "incomplete", reason: "A planned check timed out." });
  assert.deepEqual(report.coverage, [{ check: "links", status: "inconclusive", reason: "Timed out" }]);
  assert.deepEqual(report.findings[0].evidence, original.findings[0].evidence);
  assert.deepEqual(report.engine, original.engine);
  assert.deepEqual(report.agent, original.agent);
  assert.deepEqual(report.attestation, original.attestation);
  assert.deepEqual(report.contact, { emails: ["public@fixture.example"], pages: ["https://fixture.example/contact"] });
  assert.deepEqual(report.findings[0].disputed, { wrong: 2, right: 0 });
  assert.equal(report.score, null);
  assert.equal(JSON.stringify(original), before, "Projection must not mutate private storage or signed observations");
});

test("posting capability uses private ownership and verified account state", async () => {
  const publicReport = await projection();
  const owner = { id: "owner12345", emailVerified: true };
  const other = { id: "other12345", emailVerified: true };
  const report = reportFixture();
  for (const [viewer, expected] of [[null, false], [owner, true], [other, false], [{ ...owner, emailVerified: false }, false], [{ ...other, role: "admin" }, true]]) {
    assert.equal(publicReport(report, viewer).canPostToBulletin, expected);
  }
  assert.equal(publicReport({ ...report, userId: null }, other).canPostToBulletin, true);
  assert.equal(publicReport({ id: "report1234" }, other).canPostToBulletin, false, "Missing ownership must not imply an anonymous report");
});

test("entry URL privacy rejects embedded credentials and queries before publication", () => {
  const normalize = safety.normalizePublicUrl || safety.normalizeUrl;
  for (const input of ["https://person:password@fixture.example/", "https://person@fixture.example/", "https://fixture.example/reset?token=synthetic", "https://fixture.example/search?q=public"]) {
    const result = normalize(input);
    assert.equal(result.ok, false, input);
    assert.match(result.error, /public|query|password|credential|address/i);
    assert.equal(result.error.includes("synthetic"), false);
  }
  for (const input of ["", "not a domain", "https://fixture.example:444/"]) assert.equal(normalize(input).ok, false);
});

test("entry URL privacy strips fragments without breaking ordinary internal query URLs", () => {
  const normalize = safety.normalizePublicUrl || safety.normalizeUrl;
  assert.equal(normalize("https://fixture.example/about#synthetic-token").url.href, "https://fixture.example/about");
  assert.equal(normalize("fixture.example/about").url.href, "https://fixture.example/about");
  assert.equal(safety.normalizeUrl("https://fixture.example/search?q=ordinary").url.search, "?q=ordinary");
});
