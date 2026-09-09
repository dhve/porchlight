import test from 'node:test';
import assert from 'node:assert/strict';
import { findGlossaryTerms, glossary } from '../public/glossary-data.js';

test('technical prose offers terms with the original spelling and position', () => {
  const text = 'Read robots.txt, then check HTTPS and API keys.';
  assert.deepEqual(findGlossaryTerms(text).map(m => [text.slice(m.start, m.end), m.key]), [
    ['robots.txt', 'robots'], ['HTTPS', 'https'], ['API keys', 'api-key'],
  ]);
});
test('longest aliases win and matching respects word boundaries', () => {
  const text = 'Content Security Policy, HTTP headers and HTTP. Capital, stylesheetish, HTTPSite.';
  assert.deepEqual(findGlossaryTerms(text).map(m => text.slice(m.start, m.end)), ['Content Security Policy', 'HTTP headers', 'HTTP']);
});
test('raw addresses and email addresses remain intact', () => {
  const text = 'https://example.com/robots.txt?api=1 /robots.txt help@api.example CSS in words.';
  assert.deepEqual(findGlossaryTerms(text).map(m => text.slice(m.start, m.end)), ['CSS']);
});
test('repeated matching is stable and covers terms in minor notes', () => {
  const text = 'robots.txt and sitemap. robots.txt and source maps.';
  const first = findGlossaryTerms(text);
  assert.equal(first.length, 4);
  assert.deepEqual(findGlossaryTerms(text), first);
  assert.ok(glossary.find(t => t.key === 'robots').definition.includes('not a password'));
});
