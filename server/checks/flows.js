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
// when both tries agree. A connection that never got an answer (refused, reset,
// timed out, unresolved) is a gap in coverage, never a finding: it happened
// between our network and the site and says nothing about visitors.

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
  let broken = 0;
  let blocked = 0;
  let inconclusive = 0;
  let unreachable = 0;
  let unreachableText = "";
  const inconsistent = []; // an error answer that did not repeat: both observations are kept
  let untested = 0;
  let outOfBudget = false;
  for (const [href, { name, text }] of list) {
    if (throttle.stopped || outOfBudget) { untested++; continue; }
    const r = await probeAddress(client, href, { headFirst: false, throttle, pace });
    if (r.reason === "budget") { outOfBudget = true; untested++; continue; }
    if (r.verdict === "ok") {
      loaded++;
      continue;
    }
    if (r.verdict === "blocked") { blocked++; continue; }
    // No HTTP answer at all: a gap, never a finding.
    if (r.verdict !== "broken" || !(r.status > 0)) {
      if (r.transport) { unreachable++; unreachableText = unreachableText || r.statusText; }
      else if (r.reason === "mismatch" || r.reason === "single-error") inconsistent.push(`${r.firstStatus ? r.firstStatus : (r.firstText || "no answer")} then ${r.status}`);
      else inconclusive++;
      continue;
    }
    broken++;

    const path = pathOf(href, origin);
    const label = text ? `link "${text}"` : "link";
    const answer = `${r.status} ${r.statusText}`;
    const lines = [
      `${answer}  ${path}  (${label} on ${pathOf(homepage, origin)})`,
      `Tried again with standard browser headers after a short wait: ${answer}.`,
    ];
    const items = [{ url: href, status: r.status, statusText: r.statusText, page: homepage, text: text || "", kind: "page" }];
    const method =
      `We followed the ${name} ${label} from the homepage with a plain GET request, then waited and requested the same address once more with standard browser headers. ` +
      `We report it only because both tries answered with an error, and the second answer was ${answer}. A connection that fails without an answer is never reported this way.`;

    if (r.status >= 500) {
      findings.push({
        id: `flow-error-${name}`,
        category: "broken-flow",
        severity: "urgent",
        title: `The ${name} page answered with a server error`,
        meaning: `When Sutros followed the ${name} link the way a visitor would, the server answered ${answer} both times, once with standard browser headers. A server-error status usually means the site's own code or a plugin failed while building that page. It is what our checker received; please open the page yourself to see whether visitors get the same.`,
        fix: [
          `Open the ${name} page yourself and see whether it loads for you.`,
          "If it fails for you too, show your web person this report; a server error usually points to a broken plugin or setting.",
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
        title: `The ${name} link answered with a not-found error`,
        meaning: `When Sutros followed the ${name} link, the destination answered ${answer} both times, once with standard browser headers. That usually means the page has moved or been removed. It is what our checker received; please select the link yourself to see whether it opens for you.`,
        fix: [`If it fails for you too, point the ${name} link to the correct page, or remove it if it is no longer used.`],
        who: "You or your web person.",
        evidence: { lines, items, pages: [homepage], method, note: "Followed from the homepage." },
      });
    }
  }

  const complete = loaded + broken === list.length;
  if (complete && loaded && !findings.length) {
    passes.push(`The ${loaded} sampled customer page${loaded === 1 ? "" : "s"} loaded without errors.`);
  }

  if (complete) return { findings, passes, status: "completed" };
  let reason = `${loaded + broken} of ${list.length} sampled customer pages gave conclusive results (${loaded} working, ${broken} broken).`;
  if (blocked) reason += ` Refused or blocked by the site: ${blocked}.`;
  if (unreachable) reason += ` Could not connect from our network: ${unreachable} (${unreachableText}). A connection that fails without an answer does not show what visitors see.`;
  if (inconsistent.length) reason += ` Error answers that did not repeat: ${inconsistent.length} (${inconsistent[0]}); one error answer is not confirmation.`;
  if (inconclusive) reason += ` No conclusive answer: ${inconclusive}.`;
  if (untested) {
    reason += throttle.reason === "unreachable"
      ? ` Left untested after repeated connection failures: ${untested}.`
      : ` Left untested after a site limit or the request budget: ${untested}.`;
  }
  return { findings, passes, status: "inconclusive", reason };
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
