// tls.js
// Step 3: check the padlock. Connect over TLS and read the certificate's
// expiry date. A read-only handshake, nothing is sent to the site.

import tls from "node:tls";
import { config } from "../safety.js";

export async function runTls(ctx) {
  const { facts } = ctx;
  const findings = [];
  const passes = [];

  if (!facts.isHttps) {
    // The "no secure connection" case is already reported by recon.
    return { findings, passes };
  }

  const host = facts.finalUrl.hostname;
  let cert;
  try {
    cert = await getCertificate(host);
  } catch {
    return { findings, passes }; // don't invent a finding on a handshake glitch
  }
  if (!cert || !cert.valid_to) return { findings, passes };

  const expires = new Date(cert.valid_to);
  const daysLeft = Math.round((expires.getTime() - Date.now()) / 86_400_000);

  if (daysLeft < 0) {
    findings.push({
      id: "cert-expired",
      category: "tls",
      severity: "urgent",
      title: "Your security certificate has expired",
      meaning:
        "The certificate that powers your padlock has expired. Most browsers now show visitors a full-page red warning before they can reach your site, which turns customers away.",
      fix: [
        "Renew the SSL certificate right away (many hosts and Let's Encrypt renew for free).",
        "Turn on auto-renewal so this can't happen again.",
      ],
      who: "Your hosting provider or web person, urgently.",
      evidence: { lines: [`Certificate expired ${Math.abs(daysLeft)} day(s) ago`, `valid_to: ${cert.valid_to}`], note: "Read-only TLS handshake." },
    });
  } else if (daysLeft <= 14) {
    findings.push({
      id: "cert-expiring",
      category: "tls",
      severity: "watch",
      title: "Your security certificate expires soon",
      meaning: `Your padlock certificate expires in ${daysLeft} day(s). If it lapses, visitors will hit a scary security warning.`,
      fix: ["Renew the certificate now and enable automatic renewal so it stays ahead of the deadline."],
      who: "Your hosting provider or web person.",
      evidence: { lines: [`Expires in ${daysLeft} day(s)`, `valid_to: ${cert.valid_to}`], note: "Read-only TLS handshake." },
    });
  } else {
    passes.push(`Your security certificate is valid for ${daysLeft} more days.`);
  }

  return { findings, passes };
}

function getCertificate(host) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host, port: 443, servername: host, timeout: config.requestTimeoutMs, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        resolve(cert && Object.keys(cert).length ? cert : null);
      }
    );
    socket.on("error", reject);
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("TLS timeout"));
    });
  });
}
