// explain.js
// Explain what an observation may mean and how the owner or
// their web person can see it themselves. Deterministic, keyed by finding id
// with category fallbacks, so proofs are in-depth even with no LLM configured.

const BY_ID = {
  "site-unreachable": {
    why: "The checker could not get a response from the homepage. The site may be unavailable, or a network problem or access rule may have prevented this checker from connecting. This observation does not establish what every visitor sees.",
    confirm: "Open the site in a private browser window and, if possible, from another network. Ask the host to compare the failed request with its logs.",
  },
  "no-https": {
    why: "Without HTTPS, everything between a visitor and your site travels as readable text. Anyone on the same network (public wifi, a compromised router) can read or alter it, including anything typed into a form. Browsers label these pages 'Not secure' and search engines rank them lower.",
    confirm: "Look at the address bar on your site: an http:// address with no padlock.",
  },
  "cert-expired": {
    why: "Browsers refuse expired certificates and show a full-page warning. Most visitors will not click past it, so the site is effectively unreachable until the certificate is renewed.",
    confirm: "Open the site in a private window; the warning names the expired certificate and its date.",
  },
  "cert-expiring": {
    why: "The moment the certificate lapses, browsers block the site behind a warning. Renewal is automatic on most hosts, but this one is close enough to deserve a check now rather than after it fails.",
    confirm: "Click the padlock in the address bar, then the certificate details, and read the expiry date.",
  },
  "weak-cert-key": {
    why: "Shorter keys can be broken with far less computing effort. A 1024-bit RSA key is considered breakable by a well-funded attacker; 2048-bit RSA or 256-bit elliptic-curve is the current minimum.",
    confirm: "Click the padlock, open the certificate, and check the public key size.",
  },
  "self-signed-cert": {
    why: "A self-signed certificate is not vouched for by any trusted authority, so a browser cannot tell your real site from an impostor and warns the visitor away.",
    confirm: "Open the site in a private window: the browser shows 'Your connection is not private'.",
  },
  "old-tls-protocols": {
    why: "TLS 1.0 and 1.1 have known weaknesses (the BEAST and POODLE families of attacks). An attacker on the network can force a connection down to the weak version and then read or tamper with it. Modern browsers already refuse these versions, so leaving them enabled only helps attackers.",
    confirm: "Run the domain through the free SSL Labs test (ssllabs.com/ssltest); it lists every protocol version the server accepts.",
  },
  "missing-security-headers": {
    why: "Both settings only matter for visitors who sign in. Without Strict-Transport-Security, a visitor's first request can go over plain http, where a login can be read or altered on the network. Without X-Frame-Options or frame-ancestors, another site can load this site's pages inside an invisible frame and trick a signed-in visitor into clicking something they cannot see, which is called clickjacking. Sites with no logins are not affected, which is why plenty of secure brochure sites do without these.",
    confirm: "Enter the domain at securityheaders.com; it lists exactly which headers are present and missing.",
  },
  "google-browser-key": {
    why: "Google Maps, Places, and similar browser APIs require the key in page code, so its presence is not a leak. The risk is only an unrestricted key: anyone can copy it into their own site and the usage is billed to this site's Google project.",
    confirm: "In Google Cloud Console, open APIs and Services, then Credentials, select the key, and check that Application restrictions lists this site's domains and API restrictions lists only the APIs it uses.",
  },
  "weak-csp": {
    why: "A Content-Security-Policy is meant to stop injected scripts from running. 'unsafe-inline' allows any inline script, which is exactly what an injection attack inserts. 'unsafe-eval' allows code built from text at runtime. A wildcard source lets scripts load from anywhere. Each one cancels the protection the policy is supposed to provide.",
    confirm: "In the browser's developer tools, open the Network tab, click the page, and read the content-security-policy response header.",
  },
  "cors-wildcard-creds": {
    why: "Access-Control-Allow-Origin: * combined with Allow-Credentials: true means any website a logged-in visitor opens can make requests to your site as that visitor and read the responses, including private data.",
    confirm: "In developer tools, load the page and read the two access-control response headers.",
  },
  "cors-wildcard": {
    why: "A wildcard origin lets any website read your responses. That is harmless for public pages, but if any address returns user-specific data, another site could read it on a visitor's behalf.",
    confirm: "Read the access-control-allow-origin response header in the developer tools Network tab.",
  },
  "blocked-insecure-script": {
    why: "Modern browsers refuse to load scripts, stylesheets, or frames over plain http on an https page, because an attacker on the network could replace them. The site itself is secure; the blocked file simply never loads, so anything it controls (a menu, a form, a map, a slider) stops working.",
    confirm: "Open the page and press F12 (Cmd-Option-I on a Mac); the Console shows 'Mixed Content: ... was blocked'.",
  },
  "insecure-cookies": {
    why: "Without the Secure flag, the cookie is also sent over plain http where it can be read on the network. Without HttpOnly, any script on the page, including an injected one, can read it. Without SameSite, other websites can make a visitor's browser send it. For a session cookie, whoever obtains it is logged in as that user.",
    confirm: "In developer tools, open Application (or Storage), then Cookies, and check the Secure, HttpOnly, and SameSite columns.",
  },
  "secrets-in-source": {
    why: "Anything in page source is visible to anyone who views it, and automated bots scan the web for exactly these key patterns. A leaked cloud, payment, or API key is typically found and abused within hours, which can mean charges on your account or access to your data.",
    confirm: "Right-click the page, choose View Page Source, and search for the key type named in the evidence.",
  },
  "exposed-source-maps": {
    why: "Source maps let anyone reconstruct your original, uncompressed source code with its comments. That can reveal internal addresses, business logic, and occasionally credentials left in comments.",
    confirm: "Open one of the .map addresses listed in a browser; it downloads or displays your source.",
  },
  "directory-listing": {
    why: "With listing enabled, the server shows every file in the folder to anyone who asks, including backups, exports, and uploads you never linked to. Attackers browse these folders directly.",
    confirm: "Open one of the folder addresses listed; you will see a file list titled 'Index of'.",
  },
  "verbose-errors": {
    why: "Detailed error pages expose file paths, database table names, and library versions. Attackers use those specifics to pick exact exploits instead of guessing, and error text sometimes includes data from the request.",
    confirm: "Open the page listed; the error text or stack trace is visible on the page itself.",
  },
  "robots-discloses-paths": {
    why: "robots.txt is public and attackers read it first, because every Disallow line is a place you considered sensitive enough to hide from search engines.",
    confirm: "Open yourdomain/robots.txt in a browser and read the Disallow lines.",
  },
  "outdated-cms": {
    why: "Every release fixes security holes that are then publicly documented, so an old version means known, unpatched holes on your site. Attackers scan for version numbers and apply the matching exploit automatically.",
    confirm: "Log in to your site's dashboard; the updates page shows the current version and available updates.",
  },
  "password-form-insecure": {
    why: "The password travels unencrypted. On shared wifi anyone running a free packet-capture tool can read it as it is sent.",
    confirm: "Open the login page: the address bar shows http:// or the form's destination address starts with http://.",
  },
  "form-missing-csrf": {
    why: "This is a heuristic: the checker did not find a recognizable token field in the captured form markup. It did not submit the form or test the server's defenses. Other protections may exist, so the missing field does not establish that a cross-site request would succeed.",
    confirm: "Ask the maintainer to inspect how the server protects this form, including token validation and other request checks. Compare the live form with the captured markup before concluding that protection is missing.",
  },
  "password-autocomplete": {
    why: "Allowing the browser to store this password makes it available to the next person on a shared computer. Guidance is mixed here, since password managers are safer than password reuse, which is why this is a minor note.",
    confirm: "View the page source and look at the password input's autocomplete attribute.",
  },
  "missing-sri": {
    why: "The file is a fixed library version served from a public CDN. If that CDN is ever compromised, the altered file runs on this site's pages with full access to them. An integrity hash makes the browser refuse any file that has changed, and it works for fixed library files like these (tag managers, analytics, and widgets change constantly and cannot use one).",
    confirm: "View the page source and find the script tags listed; they have no integrity attribute.",
  },
  "failed-resources": {
    why: "Each line is a file the homepage asked for and the status the server answered with. 404 means the file is not at that address any more. 403 means the server refused the request, usually a permissions or security rule. 406 (Not Acceptable) means the server would not send the file in a format the browser asked for, which is almost always a misconfigured server rule or a security plugin blocking the request. Any file the site refused was requested a second time with the headers a normal browser sends, and it is listed here only when that second request failed too, so this is not a case of the site blocking our checker. Whatever that file provided is missing for every visitor.",
    confirm: "Open the page, press F12 (Cmd-Option-I on a Mac), open the Network tab, reload, and look for rows in red; or paste one of the listed addresses into the browser.",
  },
  "console-errors": {
    why: "A browser error means a script on the page failed while running. Errors like 'x is not a function' or 'undefined' usually mean a library did not load or two scripts conflict, and whatever that script controls (a menu, a slider, a form) can silently stop working.",
    confirm: "Open the page, press F12 (or Cmd-Option-I on a Mac), and read the Console tab.",
  },
  "slow-load": {
    why: "Load time is dominated by the size of images and scripts. Each extra second measurably increases visitor drop-off, especially on phones and slower connections.",
    confirm: "Run the page through Google's free PageSpeed Insights; it lists the largest files.",
  },
  "not-mobile-friendly": {
    why: "Without a viewport meta tag, phones render the page at desktop width and shrink it to fit, so text becomes tiny and buttons are hard to tap. Search engines also rank pages that are not mobile-friendly lower.",
    confirm: "Open the site on a phone, or use Google's free Mobile-Friendly Test.",
  },
  "dated-design": {
    why: "The signals listed are techniques from older web eras. They usually come with layouts that do not adapt to phones and code that is no longer maintained or patched.",
    confirm: "View the page source and search for the tags or attributes named in the evidence.",
  },
  "minor-dated": {
    why: "A single older technique on its own is not a risk; it is a hint that the site has not been refreshed in a while.",
    confirm: "View the page source and search for the item named in the evidence.",
  },
  "reflected-input": {
    why: "The page echoed our marker with the < ' and \" characters unchanged. Those characters are how HTML and scripts are written, so if an attacker places a script in that same spot inside a link and gets a visitor to click it, the script runs in the visitor's browser as if it came from your site. We sent only harmless characters and did not attempt any attack.",
    confirm: "Add ?q=sutros<b>1 to the address listed and view the page source; the <b> appears unescaped.",
  },
};

