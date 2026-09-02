// browser.js
// Step 4 (optional): the real "acts like a customer" agent. When Playwright is
// installed, we load the page in a headless browser and watch what a visitor's
// browser would experience: JavaScript errors, how long it takes to appear, and
// images that fail at render time.
//
// Playwright is heavy (~300MB of browsers), so it is an OPTIONAL dependency.
// If it isn't installed, this check reports skipped:true and the pipeline notes
// that the deeper pass was not run. Turn it on with:  npm run enable-browser
//
// Read-only: we navigate and observe. We do not submit forms or click through
// checkout, so nothing on the site is changed.

export async function runBrowser(ctx) {
  const { facts } = ctx;
  const findings = [];
  const passes = [];

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return { findings, passes, skipped: true, reason: "Playwright not installed (run: npm run enable-browser)" };
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: "SutrosBot/0.1 (+https://sutros.org)",
      viewport: { width: 390, height: 844 }, // a typical phone
    });
    const page = await context.newPage();

    const consoleErrors = []; // real JavaScript errors, with where they came from
    const failed = new Map();  // url -> { status, reason }
    page.on("pageerror", (err) => consoleErrors.push(String(err.message).slice(0, 200)));
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      if (/^Failed to load resource/i.test(text)) return; // captured below with its URL
      const loc = msg.location && msg.location();
      const where = loc && loc.url ? ` (at ${loc.url}${loc.lineNumber ? ":" + loc.lineNumber : ""})` : "";
      consoleErrors.push((text.slice(0, 160) + where).slice(0, 260));
    });
    page.on("response", (res) => {
      const st = res.status();
      if (st >= 400 && !failed.has(res.url())) failed.set(res.url(), { status: st, reason: statusText(st) });
    });
    page.on("requestfailed", (req) => {
      if (!failed.has(req.url())) failed.set(req.url(), { status: 0, reason: (req.failure() && req.failure().errorText) || "did not load" });
    });

    const start = Date.now();
    await page.goto(facts.finalUrl.href, { waitUntil: "load", timeout: 15_000 });
    const loadMs = Date.now() - start;

    const brokenImgCount = await page.evaluate(() =>
      Array.from(document.images).filter((img) => img.complete && img.naturalWidth === 0).length
    );

    await browser.close();
    browser = null;

    const failedList = [...failed.entries()]
      .filter(([u]) => !/\/favicon\.ico$/i.test(u))
      .map(([url, f]) => ({ url, ...f }));
    if (failedList.length) {
      const shown = failedList.slice(0, 6);
      findings.push({
        id: "failed-resources",
        category: "quality",
        severity: "watch",
        title: `${failedList.length} file${failedList.length > 1 ? "s" : ""} on your homepage fail${failedList.length > 1 ? "" : "s"} to load`,
        meaning:
          "When the homepage loads, it asks for these files and the server refuses or cannot find them. Whatever each file provides (a script, image, font, or stylesheet) is simply missing for visitors. The exact address and status of each one is under the technical proof.",
        fix: [
          "Open each address listed. A 404 means the file was moved or deleted: fix the link or restore the file.",
          "A 403 or 406 means the server is refusing that request, usually a security rule, hotlink protection, or a wrong file type setting on the server.",
          "Remove any reference the page no longer needs.",
        ],
        who: "Your web person.",
        evidence: {
          lines: shown.map((f) => `${f.status ? f.status + " " + f.reason : f.reason}  ${f.url.slice(0, 140)}`),
          note: `${failedList.length} request(s) failed while loading the homepage in a headless browser.`,
        },
      });
    }

    if (consoleErrors.length) {
      findings.push({
        id: "console-errors",
        category: "quality",
        severity: "watch",
        title: "Your website's code is reporting errors in visitors' browsers",
        meaning:
          "As the page loaded, its own scripts reported errors (each one is listed with the file and line it came from). Visitors do not see the messages, but errors like these are often why a menu, form, or button quietly stops working.",
        fix: ["Show your web person the errors under the technical proof; each names the script and line that failed."],
        who: "Your web person.",
        evidence: { lines: [...new Set(consoleErrors)].slice(0, 5), note: `${consoleErrors.length} JavaScript error(s) seen while loading the homepage.` },
      });
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
        evidence: { lines: [`homepage load: ${(loadMs / 1000).toFixed(1)}s on a simulated phone`], note: "Measured in a headless browser." },
      });
    } else if (loadMs) {
      passes.push(`Your homepage loaded in about ${(loadMs / 1000).toFixed(1)}s on a phone.`);
    }

    if (brokenImgCount > 0) {
      findings.push({
        id: "broken-images-render",
        category: "quality",
        severity: "watch",
        title: `${brokenImgCount} image${brokenImgCount > 1 ? "s" : ""} failed to display`,
        meaning: "Some images failed to render when the page actually loaded, so visitors see blank spaces or broken-image icons.",
        fix: ["Re-upload the affected images or fix the links to them."],
        who: "You can often do this yourself.",
        evidence: { lines: [`${brokenImgCount} image(s) with no rendered content`], note: "Observed in a headless browser." },
      });
    }

    return { findings, passes };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return { findings, passes, skipped: true, reason: `Browser pass failed: ${String(err.message).slice(0, 120)}` };
  }
}

function statusText(code) {
  const map = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 406: "Not Acceptable", 408: "Request Timeout", 410: "Gone", 429: "Too Many Requests", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout" };
  return map[code] || (code >= 500 ? "Server Error" : "Error");
}
