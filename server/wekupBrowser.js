// One bounded, read-only browser visit to a page recorded in a saved finding, for
// wekup conversations. Every request the page makes is intercepted and performed
// in Node through a guarded fetch: http(s) only, GET or HEAD only, each host resolved
// to a public address and the connection pinned to that answer, every redirect
// validated before it is followed, counts and bytes bounded. Service workers and
// WebSockets are blocked. The browser never types or submits. What comes back is
// measured: status, bot check, stylesheet state, visible text, controls, width,
// overlays, and the fate of recorded images. An explicit content-screening visit
// can return bounded image samples in memory; ordinary conversations never do.
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { resolveTarget } from './safety.js';
import { openBrowser } from './lib/browserConnect.js';
import { isChallenge, headerValue } from './lib/challenge.js';
import { classifyStylesheetResponse, assessStyling } from './lib/styling.js';
import { BROKEN_STATUSES } from './lib/http.js';
import { MOBILE_USER_AGENT } from './checks/agentBrowse.js';
import { CHROME_USER_AGENT } from './checks/browser.js';
import { waitForPageReady } from './lib/pageReadiness.js';

export const PHONE = Object.freeze({ width: 390, height: 844 });
export const DESKTOP = Object.freeze({ width: 1280, height: 800 });
export const LIMITS = Object.freeze({ maxRequests: 80, maxTotalBytes: 8_000_000, maxResponseBytes: 2_500_000, maxHops: 5, requestTimeoutMs: 8000 });
const TEXT_LIMIT = 3500;
const MAX_CONTROLS = 40;
const OVERLAY_COVER_PERCENT = 40;
const DROP_REQUEST_HEADERS = new Set(['host', 'content-length', 'connection', 'accept-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer', 'keep-alive', 'transfer-encoding']);
const DROP_RESPONSE_HEADERS = new Set(['content-encoding', 'transfer-encoding', 'content-length', 'connection', 'keep-alive', 'upgrade']);
const defaultAllowPort = (port) => !port || port === '80' || port === '443';

function parse(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) return null;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url;
  } catch { return null; }
}
const sameSite = (hostname, siteHost) => {
  const h = String(hostname || '').toLowerCase();
  const s = String(siteHost || '').toLowerCase().replace(/^www\./, '');
  return Boolean(s) && (h === s || h === 'www.' + s || h.endsWith('.' + s));
};

/**
 * One request over Node's own HTTP client, connected to `ip` instead of whatever the
 * name resolves to at that moment, with no automatic redirects and a byte cap.
 * @returns {Promise<{status:number, headers:object, body:Buffer, truncated:boolean}>}
 */
export function guardedFetch({ url, ip, method = 'GET', headers = {}, maxBytes = LIMITS.maxResponseBytes, timeoutMs = LIMITS.requestTimeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    if (!(url instanceof URL) || !['http:', 'https:'].includes(url.protocol)) return reject(new Error('Only http(s) addresses are fetched.'));
    const verb = String(method || 'GET').toUpperCase();
    if (verb !== 'GET' && verb !== 'HEAD') return reject(new Error('Only the GET and HEAD methods are allowed.'));
    const family = net.isIP(ip);
    if (!family) return reject(new Error('A pinned public address is required.'));
    const clean = {};
    for (const [k, v] of Object.entries(headers || {})) if (!DROP_REQUEST_HEADERS.has(k.toLowerCase()) && !/^:/.test(k)) clean[k] = v;
    clean['accept-encoding'] = 'identity';
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: verb, headers: clean, agent: false, timeout: timeoutMs, servername: url.hostname, signal,
      lookup: (_host, options, cb) => (options && options.all ? cb(null, [{ address: ip, family }]) : cb(null, ip, family)),
    }, (res) => {
      const chunks = [];
      let size = 0, truncated = false;
      res.on('data', (chunk) => {
        if (truncated) return;
        size += chunk.length;
        if (size > maxBytes) { truncated = true; res.destroy(); return; }
        chunks.push(chunk);
      });
      const finish = () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks), truncated });
      res.on('end', finish);
      res.on('close', finish);
      res.on('error', () => finish());
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    req.on('error', reject);
    req.end();
  });
}

/**
 * @returns {Promise<object>} `{ url, blocked }` when the address may not be visited,
 * `{ url, error }` when the visit failed, otherwise the measured observation.
 */
