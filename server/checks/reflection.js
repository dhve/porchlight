// reflection.js
// Step 4: a conservative check for reflected input, the surface where reflected
// cross-site scripting (XSS) lives. We add one harmless, uniquely-named marker
// to a page's query string and see whether the site echoes our special
// characters back into the page WITHOUT escaping them.
//
// This is intentionally cautious:
//  - it never injects a <script> tag or anything that executes
//  - the marker is a random token plus a few delimiter characters
//  - a hit is reported as "worth a developer's review", not a confirmed exploit
//
// It flags surface, it does not weaponize it.
//
// The finding carries evidence.pages (the pages that echoed the marker) and
// evidence.method (how we tested it). A 401, 403, 405, 406, 429, or 503 answer
// means the site refused our checker and is never read as a reflection. After
// two 429 answers we stop probing and set facts.throttled.

const MARKER = "plx" + Math.random().toString(36).slice(2, 8);
// Delimiter characters that MUST be escaped when reflected into HTML. No script.
const PROBE = `${MARKER}<'"`;

export async function runReflection(ctx) {
  const { facts, client } = ctx;
  const findings = [];
  const passes = [];
  const origin = facts.baseOrigin;
  const homepage = homepageOf(facts);
  const throttle = { count: 0, stop: false };

  // Test the homepage and a couple of crawled pages, preferring ones that
  // already take query parameters.
  const candidates = [];
  for (const page of (facts.pages || []).slice(0, 5)) {
    let u;
    try { u = new URL(page.url); } catch { continue; }
    candidates.push(u);
  }
  if (!candidates.length) return { findings, passes };
  if (facts.throttled) await pause(3000);

  const reflected = []; // human lines
  const reflectedPages = []; // absolute page URLs that echoed the marker
  let probed = 0; // pages that answered normally and whose body we read
  for (const base of candidates.slice(0, 4)) {
    if (throttle.stop || !client) break;
    const u = new URL(base.href);
    // If the page already has params, fuzz the first one; else add ?q=
    if ([...u.searchParams.keys()].length) {
      const key = [...u.searchParams.keys()][0];
      u.searchParams.set(key, PROBE);
    } else {
      u.searchParams.set("q", PROBE);
    }
    let res;
    try {
      res = await client.get(u.href);
    } catch (err) {
      if (err && err.code === "BUDGET") break; // nothing more will answer this checkup
      continue;
    }
    noteStatus(facts, throttle, res.status);
    // A refusal (401, 403, 429, 503) or any other error answer is not the page
    // echoing our input; it is never read as a reflection.
    if (res.status >= 400) { release(res); continue; }
    let body = "";
    try { body = await res.text(200000); } catch { continue; }
    probed++;
    // Reflected AND the special characters came back unescaped (not &lt; / &#39;).
    if (body.includes(PROBE)) {
      // URLSearchParams percent-encodes the probe, so match the encoded form when shortening the line.
      const encodedProbe = new URLSearchParams({ x: PROBE }).toString().slice(2);
      reflected.push(u.pathname + u.search.split(encodedProbe).join(`${MARKER}...`));
      reflectedPages.push(base.href);
    }
  }

  if (reflected.length) {
    findings.push({
      id: "reflected-input",
      category: "injection",
      severity: "serious",
      title: "Your site echoes visitor input without cleaning it",
      meaning:
        "When we sent a harmless test value in the web address, the page repeated our special characters back exactly, without neutralizing them. That is what a cross-site scripting (XSS) attack relies on to run malicious code in your visitors' browsers. We did not attempt any attack. A developer can fix this quickly, and it is worth doing.",
      fix: [
        "Ask your web person to escape or sanitize anything from the URL or a form before it is placed back on the page.",
        "This is a common and well-understood fix in every web framework.",
      ],
      who: "Your web person, this is worth prioritizing.",
      evidence: {
        lines: reflected.slice(0, 4).map((r) => `special characters reflected at ${r}`),
        note: "A benign marker with delimiter characters was reflected unescaped. No script was injected.",
        method: "We added a harmless marker made of random letters plus the characters < ' and \" to the address of each page and loaded it, then checked whether the page printed those characters back without escaping them. We sent no script and attempted no attack.",
        pages: uniq(reflectedPages, homepage),
      },
    });
  } else if (probed > 0) {
    // Only a page that answered normally can be said to have cleaned up the input.
    passes.push("Your pages cleaned up the test input we sent (no obvious reflected-input risk).");
  }

  return { findings, passes };
}

// ---- helpers ----

// Count 429 answers; after two, stop probing in this check and tell the pipeline.
function noteStatus(facts, throttle, status) {
  if (status !== 429) return;
  throttle.count++;
  if (throttle.count >= 2) {
    throttle.stop = true;
    facts.throttled = true;
  }
}

function href(u) {
  if (!u) return "";
  if (typeof u === "string") return u;
  return u.href || String(u);
}

// Let go of a body we are not going to read, so the connection is released.
function release(res) {
  try { if (res && typeof res.discard === "function") res.discard(); } catch {}
}

function homepageOf(facts) {
  return href(facts.finalUrl) || href(facts.pages && facts.pages[0] && facts.pages[0].url) || (facts.baseOrigin ? facts.baseOrigin + "/" : "");
}

// Distinct, non-empty entries in order, at most six; fall back to the homepage.
function uniq(list, fallback, max = 6) {
  const out = [];
  for (const x of list) {
    if (x && !out.includes(x)) out.push(x);
    if (out.length >= max) break;
  }
  return out.length ? out : (fallback ? [fallback] : []);
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
