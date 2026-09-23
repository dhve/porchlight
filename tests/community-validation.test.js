import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCommunityWebsite, validateCommunityContact } from '../server/communityValidation.js';

const page = () => ({ ok: true, status: 200, contentType: 'text/html; charset=utf-8', headers: new Headers(), challenge: false,
  text: async () => '<html><title>A local business</title><body>Opening hours and how to contact us.</body></html>', discard() {} });
const emailUser = { id: 'owner', email: 'owner@example.test', emailVerified: true };

test('a public contact email requires this account confirmed inbox, not just valid syntax', async () => {
  assert.deepEqual(await validateCommunityContact('OWNER@example.test', emailUser), { ok: true, value: 'owner@example.test' });
  assert.equal((await validateCommunityContact('other@example.test', emailUser)).ok, false);
  assert.equal((await validateCommunityContact(emailUser.email, { ...emailUser, emailVerified: false })).ok, false);
  assert.equal((await validateCommunityContact(emailUser.email, null)).ok, false);
});

test('website validation checks every redirect before making a request', async () => {
  const requests = [];
  const result = await validateCommunityWebsite('https://public.example/', {
    resolve: async url => ({ ok: url.hostname === 'public.example' }),
    makeClient: () => ({ get: async (url, options) => {
      requests.push(url);
      assert.equal(options.redirect, 'manual');
      return { ...page(), ok: false, status: 302, headers: new Headers({ location: 'http://127.0.0.1/private' }) };
    } }),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(requests, ['https://public.example/'], 'Private redirect destination must never receive a request');
});

test('website validation requires a readable page and treats blocked or failed reads as unconfirmed', async () => {
  const resolve = async () => ({ ok: true });
  for (const response of [
    { ...page(), status: 404, ok: false },
    { ...page(), contentType: 'application/json' },
    { ...page(), challenge: true },
    { ...page(), text: async () => '<html><body><script>secret()</script></body></html>' },
    { ...page(), text: async () => { throw new Error('timeout'); } },
  ]) {
    assert.equal((await validateCommunityWebsite('https://public.example/', { resolve, makeClient: () => ({ get: async () => response }) })).ok, false);
  }
  const good = await validateCommunityWebsite('https://public.example/', { resolve, makeClient: () => ({ get: async () => page() }) });
  assert.equal(good.ok, true);
  assert.equal(good.value, 'https://public.example/');
});

test('unsafe website input is rejected before any network request', async () => {
  for (const input of ['https://u:p@public.example/', 'https://public.example:444/', 'https://public.example/?token=value']) {
    const result = await validateCommunityWebsite(input, { resolve: async () => { assert.fail('Unsafe input reached DNS'); } });
    assert.equal(result.ok, false);
  }
});
