// ratelimit.js
// Small in-memory sliding-window rate limiter for a single-server deployment.
// Keys are usually an IP, an account id, or a target host. Buckets expire on
// their own, so memory stays bounded. Express middleware via limit().
//
// Usage:
//   app.post("/api/auth/login", limit({ name: "login", max: 10, windowMs: 15 * 60_000, key: (req) => ip(req) }), handler)

const buckets = new Map(); // `${name}:${key}` -> number[] (timestamps)

setInterval(() => {
  const now = Date.now();
  for (const [k, times] of buckets) {
    while (times.length && now - times[0] > 60 * 60_000) times.shift();
    if (!times.length) buckets.delete(k);
  }
}, 5 * 60_000).unref();

/** Client IP, honoring the first X-Forwarded-For hop when behind Caddy. */
export function ip(req) {
  const xf = req.headers["x-forwarded-for"];
  const first = typeof xf === "string" ? xf.split(",")[0].trim() : "";
  return first || req.ip || req.socket?.remoteAddress || "unknown";
}

/**
 * Consume one unit from a bucket. Returns { ok, remaining, retryAfterMs }.
 * @param {string} name   logical limiter name
 * @param {string} key    who/what is being limited
 * @param {number} max    allowed events per window
 * @param {number} windowMs
 */
export function consume(name, key, max, windowMs) {
  const id = `${name}:${key}`;
  const now = Date.now();
  const times = buckets.get(id) || [];
  while (times.length && now - times[0] > windowMs) times.shift();
  if (times.length >= max) {
    buckets.set(id, times);
    return { ok: false, remaining: 0, retryAfterMs: windowMs - (now - times[0]) };
  }
  times.push(now);
  buckets.set(id, times);
  return { ok: true, remaining: max - times.length, retryAfterMs: 0 };
}

/** Peek without consuming (e.g. to show "N checkups left today"). */
export function remaining(name, key, max, windowMs) {
  const id = `${name}:${key}`;
  const now = Date.now();
  const times = (buckets.get(id) || []).filter((t) => now - t <= windowMs);
  return Math.max(0, max - times.length);
}

/**
 * Express middleware. `key` derives the bucket key from the request; default is the IP.
 * Responds 429 with a plain message and Retry-After when exceeded.
 */
export function limit({ name, max, windowMs, key = ip, message }) {
  return (req, res, next) => {
    let k;
    try { k = key(req); } catch { k = ip(req); }
    const r = consume(name, String(k), max, windowMs);
    res.setHeader("X-RateLimit-Remaining", String(r.remaining));
    if (r.ok) return next();
    res.setHeader("Retry-After", String(Math.ceil(r.retryAfterMs / 1000)));
    return res.status(429).json({ error: message || "Too many requests. Please wait a bit and try again." });
  };
}
