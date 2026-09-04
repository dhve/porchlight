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

## Amendments adopted after the adversarial design pass (2026-09-02)
- Signup ALWAYS answers the same 200 body and a session cookie header. New account: real session + verify email. Existing unverified account: the new password and name replace the old ones, sessions and provider links are removed, tokens retired, a real session is created and the link resent. Existing verified account: a decoy cookie + the "you already have an account" email.
- GET /auth/verify from the same session that signed up marks verified and keeps only that session. From any other browser it marks verified, clears password_hash, provider links, and sessions, then redirects to /reset?token=<new reset token>&claimed=1 so the inbox owner chooses their own password (closes account pre-hijack). The reset screen shows "Your email is confirmed. Choose a password to finish."
- Only the account that ran a checkup (or an admin) may post it to the bulletin (403 otherwise). Reports with no owner may be posted by any verified user.
- Site owners can opt out: DNS TXT `_sutros.<host>` containing `optout`, or a robots.txt group `User-agent: SutrosBot` with `Disallow: /`. The checkup gate answers 403 "This site's owner has asked not to be checked by Sutros."
- GET /api/checkup/stream rejects requests that are not the site's own EventSource (Sec-Fetch-Mode: navigate, or no `text/event-stream` in Accept).
- Express trusts only loopback and 172.16.0.0/12 (the Docker bridge where Caddy lives); `ip()` uses req.ip. Port 3300 is reachable only from that subnet.
- Mail never prints message bodies (links) in production logs.
- Report copy says "this site" / "the site", since the reader is often not the owner.

# Round 3 (2026-09-04): accuracy, visible proof, feedback loop, anonymous use

Why: a checkup of java.com reported "Seven links lead nowhere" and "One image is broken" while every one of those
addresses works. The site had started answering 429 Too Many Requests to our checker partway through, and the links
check counted every status of 400 or higher as broken. Round 3 makes findings verifiable and honest, shows the page
where each problem was found, lets readers say when we got it wrong, and lets people use the tool without an account.

## Ownership (round 3). Edit ONLY the files you own. Do not start the server; test your module with small node scripts.
- agent LINKS:    server/checks/links.js, server/lib/http.js, server/retest.js (new), server/explain.js, server/checks/flows.js
- agent BROWSER:  server/checks/browser.js, server/proof.js (new)
- agent FEEDBACK: server/feedback.js (new), public/feedback-ui.js (new), public/feedback.css (new)
- agent UI:       public/app.js, public/styles.css, public/index.html, public/auth-ui.js (login copy only)
- agent PAGES:    server/checks/{disclosure,forms,security,reflection,modernization,exposedFiles,cookies,libraries}.js
- INTEGRATOR:     server/pipeline.js, server/index.js, public/core.js, server/db.js, deploy. Already wiring the routers and
                  pipeline calls named below, so export exactly these names.

## Shared evidence shape (every check, every finding that has `evidence`)
```
evidence: {
  lines: string[],            // as today: short human-readable observations, status first when there is one
  note: string,               // as today
  why, confirm: string,       // as today (explain.js fills them when missing)
  method: string,             // NEW, 1 to 2 plain sentences: exactly how we tested this (what we requested, what we compared)
  pages: string[],            // NEW, absolute URLs of the site pages where the problem was found (1 to 6, most relevant first)
  items: [{                   // NEW, the concrete things we tested, so the UI can link them and re-test them live
    url: string,              //   absolute URL
    status: number,           //   HTTP status we got, 0 when the request never completed
    statusText: string,       //   "Not Found", "Too Many Requests", "did not load" ...
    page?: string,            //   absolute URL of the page that referenced it
    text?: string,            //   link text / alt text, trimmed, max 60 chars
    kind?: "link"|"image"|"resource"|"file"|"page"
  }],
  shots: [{ key, page, caption, highlighted }]  // set by proof.js only; never by checks
}
```
Rules: never change a finding's id, severity, category, or title format. `lines` must stay the human summary. Use
"this site" / "the site", not "your site", in any new copy. No analogies. No dashes as punctuation. Paths in lines are
fine (`/en/download/`), but `items[].url` and `pages[]` are always absolute.

