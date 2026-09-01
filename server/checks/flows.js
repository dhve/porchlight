// flows.js
// Step 4: act like a customer. Find the pages a real visitor cares about, the
// "Order", "Book", "Menu", "Contact" style links, and confirm they actually
// load instead of throwing an error. This is the no-browser version of walking
// through the site; browser.js adds console-level detail when Playwright is on.
//
// Deterministic. Read-only GETs of pages linked from the homepage.

const INTENT = [
  { re: /\b(order|checkout|cart|buy|shop|store)\b/i, name: "ordering" },
  { re: /\b(book|reserve|reservation|appointment|schedule)\b/i, name: "booking" },
  { re: /\b(menu)\b/i, name: "menu" },
  { re: /\b(contact|get in touch)\b/i, name: "contact" },
];

export async function runFlows(ctx) {
  const { client, facts } = ctx;
  const findings = [];
  const passes = [];
  const $ = facts.$;
  const origin = facts.baseOrigin;
  if (!$ || !origin) return { findings, passes };

  // Collect same-origin links whose text or href looks like a key action.
  const candidates = new Map(); // url -> intent name
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    const text = ($(el).text() || "").trim();
    let abs;
    try {
      abs = new URL(href, origin);
    } catch {
      return;
    }
    if (abs.origin !== origin) return;
    for (const intent of INTENT) {
      if (intent.re.test(text) || intent.re.test(abs.pathname)) {
        if (!candidates.has(abs.href)) candidates.set(abs.href, intent.name);
        break;
      }
    }
  });

  const list = [...candidates.entries()].slice(0, 6);
  let checked = 0;
  for (const [href, name] of list) {
    let res;
    try {
      res = await client.get(href);
    } catch {
      continue;
    }
    checked++;
    if (res.status >= 500) {
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
        evidence: { lines: [`GET ${href}`, `<- ${res.status} ${statusText(res.status)}`], note: `Reproduced while following the "${name}" link from your homepage.` },
      });
    } else if (res.status >= 400) {
      findings.push({
        id: `flow-missing-${name}`,
        category: "broken-flow",
        severity: "serious",
        title: `Your ${name} link is broken`,
        meaning: `Your ${name} link points to a page that no longer exists (a "not found" error). Customers clicking it hit a dead end.`,
        fix: [`Point the ${name} link to the correct page, or remove it if it's no longer used.`],
        who: "You or your web person.",
        evidence: { lines: [`GET ${href}`, `<- ${res.status} ${statusText(res.status)}`], note: "Followed from the homepage." },
      });
    }
  }

  if (checked && !findings.length) {
    passes.push("Your key customer pages (like ordering and contact) load without errors.");
  }

  return { findings, passes };
}

function statusText(code) {
  const map = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout" };
  return map[code] || "";
}
