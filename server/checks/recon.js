// recon.js
// Step 1: look around. Fetch the homepage once, read the headers, and work out
// what the site is built with. The parsed HTML is shared with later checks so
// we only download the homepage a single time.
//
// Deterministic. No model involved.

import * as cheerio from "cheerio";

// Rough "current major version" map, used only to say a platform *looks* old.
// Kept intentionally conservative and honest in the wording.
const LATEST_MAJOR = { wordpress: 6, joomla: 5, drupal: 10 };

export async function runRecon(ctx) {
  const { client, url } = ctx;
  const findings = [];
  const passes = [];

  let res;
  try {
    res = await client.get(url.href);
  } catch (err) {
    // If we can't even load the homepage, there is nothing else to check.
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
  };

  detectStack(facts, $, html);

  // ---- findings derived from recon itself ----

  // No HTTPS at all.
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

  // Outdated platform (heuristic, worded carefully).
  if (facts.cms && facts.cms.version) {
    const major = parseInt(String(facts.cms.version).split(".")[0], 10);
    const latest = LATEST_MAJOR[facts.cms.name];
    if (latest && Number.isFinite(major) && major < latest) {
      findings.push({
        id: "outdated-cms",
        category: "outdated",
        severity: "serious",
        title: `Your website software looks out of date`,
        meaning: `Your site appears to run ${cap(facts.cms.name)} ${facts.cms.version}, an older version. Old software has publicly known break-in methods, like a lock everyone already knows how to pick.`,
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
          note: "Version read from the page, not confirmed against a live vulnerability database in this build.",
        },
      });
    } else {
      passes.push(`Your ${cap(facts.cms.name)} install looks current.`);
    }
  }

  // Server announcing its exact version.
  if (facts.server && /\d+\.\d+/.test(facts.server)) {
    findings.push({
      id: "server-version-disclosure",
      category: "info-leak",
      severity: "watch",
      title: "Your server announces its exact version",
      meaning:
        "Your website tells every visitor the precise software and version it runs. That's a handy shopping list for anyone looking for a known weakness.",
      fix: ["Ask your web person to hide the version number in the server's response headers."],
      who: "Your web person or hosting provider.",
      evidence: { lines: [`Server: ${facts.server}`, facts.poweredBy ? `X-Powered-By: ${facts.poweredBy}` : ""].filter(Boolean), note: "Read from response headers." },
    });
  }

  return { facts, findings, passes };
}

function detectStack(facts, $, html) {
  const tech = new Set();

  // WordPress and friends via generator tag.
  if (facts.generator) {
    const m = facts.generator.match(/^(WordPress|Joomla|Drupal)\s*([\d.]+)?/i);
    if (m) {
      facts.cms = { name: m[1].toLowerCase(), version: m[2] || null };
      tech.add(m[1]);
    } else {
      tech.add(facts.generator.split(" ")[0]);
    }
  }

  // WordPress path signals even when the generator tag is hidden.
  if (!facts.cms && /\/wp-(content|includes)\//.test(html)) {
    facts.cms = { name: "wordpress", version: null };
    tech.add("WordPress");
  }

  // Plugin + theme versions from asset query strings (?ver=x.y).
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
    const jq = src.match(/jquery[.-]?([\d.]+)?(?:\.min)?\.js/i);
    if (jq && jq[1]) tech.add(`jQuery ${jq[1]}`);
  });

  // A couple of common front-end frameworks, best-effort.
  if (/react/i.test(html) && /data-reactroot|__next/i.test(html)) tech.add("React");
  if (/\/_next\//.test(html)) tech.add("Next.js");
  if (facts.poweredBy) tech.add(facts.poweredBy);

  facts.technologies = [...tech];
}

function cap(s) {
  return String(s || "").replace(/\b\w/g, (c) => c.toUpperCase());
}
