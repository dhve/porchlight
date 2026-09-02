// auth.js
// Accounts and sessions for Sutros.
//  - email + password signup, login, logout
//  - email confirmation and password reset links (tokens are stored hashed)
//  - cookie sessions (sutros_session) with sliding renewal
//  - middleware: attachUser, requireAuth, requireVerified, csrfGuard
//  - findOrCreateOAuthUser for the Google and GitHub flows in oauth.js
//
// Ownership rule: an account whose email was never confirmed is unclaimed.
// The first proof that someone owns the address (a confirmation click, a
// reset link, or a verified Google/GitHub identity) takes the account over
// cleanly, and anything set up before that proof stops working.
//
// Nothing here logs or returns secrets, password hashes, or raw tokens.

import express from "express";
import crypto from "node:crypto";
import { sql, newId, dbEnabled } from "./db.js";
import { limit, ip } from "./ratelimit.js";
import { sendMail, mailStatus, verifyEmailMessage, resetPasswordMessage } from "./mail.js";

// ---- constants ----
const COOKIE = "sutros_session";
const DAY_MS = 24 * 60 * 60_000;
const SESSION_MS = 30 * DAY_MS;
const RENEW_UNDER_MS = 15 * DAY_MS;
const VERIFY_TOKEN_MS = 24 * 60 * 60_000;
const RESET_TOKEN_MS = 60 * 60_000;

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 64;
const MIN_PASSWORD = 10;
const MAX_PASSWORD = 200;
const MAX_EMAIL = 254;
const MAX_NAME = 80;

// Small list of passwords that are 10+ characters and still very common.
const COMMON_PASSWORDS = new Set([
  "password12", "password123", "password1234", "password12345", "password!", "password1!",
  "passw0rd12", "p@ssw0rd12", "p@ssword12", "1234567890", "12345678910", "123456789a", "0123456789",
  "qwertyuiop", "qwerty1234", "qwerty12345", "qwertyuiop1", "1q2w3e4r5t", "1q2w3e4r5t6y",
  "abcdefghij", "abcdefg123", "abc1234567", "iloveyou12", "iloveyou123", "administrator",
  "welcome123", "welcome1234", "letmein123", "letmein1234", "sunshine12", "sunshine123",
  "changeme123", "trustno1234", "monkey12345", "dragon12345", "football12", "football123",
  "baseball12", "baseball123", "superman12", "superman123", "princess12", "princess123",
  "computer123", "internet123", "whatever12", "whatever123", "sutros1234", "sutros12345",
]);

const GENERIC_ERROR = "Something went wrong on our side. Please try again.";
const SIGNUP_MESSAGE = "Check your email to confirm your account.";
const FORGOT_MESSAGE = "If that email has an account, a reset link is on its way.";
const BAD_LINK = "That link is no longer valid. Request a new one.";
const NO_DB = "Accounts need a database, which isn't set up here yet.";

// ---- small helpers ----
function appUrl() {
  return String(process.env.APP_URL || "http://localhost:3000").trim().replace(/\/+$/, "");
}
function appOrigin() {
  try { return new URL(appUrl()).origin; } catch { return null; }
}
function secureCookies() {
  return /^https:/i.test(appUrl());
}
function clean(v, max) {
  return String(v == null ? "" : v).trim().slice(0, max);
}
// Control characters (including newlines) and angle brackets never belong in a
// display name. Names end up in emails and on the bulletin, so they are stripped
// at intake and escaped again wherever they are placed into HTML.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
function tidyName(v) {
  return String(v == null ? "" : v).replace(CONTROL_CHARS, " ").replace(/[<>]/g, "").replace(/\s+/g, " ");
}
function safeName(v) {
  return clean(tidyName(v), MAX_NAME) || null;
}
const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}
function normEmail(v) {
  return clean(v, MAX_EMAIL + 20).toLowerCase();
}
function validEmail(email) {
  return email.length > 0 && email.length <= MAX_EMAIL && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}
