// explain.js
// Technical-proof explanations. For every finding, say WHY the evidence shows a
// real problem (the mechanism, and what can go wrong) and HOW the owner or
// their web person can see it themselves. Deterministic, keyed by finding id
// with category fallbacks, so proofs are in-depth even with no LLM configured.

const BY_ID = {
  "site-unreachable": {
    why: "The server did not answer within the timeout. That means visitors get nothing either: the site may be down, overloaded, or blocking connections at the firewall.",
    confirm: "Open the site in a private browser window. If it spins and fails, it is down for everyone.",
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
    why: "These headers are instructions your server sends with every page. Without X-Frame-Options or frame-ancestors, another site can load your page inside an invisible frame and trick visitors into clicking things (clickjacking). Without Content-Security-Policy, any script that gets injected runs freely. Without HSTS, a visitor's first request can be intercepted and downgraded to plain http. Each missing header is one specific protection switched off.",
    confirm: "Enter the domain at securityheaders.com; it lists exactly which headers are present and missing.",
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
    why: "Without a per-form secret token, a malicious page can submit this form using a logged-in visitor's browser, performing the action as them without their knowledge.",
    confirm: "View the page source and look for a hidden input named like csrf, token, or nonce inside the form; there is none.",
  },
  "password-autocomplete": {
    why: "Allowing the browser to store this password makes it available to the next person on a shared computer. Guidance is mixed here, since password managers are safer than password reuse, which is why this is a minor note.",
    confirm: "View the page source and look at the password input's autocomplete attribute.",
  },
  "missing-sri": {
    why: "If the third-party host serving that script is compromised or hijacked, the altered script runs on your page with full access to it. An integrity hash makes the browser refuse any file that has changed.",
    confirm: "View the page source and find the script tags listed; they have no integrity attribute.",
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
  { re: /^flow-error-/, why: "The server answered with a 5xx status, which means its own code failed while handling the request. Visitors get an error page instead of the feature, and the failure repeats on every attempt until the underlying plugin or code is fixed.", confirm: "Open the address in the evidence; you will see the error page." },
  { re: /^flow-missing-/, why: "A 404 status means nothing exists at that address any more, so the link is dead for every visitor who clicks it.", confirm: "Click the link on your site; it lands on a Not Found page." },
  { re: /^broken-images/, why: "The image address returns an error, so browsers draw a broken-image icon instead. Usually the file was moved, renamed, or deleted while the page still points at the old address.", confirm: "Open one of the image addresses listed; it returns an error instead of a picture." },
  { re: /^broken-links/, why: "The link target returns an error status, so visitors who click it hit a dead end.", confirm: "Click one of the links listed on your site." },
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

/** Return { why, confirm } for a finding; empty strings if nothing applies. */
export function explain(finding) {
  if (!finding) return { why: "", confirm: "" };
  if (BY_ID[finding.id]) return BY_ID[finding.id];
  for (const p of BY_PREFIX) if (p.re.test(finding.id || "")) return { why: p.why, confirm: p.confirm };
  return BY_CATEGORY[finding.category] || { why: "", confirm: "" };
}
