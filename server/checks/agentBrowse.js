// agentBrowse.js
// The browsing agent: a language model with a real phone-sized browser
// explores this site read-only, the way a careful visitor would, and writes
// down what a visitor would run into. It is the last check of step 4.
//
// How it works
//   1. openBrowser() (lib/browserConnect.js) hands us a browser: a hosted one
//      when BROWSER_WS_ENDPOINT or Browserbase is configured, else local
//      Chromium. We make one context: 390x844, mobile Chrome User-Agent.
//   2. We load the homepage and give the model an observation: address,
//      title, status, the visible text, a numbered list of links and buttons,
//      warnings we measured, and a JPEG of the phone screen.
//   3. The model drives with six tools (open, click, back, scroll, note,
//      finish). Every tool call spends one step. The run stops at AGENT_STEPS
//      steps (default 12), AGENT_BUDGET_MS wall clock (default 90 s), six
//      notes, the model's finish call, or a 429 from the site.
//   4. Notes become findings with source "agent" and severity watch or minor.
//      They are shown in the report but never move the grade (scoring.js).
//
// Read-only, always. We never type, fill, or submit. Controls whose text
// looks like buy, pay, sign up, log in, send, submit, download, delete,
// accept, or agree are refused before they are tapped. Links to other
// websites, email addresses, phone numbers, scripts, and files are refused.
// The browser may only go to this site or one of its subdomains, on a
// standard port, at a public address: every top-level navigation is checked
// at the network layer and answered with an empty 204 when it fails that
// rule. Chromium follows server-side redirects without asking the route
// handler, so a redirect that lands somewhere else is caught right after
// from page.url() and undone with goBack. Downloads are refused and dialogs
// are dismissed.
//
// This module never throws. When it cannot run it returns
// { findings: [], passes: [], skipped: true, reason }.

import { openBrowser } from "../lib/browserConnect.js";
import { chatTools, llmEnabled, modelName } from "../llm.js";
import { resolveTarget } from "../safety.js";

export const MOBILE_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36";

const VIEWPORT = { width: 390, height: 844 };
const DEFAULT_STEPS = 12;
const DEFAULT_BUDGET_MS = 90_000;
const ACTION_TIMEOUT_MS = 10_000; // one browser action, including the short settle after it
const NAV_TIMEOUT_MS = 8_000;
const CLICK_TIMEOUT_MS = 6_000;
const OBSERVE_TIMEOUT_MS = 6_000; // reading the page and taking the screenshot, after the action
const MODEL_MAX_TOKENS = 6_000;
const MAX_NOTES = 6;
const SHOT_KEYS = ["s7", "s8", "s9"];
const TEXT_LIMIT = 3_500;
const MAX_CONTROLS = 40;
const OBS_JPEG_QUALITY = 50;
const SHOT_JPEG_QUALITY = 58;
const SHOT_JPEG_QUALITY_RETRY = 40;
const MAX_SHOT_BYTES = 350 * 1024;
const MAX_VISITED = 40;
const KEEP_IMAGES = 2; // screenshots kept in the conversation; older ones are dropped to save tokens
const SUMMARY_MAX = 400;
const TITLE_MAX = 70;

// Controls we never tap, judged by their visible text.
const DENY_RE =
  /\b(buy|pay|checkout|order|purchase|donate|subscribe|sign ?up|register|log ?in|sign ?in|delete|remove|cancel|unsubscribe|send|submit|apply|book|reserve|add to cart|confirm|accept|agree|download)\b/i;
