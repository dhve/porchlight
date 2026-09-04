// flows.js
// Step 4: act like a customer. Find the pages a real visitor cares about, the
// "Order", "Book", "Menu", "Contact" style links, and confirm they actually
// load instead of throwing an error. This is the no-browser version of walking
// through the site; browser.js adds console-level detail when Playwright is on.
//
// Deterministic. Read-only GETs of pages linked from the homepage. An error
// answer gets one more look with standard browser headers, so a site that only
// refuses automated checkers (401, 403, 405, 406, 429, 503) is never called a
// broken flow. Only 404/410 (missing) and 500/502/504 (error) count, and only
// when both tries agree.

import { probeAddress, createThrottleGuard, sleep } from "../lib/http.js";

const INTENT = [
  { re: /\b(order|checkout|cart|buy|shop|store)\b/i, name: "ordering" },
  { re: /\b(book|reserve|reservation|appointment|schedule)\b/i, name: "booking" },
  { re: /\b(menu)\b/i, name: "menu" },
  { re: /\b(contact|get in touch)\b/i, name: "contact" },
];

const PACE_MS = 250;

export async function runFlows(ctx) {
  const { client, facts } = ctx;
  const findings = [];
  const passes = [];
  const $ = facts && facts.$;
  const origin = facts && facts.baseOrigin;
  if (!$ || !origin || !client) return { findings, passes };
  const homepage = (facts.finalUrl && facts.finalUrl.href) || origin + "/";

  // Collect same-origin links whose text or href looks like a key action.
  const candidates = new Map(); // url -> { name, text }
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    const text = ($(el).text() || "").replace(/\s+/g, " ").trim().slice(0, 60);
    let abs;
    try {
      abs = new URL(href, homepage);
    } catch {
      return;
    }
    if (abs.origin !== origin) return;
    if (!/^https?:$/.test(abs.protocol)) return;
    abs.hash = "";
    for (const intent of INTENT) {
      if (intent.re.test(text) || intent.re.test(abs.pathname)) {
        if (!candidates.has(abs.href)) candidates.set(abs.href, { name: intent.name, text });
        break;
      }
    }
  });

  const list = [...candidates.entries()].slice(0, 6);
  const throttle = createThrottleGuard(facts, 2);
  let sent = 0;
  const pace = async () => {
    if (sent++ > 0) await sleep(PACE_MS);
  };

  let loaded = 0;
  for (const [href, { name, text }] of list) {
    if (throttle.stopped) break; // the site asked us to slow down; leave the rest untested
    const r = await probeAddress(client, href, { headFirst: false, throttle, pace });
    if (r.verdict === "ok") {
      loaded++;
      continue;
    }
    if (r.verdict !== "broken") continue; // blocked or inconclusive: not a broken flow

    const path = pathOf(href, origin);
    const label = text ? `link "${text}"` : "link";
    const answer = r.status > 0 ? `${r.status} ${r.statusText}` : r.statusText;
    const lines = [
      `${answer}  ${path}  (${label} on ${pathOf(homepage, origin)})`,
      r.retried
        ? `Tried again with standard browser headers after a short wait: ${answer}.`
        : `The connection failed before the site answered (${r.statusText}).`,
    ];
    const items = [{ url: href, status: r.status, statusText: r.statusText, page: homepage, text: text || "", kind: "page" }];
    const method = r.retried
      ? `We followed the ${name} ${label} from the homepage with a plain GET request, then waited and requested the same address once more with standard browser headers. ` +
        `We report it only because both tries failed, and the second answer was ${answer}.`
      : `We followed the ${name} ${label} from the homepage with a plain GET request. ` +
        `We report it because the connection failed before the site answered (${r.statusText}).`;

    if (r.status >= 500 || r.status === 0) {
      findings.push({
        id: `flow-error-${name}`,
        category: "broken-flow",
        severity: "urgent",
        title: `Your ${name} page leads to an error`,
        meaning: `When we followed your ${name} link the way a customer would, the page returned a server error instead of loading. You may be losing customers at exactly the moment they're trying to act.`,
        fix: [
          `Open your ${name} page yourself to confirm the error.`,
          "Show your web person this report; a server error usually points to a broken plugin or setting.",
          "Ask them to test the full flow end to end before calling it fixed.",
        ],
        who: "Your web person.",
        evidence: { lines, items, pages: [homepage], method, note: `Reproduced while following the "${name}" link from the homepage.` },
      });
    } else {
      findings.push({
        id: `flow-missing-${name}`,
        category: "broken-flow",
        severity: "serious",
        title: `Your ${name} link is broken`,
        meaning: `Your ${name} link points to a page that no longer exists (a "not found" error). Customers clicking it hit a dead end.`,
        fix: [`Point the ${name} link to the correct page, or remove it if it's no longer used.`],
        who: "You or your web person.",
        evidence: { lines, items, pages: [homepage], method, note: "Followed from the homepage." },
      });
    }
  }

  if (loaded && !findings.length) {
    passes.push("Your key customer pages (like ordering and contact) load without errors.");
  }

  return { findings, passes };
}

function pathOf(u, origin) {
  try {
    const x = new URL(u);
    if (x.origin === origin) return (x.pathname + x.search) || "/";
    return x.href;
  } catch {
    return String(u);
  }
}
