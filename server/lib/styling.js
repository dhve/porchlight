// styling.js
// Did the page's stylesheets actually load for OUR browser? If not, the way the page looks
// says nothing about the site, and no appearance judgement may be made from it.
//
// Pure functions over plain values so they can be tested without a browser. Used by the
// browsing agent (agentBrowse.js) and the proof pictures (proof.js).

import { isChallenge, CHALLENGE_REASON } from "./challenge.js";

const BROKEN_STATUSES = new Set([404, 410, 500, 502, 504]);
const STATUS_TEXT = {
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
  406: "Not Acceptable", 408: "Request Timeout", 410: "Gone", 429: "Too Many Requests",
  500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
};

export function statusWords(status) {
  const n = Number(status) || 0;
  return STATUS_TEXT[n] || (n >= 500 ? "Server Error" : n >= 400 ? "Error" : n ? "OK" : "no answer");
}

function pathOf(url) {
  try {
    const u = new URL(url);
    return (u.pathname + u.search).slice(0, 120) || "/";
  } catch {
    return String(url || "").slice(0, 120);
  }
}

/**
 * Sort one stylesheet answer into an outcome.
 *   ok         2xx with a CSS content type (or none stated)
 *   broken     404, 410, 500, 502, 504: the address itself fails
 *   blocked    refused (401/403/405/406/429/503...), or a 2xx whose body is not CSS at all
 *   challenge  a hosting bot check answered instead of the stylesheet
 *   failed     the request never completed (network error, timeout, abort)
 * @returns {{ url, status, contentType, outcome, reason, errorText }}
 */
export function classifyStylesheetResponse({ url, status, contentType = "", headers, bodyStart = "", errorText = "" }) {
  const entry = { url: String(url || ""), status: Number(status) || 0, contentType: String(contentType || "").toLowerCase(), outcome: "ok", reason: "", errorText: String(errorText || "") };
  if (entry.errorText || (!entry.status && !entry.contentType)) {
    entry.outcome = "failed";
    if (/ERR_BLOCKED_BY_ORB|ERR_BLOCKED_BY_RESPONSE/i.test(entry.errorText)) entry.reason = "the browser refused an answer from that host that was not a stylesheet";
    else entry.reason = entry.errorText ? `the request failed (${entry.errorText.replace(/^net::/, "")})` : "the request never completed";
    return entry;
  }
  const c = isChallenge({ status: entry.status, headers, contentType: entry.contentType, bodyStart });
  if (c) {
    entry.outcome = "challenge";
    entry.reason = c.reason;
    entry.detail = c.detail;
    return entry;
  }
  if (entry.status >= 200 && entry.status < 400) {
    if (entry.contentType && !/text\/css/.test(entry.contentType)) {
      entry.outcome = "blocked";
      entry.reason = `the server answered with ${entry.contentType.split(";")[0]} instead of a stylesheet`;
      return entry;
    }
    return entry;
  }
  if (BROKEN_STATUSES.has(entry.status)) {
    entry.outcome = "broken";
    entry.reason = `answered ${entry.status} ${statusWords(entry.status)}`;
    return entry;
  }
  entry.outcome = "blocked";
  entry.reason = `the server refused the request (${entry.status} ${statusWords(entry.status)})`;
  return entry;
}

/**
 * Judge whether the page's appearance can be trusted.
 * @param {{ linked:number, applied:number, failures:Array<object> }} p
 *   linked   how many stylesheets the page meant to apply (enabled, not alternate)
 *   applied  how many of them have a loaded sheet
 *   failures stylesheet entries from classifyStylesheetResponse whose outcome is not "ok"
 * @returns {{ unreliable:boolean, warnings:string[], reason:string }}
 *
 * Any stylesheet that did not arrive for OUR browser makes the appearance inconclusive: a
 * bot check, a refusal, a network failure, and a 404 alike. Repeating the request from the
 * same address would not show what visitors see, so nothing here ever claims that a page
 * looks unstyled for them; the observed status is recorded as evidence and no more.
 */
export function assessStyling({ linked = 0, applied = 0, failures = [] } = {}) {
  const warnings = [];
  let unreliable = false;
  let reason = "";
  const list = Array.isArray(failures) ? failures.filter((f) => f && f.outcome && f.outcome !== "ok") : [];

  for (const f of list.slice(0, 3)) {
    const path = pathOf(f.url);
    unreliable = true;
    if (f.outcome === "broken") {
      reason = reason || `a stylesheet answered ${f.status} ${statusWords(f.status)} for our browser`;
      warnings.push(`The page's stylesheet ${path} answered ${f.status} ${statusWords(f.status)} when our browser asked for it, so the page may not look the way it does for visitors. Do not judge its appearance.`);
      continue;
    }
    const why = f.outcome === "challenge" ? (f.reason || CHALLENGE_REASON) : (f.reason || "it did not load");
    reason = reason || why;
    warnings.push(`The page's stylesheet ${path} did not load (${why}). The page looks unstyled for that reason, not because of its design. Do not judge its appearance.`);
  }

  if (linked > applied) {
    const known = new Set(list.map((f) => f.url));
    const unexplained = Math.max(0, linked - applied - list.filter((f) => known.has(f.url)).length);
    if (!list.length || unexplained > 0) {
      unreliable = true;
      const missing = list.length ? unexplained : linked - applied;
      reason = reason || "a stylesheet had not loaded when we looked";
      warnings.push(`${missing} of ${linked} stylesheet${linked === 1 ? "" : "s"} had not loaded when we looked, so the page may not look the way it does for visitors. Do not judge its appearance.`);
    }
  }

  return { unreliable, warnings, reason };
}

const APPEARANCE_RE = /unstyled|no styl|styl(?:e|es|ing) (?:is |are )?(?:missing|gone|not load)|plain (?:blue )?(?:links|text|list)|missing (?:styles?|layout|colou?rs?|design|logo|branding|formatting)|default (?:font|fonts|links|styling|browser style)|looks? (?:broken|plain|bare|unfinished|like raw)|blank (?:area|space|page|block)|no (?:colou?rs?|layout|formatting|design|css)|not styled|raw html|bulleted (?:nav|menu|links|navigation)|layout (?:is )?(?:broken|missing|gone)|cut off|overlap|run[s]? off (?:the )?(?:phone )?screen|wider than the (?:phone )?screen|tiny text|unreadable/i;

/** Is this note about how the page looks, rather than what it says or does? */
export function isAppearanceNote({ title = "", what = "", category = "" } = {}) {
  if (String(category).toLowerCase() === "modernization") return true;
  return APPEARANCE_RE.test(`${title} ${what}`);
}

/**
 * The deterministic gate: when the page did not fully render for our browser, an
 * appearance note is refused with the measured reason. Returns null when the note may
 * be recorded.
 */
export function noteRefusal(assessment, note) {
  if (!assessment || !assessment.unreliable) return null;
  if (!isAppearanceNote(note)) return null;
  const why = (assessment.warnings && assessment.warnings[0]) || assessment.reason || "a stylesheet did not load";
  return `That page did not fully load for our checker (${why.replace(/\s*Do not judge its appearance\.$/, "")}). Its appearance cannot be judged, so this note was not recorded. Note only things you saw work or fail on the page itself, and move on.`;
}
