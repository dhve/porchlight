// recon.js
// Step 1: look around, then walk a few rooms. Fetch the homepage, fingerprint
// the stack, and crawl a bounded set of internal pages so later checks have a
// real surface to work with (forms, scripts, cookies, extra pages).
//
// Everything gathered here is shared on `facts` so the deeper checks do not
// re-download anything. Deterministic. No model involved.

import * as cheerio from "cheerio";
import { config } from "../safety.js";

const LATEST_MAJOR = { wordpress: 6, joomla: 5, drupal: 10 };

export async function runRecon(ctx) {
  const { client, url } = ctx;
  const findings = [];
  const passes = [];

  let res;
  try {
    res = await client.get(url.href);
  } catch (err) {
    return {
      facts: { reachable: false },
      findings: [
        {
          id: "site-unreachable",
          category: "availability",
          severity: "urgent",
          title: "Your website didn't respond",
          meaning:
            "We couldn't load your homepage. Visitors may be seeing the same thing right now, which means the site is effectively down.",
          fix: [
            "Open your website in a browser to confirm what visitors see.",
            "Check with your hosting provider that the site is online.",
          ],
          who: "Your hosting provider or web person.",
          evidence: { lines: [`GET ${url.href}`, `error: ${String(err.message).slice(0, 120)}`], note: "No response within the timeout." },
        },
      ],
      passes,
    };
  }

  const html = await res.text().catch(() => "");
  const $ = cheerio.load(html || "");
  const finalUrl = new URL(res.finalUrl || url.href);

  const facts = {
    reachable: true,
    statusCode: res.status,
    finalUrl,
    baseOrigin: finalUrl.origin,
    isHttps: finalUrl.protocol === "https:",
    redirectedToHttps: url.protocol === "http:" && finalUrl.protocol === "https:",
    responseMs: res.ms,
    server: res.headers.get("server") || null,
    poweredBy: res.headers.get("x-powered-by") || null,
    title: ($("title").first().text() || "").trim().slice(0, 120),
    generator: ($('meta[name="generator"]').attr("content") || "").trim() || null,
    headers: res.headers,
    html,
    $,
    cms: null,
    technologies: [],
    plugins: [],
    // filled by the crawl:
    pages: [{ url: finalUrl.href, status: res.status, html, $, headers: res.headers, contentType: res.contentType }],
    scripts: [],
    forms: [],
    setCookies: [],
    robots: null,
    sitemapUrls: [],
    contact: { emails: [], pages: [] },
  };

  detectStack(facts, $, html);
  collectFrom(facts, $, finalUrl, res.headers);

  // ---- robots.txt + sitemap.xml (discovery + disclosure source) ----
  await fetchRobots(ctx, facts);

  // ---- crawl a few same-origin pages ----
  await crawl(ctx, facts);

  // ---- findings derived from recon itself ----
  if (url.protocol === "http:" && finalUrl.protocol === "http:") {
    findings.push({
      id: "no-https",
      category: "tls",
      severity: "serious",
      title: "Your website doesn't use a secure connection",
      meaning:
        "Your site loads over an unprotected connection, so browsers show a 'Not secure' warning and anything customers type can be read in transit.",
      fix: [
        "Ask your host to turn on a free SSL certificate (most offer Let's Encrypt in one click).",
        "Once it's on, make sure the site redirects visitors from http to https.",
      ],
      who: "Your hosting provider or web person.",
      evidence: { lines: [`Homepage served over http://, no https redirect`], note: "Checked the final URL after redirects." },
    });
  } else if (facts.isHttps) {
    passes.push("Your site loads over a secure (https) connection.");
  }

  if (facts.cms && facts.cms.version) {
    const major = parseInt(String(facts.cms.version).split(".")[0], 10);
    const latest = LATEST_MAJOR[facts.cms.name];
    if (latest && Number.isFinite(major) && major < latest) {
      findings.push({
        id: "outdated-cms",
        category: "outdated",
        severity: "serious",
        title: `Your website software looks out of date`,
        meaning: `Your site appears to run ${cap(facts.cms.name)} ${facts.cms.version}, an older version. Old software has publicly known security holes that attackers scan for automatically, and updating is usually quick and free.`,
        fix: [
          "Back up your site first.",
          `Update ${cap(facts.cms.name)} and all add-ons to their latest versions.`,
          "Turn on automatic updates so it doesn't drift out of date again.",
        ],
        who: "You (from the dashboard) or your web person.",
        evidence: {
          lines: [
            `Detected: ${cap(facts.cms.name)} ${facts.cms.version}`,
            facts.generator ? `generator tag: ${facts.generator}` : `inferred from page source`,
            `Current major version is around ${latest}.x`,
          ],
          note: "Version read from the page.",
        },
      });
    } else {
      passes.push(`Your ${cap(facts.cms.name)} install looks current.`);
    }
  }

  return { facts, findings, passes };
}

