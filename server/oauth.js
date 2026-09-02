// oauth.js
// Sign in with Google or GitHub.
//
//   GET /auth/google?next=/path      start Google sign-in (OpenID Connect + PKCE)
//   GET /auth/google/callback        finish Google sign-in
//   GET /auth/github?next=/path      start GitHub sign-in
//   GET /auth/github/callback        finish GitHub sign-in
//
// The start routes drop a short-lived `sutros_oauth` cookie holding the state,
// the provider, where to send the person afterwards, and (for Google) the PKCE
// verifier. The callback routes check that cookie against the provider's
// answer, exchange the code for tokens over plain fetch, read the profile, and
// hand everything to findOrCreateOAuthUser in auth.js, which links or creates
// the account and starts the session. Any failure sends the person back to
// /login?error=<provider>. Nothing here logs tokens, codes, or secrets.

import express from "express";
import crypto from "node:crypto";
import { findOrCreateOAuthUser } from "./auth.js";
import { dbEnabled } from "./db.js";

export const oauthRouter = express.Router();

const COOKIE_NAME = "sutros_oauth";
const NO_DB_MESSAGE = "Accounts need a database, which isn't set up here yet.";
const COOKIE_MAX_AGE_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const NEXT_MAX_LEN = 512;

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const GITHUB_AUTH_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_EMAILS_URL = "https://api.github.com/user/emails";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Public origin of this deployment, without a trailing slash. */
function appUrl() {
  return String(process.env.APP_URL || "http://localhost:3000").trim().replace(/\/+$/, "");
}

function isHttps() {
  return /^https:\/\//i.test(appUrl());
}

function cookieOptions() {
  return { httpOnly: true, sameSite: "lax", secure: isHttps(), path: "/" };
}

function setStateCookie(res, payload) {
  const value = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  res.cookie(COOKIE_NAME, value, { ...cookieOptions(), maxAge: COOKIE_MAX_AGE_MS });
}

function clearStateCookie(res) {
  res.clearCookie(COOKIE_NAME, cookieOptions());
}

/** Read and decode the `sutros_oauth` cookie. Returns the parsed object or null. */
function readStateCookie(req) {
  const header = req.headers.cookie;
  if (typeof header !== "string" || !header) return null;
  let raw = null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== COOKIE_NAME) continue;
    raw = part.slice(eq + 1).trim();
    break;
  }
  if (!raw) return null;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(raw)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Only allow an in-app path as the place to go after sign-in: it has to start
 * with a single "/" (so no "//host" or "/\host" tricks), carry no control
 * characters, and stay short. Anything else falls back to "/".
 */
function safeNext(value) {
  if (typeof value !== "string") return "/";
  const next = value.trim();
  if (!next || next.length > NEXT_MAX_LEN) return "/";
  if (!next.startsWith("/")) return "/";
  if (next.startsWith("//") || next.startsWith("/\\")) return "/";
  if (/[\u0000-\u001f\u007f]/.test(next)) return "/";
  return next;
}

/** First value when a query parameter was repeated. */
function queryString(value) {
  if (Array.isArray(value)) value = value[0];
  return typeof value === "string" ? value : "";
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function pkceChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier, "utf8").digest("base64url");
}

/** Constant-time string comparison that also refuses mismatched lengths. */
function sameString(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length || ab.length === 0) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Errors we raise on purpose carry a short reason code that is safe to log. */
class OAuthError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

async function fetchJson(url, init = {}) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    throw new OAuthError("network");
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw new OAuthError(`http-${res.status}`);
  if (!data || typeof data !== "object") throw new OAuthError("bad-json");
  return data;
}

function failureRedirect(res, provider, err) {
  const reason = err && err.reason ? err.reason : (err && err.message === "email-unverified" ? "email-unverified" : "unexpected");
  if (reason === "unexpected") console.error(`[oauth] ${provider} sign-in failed:`, err && err.message ? err.message : err);
  else console.warn(`[oauth] ${provider} sign-in failed: ${reason}`);
  clearStateCookie(res);
  return res.redirect(`/login?error=${provider}`);
}

/**
 * Shared callback checks: the provider must not report an error, a code must
 * be present, the state cookie must exist, belong to this provider, and match
 * the state that came back. Returns the decoded cookie.
 */
