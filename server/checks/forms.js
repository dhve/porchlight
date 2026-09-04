// forms.js
// Step 4: look at the forms a visitor would use (collected during the crawl).
//  - login or password forms that submit over an insecure connection
//  - forms that post to a different site
//  - password fields the browser is told to remember
//  - missing anti-CSRF token on forms that change things (heuristic)
//  - external scripts loaded without Subresource Integrity (SRI)
//
// Deterministic and structural. We never submit any form.
//
// Every finding carries evidence.pages (the pages the forms or scripts were
// found on) and evidence.method (how we tested it). Nothing here requests an
// address, so there are no evidence.items.

export async function runForms(ctx) {
  const { facts } = ctx;
  const findings = [];
  const passes = [];
  const forms = facts.forms || [];
  const homepage = homepageOf(facts);

  // ---- login/password forms over http, or posting off-site ----
  const insecurePwForms = forms.filter((f) => f.hasPassword && (f.insecureAction || !facts.isHttps));
  if (insecurePwForms.length) {
    findings.push({
      id: "password-form-insecure",
      category: "auth",
      severity: "urgent",
      title: "A password form isn't sent securely",
      meaning:
        "You have a form that collects a password but submits it over an unprotected connection. Anyone on the same network (a cafe wifi, for example) could read the password as it's sent.",
      fix: [
        "Serve the whole site over https and make sure the form submits to an https address.",
        "Never let a login or signup form post to an http address.",
      ],
      who: "Your web person, promptly.",
      evidence: {
        lines: insecurePwForms.slice(0, 4).map((f) => `form on ${short(f.page)} submits to ${f.action}`),
        note: "Password field submitting insecurely.",
        method: "We read every form on the pages we loaded, the same markup a browser sees, and checked whether any form with a password field sits on an http page or submits to an http address. We never filled in or sent any form.",
        pages: uniq(insecurePwForms.map((f) => href(f.page)), homepage),
      },
    });
  }

  // ---- changing forms without a CSRF token (heuristic) ----
  const noCsrf = forms.filter((f) => f.method === "post" && !f.hasCsrf && (f.hasPassword || f.hasFile));
  if (noCsrf.length) {
    findings.push({
      id: "form-missing-csrf",
      category: "auth",
      severity: "minor",
      title: "A form may be missing cross-site request protection",
      meaning:
        "Some forms that submit sensitive actions don't appear to include an anti-forgery token. Without one, a malicious site can sometimes trick a logged-in visitor into submitting it.",
      fix: [
        `Where: the form${noCsrf.length > 1 ? "s" : ""} on ${[...new Set(noCsrf.map((f) => short(f.page)))].slice(0, 4).join(", ")}.`,
        "Ask your web person to add a CSRF token to that form. WordPress, Laravel, Django, Rails, and most site builders have this built in and just need it switched on.",
      ],
      who: "Your web person.",
      evidence: {
        lines: noCsrf.slice(0, 4).map((f) => `form on ${short(f.page)} (${f.method.toUpperCase()}) with no visible token`),
        note: "Heuristic: token field not detected. Worth a manual check.",
        method: "We read every form on the pages we loaded and, for forms that send a password or a file, looked for a hidden field named like csrf, token, nonce, or authenticity. We never submitted any form.",
        pages: uniq(noCsrf.map((f) => href(f.page)), homepage),
      },
    });
  }

  // ---- password fields the browser is told to remember ----
  const rememberPw = forms.filter((f) => f.pwAutocompleteOn);
  if (rememberPw.length) {
    findings.push({
      id: "password-autocomplete",
      category: "auth",
      severity: "minor",
      title: "A password field is set to be remembered",
      meaning: "A password field explicitly allows the browser to store it. On shared or public computers that can expose the account.",
      fix: ['Ask your web person to set autocomplete to "off" (or "new-password") on sensitive password fields.'],
      who: "Your web person.",
      evidence: {
        lines: rememberPw.slice(0, 3).map((f) => `password field on ${short(f.page)} allows autocomplete`),
        note: "Structural check of the form markup.",
        method: "We read the password fields on the pages we loaded and checked whether any is marked autocomplete=on, which tells the browser it may save the password.",
        pages: uniq(rememberPw.map((f) => href(f.page)), homepage),
      },
    });
  }

  // ---- external scripts without Subresource Integrity ----
  // Integrity checks only make sense for fixed library files from a static CDN. Tag managers,
  // analytics, chat widgets, consent tools, and video players change their code constantly and
  // cannot carry an integrity hash, so they are not counted.
  const STATIC_CDN = /(^|\.)(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|code\.jquery\.com|ajax\.googleapis\.com|stackpath\.bootstrapcdn\.com|maxcdn\.bootstrapcdn\.com|ajax\.aspnetcdn\.com|cdn\.datatables\.net|use\.fontawesome\.com)$/i;
  const cdnHost = (src) => { try { return new URL(src).hostname; } catch { return ""; } };
  const extNoSri = (facts.scripts || []).filter((s) => s.external && !s.integrity && STATIC_CDN.test(cdnHost(s.src)));
  if (extNoSri.length >= 1) {
    findings.push({
      id: "missing-sri",
      category: "hardening",
      severity: "minor",
      title: "Library files from a public CDN load without a file check",
      meaning:
        "This site loads fixed library files (such as jQuery or Bootstrap) from a public CDN without an integrity check. An integrity check makes the browser refuse the file if it is ever changed on that CDN. It is a one-line addition for files like these.",
      fix: [
        "Where: the <script> tags that load the files listed under Where.",
        "Add an integrity attribute to each (free generator: srihash.org), or host those scripts on your own site instead.",
      ],
      who: "Your web person.",
      evidence: {
        lines: extNoSri.slice(0, 5).map((s) => shortHost(s.src)),
        note: `${extNoSri.length} library file(s) from a public CDN without an integrity attribute. Tag managers, analytics, and widgets are not counted because they cannot use one.`,
        method: "We listed every script tag on the pages we loaded that points to a public library CDN (cdnjs, jsDelivr, unpkg, jQuery, Google Hosted Libraries, and similar) and checked whether it carries an integrity attribute. We did not download those scripts.",
        pages: pagesReferencing(facts, extNoSri.map((s) => s.src), homepage),
      },
    });
  } else if ((facts.scripts || []).some((s) => s.external && s.integrity && STATIC_CDN.test(cdnHost(s.src)))) {
    passes.push("Your external scripts use integrity checks.");
  }

  return { findings, passes };
}

function short(u) { try { const x = new URL(u); return (x.pathname || "/"); } catch { return u; } }
function shortHost(u) { try { const x = new URL(u); return x.host + x.pathname.slice(0, 40); } catch { return String(u).slice(0, 60); } }

// ---- evidence helpers ----

function href(u) {
  if (!u) return "";
  if (typeof u === "string") return u;
  return u.href || String(u);
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

// The crawled pages whose <script src> resolves to one of the given URLs.
function pagesReferencing(facts, urls, fallback) {
  const want = new Set(urls);
  const out = [];
  for (const page of facts.pages || []) {
    if (!page || !page.url) continue;
    let hit = false;
    if (page.$) {
      page.$("script[src]").each((_, el) => {
        if (hit) return;
        let abs;
        try { abs = new URL(page.$(el).attr("src") || "", page.url).href; } catch { return; }
        if (want.has(abs)) hit = true;
      });
    } else if (page.html) {
      hit = [...want].some((u) => page.html.includes(u));
    }
    const u = href(page.url);
    if (hit && !out.includes(u)) out.push(u);
    if (out.length >= 6) break;
  }
  return out.length ? out : [fallback];
}