/** Returns a plain message when the password is not acceptable, else null. */
function passwordProblem(password, email) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) {
    return `Please choose a password with at least ${MIN_PASSWORD} characters.`;
  }
  if (password.length > MAX_PASSWORD) return "That password is too long. Please choose one under 200 characters.";
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower) || (email && lower === email.toLowerCase())) {
    return "That password is too easy to guess. Please choose another one.";
  }
  return null;
}
function providerLabel(p) {
  return p === "google" ? "Google" : p === "github" ? "GitHub" : String(p || "");
}
function providerSentence(providers) {
  const names = (providers || []).map(providerLabel).filter(Boolean);
  if (!names.length) return "Google or GitHub";
  if (names.length === 1) return names[0];
  return names.slice(0, -1).join(", ") + " or " + names[names.length - 1];
}
/**
 * Build and send a message after the response has gone out. `make` returns the
 * message (it may do database work, such as creating a token), so the time a
 * request takes never depends on whether an email is on its way.
 */
function sendLater(make) {
  Promise.resolve()
    .then(async () => sendMail(await make()))
    .catch((err) => console.error("[auth] mail:", err && err.message ? err.message : err));
}
/** Wrap an async handler so rejections reach the router's error handler. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- cookies (parsed by hand, no cookie-parser) ----
export function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== "string") return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key || key in out) continue;
    let val = part.slice(i + 1).trim();
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    try { out[key] = decodeURIComponent(val); } catch { out[key] = val; }
  }
  return out;
}
function cookieOptions(maxAge) {
  const o = { httpOnly: true, sameSite: "lax", path: "/", secure: secureCookies() };
  if (maxAge) o.maxAge = maxAge;
  return o;
}
function setSessionCookie(res, id) {
  res.cookie(COOKIE, id, cookieOptions(SESSION_MS));
}
function clearSessionCookie(res) {
  res.clearCookie(COOKIE, cookieOptions());
}
function sessionIdFrom(req) {
  const id = parseCookies(req.headers.cookie)[COOKIE];
  return id && /^[A-Za-z0-9_-]{20,128}$/.test(id) ? id : null;
}

// ---- passwords (scrypt) ----
function scryptAsync(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_LEN, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)));
  });
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(password, salt);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}
// Used so a login attempt against a missing account costs the same time as a real one.
const DUMMY_SALT = crypto.randomBytes(16);
async function verifyPassword(password, stored) {
  const pw = typeof password === "string" ? password.slice(0, MAX_PASSWORD) : "";
  const parts = typeof stored === "string" ? stored.split("$") : [];
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    await scryptAsync(pw, DUMMY_SALT);
    return false;
  }
  let salt, expected;
  try {
    salt = Buffer.from(parts[1], "base64");
    expected = Buffer.from(parts[2], "base64");
  } catch {
    await scryptAsync(pw, DUMMY_SALT);
    return false;
  }
  const actual = await scryptAsync(pw, salt);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// ---- one-time tokens (verify, reset) ----
function hashToken(raw) {
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}
/** Create a token row and return the raw token (only ever placed in an email link). */
async function issueToken(userId, kind, ttlMs) {
  const raw = crypto.randomBytes(32).toString("base64url");
  // Housekeeping: drop this user's spent or expired tokens of the same kind.
  await sql(`DELETE FROM auth_tokens WHERE user_id = $1 AND kind = $2 AND (used_at IS NOT NULL OR expires_at < now())`, [userId, kind]);
  await sql(
    `INSERT INTO auth_tokens (id, user_id, kind, token_hash, expires_at) VALUES ($1, $2, $3, $4, $5)`,
    [newId(), userId, kind, hashToken(raw), new Date(Date.now() + ttlMs)]
  );
  return raw;
}
/** Atomically mark a token used. Resolves the user id, or null when it is unknown, spent, or expired. */
async function consumeToken(raw, kind) {
  if (typeof raw !== "string" || raw.length < 20 || raw.length > 200 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const rows = await sql(
    `UPDATE auth_tokens SET used_at = now()
      WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [hashToken(raw), kind]
  );
  return rows.length ? rows[0].user_id : null;
}
/** Spend every open token for a user; `kind` narrows it to 'verify' or 'reset'. */
async function retireTokens(userId, kind) {
  if (kind) await sql(`UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND kind = $2 AND used_at IS NULL`, [userId, kind]);
  else await sql(`UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [userId]);
}

// ---- users ----
const USER_SELECT = `
  u.id, u.email, u.email_verified, u.name, u.avatar_url, u.about, u.contact, u.role, u.created_at,
  (u.password_hash IS NOT NULL) AS has_password,
  COALESCE((SELECT array_agg(o.provider ORDER BY o.provider) FROM oauth_accounts o WHERE o.user_id = u.id), ARRAY[]::text[]) AS providers`;

async function loadUser(id) {
  const rows = await sql(`SELECT ${USER_SELECT} FROM users u WHERE u.id = $1`, [id]);
  return rows.length ? publicUser(rows[0]) : null;
}
async function userRowByEmail(email) {
  const rows = await sql(`SELECT ${USER_SELECT}, u.password_hash FROM users u WHERE u.email = $1`, [email]);
  return rows[0] || null;
}

/** Public user shape. Never includes the password hash. */
export function publicUser(row) {
  if (!row) return null;
  const out = {
    id: row.id,
    email: row.email,
    emailVerified: Boolean(row.email_verified),
    name: row.name ?? null,
    avatarUrl: row.avatar_url ?? null,
    about: row.about ?? null,
    contact: row.contact ?? null,
    role: row.role || "user",
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    providers: Array.isArray(row.providers) ? row.providers.filter(Boolean) : [],
  };
  if (row.has_password !== undefined) out.hasPassword = Boolean(row.has_password);
  else if ("password_hash" in row) out.hasPassword = Boolean(row.password_hash);
  return out;
}

/** A believable user object for honeypot replies. Nothing here is stored. */
function decoyUser(email) {
  return {
    id: newId(),
    email: normEmail(email),
    emailVerified: false,
    name: null,
    avatarUrl: null,
    about: null,
    contact: null,
    role: "user",
    createdAt: new Date().toISOString(),
    providers: [],
    hasPassword: true,
  };
}

// ---- sessions ----
export async function createSession(req, res, userId) {
  const id = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_MS);
  await sql(
    `INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES ($1, $2, $3, $4, $5)`,
    [id, userId, expires, clean(ip(req), 64) || null, clean(req.get ? req.get("user-agent") : "", 300) || null]
  );
  await sql(`UPDATE users SET last_login_at = now() WHERE id = $1`, [userId]);
  setSessionCookie(res, id);
  req.sessionId = id;
  return id;
}