function collectFrom(facts, $, pageUrl, headers) {
  const origin = facts.baseOrigin;
  // scripts (for the vulnerable-library and SRI checks)
  $("script[src]").each((_, el) => {
    const src = $(el).attr("src") || "";
    let abs;
    try { abs = new URL(src, pageUrl).href; } catch { return; }
    if (!facts.scripts.some((s) => s.src === abs)) {
      facts.scripts.push({ src: abs, integrity: $(el).attr("integrity") || null, crossorigin: $(el).attr("crossorigin") || null, external: safeOrigin(abs) !== origin });
    }
  });
  // forms (for the form-security check)
  $("form").each((_, el) => {
    const $f = $(el);
    const action = $f.attr("action") || "";
    let actionAbs = pageUrl;
    try { actionAbs = new URL(action || pageUrl, pageUrl).href; } catch {}
    const inputs = $f.find("input,select,textarea");
    const hasPassword = $f.find('input[type="password"]').length > 0;
    const hasFile = $f.find('input[type="file"]').length > 0;
    const hasCsrf = inputs.toArray().some((i) => /csrf|token|nonce|authenticity|_token|__requestverification/i.test(($(i).attr("name") || "") + " " + ($(i).attr("id") || "")));
    facts.forms.push({
      page: pageUrl,
      action: actionAbs,
      method: ($f.attr("method") || "get").toLowerCase(),
      hasPassword,
      hasFile,
      hasCsrf,
      insecureAction: /^http:\/\//i.test(actionAbs),
      pwAutocompleteOn: hasPassword && $f.find('input[type="password"][autocomplete="on"]').length > 0,
    });
  });
  // contact hints (public emails and contact-like pages) for the community bulletin
  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") || "").trim();
    const text = ($(el).text() || "").trim();
    if (/^mailto:/i.test(href)) {
      const em = href.replace(/^mailto:/i, "").split("?")[0].trim().toLowerCase();
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em) && !facts.contact.emails.includes(em) && facts.contact.emails.length < 5) facts.contact.emails.push(em);
      return;
    }
    if (/contact|get in touch|reach us|about us/i.test(text + " " + href)) {
      try { const abs = new URL(href, pageUrl); if (abs.origin === origin && !facts.contact.pages.includes(abs.href) && facts.contact.pages.length < 5) facts.contact.pages.push(abs.href); } catch {}
    }
  });
  // cookies
  const sc = headers.get("set-cookie");
  if (sc) facts.setCookies.push({ page: pageUrl, raw: sc });
}

function safeOrigin(u) { try { return new URL(u).origin; } catch { return null; } }

async function fetchRobots(ctx, facts) {
  try {
    const res = await ctx.client.get(facts.baseOrigin + "/robots.txt");
    if (res.status === 200 && /text\/plain/i.test(res.contentType || "")) {
      const body = await res.text(20000);
      if (!/<html/i.test(body)) {
        facts.robots = body.slice(0, 8000);
        const sm = [...body.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
        facts.sitemapUrls = sm.slice(0, 3);
      }
    }
  } catch {}
}

async function crawl(ctx, facts) {
  const origin = facts.baseOrigin;
  const $ = facts.$;
  const queue = [];
  const seen = new Set([facts.finalUrl.href]);

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    let abs;
    try { abs = new URL(href, facts.finalUrl); } catch { return; }
    if (abs.origin !== origin) return;
    abs.hash = "";
    if (/\.(pdf|jpg|jpeg|png|gif|svg|webp|zip|mp4|css|js|ico|woff2?)$/i.test(abs.pathname)) return;
    if (seen.has(abs.href)) return;
    seen.add(abs.href);
    queue.push(abs.href);
  });

  const targets = queue.slice(0, config.maxCrawlPages);
  for (const href of targets) {
    let res;
    try { res = await ctx.client.get(href); } catch { continue; }
    let html = "";
    if (/text\/html/i.test(res.contentType || "")) {
      try { html = await res.text(); } catch { html = ""; }
    }
    const $page = cheerio.load(html || "");
    facts.pages.push({ url: res.finalUrl || href, status: res.status, html, $: $page, headers: res.headers, contentType: res.contentType });
    if (html) collectFrom(facts, $page, new URL(res.finalUrl || href), res.headers);
  }
}

function detectStack(facts, $, html) {
  const tech = new Set();
  if (facts.generator) {
    const m = facts.generator.match(/^(WordPress|Joomla|Drupal)\s*([\d.]+)?/i);
    if (m) {
      facts.cms = { name: m[1].toLowerCase(), version: m[2] || null };
      tech.add(m[1]);
    } else {
      tech.add(facts.generator.split(" ")[0]);
    }
  }
  if (!facts.cms && /\/wp-(content|includes)\//.test(html)) {
    facts.cms = { name: "wordpress", version: null };
    tech.add("WordPress");
  }
  const seen = new Set();
  $("link[href],script[src]").each((_, el) => {
    const src = $(el).attr("href") || $(el).attr("src") || "";
    const pm = src.match(/\/wp-content\/(plugins|themes)\/([^/]+)\/[^?]*\?ver=([\d.]+)/);
    if (pm) {
      const key = `${pm[2]}@${pm[3]}`;
      if (!seen.has(key)) {
        seen.add(key);
        facts.plugins.push({ type: pm[1].slice(0, -1), slug: pm[2], version: pm[3] });
      }
    }
  });
  if (/\/_next\//.test(html)) tech.add("Next.js");
  if (facts.poweredBy) tech.add(facts.poweredBy);
  facts.technologies = [...tech];
}

function cap(s) {
  return String(s || "").replace(/\b\w/g, (c) => c.toUpperCase());
}
