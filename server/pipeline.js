// pipeline.js
// The whole house call, wired into the five steps the UI shows:
//   1 recon      -> "Looking around your website"
//   2 plan       -> "Making a checklist"        (LLM orchestrator)
//   3 probe      -> "Trying the doors & windows" (tls, security, exposed files)
//   4 customer   -> "Acting like a customer"     (flows, links, browser)
//   5 report     -> "Writing up what we found"   (LLM reporter + scoring)
//
// Progress is reported through the onEvent(type, data) callback so the server
// can stream it to the browser. Every check is wrapped so one failure can't
// sink the whole checkup.

import { createClient } from "./lib/http.js";
import { modelName, llmEnabled } from "./llm.js";
import { planCheckup } from "./orchestrator.js";
import { writeReport } from "./reporter.js";
import { scoreReport } from "./scoring.js";
import { saveReport } from "./db.js";

import { runRecon } from "./checks/recon.js";
import { runTls } from "./checks/tls.js";
import { runSecurity } from "./checks/security.js";
import { runExposedFiles } from "./checks/exposedFiles.js";
import { runFlows } from "./checks/flows.js";
import { runLinks } from "./checks/links.js";
import { runBrowser } from "./checks/browser.js";

const CHECK_FNS = {
  tls: runTls,
  security: runSecurity,
  exposedFiles: runExposedFiles,
  flows: runFlows,
  links: runLinks,
  browser: runBrowser,
};
const STEP3 = ["tls", "security", "exposedFiles"];
const STEP4 = ["flows", "links", "browser"];
const MARK = { urgent: "⚠️", serious: "🔧", watch: "👀", good: "✅" };

export async function runCheckup({ url, display }, onEvent = () => {}) {
  const client = createClient();
  const ctx = { url, client };
  const findings = [];
  const passes = [];
  const checksRun = [];
  let browserInfo = { ran: false, skippedReason: null };

  // ---- Step 1: recon ----
  onEvent("step", { key: "recon", status: "start" });
  const recon = await safe(() => runRecon(ctx), { facts: { reachable: false }, findings: [], passes: [] });
  ctx.facts = recon.facts;
  push(findings, passes, recon);
  onEvent("step", {
    key: "recon",
    status: "done",
    detail: recon.facts.reachable
      ? `Built on ${recon.facts.cms ? cap(recon.facts.cms.name) : recon.facts.technologies?.[0] || "a custom stack"}`
      : "Homepage did not respond",
  });
  logFindings(onEvent, recon.findings);

  if (!recon.facts.reachable) {
    for (const key of ["plan", "probe", "customer"]) onEvent("step", { key, status: "done", detail: "skipped" });
    return finish({ url, display, findings, passes, plan: { focus: "Site was unreachable.", llm: false }, checksRun, browserInfo, onEvent });
  }

  // ---- Step 2: plan (orchestrator) ----
  onEvent("step", { key: "plan", status: "start" });
  const plan = await safe(() => planCheckup(recon.facts), { focus: "Running a full checkup.", checks: [], llm: false });
  onEvent("step", { key: "plan", status: "done", detail: plan.focus, llm: plan.llm });
  onEvent("log", { mark: "📋", text: plan.llm ? plan.focus : "Running the full checklist." });

  const order = plan.checks?.length ? plan.checks.map((c) => c.id) : [...STEP3, ...STEP4];

  // ---- Step 3: probe (doors & windows) ----
  await runStep(onEvent, "probe", order.filter((id) => STEP3.includes(id)), ctx, findings, passes, checksRun, browserInfo);

  // ---- Step 4: customer ----
  await runStep(onEvent, "customer", order.filter((id) => STEP4.includes(id)), ctx, findings, passes, checksRun, browserInfo);

  // ---- Step 5: report ----
  return finish({ url, display, facts: recon.facts, findings, passes, plan, checksRun, browserInfo, onEvent });
}

async function runStep(onEvent, key, ids, ctx, findings, passes, checksRun, browserInfo) {
  onEvent("step", { key, status: "start" });
  for (const id of ids) {
    const fn = CHECK_FNS[id];
    if (!fn) continue;
    const out = await safe(() => fn(ctx), { findings: [], passes: [] });
    if (id === "browser") browserInfo = Object.assign(browserInfo, { ran: !out.skipped, skippedReason: out.skipped ? out.reason : null });
    checksRun.push(id);
    push(findings, passes, out);
    logFindings(onEvent, out.findings);
  }
  onEvent("step", { key, status: "done" });
}

async function finish({ url, display, facts, findings, passes, plan, checksRun, browserInfo, onEvent }) {
  onEvent("step", { key: "report", status: "start" });

  // De-duplicate by id, then sort most severe first.
  const seen = new Set();
  const unique = findings.filter((f) => (seen.has(f.id) ? false : seen.add(f.id)));
  const rank = { urgent: 0, serious: 1, watch: 2, good: 3 };
  unique.sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));

  const { grade, gradeLabel, score, ringPercent, tally } = scoreReport(unique);
  const written = await writeReport({
    target: display,
    facts: facts || {},
    findings: unique,
    passes: dedupe(passes),
    grade,
    gradeLabel,
    tally,
  });

  onEvent("step", { key: "report", status: "done" });

  const report = {
    target: display,
    url: url.href,
    scannedAt: new Date().toISOString(),
    grade,
    gradeLabel,
    score,
    ringPercent,
    tally,
    summary: written.summary,
    findings: written.findings,
    passes: written.passes,
    engine: {
      llm: llmEnabled(),
      model: llmEnabled() ? modelName() : null,
      orchestrator: plan.llm ? "llm" : "rule-based",
      reporter: written.llm ? "llm" : "rule-based",
      focus: plan.focus,
      checksRun,
      browser: browserInfo,
    },
  };

  // Persist when a database is configured; a DB hiccup must never sink a checkup.
  try {
    const id = await saveReport(report);
    if (id) report.id = id;
  } catch (err) {
    console.error("could not save report:", err.message);
  }

  onEvent("report", report);
  onEvent("done", {});
  return report;
}

// ---- helpers ----
async function safe(fn, fallback) {
  try {
    const out = await fn();
    return out || fallback;
  } catch (err) {
    return fallback;
  }
}
function push(findings, passes, out) {
  if (out?.findings?.length) findings.push(...out.findings);
  if (out?.passes?.length) passes.push(...out.passes);
}
function logFindings(onEvent, list = []) {
  for (const f of list) {
    if (f.severity === "watch") continue; // keep the live log to the headlines
    onEvent("log", { mark: MARK[f.severity] || "🔎", text: f.title });
  }
}
function dedupe(arr) {
  return [...new Set(arr)];
}
function cap(s) {
  return String(s || "").replace(/\b\w/g, (c) => c.toUpperCase());
}
