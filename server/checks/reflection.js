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

const MARKER = "plx" + Math.random().toString(36).slice(2, 8);
// Delimiter characters that MUST be escaped when reflected into HTML. No script.
const PROBE = `${MARKER}<'"`;

export async function runReflection(ctx) {
  const { facts, client } = ctx;
  const findings = [];
  const passes = [];
  const origin = facts.baseOrigin;

  // Test the homepage and a couple of crawled pages, preferring ones that
  // already take query parameters.
  const candidates = [];
  for (const page of (facts.pages || []).slice(0, 5)) {
    let u;
    try { u = new URL(page.url); } catch { continue; }
    candidates.push(u);
  }
  if (!candidates.length) return { findings, passes };

  const reflected = [];
  for (const base of candidates.slice(0, 4)) {
    const u = new URL(base.href);
    // If the page already has params, fuzz the first one; else add ?q=
    if ([...u.searchParams.keys()].length) {
      const key = [...u.searchParams.keys()][0];
      u.searchParams.set(key, PROBE);
    } else {
      u.searchParams.set("q", PROBE);
    }
    let res;
    try { res = await client.get(u.href); } catch { continue; }
    if (res.status >= 400) continue;
    let body = "";
    try { body = await res.text(200000); } catch { continue; }
    // Reflected AND the special characters came back unescaped (not &lt; / &#39;).
    if (body.includes(PROBE)) {
      reflected.push(u.pathname + u.search.replace(PROBE, `${MARKER}...`));
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
      evidence: { lines: reflected.slice(0, 4).map((r) => `special characters reflected at ${r}`), note: "A benign marker with delimiter characters was reflected unescaped. No script was injected." },
    });
  } else if (candidates.length) {
    passes.push("Your pages cleaned up the test input we sent (no obvious reflected-input risk).");
  }

  return { findings, passes };
}
