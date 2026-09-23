import { load } from 'cheerio';
import { normalizePublicUrl, resolveTarget } from './safety.js';
import { createClient } from './lib/http.js';

const fail = (error) => ({ ok: false, error });

// A successful read confirms a reachable web page, not the identity of a business.
export async function validateCommunityWebsite(raw, { resolve = resolveTarget, makeClient = createClient } = {}) {
  if (typeof raw !== 'string' || raw.length > 2000) return fail('Please enter a website address.');
  const normalized = normalizePublicUrl(raw);
  if (!normalized.ok) return fail('Use a public website address without login details, query values, or a custom port.');
  const original = normalized.url.href;
  let current = normalized.url;
  const seen = new Set();
  const client = makeClient();
  try {
    for (let hop = 0; hop < 5; hop++) {
      if (seen.has(current.href)) return fail('The website redirects in a loop. Please use a working page.');
      seen.add(current.href);
      if (!(await resolve(current)).ok) return fail('We could not confirm a public website at that address.');
      const response = await client.get(current.href, { redirect: 'manual', timeoutMs: 5000 });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        response.discard();
        if (!location) return fail('The website redirect has no destination.');
        const next = normalizePublicUrl(new URL(location, current).href);
        if (!next.ok) return fail('The website redirects to an address we cannot check safely.');
        current = next.url;
        continue;
      }
      if (!response.ok || !/^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(response.contentType || '')) {
        response.discard();
        return fail('We could not load a web page there. Check the address and try again.');
      }
      const html = await response.text(100_000);
      if (response.challenge) return fail('The website blocked this check. Try again when the page can be read.');
      const $ = load(html);
      $('script,style,noscript').remove();
      if (!$('body').text().trim() && !$('title').text().trim()) return fail('That address did not return a readable web page.');
      return { ok: true, value: original, finalUrl: current.href };
    }
    return fail('The website has too many redirects. Please use its final page address.');
  } catch {
    return fail('We could not reach that website to check it. Please try again.');
  }
}

export async function validateCommunityContact(raw, user, options) {
  const contact = typeof raw === 'string' ? raw.trim() : '';
  if (!contact || contact.length > 200) return fail('Please include an email address or website link under 200 characters.');
  if (/^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/.test(contact)) {
    if (!user?.emailVerified || contact.toLowerCase() !== String(user.email || '').toLowerCase()) {
      return fail('Use the confirmed email address on your account, or a public website link.');
    }
    return { ok: true, value: String(user.email).toLowerCase() };
  }
  if (!/^https?:\/\//i.test(contact)) return fail('Use your confirmed email address or a website link beginning with https://.');
  return validateCommunityWebsite(contact, options);
}
