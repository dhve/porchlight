// browser.js
// Step 4 (optional): the real "acts like a customer" pass. When Playwright is
// available (local Chromium, or a hosted browser through lib/browserConnect.js),
// we load the homepage in a real browser and watch what a visitor's browser
// would experience: JavaScript errors, how long the page takes to appear, files
// the page asks for that fail, and images that fail at render time.
//
// Accuracy rules (shared with the links check, see docs/CONTRACTS.md):
//   BROKEN   404, 410, 500, 502, 504, and connection errors that are not
//            timeouts (no such host, refused, reset, closed, certificate).
//            Reported only when a second request from a browser context that
//            identifies as a standard desktop Chrome answers the same way, so
//            the links check and this one agree on what "broken" means.
//   BLOCKED  401, 403, 405, 406, 429, 503. The site refused OUR checker. Each
//            one is requested once more from the standard Chrome context. If
//            it loads then, it works and is not reported. If it is still
//            refused, it is "not testable" and is not reported either.
//   429      The site is limiting us. We set ctx.facts.throttled and report
//            nothing for those addresses. If the homepage itself answers 429
//            the whole pass is skipped.
//   Timeouts, aborts, and other inconclusive failures are never reported.
//
// Read-only: we navigate and observe. We do not submit forms or click through
// checkout, so nothing on the site is changed.

import { openBrowser, browserMode as configuredBrowserMode } from "../lib/browserConnect.js";

export const CHROME_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";
const BOT_USER_AGENT = "SutrosBot/0.1 (+https://sutros.org)";
const PHONE = { width: 390, height: 844 }; // a typical phone

const BROKEN_STATUSES = new Set([404, 410, 500, 502, 504]);
const BLOCKED_STATUSES = new Set([401, 403, 405, 406, 429, 503]);
const NAV_TIMEOUT_MS = 15_000;
const RETRY_TIMEOUT_MS = 8_000;
const RETRY_GAP_MS = 200;
const MAX_RETRIES = 16; // bounded so a page with hundreds of failing files cannot turn into a flood
const RETRY_BUDGET_MS = 20_000; // and bounded in time, so a slow host cannot stall the checkup
const MAX_ITEMS = 12;