export async function observeRecordedPage({ url: rawUrl, view = 'phone', siteHost, session: givenSession = null, resolve = resolveTarget,
  allowPort = defaultAllowPort, budgetMs = 45_000, images = [], captureScreening = false, maxRequests = LIMITS.maxRequests, maxTotalBytes = LIMITS.maxTotalBytes, maxResponseBytes = LIMITS.maxResponseBytes } = {}) {
  const started = Date.now();
  const remaining = () => started + budgetMs - Date.now();
  const target = parse(rawUrl);
  const url = target ? target.href : String(rawUrl || '').slice(0, 500);
  // Every host is resolved once and pinned to the first public address the resolver returned.
  const pins = new Map();
  const pin = async (u) => {
    if (!u || !allowPort(u.port)) return null;
    const key = u.hostname.toLowerCase();
    if (!pins.has(key)) pins.set(key, Promise.resolve().then(() => resolve(u)).then((r) => (r?.ok && Array.isArray(r.addresses) && net.isIP(String(r.addresses[0] || '')) ? { ip: String(r.addresses[0]) } : null)).catch(() => null));
    return pins.get(key);
  };
  if (!target || !sameSite(target.hostname, siteHost) || !(await pin(target))) return { url, blocked: 'not-allowed' };
  let session = givenSession;
  try { if (!session) session = await openBrowser({ purpose: captureScreening ? 'content-screening' : 'wekup', localOnly: captureScreening }); } catch (err) { return { url, error: err?.code === 'NO_PLAYWRIGHT' ? 'browser-not-installed' : 'browser-unavailable' }; }
  const phone = view !== 'desktop';
  let context;
  try {
    if (remaining() < 500) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    context = await session.browser.newContext({
      userAgent: phone ? MOBILE_USER_AGENT : CHROME_USER_AGENT, viewport: phone ? { ...PHONE } : { ...DESKTOP }, deviceScaleFactor: 1,
      isMobile: phone, hasTouch: phone, acceptDownloads: false, reducedMotion: 'reduce', serviceWorkers: 'block', extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });
    const limits = { maxRequests, maxTotalBytes, maxResponseBytes };
    return await withTimeout(visit(context, { url: target, view: phone ? 'phone' : 'desktop', siteHost, pin, images, captureScreening, remaining, limits }), Math.max(1, remaining()))
      .catch((err) => ({ url, error: err?.name === 'TimeoutError' || /timeout/i.test(String(err?.message)) ? 'timeout' : 'navigation-failed' }));
  } catch (err) {
    return { url, error: err?.name === 'TimeoutError' ? 'timeout' : 'browser-unavailable' };
  } finally {
    if (context) await withTimeout(context.close(), 3000).catch(() => {});
    if (!givenSession && session) await withTimeout(session.close(), 5000).catch(() => {});
  }
}