## Status classification (LINKS and BROWSER must agree)
- BROKEN (report it):  404, 410, 500, 502, 504, and connection errors that are NOT timeouts (DNS failure, refused, reset).
- BLOCKED (never report as broken; the site refused OUR checker):  401, 403, 405, 406, 429, 503, and any 4xx/5xx that
  turns into 2xx/3xx when retried with standard browser headers. 405/501 on HEAD simply means "use GET".
- INCONCLUSIVE (never report): timeout, abort, request budget reached.
Retry rule: on a BLOCKED status wait (Retry-After seconds, max 5, else 1.5 s) and GET once more with browser-like headers
(`browserLike: true`). If the retry is 2xx/3xx the address WORKS. If the retry is still BLOCKED, it is "not testable".
Throttle rule: after 2 responses of 429 from the same host, stop testing further addresses in that check, mark them
untested, and set `ctx.facts.throttled = true` (INTEGRATOR reads it for `report.engine.throttled`).

## LINKS (server/checks/links.js, server/lib/http.js, server/retest.js, server/explain.js, server/checks/flows.js)
http.js: `request(url, { method, headers, browserLike })`. `browserLike: true` sends a current Chrome desktop User-Agent,
`Accept-Language: en-US,en;q=0.9`, and a normal browser Accept. Returned object gains `discard()` (cancels the body
stream) and `retryAfterMs` (parsed from Retry-After, null when absent). Keep the request budget and timeout.
links.js: gather `<a href>` and `<img src|data-src>` from EVERY crawled page in `facts.pages` (each has `url` and `$`),
same-origin links only, remembering the first page that referenced each URL and its trimmed link text or alt text.
Sample as today (config.maxLinks, homepage first). Pause 250 ms between requests. Classify per the table above.
Evidence for `broken-links` / `broken-images`: `lines` like `404 Not Found  /en/download/  (link "Download" on /)`,
`items` (kind link/image, page, text), `pages` (distinct referencing pages, max 6), `method`, `note` like
"3 broken of 18 links tested. 4 could not be tested because the site limited our checker." Titles count ONLY confirmed
broken. When nothing is broken and at least one address worked, push the pass "The N links and M images we tested all
work." plus ", K could not be tested because the site limited our checker" when K > 0. No finding at all for
blocked-only results.
flows.js: add `items` ({url,status,statusText,kind:"page"}), `pages` ([homepage]), `method` to its findings; apply the
BLOCKED rule there too (a 403/429/503 on a flow link is not a broken flow).
explain.js: update the `broken-links`, `broken-images`, `failed-resources`, `flow-*` entries to mention the retry with
standard browser headers, and add a top-level `PROOF_PROMISE` export (a short paragraph: every finding comes from a
direct scripted test, the AI only writes the wording and cannot add, remove, or change a finding, each proof shows the
request, the response, and where on the site it was found).
retest.js: `export const retestRouter` (express.Router()).
  POST /api/reports/:id/retest  body { findingId }  ->  200 { findingId, checkedAt, items: [{ url, previous, status,
  statusText, ok, changed }] }. Loads the report with `getReport` (db.js), finds the finding, takes up to 8 `items` that
  have a url, requires each URL's host to equal the report host or end with "." + host, passes each through
  `resolveTarget` (safety.js; skip with status 0 "not allowed" when it fails), GETs with `browserLike: true`, 8 s timeout,
  200 ms apart, `discard()`s bodies. `ok` = status 2xx/3xx. `changed` = ok differs from (previous < 400 && previous > 0).
  Limits: `consume("retest-ip", ip(req), 20, 3600000)` and `consume("retest-report", id, 6, 600000)`, 429 with a
  plain sentence. 400 for a bad id/finding, 404 for a missing report, 422 when the finding has nothing to re-test.

