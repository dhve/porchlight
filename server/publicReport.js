// The public report is an observation of a website, not a public account record.
// Keep ownership in storage and derive permissions for the current viewer here.
const REPORT_FIELDS = [
  "id", "target", "url", "scannedAt", "created_at", "grade", "gradeLabel", "score",
  "ringPercent", "tally", "summary", "findings", "passes", "assessment", "coverage",
  "engine", "agent", "proofPromise", "contact", "attestation", "topFindings",
];

const PRIVATE_FIELDS = new Set([
  "userId", "user_id", "accountId", "account_id", "ownerId", "owner_id",
  "submitterId", "submitter_id", "voterKey", "voter_key", "sessionId", "session_id",
  "by", "user", "account", "owner", "submitter", "privateNotes", "private_notes",
]);

function withoutPrivateFields(value, feedback = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !PRIVATE_FIELDS.has(key) && !(feedback && ["notes", "name", "email", "ip", "userAgent"].includes(key))));
}

function publicFinding(finding) {
  const out = withoutPrivateFields(finding);
  if (!out || typeof out !== "object" || Array.isArray(out)) return out;
  if (out.disputed) out.disputed = withoutPrivateFields(out.disputed, true);
  if (out.feedback) out.feedback = withoutPrivateFields(out.feedback, true);
  // Evidence, source, AI observations, and their measurements remain exactly as
  // recorded. In particular, a measured name/IP is not the submitter's identity.
  return out;
}

export function publicReport(report, viewer = null) {
  if (!report || typeof report !== "object" || Array.isArray(report)) return null;
  const out = {};
  for (const key of REPORT_FIELDS) {
    if (!Object.hasOwn(report, key)) continue;
    out[key] = key === "findings" && Array.isArray(report.findings)
      ? report.findings.map(publicFinding) : report[key];
  }
  const knownOwner = Object.hasOwn(report, "userId") || Object.hasOwn(report, "user_id");
  const owner = Object.hasOwn(report, "userId") ? report.userId : report.user_id;
  out.canPostToBulletin = Boolean(viewer?.id && viewer.emailVerified && knownOwner &&
    (owner == null || owner === viewer.id || viewer.role === "admin"));
  return out;
}
