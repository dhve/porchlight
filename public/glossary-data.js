// Definitions are separate from page decoration so matching can be tested without a browser.
const term = (key, label, definition, aliases = []) => ({ key, label, definition, aliases: [label, ...aliases] });
export const glossary = [
  term('robots', 'robots.txt', 'A public file that asks cooperating search engines and other crawlers which parts of a site they may visit. It is not a password or access restriction, and it does not guarantee a page will stay out of search results.'),
  term('sitemap', 'sitemap', 'A file listing pages a site wants search engines to discover. A missing sitemap alone does not mean the site is broken.', ['sitemaps']),
  term('https', 'HTTPS', 'The encrypted form of HTTP. It protects data while it travels between a browser and a website. It does not guarantee the website itself is trustworthy.'),
  term('http', 'HTTP', 'The rules a browser and a web server use to request and deliver pages, images, and other files.'),
  term('headers', 'HTTP headers', 'Small pieces of information sent with a web request or response. They describe things such as file type, caching, and browser security rules.', ['security headers', 'response headers', 'request headers', 'headers']),
  term('status', 'status code', 'A number a server sends to describe the result of a request. For example, 200 usually means success and 404 means the address was not found.', ['status codes', 'HTTP status']),
  term('404', '404 Not Found', 'The server did not find a resource at that address. A checker should confirm the response before calling a link broken.', ['404']),
  term('403', '403 Forbidden', 'The server refused this request. It may allow an ordinary visitor or a signed-in user, so this alone does not prove the page is broken.', ['403']),
  term('429', '429 Too Many Requests', 'The server is limiting requests. Our checker may need to stop or wait; this is not proof that visitors cannot use the site.', ['429']),
  term('500', '500 Internal Server Error', 'The server encountered an error while handling a request. The cause and duration need further checking.', ['500']),
  term('tls', 'TLS', 'The technology that encrypts an HTTPS connection and helps a browser check the server identity.'),
  term('ssl', 'SSL', 'An older name often used for website encryption certificates. Modern secure websites use TLS instead of the old SSL protocols.'),
  term('certificate', 'certificate', 'A digital record a browser uses to check that an encrypted connection belongs to the expected website.', ['certificates']),
  term('encryption', 'encryption', 'Scrambling data so it can be read only with the right key. Connection encryption protects data in transit.'),
  term('csp', 'Content Security Policy', 'A rule a website gives the browser to limit which scripts, images, and other resources may load. It can reduce the impact of injected content.', ['CSP']),
  term('cors', 'CORS', 'Browser rules controlling whether code on one website can read certain responses from another website. Public resources can legitimately allow broad access.'),
  term('hsts', 'HSTS', 'A website rule that tells browsers to use encrypted HTTPS connections for a period of time.'),
  term('cookie', 'cookie', 'A small value a website asks your browser to store and send back. It can keep you signed in or remember a choice.', ['cookies']),
  term('httponly', 'HttpOnly', 'A cookie setting that stops page scripts from reading that cookie. It helps protect sign-in cookies from some attacks.'),
  term('samesite', 'SameSite', 'A cookie setting that controls when it is sent with requests started from other websites.'),
  term('secure-cookie', 'Secure flag', 'A cookie setting that tells a browser to send that cookie only over an encrypted connection.', ['Secure cookie']),
  term('csrf', 'CSRF', 'An attack that tricks a signed-in browser into making an unwanted request to another site. Websites use checks such as special tokens to prevent it.'),
  term('xss', 'XSS', 'An attack where unwanted code runs inside a website in a visitor’s browser. Reflected text alone is not enough to prove that code can run.', ['cross-site scripting']),
  term('sri', 'Subresource Integrity', 'A browser check that a downloaded script or stylesheet matches the exact version the site expected.', ['SRI']),
  term('api-key', 'API key', 'A value used to identify an application when it calls a service. Some keys are intended for public browsers; secret keys require private storage and access limits.', ['API keys']),
  term('api', 'API', 'A defined way for one program to request information or actions from another program.', ['APIs']),
  term('source-map', 'source map', 'A file that connects compressed website code to its original form, mainly for debugging. Its presence alone does not prove private information was exposed.', ['source maps']),
  term('dns', 'DNS', 'The system that translates a website name into the network address of its server.'),
  term('oauth', 'OAuth', 'A way to let an app use limited access through another service without giving the app your password. It is often part of a sign-in flow.'),
  term('signature', 'digital signature', 'A mathematical check of who signed data and whether the signed content changed. It does not prove that the content is factually correct.', ['signed report', 'Ed25519']),
  term('viewport', 'viewport', 'The visible area a page has to fit inside. A viewport setting helps mobile browsers size a page for a phone.'),
  term('javascript', 'JavaScript', 'Code that adds behavior to a web page, such as opening menus or updating forms.', ['JS']),
  term('css', 'CSS', 'The rules that control a page’s colors, fonts, spacing, and layout. If these rules do not load, a working page can look plain or broken.', ['stylesheet', 'stylesheets']),
  term('html', 'HTML', 'The markup that gives a web page its structure, such as headings, links, images, and forms.'),
  term('cdn', 'CDN', 'A network of servers that delivers website files from locations closer to visitors.'),
  term('llm', 'LLM', 'A language model that generates and interprets text. Its suggestions can be wrong and need evidence and testing.', ['language model']),
  term('crawler', 'crawler', 'A program that visits pages and follows links automatically, often to build a search index or check a site.', ['crawlers']),
  term('cache', 'cache', 'A saved copy used to load something faster. A cached copy can remain after the original changes or is removed.', ['caching', 'cached']),
  term('redirect', 'redirect', 'An instruction that sends a browser from one address to another. Repeated redirects can form a loop.', ['redirects']),
  term('cms', 'CMS', 'Software used to manage website pages and content, such as WordPress.'),
  term('cve', 'CVE', 'An identifier for a publicly reported software vulnerability. A version match needs context before it proves a particular site is affected.', ['CVEs']),
  term('vulnerability', 'vulnerability', 'A weakness that may let someone do something the website did not intend. A warning needs evidence of the weakness and its conditions.', ['vulnerabilities']),
  term('false-positive', 'false positive', 'A warning about an issue that is not actually present.', ['false positives']),
  term('false-negative', 'false negative', 'An issue that is present but the checker fails to report.', ['false negatives']),
  term('regression', 'regression test', 'A repeatable test kept after a mistake is found, so a later change is checked for the same mistake.', ['regression tests']),
  term('bot-challenge', 'bot challenge', 'A website check intended to distinguish an automated program from a visitor. It can block our checker even when the site works on your phone.', ['anti-bot challenge']),
  term('rate-limit', 'rate limit', 'A limit on how many requests can be made during a period of time.', ['rate limiting', 'rate limits']),
  term('recon', 'recon', 'The first check of a site’s public pages and visible technology, used to decide what to inspect next.'),
  term('orchestrator', 'orchestrator', 'The part of the checker that chooses and orders the checks.'),
  term('probe', 'probe', 'A small request or test used to observe how a website responds.', ['probes']),
  term('source-code', 'source code', 'The instructions developers write to make software work.'),
  term('hash', 'hash', 'A short digital fingerprint of data. Changing the data usually changes its fingerprint.', ['hashes']),
  term('metadata', 'metadata', 'Information about a record, such as when it was created or which checker produced it.'),
  term('query', 'query parameters', 'Values added after the question mark in a web address. They can contain search terms, tracking information, or private tokens. Public checkups require an address without them.', ['query parameter', 'query string']),
  term('public-key', 'public key', 'A key people can share to verify a digital signature or encrypt data for its owner. It is different from a secret private key.', ['public keys']),
  term('private-key', 'private key', 'A secret used for signing or decryption. Its owner must keep it private.', ['private keys']),
  term('json', 'JSON', 'A text format programs use to exchange structured information.'),
  term('xml', 'XML', 'A text format for structured information. Website sitemaps often use it.'),
  term('iframe', 'iframe', 'A web page embedded inside another page.', ['iframes']),
  term('mixed-content', 'mixed content', 'When an HTTPS page tries to load some resources over unencrypted HTTP. Browsers may block those resources.'),
  term('clickjacking', 'clickjacking', 'An attack that hides or overlays a page to trick someone into clicking a control they did not intend to use.'),
  term('directory-listing', 'directory listing', 'A server-generated list of files inside a website folder. It can expose filenames that were not meant to be browsed.'),
];

