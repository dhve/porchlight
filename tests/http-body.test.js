import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../server/lib/http.js";

test("a limited body read stops and cancels instead of consuming the complete response", async (t) => {
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) { pulled++; controller.enqueue(new TextEncoder().encode("abcd")); if (pulled === 20) controller.close(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  t.mock.method(globalThis, "fetch", async () => new Response(body));
  const response = await createClient().get("https://fixture.example/file");
  assert.equal(await response.text(6), "abcdab");
  assert.equal(pulled, 2, "Only the chunks needed to reach the limit should be requested");
  assert.equal(cancelled, true);
});

test("a zero-byte body read cancels without pulling bytes", async (t) => {
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream({ pull(controller) { pulled++; controller.enqueue(new Uint8Array(5)); controller.close(); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  t.mock.method(globalThis, "fetch", async () => new Response(body));
  assert.equal(await (await createClient().get("https://fixture.example/file")).text(0), "");
  assert.equal(pulled, 0);
  assert.equal(cancelled, true);
});

test("a complete short UTF-8 body remains intact and discard cancels an unread body", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("café"));
  assert.equal(await (await createClient().get("https://fixture.example/page")).text(100), "café");
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }, { highWaterMark: 0 })));
  (await createClient().get("https://fixture.example/unread")).discard();
  await Promise.resolve();
  assert.equal(cancelled, true);
});

test("the request deadline remains active while reading the response body", async (t) => {
  let aborted = false;
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      signal.addEventListener("abort", () => { aborted = true; controller.error(new Error("aborted")); }, { once: true });
      setTimeout(() => { if (!aborted) controller.close(); }, 80);
    },
  })));
  const response = await createClient().get("https://fixture.example/slow", { timeoutMs: 20 });
  await assert.rejects(response.text(100), (err) => err.code === "TIMEOUT");
  assert.equal(aborted, true);
});