export async function runBrowser(ctx) {
  const { facts } = ctx;
  const findings = [];
  const passes = [];
  const homepage = String((facts.finalUrl && facts.finalUrl.href) || facts.finalUrl || (ctx.url && ctx.url.href) || "");
  const siteHost = hostOf(homepage);

  let session;
  try {
    session = await openBrowser({ purpose: "visitor" });
  } catch (err) {
    const browserMode = safeMode();
    if (err && err.code === "NO_PLAYWRIGHT") {
      return { findings, passes, skipped: true, reason: "Playwright not installed (run: npm run enable-browser)", browserMode };
    }
    return { findings, passes, skipped: true, reason: `Browser unavailable: ${String((err && err.message) || err).slice(0, 120)}`, browserMode };
  }
  const { browser, mode: browserMode, close } = session;

  try {
    // The site already told another check to slow down: give it a moment before we knock again.
    if (facts.throttled) await sleep(3000);

    const botContext = await browser.newContext({ userAgent: BOT_USER_AGENT, viewport: PHONE, acceptDownloads: false });
    let chromeContext = null;
    const asChrome = async () => {
      if (!chromeContext) {
        chromeContext = await browser.newContext({
          userAgent: CHROME_USER_AGENT,
          viewport: PHONE,
          acceptDownloads: false,
          extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
        });
      }
      return chromeContext;
    };
    const markLimited = (url) => {
      if (sameSite(url, siteHost)) facts.throttled = true;
    };

    // ---- load the homepage as our honest bot identity ----
    let obs = await observe(botContext, homepage);
    if (obs.mainStatus === 429) {
      facts.throttled = true;
      return { findings, passes, skipped: true, reason: "The site limited our checker", browserMode };
    }
    if (BLOCKED_STATUSES.has(obs.mainStatus)) {
      // The site refused our checker's identity. Give it the pause it asked for
      // (Retry-After, at most 5 s, else 1.5 s), then ask once more as a standard browser.
      await obs.page.close().catch(() => {});
      const asked = (obs.failed.get(obs.mainUrl) || obs.failed.get(homepage) || {}).retryAfterMs;
      await sleep(asked ? Math.min(asked, 5000) : 1500);
      obs = await observe(await asChrome(), homepage);
      if (obs.mainStatus === 429) {
        facts.throttled = true;
        return { findings, passes, skipped: true, reason: "The site limited our checker", browserMode };
      }
      if (BLOCKED_STATUSES.has(obs.mainStatus)) {
        return { findings, passes, skipped: true, reason: "The site refused our checker", browserMode };
      }
    }
    const { page, mainStatus, mainUrl, loadMs, consoleErrors, failed, responses } = obs;
    const mainOk = mainStatus > 0 && mainStatus < 400;
    const isMainDocument = (u) => u === homepage || u === mainUrl;

    // Images with no rendered content, checked in the page itself. SVGs are left out
    // because a vector image without a declared size can report a natural width of 0.
    const brokenImages = await page.evaluate(() =>
      Array.from(document.images)
        .filter((img) => img.complete && img.naturalWidth === 0 && img.naturalHeight === 0)
        .map((img) => ({ src: img.currentSrc || img.src || "", alt: (img.getAttribute("alt") || "").trim().slice(0, 60) }))
        .filter((i) => /^https?:\/\//i.test(i.src) && !/\.svg(\?|#|$)/i.test(i.src))
        .slice(0, 40)
    ).catch(() => []);

    await page.close().catch(() => {});

    // Errors caused by our headless environment, not by the site, and errors thrown inside
    // other companies' scripts are not the site's code failing, so they are set aside.
    const ENV_NOISE = /geolocation|GeolocationPositionError|User denied|permission (?:was )?denied|NotAllowedError|play\(\) (?:failed|request was interrupted)|autoplay|AudioContext was not allowed|Notification permission|ResizeObserver loop|ERR_BLOCKED_BY_CLIENT|net::ERR_|\[Violation\]|Tracking Prevention|third-party cookie/i;
    for (let i = consoleErrors.length - 1; i >= 0; i--) {
      const e = consoleErrors[i];
      const thirdParty = e.url && !sameSite(e.url, siteHost);
      if (ENV_NOISE.test(e.text) || thirdParty) consoleErrors.splice(i, 1);
    }

    // ---- sort every failed request into broken / blocked for bots / not testable / limited ----
    // The homepage document itself is not "a file the homepage asked for"; the recon step
    // already speaks to how the homepage answered.
    const failedList = [...failed.entries()]
      .filter(([u]) => !isMainDocument(u) && !/\/favicon\.ico$/i.test(u))
      .map(([url, f]) => ({ url, ...f }));

    const broken = [];          // reported
    const dropped = new Set();  // addresses we decided not to report, whatever the reason
    let blockedForBots = 0;     // failed for our bot identity, fine for a standard browser
    let untestable = 0;         // still refused after the retry, or never retried
    let limited = 0;            // 429s
    let retries = 0;
    let waited = false;
    const retryStart = Date.now();
    const limitedByHost = new Map();

    for (const f of failedList) {
      const cls = classify(f);
      if (cls === "limited") {
        limited++;
        dropped.add(f.url);
        markLimited(f.url);
        bump(limitedByHost, hostOf(f.url));
        continue;
      }
      if (cls === "inconclusive") { dropped.add(f.url); continue; }

      // Every error answer gets one more look as a standard browser, the same way the links
      // check does. An address counts as broken only when the second answer agrees, and a
      // refusal that turns into a normal answer means the site only refused our checker.
      const host = hostOf(f.url);
      const canRetry = retries < MAX_RETRIES && Date.now() - retryStart < RETRY_BUDGET_MS && (limitedByHost.get(host) || 0) < 2;
      if (!canRetry) {
        // No second look possible. A definite error answer or a failed connection that the
        // browser saw directly still stands; a refusal does not.
        if (cls === "broken") broken.push(f); else { untestable++; dropped.add(f.url); }
        continue;
      }
      if (cls === "blocked" && !waited) {
        // Give the site the pause it asked for (Retry-After, at most 5 s), else a short breath.
        const ask = failedList.map((x) => x.retryAfterMs || 0).reduce((a, b) => Math.max(a, b), 0);
        await sleep(ask ? Math.min(ask, 5000) : 1500);
        waited = true;
      } else if (retries > 0) {
        await sleep(RETRY_GAP_MS);
      }
      retries++;
      const again = await fetchAsChrome(await asChrome(), f.url);
      if (again && again.status >= 200 && again.status < 400) { blockedForBots++; dropped.add(f.url); continue; }
      if (again && again.status === 429) {
        limited++;
        dropped.add(f.url);
        markLimited(f.url);
        bump(limitedByHost, host);
        continue;
      }
      if (again && BROKEN_STATUSES.has(again.status)) { broken.push({ ...f, status: again.status, reason: statusText(again.status) }); continue; }
      if (!again && cls === "broken") { broken.push(f); continue; } // still cannot load as a standard browser
      untestable++;
      dropped.add(f.url);
    }

    // Everything the homepage asked for, leaving out the homepage document itself and the favicon.
    const tested = [...new Set([...responses.keys(), ...failedList.map((f) => f.url)])]
      .filter((u) => !isMainDocument(u) && !/\/favicon\.ico$/i.test(u)).length;
    const couldNotTest = untestable + limited;
    const loaded = Math.max(0, tested - couldNotTest);
    const pages = [homepage];

    // ---- findings ----
    if (broken.length) {
      const shown = broken.slice(0, 6);
      findings.push({
        id: "failed-resources",
        category: "quality",
        severity: "watch",
        title: `${broken.length} file${broken.length > 1 ? "s" : ""} on your homepage fail${broken.length > 1 ? "" : "s"} to load`,
        meaning:
          "When the homepage loads, it asks for these files and the server cannot find them or fails while sending them. Whatever each file provides (a script, image, font, or stylesheet) is missing for visitors. The exact address and status of each one is under the technical proof. Every file that failed was requested once more as a standard browser, and only the ones that failed again are listed here.",
        fix: [
          "Open each address listed. A 404 or 410 means the file was moved or deleted: fix the link or restore the file.",
          "A 500, 502, or 504 means the server failed while sending the file: ask the host or the web person to look at the server logs.",
          "A file that could not be reached at all means its address is wrong or the server it lives on is not answering.",
          "Remove any reference the page no longer needs.",
        ],
        who: "Your web person.",
        evidence: {
          lines: shown.map((f) => `${f.status ? f.status + " " + f.reason : "did not load (" + f.reason + ")"}  ${f.url.slice(0, 140)}`),
          note: [
            `${broken.length} broken of ${tested} file${tested === 1 ? "" : "s"} the homepage asked for.`,
            blockedForBots ? `${blockedForBots} loaded once we asked as a standard browser and ${blockedForBots === 1 ? "is" : "are"} not listed.` : "",
            couldNotTest ? `${couldNotTest} could not be tested because the site limited our checker.` : "",
          ].filter(Boolean).join(" "),
          method:
            "We opened the homepage in a real browser and recorded every file it asked for and the status the server answered with. Each file that failed was requested once more with a standard Chrome identity, and it is listed only when that second request also answered 404, 410, 500, 502, or 504, or the connection itself failed again.",
          pages,
          items: broken.slice(0, MAX_ITEMS).map((f) => ({ url: f.url, status: f.status, statusText: f.reason, page: homepage, kind: "resource" })),
        },
      });
    } else if (mainOk && loaded > 0) {
      let text = `The ${loaded} file${loaded === 1 ? "" : "s"} the homepage asked for ${loaded === 1 ? "loaded" : "all loaded"} in a real browser`;
      if (couldNotTest) text += `, ${couldNotTest} could not be tested because the site limited our checker`;
      passes.push(text + ".");
    }

    if (consoleErrors.length) {
      // Scripts the errors came from, leaving out the homepage itself (inline scripts), which is already the page item.
      const scriptUrls = [...new Set(consoleErrors.map((e) => e.url).filter((u) => u && !isMainDocument(u) && responses.has(u)))].slice(0, 5);
      findings.push({
        id: "console-errors",
        category: "quality",
        severity: "watch",
        title: "Your website's code is reporting errors in visitors' browsers",
        meaning:
          "As the page loaded, its own scripts reported errors (each one is listed with the file and line it came from). Visitors do not see the messages, but errors like these are often why a menu, form, or button quietly stops working.",
        fix: ["Show your web person the errors under the technical proof; each names the script and line that failed."],
        who: "Your web person.",
        evidence: {
          lines: [...new Set(consoleErrors.map((e) => e.text))].slice(0, 5),
          note: `${consoleErrors.length} JavaScript error(s) seen while loading the homepage.`,
          method:
            "We opened the homepage in a real browser and recorded every JavaScript error the page's own scripts reported while it loaded, with the file and line each came from.",
          pages,
          items: [
            { url: homepage, status: mainStatus, statusText: statusText(mainStatus), page: homepage, kind: "page" },
            ...scriptUrls.map((u) => ({ url: u, status: responses.get(u), statusText: statusText(responses.get(u)), page: homepage, kind: "resource" })),
          ],
        },
      });
    } else if (mainOk) {
      passes.push("The homepage loaded with no JavaScript errors.");
    }

    if (loadMs > 5000) {
      findings.push({
        id: "slow-load",
        category: "performance",
        severity: "watch",
        title: "Your site is slow to load on a phone",
        meaning: `Your homepage took about ${(loadMs / 1000).toFixed(1)} seconds to appear on a phone-sized screen. Many visitors leave after three. Oversized images are the usual cause.`,
        fix: ["Compress your largest images, or ask your web person to add an image optimizer."],
        who: "Your web person; free tools can automate it.",
        evidence: {
          lines: [`homepage load: ${(loadMs / 1000).toFixed(1)}s on a simulated phone`],
          note: "Measured in a headless browser.",
          method:
            "We opened the homepage in a real browser with a phone sized screen and measured the time from the request until the browser reported the page fully loaded.",
          pages,
          items: [{ url: homepage, status: mainStatus, statusText: statusText(mainStatus), page: homepage, kind: "page" }],
        },
      });
    } else if (loadMs) {
      passes.push(`Your homepage loaded in about ${(loadMs / 1000).toFixed(1)}s on a phone.`);
    }

    const renderBroken = brokenImages.filter((i) => !dropped.has(i.src));
    if (renderBroken.length) {
      const n = renderBroken.length;
      findings.push({
        id: "broken-images-render",
        category: "quality",
        severity: "watch",
        title: `${n} image${n > 1 ? "s" : ""} failed to display`,
        meaning: "Some images failed to render when the page actually loaded, so visitors see blank spaces or broken-image icons.",
        fix: ["Re-upload the affected images or fix the links to them."],
        who: "You can often do this yourself.",
        evidence: {
          lines: renderBroken.slice(0, 6).map((i) => {
            const st = imageStatus(i.src, responses, failed);
            return `${st.status ? st.status + " " + st.statusText : "did not load (" + st.statusText + ")"}  ${i.src.slice(0, 140)}`;
          }),
          note: `${n} image(s) with no rendered content. Observed in a headless browser.`,
          method:
            "We opened the homepage in a real browser, waited for it to finish loading, and checked each image on the page for rendered content. Images whose file failed to load were requested once more with a standard Chrome identity, and any that loaded then are not counted.",
          pages,
          items: renderBroken.slice(0, MAX_ITEMS).map((i) => {
            const st = imageStatus(i.src, responses, failed);
            const item = { url: i.src, status: st.status, statusText: st.statusText, page: homepage, kind: "image" };
            if (i.alt) item.text = i.alt;
            return item;
          }),
        },
      });
    }

    return { findings, passes, browserMode };
  } catch (err) {
    return { findings, passes, skipped: true, reason: `Browser pass failed: ${String((err && err.message) || err).slice(0, 120)}`, browserMode };
  } finally {
    try { await close(); } catch {}
  }
}

/** The configured browser mode, for the skipped result when no browser could be opened. */
function safeMode() {
  try { return configuredBrowserMode(); } catch { return "local"; }
}

/**
 * Open one page in the given context, load the homepage, and collect what a
 * visitor's browser would see: the main document status, load time, JavaScript
 * errors (with where they came from), every response status, and every failed
 * request.
 */
async function observe(context, url) {
  const page = await context.newPage();
  page.on("dialog", (d) => d.dismiss().catch(() => {}));

  const consoleErrors = []; // { text, url }
  const failed = new Map();  // url -> { status, reason, errorText, retryAfterMs }
  const responses = new Map(); // url -> status, every response we saw

  page.on("pageerror", (err) => {
    const frame = (String(err.stack || "").split("\n").find((l) => /\(?https?:\/\/[^)]+:\d+:\d+\)?/.test(l)) || "").trim();
    const where = frame ? ` (at ${frame.replace(/^at\s+/, "").slice(0, 120)})` : "";
    const m = frame.match(/(https?:\/\/[^\s()]+?):\d+:\d+/);
    consoleErrors.push({ text: (String(err.message).slice(0, 160) + where).slice(0, 260), url: m ? m[1] : "" });
  });
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (/^Failed to load resource/i.test(text)) return; // captured below with its URL
    const loc = msg.location && msg.location();
    const where = loc && loc.url ? ` (at ${loc.url}${loc.lineNumber ? ":" + loc.lineNumber : ""})` : "";
    consoleErrors.push({ text: (text.slice(0, 160) + where).slice(0, 260), url: loc && loc.url ? loc.url : "" });
  });
  page.on("response", (res) => {
    const u = res.url();
    const st = res.status();
    if (!responses.has(u)) responses.set(u, st);
    if (st >= 400 && !failed.has(u)) {
      let retryAfterMs = null;
      try {
        const ra = res.headers()["retry-after"];
        if (ra && /^\d+$/.test(ra.trim())) retryAfterMs = Number(ra.trim()) * 1000;
      } catch {}
      failed.set(u, { status: st, reason: statusText(st), errorText: "", retryAfterMs });
    }
  });
  page.on("requestfailed", (req) => {
    const u = req.url();
    if (failed.has(u) || responses.has(u)) return;
    const errorText = (req.failure() && req.failure().errorText) || "";
    failed.set(u, { status: 0, reason: failureWords(errorText), errorText, retryAfterMs: null });
  });

  const start = Date.now();
  const mainRes = await page.goto(url, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
  const loadMs = Date.now() - start;
  const mainStatus = mainRes ? mainRes.status() : 0;
  const mainUrl = mainRes ? mainRes.url() : url;

  return { page, mainStatus, mainUrl, loadMs, consoleErrors, failed, responses };
}

