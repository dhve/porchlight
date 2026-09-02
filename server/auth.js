// auth.js  (STUB: the AUTH agent replaces this file; keep the exported names)
import express from "express";
export const authRouter = express.Router();
export function attachUser(req, _res, next) { req.user = null; req.sessionId = null; next(); }
export function requireAuth(req, res, next) { if (!req.user) return res.status(401).json({ error: "Please sign in." }); next(); }
export function requireVerified(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Please sign in." });
  if (!req.user.emailVerified) return res.status(403).json({ error: "Please confirm your email first.", code: "unverified" });
  next();
}
export function csrfGuard(req, res, next) {
  if (["POST", "PATCH", "PUT", "DELETE"].includes(req.method)) {
    let ok = req.get("x-requested-with") === "fetch";
    const origin = req.get("origin");
    if (ok && origin) { try { ok = new URL(origin).origin === new URL(process.env.APP_URL || "http://localhost").origin; } catch { ok = false; } }
    if (!ok) return res.status(403).json({ error: "Blocked request." });
  }
  next();
}
export async function createSession() { throw new Error("auth not implemented"); }
export async function destroySession() {}
export function publicUser(row) { return row ? { id: row.id, email: row.email, emailVerified: !!row.email_verified, name: row.name, avatarUrl: row.avatar_url, about: row.about, contact: row.contact, role: row.role, createdAt: row.created_at, providers: [] } : null; }
export async function findOrCreateOAuthUser() { throw new Error("auth not implemented"); }
authRouter.get("/api/me", (req, res) => res.json({ user: req.user, mail: { configured: false } }));