## BROWSER (server/checks/browser.js, server/proof.js)
browser.js: after the homepage load, every failed sub-resource with a BLOCKED status is fetched again through
`context.request.get(url)` from a SECOND context that uses a standard Chrome User-Agent. If that succeeds the resource is
dropped from `failed-resources` (count it in `blockedForBots`). A 429 for the main document or for resources means the
site is limiting us: set `ctx.facts.throttled = true`, do not report those, and if the main document itself was refused
return `{ findings: [], passes: [], skipped: true, reason: "The site limited our checker" }`. If `ctx.facts.throttled` is
already true when the check starts, wait 3 s before navigating. Add `items` (kind resource, status, statusText, page =
homepage), `pages` ([homepage]), `method` to `failed-resources`, `console-errors`, `slow-load`, `broken-images-render`.
proof.js exports:
  `ensureProofSchema()` creates `report_shots(report_id TEXT, key TEXT, page_url TEXT, mime TEXT, bytes BYTEA,
   width INT, height INT, created_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (report_id, key))` via `sql` from db.js.
  `captureProof({ facts, findings, onEvent })` -> `{ shots: [{ key, page, caption, highlighted, mime, bytes, width,
   height }], skipped: string|null }`. Picks up to 6 (page, finding) targets: walk findings in order (urgent, serious,
   watch, then minor), each finding's `evidence.pages` in order, one shot per finding, one shot per distinct page unless a
   finding needs its own highlight. One Chromium instance for all shots, standard Chrome User-Agent, viewport 1100x760,
   deviceScaleFactor 1, `goto` with waitUntil "domcontentloaded" + 800 ms settle, 12 s timeout per page, 25 s total
   budget, JPEG quality 58, max 350 KB per shot (drop it otherwise). For findings with `items` of kind link or image,
   outline every matching `a[href]` / `img` (resolved href equals an item url) with `3px solid #DC2626` plus a red
   label "broken link" / "broken image", and scroll the first into view before shooting. Caption examples: "Broken links
   outlined in red", "The page as a visitor sees it". Sets `finding.evidence.shots = [{ key, page, caption,
   highlighted }]` on the findings it shot. Keys are "s1".."s6". Emits `onEvent("log", { mark: "📸", text })` once.
   Never throws; returns `skipped` with a reason when Playwright is missing or nothing has pages.
  `saveShots(reportId, shots)` inserts rows (ignores duplicates). `sweepOldShots(days = 60)` deletes shots whose report
   is older than that many days; returns the count.
  `export const proofRouter` : GET /api/reports/:id/shots/:key -> image bytes, `Cache-Control: public, max-age=31536000,
   immutable`, 404 when missing; id and key validated with the same regexes as index.js (`^[A-Za-z0-9_-]{6,20}$`, `^s[1-9]$`).

## FEEDBACK (server/feedback.js, public/feedback-ui.js, public/feedback.css)
Table `finding_feedback(id TEXT PK, report_id TEXT NOT NULL, target_host TEXT NOT NULL, finding_id TEXT NOT NULL,
user_id TEXT, voter_key TEXT NOT NULL, verdict TEXT NOT NULL CHECK (verdict IN ('right','wrong')), note TEXT,
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (report_id, finding_id, voter_key))` with indexes on
(target_host, finding_id) and (created_at). Created by `ensureFeedbackSchema()`.
voter_key: the user id when signed in, else "anon:" + sha256Hex(SESSION_SECRET + "|" + ip(req) + "|" + user agent).slice(0, 32).
Exports: `feedbackRouter`, `ensureFeedbackSchema()`, `disputesForHost(host, { sinceDays = 90 } = {})` ->
`Map<findingId, { wrong, right, notes: [{ text, when }] }>` aggregated over every report whose target_host matches
(notes: 3 most recent "wrong" notes).
Routes (all under csrfGuard already):
  GET  /api/reports/:id/feedback -> { findings: { [findingId]: { right, wrong, notes: [{ text, when, by }] } },
       mine: { [findingId]: "right"|"wrong" } }. Notes are the 5 most recent with text; `by` is the voter's first name
       when signed in, else null. Escape nothing server-side; the client escapes.
  POST /api/reports/:id/feedback  body { findingId, verdict, note?, website? } -> { findingId, right, wrong, mine, notes }.
       findingId must be a finding id in the saved report or "_report". note trimmed, max 400 chars, stripped of control
       characters. Upsert on (report_id, finding_id, voter_key) so a person can change their mind. Honeypot: a non-empty
       `website` answers 200 with the current counts and stores nothing. `consume("feedback", voterKey, 40, 3600000)` -> 429.
  GET  /api/feedback/summary (req.user.role === "admin" only, else 403) -> { since, findings: [{ findingId, wrong, right,
       hosts, latestNotes: [{ host, text, when }] }] } sorted by wrong desc, 90 days.
feedback-ui.js (IIFE, loaded after community-ui.js): wraps the hook without replacing it:
  `const prev = S.onReportRendered; S.onReportRendered = function (r) { prev(r); mount(r); };`
  mount(r): if `!r.id` leave slots empty (sample report). Else GET feedback, then fill every `.f-slot[data-finding]` in
  #findingsRoot and `#reportFeedbackSlot`. Widget copy: "Was this accurate?" [Yes] [No]. On No, show a textarea
  "What did you see? (optional)" max 400 + "Send". After a vote: "Thanks. N people said this is right, M said it is
  wrong." Show existing notes (max 3) as "A visitor wrote: ..." or "<name> wrote: ..." with time ago. Report-level widget
  copy: "Was this checkup accurate overall?". Hidden honeypot input named `website`. Never require sign in.
  Use `S.api` and `S.toast`. Everything the client renders is escaped.
