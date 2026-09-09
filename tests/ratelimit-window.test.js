import test from "node:test";
import assert from "node:assert/strict";

test("hourly cleanup preserves account events for their full rolling day", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
  const { consume, remaining } = await import("../server/ratelimit.js?privacy-window-test");
  const day = 24 * 60 * 60_000;
  for (let i = 0; i < 30; i++) assert.equal(consume("account-day", "fixture", 30, day).ok, true);
  assert.equal(consume("account-day", "fixture", 30, day).ok, false);
  t.mock.timers.tick(65 * 60_000);
  assert.equal(remaining("account-day", "fixture", 30, day), 0);
  assert.equal(consume("account-day", "fixture", 30, day).ok, false);
  t.mock.timers.tick(day - 65 * 60_000);
  assert.equal(consume("account-day", "fixture", 30, day).ok, true, "The event expires at the end of the rolling window");
});

test("short windows expire at their boundary without waiting for cleanup", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
  const { consume } = await import("../server/ratelimit.js?privacy-short-window-test");
  assert.equal(consume("short", "fixture", 1, 1000).ok, true);
  assert.equal(consume("short", "fixture", 1, 1000).retryAfterMs, 1000);
  t.mock.timers.tick(999);
  assert.equal(consume("short", "fixture", 1, 1000).ok, false);
  t.mock.timers.tick(1);
  assert.equal(consume("short", "fixture", 1, 1000).ok, true);
});
