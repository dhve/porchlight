// Stylesheet outcome tracking and the deterministic gate on appearance notes.
import test from "node:test";
import assert from "node:assert/strict";
import { classifyStylesheetResponse, assessStyling, isAppearanceNote, noteRefusal } from "../server/lib/styling.js";

const SG_BODY = `<html><head><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2Fstyle.css&y=ipc:1.2.3.4:1"></head></html>`;

test("classifyStylesheetResponse: ok, broken, blocked, challenge, failed", () => {
  assert.equal(classifyStylesheetResponse({ url: "https://s/a.css", status: 200, contentType: "text/css" }).outcome, "ok");
  assert.equal(classifyStylesheetResponse({ url: "https://s/a.css", status: 404, contentType: "text/html" }).outcome, "broken");
  assert.equal(classifyStylesheetResponse({ url: "https://s/a.css", status: 403, contentType: "text/html" }).outcome, "blocked");
  assert.equal(classifyStylesheetResponse({ url: "https://s/a.css", status: 202, contentType: "text/html", bodyStart: SG_BODY }).outcome, "challenge");
  // A 200 whose body is not CSS is something else standing in for the stylesheet; not the site's fault, not proof either.
  assert.equal(classifyStylesheetResponse({ url: "https://s/a.css", status: 200, contentType: "text/html", bodyStart: "<html>" }).outcome, "blocked");
  assert.equal(classifyStylesheetResponse({ url: "https://s/a.css", status: 0, errorText: "net::ERR_TIMED_OUT" }).outcome, "failed");
});

test("assessStyling: healthy, no stylesheet, and slow-but-loaded pages are reliable", () => {
  assert.equal(assessStyling({ linked: 1, applied: 1, failures: [] }).unreliable, false);
  assert.equal(assessStyling({ linked: 0, applied: 0, failures: [] }).unreliable, false);
  assert.deepEqual(assessStyling({ linked: 2, applied: 2, failures: [] }).warnings, []);
});

test("assessStyling: a challenged or blocked stylesheet makes appearance unreliable and says why", () => {
  const a = assessStyling({ linked: 1, applied: 0, failures: [{ url: "https://s/wp-content/style.css", status: 202, outcome: "challenge", reason: "The site's hosting put a bot check in front of our checker" }] });
  assert.equal(a.unreliable, true);
  assert.match(a.warnings[0], /stylesheet \/wp-content\/style\.css did not load/);
  assert.match(a.warnings[0], /bot check/);
  assert.match(a.warnings[0], /Do not judge its appearance/);
  const b = assessStyling({ linked: 1, applied: 0, failures: [{ url: "https://s/a.css", status: 403, outcome: "blocked" }] });
  assert.equal(b.unreliable, true);
});

test("assessStyling: a stylesheet still loading when we looked is unreliable, not a finding", () => {
  const a = assessStyling({ linked: 2, applied: 1, failures: [] });
  assert.equal(a.unreliable, true);
  assert.match(a.warnings[0], /1 of 2 stylesheets had not loaded/);
});

test("assessStyling: a 404 stylesheet is inconclusive for our browser, never proof of what visitors see", () => {
  const a = assessStyling({ linked: 1, applied: 0, failures: [{ url: "https://s/missing.css", status: 404, outcome: "broken" }] });
  assert.equal(a.unreliable, true, "a 404 for our browser is not proof");
  assert.match(a.warnings[0], /answered 404 Not Found when our browser asked for it/);
  assert.match(a.warnings[0], /Do not judge its appearance/);
  assert.doesNotMatch(a.warnings[0], /twice|visitors too|standard browser headers/);
  // A repeated status changes nothing: there is no confirmation path.
  const again = assessStyling({ linked: 1, applied: 0, failures: [{ url: "https://s/missing.css", status: 404, outcome: "broken", confirmed: true }] });
  assert.equal(again.unreliable, true);
  assert.equal(again.confirmedBroken, undefined);
});

test("isAppearanceNote recognises styling and layout complaints", () => {
  assert.equal(isAppearanceNote({ title: "The Quality page appears unstyled on a phone", what: "plain blue links and bulleted navigation", category: "quality" }), true);
  assert.equal(isAppearanceNote({ title: "Contact tables run off the phone screen", what: "", category: "modernization" }), true);
  assert.equal(isAppearanceNote({ title: "The Events page still says Coming Soon", what: 'It says "Coming soon" under Events.', category: "quality" }), false);
  assert.equal(isAppearanceNote({ title: "The phone number is missing", what: "The contact page lists no phone number.", category: "quality" }), false);
});

test("noteRefusal blocks appearance notes only when styling is unreliable", () => {
  const unreliable = assessStyling({ linked: 1, applied: 0, failures: [{ url: "https://s/a.css", status: 202, outcome: "challenge", reason: "The site's hosting put a bot check in front of our checker" }] });
  const reliable = assessStyling({ linked: 1, applied: 1, failures: [] });
  const appearance = { title: "The page appears unstyled on a phone", what: "plain links", category: "modernization" };
  const content = { title: "The Events page still says Coming Soon", what: 'It says "Coming soon".', category: "quality" };
  assert.match(noteRefusal(unreliable, appearance), /did not fully load/);
  assert.equal(noteRefusal(reliable, appearance), null);
  assert.equal(noteRefusal(unreliable, content), null, "content notes are still allowed on an unstyled page");
});

test("classifyStylesheetResponse works from status and headers alone", () => {
  const sg = classifyStylesheetResponse({ url: "https://s/a.css", status: 202, contentType: "text/html", headers: { "set-cookie": "nevercache-b39818=Y;Max-Age=-1" } });
  assert.equal(sg.outcome, "challenge");
  const html202 = classifyStylesheetResponse({ url: "https://s/a.css", status: 202, contentType: "text/html", headers: {} });
  assert.equal(html202.outcome, "blocked", "an HTML answer without a known signature is a refusal, not proof of a check");
  assert.match(html202.reason, /instead of a stylesheet/);
});
