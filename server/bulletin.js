// bulletin.js  (STUB: the BULLETIN agent replaces this file)
import express from "express";
export const bulletinRouter = express.Router();
bulletinRouter.get("/api/bulletin", (_req, res) => res.json({ posts: [], page: 1, hasMore: false }));
