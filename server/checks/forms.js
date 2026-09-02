// forms.js
// Step 4: look at the forms a visitor would use (collected during the crawl).
//  - login or password forms that submit over an insecure connection
//  - forms that post to a different site
//  - password fields the browser is told to remember
//  - missing anti-CSRF token on forms that change things (heuristic)
//  - external scripts loaded without Subresource Integrity (SRI)
//
// Deterministic and structural. We never submit any form.

export async function runForms(ctx) {
  const { facts } = ctx;
  const findings = [];
  const passes = [];
  const forms = facts.forms || [];

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
      evidence: { lines: insecurePwForms.slice(0, 4).map((f) => `form on ${short(f.page)} submits to ${f.action}`), note: "Password field submitting insecurely." },
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
      fix: ["Ask your web person to confirm your forms include CSRF protection. Most frameworks and CMS platforms add it automatically when enabled."],
      who: "Your web person.",
      evidence: { lines: noCsrf.slice(0, 4).map((f) => `form on ${short(f.page)} (${f.method.toUpperCase()}) with no visible token`), note: "Heuristic: token field not detected. Worth a manual check." },
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
      evidence: { lines: rememberPw.slice(0, 3).map((f) => `password field on ${short(f.page)} allows autocomplete`), note: "Structural check of the form markup." },
    });
  }

  // ---- external scripts without Subresource Integrity ----
  const extNoSri = (facts.scripts || []).filter((s) => s.external && !s.integrity);
  if (extNoSri.length >= 1) {
    findings.push({
      id: "missing-sri",
      category: "hardening",
      severity: "minor",
      title: "Scripts from other sites load without a safety check",
      meaning:
        "Your site runs code hosted on other companies' servers without verifying it hasn't been tampered with. If one of those providers is ever compromised, the bad code runs on your site too.",
      fix: ["Ask your web person to add Subresource Integrity (an integrity hash) to external scripts, or self-host the important ones."],
      who: "Your web person.",
      evidence: { lines: extNoSri.slice(0, 5).map((s) => shortHost(s.src)), note: `${extNoSri.length} external script(s) without an integrity attribute.` },
    });
  } else if ((facts.scripts || []).some((s) => s.external)) {
    passes.push("Your external scripts use integrity checks.");
  }

  return { findings, passes };
}

function short(u) { try { const x = new URL(u); return (x.pathname || "/"); } catch { return u; } }
function shortHost(u) { try { const x = new URL(u); return x.host + x.pathname.slice(0, 40); } catch { return String(u).slice(0, 60); } }