feedback.css: class prefix `fb-`; tokens from styles.css (--ink, --ink-soft, --ink-faint, --border, --surface,
--surface-2, --brand, --good, --serious, --radius-sm, --font). Compact, quiet, one line when idle.

## UI (public/app.js, public/styles.css, public/index.html, public/auth-ui.js login copy)
index.html: add `<link rel="stylesheet" href="/feedback.css">` after styles.css and `<script src="/feedback-ui.js"></script>`
after community-ui.js. Add a reassure chip "No account needed". Change nothing else structurally.
app.js:
  1. Above the findings (only when there is at least one finding), a `.proof-promise` block with the text from the
     report (`r.proofPromise`, INTEGRATOR sets it from explain.js PROOF_PROMISE) or a built-in fallback of the same text.
  2. Every finding card and every minor-note item ends with `<div class="f-slot" data-finding="<id>"></div>`. After all
     findings, `<div id="reportFeedbackSlot"></div>` inside #findingsRoot.
  3. Proof panel order: why; NEW `.proof-method` ("How we tested this." + ev.method) when present; "What we observed"
     lines with URLs and site paths turned into links (absolute http(s) URLs, and tokens starting with "/" resolved
     against the report's origin), target _blank rel noopener; NEW "Found on" list from ev.pages (show path, full URL on
     hover); NEW screenshots from ev.shots when `r.id` (figure with lazy image `/api/reports/<id>/shots/<key>`, the page
     link, and the caption; max 3 shown); NEW "Check this again right now" button when `r.id` and ev.items has urls,
     which POSTs /api/reports/<id>/retest and renders one line per item like "Right now: 404 Not Found for /en/download/
     (same as when we checked)" or "(this one works now)"; then confirm and note as today.
  4. `f.disputed` (set by INTEGRATOR: `{ wrong, right, notes }`) renders a `.dispute-chip` next to the severity chip:
     "Visitors disputed this on earlier checkups" and, in the proof panel, a "What visitors said" list (max 3 notes).
  5. `r.engine.throttled` renders one quiet line under the summary: "The site limited our checker partway through, so
     some checks were shortened."
  6. Keep all copy rules. Style everything in styles.css (no inline styles beyond what exists).
auth-ui.js: on the sign-in screen add one line under the heading: "An account is optional. It keeps your checkups
together, lets you post to the bulletin, and helps keep out spam." Do not change behavior.

## PAGES (server/checks/{disclosure,forms,security,reflection,modernization,exposedFiles,cookies,libraries}.js)
Add `pages`, `items` (where there is a concrete URL that was requested: exposed files, source maps, directory listings,
verbose-error pages, mixed-content resources, vulnerable library script URLs), and `method` to every finding in those
files. Do not change ids, severities, titles, lines, or notes. Apply the BLOCKED rule wherever a status is interpreted
(a 403/429/503 is never "exposed", "listing", or "error page"). `facts.pages[i].url` is the absolute page URL;
`facts.finalUrl.href` is the homepage.

