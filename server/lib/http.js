// http.js
// A small, polite HTTP client used by every check, plus the shared rules for
// reading a site's answers honestly.
//  - identifies itself with an honest user agent (or, on a retry, with the
//    headers a normal browser sends, so a site that only blocks bots is not
//    reported as broken)
//  - enforces a per-request timeout
//  - enforces a per-checkup request budget so a scan can never flood a site
//  - never follows redirects into private space (each hop is re-validated by
//    the caller when it matters; here we simply cap redirects)
//
// Status rules (shared with every check that interprets a status):
//   BROKEN       404, 410, 500, 502, 504, and connection failures that are not
//                timeouts (no such host, refused, reset). A refused or reset
//                connection gets one more try first, since servers close idle
//                keep-alive sockets and that looks like a reset on our side.
//   BLOCKED      401, 403, 405, 406, 429, 503, and any 4xx/5xx that turns into
//                2xx/3xx when we ask again with standard browser headers
//   INCONCLUSIVE timeouts, aborts, and the request budget being reached

import { config, normalizeUrl, resolveTarget } from "../safety.js";

export const USER_AGENT =
  "SutrosBot/0.1 (+https://sutros.org; friendly website checkup)";

/** A current Chrome desktop user agent, used only for the second try of an address the site refused. */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const BOT_HEADERS = {
  "User-Agent": USER_AGENT,
  Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
};

const BROWSER_HEADERS = {
  "User-Agent": BROWSER_USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "Accept-Language": "en-US,en;q=0.9",
};

export function createClient() {
  let used = 0;
  let throttle = null; // the most recent 429 we were given: { at, retryAfterMs, url }

  /**
   * Make one request.
   * @param {string} url
   * @param {{ method?: string, headers?: object, browserLike?: boolean, timeoutMs?: number, redirect?: "follow"|"manual" }} opts
   *   browserLike: send the headers a normal Chrome desktop browser sends.
   *   headers: extra headers, layered on top of the defaults.
   *   timeoutMs: per-request timeout (defaults to config.requestTimeoutMs).
   *   redirect: "follow" (default) or "manual" to get the 3xx answer itself,
   *   so a caller can re-check every hop before following it.
   */
  async function request(url, { method = "GET", headers = {}, browserLike = false, timeoutMs = config.requestTimeoutMs, redirect = "follow" } = {}) {
    if (used >= config.maxRequests) {
      const e = new Error("Request budget for this checkup was reached.");
      e.code = "BUDGET";
      throw e;
    }
    used++;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.max(1, Number(timeoutMs) || config.requestTimeoutMs));
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method,
        redirect: redirect === "manual" ? "manual" : "follow",
        signal: controller.signal,
        headers: { ...(browserLike ? BROWSER_HEADERS : BOT_HEADERS), ...headers },
      });
      if (res.status === 429) throttle = { at: Date.now(), retryAfterMs: parseRetryAfter(res.headers.get("retry-after")), url: String(url).slice(0, 200) };
      return {
        ok: res.ok,
        status: res.status,
        finalUrl: res.url,
        headers: res.headers,
        redirected: res.redirected,
        ms: Date.now() - started,
        contentType: res.headers.get("content-type") || "",
        retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
        async text(limitBytes = 600_000) {
          const buf = await res.arrayBuffer();
          const slice = buf.byteLength > limitBytes ? buf.slice(0, limitBytes) : buf;
          return new TextDecoder("utf-8").decode(slice);
        },
        /** Cancel the body stream so the connection is released without reading it. */
        discard() {
          try {
            const p = res.body && !res.bodyUsed ? res.body.cancel() : null;
            if (p && typeof p.catch === "function") p.catch(() => {});
          } catch {}
        },
      };
    } catch (err) {
      if (timedOut) {
        const e = new Error("The request timed out.");
        e.code = "TIMEOUT";
        e.name = "TimeoutError";
        throw e;
      }
      // Surface the low-level reason (ENOTFOUND, ECONNREFUSED, ...) so callers can classify it.
      if (err && !err.code) {
        const code = errorCode(err);
        if (code) {
          try { err.code = code; } catch {}
        }
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    request,
    get: (url, opts = {}) => request(url, { ...opts, method: "GET" }),
    head: (url, opts = {}) => request(url, { ...opts, method: "HEAD" }),
    used: () => used,
    /** The most recent 429 answer seen by this client, or null. */
    throttleInfo: () => throttle,
  };
}

