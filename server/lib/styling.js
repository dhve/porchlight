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
    entry.reason = entry.errorText ? `the request failed (${entry.errorText.replace(/^net::/, "")})` : "the request never completed";
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
 *   linked   how many <link rel="stylesheet"> the page has
 *   applied  how many of them have a loaded sheet
 *   failures stylesheet entries from classifyStylesheetResponse whose outcome is not "ok";
 *            a "broken" entry may carry confirmed: true when an independent retry with
 *            standard browser headers answered the same way
 * @returns {{ unreliable:boolean, confirmedBroken:object[], warnings:string[], reason:string }}
 */
export function assessStyling({ linked = 0, applied = 0, failures = [] } = {}) {
  const warnings = [];
  const confirmedBroken = [];
  let unreliable = false;
  let reason = "";
  const list = Array.isArray(failures) ? failures.filter((f) => f && f.outcome && f.outcome !== "ok") : [];

  for (const f of list.slice(0, 3)) {
    const path = pathOf(f.url);
    if (f.outcome === "broken") {
      if (f.confirmed === true) {
        confirmedBroken.push(f);
        warnings.push(`The page's stylesheet ${path} answered ${f.status} ${statusWords(f.status)} twice, including once with standard browser headers, so the page looks unstyled for visitors too.`);
      } else {
        unreliable = true;
        reason = reason || "a stylesheet failed once and that is not confirmed";
        warnings.push(`The page's stylesheet ${path} answered ${f.status} ${statusWords(f.status)} once, which is not confirmed, so the page may not look the way it does for visitors. Do not judge its appearance.`);
      }
      continue;
    }
    unreliable = true;
    const why = f.outcome === "challenge" ? (f.reason || CHALLENGE_REASON) : (f.reason || "it did not load");
    reason = reason || why;
    warnings.push(`The page's stylesheet ${path} did not load (${why}). The page looks unstyled for that reason, not because of its design. Do not judge its appearance.`);
  }

  const known = new Set(list.map((f) => f.url));
  const unexplained = Math.max(0, linked - applied - list.filter((f) => known.has(f.url)).length);
  if (!list.length && linked > applied) {
    unreliable = true;
    reason = reason || "a stylesheet had not loaded when we looked";
    const missing = linked - applied;
    warnings.push(`${missing} of ${linked} stylesheet${linked === 1 ? "" : "s"} had not loaded when we looked, so the page may not look the way it does for visitors. Do not judge its appearance.`);
  } else if (unexplained > 0 && !unreliable) {
    unreliable = true;
    reason = reason || "a stylesheet had not loaded when we looked";
    warnings.push(`${unexplained} of ${linked} stylesheet${linked === 1 ? "" : "s"} had not loaded when we looked, so the page may not look the way it does for visitors. Do not judge its appearance.`);
  }

  return { unreliable, confirmedBroken, warnings, reason };
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