## INTEGRATOR wiring (already being done; for reference)
- pipeline.js: after explain(), `disputesForHost(host)` marks findings with wrong >= 2 and wrong > right as
  `f.disputed`; `captureProof` runs alongside `writeReport`, shots are re-attached to the written findings by id, and
  `saveShots(report.id, shots)` runs after `saveReport`. `report.engine.throttled = Boolean(ctx.facts.throttled)`.
  `report.proofPromise = PROOF_PROMISE`.
- index.js: mounts retestRouter, proofRouter, feedbackRouter; calls ensureProofSchema/ensureFeedbackSchema after initDb;
  sweeps old shots daily. Anonymous checkups are allowed (REQUIRE_ACCOUNT=0): 30 per hour per IP.

# Round 3b (2026-09-04): the browsing agent and hosted browsers

Vedh asked for the agent to have "FULL browser access": its own real browser, hosted if we want, that explores a site
the way a visitor would and reports what it runs into. Integrator has already provided:
- `server/lib/browserConnect.js`: `openBrowser({ purpose })` -> `{ browser, mode, close(), session? }`. Uses
  BROWSER_WS_ENDPOINT (connectOverCDP, or chromium.connect when BROWSER_CONNECT=playwright), else Browserbase
  (BROWSERBASE_API_KEY + BROWSERBASE_PROJECT_ID, one session per call, `session.replayUrl`), else local Chromium.
  `browserMode()` returns "remote" | "browserbase" | "local". Throws with code NO_PLAYWRIGHT when Playwright is missing.
- `server/llm.js`: `chatTools({ system, messages, tools, maxTokens, toolChoice })` -> `{ message, finishReason, usage }`
  (OpenAI function calling; messages may include image_url parts with data: JPEG URLs).
- `server/scoring.js`: findings with `source: "agent"` (or id starting "agent-") count in the tally but never move the grade.

## Ownership (round 3b)
- agent AGENT: server/checks/agentBrowse.js (new). Nothing else.
- agent UI2:   public/app.js, public/styles.css (additions only), public/index.html (run-screen copy only).
- agent BROWSER2: server/checks/browser.js, server/proof.js (switch both from chromium.launch to openBrowser(); keep behavior).
- INTEGRATOR: pipeline.js (ctx.onEvent, STEP4 gets "agent" last, report.agent, saveShots for agent shots),
  orchestrator.js (catalog entry `agent`), deploy.

