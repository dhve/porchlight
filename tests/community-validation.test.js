import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCommunityWebsite, validateCommunityContact } from '../server/communityValidation.js';

const page = () => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, truncated: false,
  body: Buffer.from('<html><title>A local business</title><body>Opening hours and how to contact us.</body></html>') });
const emailUser = { id: 'owner', email: 'owner@example.test', emailVerified: true };

test('a public contact email requires this account confirmed inbox, not just valid syntax', async () => {
  assert.deepEqual(await validateCommunityContact('OWNER@example.test', emailUser), { ok: true, value: 'owner@example.test' });
  assert.equal((await validateCommunityContact('other@example.test', emailUser)).ok, false);
  assert.equal((await validateCommunityContact(emailUser.email, { ...emailUser, emailVerified: false })).ok, false);
  assert.equal((await validateCommunityContact(emailUser.email, null)).ok, false);
});

test('website validation rejects private redirect addresses before making a request', async () => {
  for (const location of ['http://127.0.0.1/private', 'https://private.example/private']) {
    const requests = [];
    const resolved = [];
    const result = await validateCommunityWebsite('https://public.example/', {
      resolve: async url => {
        resolved.push(url.href);
        return { ok: url.hostname === 'public.example', addresses: ['203.0.113.8'] };
      },
      fetchGuarded: async ({ url, ip }) => {
        requests.push({ url: url.href, ip });
        return { ...page(), status: 302, headers: { location } };
      },
    });
    assert.equal(result.ok, false);
    assert.deepEqual(requests, [{ url: 'https://public.example/', ip: '203.0.113.8' }], 'Private redirect destination must never receive a request');
    assert.deepEqual(resolved, ['https://public.example/', location]);
  }
});

test('website validation connects to each public IP approved for the current redirect', async () => {
  const resolved = [];
  const requests = [];
  const result = await validateCommunityWebsite('https://public.example/', {
    resolve: async url => {
      resolved.push(url.href);
      return { ok: true, addresses: [url.hostname === 'public.example' ? '203.0.113.8' : '203.0.113.9'] };
    },
    fetchGuarded: async ({ url, ip, method, maxBytes, timeoutMs }) => {
      requests.push({ url: url.href, ip, method, maxBytes, timeoutMs });
      return url.hostname === 'public.example'
        ? { status: 302, headers: { location: 'https://destination.example/about' }, body: Buffer.alloc(0), truncated: false }
        : { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html><body>A readable page.</body></html>'), truncated: false };
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(requests, [
    { url: 'https://public.example/', ip: '203.0.113.8', method: 'GET', maxBytes: 100_000, timeoutMs: 5000 },
    { url: 'https://destination.example/about', ip: '203.0.113.9', method: 'GET', maxBytes: 100_000, timeoutMs: 5000 },
  ]);
  assert.deepEqual(resolved, ['https://public.example/', 'https://destination.example/about']);
  assert.equal(result.finalUrl, 'https://destination.example/about');
});

test('website validation requires a readable page and treats blocked or failed reads as unconfirmed', async () => {
  const resolve = async () => ({ ok: true, addresses: ['203.0.113.8'] });
  for (const response of [
    { ...page(), status: 404 },
    { ...page(), headers: { 'content-type': 'application/json' } },
    { ...page(), headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' } },
    { ...page(), body: Buffer.from('<html><body><script>secret()</script></body></html>') },
  ]) {
    assert.equal((await validateCommunityWebsite('https://public.example/', { resolve, fetchGuarded: async () => response })).ok, false);
  }
  assert.equal((await validateCommunityWebsite('https://public.example/', { resolve, fetchGuarded: async () => { throw new Error('timeout'); } })).ok, false);
  const good = await validateCommunityWebsite('https://public.example/', { resolve, fetchGuarded: async () => page() });
  assert.equal(good.ok, true);
  assert.equal(good.value, 'https://public.example/');
});

test('unsafe website input is rejected before any network request', async () => {
  for (const input of ['https://u:p@public.example/', 'https://public.example:444/', 'https://public.example/?token=value']) {
    const result = await validateCommunityWebsite(input, { resolve: async () => { assert.fail('Unsafe input reached DNS'); } });
    assert.equal(result.ok, false);
  }
});
