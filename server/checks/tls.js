// tls.js
// Step 3: the padlock, in depth. A read-only TLS handshake to check:
//  - certificate expiry (expired / expiring soon)
//  - certificate strength (key size) and whether it's self-signed
//  - whether the server still allows the deprecated TLS 1.0 / 1.1 protocols
//
// Nothing is sent to the site beyond standard handshakes.

import tls from "node:tls";
import { config } from "../safety.js";

export async function runTls(ctx) {
  const { facts } = ctx;
  const findings = [];
  const passes = [];
  if (!facts.isHttps) return { findings, passes };

  const host = facts.finalUrl.hostname;
  let cert;
  try {
    cert = await getCertificate(host);
  } catch {
    return { findings, passes };
  }
  if (!cert || !cert.valid_to) return { findings, passes };

  // ---- expiry ----
  const daysLeft = Math.round((new Date(cert.valid_to).getTime() - Date.now()) / 86_400_000);
  if (daysLeft < 0) {
    findings.push(mk("cert-expired", "urgent", "Your security certificate has expired",
      "The certificate that powers your padlock has expired. Most browsers now show visitors a full-page red warning before they can reach your site.",
      ["Renew the SSL certificate right away (many hosts and Let's Encrypt renew for free).", "Turn on auto-renewal so this can't happen again."],
      "Your hosting provider or web person, urgently.",
      [`Certificate expired ${Math.abs(daysLeft)} day(s) ago`, `valid_to: ${cert.valid_to}`]));
  } else if (daysLeft <= 14) {
    findings.push(mk("cert-expiring", "watch", "Your security certificate expires soon",
      `Your padlock certificate expires in ${daysLeft} day(s). If it lapses, visitors will hit a scary security warning.`,
      ["Renew the certificate now and enable automatic renewal."],
      "Your hosting provider or web person.",
      [`Expires in ${daysLeft} day(s)`, `valid_to: ${cert.valid_to}`]));
  } else {
    passes.push(`Your security certificate is valid for ${daysLeft} more days.`);
  }

  // ---- key strength (curve-aware: ECC 256-bit is strong, RSA needs >= 2048) ----
  const isEcc = Boolean(cert.nistCurve || cert.asn1Curve);
  const weakKey = cert.bits && (isEcc ? cert.bits < 224 : cert.bits < 2048);
  if (weakKey) {
    findings.push(mk("weak-cert-key", "serious", "Your certificate uses a weak key",
      `Your certificate's encryption key (${cert.bits} bits${isEcc ? ", elliptic curve" : ", RSA"}) is below modern guidance, which makes it easier to break.`,
      [isEcc ? "Ask your host to reissue the certificate with a 256-bit (or stronger) elliptic-curve key." : "Ask your host to reissue the certificate with a 2048-bit (or stronger) RSA key."],
      "Your hosting provider.",
      [`Key size: ${cert.bits} bits (${isEcc ? "ECC " + (cert.nistCurve || cert.asn1Curve) : "RSA"})`]));
  }

  // ---- self-signed ----
  const issuerCN = cert.issuer && cert.issuer.CN;
  const subjectCN = cert.subject && cert.subject.CN;
  if (issuerCN && subjectCN && issuerCN === subjectCN) {
    findings.push(mk("self-signed-cert", "serious", "Your certificate isn't from a trusted authority",
      "Your site's certificate appears to be self-signed. Browsers don't trust it, so visitors see a security warning and many will leave.",
      ["Replace it with a certificate from a trusted authority. Let's Encrypt is free and most hosts offer it in one click."],
      "Your hosting provider or web person.",
      [`Issuer and subject are the same (${issuerCN})`]));
  } else if (issuerCN) {
    passes.push(`Your certificate is issued by ${issuerCN}.`);
  }

  // ---- deprecated protocol versions ----
  const oldProtos = [];
  for (const v of ["TLSv1", "TLSv1.1"]) {
    if (await supportsProtocol(host, v)) oldProtos.push(v);
  }
  if (oldProtos.length) {
    findings.push(mk("old-tls-protocols", "serious", "Your site still allows outdated encryption",
      `Your server accepts ${oldProtos.join(" and ")}, protocols that are officially retired and known to be weak. Attackers can use them to weaken the connection.`,
      ["Ask your host to disable TLS 1.0 and 1.1 and allow only TLS 1.2 and 1.3."],
      "Your hosting provider.",
      oldProtos.map((v) => `Server accepts ${v} (deprecated)`)));
  } else {
    passes.push("Your site only allows modern, secure encryption protocols.");
  }

  return { findings, passes };
}

function mk(id, severity, title, meaning, fix, who, lines) {
  return { id, category: "tls", severity, title, meaning, fix, who, evidence: { lines, note: "Read-only TLS handshake." } };
}

function getCertificate(host) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host, port: 443, servername: host, timeout: config.requestTimeoutMs, rejectUnauthorized: false },
      () => { const c = socket.getPeerCertificate(); socket.end(); resolve(c && Object.keys(c).length ? c : null); }
    );
    socket.on("error", reject);
    socket.on("timeout", () => { socket.destroy(); reject(new Error("TLS timeout")); });
  });
}

function supportsProtocol(host, version) {
  return new Promise((resolve) => {
    let socket;
    try {
      socket = tls.connect({ host, port: 443, servername: host, minVersion: version, maxVersion: version, rejectUnauthorized: false, timeout: config.requestTimeoutMs },
        () => { socket.end(); resolve(true); });
      socket.on("error", () => resolve(false));
      socket.on("timeout", () => { socket.destroy(); resolve(false); });
    } catch { resolve(false); }
  });
}
