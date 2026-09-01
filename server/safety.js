// safety.js
// Guardrails that keep Porchlight an authorized, non-destructive tool:
//  - normalize and validate the target URL
//  - block scans of private / internal / reserved addresses (SSRF protection)
//  - centralize the scan limits read from the environment
//
// Every network-facing check must go through resolveTarget() before touching
// the network. If it says no, we do not make the request.

import dns from "node:dns/promises";
import net from "node:net";

export const config = {
  maxLinks: intFromEnv("MAX_LINKS", 20),
  requestTimeoutMs: intFromEnv("REQUEST_TIMEOUT_MS", 8000),
  // A hard ceiling on total outbound requests per checkup, so a scan can never
  // turn into a flood against someone's site.
  maxRequests: 60,
};

function intFromEnv(name, fallback) {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * Turn user input into a validated https/http URL, or explain why we can't.
 * @param {string} input
 * @returns {{ok:true, url:URL, display:string}|{ok:false, error:string}}
 */
export function normalizeUrl(input) {
  if (!input || typeof input !== "string") {
    return { ok: false, error: "Please enter a website address." };
  }
  let raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "That does not look like a valid website address." };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "Only http and https websites can be checked." };
  }
  if (!url.hostname || !url.hostname.includes(".")) {
    return { ok: false, error: "Please include a full domain, like example.com." };
  }
  // Only default ports, so we never poke at odd internal services.
  if (url.port && url.port !== "80" && url.port !== "443") {
    return { ok: false, error: "Only standard web ports (80 and 443) are supported." };
  }

  return { ok: true, url, display: url.hostname.replace(/^www\./, "") };
}

/**
 * Resolve the hostname and confirm every address it points to is public.
 * Prevents the scanner from being aimed at localhost, the local network, or
 * cloud metadata endpoints.
 * @param {URL} url
 * @returns {Promise<{ok:true, addresses:string[]}|{ok:false, error:string}>}
 */
export async function resolveTarget(url) {
  const host = url.hostname;

  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) {
    return { ok: false, error: "Local and internal hostnames can't be checked." };
  }

  // If the host is already a literal IP, check it directly.
  if (net.isIP(host)) {
    return isPrivateIp(host)
      ? { ok: false, error: "Private or reserved IP addresses can't be checked." }
      : { ok: true, addresses: [host] };
  }

  let records;
  try {
    records = await dns.lookup(host, { all: true });
  } catch {
    return { ok: false, error: "We couldn't find that website. Check the address and try again." };
  }
  if (!records.length) {
    return { ok: false, error: "We couldn't find that website. Check the address and try again." };
  }
  for (const r of records) {
    if (isPrivateIp(r.address)) {
      return { ok: false, error: "That address resolves to a private network and can't be checked." };
    }
  }
  return { ok: true, addresses: records.map((r) => r.address) };
}

/** True for loopback, private, link-local, and reserved ranges (v4 and v6). */
export function isPrivateIp(ip) {
  const type = net.isIP(ip);
  if (type === 4) return isPrivateV4(ip);
  if (type === 6) return isPrivateV6(ip);
  return true; // unknown format -> treat as unsafe
}

function isPrivateV4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateV6(ip) {
  const v = ip.toLowerCase();
  if (v === "::1" || v === "::") return true;
  if (v.startsWith("fe80")) return true; // link-local
  if (v.startsWith("fc") || v.startsWith("fd")) return true; // unique local
  // IPv4-mapped (::ffff:a.b.c.d) -> check the embedded v4
  const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  return false;
}