async function visit(context, { url, view, siteHost, pin, images, captureScreening, remaining, limits }) {
  const state = { blocked: null, redirectTo: null, finalUrl: url.href, documentStatus: 0, documentHeaders: {}, stylesheets: new Map(), pending: [], docChallenge: null, documents: 0, imageStatus: new Map(), redirectedCode: false,
    requests: { count: 0, bytes: 0, aborted: 0, denied: 0, failed: 0 } };
  const wanted = new Set((Array.isArray(images) ? images : []).map((u) => parse(u)?.href).filter(Boolean));
  let inFlight = 0;
  const capacityWaiters = new Set();
  const lifecycle = new AbortController();
  let closed = false;
  context.once('close', () => {
    closed = true; lifecycle.abort();
    for (const wake of capacityWaiters) wake();
  });

  // Redirects are never handed to Chromium: a fulfilled 3xx would be followed by the
  // browser itself, outside this handler. A document redirect is validated here, the
  // navigation is stopped, and the visit loop below navigates to the validated target
  // itself, so the document address is right and the target is intercepted again. A
  // subresource redirect is followed in Node, one validated hop at a time.
  async function fetchValidated(first, { method, headers, topLevel }) {
    let current = first;
    for (let hop = 0; hop <= LIMITS.maxHops; hop++) {
      const pinned = await pin(current);
      if (closed || !pinned || (topLevel && !sameSite(current.hostname, siteHost))) return null;
      // Wait for reserved capacity to return instead of rejecting normal parallel
      // page resources merely because other responses are still in flight.
      while (!closed && inFlight && limits.maxTotalBytes - state.requests.bytes < Math.min(limits.maxResponseBytes, limits.maxTotalBytes) && remaining() > 300) {
        let wake;
        await withTimeout(new Promise(resolve => { wake = resolve; capacityWaiters.add(wake); }), Math.max(1, remaining() - 300)).catch(() => {});
        capacityWaiters.delete(wake);
      }
      const maxBytes = Math.min(limits.maxResponseBytes, limits.maxTotalBytes - state.requests.bytes);
      if (closed || state.requests.count >= limits.maxRequests || maxBytes < 1 || remaining() < 300) return { limited: true };
      // Reserve before awaiting a response so parallel resources and redirects share
      // the same limits. A cut-off or failed download conservatively spends its reservation.
      state.requests.count++;
      state.requests.bytes += maxBytes;
      let out;
      inFlight++;
      try {
        out = await guardedFetch({ url: current, ip: pinned.ip, method, headers, maxBytes, timeoutMs: Math.max(1000, Math.min(LIMITS.requestTimeoutMs, remaining() - 500)), signal: lifecycle.signal });
        if (!out.truncated) state.requests.bytes -= maxBytes - Math.min(maxBytes, out.body.length);
      } finally { inFlight--; for (const wake of capacityWaiters) wake(); }
      if (![301, 302, 303, 307, 308].includes(out.status) || !out.headers.location) return { ...out, url: current };
      let next = null;
      try { next = parse(new URL(String(out.headers.location), current).href); } catch {}
      if (!next || !(await pin(next)) || (topLevel && !sameSite(next.hostname, siteHost))) return null;
      if (topLevel) return { redirectTo: next.href };
      if (hop === LIMITS.maxHops) return null;
      current = next;
    }
    return null;
  }
  await context.route('**/*', async (route) => {
    const req = route.request();
    let topLevel = false;
    try { topLevel = req.isNavigationRequest() && !req.frame().parentFrame(); } catch {}
    // A refused document navigation is answered with an empty 204 so the browser stays put.
    const deny = (why) => { if (topLevel) { state.blocked = state.blocked || why; return route.fulfill({ status: 204, body: '' }).catch(() => {}); } return route.abort('blockedbyclient').catch(() => {}); };
    const method = req.method().toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') { state.requests.denied++; return deny('not-allowed'); }
    if (state.requests.count >= limits.maxRequests || remaining() < 300) { state.requests.aborted++; return deny('bounded'); }
    const target = parse(req.url());
    if (!target || (topLevel && !sameSite(target.hostname, siteHost))) { state.requests.denied++; return deny('not-allowed'); }
    let out;
    try { out = await fetchValidated(target, { method, headers: req.headers(), topLevel }); }
    catch { state.requests.failed++; return topLevel ? deny('not-allowed') : route.abort('failed').catch(() => {}); }
    if (!out) { state.requests.denied++; return deny('not-allowed'); }
    if (out.limited) { state.requests.aborted++; return deny('bounded'); }
    if (out.redirectTo) { state.redirectTo = out.redirectTo; return route.fulfill({ status: 204, body: '' }).catch(() => {}); }
    if (out.truncated) { state.requests.aborted++; return deny('bounded'); }
    if (out.url.href !== target.href && ['stylesheet', 'script'].includes(req.resourceType())) state.redirectedCode = true;
    const headers = {};
    for (const [k, v] of Object.entries(out.headers || {})) { if (DROP_RESPONSE_HEADERS.has(k.toLowerCase())) continue; headers[k] = Array.isArray(v) ? v[0] : String(v); }
    return route.fulfill({ status: out.status, headers, body: out.body }).catch(() => {});
  });
  if (typeof context.routeWebSocket === 'function') await context.routeWebSocket('**/*', (ws) => { state.requests.denied++; try { ws.close(); } catch {} }).catch(() => {});

  const page = await context.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  page.on('download', (d) => d.cancel().catch(() => {}));
  context.on('page', (p) => { if (p !== page) p.close().catch(() => {}); });
  page.on('response', (res) => {
    let main = false, type = '';
    try { const rq = res.request(); main = rq.isNavigationRequest() && !rq.frame().parentFrame(); type = rq.resourceType(); } catch {}
    const u = res.url();
    const status = res.status();
    const headers = res.headers();
    if (main) {
      // A refused navigation is answered 204 and leaves the page where it was.
      if ((status < 300 || status >= 400) && status !== 204) { state.finalUrl = u; state.documentStatus = status; state.documentHeaders = headers; }
      const thisDoc = ++state.documents;
      state.docChallenge = isChallenge({ url: u, status, headers }) || null;
      const ct = headerValue(headers, 'content-type');
      if (!state.docChallenge && [200, 202, 403, 503].includes(status) && (!ct || /text\/html|application\/xhtml/i.test(ct))) {
        // The body of a fulfilled document is already in hand; reading it fetches nothing.
        state.pending.push(res.text().catch(() => '').then((body) => {
          const c = isChallenge({ status, headers, bodyStart: String(body || '').slice(0, 8192) });
          if (c && state.documents === thisDoc) state.docChallenge = c;
        }));
      }
      return;
    }
    if (type === 'stylesheet') state.stylesheets.set(u, classifyStylesheetResponse({ url: u, status, contentType: headerValue(headers, 'content-type'), headers }));
    if ((captureScreening || wanted.has(u)) && !state.imageStatus.has(u)) {
      const challenged = Boolean(isChallenge({ url: u, status, headers }));
      state.imageStatus.set(u, { status, challenged, outcome: challenged ? 'unavailable' : status >= 200 && status < 400 ? 'loaded' : BROKEN_STATUSES.has(status) ? 'broken' : 'unavailable' });
    }
  });
  page.on('requestfailed', (req) => {
    const u = req.url();
    let type = '';
    try { type = req.resourceType(); } catch {}
    const errorText = (req.failure() && req.failure().errorText) || '';
    if (type === 'stylesheet' && !state.stylesheets.has(u)) state.stylesheets.set(u, classifyStylesheetResponse({ url: u, status: 0, errorText: errorText || 'net::ERR_FAILED' }));
    if ((captureScreening || wanted.has(u)) && !state.imageStatus.has(u)) state.imageStatus.set(u, { status: 0, challenged: false, outcome: 'unavailable' });
  });

  // Navigate hop by hop: the handler validates each document redirect and hands the
  // target back here, so the browser lands on the final page by its own address.
  let res = null, current = url.href;
  const navigationStartedAt = Date.now();
  for (let hop = 0; hop <= LIMITS.maxHops; hop++) {
    state.redirectTo = null;
    const navTimeout = Math.max(1000, Math.min(15_000, remaining() - 1000));
    res = await page.goto(current, { waitUntil: 'domcontentloaded', timeout: navTimeout }).catch((err) => ({ __error: err }));
    if (res && res.__error) {
      // A navigation the handler stopped (a refusal or a validated redirect) is reported as aborted.
      if (state.blocked) return { url: url.href, blocked: state.blocked };
      if (!state.redirectTo) throw res.__error;
      res = null;
    }
    if (state.blocked) return { url: url.href, blocked: state.blocked };
    if (!state.redirectTo) break;
    if (hop === LIMITS.maxHops) return { url: url.href, blocked: 'bounded' };
    current = state.redirectTo;
  }
  if (!res) return { url: url.href, blocked: state.blocked || 'not-allowed' };
  let status = res.status();
  state.finalUrl = page.url() || res.url() || state.finalUrl;
  await page.waitForTimeout(Math.max(0, Math.min(800, remaining() - 2500)));
  if (state.pending.length) await withTimeout(Promise.allSettled(state.pending.splice(0)), 1500).catch(() => {});
  const readiness = captureScreening ? await waitForPageReady(page, {
    budgetMs: 7000, remainingMs: Math.max(0, remaining() - 2000), requestedUrl: url.href, navigationStartedAt,
    isBlocked: () => state.docChallenge || state.blocked || (state.documentStatus >= 400 ? 'The page did not answer successfully.' : null),
  }) : null;
  let counts = await withTimeout(page.evaluate(countStylesheetsInPage), 1500).catch(() => ({ linked: 0, applied: 0 }));
  const settle = Date.now() + Math.max(0, Math.min(1500, remaining() - 2000));
  while (counts.linked > counts.applied && Date.now() < settle) {
    await page.waitForTimeout(250);
    counts = await withTimeout(page.evaluate(countStylesheetsInPage), 1000).catch(() => counts);
  }
  status = state.documentStatus || status;
  const challenged = state.docChallenge || isChallenge({ url: state.finalUrl, status, headers: state.documentHeaders }) || null;
  const failures = [...state.stylesheets.values()].filter((e) => e.outcome !== 'ok');
  const styling = assessStyling({ linked: counts.linked, applied: counts.applied, failures });
  // Measurements are taken against the configured screen: in phone emulation Chromium grows
  // the layout viewport to fit wide content, so window.innerWidth is not the screen width.
  const screen = view === 'phone' ? PHONE : DESKTOP;
  const read = status < 400 && !challenged
    ? await withTimeout(page.evaluate(readPageInBrowser, { textLimit: TEXT_LIMIT, maxControls: MAX_CONTROLS, coverPercent: OVERLAY_COVER_PERCENT, screenWidth: screen.width, screenHeight: screen.height }), 4000).catch(() => null)
    : null;
  const decoded = new Set(read?.decodedImages || []);
  let screening;
  if (captureScreening) {
    screening = { status: 'unavailable', images: [], readiness };
    if (read && status >= 200 && status < 400 && !challenged && !styling.unreliable && !state.redirectedCode && readiness?.status === 'ready') {
      try {
        const captured = [];
        const documentNumber = state.documents;
        const height = await withTimeout(page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0)), 1000);
        const bottom = Math.max(0, Math.min(30_000, height - screen.height));
        const offsets = [...new Set([0, Math.round(bottom / 2), bottom])];
        for (const offset of offsets) {
          if (remaining() < 1200 || state.blocked || state.docChallenge) throw new Error('Content sampling interrupted');
          await withTimeout(page.evaluate(y => scrollTo(0, y), offset), 1000);
          await page.waitForTimeout(350);
          const visibleImages = await waitForVisibleImages(page, Math.min(7000, Math.max(0, remaining() - 1500)));
          if (!visibleImages || visibleImages.some(img => !img.decoded && state.imageStatus.get(img.url)?.outcome !== 'broken')) throw new Error('Visible images could not be read');
          if (state.documents !== documentNumber || state.documentStatus >= 400 || state.blocked || state.docChallenge) throw new Error('Document changed during capture');
          const bytes = await page.screenshot({ type: 'jpeg', quality: 65, fullPage: false, animations: 'disabled', timeout: Math.min(2000, Math.max(1, remaining() - 300)) });
          if (state.documents !== documentNumber || state.blocked || state.docChallenge) throw new Error('Document changed during capture');
          if (!bytes.length || bytes.length > 1_450_000) throw new Error('Image sample exceeds its limit');
          captured.push(`data:image/jpeg;base64,${bytes.toString('base64')}`);
        }
        screening = { status: 'captured', images: captured, readiness };
      } catch { /* An incomplete capture is not evidence that content is safe. */ }
    }
  }
  return {
    url: url.href, finalUrl: state.finalUrl, status: state.documentStatus || status, view,
    challenged: challenged ? String(challenged.reason || 'A bot check answered instead of the page') : null,
    render: { reliable: !styling.unreliable && !state.redirectedCode, linked: counts.linked, applied: counts.applied,
      reason: state.redirectedCode ? 'A stylesheet or script redirected; its relative resource addresses could not be verified by this check.' : styling.reason || '' },
    // A measurement that could not be taken is null, never a value that reads as success.
    text: read ? read.text : null, textLength: read ? read.textLength : null, controls: read ? read.controls : [],
    viewportMeta: read ? read.viewportMeta : null, overflow: read ? read.overflow : null, overlay: read ? read.overlay : null,
    images: [...wanted].filter((u) => state.imageStatus.has(u)).map((u) => {
      const image = state.imageStatus.get(u);
      return { url: u, ...image, outcome: image.outcome === 'loaded' && !decoded.has(u) ? 'unavailable' : image.outcome };
    }),
    requests: { ...state.requests },
    ...(screening ? { screening } : {}),
  };
}