function verifyCallback(req, provider) {
  if (queryString(req.query.error)) throw new OAuthError("provider-denied");
  const code = queryString(req.query.code);
  const state = queryString(req.query.state);
  if (!code || !state) throw new OAuthError("missing-code-or-state");
  const saved = readStateCookie(req);
  if (!saved) throw new OAuthError("missing-cookie");
  if (saved.provider !== provider) throw new OAuthError("wrong-provider");
  if (!sameString(saved.state, state)) throw new OAuthError("state-mismatch");
  return { code, saved };
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function cleanText(value, max) {
  if (typeof value !== "string") return null;
  const text = value.trim().slice(0, max);
  return text || null;
}

function cleanUrl(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().slice(0, 500);
  return /^https:\/\//i.test(text) ? text : null;
}

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

oauthRouter.get("/auth/google", (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(503).json({ error: "Google sign-in isn't set up yet." });
  // Every other account route answers 503 without a database. Do the same here
  // rather than sending the person through Google only to fail on the way back.
  if (!dbEnabled()) return res.status(503).json({ error: NO_DB_MESSAGE });

  const state = randomToken(24);
  const verifier = randomToken(32);
  const next = safeNext(queryString(req.query.next));
  setStateCookie(res, { state, provider: "google", next, verifier });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${appUrl()}/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  res.setHeader("Cache-Control", "no-store");
  res.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
});

oauthRouter.get("/auth/google/callback", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const { code, saved } = verifyCallback(req, "google");
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new OAuthError("not-configured");
    if (typeof saved.verifier !== "string" || !saved.verifier) throw new OAuthError("missing-verifier");

    const token = await fetchJson(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${appUrl()}/auth/google/callback`,
        grant_type: "authorization_code",
        code_verifier: saved.verifier,
      }),
    });
    const accessToken = typeof token.access_token === "string" ? token.access_token : "";
    if (!accessToken) throw new OAuthError("no-access-token");

    const profile = await fetchJson(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    const sub = profile.sub != null ? String(profile.sub) : "";
    const email = normalizeEmail(profile.email);
    if (!sub) throw new OAuthError("no-subject");
    if (!email) throw new OAuthError("no-email");

    await findOrCreateOAuthUser({
      provider: "google",
      providerUserId: sub,
      email,
      emailVerified: profile.email_verified === true || profile.email_verified === "true",
      name: cleanText(profile.name, 80),
      avatarUrl: cleanUrl(profile.picture),
      req,
      res,
    });

    clearStateCookie(res);
    return res.redirect(safeNext(saved.next));
  } catch (err) {
    return failureRedirect(res, "google", err);
  }
});

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

function githubHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github+json",
    "User-Agent": `Sutros (+${appUrl()})`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

oauthRouter.get("/auth/github", (req, res) => {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) return res.status(503).json({ error: "GitHub sign-in isn't set up yet." });
  if (!dbEnabled()) return res.status(503).json({ error: NO_DB_MESSAGE });

  const state = randomToken(24);
  const next = safeNext(queryString(req.query.next));
  setStateCookie(res, { state, provider: "github", next, verifier: null });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${appUrl()}/auth/github/callback`,
    scope: "read:user user:email",
    state,
  });
  res.setHeader("Cache-Control", "no-store");
  res.redirect(`${GITHUB_AUTH_URL}?${params.toString()}`);
});

oauthRouter.get("/auth/github/callback", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const { code, saved } = verifyCallback(req, "github");
    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new OAuthError("not-configured");

    const token = await fetchJson(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": `Sutros (+${appUrl()})`,
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: `${appUrl()}/auth/github/callback`,
      }),
    });
    const accessToken = typeof token.access_token === "string" ? token.access_token : "";
    if (!accessToken) throw new OAuthError("no-access-token");

    const headers = githubHeaders(accessToken);
    const user = await fetchJson(GITHUB_USER_URL, { headers });
    const id = user.id != null ? String(user.id) : "";
    if (!id) throw new OAuthError("no-subject");

    // Emails come from a separate endpoint. Pick the primary verified one, or
    // failing that the first verified one. There is no other fallback: the
    // public profile email is unproven, so a sign-in without a verified
    // address stops here instead of creating an account nobody has claimed.
    // A failed lookup (transient error or revoked scope) propagates as an
    // OAuthError and lands on /login?error=github like any other failure.
    const emails = await fetchJson(GITHUB_EMAILS_URL, { headers });
    let email = "";
    if (Array.isArray(emails)) {
      const verified = emails.filter((e) => e && e.verified === true && normalizeEmail(e.email));
      const pick = verified.find((e) => e.primary === true) || verified[0];
      if (pick) email = normalizeEmail(pick.email);
    }
    if (!email) throw new OAuthError("no-email");

    await findOrCreateOAuthUser({
      provider: "github",
      providerUserId: id,
      email,
      emailVerified: true,
      name: cleanText(user.name, 80) || cleanText(user.login, 80),
      avatarUrl: cleanUrl(user.avatar_url),
      req,
      res,
    });

    clearStateCookie(res);
    return res.redirect(safeNext(saved.next));
  } catch (err) {
    return failureRedirect(res, "github", err);
  }
});