export async function destroySession(req, res) {
  const id = req.sessionId || sessionIdFrom(req);
  if (id && dbEnabled()) {
    try { await sql(`DELETE FROM sessions WHERE id = $1`, [id]); } catch (err) { console.error("[auth] destroySession:", err.message); }
  }
  clearSessionCookie(res);
  req.user = null;
  req.sessionId = null;
}

/** Close every session for a user except `keepId` (pass "" to close them all). */
async function closeOtherSessions(userId, keepId) {
  await sql(`DELETE FROM sessions WHERE user_id = $1 AND id <> $2`, [userId, keepId || ""]);
}

// ---- middleware ----
export async function attachUser(req, res, next) {
  req.user = null;
  req.sessionId = null;
  const sid = sessionIdFrom(req);
  if (!sid || !dbEnabled()) return next();
  try {
    const rows = await sql(
      `SELECT s.expires_at, ${USER_SELECT}
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = $1 AND s.expires_at > now()`,
      [sid]
    );
    if (!rows.length) {
      clearSessionCookie(res);
      return next();
    }
    const row = rows[0];
    req.user = publicUser(row);
    req.sessionId = sid;
    const left = new Date(row.expires_at).getTime() - Date.now();
    if (left < RENEW_UNDER_MS) {
      await sql(`UPDATE sessions SET expires_at = $2 WHERE id = $1`, [sid, new Date(Date.now() + SESSION_MS)]);
      setSessionCookie(res, sid);
    }
  } catch (err) {
    console.error("[auth] attachUser:", err.message);
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Please sign in." });
  next();
}

export function requireVerified(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Please sign in." });
  if (!req.user.emailVerified) return res.status(403).json({ error: "Please confirm your email first.", code: "unverified" });
  next();
}

export function csrfGuard(req, res, next) {
  if (!["POST", "PATCH", "PUT", "DELETE"].includes(req.method)) return next();
  let ok = req.get("x-requested-with") === "fetch";
  const origin = req.get("origin");
  if (ok && origin) {
    try {
      const got = new URL(origin).origin;
      const expected = appOrigin();
      ok = expected ? got === expected : new URL(origin).host === req.get("host");
    } catch {
      ok = false;
    }
  }
  if (!ok) return res.status(403).json({ error: "Blocked request." });
  next();
}

function needDb(_req, res, next) {
  if (!dbEnabled()) return res.status(503).json({ error: NO_DB });
  next();
}

/**
 * Honeypot: bots fill the hidden `website` field. Answer exactly as if it
 * worked and do nothing. `reply` is the success body, or a function of
 * (req, res) that builds it (and may set the same headers a real success would).
 */
function honeypot(reply) {
  return (req, res, next) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    if (String(body.website ?? "").trim() === "") return next();
    return res.json(typeof reply === "function" ? reply(req, res) : reply);
  };
}