async function waitForVisibleImages(page, budgetMs) {
  const deadline = Date.now() + budgetMs;
  do {
    const images = await withTimeout(page.evaluate(() => [...document.images].filter(img => {
      const rect = img.getBoundingClientRect(), style = getComputedStyle(img);
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
    }).slice(0, 200).map(img => ({ url: img.currentSrc || img.src, complete: img.complete, decoded: img.naturalWidth > 0 }))), Math.max(1, Math.min(1000, deadline - Date.now())));
    if (images.every(img => img.complete)) return images;
    const left = deadline - Date.now();
    if (left <= 0) break;
    await page.waitForTimeout(Math.min(150, left));
  } while (Date.now() < deadline);
  return null;
}

// Runs inside the page.
function countStylesheetsInPage() {
  const links = [...document.querySelectorAll('link[rel~="stylesheet"][href]')].filter((l) => !l.disabled && !/^print$/i.test(l.media || ''));
  let applied = 0;
  for (const sheet of document.styleSheets) { try { if (sheet.href && !sheet.disabled) applied++; } catch {} }
  return { linked: links.length, applied: Math.min(applied, links.length) };
}
function readPageInBrowser({ textLimit, maxControls, coverPercent, screenWidth, screenHeight }) {
  const vw = screenWidth || window.innerWidth, vh = screenHeight || window.innerHeight;
  const doc = document.documentElement, body = document.body;
  let full = (body && body.innerText) || '';
  full = full.replace(/[ \t\u00a0]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };
  const textOf = (el) => {
    let t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) t = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('value') || '';
    return t.replace(/\s+/g, ' ').trim().slice(0, 60);
  };
  const controls = [];
  for (const el of document.querySelectorAll('a[href], button, [role="button"], input[type="submit"], input[type="button"]')) {
    if (controls.length >= maxControls) break;
    if (!visible(el)) continue;
    const kind = el.tagName === 'A' ? 'link' : 'button';
    controls.push({ n: controls.length + 1, kind, text: textOf(el), ...(kind === 'link' ? { href: String(el.getAttribute('href') || '').slice(0, 300) } : {}) });
  }
  let overlay = { present: false, coversPercent: 0, closeControl: false };
  const area = Math.max(1, vw * vh);
  let seen = 0;
  for (const el of document.querySelectorAll('body *')) {
    if (++seen > 1500) break;
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)), h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const percent = Math.round((w * h * 100) / area);
    if (percent < coverPercent || percent <= overlay.coversPercent) continue;
    const close = [...el.querySelectorAll('button, a, [role="button"], [aria-label]')].some((c) => /close|dismiss|accept|agree|got it|okay|^ok$|^x$|\u00d7/i.test(textOf(c)));
    overlay = { present: true, coversPercent: percent, closeControl: close };
  }
  return {
    text: full.slice(0, textLimit), textLength: full.length, controls,
    decodedImages: [...document.images].slice(0, 200).filter(img => img.complete && img.naturalWidth > 0).map(img => img.currentSrc || img.src),
    viewportMeta: Boolean(document.querySelector('meta[name="viewport"]')),
    overflow: { scrollWidth: Math.max(doc ? doc.scrollWidth : 0, body ? body.scrollWidth : 0, window.innerWidth || 0), innerWidth: vw },
    overlay,
  };
}

