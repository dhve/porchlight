import test from 'node:test';
import assert from 'node:assert/strict';
import { chatJSON } from '../server/llm.js';

const response = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const success = () => response(200, { choices: [{ message: { content: '{"ok":true}' } }] });
function delayed(signal, delay, result) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Request aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(result()); }, delay);
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}
test.beforeEach(t => {
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'fixture-only-key';
  t.after(() => { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; });
});

test('a bounded AI review aborts its provider request at the requested deadline', async t => {
  t.mock.method(globalThis, 'fetch', (_url, options) => delayed(options.signal, 120, success));
  await assert.rejects(chatJSON({ system: 'Review evidence', user: 'Fixture', timeoutMs: 20 }), { name: 'AbortError' });
});

test('temperature fallback shares the original deadline rather than starting a second budget', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', (_url, options) => {
    calls++;
    return calls === 1
      ? delayed(options.signal, 45, () => response(400, { error: 'temperature is unsupported' }))
      : delayed(options.signal, 45, success);
  });
  await assert.rejects(chatJSON({ system: 'Review evidence', user: 'Fixture', timeoutMs: 75 }), { name: 'AbortError' });
  assert.equal(calls, 2);
});

test('a successful bounded call preserves image content parts and returns parsed JSON', async t => {
  const content = [{ type: 'text', text: 'Classify this fixture' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body).messages[1].content, content);
    return success();
  });
  assert.deepEqual(await chatJSON({ system: 'Fixture', user: content, timeoutMs: 1000 }), { ok: true });
});