const BY_PREFIX = [
  { re: /^vuln-lib-/, why: "This library version has a published vulnerability (a CVE, referenced in the evidence). Exploit code for known CVEs is public, and automated scanners look for exactly this version string in page source, so the risk is not theoretical.", confirm: "Search the CVE number from the evidence to read the advisory; the version is visible in the script address in your page source." },
  { re: /^exposed-/, why: "The file is served to anyone who requests that exact address. Automated scanners request these well-known paths constantly. Files of this kind typically contain passwords, keys, or customer data that give direct access to your systems.", confirm: "Open the address in a private browser window; the file contents appear. Then have it removed." },
  { re: /^broken-images/, why: "The recorded image-loading observation needs confirmation in an independent browser. A failed request in the checker's browser can reflect a missing resource, network conditions, or an access restriction.", confirm: "Open the recorded page and image addresses in your browser and compare the results with the evidence." },
  { re: /^broken-links/, why: "The recorded link observation needs confirmation in an independent browser. A failed request can reflect a missing page, network conditions, or an access restriction.", confirm: "Open the recorded page and follow the listed links, then compare the results with the evidence." },
];

const BY_CATEGORY = {
  "exposed-data": { why: "This exposes data that should never be public, and automated scanners look for it constantly.", confirm: "Open the address listed in a private browser window." },
  "info-leak": { why: "This reveals details about how the site is built, which lets an attacker choose a precise exploit instead of guessing.", confirm: "Open the address listed in a browser." },
  "hardening": { why: "This is a protective setting that is switched off. It is not an active hole, but it removes a safeguard that matters most if something else goes wrong.", confirm: "Check the response headers in the browser's developer tools." },
  "tls": { why: "This weakens the encryption between visitors and your site.", confirm: "Run the domain through the free SSL Labs test." },
  "auth": { why: "This weakens how logins and form submissions are protected.", confirm: "View the page source for the form named." },
  "quality": { why: "This is something visitors can see or run into directly.", confirm: "Open the page listed." },
  "modernization": { why: "This affects how the site looks and works for today's visitors, most of whom are on phones.", confirm: "Open the site on a phone." },
};

