// modernization.js
// Step 4: is the site dated, and (most importantly) is it usable on a phone?
// These are the most actionable, most understandable findings for a small
// business, community group, or town office, so each one comes with specific,
// non-technical next steps and named tools, not jargon.
//
// Deterministic, reads the homepage HTML already fetched by recon.
//
// Every finding carries evidence.pages (the homepage, where these signals are
// read) and evidence.method (how we tested it). Nothing here requests an
// address, so there are no evidence.items.

export async function runModernization(ctx) {
  const { facts } = ctx;
  const findings = [];
  const passes = [];
  const page = facts.pages && facts.pages[0];
  if (!page || !page.html) return { findings, passes };
  const html = page.html;
  const $ = page.$ || facts.$;
  const year = new Date().getFullYear();
  const homepage = href(facts.finalUrl) || href(page.url) || (facts.baseOrigin ? facts.baseOrigin + "/" : "");

  const hasViewport = Boolean($ && typeof $ === "function" && $('meta[name="viewport"]').length > 0) || /<meta[^>]+name=["']viewport["']/i.test(html);

  const signals = [];
  if (/<font[\s>]/i.test(html)) signals.push("uses old <font> tags");
  if (/<center[\s>]/i.test(html)) signals.push("uses <center> tags to position things");
  if (/<marquee|<blink/i.test(html)) signals.push("uses scrolling or blinking text");
  if (/cellpadding=|cellspacing=|<frameset/i.test(html)) signals.push("is laid out with tables or frames (an old technique)");
  if (/(FrontPage|Dreamweaver|Microsoft Word|GoLive)/i.test(facts.generator || "")) signals.push(`was built with dated software (${facts.generator})`);
  if (/<embed[^>]+\.swf|<object[^>]+\.swf|application\/x-shockwave-flash/i.test(html)) signals.push("uses Flash, which no longer works in any modern browser");
  if (/<!DOCTYPE\s+HTML\s+PUBLIC/i.test(html)) signals.push("uses an outdated page format (HTML 4 / XHTML)");
  if ((facts.scripts || []).some((s) => /jquery[-.]?1\.\d/i.test(s.src))) signals.push("runs a very old version of jQuery");
  const years = [...html.matchAll(/(?:©|&copy;|copyright)[^\d]{0,10}(?:\d{4}\s*[-–]\s*)?(\d{4})/gi)]
    .map((m) => parseInt(m[1], 10)).filter((y) => y > 2000 && y <= year);
  if (years.length && Math.max(...years) <= year - 3) signals.push(`the copyright year still says ${Math.max(...years)}`);

  const signalsMethod =
    "We read the homepage source and looked for a fixed set of older techniques: font and center tags, scrolling or blinking text, table or frame layouts, Flash, the HTML 4 page format, very old jQuery, dated page builders, and a copyright year three or more years behind. Each sign we found is listed above.";

  if (!hasViewport) {
    findings.push({
      id: "not-mobile-friendly",
      category: "modernization",
      severity: "serious",
      title: "Your website isn't built for phones",
      meaning:
        "Your site doesn't tell phones how to size the page, so it likely shows up tiny and hard to use on a phone. Most people visit small business and community sites on their phones, and search engines rank phone-friendly sites higher, so this quietly costs you visitors.",
      fix: [
        "Open your own site on your phone. If you have to pinch and zoom to read it, that is the problem your visitors have too.",
        "The simplest fix is a modern website builder that handles phones for you: Squarespace or Wix (about $16 to $23 a month, no coding), or WordPress with a current theme.",
        "On a tight budget, Google Sites is free and phone-friendly out of the box.",
        "Prefer to hand it off? See the local helpers listed in Sutros.",
      ],
      who: "You (with a website builder) or a local helper.",
      evidence: {
        lines: ["No mobile viewport setting was found on the homepage.", "You can confirm with Google's free Mobile-Friendly Test."],
        note: "Read from the homepage HTML.",
        method: "We read the homepage source and looked for a meta viewport tag, the one line that tells phones how to size the page. There was none.",
        pages: [homepage],
      },
    });
  } else {
    passes.push("Your site is set up to work properly on phones.");
  }

  if (signals.length >= 2) {
    findings.push({
      id: "dated-design",
      category: "modernization",
      severity: "watch",
      title: "Your website looks dated",
      meaning:
        "A few signs suggest your site was built a while ago and hasn't been refreshed. People judge a business or organization by its website within seconds, and a dated look can cost you trust before someone ever calls or visits.",
      fix: [
        "A refresh usually just means moving your same words and photos into a modern template.",
        "Easiest with no coding: Squarespace, Wix, or Webflow. If you're on WordPress, switching to a current theme goes a long way.",
        "Want it done for you? Find a local helper in the Sutros directory.",
      ],
      who: "You (with a website builder) or a local helper.",
      evidence: {
        lines: signals.slice(0, 6).map((s) => "Your site " + s),
        note: "Signs of an older build, from the homepage.",
        method: signalsMethod,
        pages: [homepage],
      },
    });
  } else if (signals.length === 1) {
    findings.push({
      id: "minor-dated",
      category: "modernization",
      severity: "minor",
      title: "One small sign your site could be refreshed",
      meaning: `A small detail suggests a refresh could help: your site ${signals[0]}.`,
      fix: ["Where: your homepage.", "Not urgent. Next time you update the site, switching to a current template clears this up."],
      who: "You or a local helper.",
      evidence: {
        lines: ["Your site " + signals[0]],
        note: "Minor modernization signal.",
        method: signalsMethod,
        pages: [homepage],
      },
    });
  }

  return { findings, passes };
}

function href(u) {
  if (!u) return "";
  if (typeof u === "string") return u;
  return u.href || String(u);
}
