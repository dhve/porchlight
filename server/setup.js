// setup.js
// One-time, token-gated helpers used during initial deployment so provider
// secrets can flow from the owner's browser straight to this server's .env
// without anyone copying them by hand. Disable by removing SETUP_TOKEN from
// .env (every route here returns 404 when it is unset).

import fs from "node:fs";
import path from "node:path";
import express from "express";

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
