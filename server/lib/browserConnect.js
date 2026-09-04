// browserConnect.js
// One place that hands out a browser for the checks that need one: the visitor
// simulation, the page pictures in the technical proof, and the browsing agent.
//
// Three ways to get a browser, in order of preference:
//   1. BROWSER_WS_ENDPOINT   a hosted Chrome that speaks the DevTools protocol
//                            (Browserless, Steel, Hyperbrowser, a self-hosted
//                            browserless container). BROWSER_CONNECT=playwright
//                            switches to Playwright's own wire protocol for hosts
//                            that expose a /playwright endpoint.
//   2. BROWSERBASE_API_KEY   Browserbase: one REST call creates an isolated
//      + BROWSERBASE_PROJECT_ID  session, then we connect to its CDP URL.
//   3. local Chromium         Playwright's bundled browser on this machine.
//
// Hosted browsers give every checkup a clean profile and a different egress
// address, and keep Chromium off the small droplet that runs Sutros.

const REMOTE_TIMEOUT_MS = 20_000;

export function browserMode() {
  if (process.env.BROWSER_WS_ENDPOINT) return "remote";
  if (process.env.BROWSERBASE_API_KEY && process.env.BROWSERBASE_PROJECT_ID) return "browserbase";
  return "local";
}

/**
 * @returns {Promise<{browser: import("playwright").Browser, mode: string, close: () => Promise<void>, session?: object}>}
 */
export async function openBrowser({ purpose = "checkup" } = {}) {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    const e = new Error("Playwright not installed (run: npm run enable-browser)");
    e.code = "NO_PLAYWRIGHT";
    throw e;
  }

  const mode = browserMode();
  if (mode === "remote") {
    const ws = process.env.BROWSER_WS_ENDPOINT;
    const browser = process.env.BROWSER_CONNECT === "playwright"
      ? await chromium.connect(ws, { timeout: REMOTE_TIMEOUT_MS })
      : await chromium.connectOverCDP(ws, { timeout: REMOTE_TIMEOUT_MS });
    return { browser, mode, close: () => browser.close().catch(() => {}) };
  }

  if (mode === "browserbase") {
    const session = await createBrowserbaseSession(purpose);
    const browser = await chromium.connectOverCDP(session.connectUrl, { timeout: REMOTE_TIMEOUT_MS });
    return {
      browser,
      mode,
      session: { id: session.id, replayUrl: session.id ? `https://www.browserbase.com/sessions/${session.id}` : null },
      close: async () => {
        await browser.close().catch(() => {});
        await releaseBrowserbaseSession(session.id).catch(() => {});
      },
    };
  }

  const browser = await chromium.launch({ headless: true });
  return { browser, mode, close: () => browser.close().catch(() => {}) };
}

async function createBrowserbaseSession(purpose) {
  const res = await fetch("https://api.browserbase.com/v1/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-bb-api-key": process.env.BROWSERBASE_API_KEY },
    body: JSON.stringify({
      projectId: process.env.BROWSERBASE_PROJECT_ID,
      keepAlive: false,
      timeout: 180,
      userMetadata: { app: "sutros", purpose },
    }),
    signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Browserbase session failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  if (!data.connectUrl) throw new Error("Browserbase session had no connectUrl");
  return data;
}

async function releaseBrowserbaseSession(id) {
  if (!id) return;
  await fetch(`https://api.browserbase.com/v1/sessions/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-bb-api-key": process.env.BROWSERBASE_API_KEY },
    body: JSON.stringify({ projectId: process.env.BROWSERBASE_PROJECT_ID, status: "REQUEST_RELEASE" }),
    signal: AbortSignal.timeout(10_000),
  });
}
