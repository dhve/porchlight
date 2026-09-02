// orchestrator.js
// Step 2: make a checklist. The LLM plays the role of the planner here. Given
// what recon found, it decides which checks are worth running and in what
// order, and writes one plain-language sentence about its focus.
//
// If no key is set, planCheckup() falls back to running every check.

import { chatJSON, llmEnabled } from "./llm.js";

// The catalog of checks the orchestrator is allowed to schedule. Keys must
// match the ids the pipeline knows how to run.
export const CHECK_CATALOG = [
  { id: "tls", desc: "Certificate validity, key strength, self-signed, deprecated TLS 1.0/1.1." },
  { id: "security", desc: "Security headers, CSP quality, CORS misconfig, mixed content." },
  { id: "cookies", desc: "Per-cookie Secure / HttpOnly / SameSite flags." },
  { id: "exposedFiles", desc: "Well-known private files (.env, .git, backups, configs) left readable." },
  { id: "libraries", desc: "Front-end libraries running known-vulnerable versions." },
  { id: "disclosure", desc: "Secrets in source, source maps, directory listing, verbose errors, robots leaks." },
  { id: "forms", desc: "Insecure password forms, missing CSRF token, missing SRI on external scripts." },
  { id: "flows", desc: "Key customer pages (order, book, contact) load without errors." },
  { id: "links", desc: "Broken links and images." },
  { id: "reflection", desc: "Conservative reflected-input (XSS surface) check, detection only." },
  { id: "browser", desc: "Headless-browser pass: JS errors, load speed, render issues." },
];

const ALL_IDS = CHECK_CATALOG.map((c) => c.id);

export async function planCheckup(facts) {
  const fallback = {
    focus: "Running a full checkup across security, customer flows, and quality.",
    checks: ALL_IDS.map((id) => ({ id, reason: "Default full sweep." })),
    llm: false,
  };

  if (!llmEnabled()) return fallback;

  const summary = summarizeFacts(facts);
  try {
    const out = await chatJSON({
      system:
        "You are the planner for Porchlight, a friendly website-checkup tool for small businesses. " +
        "Given a summary of what an initial scan found, choose which follow-up checks to run and in what order, " +
        "prioritizing the ones most likely to matter for THIS site. You may include every check. " +
        "Respond as JSON: {\"focus\": string, \"checks\": [{\"id\": string, \"reason\": string}]}. " +
        "Valid ids are exactly: " + ALL_IDS.join(", ") + ". Keep 'focus' to one short sentence a shop owner would understand.",
      user: `Initial scan summary:\n${summary}`,
      temperature: 0.3,
      maxTokens: 2500,
    });

    const checks = Array.isArray(out.checks)
      ? out.checks.filter((c) => c && ALL_IDS.includes(c.id))
      : [];
    // Make sure nothing important is dropped: append any missing checks at the end.
    const chosen = new Set(checks.map((c) => c.id));
    for (const id of ALL_IDS) if (!chosen.has(id)) checks.push({ id, reason: "Included for completeness." });

    return { focus: String(out.focus || fallback.focus).slice(0, 200), checks, llm: true };
  } catch (err) {
    console.error("orchestrator: falling back to rule-based plan:", err.message);
    return fallback; // any LLM trouble -> just run everything
  }
}

function summarizeFacts(facts) {
  const lines = [
    `reachable: ${facts.reachable}`,
    `https: ${facts.isHttps}`,
    `platform: ${facts.cms ? facts.cms.name + " " + (facts.cms.version || "unknown version") : "unknown"}`,
    `server: ${facts.server || "unknown"}`,
    `technologies: ${(facts.technologies || []).join(", ") || "none detected"}`,
    `plugins/themes detected: ${(facts.plugins || []).map((p) => p.slug + "@" + p.version).join(", ") || "none"}`,
    `homepage title: ${facts.title || "(none)"}`,
    `response time: ${facts.responseMs}ms`,
  ];
  return lines.join("\n");
}