// ---- emails written here (the verify and reset templates live in mail.js) ----
function greeting(name) {
  const n = safeName(name);
  return { text: n ? `Hi ${n},` : "Hi,", html: n ? `Hi ${escapeHtml(n)},` : "Hi," };
}
function existingAccountMessage({ name, hasPassword, providers }) {
  const hi = greeting(name);
  const base = appUrl();
  const how = hasPassword
    ? `You can sign in here:\n${base}/login\n\nIf you forgot your password, you can choose a new one here:\n${base}/forgot`
    : `Your account signs in with ${providerSentence(providers)}. You can sign in here:\n${base}/login`;
  const howHtml = hasPassword
    ? `<p>You can sign in here:<br><a href="${base}/login">${base}/login</a></p><p>If you forgot your password, you can choose a new one here:<br><a href="${base}/forgot">${base}/forgot</a></p>`
    : `<p>Your account signs in with ${providerSentence(providers)}. You can sign in here:<br><a href="${base}/login">${base}/login</a></p>`;
  const text = `${hi.text}\n\nSomeone just tried to create a Sutros account with this email address, but you already have one.\n\n${how}\n\nIf this wasn't you, you can ignore this email. Nothing has changed on your account.\n\nSutros`;
  const html = `<p>${hi.html}</p><p>Someone just tried to create a Sutros account with this email address, but you already have one.</p>${howHtml}<p>If this wasn't you, you can ignore this email. Nothing has changed on your account.</p><p>Sutros</p>`;
  return { subject: "You already have a Sutros account", text, html };
}
function noPasswordResetMessage({ name, providers }) {
  const hi = greeting(name);
  const base = appUrl();
  const via = providerSentence(providers);
  const text = `${hi.text}\n\nYou asked to reset your Sutros password, but your account signs in with ${via} and doesn't use a password. Just sign in with ${via} here:\n${base}/login\n\nIf you didn't ask for this, you can ignore this email.\n\nSutros`;
  const html = `<p>${hi.html}</p><p>You asked to reset your Sutros password, but your account signs in with ${via} and doesn't use a password. Just sign in with ${via} here:<br><a href="${base}/login">${base}/login</a></p><p>If you didn't ask for this, you can ignore this email.</p><p>Sutros</p>`;
  return { subject: "How to sign in to Sutros", text, html };
}
// Token creation happens after the response is sent (inside sendLater), so a
// request that triggers an email takes the same time as one that does not.
function sendVerifyEmail(user) {
  sendLater(async () => {
    const raw = await issueToken(user.id, "verify", VERIFY_TOKEN_MS);
    return { to: user.email, ...verifyEmailMessage({ name: safeName(user.name), link: `${appUrl()}/auth/verify?token=${raw}` }) };
  });
}
function sendResetEmail(user) {
  sendLater(async () => {
    const raw = await issueToken(user.id, "reset", RESET_TOKEN_MS);
    return { to: user.email, ...resetPasswordMessage({ name: safeName(user.name), link: `${appUrl()}/reset?token=${raw}` }) };
  });
}

