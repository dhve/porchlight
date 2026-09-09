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
import { saveReport, newId } from "./db.js";
import { signReport } from "./verify.js";
import { explain, PROOF_PROMISE } from "./explain.js";
import { disputesForHost } from "./feedback.js";
import { captureProof, saveShots } from "./proof.js";
import { observeCheck, assessmentFor, bindArtifactHashes, SCANNER_VERSION, SCORING_VERSION, REPORTER_VERSION } from "./provenance.js";

import { runRecon } from "./checks/recon.js";
import { runTls } from "./checks/tls.js";
import { runSecurity } from "./checks/security.js";
import { runCookies } from "./checks/cookies.js";
import { runExposedFiles } from "./checks/exposedFiles.js";
import { runLibraries } from "./checks/libraries.js";
import { runDisclosure } from "./checks/disclosure.js";
import { runForms } from "./checks/forms.js";
import { runFlows } from "./checks/flows.js";
import { runLinks } from "./checks/links.js";
import { runReflection } from "./checks/reflection.js";
import { runModernization } from "./checks/modernization.js";
import { runBrowser } from "./checks/browser.js";
import { runAgentBrowse } from "./checks/agentBrowse.js";

const CHECK_FNS = {
  tls: runTls,
  security: runSecurity,
  cookies: runCookies,
  exposedFiles: runExposedFiles,
  libraries: runLibraries,
  disclosure: runDisclosure,
  forms: runForms,
  flows: runFlows,
  links: runLinks,
  reflection: runReflection,
  modernization: runModernization,
  browser: runBrowser,
  agent: runAgentBrowse,
};
// Step 3 = security posture. Step 4 = functional + input behavior.
const STEP3 = ["tls", "security", "cookies", "exposedFiles", "libraries", "disclosure"];
const STEP4 = ["forms", "flows", "links", "reflection", "modernization", "browser", "agent"];
const MARK = { urgent: "⚠️", serious: "🔧", watch: "👀", good: "✅" };

export async function runCheckup({ url, display, userId = null }, onEvent = () => {}) {
  const client = createClient();
  const ctx = { url, client, onEvent };
  let agentInfo = null; // filled by the browsing agent when it runs
  const findings = [];
  const passes = [];
  const checksRun = [];
  const coverage = [];
  const requiredChecks = ["recon"];
  let browserInfo = { ran: false, skippedReason: null };

  // ---- Step 1: recon ----
  onEvent("step", { key: "recon", status: "start" });
  const observedRecon = await observeCheck("recon", runRecon, ctx);
  const recon = observedRecon.out;
  coverage.push(observedRecon.coverage);
  ctx.facts = recon.facts || { reachable: false };
  if (observedRecon.coverage.status === "completed") checksRun.push("recon");
  push(findings, passes, recon, observedRecon.coverage.status === "completed");
  onEvent("step", {
    key: "recon",
    status: "done",
    detail: observedRecon.coverage.status === "completed"
      ? `Built on ${ctx.facts.cms ? cap(ctx.facts.cms.name) : ctx.facts.technologies?.[0] || "a custom stack"}`
      : observedRecon.coverage.reason,
  });
  logFindings(onEvent, recon.findings);

  if (!ctx.facts.reachable || observedRecon.coverage.status !== "completed") {
    for (const check of [...STEP3, ...STEP4]) coverage.push({ check, status: "skipped", reason: "The homepage check did not complete." });
    for (const key of ["plan", "probe", "customer"]) onEvent("step", { key, status: "done", detail: "skipped" });
    return finish({ url, display, userId, facts: ctx.facts, findings, passes, plan: { focus: "The homepage check did not complete.", llm: false }, checksRun, coverage, requiredChecks, browserInfo, onEvent, client });
  }

  // ---- Step 2: plan (orchestrator) ----
  onEvent("step", { key: "plan", status: "start" });
  const plan = await safe(() => planCheckup(recon.facts), { focus: "Running a full checkup.", checks: [], llm: false });
  onEvent("step", { key: "plan", status: "done", detail: plan.focus, llm: plan.llm });
  onEvent("log", { mark: "📋", text: plan.llm ? plan.focus : "Running the full checklist." });

  const order = [...new Set(plan.checks?.length ? plan.checks.map((c) => c.id) : [...STEP3, ...STEP4])];
  requiredChecks.push(...order.filter((id) => CHECK_FNS[id] && id !== "browser" && id !== "agent"));
  for (const check of [...STEP3, ...STEP4]) {
    if (!order.includes(check) && check !== "agent") coverage.push({ check, status: "skipped", reason: "This check was not included in the plan." });
  }

  // ---- Step 3: probe (doors & windows) ----
  await runStep(onEvent, "probe", order.filter((id) => STEP3.includes(id)), ctx, findings, passes, checksRun, coverage, browserInfo);

  // ---- Step 4: customer ----
  const extra = {};
  const step4 = order.filter((id) => STEP4.includes(id));
  if (!step4.includes("agent") && STEP4.includes("agent")) step4.push("agent"); // the browsing agent always gets its turn
  await runStep(onEvent, "customer", step4, ctx, findings, passes, checksRun, coverage, browserInfo, extra);
  agentInfo = extra.agent || null;

  // ---- Step 5: report ----
  return finish({ url, display, userId, facts: recon.facts, findings, passes, plan, checksRun, coverage, requiredChecks, browserInfo, agentInfo, onEvent, client });
}

