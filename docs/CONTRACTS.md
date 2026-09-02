# Sutros accounts + community: implementation contracts

Read this before touching code. Modules are owned; do not edit files you do not own.
Stack: Node 22 ESM, Express, Postgres via `pg` (helpers in server/db.js), vanilla-JS SPA.
Live: https://sutros.org (Caddy TLS proxy -> :3300). APP_URL env is the public origin.

## Ownership
- server/db.js, server/index.js, server/pipeline.js, server/checks/*, public/core.js, public/index.html, public/styles.css, public/app.js  -> INTEGRATOR only (already done; do not edit).
- server/auth.js + server/mail.js usage           -> agent AUTH
- server/oauth.js                                  -> agent OAUTH
- server/verify.js (signing routes, badge)         -> agent VERIFY
- server/bulletin.js                               -> agent BULLETIN
- public/auth-ui.js                                -> agent AUTH-UI
- public/community-ui.js                           -> agent COMMUNITY-UI
Stubs for the five server files and two UI files already exist so the app boots; REPLACE the whole file.
Helpers that exist: server/ratelimit.js (limit(), consume(), remaining(), ip()), server/mail.js (sendMail, verifyEmailMessage, resetPasswordMessage, mailStatus), server/signing.js (canonicalize, sha256Hex, sign, verify, publicKeyInfo, signingEnabled), server/db.js (see below).

## Conventions
- JSON errors: `{ "error": "plain sentence for a person" }` with a real status (400/401/403/404/409/429/500).
- Copy rules: plain, warm, direct; no analogies; no scary language; no dashes as punctuation.
- Never log or return secrets, password hashes, or raw tokens.
- All state-changing endpoints under /api or /auth POST/PATCH/DELETE must pass `csrfGuard` (exported by auth.js): require header `X-Requested-With: fetch` AND, when an Origin header is present, it must equal APP_URL's origin. Reject with 403 `{error:"Blocked request."}`.
- `app.set("trust proxy", 1)` is already set; use `ip(req)` from ratelimit.js for client IPs.
- Cookies: `sutros_session` (httpOnly, sameSite=lax, path=/, secure when APP_URL starts with https, maxAge 30 days). OAuth state cookie `sutros_oauth` (httpOnly, sameSite=lax, secure as above, maxAge 10 min).

## Database (server/db.js, already migrated by initDb)
Helpers: `sql(text, params) -> Promise<rows>`, `newId() -> 10-char base64url string`, `dbEnabled()`.
Tables:
```
users(id TEXT PK, email TEXT UNIQUE NOT NULL /*lowercase*/, email_verified BOOLEAN NOT NULL DEFAULT false,
      password_hash TEXT NULL /*scrypt, see below*/, name TEXT, avatar_url TEXT, about TEXT, contact TEXT,
      role TEXT NOT NULL DEFAULT 'user', created_at TIMESTAMPTZ DEFAULT now(), last_login_at TIMESTAMPTZ)
oauth_accounts(provider TEXT, provider_user_id TEXT, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      email TEXT, created_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY(provider, provider_user_id))
sessions(id TEXT PK, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL, ip TEXT, user_agent TEXT)
auth_tokens(id TEXT PK, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL /*'verify'|'reset'*/,
      token_hash TEXT UNIQUE NOT NULL /*sha256 hex of the raw token*/, expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now())
reports(... existing ..., user_id TEXT NULL, target_host TEXT, signature TEXT, key_id TEXT, signed_at TIMESTAMPTZ, contact JSONB)
bulletin_posts(id TEXT PK, report_id TEXT UNIQUE REFERENCES reports(id), user_id TEXT REFERENCES users(id),
      note TEXT, status TEXT NOT NULL DEFAULT 'open' /*open|claimed|resolved*/, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())
bulletin_offers(id TEXT PK, post_id TEXT REFERENCES bulletin_posts(id) ON DELETE CASCADE, user_id TEXT REFERENCES users(id),
      message TEXT NOT NULL, contact TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now())
