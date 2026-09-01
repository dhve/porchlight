// links.js
// Step 4: check for broken links and broken images, the small stuff that makes
// a site feel neglected. We sample a bounded number so we stay polite.
//
// Deterministic. HEAD first (cheap), GET only if HEAD isn't allowed.

import { config } from "../safety.js";

export async function runLinks(ctx) {
  const { client, facts } = ctx;
  const findings = [];
  const passes = [];
  const $ = facts.$;
  const origin = facts.baseOrigin;
  if (!$ || !origin) return { findings, passes };

  const links = new Set();
  const images = new Set();

  $("a[href]").each((_, el) => {
    const abs = absolute($(el).attr("href"), origin);
    if (abs && abs.origin === origin && /^https?:/.test(abs.protocol)) links.add(abs.href);
  });
  $("img[src]").each((_, el) => {
    const abs = absolute($(el).attr("src") || $(el).attr("data-src"), origin);
    if (abs && /^https?:/.test(abs.protocol)) images.add(abs.href);
  });

  // Budget the samples: favor images (visitors see those immediately).
  const imgSample = [...images].slice(0, Math.ceil(config.maxLinks / 2));
  const linkSample = [...links].slice(0, config.maxLinks - imgSample.length);

  const brokenImages = [];
  const brokenLinks = [];

  for (const url of imgSample) {
    const ok = await reachable(client, url);
    if (ok === false) brokenImages.push(url);
  }
  for (const url of linkSample) {
    const ok = await reachable(client, url);
    if (ok === false) brokenLinks.push(url);
  }

  if (brokenImages.length) {
    findings.push({
      id: "broken-images",
      category: "quality",
      severity: "watch",
      title: `${brokenImages.length} image${brokenImages.length > 1 ? "s are" : " is"} broken`,
      meaning:
        "Some images on your site don't load, so visitors see a broken-image icon instead. Since most people browse on phones, a broken photo is often the first thing they notice.",
      fix: ["Re-upload the missing images, or fix the links pointing to them."],
      who: "You can often do this yourself.",
      evidence: { lines: brokenImages.slice(0, 5).map((u) => shorten(u)), note: `${brokenImages.length} broken of ${imgSample.length} images sampled.` },
    });
  }
  if (brokenLinks.length) {
    findings.push({
      id: "broken-links",
      category: "quality",
      severity: "watch",
      title: `${brokenLinks.length} link${brokenLinks.length > 1 ? "s lead" : " leads"} nowhere`,
      meaning:
        "Some links on your site point to pages that no longer exist. Dead links frustrate visitors and make a business look inattentive.",
      fix: ["Update or remove the broken links so every one goes somewhere real."],
      who: "You or your web person.",
      evidence: { lines: brokenLinks.slice(0, 5).map((u) => shorten(u)), note: `${brokenLinks.length} broken of ${linkSample.length} links sampled.` },
    });
  }
  if (!brokenImages.length && !brokenLinks.length && (imgSample.length || linkSample.length)) {
    passes.push("The links and images we sampled all work.");
  }

  return { findings, passes };
}

async function reachable(client, url) {
  try {
    let res = await client.head(url);
    if (res.status === 405 || res.status === 501) res = await client.get(url); // HEAD not allowed
    if (res.status >= 400) return false;
    return true;
  } catch {
    return null; // inconclusive (timeout/network); don't count as broken
  }
}

function absolute(href, origin) {
  if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:") || href.startsWith("data:")) return null;
  try {
    return new URL(href, origin);
  } catch {
    return null;
  }
}

function shorten(u) {
  try {
    const x = new URL(u);
    return (x.pathname + x.search).slice(0, 80) || u.slice(0, 80);
  } catch {
    return u.slice(0, 80);
  }
}
