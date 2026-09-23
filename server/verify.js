// verify.js
// The "Checked by SUTROS" attestation: signing a finished report, the public
// key endpoint, the verify API, the badge image, and the verify page shell.
//
// Routes (all GET; saved report routes use the access guard in index.js):
//   /.well-known/sutros-signing-key.json  public key + key id
//   /api/verify/:id                        recompute + check a saved report's signature
//   /badge/:id.svg                         small SVG badge for a saved report
//   /verify/:id                            the SPA shell (the client renders the verify screen)

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize, canonicalizeV1, sha256Hex, sign, verify, signingEnabled, publicKeyInfo } from "./signing.js";
import { sql } from "./db.js";
import { publicReport } from "./publicReport.js";

export const verifyRouter = express.Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.resolve(__dirname, "..", "public", "index.html");
const ID_RE = /^[A-Za-z0-9_-]{6,20}$/;

/** Sign a finished report. Returns the attestation object or null when signing is off. */
export function signReport(report) {
  if (!signingEnabled()) return null;
  const payload = payloadFor(report, 2);
  const signature = sign(canonicalize(payload));
  return { v: 2, keyId: publicKeyInfo().keyId, signature, signedAt: new Date().toISOString(), payload };
}

// ---------------------------------------------------------------------------
// helpers

/** Public origin without a trailing slash. */
function appUrl() {
  return String(process.env.APP_URL || "").replace(/\/+$/, "");
}

/**
 * Bind public report sections after applying the same privacy boundary used by
 * report routes. Ownership, contact hints, and viewer capabilities are not signed.
 * Keep the narrower historical payload exactly as it was for version 1.
 */
function payloadFor(report, version) {
  const core = { v: version, id: report.id, target: report.target, url: report.url,
    grade: report.grade, score: report.score, scannedAt: report.scannedAt };
  if (version === 1) {
    return { ...core, findingsDigest: sha256Hex(canonicalizeV1((report.findings || []).map((f) => ({ id: f.id, severity: f.severity, title: f.title })))) };
  }
  if (version !== 2) return null;
  const view = publicReport(report);
  const digest = (value) => sha256Hex(canonicalize(value ?? null));
  return { ...core,
    findingsDigest: digest(view.findings || []),
    passesDigest: digest(view.passes || []),
    coverageDigest: digest(view.coverage),
    assessmentDigest: digest(view.assessment),
    summaryDigest: digest(view.summary),
    engineDigest: digest(view.engine),
    detailsDigest: digest({ gradeLabel: view.gradeLabel, ringPercent: view.ringPercent,
      tally: view.tally, proofPromise: view.proofPromise, agent: view.agent }),
  };
}