/** One GET from the standard-browser context. Resolves { status } or null when the request itself failed. */
async function fetchAsChrome(context, url) {
  try {
    const res = await context.request.get(url, { timeout: RETRY_TIMEOUT_MS, maxRedirects: 5, failOnStatusCode: false });
    const status = res.status();
    await res.dispose().catch(() => {});
    return { status };
  } catch {
    return null;
  }
}

/** "broken" | "blocked" | "limited" | "inconclusive" for one failed request. */
function classify(f) {
  if (f.status === 429) return "limited";
  if (f.status) {
    // Any 4xx/5xx outside the broken list (401, 403, 408, 501 ...) can only be judged by the
    // retry as a standard browser, and is never reported as is.
    return BROKEN_STATUSES.has(f.status) ? "broken" : "blocked";
  }
  // No answer at all. Only a failure we can name and stand behind counts as broken;
  // timeouts, aborts, and anything unfamiliar are inconclusive.
  if (!f.errorText || INCONCLUSIVE_RE.test(f.errorText)) return "inconclusive";
  return BROKEN_ERROR_RE.test(f.errorText) ? "broken" : "inconclusive";
}

const INCONCLUSIVE_RE = /ERR_ABORTED|TIMED_OUT|ERR_NETWORK_CHANGED|INSUFFICIENT_RESOURCES|NETWORK_IO_SUSPENDED|BLOCKED_BY_CLIENT|BLOCKED_BY_RESPONSE|BLOCKED_BY_ORB|BLOCKED_BY_PRIVATE_NETWORK|ERR_FAILED|ERR_CACHE|ERR_INVALID_URL|ERR_UNKNOWN_URL_SCHEME|ERR_HTTP_RESPONSE_CODE_FAILURE/i;
const BROKEN_ERROR_RE = /NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_CLOSED|EMPTY_RESPONSE|CONNECTION_ABORTED|ADDRESS_UNREACHABLE|ERR_CERT|ERR_SSL|BAD_SSL|TOO_MANY_REDIRECTS|INVALID_RESPONSE|INVALID_HTTP_RESPONSE|HTTP2_PROTOCOL_ERROR|INVALID_CHUNKED|CONTENT_LENGTH_MISMATCH|INCOMPLETE_CHUNKED/i;