// Addresses that would download a file instead of showing a page.
const FILE_RE =
  /\.(pdf|zip|gz|tgz|tar|rar|7z|dmg|exe|msi|pkg|apk|doc|docx|xls|xlsx|ppt|pptx|csv|mp3|mp4|m4a|mov|avi|wav|ics|vcf|epub|rtf)(\?|#|$)/i;

const METHOD =
  "Our browsing agent opened this page in a real browser on a phone-sized screen and read it the way a visitor would. It never typed or submitted anything.";
const WHO = "The owner or their web person.";
const NOTE_TEXT = "Seen by the browsing agent.";
const CAPTION = "What the browsing agent saw";
const CONFIRM = "Open the page listed on a phone and look for what is described above.";

const TOOLS = [
  tool("open", "Open a page on this site by address. A path like /contact works. Only pages on this site or its subdomains can be opened.", {
    url: { type: "string", description: "The address or path to open." },
  }, ["url"]),
  tool("click", "Tap one link or button from the latest observation, by its number n. Menu buttons are fine. Controls that would buy, pay, sign up, log in, send, submit, download, delete, accept, or agree are refused.", {
    n: { type: "integer", description: "The control number from the latest observation." },
  }, ["n"]),
  tool("back", "Go back to the previous page.", {}, []),
  tool("scroll", "Scroll the current page by most of one screen, then look again.", {
    direction: { type: "string", enum: ["down", "up"] },
  }, ["direction"]),
  tool("note", "Write down one thing a visitor would run into on this site. Only for things you actually saw on the screen. At most 6 notes in a run.", {
    title: { type: "string", description: "At most 70 characters. Says the thing plainly." },
    what: { type: "string", description: "1 to 3 sentences on what a visitor sees, with the exact text in quotes." },
    where: { type: "string", description: "The full address of the page where you saw it." },
    quote: { type: "string", description: "The exact text you saw, up to 200 characters. Leave empty for a layout problem with no text." },
    severity: { type: "string", enum: ["watch", "minor"], description: "watch when a visitor is stopped or misled, minor for a small annoyance." },
    category: { type: "string", enum: ["quality", "modernization"], description: "modernization for phone layout and display problems, quality for everything else." },
    why: { type: "string", description: "One sentence on why it matters to a visitor." },
    fix: { type: "string", description: "One practical sentence on what to change." },
  }, ["title", "what", "where", "severity", "category", "why", "fix"]),
  tool("finish", "End the run with a short summary of what you opened and what you found, at most 400 characters.", {
    summary: { type: "string" },
  }, ["summary"]),
];

/**
 * The check. See the header comment. Never throws.
 * @returns {Promise<{findings: object[], passes: string[], skipped?: boolean, reason?: string, agent?: object}>}
 */
export async function runAgentBrowse(ctx) {
  const onEvent = ctx && typeof ctx.onEvent === "function" ? ctx.onEvent : () => {};
  const emit = (type, data) => {
    try { onEvent(type, data); } catch {}
  };
  const skipped = (reason) => ({ findings: [], passes: [], skipped: true, reason });
  try {
    if (!llmEnabled()) return skipped("AI is not configured, so the browsing agent did not run");
    if (String(process.env.AGENT_BROWSE || "") === "0") return skipped("The browsing agent is turned off");
    const facts = (ctx && ctx.facts) || {};
    const homepage = pickHomepage(ctx, facts);
    const siteHost = hostOf(homepage);
    if (!siteHost) return skipped("No site address for the browsing agent");
    if (facts.throttled) return skipped("The site limited our checker");

    let session;
    try {
      session = await openBrowser({ purpose: "agent" });
    } catch (err) {
      if (err && err.code === "NO_PLAYWRIGHT") return skipped("Playwright not installed (run: npm run enable-browser)");
      return skipped(`Browser unavailable: ${String((err && err.message) || err).slice(0, 120)}`);
    }
    try {
      return await explore({ ctx, facts, emit, homepage, siteHost, session });
    } finally {
      await withTimeout(session.close(), 5000).catch(() => {});
    }
  } catch (err) {
    return skipped(`Browsing agent failed: ${String((err && err.message) || err).slice(0, 120)}`);
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function explore({ ctx, facts, emit, homepage, siteHost, session }) {
  const { browser, mode } = session;
  const replayUrl = (session.session && session.session.replayUrl) || null;
  const maxSteps = intEnv("AGENT_STEPS", DEFAULT_STEPS, 1, 60);
  const budgetMs = intEnv("AGENT_BUDGET_MS", DEFAULT_BUDGET_MS, 10_000, 600_000);
  const started = Date.now();
  const remaining = () => started + budgetMs - Date.now();
  const homeHost = safeHostname(homepage);
  const homePort = safePort(homepage);

  const state = {
    steps: 0,
    idleTurns: 0,
    notes: [],
    shots: [],
    visited: [],
    statusByUrl: new Map(),
    shotByUrl: new Map(), // url -> the latest observation JPEG of that page
    controls: new Map(), // n -> { n, kind, text, href, submit, target, download }
    lastStatus: 0,
    lastUrl: "",
    pending: [], // warnings gathered by listeners since the last observation
    blocked: "", // where the last refused top-level navigation was headed
    cdp: null, // a DevTools session for the page, opened when a stuck load must be stopped
    limited: false,
    finished: false,
    summary: "",
    stopReason: "",
    directCalls: false, // set when llm.js's chatTools cannot be used with this model
    toolChoice: "required", // falls back to "auto" for the rest of the run when the model rejects "required"
  };

  const onSite = (u) => sameSite(u, siteHost);
  // Chromium shows its own page (chrome-error://) when a document cannot be displayed.
  const errorPage = (u) => /^chrome-error:/i.test(String(u || ""));

  // Other hosts of this site (subdomains) must resolve to public addresses, like every
  // target the checker touches. One lookup per host for the whole run.
  const hostCache = new Map(); // hostname -> Promise<{ok, error?}>
  const lookupHost = (u) => {
    const host = u.hostname.toLowerCase();
    if (!hostCache.has(host)) hostCache.set(host, resolveTarget(u).catch(() => ({ ok: false, error: "" })));
    return hostCache.get(host);
  };
  /**
   * Where the browser may go: this site or a subdomain, on the site's own port or a
   * standard one, at a public address. Returns "" when allowed, else a short clause
   * that reads after "because" ("it is on another website (example.org)").
   */
  async function navBlockReason(raw) {
    let u;
    try {
      u = new URL(String(raw || ""));
    } catch {
      return "it is not a valid address";
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return `it is not a web page (${u.protocol})`;
    if (!onSite(u.href)) return `it is on another website (${hostOf(u.href)})`;
    if (u.port && u.port !== "80" && u.port !== "443" && u.port !== homePort) return `it uses a port we do not open (${u.port})`;
    if (u.hostname.toLowerCase() !== homeHost) {
      const r = await lookupHost(u);
      if (!r || !r.ok) {
        return /find/i.test(String((r && r.error) || ""))
          ? `its host name (${u.hostname}) could not be found`
          : "it could not be opened safely";
      }
    }
    return "";
  }

  // ---- one phone-sized context, read-only ----
  const context = await browser.newContext({
    userAgent: MOBILE_USER_AGENT,
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    acceptDownloads: false,
    reducedMotion: "reduce",
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  });
  try {
    return await exploreWith(context);
  } finally {
    // The browser is closed by the caller; closing our context first tears down the
    // page, its route handler, and its listeners even on a shared hosted browser.
    await withTimeout(context.close(), 3000).catch(() => {});
  }

  async function exploreWith(context) {
  // A top-level navigation that breaks the rule above (another website, an odd port, a
  // private address) is not followed. Scripts, images, and fonts from other hosts load
  // as they would for any visitor. The request is answered with an empty 204 rather than
  // aborted, because a 204 leaves the browser on the page it was showing, while an abort
  // would replace it with Chromium's error page. Server-side redirects never reach this
  // handler (Chromium follows them on its own), so navigate() and click() also check
  // page.url() afterwards and go back when the browser ended up somewhere else.
  await context.route("**/*", async (route) => {
    const req = route.request();
    let topLevel = false;
    try {
      topLevel = req.isNavigationRequest() && !req.frame().parentFrame();
    } catch {}
    if (!topLevel) return route.continue().catch(() => {});
    let why = "";
    try {
      why = await navBlockReason(req.url());
    } catch {
      why = "it could not be checked";
    }
    if (!why) return route.continue().catch(() => {});
    state.blocked = hostOf(req.url()) || String(req.url()).slice(0, 80);
    state.pending.push(`The page tried to go to ${state.blocked}, which we do not follow because ${why}.`);
    return route.fulfill({ status: 204, body: "" }).catch(() => {});
  }).catch(() => {});

  const page = await context.newPage();
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  page.on("dialog", (d) => {
    let kind = "";
    try { kind = d.type(); } catch {}
    // Leaving a page we never typed on loses nothing, so a "leave this page?" prompt is accepted.
    if (kind === "beforeunload") {
      d.accept().catch(() => {});
      return;
    }
    const msg = String(d.message() || "").replace(/\s+/g, " ").trim().slice(0, 120);
    state.pending.push(msg ? `A popup dialog said "${msg}" and was dismissed.` : "A popup dialog appeared and was dismissed.");
    d.dismiss().catch(() => {});
  });
  page.on("download", (d) => {
    state.pending.push("The page tried to download a file, which we do not accept.");
    d.cancel().catch(() => {});
  });
  context.on("page", (p) => {
    if (p === page) return;
    state.pending.push("The page tried to open a new tab, which we closed.");
    p.close().catch(() => {});
  });
  page.on("response", (res) => {
    let status = 0;
    let url = "";
    let main = false;
    try {
      status = res.status();
      url = res.url();
      const req = res.request();
      main = req.isNavigationRequest() && !req.frame().parentFrame();
    } catch {
      return;
    }
    if (main) {
      state.lastStatus = status;
      state.statusByUrl.set(url, status);
    }
    if (status === 429 && onSite(url)) {
      state.limited = true;
      facts.throttled = true;
    }
  });

  const visitLog = (url) => {
    emit("log", { mark: "🧭", text: `Browsing agent opened ${pathFor(url, homeHost)}` });
  };

  // ---- observation ----
  async function observe({ requested = null, status = null, warnings = [] } = {}) {
    const url = page.url();
    const obsStart = Date.now();
    const obsLeft = () => Math.max(500, OBSERVE_TIMEOUT_MS - (Date.now() - obsStart));
    const data = await withTimeout(page.evaluate(readPage, { maxControls: MAX_CONTROLS, textLimit: TEXT_LIMIT }), obsLeft()).catch(() => null);
    let st = status != null ? status : state.lastStatus;
    if (status == null && state.statusByUrl.has(url)) st = state.statusByUrl.get(url);
    const warn = [...warnings, ...state.pending.splice(0)];

    if (st >= 400) warn.unshift(`The page answered with status ${st} ${statusText(st)}.`);
    if (requested && !sameAddress(requested, url)) warn.push(`The address redirected to ${url.slice(0, 160)}.`);

    state.controls = new Map();
    const controls = [];
    let text = "";
    let title = "";
    let view = "";
    if (data) {
      title = data.title;
      text = data.text;
      for (const c of data.controls) {
        state.controls.set(c.n, c);
        const shown = { n: c.n, kind: c.kind, text: c.text };
        if (c.href) shown.href = c.href;
        controls.push(shown);
      }
      const screens = Math.max(1, Math.ceil(data.scrollH / Math.max(1, data.vh)));
      const atBottom = data.y + data.vh >= data.scrollH - 4;
      const where = data.y < 4 ? "top" : atBottom ? "bottom" : `screen ${Math.min(screens, Math.round(data.y / data.vh) + 1)}`;
      view = `${where} of the page, about ${screens} screen${screens === 1 ? "" : "s"} tall`;
      if (data.cut) view += `; text shortened to ${TEXT_LIMIT} of ${data.total} characters, taken from around the current screen`;
      if (data.overflowX) warn.push("The page is wider than the phone screen, so some content may be cut off or need sideways scrolling.");
      if (data.overlay) warn.push(`Something covers most of the screen: "${data.overlay}".`);
      if (data.total < 40 && st < 400) warn.push("The page shows almost no text.");
    } else {
      warn.push("The page contents could not be read this time.");
      try { title = await withTimeout(page.title(), 2000); } catch {}
    }

    // Pages are tracked without their #fragment: jumping within a page is not a new page.
    const pageUrl = stripHash(url);
    const shot = await withTimeout(page.screenshot({ type: "jpeg", quality: OBS_JPEG_QUALITY, timeout: obsLeft() }), obsLeft()).catch(() => null);
    if (shot && shot.length <= MAX_SHOT_BYTES && /^https?:/i.test(pageUrl)) {
      if (!state.shotByUrl.has(pageUrl) && state.shotByUrl.size >= MAX_VISITED) state.shotByUrl.delete(state.shotByUrl.keys().next().value);
      state.shotByUrl.set(pageUrl, shot);
    }

    // Bookkeeping: what we visited, and the live log line for a new page.
    if (/^https?:/i.test(pageUrl) && !sameAddress(pageUrl, state.lastUrl)) {
      state.lastUrl = pageUrl;
      if (!state.visited.some((v) => sameAddress(v, pageUrl)) && state.visited.length < MAX_VISITED) state.visited.push(pageUrl);
      visitLog(pageUrl);
    }
    return { obs: { url, title, status: st, view, text, controls, warnings: warn }, shot };
  }

  // Let the page finish loading and paint, within what is left of the action's 10 seconds.
  async function settle(startedAt) {
    const left = ACTION_TIMEOUT_MS - (Date.now() - startedAt) - 400;
    if (left > 200) await page.waitForLoadState("load", { timeout: Math.min(2500, left) }).catch(() => {});
    await sleep(400);
  }

  // Chromium commits its own error page (chrome-error://) a moment after a navigation
  // fails. When the browser is on it, go back to the page it was showing before.
  async function leaveErrorPage() {
    if (!errorPage(page.url())) return false;
    await page.goBack({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => {});
    return true;
  }

  // The browser followed a redirect somewhere it may not go (Chromium does that without
  // asking the route handler). Go back and say where it was headed.
  async function leaveWrongSite(what) {
    const landed = page.url();
    if (/^about:blank$/i.test(landed)) {
      await page.goto(homepage, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => {});
      return refuseHere(`${what} left the browser on an empty page, so we opened the homepage again.`);
    }
    let why = "";
    try {
      why = await navBlockReason(landed);
    } catch {
      why = "";
    }
    if (!why) return null;
    const where = hostOf(landed) || state.blocked || "another address";
    await page.goBack({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => {});
    if (errorPage(page.url()) || !onSite(page.url())) {
      await page.goto(homepage, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => {});
    }
    return refuseHere(`${what} redirected to ${where}, which we do not follow because ${why}. We went back.`);
  }

  // A refusal after the browser moved (we went back, or reopened the homepage): the
  // model also gets the page it is on now, so its control numbers are fresh.
  async function refuseHere(text) {
    if (!onSite(page.url())) return refuse(text);
    const out = await observe({ status: null }).catch(() => null);
    return out && out.obs ? { text: `Refused: ${text}`, obs: out.obs, shot: out.shot } : refuse(text);
  }

  // Stop a navigation that is still pending. Chromium's own command answers at once even
  // when the page is stuck, while window.stop() through evaluate can hang with it.
  async function stopLoading() {
    try {
      if (!state.cdp) state.cdp = await withTimeout(context.newCDPSession(page), 2000);
      await withTimeout(state.cdp.send("Page.stopLoading"), 1500);
      return;
    } catch {
      state.cdp = null;
    }
    await withTimeout(page.evaluate(() => window.stop()), 1000).catch(() => {});
  }

  // ---- actions ----
  async function navigate(raw) {
    const startedAt = Date.now();
    const given = String(raw == null ? "" : raw).trim();
    if (!given) return refuse("open needs an address. Give a path like /contact or a full address on this site.");
    let target;
    try {
      target = new URL(given, homepage);
    } catch {
      return refuse("That is not a valid address.");
    }
    const check = await refuseAddress(target);
    if (check) return refuse(check);
    const warnings = [];
    let res = null;
    let timedOut = false;
    let failure = "";
    const seconds = Math.round(NAV_TIMEOUT_MS / 1000);
    try {
      res = await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (/Download is starting/i.test(msg)) return refuse("That address started a file download, which we do not accept. Nothing was opened.");
      if (/timeout/i.test(msg)) {
        timedOut = true;
        // Stop the load that is still pending, so the page can be read and pictured.
        await stopLoading();
        if (sameAddress(page.url(), target.href)) {
          warnings.push(`The page did not finish loading within ${seconds} seconds. What loaded so far is shown.`);
        } else {
          // The new page never arrived; the browser is still showing the one it had.
          warnings.push(`${target.href} did not answer within ${seconds} seconds, so the browser stayed on ${page.url()}. The page shown is the one it was already on.`);
        }
      } else {
        if (/interrupted by another navigation/i.test(msg)) warnings.push("The page moved to another address while it was loading.");
        else if (!/ERR_ABORTED/i.test(msg)) {
          failure = plainError(msg);
          warnings.push(`The page could not be opened (${failure}).`);
        }
        // Chromium's error page, when there is one, commits shortly after the failure.
        await sleep(300);
      }
    }
    const status = res ? res.status() : null;
    if (status === 429) {
      state.limited = true;
      facts.throttled = true;
      return { text: "The site asked us to slow down (429), so browsing stopped. Call finish now with what you have." };
    }
    if (await leaveErrorPage()) return refuseHere(`That page could not be shown (${failure || "the browser could not display it"}), so we went back.`);
    const wrong = await leaveWrongSite("That address");
    if (wrong) return wrong;
    if (!timedOut) await settle(startedAt);
    const arrived = sameAddress(page.url(), target.href) || !timedOut;
    return await observe({ requested: arrived ? target.href : null, status: arrived ? status : null, warnings });
  }

  async function click(nRaw) {
    const n = Number(nRaw);
    const info = state.controls.get(n);
    if (!Number.isInteger(n) || !info) return refuse(`There is no control number ${String(nRaw).slice(0, 12)} in the latest observation. Pick a number from the controls list.`);
    const why = await refuseControl(info);
    if (why) return refuse(why);
    const loc = page.locator(`[data-sutros-n="${n}"]`).first();
    if ((await loc.count().catch(() => 0)) === 0) return refuse("That control is no longer on the page. Read the latest observation and choose again.");

    // A link that opens a new tab for visitors is opened here instead, so we can see it.
    if (info.kind === "link" && info.href && /^https?:/i.test(info.href) && info.target === "_blank") {
      const out = await navigate(info.href);
      if (out.obs) out.obs.warnings.unshift("This link opens in a new tab for visitors. We opened it here instead.");
      return out;
    }

    const startedAt = Date.now();
    const before = page.url();
    try {
      await loc.click({ timeout: CLICK_TIMEOUT_MS });
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (/Download is starting/i.test(msg)) return refuse("That control started a file download, which we do not accept.");
      if (/intercepts pointer events|not visible|outside of the viewport|timeout/i.test(msg)) {
        return refuse("That control could not be tapped. Something may be covering it, or it may be hidden. Try scrolling, or open the address directly with open.");
      }
      return refuse(`That control could not be tapped (${plainError(msg)}).`);
    }
    await settle(startedAt);
    if (await leaveErrorPage()) return refuseHere("That control led to a page the browser could not show, so we went back.");
    const wrong = await leaveWrongSite("That control");
    if (wrong) return wrong;
    if (state.limited) return { text: "The site asked us to slow down (429), so browsing stopped. Call finish now with what you have." };
    const moved = page.url() !== before;
    // Only a full address can be compared with where we landed; a #fragment link cannot.
    const requested = moved && info.href && /^https?:/i.test(info.href) ? info.href : null;
    return await observe({ requested, status: moved ? null : state.statusByUrl.get(page.url()) ?? state.lastStatus });
  }

  async function back() {
    const startedAt = Date.now();
    const before = page.url();
    let res = null;
    try {
      res = await page.goBack({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    } catch {}
    const warnings = [];
    const now = page.url();
    if (!res && now === before) warnings.push("There is no earlier page to go back to.");
    if (/^about:blank$/i.test(now)) {
      await page.goForward({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => {});
      return refuse("There is no earlier page to go back to, so we stayed here.");
    }
    if (errorPage(now) || !onSite(now)) {
      await page.goForward({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => {});
      return refuse("The earlier page is not one of this site's pages, so we stayed here.");
    }
    await settle(startedAt);
    return await observe({ status: res ? res.status() : state.statusByUrl.get(page.url()) ?? state.lastStatus, warnings });
  }

  async function scroll(direction) {
    const dir = direction === "up" ? -1 : 1;
    const delta = dir * Math.round(VIEWPORT.height * 0.85);
    const before = await page.evaluate(() => window.scrollY).catch(() => 0);
    try {
      await page.mouse.move(Math.round(VIEWPORT.width / 2), Math.round(VIEWPORT.height / 2));
      await page.mouse.wheel(0, delta);
    } catch {}
    await sleep(350);
    let after = await page.evaluate(() => window.scrollY).catch(() => before);
    if (after === before) {
      await page.evaluate((d) => window.scrollBy({ top: d, left: 0, behavior: "instant" }), delta).catch(() => {});
      await sleep(250);
      after = await page.evaluate(() => window.scrollY).catch(() => before);
    }
    const warnings = [];
    if (after === before) warnings.push(`The page did not scroll. You are already at the ${dir > 0 ? "bottom" : "top"}, or the page has no more content that way.`);
    return await observe({ status: state.statusByUrl.get(page.url()) ?? state.lastStatus, warnings });
  }

  async function note(args) {
    if (state.notes.length >= MAX_NOTES) return { text: `You have used all ${MAX_NOTES} notes. Call finish now.` };
    const title = clean(args.title).slice(0, 200);
    const what = clean(args.what);
    const why = clean(args.why);
    const fix = clean(args.fix);
    if (!title || !what) return { text: "A note needs a title and a description of what you saw. Nothing was recorded." };
    if (state.notes.some((x) => x.title.toLowerCase() === title.toLowerCase())) return { text: "You already noted that. Nothing was recorded." };
    const severity = args.severity === "minor" ? "minor" : "watch";
    const category = args.category === "modernization" ? "modernization" : "quality";
    const quote = clean(args.quote || "").slice(0, 200);
    // The same widget, banner, or message seen again on another page is one problem, not two:
    // the earlier note simply gains this page.
    const hereNow = stripHash(page.url());
    const twin = quote && state.notes.find((x) => x.quote && x.quote.toLowerCase() === quote.toLowerCase());
    if (twin) {
      twin.morePages = twin.morePages || [];
      if (!sameAddress(twin.where, hereNow) && !twin.morePages.some((u) => sameAddress(u, hereNow))) twin.morePages.push(hereNow);
      return { text: `That is the same thing you already noted ("${twin.title}"). This page was added to that note instead of making a second one. Move on to something different.` };
    }
    // Only pages the agent actually opened can be named; anything else, or no address at
    // all, means the page it is on. The address is kept in the form we saw it.
    const here = stripHash(page.url());
    let where = here;
    const named = String(args.where == null ? "" : args.where).trim();
    if (named) {
      try {
        const w = new URL(named, homepage).href;
        const hit = state.visited.find((v) => v === w) || state.visited.find((v) => sameAddress(v, w));
        if (hit) where = hit;
      } catch {}
    }
    const status = state.statusByUrl.get(where) ?? (sameAddress(where, here) ? state.lastStatus : 0);

    const entry = { title: fitTitle(title), what, why, fix, severity, category, quote, where, status, shot: null };
    if (state.shots.length < SHOT_KEYS.length) {
      // A fresh picture of the page the agent is on. When the note is about a page it
      // opened earlier, the picture it saw of that page is used, so the picture matches.
      // When a fresh picture cannot be taken, the last one of this page stands in.
      const elsewhere = !sameAddress(where, here) && state.shotByUrl.get(where);
      const bytes = elsewhere || (await takeShot()) || state.shotByUrl.get(here) || null;
      if (bytes) {
        const shot = {
          key: SHOT_KEYS[state.shots.length],
          page: elsewhere ? where : here,
          caption: CAPTION,
          highlighted: 0,
          mime: "image/jpeg",
          bytes,
          width: VIEWPORT.width,
          height: VIEWPORT.height,
        };
        state.shots.push(shot);
        entry.shot = { key: shot.key, page: shot.page, caption: shot.caption, highlighted: 0 };
      }
    }
    state.notes.push(entry);
    emit("log", { mark: "🧭", text: `Browsing agent noted: ${entry.title}` });
    const left = MAX_NOTES - state.notes.length;
    return { text: `Noted (${state.notes.length} of ${MAX_NOTES}): "${entry.title}" at ${where}. ${left ? left + " note" + (left === 1 ? "" : "s") + " left." : "No notes left; call finish next."}` };
  }

  async function takeShot() {
    try {
      let bytes = await withTimeout(page.screenshot({ type: "jpeg", quality: SHOT_JPEG_QUALITY }), OBSERVE_TIMEOUT_MS);
      if (bytes.length > MAX_SHOT_BYTES) bytes = await withTimeout(page.screenshot({ type: "jpeg", quality: SHOT_JPEG_QUALITY_RETRY }), OBSERVE_TIMEOUT_MS);
      return bytes.length > MAX_SHOT_BYTES ? null : bytes;
    } catch {
      return null;
    }
  }

  function finish(args) {
    state.finished = true;
    state.summary = clean(args.summary || "").slice(0, SUMMARY_MAX);
    return { text: "Thank you. The run is finished." };
  }

  // ---- refusals ----
  async function refuseAddress(u) {
    if (u.protocol === "mailto:") return "That is an email link (mailto:). It opens the visitor's mail app, which is normal, so it was not opened.";
    if (u.protocol === "tel:") return "That is a phone link (tel:). It starts a call on a phone, which is normal, so it was not opened.";
    if (u.protocol === "javascript:") return "That link runs a script instead of opening a page (javascript:), so it was not opened.";
    if (u.protocol !== "http:" && u.protocol !== "https:") return `That address is not a web page (${u.protocol}), so it was not opened.`;
    if (!onSite(u.href)) return `That address is on another website (${hostOf(u.href)}). We stay on this site, so it was not opened. This is our rule, not a problem with the site.`;
    if (FILE_RE.test(u.pathname)) return "That address points to a file, which would download instead of showing a page. We do not open files, so it was not opened.";
    // The port and public-address rules, the same ones the network layer applies.
    const why = await navBlockReason(u.href);
    if (why) return `That address was not opened because ${why}.`;
    return "";
  }

  async function refuseControl(info) {
    if (DENY_RE.test(info.text)) {
      return `We never tap controls that could buy, pay, sign up, log in, send, submit, download, delete, cancel, accept, or agree to something. "${info.text}" looks like one of those, so it was not tapped. That is our rule, not a problem with the site.`;
    }
    if (info.submit) return `"${info.text}" would submit a form. We never submit anything, so it was not tapped.`;
    if (info.download) return `"${info.text}" would download a file. We do not accept downloads, so it was not tapped.`;
    if (info.kind === "link" && info.href && !/^#/.test(info.href)) {
      let u;
      try {
        u = new URL(info.href, page.url());
      } catch {
        return "";
      }
      const why = await refuseAddress(u);
      if (why) return why;
    }
    return "";
  }

  // ---- tool dispatch ----
  async function runTool(call) {
    const name = call.function && call.function.name;
    let args = {};
    try {
      args = call.function && call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      return { text: "The arguments for that call were not valid JSON, so nothing happened." };
    }
    if (!args || typeof args !== "object") args = {};
    // One browser action gets ACTION_TIMEOUT_MS; reading and picturing the page afterwards
    // gets OBSERVE_TIMEOUT_MS more. A step can never take longer than the two together.
    const guarded = (p) => withTimeout(p, ACTION_TIMEOUT_MS + OBSERVE_TIMEOUT_MS).catch((err) => ({
      text: /timed out/i.test(String(err && err.message)) ? "That action took too long and was stopped. Try something else." : `That action failed (${plainError(String((err && err.message) || err))}).`,
    }));
    switch (name) {
      case "open": return guarded(navigate(args.url));
      case "click": return guarded(click(args.n));
      case "back": return guarded(back());
      case "scroll": return guarded(scroll(args.direction));
      case "note": return guarded(note(args));
      case "finish": return finish(args);
      default: return { text: `There is no tool called "${String(name).slice(0, 30)}". Use open, click, back, scroll, note, or finish.` };
    }
  }

  // ---- first look: the homepage ----
  const first = await withTimeout(navigate(homepage), ACTION_TIMEOUT_MS + OBSERVE_TIMEOUT_MS).catch((err) => ({ text: String((err && err.message) || err) }));
  if (process.env.AGENT_DEBUG && first.obs) console.error(`agentBrowse homepage: ${JSON.stringify(first.obs).slice(0, 300)}`);
  if (state.limited) return { findings: [], passes: [], skipped: true, reason: "The site limited our checker" };
  if (!first.obs) {
    return { findings: [], passes: [], skipped: true, reason: `The homepage did not open in the browsing agent's browser: ${String(first.text || "").slice(0, 100)}` };
  }

  const system = systemPrompt({ homepage, facts, maxSteps, budgetMs });
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: `You are on the homepage now. Explore from here.\n\nObservation:\n${JSON.stringify(first.obs)}` },
        ...imagePart(first.shot),
      ],
    },
  ];

  // ---- the loop: every tool call is a step ----
  while (!state.finished) {
    if (state.steps >= maxSteps) { state.stopReason = "steps"; break; }
    if (remaining() < 2500) { state.stopReason = "time"; break; }
    if (state.limited) { state.stopReason = "limited"; break; }
    if (!browser.isConnected()) { state.stopReason = "browser"; break; }

    let reply;
    try {
      reply = await askModel({ system, messages, remaining, state });
    } catch (err) {
      state.stopReason = `model: ${String((err && err.message) || err).slice(0, 80)}`;
      if (process.env.AGENT_DEBUG) console.error("agentBrowse model call failed:", String((err && err.message) || err).slice(0, 400));
      break;
    }
    const msg = reply.message || {};
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls.filter((c) => c && c.id && c.function) : [];
    messages.push(assistantMessage(msg, calls));

    if (!calls.length) {
      state.steps++;
      state.idleTurns++;
      if (state.idleTurns >= 2) { state.stopReason = "no tool calls"; break; }
      messages.push({ role: "user", content: "Please use one of the tools: open, click, back, scroll, note, or finish." });
      continue;
    }
    state.idleTurns = 0;

    let lastShot = null;
    for (const call of calls) {
      let result;
      if (state.finished) result = "The run has finished. No more actions.";
      else if (state.steps >= maxSteps) result = "The step budget is used up. No more actions.";
      else if (state.limited) result = "The site asked us to slow down, so browsing stopped.";
      else if (remaining() < 2500) result = "The time budget is used up. No more actions.";
      else {
        state.steps++;
        const out = await runTool(call);
        result = out.obs
          ? `${out.text ? out.text + "\n\n" : ""}Observation:\n${JSON.stringify(out.obs)}`
          : String(out.text || "Done.");
        if (process.env.AGENT_DEBUG) {
          console.error(`agentBrowse step ${state.steps}: ${call.function.name}(${String(call.function.arguments || "").slice(0, 300)}) -> ${result.replace(/\s+/g, " ").slice(0, 300)}`);
        }
        if (out.shot) lastShot = out.shot;
        if (!state.finished) result += `\n\n[${Math.max(0, maxSteps - state.steps)} of ${maxSteps} actions left, about ${Math.max(0, Math.round(remaining() / 1000))} seconds left. Notes so far: ${state.notes.length} of ${MAX_NOTES}.]`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
    if (lastShot && !state.finished) {
      dropOldImages(messages);
      messages.push({ role: "user", content: [{ type: "text", text: "The phone screen now:" }, ...imagePart(lastShot)] });
    }
  }

  // ---- wrap up ----
  // The model never answered, so nothing was explored: say so instead of vouching for the site.
  if (state.steps === 0 && /^model/.test(state.stopReason)) {
    return { findings: [], passes: [], skipped: true, reason: `The AI model did not answer the browsing agent: ${state.stopReason.replace(/^model:\s*/, "").slice(0, 100)}` };
  }
  const pages = state.visited.length;
  const notes = state.notes.length;
  // The model or the browser gave out, so the agent did not get to look properly.
  const failed = /^(model|browser)/.test(state.stopReason);
  let summary = state.summary;
  if (!summary) {
    let ending = "";
    if (failed) ending = " before it had to stop early";
    else if (state.stopReason === "steps") ending = " before its budget of actions ran out";
    else if (state.stopReason === "time") ending = " before its time ran out";
    const opened = `Our browsing agent opened ${pages} page${pages === 1 ? "" : "s"} on a phone-sized screen`;
    summary = notes
      ? `${opened} and made ${notes} note${notes === 1 ? "" : "s"}${ending}.`
      : `${opened} and found nothing in the way${ending}.`;
    if (state.stopReason === "limited") summary += " The site asked us to slow down, so it stopped early.";
  }
  summary = summary.slice(0, SUMMARY_MAX);

  emit("log", {
    mark: "🧭",
    text: `Browsing agent finished after ${state.steps} step${state.steps === 1 ? "" : "s"} and ${pages} page${pages === 1 ? "" : "s"}${notes ? `, with ${notes} note${notes === 1 ? "" : "s"}` : ""}.`,
  });

  const findings = toFindings(state.notes);
  // No notes means a pass, unless the site cut the visit short by limiting us, or the
  // run broke down before the agent had looked at more than the homepage.
  const passes = notes || state.stopReason === "limited" || (failed && pages < 2)
    ? []
    : [`Our browsing agent tried ${pages} page${pages === 1 ? "" : "s"} the way a visitor would and found nothing in the way.`];
  return {
    findings,
    passes,
    agent: {
      ran: true,
      mode,
      steps: state.steps,
      visited: state.visited.slice(),
      summary,
      replayUrl,
      shots: state.shots,
    },
  };
  } // exploreWith
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

async function askModel({ system, messages, remaining, state }) {
  const budget = () => Math.max(3000, remaining());
  const opts = { system, messages, tools: TOOLS, maxTokens: MODEL_MAX_TOKENS, toolChoice: state.toolChoice };
  if (state.directCalls) return withTimeout(chatToolsDirect(opts), budget());
  try {
    return await withTimeout(chatTools(opts), budget());
  } catch (err) {
    const msg = String((err && err.message) || err);
    // Newer models refuse function tools on the chat endpoint unless reasoning is switched
    // off. llm.js does not send that field, so the rest of this run calls the API directly.
    if (/reasoning_effort/i.test(msg) && /function tools|tools/i.test(msg) && remaining() > 3000) {
      state.directCalls = true;
      return withTimeout(chatToolsDirect(opts), budget());
    }
    // A model that does not accept "required" gets "auto" for the rest of the run.
    if (/tool_choice/i.test(msg) && state.toolChoice !== "auto" && remaining() > 3000) {
      state.toolChoice = "auto";
      return withTimeout(chatTools({ ...opts, toolChoice: "auto" }), budget());
    }
    throw err;
  }
}

/**
 * The same call chatTools() makes, plus reasoning_effort "none", which the
 * chat endpoint requires for function tools on gpt-5.x models. Used only after
 * chatTools() has refused for that reason.
 */
async function chatToolsDirect({ system, messages, tools, maxTokens, toolChoice }) {
  const body = {
    model: modelName(),
    max_completion_tokens: Math.max(maxTokens, 1500),
    messages: [{ role: "system", content: system }, ...messages],
    tools,
    tool_choice: toolChoice,
    reasoning_effort: "none",
  };
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        const err = new Error(`OpenAI API error ${res.status}: ${detail.slice(0, 400)}`);
        if (res.status === 429 || res.status >= 500) { lastErr = err; continue; }
        throw err;
      }
      const data = await res.json();
      const choice = data && data.choices && data.choices[0];
      if (!choice || !choice.message) throw new Error("OpenAI returned no message.");
      return { message: choice.message, finishReason: choice.finish_reason || "", usage: data.usage || null };
    } catch (err) {
      lastErr = err;
      if (err && err.name === "AbortError") continue;
      if (!/OpenAI API error (429|5\d\d)/.test(String(err && err.message))) throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error("OpenAI call failed.");
}

function systemPrompt({ homepage, facts, maxSteps, budgetMs }) {
  const built = facts.cms && facts.cms.name ? facts.cms.name : Array.isArray(facts.technologies) && facts.technologies[0] ? facts.technologies[0] : "";
  const known = knownPaths(facts, homepage);
  const seconds = Math.round(budgetMs / 1000);
  return [
    `You are the browsing agent for Sutros, a free website checkup for community sites: schools, libraries, clubs, places of worship, small businesses, and town offices. You have a real phone-sized browser open on this site: ${homepage}. You explore it read-only, the way a careful visitor on a phone would, and you write down what a visitor would run into. A person who is not technical reads your notes, so they must be plain, specific, and fair.`,
    "",
    "What you already know",
    built ? `- The site is built on ${built}.` : "- We do not know what the site is built on.",
    known.length ? `- Pages our crawler saw: ${known.join(", ")}. These are hints. Open what a real visitor would open first: the menu, the main sections, contact or about, and one or two deeper pages.` : "- Our crawler saw no other pages. Use the menu and the links on the homepage.",
    "",
    "How you work",
    "- After every action you get an observation: the page address, title, status, where on the page you are, the visible text (shortened to 3500 characters, taken from around the part you are looking at), a numbered list of the first 40 visible links and buttons, and warnings we measured. You also get a screenshot of the phone screen. Look at the screenshot every time; it shows what the visitor sees, including layout problems the text cannot show.",
    "- Tools: open, click, back, scroll, note, finish. One action per turn.",
    `- Budget: ${maxSteps} actions in total and about ${seconds} seconds. Every tool call spends one action, including note and finish. Keep 1 action for finish and, when you have something to say, 1 for each note. Plan to open 3 to 6 pages. When the budget runs out the run ends without your summary, so finish before that.`,
    "- Menus on phones are usually behind a button that says Menu, or an icon with no text. Tap it to see the links. A menu that needs one tap to open is normal.",
    "- You cannot type, fill in forms, or submit anything, and you must not try. Controls that buy, pay, sign up, log in, send, submit, download, delete, accept, or agree are refused. Links that leave this site are refused; that is our rule, not a problem with the site. Links to email addresses and phone numbers are refused too; they are normal and not a problem.",
    "- When a tap is refused or fails, move on. Do not repeat the same action. Do not open the same page twice.",
    "- The warnings in the observation are measured facts (a status code, a redirect, a dialog, a page wider than the screen, an overlay). Use them, but decide for yourself whether a visitor would mind.",
    "",
    "What to look for (only things a visitor would run into)",
    "- pages that fail to load, show an error, or are empty",
    "- placeholder text such as Lorem ipsum, coming soon, under construction, or an unfinished section",
    "- error messages printed on the page",
    "- navigation that goes nowhere: a menu item that does nothing, a link that lands on a Not Found page, a menu that cannot be opened",
    "- layout that is cut off, overlapping, or unreadable on a phone: tiny text, content wider than the screen, buttons on top of each other, a picture covering the words",
    "- popups or banners that cover the page and cannot be closed",
    "- notices, events, or news with clearly old dates presented as current",
    "- contact details that are missing or clearly wrong: no way to reach anyone, a broken address, hours that contradict each other",
    "- links to social pages that no longer exist, only when you saw that they are gone",
    "- anything else that would frustrate a visitor who came to find something out or get something done",
    "",
    "Being fair",
    "- Note only what you actually saw on this phone screen. Quote the text exactly as it appeared and give the page address. Do not guess at causes you cannot see, and do not invent problems.",
    "- Prefer fewer, better notes. A site that works fine deserves zero notes, and that is a good result. Do not pad. Do not note design taste, missing features you wish existed, or small things a visitor would not notice.",
    "- Do not note: a cookie or consent banner that can be closed; a control we refused; content from another website that loaded slowly; text that was cut in the observation because of the 3500 character limit; a menu that simply needs a tap; a link you did not open yourself (another check tests every link); a page that our crawler saw but you did not open.",
    "- Old dates: a News or Events section whose newest item is more than about a year old is worth a note. An archive page or a dated blog post is not.",
    "- Severity: watch when a visitor would be stopped, misled, or unable to do what they came for; minor for a small annoyance. Category: modernization for phone layout and display problems; quality for everything else.",
    "- Before you write a note, ask whether the owner would agree it is real when they open that page on a phone. If you are not sure, do not note it.",
    "",
    "Writing notes",
    "- Plain, warm, direct English. Short sentences. Say this site, never your site. No analogies or metaphors. No dashes as punctuation. No exclamation marks.",
    "- title: at most 70 characters, says the thing plainly. Example: The Events page still says Coming Soon",
    "- what: 1 to 3 sentences on what a visitor sees, with the exact text in quotes",
    "- where: the full address of the page where you saw it",
    "- quote: the exact text you saw, up to 200 characters; leave it empty for a layout problem with no text",
    "- why: one sentence on why it matters to a visitor",
    "- fix: one practical sentence on what to change",
    "",
    "Finishing",
    "- Call finish once you have seen the main pages a visitor would visit and have either noted what you found or found nothing. Finish early when the site is fine. Do not spend actions just because you have them.",
    "- The summary is at most 400 characters, in the same plain style, written as a short report and not in the first person (no I or we). Say which pages you opened (as paths such as /about) and what you found, or that nothing was in the way. Example: Opened /, /about, /events, and /contact. Every page loaded and read well on a phone. The Events page still says Coming Soon; nothing else was in the way.",
  ].join("\n");
}

function knownPaths(facts, homepage) {
  const out = [];
  const seen = new Set();
  for (const p of Array.isArray(facts.pages) ? facts.pages : []) {
    const u = p && p.url ? String(p.url) : "";
    if (!u || sameAddress(u, homepage)) continue;
    let path;
    try {
      const x = new URL(u);
      path = x.pathname + (x.search ? x.search : "");
    } catch {
      continue;
    }
    if (path.length > 60) path = path.slice(0, 57) + "...";
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
    if (out.length >= 12) break;
  }
  return out;
}

function assistantMessage(msg, calls) {
  const out = { role: "assistant", content: typeof msg.content === "string" ? msg.content : null };
  if (calls.length) {
    out.tool_calls = calls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: String(c.function.name || ""), arguments: typeof c.function.arguments === "string" ? c.function.arguments : JSON.stringify(c.function.arguments || {}) },
    }));
  }
  return out;
}

function imagePart(shot) {
  if (!shot || !shot.length) return [];
  return [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${shot.toString("base64")}` } }];
}

/** Keep only the latest screenshots in the conversation; older ones become a short line. */
function dropOldImages(messages) {
  const idx = [];
  messages.forEach((m, i) => {
    if (m.role === "user" && Array.isArray(m.content) && m.content.some((p) => p && p.type === "image_url")) idx.push(i);
  });
  const stale = idx.slice(0, Math.max(0, idx.length - (KEEP_IMAGES - 1)));
  for (const i of stale) {
    const text = messages[i].content.filter((p) => p && p.type === "text").map((p) => p.text).join("\n");
    messages[i] = { role: "user", content: `${text}\n(earlier screenshot removed to save space)` };
  }
}

function refuse(text) {
  return { text: `Refused: ${text}` };
}

// ---------------------------------------------------------------------------
// In the page
// ---------------------------------------------------------------------------

/**
 * Runs inside the page. Reads the visible text, numbers the visible links and
 * buttons (data-sutros-n), and measures a few things a phone visitor would
 * notice: sideways overflow and a large fixed overlay.
 */
function readPage({ maxControls, textLimit }) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const doc = document.documentElement;
  const body = document.body;
  const scrollH = Math.max(doc ? doc.scrollHeight : 0, body ? body.scrollHeight : 0, vh);
  const y = window.scrollY || 0;

  let full = (body && body.innerText) || "";
  full = full.replace(/[ \t\u00a0]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const total = full.length;
  let text = full;
  let cut = false;
  if (total > textLimit) {
    const frac = scrollH > vh ? Math.min(1, y / (scrollH - vh)) : 0;
    const start = Math.floor(frac * (total - textLimit));
    text = (start > 0 ? "..." : "") + full.slice(start, start + textLimit) + (start + textLimit < total ? "..." : "");
    cut = true;
  }

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (r.right <= 0 || r.left >= vw) return false;
    if (r.bottom + y <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  };
  const textOf = (el) => {
    let t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    if (!t) t = el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("value") || "";
    if (!t) {
      const img = el.querySelector("img[alt], svg title");
      if (img) t = img.getAttribute ? img.getAttribute("alt") || img.textContent || "" : "";
    }
    return t.replace(/\s+/g, " ").trim().slice(0, 60);
  };

  for (const el of document.querySelectorAll("[data-sutros-n]")) el.removeAttribute("data-sutros-n");
  const nodes = document.querySelectorAll(
    'a[href], button, input[type="button"], input[type="submit"], input[type="reset"], input[type="image"], summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"]'
  );
  // Every rendered control, in document order, with where its bottom edge sits
  // relative to the top of the current screen.
  const found = [];
  const seen = new Set();
  for (const el of nodes) {
    if (found.length >= maxControls * 6) break;
    if (!visible(el)) continue;
    const tag = el.tagName;
    const isLink = tag === "A" && el.hasAttribute("href");
    const kind = isLink ? "link" : "button";
    let href = "";
    if (isLink) {
      const raw = el.getAttribute("href") || "";
      if (/^#/.test(raw)) href = raw;
      else {
        try { href = new URL(raw, location.href).href; } catch { href = raw; }
      }
    }
    const t = textOf(el) || "(no text)";
    const key = kind + "|" + t + "|" + href;
    if (seen.has(key)) continue;
    seen.add(key);
    const type = (el.getAttribute("type") || "").toLowerCase();
    const inForm = Boolean(el.form || el.closest("form"));
    const submit = inForm && ((tag === "BUTTON" && (type === "" || type === "submit")) || (tag === "INPUT" && (type === "submit" || type === "image")));
    const c = { kind, text: t, submit, download: isLink && el.hasAttribute("download"), target: (el.getAttribute("target") || "").toLowerCase() };
    if (href) c.href = href.length > 300 ? href.slice(0, 300) : href;
    found.push({ el, c, order: found.length, bottom: el.getBoundingClientRect().bottom });
  }
  // When there are more than fit, the ones at or under the top of the current screen come
  // first, so scrolling down reveals new controls. Numbering stays in document order.
  let chosen = found;
  if (found.length > maxControls) {
    const below = found.filter((f) => f.bottom >= 0);
    const above = found.filter((f) => f.bottom < 0);
    chosen = below.slice(0, maxControls);
    if (chosen.length < maxControls) chosen = chosen.concat(above.slice(-(maxControls - chosen.length)));
    chosen.sort((a, b) => a.order - b.order);
  }
  const controls = [];
  let n = 0;
  for (const f of chosen) {
    n++;
    f.el.setAttribute("data-sutros-n", String(n));
    controls.push(Object.assign({ n }, f.c));
  }

  // Sideways overflow: the page is wider than the phone.
  const overflowX = (doc ? doc.scrollWidth : 0) > vw + 8;

  // A fixed element covering at least half the screen, with words in it.
  let overlay = "";
  const candidates = document.querySelectorAll("div, section, aside, dialog, form, nav");
  let looked = 0;
  for (const el of candidates) {
    if (looked++ > 2500) break;
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "sticky") continue;
    if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") continue;
    const r = el.getBoundingClientRect();
    const w = Math.min(r.right, vw) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, vh) - Math.max(r.top, 0);
    if (w <= 0 || h <= 0) continue;
    if (w * h < vw * vh * 0.5) continue;
    const words = (el.innerText || "").replace(/\s+/g, " ").trim();
    if (words.length < 3) continue;
    overlay = words.slice(0, 80);
    break;
  }

  return { title: (document.title || "").slice(0, 160), text, cut, total, y, vh, scrollH, controls, overflowX, overlay };
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

function toFindings(notes) {
  const ids = new Set();
  return notes.map((n) => {
    let base = "agent-" + slug(n.title);
    let id = base;
    for (let i = 2; ids.has(id); i++) id = `${base}-${i}`;
    ids.add(id);
    const more = Array.isArray(n.morePages) ? n.morePages.filter(Boolean) : [];
    const lines = [n.where, n.quote ? `Seen on the page: "${n.quote}"` : n.what];
    if (more.length) lines.push(`Also seen on ${more.length === 1 ? "another page" : more.length + " other pages"}: ${more.map((u) => pathOf(u)).join(", ")}`);
    return {
      id,
      source: "agent",
      severity: n.severity,
      category: n.category,
      title: n.title,
      meaning: n.what,
      fix: [n.fix || "Open the page listed and put right what is described above."],
      who: WHO,
      evidence: {
        lines,
        note: NOTE_TEXT,
        why: n.why || "",
        confirm: CONFIRM,
        method: METHOD,
        pages: [n.where, ...more].slice(0, 6),
        items: [n.where, ...more].slice(0, 6).map((u) => ({ url: u, status: u === n.where ? n.status || 0 : 0, statusText: u === n.where ? statusText(n.status || 0) : "seen", kind: "page" })),
        shots: n.shot ? [n.shot] : [],
      },
    };
  });
}

/** Plain copy: one line of whitespace, no dashes as punctuation, no exclamation marks, "this site". */
function clean(s) {
  return String(s == null ? "" : s)
    .replace(/\s+/g, " ")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s+-\s+/g, ", ")
    .replace(/!+/g, ".")
    .replace(/\b(your) (web ?site|site|homepage|page)\b/gi, (m, y, w) => (y[0] === "Y" ? "This " : "this ") + w)
    .replace(/^[,\s]+/, "")
    .replace(/,\s*([.,;:])/g, "$1")
    .trim();
}

function fitTitle(title) {
  let t = title.replace(/[.!]+$/, "").trim();
  if (t.length <= TITLE_MAX) return t;
  t = t.slice(0, TITLE_MAX);
  const sp = t.lastIndexOf(" ");
  if (sp > 40) t = t.slice(0, sp);
  return t.replace(/[\s,;:]+$/, "");
}

function pathOf(u) {
  try { const x = new URL(u); return (x.pathname + x.search) || "/"; } catch { return String(u || ""); }
}

function slug(s) {
  const out = String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return out || "note";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tool(name, description, properties, required) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

function pickHomepage(ctx, facts) {
  const f = facts.finalUrl;
  const raw = (f && f.href) || (typeof f === "string" ? f : "") || (ctx && ctx.url && ctx.url.href) || (typeof (ctx && ctx.url) === "string" ? ctx.url : "");
  try {
    const u = new URL(String(raw));
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    u.hash = "";
    return u.href;
  } catch {
    return "";
  }
}

function intEnv(name, fallback, min, max) {
  const v = parseInt(process.env[name] || "", 10);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

function safeHostname(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return ""; }
}

/** The explicit port of an address ("" for the default one). */
function safePort(url) {
  try { return new URL(String(url)).port || ""; } catch { return ""; }
}

/** The address without its #fragment. */
function stripHash(url) {
  try {
    const u = new URL(String(url));
    u.hash = "";
    return u.href;
  } catch {
    return String(url || "");
  }
}

/** The site itself or one of its subdomains, with www. ignored on both sides. */
function sameSite(url, siteHost) {
  const h = hostOf(url);
  if (!h || !siteHost) return false;
  return h === siteHost || h.endsWith("." + siteHost);
}

/** The same page, ignoring the scheme, www., a trailing slash, and the fragment. */
function sameAddress(a, b) {
  const norm = (u) => {
    try {
      const x = new URL(String(u));
      return x.hostname.toLowerCase().replace(/^www\./, "") + x.pathname.replace(/\/+$/, "") + x.search;
    } catch {
      return String(u || "");
    }
  };
  return norm(a) === norm(b);
}

/** "/contact" for the site's own host, "blog.example.org/news" for another host of the site. */
function pathFor(url, homeHost) {
  try {
    const u = new URL(url);
    let p = u.pathname + u.search;
    if (p.length > 80) p = p.slice(0, 77) + "...";
    return u.hostname.toLowerCase() === homeHost ? p || "/" : u.hostname + p;
  } catch {
    return String(url || "").slice(0, 80);
  }
}

function plainError(msg) {
  const m = String(msg || "");
  if (/NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED/i.test(m)) return "address not found";
  if (/CONNECTION_REFUSED/i.test(m)) return "connection refused";
  if (/CONNECTION_RESET|CONNECTION_CLOSED|EMPTY_RESPONSE/i.test(m)) return "connection closed";
  if (/ERR_CERT|ERR_SSL/i.test(m)) return "certificate problem";
  if (/TOO_MANY_REDIRECTS/i.test(m)) return "too many redirects";
  if (/ERR_ABORTED/i.test(m)) return "request cancelled";
  if (/UNSAFE_PORT|BLOCKED_BY_CLIENT|BLOCKED_BY_RESPONSE/i.test(m)) return "the browser refused that address";
  if (/INVALID_URL|INVALID_REDIRECT|UNKNOWN_URL_SCHEME/i.test(m)) return "the address is not valid";
  if (/interrupted by another navigation/i.test(m)) return "the page moved on while loading";
  if (/timeout|timed out/i.test(m)) return "timed out";
  return m.replace(/\s+/g, " ").replace(/^.*?(net::ERR_[A-Z_]+).*$/, "$1").slice(0, 60);
}

function statusText(code) {
  const map = {
    200: "OK", 201: "Created", 204: "No Content", 301: "Moved Permanently", 302: "Found", 303: "See Other", 304: "Not Modified",
    307: "Temporary Redirect", 308: "Permanent Redirect", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
    405: "Method Not Allowed", 406: "Not Acceptable", 408: "Request Timeout", 410: "Gone", 429: "Too Many Requests",
    500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
  };
  if (!code) return "did not load";
  if (map[code]) return map[code];
  if (code >= 500) return "Server Error";
  if (code >= 400) return "Error";
  if (code >= 300) return "Redirect";
  return "OK";
}

function withTimeout(promise, ms) {
  let timer;
  const gate = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), ms); });
  return Promise.race([Promise.resolve(promise), gate]).finally(() => clearTimeout(timer));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
