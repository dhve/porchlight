// Local fixture site for render tests. Serves a handful of pages that stand in for the
// real-world cases the browsing agent, the browser check, and the proof pictures must
// handle honestly: a healthy page, a stylesheet answered by a hosting bot check, a bot
// check for the document itself (SiteGround and Cloudflare flavours), a stylesheet that
// really is missing, one that fails once and then works, a slow stylesheet, and a page
// with no stylesheet at all. Every request is logged so tests can prove retries happened.
import http from "node:http";

const SG_CHALLENGE = (path) =>
  `<html><head><link rel="icon" href="data:;"><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=${encodeURIComponent(path)}&y=ipc:127.0.0.1:1788970115.820"></meta></head></html>`;
const CF_CHALLENGE =
  `<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div id="challenge-platform"><h1>Just a moment...</h1><p>Checking if the site connection is secure</p><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></div></body></html>`;

const page = (title, css, extra = "") => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>${css ? `<link rel="stylesheet" href="${css}">` : ""}</head><body><header><h1>${title}</h1></header><nav><ul><li><a href="/healthy">Home</a></li><li><a href="/about">About</a></li><li><a href="/contact">Contact</a></li></ul></nav><main><p>Welcome to the fixture site. This paragraph exists so the page has readable text for the visitor.</p>${extra}</main></body></html>`;

const CSS = "body{background:#0b3d2e;color:#fff;margin:0}header{background:#1e8c63;padding:16px}a{color:#ffd66b}nav ul{list-style:none;display:flex;gap:12px;padding:12px}main{padding:16px}";

export async function startFixture() {
  const log = [];
  let flakyHits = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    log.push({ path: url.pathname, ua: req.headers["user-agent"] || "", accept: req.headers.accept || "" });
    const send = (status, type, body, headers = {}) => {
      res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body), ...headers });
      res.end(body);
    };
    switch (url.pathname) {
      case "/":
      case "/healthy": return send(200, "text/html; charset=utf-8", page("Healthy fixture", "/style.css"));
      case "/about": return send(200, "text/html; charset=utf-8", page("About the fixture", "/style.css"));
      case "/contact": return send(200, "text/html; charset=utf-8", page("Contact", "/style.css"));
      case "/style.css": return send(200, "text/css", CSS);
      case "/sgcss": return send(200, "text/html; charset=utf-8", page("Page whose stylesheet is challenged", "/sg.css"));
      case "/sg.css": return send(202, "text/html", SG_CHALLENGE("/sg.css"), { "set-cookie": "nevercache-b39818=Y;Max-Age=-1", "cache-control": "no-store,no-cache,max-age=0" });
      case "/sgdoc": return send(202, "text/html", SG_CHALLENGE("/sgdoc"), { "set-cookie": "nevercache-b39818=Y;Max-Age=-1", "x-robots-tag": "noindex" });
      case "/cfdoc": return send(503, "text/html; charset=utf-8", CF_CHALLENGE, { "cf-mitigated": "challenge", server: "cloudflare" });
      case "/broken": return send(200, "text/html; charset=utf-8", page("Page with a missing stylesheet", "/missing.css"));
      case "/missing.css": return send(404, "text/html; charset=utf-8", "<h1>Not Found</h1>");
      case "/flaky": return send(200, "text/html; charset=utf-8", page("Page whose stylesheet fails once", "/flaky.css"));
      case "/flaky.css":
        flakyHits++;
        if (flakyHits === 1) return send(404, "text/html; charset=utf-8", "<h1>Not Found</h1>");
        return send(200, "text/css", CSS);
      case "/slow": return send(200, "text/html; charset=utf-8", page("Page with a slow stylesheet", "/slow.css"));
      case "/slow.css": await new Promise((r) => setTimeout(r, 1500)); return send(200, "text/css", CSS);
      case "/bare": return send(200, "text/html; charset=utf-8", page("Page with no stylesheet", ""));
      case "/error": return send(500, "text/html; charset=utf-8", "<html><body><h1>Whoops, looks like something went wrong.</h1><pre>Stack trace: /var/www/app/index.php:12</pre></body></html>");
      case "/favicon.ico": return send(404, "text/plain", "");
      default: return send(404, "text/html; charset=utf-8", "<h1>Not Found</h1>");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    log,
    hits: (path) => log.filter((e) => e.path === path).length,
    resetFlaky: () => { flakyHits = 0; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * A minimal ctx.facts the checks expect, built from a fixture URL. The page is fetched from
 * `origin` (the loopback fixture); `publicOrigin` is the origin the facts name, so a test can
 * present the fixture under a public-looking hostname that a browser maps to the loopback
 * with a host-resolver alias.
 */
export async function factsFor(origin, path = "/healthy", publicOrigin = origin) {
  const cheerio = await import("cheerio");
  const fetchUrl = new URL(path, origin);
  const url = new URL(path, publicOrigin);
  const res = await fetch(fetchUrl.href);
  const html = await res.text();
  const $ = cheerio.load(html);
  return {
    reachable: true,
    finalUrl: url,
    baseOrigin: publicOrigin,
    isHttps: false,
    headers: res.headers,
    pages: [{ url: url.href, status: res.status, html, $, headers: res.headers, contentType: res.headers.get("content-type") || "" }],
    forms: [],
    scripts: [],
    contact: { emails: [], pages: [] },
  };
}

/**
 * A Chromium that answers `alias` from the loopback fixture, for checks whose safety guards
 * (rightly) refuse loopback and private addresses. Same shape as openBrowser()'s session.
 */
export async function aliasedSession(alias) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true, args: [`--host-resolver-rules=MAP ${alias} 127.0.0.1`] });
  return { browser, mode: "local", close: () => browser.close().catch(() => {}) };
}

/**
 * A scripted stand-in for the AI model: on the first turn it writes the given note,
 * on the second it finishes. Records every message it was shown so tests can read the
 * tool results the agent returned.
 */
export function scriptedModel(note, { extraOpen = null } = {}) {
  const seen = [];
  let turn = 0;
  const call = (name, args) => ({ id: `call_${turn}_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
  const model = async ({ messages }) => {
    seen.push(messages.map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content.filter((p) => p.type === "text").map((p) => p.text).join("\n") : "") })));
    turn++;
    if (extraOpen && turn === 1) return { message: { role: "assistant", content: "", tool_calls: [call("open", { url: extraOpen })] }, finishReason: "tool_calls" };
    const noteTurn = extraOpen ? 2 : 1;
    if (turn === noteTurn) return { message: { role: "assistant", content: "", tool_calls: [call("note", note)] }, finishReason: "tool_calls" };
    return { message: { role: "assistant", content: "", tool_calls: [call("finish", { summary: "Done looking." })] }, finishReason: "tool_calls" };
  };
  model.seen = seen;
  /** The tool result the agent returned for the note call, or "" */
  model.noteResult = () => {
    for (const turnMsgs of seen) for (const m of turnMsgs) if (m.role === "tool" && /note|recorded|not recorded|Noted/i.test(m.content)) return m.content;
    const last = seen[seen.length - 1] || [];
    return last.filter((m) => m.role === "tool").map((m) => m.content).join("\n");
  };
  /** Every observation text the model was shown, joined */
  model.observations = () => seen.flat().filter((m) => /Observation:/.test(m.content)).map((m) => m.content).join("\n");
  return model;
}