/** Retry-After as milliseconds: seconds or an HTTP date. Null when absent or unreadable. */
export function parseRetryAfter(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return parseInt(s, 10) * 1000;
  const t = Date.parse(s);
  if (Number.isFinite(t)) return Math.max(0, t - Date.now());
  return null;
}

// ---------------------------------------------------------------------------
// Shared status rules

export const BROKEN_STATUSES = new Set([404, 410, 500, 502, 504]);
export const BLOCKED_STATUSES = new Set([401, 403, 405, 406, 429, 503]);

const STATUS_TEXT = {
  200: "OK", 201: "Created", 202: "Accepted", 204: "No Content", 206: "Partial Content",
  301: "Moved Permanently", 302: "Found", 303: "See Other", 304: "Not Modified", 307: "Temporary Redirect", 308: "Permanent Redirect",
  400: "Bad Request", 401: "Unauthorized", 402: "Payment Required", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
  406: "Not Acceptable", 408: "Request Timeout", 409: "Conflict", 410: "Gone", 412: "Precondition Failed", 413: "Content Too Large",
  414: "URI Too Long", 415: "Unsupported Media Type", 416: "Range Not Satisfiable", 418: "I'm a teapot", 422: "Unprocessable Content",
  423: "Locked", 429: "Too Many Requests", 451: "Unavailable For Legal Reasons",
  500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
  505: "HTTP Version Not Supported", 508: "Loop Detected", 520: "Unknown Error", 521: "Web Server Is Down", 522: "Connection Timed Out",
  523: "Origin Is Unreachable", 524: "A Timeout Occurred", 525: "SSL Handshake Failed", 526: "Invalid SSL Certificate",
};

/** Human words for a status code, always a string. */
export function statusText(code) {
  const n = Number(code);
  if (STATUS_TEXT[n]) return STATUS_TEXT[n];
  if (n >= 200 && n < 300) return "OK";
  if (n >= 300 && n < 400) return "Redirect";
  if (n >= 400 && n < 500) return "Client Error";
  if (n >= 500 && n < 600) return "Server Error";
  return "";
}

/** "ok" for 2xx/3xx, "broken" for the confirmed-broken set, "blocked" for everything else 4xx/5xx. */
export function classifyStatus(status) {
  const n = Number(status);
  if (n >= 200 && n < 400) return "ok";
  if (BROKEN_STATUSES.has(n)) return "broken";
  return "blocked";
}

/**
 * Read a thrown request error.
 * Returns { verdict: "broken"|"inconclusive", statusText, reason }.
 * Only connection failures that are not timeouts count as broken.
 */
export function classifyError(err) {
  const code = errorCode(err);
  const name = String((err && err.name) || "");
  if (code === "BUDGET") return { verdict: "inconclusive", statusText: "not tested", reason: "budget" };
  if (code === "TIMEOUT" || name === "TimeoutError" || name === "AbortError" || /TIMEOUT|ETIMEDOUT/i.test(code)) {
    return { verdict: "inconclusive", statusText: "timed out", reason: "timeout" };
  }
  if (/ENOTFOUND|EAI_AGAIN|EAI_NONAME|EAI_FAIL|EAI_NODATA/i.test(code)) return { verdict: "broken", statusText: "no such host", reason: "dns" };
  if (/ECONNREFUSED/i.test(code)) return { verdict: "broken", statusText: "connection refused", reason: "refused" };
  if (/ECONNRESET|EPIPE|UND_ERR_SOCKET/i.test(code)) return { verdict: "broken", statusText: "connection reset", reason: "reset" };
  return { verdict: "inconclusive", statusText: "did not load", reason: "unknown" };
}