/**
 * Site owners can opt out; the same DNS and robots rules as a fresh checkup, but the
 * robots request goes through the guarded fetch: the host must resolve publicly and
 * every redirect must stay on the same host and resolve publicly before it is sent.
 */
export async function siteOptedOut(host, { resolveTxt = (name) => dns.resolveTxt(name), resolve = resolveTarget, fetchGuarded = guardedFetch } = {}) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  if (!h) return null;
  try { const txt = await resolveTxt(`_sutros.${h}`); if (txt.flat().some((t) => /optout/i.test(t))) return 'dns'; } catch {}
  try {
    let current = new URL(`https://${h}/robots.txt`);
    for (let hop = 0; hop <= LIMITS.maxHops; hop++) {
      const r = await resolve(current).catch(() => null);
      const ip = r?.ok && Array.isArray(r.addresses) ? String(r.addresses[0] || '') : '';
      if (!net.isIP(ip) || !sameSite(current.hostname, h)) return null;
      const out = await fetchGuarded({ url: current, ip, headers: { 'user-agent': 'SutrosBot/0.1 (+https://sutros.org)' }, maxBytes: 20_000, timeoutMs: 5000 });
      if ([301, 302, 303, 307, 308].includes(out.status) && out.headers?.location) {
        const next = parse(new URL(String(out.headers.location), current).href);
        if (!next) return null;
        current = next;
        continue;
      }
      if (out.status !== 200 || !/text\/plain/i.test(String(out.headers?.['content-type'] || ''))) return null;
      let mine = false;
      for (const raw of out.body.toString('utf8').split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, '').trim();
        if (!line) { mine = false; continue; }
        const ua = line.match(/^user-agent:\s*(.+)$/i);
        if (ua) { mine = mine || /^sutrosbot$/i.test(ua[1].trim()); continue; }
        if (mine && /^disallow:\s*\/\s*$/i.test(line)) return 'robots';
      }
      return null;
    }
  } catch {}
  return null;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), ms); })]).finally(() => clearTimeout(timer));
}