const escapeRE = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const aliases = glossary.flatMap(t => t.aliases.map(alias => ({ alias, key: t.key })))
  .sort((a, b) => b.alias.length - a.alias.length);
const keyByAlias = new Map(aliases.map(t => [t.alias.toLowerCase(), t.key]));
const pattern = new RegExp(aliases.map(t => escapeRE(t.alias)).join('|'), 'gi');
const word = /[\p{L}\p{N}_]/u;

export function findGlossaryTerms(value) {
  const text = String(value ?? '');
  const protectedSpans = [...text.matchAll(/(?:https?:\/\/|www\.)[^\s<>]+|\/[\w.][^\s<>]*|[\w.+-]+@[\w.-]+\.[\w-]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,63}(?::\d+)?(?:\/[^\s<>]*)?/gi)]
    .filter(m => !keyByAlias.has(m[0].toLowerCase()))
    .map(m => [m.index, m.index + m[0].length]);
  const matches = [];
  for (const m of text.matchAll(new RegExp(pattern))) {
    const start = m.index, end = start + m[0].length;
    if (word.test(text[start - 1] || '') || word.test(text[end] || '')) continue;
    if (protectedSpans.some(([a, b]) => start < b && end > a)) continue;
    matches.push({ start, end, key: keyByAlias.get(m[0].toLowerCase()) });
  }
  return matches;
}