/** Plain words for a Chromium network error. */
function failureWords(errorText) {
  const t = String(errorText || "");
  if (/NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|DNS/i.test(t)) return "address not found";
  if (/CONNECTION_REFUSED/i.test(t)) return "connection refused";
  if (/CONNECTION_RESET/i.test(t)) return "connection reset";
  if (/CONNECTION_CLOSED|EMPTY_RESPONSE|CONNECTION_ABORTED/i.test(t)) return "connection closed";
  if (/ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED|NETWORK_ACCESS_DENIED/i.test(t)) return "server unreachable";
  if (/ERR_CERT|ERR_SSL|BAD_SSL/i.test(t)) return "certificate problem";
  if (/TOO_MANY_REDIRECTS/i.test(t)) return "too many redirects";
  if (/INVALID_RESPONSE|INVALID_HTTP_RESPONSE|HTTP2_PROTOCOL_ERROR|INVALID_CHUNKED|CONTENT_LENGTH_MISMATCH|INCOMPLETE_CHUNKED/i.test(t)) return "bad response";
  if (/TIMED_OUT/i.test(t)) return "timed out";
  if (/ABORTED/i.test(t)) return "request cancelled";
  return "did not load";
}

function imageStatus(src, responses, failed) {
  if (failed.has(src)) {
    const f = failed.get(src);
    return { status: f.status, statusText: f.reason };
  }
  if (responses.has(src)) return { status: responses.get(src), statusText: statusText(responses.get(src)) };
  return { status: 0, statusText: "did not load" };
}