// ---- OAuth account linking (called by oauth.js) ----
async function insertOAuthLink(provider, pid, userId, mail) {
  await sql(
    `INSERT INTO oauth_accounts (provider, provider_user_id, user_id, email) VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, provider_user_id) DO NOTHING`,
    [provider, pid, userId, mail]
  );
}

/**
 * Attach a verified provider identity to an existing user row with the same email.
 * If that row's email was never confirmed, nobody has proven they own it yet, so
 * the provider identity is the first proof: whatever was set up before (a password,
 * other provider links, sessions, pending links) stops working, and the profile
 * fields written by the unproven claimant are replaced.
 */
async function linkVerifiedIdentity({ row, provider, pid, mail, displayName, avatarOk }) {
  const userId = row.id;
  if (!row.email_verified) {
    await sql(
      `UPDATE users SET password_hash = NULL, about = NULL, contact = NULL,
              name = COALESCE($2, name), avatar_url = COALESCE($3, avatar_url)
        WHERE id = $1`,
      [userId, displayName, avatarOk]
    );
    await sql(`DELETE FROM oauth_accounts WHERE user_id = $1`, [userId]);
    await closeOtherSessions(userId, "");
    await retireTokens(userId);
  }
  await insertOAuthLink(provider, pid, userId, mail);
  await sql(
    `UPDATE users SET email_verified = true, name = COALESCE(name, $2), avatar_url = COALESCE(avatar_url, $3) WHERE id = $1`,
    [userId, displayName, avatarOk]
  );
  return userId;
}

export async function findOrCreateOAuthUser({ provider, providerUserId, email, emailVerified, name, avatarUrl, req, res }) {
  if (!dbEnabled()) throw new Error("no-database");
  if (!["google", "github"].includes(provider)) throw new Error("bad-provider");
  const pid = clean(providerUserId, 200);
  if (!pid) throw new Error("bad-provider-user");
  const mail = normEmail(email);
  const hasEmail = validEmail(mail);
  const verified = Boolean(emailVerified) && hasEmail;
  const displayName = safeName(name);
  const avatar = clean(avatarUrl, 500);
  const avatarOk = /^https:\/\//i.test(avatar) ? avatar : null;

  let userId = null;
  const linked = await sql(`SELECT user_id FROM oauth_accounts WHERE provider = $1 AND provider_user_id = $2`, [provider, pid]);
  if (linked.length) {
    userId = linked[0].user_id;
    // Fill in a missing name or picture; never overwrite what the person chose.
    await sql(
      `UPDATE users SET name = COALESCE(name, $2), avatar_url = COALESCE(avatar_url, $3) WHERE id = $1`,
      [userId, displayName, avatarOk]
    );
  } else {
    if (!hasEmail) throw new Error("email-missing");
    const byEmail = async () => (await sql(`SELECT id, email_verified FROM users WHERE email = $1`, [mail]))[0] || null;
    let existing = await byEmail();
    if (!existing) {
      const id = newId();
      try {
        await sql(
          `INSERT INTO users (id, email, email_verified, name, avatar_url) VALUES ($1, $2, $3, $4, $5)`,
          [id, mail, verified, displayName, avatarOk]
        );
        await insertOAuthLink(provider, pid, id, mail);
        userId = id;
      } catch (err) {
        // Someone created this email between our lookup and insert; fall through to linking.
        if (!(err && err.code === "23505")) throw err;
        existing = await byEmail();
        if (!existing) throw err;
      }
    }
    if (existing) {
      if (!verified) throw new Error("email-unverified");
      userId = await linkVerifiedIdentity({ row: existing, provider, pid, mail, displayName, avatarOk });
    }
  }
  await createSession(req, res, userId);
  return loadUser(userId);
}

