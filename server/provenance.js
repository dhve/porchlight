import { createHash } from "node:crypto";

// Bump these when observation, score, or writer semantics change. This is an
// implementation version, not a claim that a particular git build was deployed.
export const SCANNER_VERSION = "sutros-evidence-2";
export const SCORING_VERSION = "scripted-coverage-2";
export const REPORTER_VERSION = "advice-only-2";
const STATUSES = new Set(["completed", "skipped", "failed", "inconclusive"]);

/** Capture a checker result without converting an exception into success. */
export async function observeCheck(check, fn, ctx = {}) {
  const unresolvedRequests = new Set();
  let requestChallenge = null;
  const noteChallenge = reason => {
    requestChallenge ||= reason;
    if (ctx.facts) ctx.facts.challenged ||= reason;
  };
  const observedCtx = ctx.client ? { ...ctx, client: observingClient(ctx.client, unresolvedRequests, noteChallenge) } : ctx;
  let out;
  try {
    out = await fn(observedCtx);
  } catch {
    return { out: { findings: [], passes: [] }, coverage: { check, status: "failed", reason: "The checker could not finish this check." } };
  }
  if (!out || !Array.isArray(out.findings) || !Array.isArray(out.passes)) {
    return { out: { findings: [], passes: [] }, coverage: { check, status: "failed", reason: "The checker returned no usable result." } };
  }
  if (requestChallenge && out.facts) out = { ...out, facts: { ...out.facts, challenged: out.facts.challenged || requestChallenge } };
  let status = STATUSES.has(out.status) ? out.status : "completed";
  if (out.skipped) status = "skipped";
  if (out.inconclusive || out.partial) status = "inconclusive";
  if (out.challenged || out.agent?.challenged || requestChallenge) status = 'inconclusive';
  const missingCertificate = check === "tls" && ctx.facts?.isHttps && !out.findings.length && !out.passes.length;
  if (status === "completed" && (unresolvedRequests.size || missingCertificate)) status = "inconclusive";
  if (check === "recon" && !out.facts?.reachable) status = "inconclusive";
  if (check === "recon" && out.facts?.challenged) status = "inconclusive";
  const unusableHomepage = check === "recon" && Number.isFinite(out.facts?.statusCode) &&
    (out.facts.statusCode < 200 || out.facts.statusCode >= 300);
  if (unusableHomepage) status = "inconclusive";
  const coverage = { check, status };
  const challengeReason = out.challengeReason || out.agent?.challenged || requestChallenge || out.facts?.challenged;
  if (status !== "completed") coverage.reason = typeof out.reason === "string" && out.reason.trim()
    ? out.reason.trim().slice(0, 500)
    : typeof challengeReason === 'string' && challengeReason.trim() ? challengeReason.trim().slice(0, 500)
    : missingCertificate ? "The TLS check did not return usable certificate evidence."
      : unresolvedRequests.size ? "Some requests needed for this check did not complete."
      : check === "recon" && out.facts?.challenged ? "A verification challenge prevented the homepage check."
      : unusableHomepage ? `The homepage returned HTTP ${out.facts.statusCode}, so its content could not be fully checked.`
      : check === "recon" ? "The homepage could not be checked, so follow-up checks could not run." : "This check did not complete.";
  const recordedAt = new Date().toISOString();
  out = { ...out, findings: out.findings.filter((f) => f && typeof f === "object").map((f) => ({
    ...f,
    source: check === "agent" ? "agent" : f.source || "scripted",
    provenance: { ...f.provenance, check,
      observedAt: f.provenance?.observedAt || f.evidence?.observedAt || recordedAt,
      recordedAt, scannerVersion: SCANNER_VERSION },
  })) };
  return { out, coverage };
}

// Several existing checks catch request errors themselves. Record unresolved
// failures at the client boundary so an empty result cannot imply full coverage.
// A later response to the same address clears a transient failure.
function observingClient(client, unresolved, noteChallenge) {
  const observed = { ...client };
  for (const method of ["get", "head", "request"]) {
    if (typeof client[method] !== "function") continue;
    observed[method] = async (...args) => {
      const key = String(args[0]);
      const markChallenge = response => {
        if (!response?.challenge) return;
        unresolved.add(key);
        noteChallenge(response.challenge.reason);
      };
      try {
        const response = await client[method](...args);
        if (response?.status === 429 || response?.status === 503) unresolved.add(key);
        else unresolved.delete(key);
        markChallenge(response);
        if (typeof response?.text !== "function") return response;
        const wrapped = { ...response, text: async (...textArgs) => {
          try {
            const body = await response.text(...textArgs);
            wrapped.challenge = response.challenge;
            markChallenge(response);
            return body;
          }
          catch (err) { unresolved.add(key); throw err; }
        } };
        return wrapped;
      } catch (err) {
        unresolved.add(key);
        throw err;
      }
    };
  }
  return observed;
}

export function assessmentFor(coverage, requiredChecks) {
  const byCheck = new Map(coverage.map((entry) => [entry.check, entry]));
  const missing = [...new Set(requiredChecks)].filter((check) => byCheck.get(check)?.status !== "completed");
  return missing.length
    ? { status: "incomplete", reason: `Required checks did not complete: ${missing.join(", ")}.` }
    : { status: "complete", reason: "All required checks completed. Optional check coverage is listed separately." };
}

/** Hash actual stored image bytes, then bind their references to those hashes. */
export function bindArtifactHashes(findings, shots) {
  const artifacts = new Map();
  for (const shot of shots || []) {
    if (!shot?.key || !(Buffer.isBuffer(shot.bytes) || shot.bytes instanceof Uint8Array) || !shot.bytes.length) continue;
    if (artifacts.has(shot.key)) continue; // storage keeps the first value for a key
    artifacts.set(shot.key, { key: shot.key, sha256: createHash("sha256").update(shot.bytes).digest("hex"),
      mime: shot.mime || "image/jpeg", bytes: shot.bytes.length });
  }
  for (const finding of findings) {
    for (const ref of finding.evidence?.shots || []) {
      const artifact = artifacts.get(ref.key);
      if (artifact) ref.sha256 = artifact.sha256;
    }
  }
  return [...artifacts.values()];
}