## AGENT (server/checks/agentBrowse.js)
`export async function runAgentBrowse(ctx)` -> `{ findings, passes, skipped?: boolean, reason?: string,
agent?: { ran, mode, steps, visited: string[], summary: string, replayUrl: string|null, shots: [...] } }`.
ctx has: `url` (URL), `client`, `facts` (finalUrl, pages[{url,$,html,status}], cms, technologies, throttled), and
`onEvent(type, data)` (INTEGRATOR adds it). Runs only when `llmEnabled()` (../llm.js), AGENT_BROWSE is not "0", and
`openBrowser` succeeds; otherwise `{ findings: [], passes: [], skipped: true, reason }`. Never throws.
Budget: AGENT_STEPS (default 12) model turns, AGENT_BUDGET_MS (default 90000) wall clock, 10 s per browser action,
max 6 notes. Browser: one context, phone viewport 390x844, deviceScaleFactor 1, standard mobile Chrome User-Agent,
`context.route` that aborts requests whose URL is off-origin AND is a document navigation (third-party scripts/images
are fine), downloads refused (`acceptDownloads: false`), dialogs auto-dismissed.
Observation given to the model after every action: `{ url, title, status, text (innerText trimmed, max 3500 chars),
controls: [{ n, kind: "link"|"button", text, href? }] (first 40 visible), warnings: [...] }` as JSON text PLUS one JPEG
screenshot of the viewport (quality 50) as an image part. The system prompt: the agent is a careful visitor exploring
this site read-only for someone who is not technical; it looks for what a visitor would run into: pages that fail or
are empty, placeholder or "coming soon" text, error messages on the page, navigation that goes nowhere, layout that is
cut off, overlapping, or unreadable on a phone, popups or banners that cannot be closed, notices with old dates,
contact details that are missing or clearly wrong, links to social pages that are gone, and anything else a visitor
would find frustrating. It must be fair: only note things it actually saw, quote the text it saw, and prefer fewer,
better notes. Copy rules as always ("this site", plain, warm, no analogies, no dashes, no exclamation marks).
Tools (function calling): `open({url})` same origin or subdomain only; `click({n})` a control from the last
observation; `back()`; `scroll({direction:"down"|"up"})`; `note({title, what, where, severity:"watch"|"minor",
category:"quality"|"modernization", why, fix})`; `finish({summary})`.
Safety: never type, fill, or submit; refuse `click` on controls whose text matches
/\b(buy|pay|checkout|order|purchase|donate|subscribe|sign ?up|register|log ?in|sign ?in|delete|remove|cancel|unsubscribe|send|submit|apply|book|reserve|add to cart|confirm|accept|agree|download)\b/i
and tell the model why; refuse mailto:, tel:, javascript:, and file downloads; stop early on 429 or when
`ctx.facts.throttled` becomes true (set it when you see 429). Visits are logged through
`ctx.onEvent("log", { mark: "🧭", text: "Browsing agent opened /contact" })` and a closing line with the step count.
Findings from notes: `{ id: "agent-" + slug(title) (unique within the run), source: "agent", severity (watch|minor
only), category, title (max 70 chars), meaning: what, fix: [fix], who: "The owner or their web person.",
evidence: { lines: [where, quoted text seen], pages: [where], method: "Our browsing agent opened this page in a real
browser on a phone-sized screen and read it the way a visitor would. It never typed or submitted anything.",
note: "Seen by the browsing agent.", shots: [{ key, page, caption: "What the browsing agent saw", highlighted: 0 }] } }`.
Screenshots at note time are returned in `agent.shots` as `[{ key: "s7"|"s8"|"s9", page, caption, highlighted: 0,
mime: "image/jpeg", bytes: Buffer, width, height }]` (first 3 notes only, JPEG quality 58, max 350 KB); the finding's
`evidence.shots` carries the same entries WITHOUT bytes. Pass when the run ends with no notes: "Our browsing agent
tried N pages the way a visitor would and found nothing in the way." `agent.summary` is the model's finish summary
(max 400 chars) or a template.
Test for real: OPENAI_API_KEY and DATABASE_URL are in /Users/admin/porchlight/.env (load them with the same loadEnv
logic or `export $(grep -v '^#' .env | xargs)` in a shell); run the check against https://example.com and one small
real site through a throwaway node script that fakes ctx (facts.finalUrl, facts.pages from a fetch + cheerio load,
onEvent that prints). Print the findings and the number of shots and their sizes. Do not start the Sutros server.

## UI2 (public/app.js, public/styles.css additions, public/index.html run-screen copy)
- Findings with `source === "agent"` show a small `.agent-chip` ("Browsing agent") beside the severity chip.
- When `r.agent && r.agent.ran`, render a `.agent-card` under the scorecard summary (before the findings list):
  eyebrow "Our browsing agent", the summary text, "Pages it opened:" as a compact list of paths (max 8), and when
  `r.agent.replayUrl` a link "Watch the session". When `r.agent` exists but `ran` is false, nothing.
- Run screen: the five step labels stay; add one quiet line under the log, "The browsing agent's visits show up here
  as it goes", only while the run is live.
- Engine badge title includes `agent: <steps> steps` when present.

## BROWSER2 (server/checks/browser.js, server/proof.js)
Replace `chromium.launch({ headless: true })` with `const { browser, mode, close } = await openBrowser({ purpose })`
(import from "../lib/browserConnect.js" / "./lib/browserConnect.js"); always call `close()` in finally; keep every
behavior from round 3. When mode is "remote" or "browserbase", `browser.contexts()` may already hold a default context;
still create your own `newContext` with the same options as before. browser.js's skipped reason when NO_PLAYWRIGHT
stays "Playwright not installed (run: npm run enable-browser)"; other connect failures use "Browser unavailable: <msg>".
Record `mode` in the returned object as `browserMode` so the integrator can put it in report.engine.browser.mode.
