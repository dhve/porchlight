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
      userAgent: "PorchlightBot/0.1 (+https://github.com/dhve/porchlight)",
      viewport: { width: 390, height: 844 }, // a typical phone
    });
    const page = await context.newPage();

    const consoleErrors = [];
    page.on("pageerror", (err) => consoleErrors.push(String(err.message).slice(0, 160)));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 160));
    });

    const start = Date.now();
    await page.goto(facts.finalUrl.href, { waitUntil: "load", timeout: 15_000 });
    const loadMs = Date.now() - start;

    const brokenImgCount = await page.evaluate(() =>
      Array.from(document.images).filter((img) => img.complete && img.naturalWidth === 0).length
    );

    await browser.close();
    browser = null;

    if (consoleErrors.length) {
      findings.push({
        id: "console-errors",
        category: "quality",
        severity: "watch",
        title: "Your website is throwing errors in visitors' browsers",
        meaning:
          "As the page loaded, its own code reported errors. Visitors won't see the messages, but errors like these are often why a button or form quietly stops working.",
        fix: ["Show your web person these errors; they point straight to the broken script."],
        who: "Your web person.",
        evidence: { lines: [...new Set(consoleErrors)].slice(0, 4), note: `${consoleErrors.length} browser error(s) seen while loading the homepage.` },
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