// ---- router ----
export const authRouter = express.Router();

// Everyone can ask who they are, even without a database.
authRouter.get("/api/me", (req, res) => {
  res.json({ user: req.user || null, mail: { configured: Boolean(mailStatus().configured) } });
});

// Email confirmation link (GET from the email; redirects into the app).
// Clicking it proves the address belongs to the person holding the inbox, so
// this browser is signed in and sessions opened before that proof are closed.
authRouter.get("/auth/verify", wrap(async (req, res) => {
  const fail = () => res.redirect(302, "/login?error=verify");
  if (!dbEnabled()) return fail();
  const raw = typeof req.query.token === "string" ? req.query.token : "";
  const userId = await consumeToken(raw, "verify");
  if (!userId) return fail();
  await retireTokens(userId, "verify");
  const sameUser = Boolean(req.user && req.user.id === userId);
  if (sameUser) {
    // The browser that signed up is confirming: mark verified, keep this session only.
    await sql(`UPDATE users SET email_verified = true WHERE id = $1`, [userId]);
    await closeOtherSessions(userId, req.sessionId);
    return res.redirect(302, "/?verified=1");
  }
  // Confirmed from a browser that did not sign up. The inbox owner is proven, but
  // whoever created the account is not, so everything set up before is cleared and
  // the inbox owner chooses their own password to finish.
  await sql(`UPDATE users SET email_verified = true, password_hash = NULL WHERE id = $1`, [userId]);
  await sql(`DELETE FROM oauth_accounts WHERE user_id = $1`, [userId]);
  await closeOtherSessions(userId, "");
  await retireTokens(userId, "reset");
  const resetRaw = await issueToken(userId, "reset", RESET_TOKEN_MS);
  res.redirect(302, `/reset?token=${encodeURIComponent(resetRaw)}&claimed=1`);
}));

