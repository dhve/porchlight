// reporter.js
// Step 5: write it up. The findings arrive already in plain-ish language from
// the checks. When a key is present, the LLM polishes them into warm, consistent,
// jargon-free copy for a non-technical owner and writes the overall summary.
//
// The model only rewrites WORDING. It never changes a finding's severity, its
// evidence, or the grade, so it can't invent or hide a problem. If no key is
// set (or the call fails), we fall back to a built-in template.

import { chatJSON, llmEnabled } from "./llm.js";

export async function writeReport({ target, facts, findings, passes, grade, gradeLabel, tally }) {
  const base = { summary: templateSummary(tally, target, grade), findings, passes };

  if (!llmEnabled() || !findings.length) {
    return { ...base, llm: false };
  }

  try {
    const payload = {
      website: target,
      grade,
      gradeLabel,
      platform: facts.cms ? `${facts.cms.name} ${facts.cms.version || ""}`.trim() : "unknown",
      findings: findings.map((f) => ({
        id: f.id,
        severity: f.severity,
        category: f.category,
        title: f.title,
        meaning: f.meaning,
        fix: f.fix,
        who: f.who,
        evidence: f.evidence ? { lines: (f.evidence.lines || []).slice(0, 6), why: f.evidence.why || "", confirm: f.evidence.confirm || "" } : null,
      })),
      passes,
    };

    const out = await chatJSON({
      system:
        "You are the report writer for Sutros, a website checkup tool for small-business owners who are NOT technical. " +
        "Rewrite the given findings in warm, plain, everyday language. Rules: " +
        "keep each finding's id and severity EXACTLY as given; do not add or remove findings; " +
        "explain impact in terms an owner feels (lost customers, exposed data, scary warnings); " +
        "keep fixes concrete and short; no jargon, no dashes, no exclamation marks. " +
        "Tone: warm and welcoming, never alarming or dramatic; no analogies or metaphors; state the plain fact of what could go wrong and nudge toward the fix. " +
        "Because the reader is often not the site owner, say 'this site' or 'the site' rather than 'your site', and 'the owner' rather than 'you' when talking about who fixes things. " +
        "For each finding also write 'why': 2 to 4 sentences of specific, technically accurate explanation of why the evidence proves a real problem and what can go wrong, referring to the concrete evidence (the status code, header, file, version, or error text). Keep EVERY specific mechanism and named risk from the provided why (for example clickjacking, HSTS downgrade, the exact status code, the CVE) and add site-specific detail from the evidence on top; never shorten, soften, or generalize it. " +
        "And 'confirm': one or two concrete steps the owner or their web person can take to see the problem themselves. " +
        "Also write one short 'summary' paragraph (2-3 sentences) describing the site's overall health, " +
        "and lightly tidy the 'passes' list (things that are fine). " +
        "Respond as JSON: {\"summary\": string, \"findings\": [{\"id\": string, \"title\": string, \"meaning\": string, \"fix\": [string], \"who\": string, \"why\": string, \"confirm\": string}], \"passes\": [string]}.",
      user: JSON.stringify(payload),
      temperature: 0.5,
      maxTokens: 8000,
    });

    const byId = new Map((out.findings || []).map((f) => [f.id, f]));
    const merged = findings.map((f) => {
      const r = byId.get(f.id);
      if (!r) return f;
      return {
        ...f, // keep severity, category, evidence
        title: str(r.title, f.title),
        meaning: str(r.meaning, f.meaning),
        fix: Array.isArray(r.fix) && r.fix.length ? r.fix.map(String) : f.fix,
        who: str(r.who, f.who),
        evidence: f.evidence
          ? { ...f.evidence, why: str(r.why, f.evidence.why), confirm: str(r.confirm, f.evidence.confirm) }
          : f.evidence,
      };
    });

    return {
      summary: str(out.summary, base.summary),
      findings: merged,
      passes: Array.isArray(out.passes) && out.passes.length ? out.passes.map(String) : passes,
      llm: true,
    };
  } catch (err) {
    console.error("reporter: falling back to template write-up:", err.message);
    return { ...base, llm: false };
  }
}

function str(v, fallback) {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

function templateSummary(tally, target, grade) {
  const parts = [];
  const urgent = tally.urgent, serious = tally.serious, watch = tally.watch;
  if (!urgent && !serious && !watch) {
    return `Good news: ${target} passed its checkup with no problems worth flagging. The doors are locked and the lights are on.`;
  }
  if (urgent) parts.push(`${urgent} urgent problem${urgent > 1 ? "s" : ""} that should be handled right away`);
  if (serious) parts.push(`${serious} serious issue${serious > 1 ? "s" : ""}`);
  if (watch) parts.push(`${watch} smaller thing${watch > 1 ? "s" : ""} worth a look`);
  const list = parts.length > 1 ? parts.slice(0, -1).join(", ") + ", and " + parts.slice(-1) : parts[0];
  return `We checked ${target} and found ${list}. Everything below comes with a plain-language fix, so you know exactly what to do next.`;
}
