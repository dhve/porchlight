// oauth.js  (STUB: the OAUTH agent replaces this file)
import express from "express";
export const oauthRouter = express.Router();
oauthRouter.get(["/auth/google", "/auth/github"], (_req, res) => res.status(503).json({ error: "Sign-in with this provider isn't set up yet." }));