/**
 * The promise shown above the findings. Every report carries it so readers
 * know what a finding is and is not.
 */
export const PROOF_PROMISE =
  "Scripted findings record what the checker observed under the conditions shown in the evidence. " +
  "Some checks are heuristics and need further verification. Coverage shows which checks completed or could not run. " +
  "AI browsing observations and AI suggestions are labeled and do not change the grade or replace the original observations. " +
  "Evidence and signatures help readers inspect a report; they do not guarantee that its interpretation is correct or that the whole site is safe.";

/** Return { why, confirm } for a finding; empty strings if nothing applies. */
export function explain(finding) {
  if (!finding) return { why: "", confirm: "" };
  const availability = explainAvailability(finding);
  if (availability) return availability;
  if (BY_ID[finding.id]) return BY_ID[finding.id];
  for (const p of BY_PREFIX) if (p.re.test(finding.id || "")) return { why: p.why, confirm: p.confirm };
  return BY_CATEGORY[finding.category] || { why: "", confirm: "" };
}

function explainAvailability(finding) {
  if (!/^(broken-links|broken-images|flow-(error|missing)-.+)$/.test(String(finding.id || ''))) return null;
  const items = Array.isArray(finding.evidence?.items) ? finding.evidence.items : [];
  const statuses = [...new Set(items.map(item => item?.status).filter(status => Number.isInteger(status) && status >= 400 && status <= 599))];
  const unanswered = items.some(item => item?.status === 0);
  const observed = statuses.length ? `Sutros recorded ${statuses.map(status => `HTTP ${status}`).join(', ')} responses. ` : '';
  const why = unanswered
    ? observed + 'Sutros received no HTTP response for one or more recorded requests. A connection failure can reflect network conditions or access restrictions and does not establish a server error or what other visitors experienced.'
    : statuses.length
      ? observed + 'An HTTP error describes the response received by the checker at that time. The response may come from the website, an intermediary, or an access rule. Retrying from the same network with different headers does not establish what other visitors see.'
      : 'The recorded evidence does not establish an HTTP error at the listed addresses. Inspect the observation and compare it with an independent browser before treating the finding as confirmed.';
  return { why, confirm: 'Open the listed addresses in your browser and, if possible, from another network. Compare what loads with the recorded responses. If the results differ, ask the host to check its request and access logs.' };
}