/** The first system error code found on an error, its cause, or an AggregateError's members. */
function errorCode(err, depth = 0) {
  if (!err || depth > 4) return "";
  if (err.code) return String(err.code);
  if (err.cause) {
    const c = errorCode(err.cause, depth + 1);
    if (c) return c;
  }
  if (Array.isArray(err.errors)) {
    for (const e of err.errors) {
      const c = errorCode(e, depth + 1);
      if (c) return c;
    }
  }
  return "";
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** How long to wait before the browser-like retry: Retry-After (max 5 s), else 1.5 s. */
export function retryDelayMs(retryAfterMs) {
  if (retryAfterMs == null || !Number.isFinite(retryAfterMs)) return 1500;
  return Math.min(5000, Math.max(0, retryAfterMs));
}

/**
 * Per-check throttle guard. After `limit` answers of 429 from one host, the
 * check should stop asking; we mark facts.throttled so the report can say so.
 */
export function createThrottleGuard(facts, limit = 2) {
  const counts = new Map();
  let stopped = false;
  return {
    get stopped() {
      return stopped;
    },
    record(url, status) {
      if (Number(status) !== 429) return stopped;
      let host = "";
      try { host = new URL(url).hostname; } catch { host = String(url); }
      const n = (counts.get(host) || 0) + 1;
      counts.set(host, n);
      if (n >= limit) {
        stopped = true;
        if (facts && typeof facts === "object") facts.throttled = true;
      }
      return stopped;
    },
  };
}

/**
 * Test one address the honest way.
 *  1. HEAD (or GET when headFirst is false); 405/501 on HEAD means "use GET".
 *  2. 2xx/3xx: works. Otherwise wait (Retry-After, max 5 s, else 1.5 s for a
 *     blocked status) and GET once more with standard browser headers.
 *  3. If the retry is 2xx/3xx the address works. If it is 404/410/500/502/504
 *     it is broken. Anything else is blocked (the site refused our checker).
 * A refused or reset connection also gets the second try (servers close idle
 * keep-alive sockets, which looks like a reset on the next request); it is
 * broken only when the connection fails again. No such host is broken at
 * once. Timeouts, aborts, and the request budget are inconclusive.
 *
 * @returns {Promise<{ verdict: "ok"|"broken"|"blocked"|"inconclusive", status: number, statusText: string, retried: boolean, firstStatus: number|null, reason?: string }>}
 */
export async function probeAddress(client, url, { headFirst = true, throttle = null, pace = null } = {}) {
  async function send(method, opts = {}) {
    if (pace) await pace();
    let res;
    try {
      res = await (method === "HEAD" ? client.head(url, opts) : client.get(url, opts));
    } catch (err) {
      return { error: err };
    }
    try { if (res && typeof res.discard === "function") res.discard(); } catch {}
    if (throttle && res) throttle.record(url, res.status);
    return { res };
  }
  function fromError(err, retried, firstStatus) {
    const c = classifyError(err);
    return { verdict: c.verdict, status: 0, statusText: c.statusText, retried, firstStatus, reason: c.reason };
  }

  let first = await send(headFirst ? "HEAD" : "GET");
  if (!first.error && headFirst && (first.res.status === 405 || first.res.status === 501)) first = await send("GET");
  if (first.error) {
    const c = classifyError(first.error);
    const transient = c.verdict === "broken" && (c.reason === "refused" || c.reason === "reset");
    if (!transient || (throttle && throttle.stopped)) return fromError(first.error, false, null);
    await sleep(retryDelayMs(null));
    const again = await send("GET", { browserLike: true });
    if (again.error) return fromError(again.error, true, null);
    const status = again.res.status;
    const verdict = classifyStatus(status);
    return { verdict, status, statusText: statusText(status), retried: true, firstStatus: null, reason: verdict === "blocked" && throttle && throttle.stopped ? "throttled" : undefined };
  }

  const firstStatus = first.res.status;
  if (classifyStatus(firstStatus) === "ok") {
    return { verdict: "ok", status: firstStatus, statusText: statusText(firstStatus), retried: false, firstStatus };
  }
  if (throttle && throttle.stopped) {
    return { verdict: "blocked", status: firstStatus, statusText: statusText(firstStatus), retried: false, firstStatus, reason: "throttled" };
  }

  // A blocked status asked us to back off; a broken one just gets the second look.
  if (!BROKEN_STATUSES.has(firstStatus)) await sleep(retryDelayMs(first.res.retryAfterMs));
  const second = await send("GET", { browserLike: true });
  if (second.error) return fromError(second.error, true, firstStatus);

  const status = second.res.status;
  const verdict = classifyStatus(status);
  return { verdict, status, statusText: statusText(status), retried: true, firstStatus, reason: verdict === "blocked" && throttle && throttle.stopped ? "throttled" : undefined };
}

// Re-export the guards so checks can validate a URL before fetching it.
export { normalizeUrl, resolveTarget };