// ---- signup ----
// Every outcome answers with the same body and a session cookie header, so a
// signup attempt says nothing about whether the address already has an account.
authRouter.post(
  "/api/auth/signup",
  needDb,
  honeypot({ ok: true, message: SIGNUP_MESSAGE }),
  limit({ name: "signup", max: 5, windowMs: 60 * 60_000, key: ip, message: "Too many signups from this connection. Please try again in an hour." }),
  wrap(async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const email = normEmail(body.email);
    const password = typeof body.password === "string" ? body.password : "";
    const name = safeName(body.name);
    if (!validEmail(email)) return res.status(400).json({ error: "Please enter a valid email address." });
    const weak = passwordProblem(password, email);
    if (weak) return res.status(400).json({ error: weak });

    // Hash first so the response takes the same time whether or not the account exists.
    const hash = await hashPassword(password);
    let existing = await userRowByEmail(email);
    if (!existing) {
      const id = newId();
      try {
        await sql(
          `INSERT INTO users (id, email, email_verified, password_hash, name) VALUES ($1, $2, false, $3, $4)`,
          [id, email, hash, name]
        );
      } catch (err) {
        if (err && err.code === "23505") existing = await userRowByEmail(email);
        else throw err;
      }
      if (!existing) {
        await createSession(req, res, id);
        sendVerifyEmail({ id, email, name });
        return res.json({ ok: true, message: SIGNUP_MESSAGE });
      }
    }
    if (!existing.email_verified) {
      // Nobody has proven this address yet, so this attempt replaces whatever was set up before.
      await sql(`UPDATE users SET password_hash = $2, name = COALESCE($3, name) WHERE id = $1`, [existing.id, hash, name]);
      await sql(`DELETE FROM oauth_accounts WHERE user_id = $1`, [existing.id]);
      await closeOtherSessions(existing.id, "");
      await retireTokens(existing.id);
      await createSession(req, res, existing.id);
      sendVerifyEmail({ id: existing.id, email, name: name || existing.name });
      return res.json({ ok: true, message: SIGNUP_MESSAGE });
    }
    // A confirmed account already exists: same body, and a decoy cookie so the headers match too.
    setSessionCookie(res, crypto.randomBytes(32).toString("base64url"));
    const info = { name: existing.name, hasPassword: Boolean(existing.has_password), providers: existing.providers };
    sendLater(() => ({ to: existing.email, ...existingAccountMessage(info) }));
    res.json({ ok: true, message: SIGNUP_MESSAGE });
  })
);

// ---- login ----
authRouter.post(
  "/api/auth/login",
  needDb,
  honeypot((req, res) => {
    // Same shape and same cookie header as a real sign-in; the cookie matches no session.
    setSessionCookie(res, crypto.randomBytes(32).toString("base64url"));
    return { ok: true, user: decoyUser(req.body && req.body.email) };
  }),
  limit({
    name: "login", max: 10, windowMs: 15 * 60_000,
    key: (req) => `${ip(req)}|${normEmail(req.body && req.body.email)}`,
    message: "Too many sign-in attempts. Please wait 15 minutes and try again.",
  }),
  wrap(async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const email = normEmail(body.email);
    const password = typeof body.password === "string" ? body.password : "";
    if (!email || !password) return res.status(400).json({ error: "Please enter your email and password." });
    const row = validEmail(email) ? await userRowByEmail(email) : null;
    const ok = await verifyPassword(password, row ? row.password_hash : null);
    if (!row || !ok) return res.status(401).json({ error: "That email and password don't match." });
    await createSession(req, res, row.id);
    res.json({ ok: true, user: await loadUser(row.id) });
  })
);

// ---- logout ----
authRouter.post("/api/auth/logout", wrap(async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
}));

// ---- profile ----
authRouter.patch("/api/me", needDb, requireAuth, wrap(async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const sets = [];
  const params = [req.user.id];
  const field = (key, column, max, label, tidy) => {
    if (body[key] === undefined) return null;
    if (body[key] !== null && typeof body[key] !== "string") return `Please enter ${label} as text.`;
    const raw = body[key] == null ? "" : body[key];
    if (raw.length > max) return `Please keep ${label} under ${max} characters.`;
    const value = (tidy ? tidy(raw) : raw).trim();
    params.push(value || null);
    sets.push(`${column} = $${params.length}`);
    return null;
  };
  const problem = field("name", "name", MAX_NAME, "your name", tidyName)
    || field("about", "about", 400, "the about text")
    || field("contact", "contact", 200, "your contact");
  if (problem) return res.status(400).json({ error: problem });
  if (sets.length) await sql(`UPDATE users SET ${sets.join(", ")} WHERE id = $1`, params);
  const user = await loadUser(req.user.id);
  req.user = user;
  res.json({ user });
}));