async function runStep(onEvent, key, ids, ctx, findings, passes, checksRun, coverage, browserInfo, extra = {}) {
  onEvent("step", { key, status: "start" });
  for (const id of ids) {
    const fn = CHECK_FNS[id];
    if (!fn) continue;
    if (ctx.facts?.challenged) {
      const reason = 'A hosting bot challenge prevented further checks.';
      coverage.push({check:id,status:'skipped',reason});
      if (id === 'browser') Object.assign(browserInfo,{ran:false,skippedReason:reason});
      if (id === 'agent') extra.agent = {ran:false,reason};
      continue;
    }
    await respectThrottle(ctx, onEvent, "the next check");
    const observed = await observeCheck(id, fn, ctx);
    const out = observed.out;
    coverage.push(observed.coverage);
    const completed = observed.coverage.status === "completed";
    if (id === "browser") {
      const { findings: _findings, passes: _passes, ...metadata } = out;
      Object.assign(browserInfo, metadata, { ran: completed, skippedReason: completed ? null : observed.coverage.reason, mode: out.browserMode || null });
    }
    if (id === "agent") extra.agent = out.agent || { ran: false, reason: out.reason || null };
    if (completed) checksRun.push(id);
    // An incomplete browser render cannot support a negative layout finding.
    if (completed || (id !== "browser" && id !== "agent")) {
      push(findings, passes, out, completed);
      logFindings(onEvent, out.findings);
    }
  }
  onEvent("step", { key, status: "done" });
}