/** Load one saved report row, or null. Throws when the database is off. */
async function loadRow(id) {
  const rows = await sql(
    `SELECT id, target, grade, score, report, signature, key_id, signed_at, created_at
       FROM reports WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

/** The stored report JSON as an object, with the row id in place. */
function reportOf(row) {
  let report = row.report;
  if (typeof report === "string") {
    try { report = JSON.parse(report); } catch { report = {}; }
  }
  if (!report || typeof report !== "object") report = {};
  return { ...report, id: row.id };
}

/** Plain sentence for a database problem, with the right status. */
function dbFailure(res, err, what) {
  if (err && /not configured/i.test(err.message || "")) {
    return res.status(503).json({ error: "Saved reports need a database, which isn't set up here yet." });
  }
  console.error(what + ":", err && err.message ? err.message : err);
  return res.status(500).json({ error: "Could not load that report right now. Please try again." });
}

/** YYYY-MM-DD from a date-like value, or "" when it can't be read. */
function shortDate(value) {
  const d = value ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

/** Escape text for use inside SVG/XML. */
function esc(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const GRADE_COLORS = { 'A+': "#15803D", A: "#15803D", B: "#15803D", C: "#CFA23A", D: "#DC2626", F: "#991B1B" };

/** Decide what the verify API should say about a stored row. */
function assess(row) {
  const report = reportOf(row);
  const att = report.attestation && typeof report.attestation === "object" ? report.attestation : null;
  const signature = (att && att.signature) || row.signature || null;
  const keyId = (att && att.keyId) || row.key_id || null;
  const signedAt = (att && att.signedAt) || row.signed_at || null;
  const version = att?.v ?? att?.payload?.v ?? 1;
  const payload = payloadFor(report, version);
  const encode = version === 1 ? canonicalizeV1 : canonicalize;
  const canonical = payload ? encode(payload) : null;

  let valid = false;
  let reason = null;
  let currentKeyId = null;
  let publicKeySpkiBase64 = null;

  if (signingEnabled()) {
    const info = publicKeyInfo();
    currentKeyId = info.keyId;
    publicKeySpkiBase64 = info.publicKeySpkiBase64;
  }

  if (!payload) {
    reason = "This report uses an unsupported signature version.";
  } else if (!signature) {
    reason = "This report was saved without a signature, so there is nothing to check.";
  } else if (!currentKeyId) {
    reason = "Signing isn't set up on this server, so the signature can't be checked here.";
  } else if (verify(canonical, signature)) {
    valid = true;
  } else if (att && att.payload && typeof att.payload === "object" && verify(encode(att.payload), signature)) {
    // The signature checks out against the payload stored with it, so the key
    // is right and the report body is what changed. Check this before trusting
    // the key id written inside the same JSON.
    reason = "The signature is real, but the report contents no longer match what was signed.";
  } else if (keyId && keyId !== currentKeyId) {
    reason = "This report was signed with a different key than the one this server uses now.";
  } else {
    reason = "The signature doesn't match this report.";
  }

  return {
    valid,
    reason,
    version,
    scope: version === 2
      ? "Version 2 covers the public findings and their evidence, source, advice, artifact hashes, passes, coverage, assessment, summary, engine, and report metadata."
      : "Version 1 covers the report identity, target, URL, grade, score, scan time, and finding IDs, severities, and titles.",
    limits: version === 2
      ? "A valid signature establishes the origin and integrity of the signed content. It does not establish factual correctness. Verification does not fetch current picture bytes or check whether saved pictures remain available."
      : "Version 1 does not cover evidence, source, explanations, passes, summary, coverage, or engine metadata. A valid signature does not establish factual correctness.",
    // Name the key that verified the report, or the one the report claims.
    // Never fall back to the server's live key for a report it did not sign.
    keyId: valid ? currentKeyId : keyId,
    payload,
    canonical,
    signature,
    signedAt,
    publicKeySpkiBase64,
    report: {
      id: report.id,
      target: report.target || row.target,
      grade: report.grade || row.grade,
      score: report.score === null || typeof report.score === "number" ? report.score : row.score,
      scannedAt: report.scannedAt || row.created_at,
      gradeLabel: report.gradeLabel || null,
    },
  };
}

// ---------------------------------------------------------------------------
// badge

/**
 * A small lotus mark: three petals on a short stem, drawn with plain paths.
 * Positioned by a transform so the badge layout stays simple.
 */
function lotusMark(x, y, color) {
  return (
    `<g transform="translate(${x} ${y})" fill="${color}">` +
    // center petal
    `<path d="M12 2 C9.4 6.2 9.4 12 12 15.6 C14.6 12 14.6 6.2 12 2 Z"/>` +
    // left petal
    `<path d="M4.2 6.4 C5.2 11 8 14.8 11.4 16.2 C11.2 12 9 8 4.2 6.4 Z"/>` +
    // right petal
    `<path d="M19.8 6.4 C18.8 11 16 14.8 12.6 16.2 C12.8 12 15 8 19.8 6.4 Z"/>` +
    // pad under the flower
    `<path d="M2.6 17.2 C5.6 20.6 18.4 20.6 21.4 17.2 C17.4 18.8 6.6 18.8 2.6 17.2 Z" opacity="0.85"/>` +
    `</g>`
  );
}

const BADGE_FONT = "font-family=\"system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif\"";

/** Shared frame: border, lotus mark, and the "Checked by SUTROS" line. */
function badgeFrame(label, markColor) {
  const w = 230;
  const h = 40;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">` +
    `<title>${esc(label)}</title>` +
    `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="8" fill="#FFFFFF" stroke="#DCEBE2"/>` +
    lotusMark(9, 8, markColor) +
    `<text x="40" y="17" ${BADGE_FONT} font-size="12" fill="#12261E">` +
    `<tspan>Checked by </tspan><tspan font-weight="700" letter-spacing="0.4">SUTROS</tspan>` +
    `</text>`
  );
}

/** The confirmed badge: grade letter in the grade color inside an outlined disc, plus the date. */
function badgeSvg({ grade, date, ringPercent }) {
  const candidate = String(grade || '').trim().toUpperCase();
  const letter = Object.hasOwn(GRADE_COLORS, candidate) ? candidate : '?';
  const color = GRADE_COLORS[letter] || "#7A9187";
  const percent = letter !== '?' && Number.isFinite(Number(ringPercent)) ? Math.max(0, Math.min(100, Number(ringPercent))) : 0;
  const label = `Checked by SUTROS, grade ${letter}${date ? ", " + date : ""}`;
  return (
    badgeFrame(label, color) +
    `<text x="40" y="31" ${BADGE_FONT} font-size="10" fill="#3F5A4F">${esc(date || "Signed report")}</text>` +
    `<circle cx="206" cy="20" r="14" fill="none" stroke="#DCEBE2" stroke-width="2"/>` +
    `<circle cx="206" cy="20" r="14" fill="none" stroke="${color}" stroke-width="2" pathLength="100" stroke-dasharray="100" stroke-dashoffset="${100 - percent}" transform="rotate(-90 206 20)"/>` +
    `<text x="206" y="25" ${BADGE_FONT} font-size="${letter === 'A+' ? 12 : 15}" font-weight="700" fill="${color}" text-anchor="middle">${esc(letter)}</text>` +
    `</svg>`
  );
}