function statusText(code) {
  const map = {
    200: "OK", 201: "Created", 204: "No Content", 301: "Moved Permanently", 302: "Found", 303: "See Other", 304: "Not Modified",
    307: "Temporary Redirect", 308: "Permanent Redirect", 400: "Bad Request", 401: "Unauthorized", 402: "Payment Required",
    403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 406: "Not Acceptable", 407: "Proxy Authentication Required",
    408: "Request Timeout", 409: "Conflict", 410: "Gone", 411: "Length Required", 412: "Precondition Failed", 413: "Payload Too Large",
    414: "URI Too Long", 415: "Unsupported Media Type", 416: "Range Not Satisfiable", 417: "Expectation Failed", 421: "Misdirected Request",
    422: "Unprocessable Content", 423: "Locked", 424: "Failed Dependency", 425: "Too Early", 426: "Upgrade Required",
    428: "Precondition Required", 429: "Too Many Requests", 431: "Request Header Fields Too Large", 451: "Unavailable For Legal Reasons",
    500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
    505: "HTTP Version Not Supported", 507: "Insufficient Storage", 508: "Loop Detected", 511: "Network Authentication Required",
  };
  if (!code) return "did not load";
  if (map[code]) return map[code];
  if (code >= 500) return "Server Error";
  if (code >= 400) return "Error";
  if (code >= 300) return "Redirect";
  return "OK";
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

/** True when the address belongs to the site being checked (same host or a subdomain either way). */
function sameSite(url, siteHost) {
  const h = hostOf(url);
  if (!h || !siteHost) return false;
  return h === siteHost || h.endsWith("." + siteHost) || siteHost.endsWith("." + h);
}

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
