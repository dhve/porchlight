// setup.js
// One-time, token-gated helpers used during initial deployment so provider
// secrets can flow from the owner's browser straight to this server's .env
// without anyone copying them by hand. Disable by removing SETUP_TOKEN from
// .env (every route here returns 404 when it is unset).

import fs from "node:fs";
import path from "node:path";
import express from "express";
import { resetMail, sendMail, mailStatus } from "./mail.js";

const ALLOWED = new Set([
  "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET",
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET",
  "SMTP_URL", "MAIL_FROM", "GMAIL_USER", "GMAIL_REFRESH_TOKEN",
]);

export function setupRouter(ROOT) {
  const r = express.Router();
  const envPath = path.join(ROOT, ".env");
  const token = () => process.env.SETUP_TOKEN || "";

  function upsert(key, value) {
    let text = "";
    try { text = fs.readFileSync(envPath, "utf8"); } catch {}
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    text = re.test(text) ? text.replace(re, line) : text.replace(/\n?$/, "\n") + line + "\n";
    fs.writeFileSync(envPath, text, { mode: 0o600 });
    process.env[key] = value;
  }

  r.get("/setup/relay", (_req, res) => {
    if (!token()) return res.status(404).end();
    res.type("html").send(RELAY_HTML);
  });

  r.post("/setup/secrets", express.json({ limit: "32kb" }), (req, res) => {
    if (!token() || !req.body || req.body.t !== token()) return res.status(403).json({ error: "not allowed" });
    const saved = [];
    for (const [k, v] of Object.entries(req.body.values || {})) {
      if (ALLOWED.has(k) && typeof v === "string" && v.length && v.length < 4096) { upsert(k, v.trim()); saved.push(k); }
    }
    res.json({ ok: true, saved });
  });

  // ---- Connect Gmail for sending (OAuth2, refresh token stored server-side) ----
  r.get("/setup/gmail", (req, res) => {
    if (!token() || req.query.t !== token()) return res.status(404).end();
    if (!process.env.GOOGLE_CLIENT_ID) return res.status(500).send("GOOGLE_CLIENT_ID is not set");
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID);
    u.searchParams.set("redirect_uri", `${process.env.APP_URL}/setup/gmail/callback`);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", "https://www.googleapis.com/auth/gmail.send openid email");
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent");
    u.searchParams.set("state", token());
    res.redirect(u.href);
  });

  r.get("/setup/gmail/callback", async (req, res) => {
    if (!token() || req.query.state !== token()) return res.status(403).send("bad state");
    if (req.query.error) return res.status(400).send("Google said: " + String(req.query.error));
    try {
      const body = new URLSearchParams({
        code: String(req.query.code || ""),
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${process.env.APP_URL}/setup/gmail/callback`,
        grant_type: "authorization_code",
      });
      const tr = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
      const tj = await tr.json();
      if (!tj.refresh_token) return res.status(400).send("No refresh token returned (" + (tj.error_description || tj.error || "unknown") + ").");
      const ur = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: "Bearer " + tj.access_token } });
      const uj = await ur.json();
      if (!uj.email) return res.status(400).send("Could not read the Gmail address.");
      upsert("GMAIL_USER", uj.email);
      upsert("GMAIL_REFRESH_TOKEN", tj.refresh_token);
      resetMail();
      res.type("html").send(`<p style="font-family:Helvetica Neue,Arial,sans-serif;padding:40px">Gmail connected for <b>${uj.email}</b>. Sutros will send account emails from this address. You can close this tab.</p>`);
    } catch (err) {
      res.status(500).send("Gmail connect failed: " + err.message);
    }
  });

  // Send a test message to confirm delivery works.
  r.get("/setup/mailtest", async (req, res) => {
    if (!token() || req.query.t !== token()) return res.status(404).end();
    const to = String(req.query.to || "");
    if (!/^\S+@\S+\.\S+$/.test(to)) return res.status(400).json({ error: "bad 'to'" });
    const out = await sendMail({ to, subject: "Sutros test email", text: "This is a test message from Sutros. Email sending works.", html: "<p>This is a test message from <b>Sutros</b>. Email sending works.</p>" });
    res.json({ ...out, status: mailStatus() });
  });

  // Status without values: which keys are set (used to confirm setup worked).
  r.get("/setup/status", (req, res) => {
    if (!token() || req.query.t !== token()) return res.status(404).end();
    const out = {};
    for (const k of ALLOWED) out[k] = Boolean(process.env[k]);
    res.json(out);
  });

  return r;
}

const RELAY_HTML = `<!doctype html><meta charset="utf-8"><title>Sutros setup</title>
<style>body{font-family:Helvetica Neue,Arial,sans-serif;padding:40px;color:#12261E}b{color:#1E8C63}</style>
<p id="m">Saving…</p>
<script>
(function(){
  var h = location.hash.slice(1); history.replaceState(null, "", location.pathname);
  var p = new URLSearchParams(h), t = p.get("t"), values = {};
  p.forEach(function(v,k){ if(k!=="t") values[k]=v; });
  fetch("/setup/secrets",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({t:t,values:values})})
    .then(function(r){return r.json()}).then(function(j){ document.getElementById("m").innerHTML = j.ok ? "<b>Saved:</b> "+j.saved.join(", ") : "Not saved: "+(j.error||"error"); })
    .catch(function(){ document.getElementById("m").textContent="Network error"; });
})();
</script>`;
