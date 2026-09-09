// challenge.js
// Recognise a hosting bot check ("challenge") from plain response values, so every part
// of the checker can tell "the site refused our checker" from "the site is broken".
//
// Why this exists: SiteGround's anti-bot layer answered the droplet's address with HTTP 202
// and a tiny HTML page that refreshes to /.well-known/sgcaptcha/ for EVERY path, including
// the page's stylesheet. A 202 counts as success everywhere status codes are compared, so
// the stylesheet was "loaded", the page rendered unstyled, and the browsing agent reported
// the site as broken. Cloudflare does the same with 403/503 and a "Just a moment" page.
//
// Inputs are plain values (status number, headers in any shape, the first bytes of the
// body) so fetch responses, Playwright responses, and stored records can all be checked.
//
// Integration hooks for the files this module does not own (see docs in
// /Users/admin/Documents/Codex/2026-09-09/can/work/mobile-implementation.md):
//   server/lib/http.js   classifyStatus() -> classifyResponse() here returns "challenge"
//                        for challenge answers, which callers should treat like "blocked"
//                        (never "broken", never "ok"). probeAddress() can pass the body start
//                        of small HTML answers.
//   server/pipeline.js   checks set facts.challenged = CHALLENGE_REASON; the pipeline should
//                        mirror it into report.engine.challenged (next to engine.throttled)
//                        and treat it as a shortened checkup, never as a clean result.

export const CHALLENGE_REASON = "The site's hosting put a bot check in front of our checker";

// Only small HTML answers can be challenges. Real pages and stylesheets are bigger or are
// not HTML at all.
const MAX_CHALLENGE_BODY = 8192;
const BROKEN_STATUSES = new Set([404, 410, 500, 502, 504]);

/**
 * Read one header from a fetch Headers object, a plain object (any case), a Playwright
 * headers() object, or nothing. Always returns a string.
 */
export function headerValue(headers, name) {
  if (!headers) return "";
  const want = String(name).toLowerCase();
  try {
    if (typeof headers.get === "function") return String(headers.get(want) || headers.get(name) || "");
  } catch {}
  if (typeof headers === "object") {
    for (const key of Object.keys(headers)) {
      if (String(key).toLowerCase() === want) {
        const v = headers[key];
        return Array.isArray(v) ? v.join(", ") : String(v == null ? "" : v);
      }
    }
  }
  return "";
}

function contentTypeOf(headers, explicit) {
  return String(explicit || headerValue(headers, "content-type") || "").toLowerCase();
}

function htmlLike(contentType) {
  // A missing content type is treated as possibly HTML; JSON, CSS, JS, images, fonts are not.
  if (!contentType) return true;
  return /text\/html|application\/xhtml/.test(contentType);
}

/**
 * Is this answer a bot check rather than the thing that was asked for?
 * @param {{status:number, headers?:any, contentType?:string, bodyStart?:string, url?:string}} r
 * @returns {null | { vendor: "siteground"|"cloudflare"|"generic", reason: string, detail: string }}
 */
/** Paths that are the bot check itself: landing on one of these is the challenge, whatever it answers. */
export const CHALLENGE_PATH_RE = /\/\.well-known\/sgcaptcha\/|\/cdn-cgi\/challenge-platform\/|\/cdn-cgi\/l\/chk_(?:jschl|captcha)/i;

/** Is this address the bot check page itself? Returns the same shape as isChallenge. */
export function isChallengeUrl(url) {
  const u = String(url || "");
  if (!CHALLENGE_PATH_RE.test(u)) return null;
  const vendor = /sgcaptcha/i.test(u) ? "siteground" : "cloudflare";
  return { vendor, reason: CHALLENGE_REASON, detail: `${vendor === "siteground" ? "SiteGround" : "Cloudflare"} bot check page (${u.replace(/[?#].*$/, "").slice(0, 80)})` };
}

export function isChallenge(r) {
  if (!r) return null;
  const byUrl = isChallengeUrl(r.url);
  if (byUrl) return byUrl;
  const status = Number(r.status) || 0;
  const headers = r.headers;
  const ctype = contentTypeOf(headers, r.contentType);
  const body = String(r.bodyStart || "");

  // Cloudflare says so in a header, whatever the body looks like.
  if (/^challenge$/i.test(headerValue(headers, "cf-mitigated").trim())) {
    return { vendor: "cloudflare", reason: CHALLENGE_REASON, detail: `Cloudflare challenge (status ${status}, cf-mitigated: challenge)` };
  }

  if (!htmlLike(ctype)) return null;
  if (body.length > MAX_CHALLENGE_BODY) return null;

  // SiteGround: a tiny page that refreshes to the sgcaptcha check. Seen with status 202.
  if (/\/\.well-known\/sgcaptcha\//i.test(body)) {
    return { vendor: "siteground", reason: CHALLENGE_REASON, detail: `SiteGround bot check (status ${status}, refresh to /.well-known/sgcaptcha/)` };
  }

  // Cloudflare without the header: the "Just a moment" interstitial.
  if ((status === 403 || status === 503) && /cf-chl|__cf_chl|challenge-platform|Just a moment\.\.\.|cf_chl_opt/i.test(body)) {
    return { vendor: "cloudflare", reason: CHALLENGE_REASON, detail: `Cloudflare challenge page (status ${status})` };
  }

  // Anything else: a small interstitial on a challenge-shaped status that refreshes to a
  // verification path or says it is checking the browser.
  if (status === 202 || status === 403 || status === 503) {
    if (body.length <= 4096) {
      const refreshTo = body.match(/http-equiv=["']?refresh["']?[^>]*content=["'][^"']*?;\s*(?:url=)?([^"'>\s]+)/i);
      if (refreshTo && /captcha|challenge|verif|bot|check|human/i.test(refreshTo[1])) {
        return { vendor: "generic", reason: CHALLENGE_REASON, detail: `bot check (status ${status}, refresh to ${refreshTo[1].slice(0, 80)})` };
      }
      if (/Checking (the site connection security|your browser|if the site connection is secure)|verify (that )?you are (a )?human|enable cookies to continue|requires cookies to be enabled|Please enable cookies/i.test(body)) {
        return { vendor: "generic", reason: CHALLENGE_REASON, detail: `bot check page (status ${status})` };
      }
    }
  }
  return null;
}

/**
 * The shared status rule plus challenge awareness.
 *   ok         2xx or 3xx that is not a challenge
 *   broken     404, 410, 500, 502, 504 (the address really fails)
 *   blocked    401, 403, 405, 406, 429, 503 and any other 4xx/5xx (our checker was refused)
 *   challenge  a bot check stood in for the answer (treat like blocked; never broken, never ok)
 */
export function classifyResponse(r) {
  const c = isChallenge(r);
  if (c) return "challenge";
  const n = Number(r && r.status) || 0;
  if (n >= 200 && n < 400) return "ok";
  if (BROKEN_STATUSES.has(n)) return "broken";
  return "blocked";
}
