// mail.js
// Outbound email for account verification and password resets.
// Transports, in order of preference:
//   1. SMTP_URL                      any SMTP provider (smtp://user:pass@host:587)
//   2. GMAIL_USER + GMAIL_REFRESH_TOKEN  Gmail via OAuth2 (uses the Google OAuth client)
//   3. console                       no transport configured: log the message and link
// Nothing here ever throws to the caller; sendMail() resolves { ok, via }.

import nodemailer from "nodemailer";

let transport = null;
let via = "console";

function build() {
  if (transport) return transport;
  if (process.env.SMTP_URL) {
    transport = nodemailer.createTransport(process.env.SMTP_URL, { connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000 });
    via = "smtp";
  } else if (process.env.GMAIL_USER && process.env.GMAIL_REFRESH_TOKEN && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    // Gmail over the REST API (HTTPS). Many hosts block outbound SMTP ports.
    transport = { gmailApi: true };
    via = "gmail";
  } else {
    via = "console";
  }
  return transport;
}

export function mailStatus() {
  build();
  return { configured: via !== "console", via };
}

/** Reset the cached transport (after setup writes new env values). */
export function resetMail() { transport = null; via = "console"; }

function from() {
  const f = process.env.MAIL_FROM || "Sutros <no-reply@sutros.org>";
  // Gmail sends as the authorized account; keep the display name.
  if (via === "gmail" && process.env.GMAIL_USER) {
    const name = f.replace(/<.*$/, "").trim().replace(/^"|"$/g, "") || "Sutros";
    return `${name} <${process.env.GMAIL_USER}>`;
  }
  return f;
}

/**
 * Send an email. Falls back to logging when no transport is configured so
 * verification and reset links still appear in the server log during setup.
 */
export async function sendMail({ to, subject, text, html }) {
  const t = build();
  if (!t) {
    console.log(`\n[mail] (no transport configured) To: ${to}\nSubject: ${subject}\n${text}\n`);
    return { ok: true, via: "console" };
  }
  try {
    if (t.gmailApi) await sendViaGmailApi({ from: from(), to, subject, text, html });
    else await t.sendMail({ from: from(), to, subject, text, html });
    return { ok: true, via };
  } catch (err) {
    console.error("[mail] send failed:", err.message);
    console.log(`\n[mail] fallback copy. To: ${to}\nSubject: ${subject}\n${text}\n`);
    return { ok: false, via, error: err.message };
  }
}

// ---- Gmail REST API transport ----
async function gmailAccessToken() {
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: process.env.GMAIL_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  if (!j.access_token) throw new Error("gmail token: " + (j.error_description || j.error || "no access token"));
  return j.access_token;
}
function encodeHeader(v) {
  return /^[\x20-\x7e]*$/.test(v) ? v : "=?UTF-8?B?" + Buffer.from(v, "utf8").toString("base64") + "?=";
}
function buildRaw({ from, to, subject, text, html }) {
  const boundary = "sutros_" + Math.random().toString(36).slice(2);
  const lines = [
    `From: ${from}`, `To: ${to}`, `Subject: ${encodeHeader(subject)}`, "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 8bit", "", text, "",
    `--${boundary}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: 8bit", "", html || text, "",
    `--${boundary}--`,
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}
async function sendViaGmailApi(msg) {
  const token = await gmailAccessToken();
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: buildRaw(msg) }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error("gmail api " + r.status + ": " + (await r.text()).slice(0, 200));
}

// ---- templates (plain, warm, no analogies) ----
export function verifyEmailMessage({ name, link }) {
  const hi = name ? `Hi ${name},` : "Hi,";
  const text = `${hi}\n\nConfirm your email to finish setting up your Sutros account:\n${link}\n\nThis link works for 24 hours. If you didn't create an account, you can ignore this email.\n\nSutros`;
  const html = `<p>${hi}</p><p>Confirm your email to finish setting up your Sutros account:</p><p><a href="${link}">${link}</a></p><p>This link works for 24 hours. If you didn't create an account, you can ignore this email.</p><p>Sutros</p>`;
  return { subject: "Confirm your Sutros email", text, html };
}
export function resetPasswordMessage({ name, link }) {
  const hi = name ? `Hi ${name},` : "Hi,";
  const text = `${hi}\n\nHere is your link to choose a new Sutros password:\n${link}\n\nIt works for one hour and can be used once. If you didn't ask for this, you can ignore this email and your password stays the same.\n\nSutros`;
  const html = `<p>${hi}</p><p>Here is your link to choose a new Sutros password:</p><p><a href="${link}">${link}</a></p><p>It works for one hour and can be used once. If you didn't ask for this, you can ignore this email and your password stays the same.</p><p>Sutros</p>`;
  return { subject: "Reset your Sutros password", text, html };
}