```
Password hashing: Node `crypto.scrypt` with a 16-byte random salt, N=16384, r=8, p=1, 64-byte key; store as `scrypt$<saltB64>$<hashB64>`; compare with `timingSafeEqual`.
User JSON (public shape, used everywhere): `{ id, email, emailVerified, name, avatarUrl, about, contact, role, createdAt, providers: ["google","github"] }`. Never include password_hash.

## Auth (server/auth.js)  exports: authRouter, attachUser, requireAuth, requireVerified, csrfGuard, createSession(req,res,userId), destroySession(req,res), publicUser(row), findOrCreateOAuthUser({provider, providerUserId, email, emailVerified, name, avatarUrl, req, res})
- `attachUser` middleware: reads the session cookie, loads session+user if not expired, sets `req.user` (public shape or null) and `req.sessionId`. Sliding expiry: extend if under 15 days left.
- `requireAuth`: 401 `{error:"Please sign in."}`. `requireVerified`: requireAuth then 403 `{error:"Please confirm your email first.", code:"unverified"}` when !emailVerified.
- Honeypot: signup/login bodies may include `website`; if non-empty, respond 200 with the normal success shape but do nothing.
- Rate limits (ratelimit.js): signup 5/hour/IP; login 10/15min per IP+email key; forgot 3/hour per email and 10/hour per IP; verify-resend 3/hour per user.
- POST /api/auth/signup {email, password, name?, website?}: validate email, password >= 10 chars and not in a small common list. Enumeration safe: ALWAYS 200 `{ok:true, message:"Check your email to confirm your account."}`. If new: create user (email_verified=false), createSession, send verify email (token 24h). If exists: send a short "you already have an account" email; no session.
- POST /api/auth/login {email, password, website?}: 200 `{ok:true, user}`; 401 `{error:"That email and password don't match."}` (same message when the user has no password: add hint `code:"oauth-only"` only if the account exists and has providers... NO, keep generic to avoid enumeration).
- POST /api/auth/logout: destroys session, 200 `{ok:true}`.
- GET /api/me: `{user: null|User, mail: {configured:boolean}}`.
- PATCH /api/me {name?, about?, contact?} (requireAuth): 200 `{user}` (name <= 80, about <= 400, contact <= 200).
- POST /api/auth/password {current, next} (requireAuth): 200 `{ok:true}`; 400 on mismatch/weak.
- POST /api/auth/verify/resend (requireAuth): 200 `{ok:true}`.
- GET /auth/verify?token=...: mark verified, consume token, then redirect 302 to `/?verified=1` (or `/login?error=verify` when invalid/expired).
- POST /api/auth/forgot {email}: ALWAYS 200 `{ok:true, message:"If that email has an account, a reset link is on its way."}`; sends reset email (token 1h) when the user exists; if the user has no password (OAuth only) send an email saying to sign in with Google/GitHub.
- POST /api/auth/reset {token, password}: validates token (unused, unexpired), sets password, marks used, deletes ALL sessions for the user, creates a fresh session, 200 `{ok:true, user}`; 400 `{error:"That link is no longer valid. Request a new one."}`.
- Tokens: raw = 32 random bytes base64url; store sha256 hex; links: `${APP_URL}/auth/verify?token=RAW` and `${APP_URL}/reset?token=RAW`.
- createSession: id = 32 random bytes base64url; insert; set cookie. destroySession: delete row, clear cookie.
- findOrCreateOAuthUser: look up oauth_accounts(provider, providerUserId) -> user. Else if emailVerified && a user with that email exists -> link + set email_verified=true. Else if a user with that email exists but provider email unverified -> throw Error("email-unverified"). Else create user (email_verified = emailVerified). Then createSession. Returns the user.

## OAuth (server/oauth.js)  exports: oauthRouter
- GET /auth/google?next=/path : set `sutros_oauth` cookie `{state, provider:"google", next, verifier}`; redirect to https://accounts.google.com/o/oauth2/v2/auth with client_id, redirect_uri `${APP_URL}/auth/google/callback`, response_type=code, scope `openid email profile`, state, code_challenge (S256 of verifier), code_challenge_method=S256, prompt=select_account.
- GET /auth/google/callback: verify state cookie; POST https://oauth2.googleapis.com/token (code, client_id, client_secret, redirect_uri, grant_type=authorization_code, code_verifier); GET https://openidconnect.googleapis.com/v1/userinfo with the access token -> {sub, email, email_verified, name, picture}. findOrCreateOAuthUser. Redirect to `next` (must start with "/" and not "//") else "/". On any failure redirect to `/login?error=google`.
- GET /auth/github?next=... : cookie as above; redirect to https://github.com/login/oauth/authorize?client_id&redirect_uri=${APP_URL}/auth/github/callback&scope=read:user%20user:email&state.
- GET /auth/github/callback: POST https://github.com/login/oauth/access_token (Accept: application/json) -> access_token; GET https://api.github.com/user and https://api.github.com/user/emails (User-Agent required; Accept: application/vnd.github+json); pick the primary verified email (fallback first verified). findOrCreateOAuthUser({provider:"github", providerUserId:String(user.id), email, emailVerified:true-if-from-verified-list, name: user.name||user.login, avatarUrl: user.avatar_url}). Redirect as above; failure -> `/login?error=github`.
- If GOOGLE_CLIENT_ID / GITHUB_CLIENT_ID is unset, the start route responds 503 `{error:"Google sign-in isn't set up yet."}`.

## Signing, verify, badge (server/verify.js)  exports: verifyRouter, signReport(report) -> {signature, keyId, signedAt, payload}
- Canonical payload v1: `{ v:1, id, target, url, grade, score, scannedAt, findingsDigest }` where findingsDigest = sha256Hex(canonicalize(report.findings.map(f => ({id:f.id, severity:f.severity, title:f.title})))). Signature = sign(canonicalize(payload)) (base64url). The integrator calls signReport in the pipeline before saving and stores signature, key_id, signed_at on the row and inside the report JSON as `report.attestation = {v:1, keyId, signature, signedAt, payload}`.
- GET /.well-known/sutros-signing-key.json -> `{ keyId, algorithm:"Ed25519", publicKeySpkiBase64, publicKeyPem, verifyUrl:"${APP_URL}/verify/{id}" }` (Cache-Control: public, max-age=3600).
- GET /api/verify/:id -> `{ valid:boolean, keyId, payload, canonical, signature, publicKeySpkiBase64, report:{id,target,grade,score,scannedAt,gradeLabel} }`; 404 if the report does not exist; `valid:false, reason` when unsigned or tampered (recompute from the stored report JSON).
- GET /badge/:id.svg -> SVG 220x40-ish: lotus mark, "Checked by SUTROS", grade letter in the grade color, short date; Cache-Control public max-age=3600; 404 if unknown.
- GET /verify/:id serves public/index.html (the SPA renders the verify screen).

## Reports, dedup, recent (integrator, already in server/index.js)
- Running a checkup (POST /api/checkup and GET /api/checkup/stream) now requires a verified account; reports get user_id and target_host; limits: 20 checkups/day/user, and per host at most 1 fresh checkup per 10 minutes across all users (429 `{error, latestReportId}`).
- GET /api/checks?host=example.com -> `{ host, count, reports:[{id, grade, score, scannedAt, by:{name}}] }` (latest 10 for that host).
- GET /api/reports?limit=20&host= -> `{ db, reports:[{id, target, grade, score, created_at, by:{name}}] }`.
- report.contact = `{ emails:[...], pages:[...] }` (public emails and contact-like page URLs found during the crawl), present on every new report.

## Bulletin (server/bulletin.js)  exports: bulletinRouter
- GET /api/bulletin?sort=new|worst&page=1 (20/page) -> `{ posts:[{ id, note, status, createdAt, by:{id,name,avatarUrl}, offersCount, report:{ id, target, grade, score, tally, summary, topFindings:[{severity,title}] (max 3), contact } }], page, hasMore }`. `worst` orders by score asc then newest.
- GET /api/bulletin/:id -> `{ post:{...as above}, report:<full report JSON>, offers:[{ id, message, contact, createdAt, by:{id,name,avatarUrl} }], intro:string }`. intro = a ready-to-send message: greets the site by name, says the writer found it on the Sutros community bulletin (link `${APP_URL}/b/<id>`), lists the top 3 findings in plain words, says what the report recommends for the first one, offers help, links the full report `${APP_URL}/r/<reportId>`. Plain and warm; no analogies.
- POST /api/bulletin {reportId, note?} (requireVerified, csrfGuard; 10/day/user): report must exist; one post per report (409 if exists, return the existing post id); note <= 500. -> 201 `{post}`.
- PATCH /api/bulletin/:id {status} (requireAuth; poster or role=admin) -> `{post}`.
- POST /api/bulletin/:id/offers {message, contact} (requireVerified; 20/day/user): message 20..1500 chars, contact = email or http(s) URL <= 200. -> 201 `{offer}`.
- DELETE /api/bulletin/:id/offers/:offerId (offer owner, post owner, or admin) -> `{ok:true}`.
- Never include evidence contents in list views; the detail view returns the full report as stored (already redacted).

## Frontend core (public/core.js, already present)  window.Sutros
- `Sutros.api(path, {method, body})` -> fetch with `X-Requested-With: fetch`, JSON body, credentials same-origin; resolves parsed JSON; rejects with Error(message) using `error` from the body; `err.status` set.
- `Sutros.user` (current user or null), `Sutros.refreshMe()` -> Promise<user|null>, `Sutros.onUser(fn)` (called on every change).
- `Sutros.requireLogin(next)` -> if signed in returns true; else navigates to `/login?next=<encoded>` and returns false.
- Routing: `Sutros.route(pattern, handler)` where pattern is a RegExp on location.pathname; `Sutros.navigate(path)` pushes state and dispatches; `Sutros.dispatch()` runs the first matching handler (called on load and popstate). `Sutros.showScreen(id)` toggles `.screen.is-active` (same as app.js go()).
- Hooks: `Sutros.beforeCheckup(host) -> Promise<boolean>` (community-ui replaces this to show the dedup prompt; resolve true to proceed), `Sutros.onReportRendered(report)` (community-ui appends the bulletin + badge blocks into `#reportExtras`), `Sutros.toast(text)`.
- Screens are `<div class="screen" id="screen-...">` appended to `#screens-extra` by each UI module. Use existing CSS classes (.wrap, .btn, .btn-primary, .btn-ghost, .finding, .sev-chip, .eyebrow, .checkcard, .consent, .err, .tally, .helper-card, .helper-form-card, .hf-row). Add small module-specific CSS via a <style> element the module injects; keep the jade/gold tokens (var(--brand), var(--glow), var(--ink), var(--ink-soft), var(--surface), var(--border)).
- Topbar slot `#authSlot`: auth-ui renders a "Sign in" button (to /login) or the user's name/avatar with a menu (Account, My checkups, Bulletin, Sign out).
- Home slot `#recentChecks`: community-ui renders "Recent public checkups" (from GET /api/reports).

