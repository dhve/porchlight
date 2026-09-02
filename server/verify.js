// verify.js  (the VERIFY agent extends this file with routes; signReport is final)
import express from "express";
import { canonicalize, sha256Hex, sign, signingEnabled, publicKeyInfo } from "./signing.js";
export const verifyRouter = express.Router();

/** Sign a finished report. Returns the attestation object or null when signing is off. */
export function signReport(report) {
  if (!signingEnabled()) return null;
  const payload = {
    v: 1, id: report.id, target: report.target, url: report.url, grade: report.grade, score: report.score, scannedAt: report.scannedAt,
    findingsDigest: sha256Hex(canonicalize((report.findings || []).map((f) => ({ id: f.id, severity: f.severity, title: f.title })))),
  };
  const signature = sign(canonicalize(payload));
  return { v: 1, keyId: publicKeyInfo().keyId, signature, signedAt: new Date().toISOString(), payload };
}
