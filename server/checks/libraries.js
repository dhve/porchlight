// libraries.js
// Step 3: find front-end libraries running known-vulnerable versions. This is
// the idea behind Retire.js: read the version out of the script URL (or inline),
// and compare it against a bundled list of versions with public advisories.
//
// Deterministic. Detection only: we report the version and the known issue, we
// do not attempt to exploit anything.

import { inRange } from "../lib/semver.js";

// A curated set of popular libraries with known-vulnerable version ranges.
// `below` is exclusive. Each entry is worded for a non-technical owner.
const KNOWN = [
  { name: "jQuery", re: /jquery[-.]?(\d+\.\d+(?:\.\d+)?)(?:\.min)?\.js/i, ranges: [
    { below: "3.5.0", severity: "serious", note: "Versions before 3.5.0 have a known cross-site scripting (XSS) weakness (CVE-2020-11022/11023)." },
    { below: "1.9.0", severity: "serious", note: "Very old jQuery has multiple known security issues." },
  ]},
  { name: "jQuery UI", re: /jquery-ui[-.]?(\d+\.\d+(?:\.\d+)?)(?:\.min)?\.js/i, ranges: [
    { below: "1.13.2", severity: "serious", note: "Versions before 1.13.2 have a known XSS issue (CVE-2022-31160)." },
  ]},
  { name: "Bootstrap", re: /bootstrap[-.]?(\d+\.\d+(?:\.\d+)?)(?:\.min)?\.js/i, ranges: [
    { atLeast: "4.0.0", below: "4.3.1", severity: "serious", note: "Bootstrap 4 before 4.3.1 has a known XSS issue (CVE-2019-8331)." },
    { below: "3.4.1", severity: "serious", note: "Bootstrap 3 before 3.4.1 has known XSS issues." },
  ]},
  { name: "AngularJS", re: /angular[-.]?(\d+\.\d+(?:\.\d+)?)(?:\.min)?\.js/i, ranges: [
    { below: "1.8.0", severity: "serious", note: "AngularJS (1.x) before 1.8 has multiple XSS/sandbox-bypass issues, and 1.x is end-of-life." },
  ]},
  { name: "Lodash", re: /lodash[-.]?(\d+\.\d+(?:\.\d+)?)(?:\.min)?\.js/i, ranges: [
    { below: "4.17.21", severity: "serious", note: "Lodash before 4.17.21 has prototype-pollution and ReDoS issues (CVE-2021-23337 and others)." },
  ]},
  { name: "Moment.js", re: /moment[-.]?(\d+\.\d+(?:\.\d+)?)(?:\.min)?\.js/i, ranges: [
    { below: "2.29.4", severity: "watch", note: "Moment before 2.29.4 has a path-traversal / ReDoS issue, and Moment is no longer actively developed." },
  ]},
  { name: "Handlebars", re: /handlebars[-.]?(\d+\.\d+(?:\.\d+)?)(?:\.min)?\.js/i, ranges: [
    { below: "4.7.7", severity: "serious", note: "Handlebars before 4.7.7 has prototype-pollution / RCE issues in template compilation." },
  ]},
  { name: "DOMPurify", re: /(?:purify|dompurify)[-.]?(\d+\.\d+(?:\.\d+)?)(?:\.min)?\.js/i, ranges: [
    { below: "2.4.0", severity: "serious", note: "DOMPurify before 2.4.0 has known sanitizer-bypass issues." },
  ]},
  { name: "Axios", re: /axios[-.]?(\d+\.\d+(?:\.\d+)?)(?:\.min)?\.js/i, ranges: [
    { below: "0.21.2", severity: "watch", note: "Axios before 0.21.2 has a server-side request forgery (SSRF) issue." },
  ]},
  { name: "Select2", re: /select2[-.]?(\d+\.\d+(?:\.\d+)?)(?:\.min)?\.js/i, ranges: [
    { below: "4.0.6", severity: "watch", note: "Select2 before 4.0.6 has a known XSS issue." },
  ]},
];

export async function runLibraries(ctx) {
  const { facts } = ctx;
  const findings = [];
  const passes = [];
  const scripts = facts.scripts || [];
  if (!scripts.length && !facts.html) return { findings, passes };

  const hits = [];
  const sources = scripts.map((s) => s.src);
  // also scan inline references in page HTML for version comments
  for (const lib of KNOWN) {
    let found = null;
    for (const src of sources) {
      const m = src.match(lib.re);
      if (m) { found = m[1]; break; }
    }
    if (!found && facts.html) {
      const m = facts.html.match(lib.re);
      if (m) found = m[1];
    }
    if (!found) continue;
    for (const range of lib.ranges) {
      if (inRange(found, range)) {
        hits.push({ name: lib.name, version: found, ...range });
        break; // report the first (most relevant) matching range
      }
    }
  }

  if (!hits.length) {
    if (scripts.length) passes.push("The front-end libraries we could identify are up to date.");
    return { findings, passes };
  }

  for (const h of hits) {
    findings.push({
      id: `vuln-lib-${h.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      category: "vulnerable-component",
      severity: h.severity,
      title: `${h.name} ${h.version} has a known security weakness`,
      meaning: `Your site loads ${h.name} version ${h.version}. ${h.note} Attackers actively scan for outdated libraries like this because the weakness is public.`,
      fix: [
        `Update ${h.name} to its latest version.`,
        "If a plugin or theme bundles this library, update that too, or ask your web person which one ships it.",
      ],
      who: "Your web person.",
      evidence: { lines: [`Detected ${h.name} ${h.version}`, `Known issue: ${h.note}`], note: "Version read from the script URL or page source." },
    });
  }

  return { findings, passes };
}