// ---- change password ----
// An account with no password yet (Google or GitHub sign-in, or one taken over
// through a verified provider identity) can set its first password here; there
// is no current password to check in that case.
authRouter.post("/api/auth/password", needDb, requireAuth, wrap(async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const current = typeof body.current === "string" ? body.current : "";
  const next = typeof body.next === "string" ? body.next : "";
  const rows = await sql(`SELECT password_hash FROM users WHERE id = $1`, [req.user.id]);
  if (!rows.length) return res.status(401).json({ error: "Please sign in." });
  const weak = passwordProblem(next, req.user.email);
  if (weak) return res.status(400).json({ error: weak });
  if (rows[0].password_hash) {
    if (!(await verifyPassword(current, rows[0].password_hash))) {
      return res.status(400).json({ error: "That current password doesn't match." });
    }
  }
  await sql(`UPDATE users SET password_hash = $2 WHERE id = $1`, [req.user.id, await hashPassword(next)]);
  // Sign out every other device; keep this one.
  await closeOtherSessions(req.user.id, req.sessionId);
  await retireTokens(req.user.id, "reset");
  res.json({ ok: true });
}));

// ---- resend confirmation ----
authRouter.post(
  "/api/auth/verify/resend",
  needDb,
  requireAuth,
  limit({ name: "verify-resend", max: 3, windowMs: 60 * 60_000, key: (req) => req.user.id, message: "We've sent a few already. Please check your inbox and spam folder, then try again in an hour." }),
  wrap(async (req, res) => {
    if (req.user.emailVerified) return res.json({ ok: true, message: "Your email is already confirmed." });
    sendVerifyEmail(req.user);
    res.json({ ok: true, message: "We sent a new confirmation link. Check your email." });
  })
);

// ---- forgot password ----
// Always the same 200 body. Every branch does one lookup before answering; the
// token and the email happen after the response, so timing gives nothing away.
authRouter.post(
  "/api/auth/forgot",
  needDb,
  limit({ name: "forgot-ip", max: 10, windowMs: 60 * 60_000, key: ip, message: "Too many reset requests from this connection. Please try again in an hour." }),
  limit({ name: "forgot-email", max: 3, windowMs: 60 * 60_000, key: (req) => normEmail(req.body && req.body.email), message: "We've sent a few reset links already. Please check your inbox and spam folder, then try again in an hour." }),
  wrap(async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const email = normEmail(body.email);
    if (!validEmail(email)) return res.json({ ok: true, message: FORGOT_MESSAGE });
    const row = await userRowByEmail(email);
    if (row) {
      if (row.password_hash) sendResetEmail(row);
      else {
        const info = { name: row.name, providers: row.providers };
        sendLater(() => ({ to: row.email, ...noPasswordResetMessage(info) }));
      }
    }
    res.json({ ok: true, message: FORGOT_MESSAGE });
  })
);

// ---- reset password ----
authRouter.post("/api/auth/reset", needDb, wrap(async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!token) return res.status(400).json({ error: BAD_LINK });
  const weak = passwordProblem(password, "");
  if (weak) return res.status(400).json({ error: weak });
  const userId = await consumeToken(token, "reset");
  if (!userId) return res.status(400).json({ error: BAD_LINK });
  const before = await sql(`SELECT email_verified FROM users WHERE id = $1`, [userId]);
  if (!before.length) return res.status(400).json({ error: BAD_LINK });
  // The link came from the account's inbox, so the address is confirmed too. If it
  // was never confirmed before, provider links added without that proof are dropped.
  if (!before[0].email_verified) await sql(`DELETE FROM oauth_accounts WHERE user_id = $1`, [userId]);
  await sql(`UPDATE users SET password_hash = $2, email_verified = true WHERE id = $1`, [userId, await hashPassword(password)]);
  await retireTokens(userId);
  await closeOtherSessions(userId, "");
  await createSession(req, res, userId);
  const user = await loadUser(userId);
  req.user = user;
  res.json({ ok: true, user });
}));

// Errors from any handler above: log a short line, answer with a plain message.
authRouter.use((err, _req, res, _next) => {
  console.error("[auth]", err && err.message ? err.message : err);
  if (res.headersSent) return;
  res.status(500).json({ error: GENERIC_ERROR });
});