/**
 * The neutral badge for a report whose signature does not check out, or that
 * has no signature on a server that signs. No grade letter, gray disc.
 */
function unconfirmedSvg() {
  const gray = "#9CA3AF";
  const label = "Checked by SUTROS, unconfirmed";
  return (
    badgeFrame(label, "#7A9187") +
    `<text x="40" y="31" ${BADGE_FONT} font-size="10" fill="#3F5A4F">Unconfirmed</text>` +
    `<circle cx="206" cy="20" r="14" fill="none" stroke="${gray}" stroke-width="1.5"/>` +
    `</svg>`
  );
}

function notFoundSvg() {
  const font = BADGE_FONT;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="230" height="40" viewBox="0 0 230 40" role="img" aria-label="Report not found">` +
    `<title>Report not found</title>` +
    `<rect x="0.5" y="0.5" width="229" height="39" rx="8" fill="#FFFFFF" stroke="#DCEBE2"/>` +
    lotusMark(9, 8, "#7A9187") +
    `<text x="40" y="24" ${font} font-size="12" fill="#3F5A4F">Report not found</text>` +
    `</svg>`
  );
}

// ---------------------------------------------------------------------------
// routes

verifyRouter.get("/.well-known/sutros-signing-key.json", (_req, res) => {
  if (!signingEnabled()) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).json({ error: "Report signing isn't set up on this server yet." });
  }
  let info;
  try {
    info = publicKeyInfo();
  } catch (err) {
    console.error("signing key:", err && err.message ? err.message : err);
    res.setHeader("Cache-Control", "no-store");
    return res.status(500).json({ error: "The signing key could not be read." });
  }
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.json({
    keyId: info.keyId,
    algorithm: info.algorithm,
    publicKeySpkiBase64: info.publicKeySpkiBase64,
    publicKeyPem: info.publicKeyPem,
    verifyUrl: `${appUrl()}/verify/{id}`,
  });
});

verifyRouter.get("/api/verify/:id", async (req, res) => {
  const id = String(req.params.id || "");
  if (!ID_RE.test(id)) return res.status(404).json({ error: "We couldn't find that report." });
  let row;
  try {
    row = await loadRow(id);
  } catch (err) {
    return dbFailure(res, err, "verify report");
  }
  if (!row) return res.status(404).json({ error: "We couldn't find that report." });
  let result;
  try {
    result = assess(row);
  } catch (err) {
    console.error("verify report:", err && err.message ? err.message : err);
    return res.status(500).json({ error: "Could not check that report right now. Please try again." });
  }
  res.setHeader("Cache-Control", "no-store");
  res.json(result);
});

verifyRouter.get("/badge/:id.svg", async (req, res) => {
  const id = String(req.params.id || "");
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (!ID_RE.test(id)) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(404).send(notFoundSvg());
  }
  let row;
  try {
    row = await loadRow(id);
  } catch (err) {
    if (!(err && /not configured/i.test(err.message || ""))) console.error("badge:", err && err.message ? err.message : err);
    res.setHeader("Cache-Control", "no-store");
    return res.status(err && /not configured/i.test(err.message || "") ? 503 : 500).send(notFoundSvg());
  }
  if (!row) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(404).send(notFoundSvg());
  }
  let result;
  try {
    result = assess(row);
  } catch (err) {
    console.error("badge:", err && err.message ? err.message : err);
    res.setHeader("Cache-Control", "no-store");
    return res.status(500).send(notFoundSvg());
  }

  if (result.valid) {
    // Render only what the signature covers. result.payload was rebuilt from
    // the stored report and just verified, so its values are the signed ones.
    const signed = result.payload || {};
    res.setHeader("Cache-Control", "private, no-store");
    return res.send(badgeSvg({ grade: signed.grade, date: shortDate(signed.scannedAt),
      ringPercent: result.version === 2 ? reportOf(row).ringPercent : signed.score }));
  }

  if (result.signature || signingEnabled()) {
    // A signature that does not check out, or a report this server should have
    // signed but did not. Do not stamp a grade, and do not let caches keep it.
    res.setHeader("Cache-Control", "no-store");
    return res.send(unconfirmedSvg());
  }

  // No signing key on this server and nothing to check: show the stored values as before.
  const report = reportOf(row);
  res.setHeader("Cache-Control", "private, no-store");
  res.send(badgeSvg({
    grade: report.grade || row.grade,
    ringPercent: report.ringPercent ?? report.score ?? row.score,
    date: shortDate(report.scannedAt) || shortDate(row.created_at),
  }));
});

verifyRouter.get("/verify/:id", (_req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(INDEX_HTML, (err) => {
    if (err && !res.headersSent) res.status(500).json({ error: "Could not load the page." });
  });
});
