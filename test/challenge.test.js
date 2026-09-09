// Bot-challenge recognition from plain response values (status, headers, body start).
import test from "node:test";
import assert from "node:assert/strict";
import { isChallenge, classifyResponse, CHALLENGE_REASON, headerValue } from "../server/lib/challenge.js";

const SG_BODY = `<html><head><link rel="icon" href="data:;"><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2Fquality%2F&y=ipc:67.205.176.71:1788970115.820"></meta></head></html>`;
const CF_BODY = `<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div id="challenge-platform"><h1>Just a moment...</h1></div></body></html>`;

test("SiteGround 202 with the sgcaptcha refresh is a challenge, for the page and for a stylesheet", () => {
  const page = isChallenge({ status: 202, headers: { "content-type": "text/html", "set-cookie": "nevercache-b39818=Y;Max-Age=-1" }, bodyStart: SG_BODY });
  assert.ok(page, "page should be recognised");
  assert.equal(page.vendor, "siteground");
  assert.equal(page.reason, CHALLENGE_REASON);
  const css = isChallenge({ status: 202, headers: { "content-type": "text/html", "content-length": "291" }, bodyStart: SG_BODY.replace("%2Fquality%2F", "%2Fwp-content%2Fstyle.css") });
  assert.ok(css, "a stylesheet answered with the challenge should be recognised");
  assert.equal(css.vendor, "siteground");
});

test("Cloudflare challenge by header, and by body when the header is missing", () => {
  const byHeader = isChallenge({ status: 503, headers: { "content-type": "text/html; charset=utf-8", "cf-mitigated": "challenge" }, bodyStart: "<html></html>" });
  assert.ok(byHeader);
  assert.equal(byHeader.vendor, "cloudflare");
  const byBody = isChallenge({ status: 403, headers: { "content-type": "text/html" }, bodyStart: CF_BODY });
  assert.ok(byBody);
  assert.equal(byBody.vendor, "cloudflare");
});

test("healthy answers are not challenges", () => {
  assert.equal(isChallenge({ status: 200, headers: { "content-type": "text/css" }, bodyStart: "body{color:red}" }), null);
  assert.equal(isChallenge({ status: 200, headers: { "content-type": "text/html" }, bodyStart: "<!doctype html><html><head><title>Quality</title>" }), null);
  // A legitimate 202 from an API is not a challenge.
  assert.equal(isChallenge({ status: 202, headers: { "content-type": "application/json" }, bodyStart: '{"queued":true}' }), null);
  // A plain 503 maintenance page without challenge markers is an outage, not a challenge.
  assert.equal(isChallenge({ status: 503, headers: { "content-type": "text/html" }, bodyStart: "<html><body><h1>Service Unavailable</h1><p>We are doing maintenance.</p></body></html>" }), null);
  // A 202 that merely mentions the word in a large real page is not a challenge.
  assert.equal(isChallenge({ status: 202, headers: { "content-type": "text/html" }, bodyStart: "<html>" + "x".repeat(9000) + "captcha" }), null);
});

test("generic small interstitials that refresh to a verification path are challenges", () => {
  const r = isChallenge({ status: 202, headers: { "content-type": "text/html" }, bodyStart: '<html><head><meta http-equiv="refresh" content="0;/verify-human?r=%2F"></head><body>Checking your browser before accessing the site.</body></html>' });
  assert.ok(r);
  assert.equal(r.vendor, "generic");
});

test("headers may be a fetch Headers object, a plain object in any case, or missing", () => {
  assert.equal(headerValue(new Headers({ "Cf-Mitigated": "challenge" }), "cf-mitigated"), "challenge");
  assert.equal(headerValue({ "CF-Mitigated": "challenge" }, "cf-mitigated"), "challenge");
  assert.equal(headerValue(undefined, "cf-mitigated"), "");
  assert.ok(isChallenge({ status: 503, headers: new Headers({ "cf-mitigated": "challenge", "content-type": "text/html" }), bodyStart: "" }));
});

test("classifyResponse keeps the shared BROKEN/BLOCKED rule and adds challenge", () => {
  assert.equal(classifyResponse({ status: 200, headers: { "content-type": "text/css" }, bodyStart: "" }), "ok");
  assert.equal(classifyResponse({ status: 404, headers: {}, bodyStart: "" }), "broken");
  assert.equal(classifyResponse({ status: 403, headers: {}, bodyStart: "" }), "blocked");
  assert.equal(classifyResponse({ status: 429, headers: {}, bodyStart: "" }), "blocked");
  assert.equal(classifyResponse({ status: 202, headers: { "content-type": "text/html" }, bodyStart: SG_BODY }), "challenge");
  assert.equal(classifyResponse({ status: 503, headers: { "cf-mitigated": "challenge" }, bodyStart: "" }), "challenge");
});

test("landing on the bot check's own address is the challenge, whatever it answers", async () => {
  const { isChallengeUrl } = await import("../server/lib/challenge.js");
  assert.equal(isChallengeUrl("https://thelindgrengroup.com/.well-known/sgcaptcha/?r=%2Fquality%2F&y=ipc:1.2.3.4:1").vendor, "siteground");
  assert.equal(isChallengeUrl("https://example.com/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1").vendor, "cloudflare");
  assert.equal(isChallengeUrl("https://example.com/quality/"), null);
  // isChallenge honours the address even for a 200 with an ordinary looking body.
  assert.ok(isChallenge({ url: "https://site/.well-known/sgcaptcha/?r=%2F", status: 200, headers: { "content-type": "text/html" }, bodyStart: "<html><body>Checking the site connection security</body></html>" }));
});

test("a real page that merely mentions the SiteGround address is not a challenge; the refresh is", () => {
  assert.equal(isChallenge({ status: 200, headers: { "content-type": "text/html" }, bodyStart: "<html><body><p>If you see /.well-known/sgcaptcha/ ask your host.</p></body></html>" }), null);
  assert.ok(isChallenge({ status: 200, headers: { "content-type": "text/html" }, bodyStart: '<html><head><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2F"></head></html>' }));
});

test("a challenge header is recognised on any status, including 200", () => {
  const r = isChallenge({ url: "https://site/", status: 200, headers: { "content-type": "text/html", "cf-mitigated": "challenge" } });
  assert.ok(r);
  assert.equal(r.vendor, "cloudflare");
});

test("SiteGround is recognised from its headers alone, so a failed file's body never has to be read", () => {
  const r = isChallenge({ status: 202, headers: { "content-type": "text/html", "set-cookie": "nevercache-b39818=Y;Max-Age=-1" }, bodyStart: "" });
  assert.ok(r);
  assert.equal(r.vendor, "siteground");
  assert.equal(isChallenge({ status: 200, headers: { "content-type": "text/html", "set-cookie": "nevercache-b39818=Y" }, bodyStart: "" }), null, "the cookie alone on a 200 page is not a check");
});
