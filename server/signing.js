// signing.js
// Ed25519 primitives for the "Checked by SUTROS" attestation. The canonical
// report payload and endpoints live in the report/verify layer; this module
// only loads the key, signs bytes, verifies, and exposes the public key.

import crypto from "node:crypto";

let priv = null;
let pub = null;
let keyId = null;

function load() {
  if (priv) return;
  const b64 = process.env.SIGNING_PRIVATE_KEY;
  if (!b64) throw new Error("SIGNING_PRIVATE_KEY is not set");
  priv = crypto.createPrivateKey({ key: Buffer.from(b64, "base64"), format: "der", type: "pkcs8" });
  pub = crypto.createPublicKey(priv);
  const spki = pub.export({ type: "spki", format: "der" });
  keyId = crypto.createHash("sha256").update(spki).digest("base64url").slice(0, 16);
}

export function signingEnabled() {
  return Boolean(process.env.SIGNING_PRIVATE_KEY);
}

/** Stable JSON: sorted keys, no whitespace, so the same object always yields the same bytes. */
export function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonicalize(value[k])).join(",") + "}";
}

export function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** Sign a canonical string; returns base64url signature. */
export function sign(canonicalText) {
  load();
  return crypto.sign(null, Buffer.from(canonicalText, "utf8"), priv).toString("base64url");
}

/** Verify with this server's public key (or a supplied SPKI base64). */
export function verify(canonicalText, signatureB64url, publicKeySpkiB64) {
  const key = publicKeySpkiB64
    ? crypto.createPublicKey({ key: Buffer.from(publicKeySpkiB64, "base64"), format: "der", type: "spki" })
    : (load(), pub);
  try {
    return crypto.verify(null, Buffer.from(canonicalText, "utf8"), key, Buffer.from(signatureB64url, "base64url"));
  } catch {
    return false;
  }
}

/** Public key material for /.well-known and the verify page. */
export function publicKeyInfo() {
  load();
  return {
    keyId,
    algorithm: "Ed25519",
    publicKeySpkiBase64: pub.export({ type: "spki", format: "der" }).toString("base64"),
    publicKeyPem: pub.export({ type: "spki", format: "pem" }),
  };
}