async function finish({ url, display, userId = null, facts, findings, passes, plan, checksRun, coverage, requiredChecks, browserInfo, agentInfo = null, onEvent, client = null }) {
  onEvent("step", { key: "report", status: "start" });

  // De-duplicate by id, then sort most severe first.
  const seen = new Set();
  const unique = findings.filter((f) => (seen.has(f.id) ? false : seen.add(f.id)));
  const rank = { urgent: 0, serious: 1, watch: 2, good: 3 };
  unique.sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));

  // Technical proof: every finding gets a mechanism explanation + how to confirm.
  for (const f of unique) {
    if (!f.evidence) continue;
    const e = explain(f);
    if (!f.evidence.why && e.why) f.evidence.why = e.why;
    if (!f.evidence.confirm && e.confirm) f.evidence.confirm = e.confirm;
  }

  // Feedback loop: readers of earlier checkups of this site may have said a finding was wrong.
  try {
    const disputes = await disputesForHost(hostOf(display));
    for (const f of unique) {
      const d = disputes.get(f.id);
      if (d && d.wrong >= 2 && d.wrong > d.right) f.disputed = { wrong: d.wrong, right: d.right };
    }
  } catch (err) {
    console.error("disputes lookup failed:", err.message);
  }

  const assessment = assessmentFor(coverage, requiredChecks);
  const { grade, gradeLabel, score, ringPercent, tally } = scoreReport(unique, assessment);

  // Pictures of the affected pages are taken while the write-up is produced; both are bounded.
  const canCaptureProof = facts?.reachable && !facts.challenged && coverage.find((c) => c.check === "recon")?.status === "completed";
  if (canCaptureProof) await respectThrottle({ facts, client }, onEvent, "taking pictures of the affected pages");
  const proofPromise = canCaptureProof
    ? captureProof({ facts, findings: unique, onEvent }).catch((err) => ({ shots: [], skipped: `capture failed: ${String(err.message).slice(0, 100)}` }))
    : Promise.resolve({ shots: [], skipped: facts?.challenged ? "A verification challenge prevented page capture." : "The homepage check did not complete." });
  const [written, proof] = await Promise.all([
    writeReport({
      target: display,
      facts: facts || {},
      findings: unique,
      passes: dedupe(passes),
      grade,
      gradeLabel,
      tally,
      assessment,
    }),
    proofPromise,
  ]);
  // The writer may have copied evidence before the pictures were attached; re-attach by id.
  const shotsById = new Map(unique.filter((f) => f.evidence && f.evidence.shots).map((f) => [f.id, f.evidence.shots]));
  for (const f of written.findings || []) {
    const s = shotsById.get(f.id);
    if (s && f.evidence && !f.evidence.shots) f.evidence.shots = s;
  }

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
    assessment,
    coverage,
    summary: written.summary,
    findings: written.findings,
    passes: written.passes,
    engine: {
      version: SCANNER_VERSION,
      scoringVersion: SCORING_VERSION,
      reporterVersion: REPORTER_VERSION,
      llm: llmEnabled(),
      model: llmEnabled() ? modelName() : null,
      orchestrator: plan.llm ? "llm" : "rule-based",
      reporter: written.llm ? "llm" : "rule-based",
      focus: plan.focus,
      checksRun,
      browser: browserInfo,
      throttled: Boolean(facts && (facts.throttled || facts.wasThrottled)),
      challenged: typeof facts?.challenged === "string" ? facts.challenged : null,
      proof: { shots: (proof.shots || []).length, skipped: proof.skipped || null },
    },
    proofPromise: PROOF_PROMISE,
  };
  if (agentInfo) {
    const { shots: agentShots, ...rest } = agentInfo;
    report.agent = rest;
    if (Array.isArray(agentShots) && agentShots.length) proof.shots = [...(proof.shots || []), ...agentShots];
  }
  report.engine.proof.artifacts = bindArtifactHashes(report.findings, proof.shots);

  // Identity, ownership, contact hints, and the signed attestation, then persist.
  report.id = newId();
  report.userId = userId || null;
  report.contact = (facts && facts.contact) || { emails: [], pages: [] };
  try { const att = signReport(report); if (att) report.attestation = att; } catch (err) { console.error("could not sign report:", err.message); }
  try {
    await saveReport(report); // a DB hiccup must never sink a checkup
    if (proof.shots && proof.shots.length) await saveShots(report.id, proof.shots);
  } catch (err) {
    console.error("could not save report:", err.message);
  }

  onEvent("report", report);
  onEvent("done", {});
  return report;
}

// ---- helpers ----
const MAX_THROTTLE_WAIT_MS = 60_000;
/**
 * A site that answers 429 is asking us to slow down. Rather than skip every later
 * check (and mislabel the site), wait out its Retry-After (bounded, at most twice
 * per checkup) and give the next check a clean start.
 */
async function respectThrottle(ctx, onEvent, why) {
  const facts = ctx && ctx.facts;
  if (!facts || !facts.throttled) return;
  facts.throttleWaits = (facts.throttleWaits || 0) + 1;
  facts.wasThrottled = true;
  if (facts.throttleWaits > 2) return; // the site keeps limiting us; let the remaining checks report that honestly
  const info = ctx.client && typeof ctx.client.throttleInfo === "function" ? ctx.client.throttleInfo() : null;
  let wait = info && Number.isFinite(info.retryAfterMs) ? info.retryAfterMs - (Date.now() - info.at) + 1500 : 20_000;
  wait = Math.max(3000, Math.min(MAX_THROTTLE_WAIT_MS, wait));
  onEvent("log", { mark: "⏳", text: `The site asked us to slow down. Waiting ${Math.round(wait / 1000)} seconds before ${why}.` });
  await new Promise((r) => setTimeout(r, wait));
  facts.throttled = false; // the next check re-detects the limit if it is still on
}
async function safe(fn, fallback) {
  try {
    const out = await fn();
    return out || fallback;
  } catch (err) {
    return fallback;
  }
}
function push(findings, passes, out, completed = true) {
  if (out?.findings?.length) findings.push(...out.findings);
  if (completed && out?.passes?.length) passes.push(...out.passes);
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
function hostOf(display) {
  return String(display || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
}
function cap(s) {
  return String(s || "").replace(/\b\w/g, (c) => c.toUpperCase());
}