## Auth UI (public/auth-ui.js)  routes: /login, /signup, /forgot, /reset (?token=), /account, /auth-error
- Login/Signup screen with tabs, email+password form, honeypot input (name="website", visually hidden, tabindex -1, autocomplete off), "Continue with Google" -> `/auth/google?next=...`, "Continue with GitHub" -> `/auth/github?next=...`, "Forgot password" link. Shows plain errors inline. After login: `Sutros.refreshMe()` then navigate to `next` or "/".
- Unverified banner (rendered under the topbar when user && !emailVerified): "Confirm your email to run checkups and post. Resend." with a resend button.
- Account screen: profile form (name, about, contact), change password (hidden for OAuth-only users, with a note), connected providers, "My checkups" list (GET /api/reports?mine=1 -> integrator supports `mine=1` returning the signed-in user's reports), sign out.
- Handle `?verified=1` (toast "Email confirmed") and `?error=google|github|verify` (plain messages).

## Community UI (public/community-ui.js)  routes: /bulletin, /b/:id, /verify/:id
- /bulletin: list with sort toggle (Newest / Needs the most help), cards showing target, grade chip, score, top findings, poster, offers count, status; "Post a checkup" hint linking to home.
- /b/:id: report summary + link to full report; contact hints (contact page links, public emails as mailto); "Intro message" textarea prefilled from `intro` with a Copy button; offers list; "Offer to help" form (message, contact) gated by requireLogin/verified (show the sign-in prompt instead of the form when logged out); status control for the poster.
- /verify/:id: shows valid/invalid, target, grade, date, key id, and runs a client-side check with WebCrypto (`crypto.subtle.importKey("spki", base64->bytes, {name:"Ed25519"}, false, ["verify"])` then `verify`) and shows "Verified in your browser" when it matches; falls back to the server result if the browser lacks Ed25519.
- Report screen extras (`#reportExtras`): "Post this checkup to the community bulletin" (POST /api/bulletin; when it already exists, link to it) and "Add the Checked by SUTROS badge" with the embed snippet `<a href="${APP_URL}/verify/<id>"><img alt="Checked by SUTROS" src="${APP_URL}/badge/<id>.svg"></a>` and a Copy button, plus a preview <img>.
- Dedup prompt: implement `Sutros.beforeCheckup(host)`: GET /api/checks?host=; if count > 0 render a card in `#dedupSlot`: "This site has been checked N times. See the latest checkup (link, grade, date) or run a fresh one." with buttons "View latest" (navigate /r/<id>, resolve false) and "Run a fresh checkup" (resolve true); if the latest is under 10 minutes old, only offer viewing.
