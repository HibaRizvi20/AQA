import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { withRetry, mapLimit, isRetryable } from "./retry.mjs";

const noSleep = async () => {};

describe("what may be retried", () => {
  test("a transport failure is retryable — nothing was learned about the app", () => {
    assert.equal(isRetryable({ ok: false, error: "ECONNRESET" }), true);
    assert.equal(isRetryable({ ok: false, error: "timed out after 10000ms" }), true);
    assert.equal(isRetryable({ ok: false, error: "socket hang up" }), true);
  });

  test("an ANSWERED request is never retryable, whatever the status", () => {
    // This is the property that stops the framework from retrying a real defect into a pass.
    assert.equal(isRetryable({ ok: true, status: 500 }), false);
    assert.equal(isRetryable({ ok: true, status: 409 }), false);
    assert.equal(isRetryable({ ok: true, status: 200 }), false);
  });

  test("an unrecognised failure is not retried — retry is an allowlist", () => {
    assert.equal(isRetryable({ ok: false, error: "something odd" }), false);
  });
});

describe("withRetry", () => {
  test("returns immediately on a non-retryable result and records one attempt", async () => {
    let calls = 0;
    const r = await withRetry(async () => (calls++, { ok: true, status: 500 }), { sleepFn: noSleep });
    assert.equal(calls, 1);
    assert.equal(r.attempts, 1);
    assert.equal(r.retried, false);
  });

  test("retries a transport failure and records that it did", async () => {
    let calls = 0;
    const r = await withRetry(
      async () => (++calls < 3 ? { ok: false, error: "ECONNREFUSED" } : { ok: true, status: 200 }),
      { sleepFn: noSleep },
    );
    assert.equal(calls, 3);
    assert.equal(r.status, 200);
    assert.equal(r.attempts, 3);
    assert.equal(r.retried, true, "a pass on attempt 3 must not look like a pass on attempt 1");
  });

  test("gives up after the cap and says it exhausted", async () => {
    let calls = 0;
    const r = await withRetry(async () => (calls++, { ok: false, error: "ETIMEDOUT" }), { attempts: 3, sleepFn: noSleep });
    assert.equal(calls, 3);
    assert.equal(r.exhausted, true);
    assert.equal(r.ok, false);
  });

  test("backs off exponentially with jitter, bounded by maxMs", async () => {
    const waits = [];
    await withRetry(async () => ({ ok: false, error: "ECONNRESET" }), {
      attempts: 5,
      baseMs: 100,
      maxMs: 400,
      random: () => 1, // full jitter at its ceiling, so the ceiling itself is observable
      sleepFn: async (ms) => waits.push(ms),
    });
    assert.deepEqual(waits, [100, 200, 400, 400], "doubles, then holds at the cap");
  });

  test("jitter actually varies the delay", async () => {
    const waits = [];
    await withRetry(async () => ({ ok: false, error: "ECONNRESET" }), {
      attempts: 3, baseMs: 1000, random: () => 0.25, sleepFn: async (ms) => waits.push(ms),
    });
    assert.deepEqual(waits, [250, 500]);
  });
});

describe("mapLimit", () => {
  test("preserves input order regardless of completion order", async () => {
    const out = await mapLimit([30, 10, 20, 0], 2, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    assert.deepEqual(out, [30, 10, 20, 0]);
  });

  test("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    assert.ok(peak <= 4, `peak concurrency was ${peak}`);
    assert.ok(peak > 1, "and it did run in parallel");
  });

  test("handles an empty list and a limit larger than the list", async () => {
    assert.deepEqual(await mapLimit([], 4, async (x) => x), []);
    assert.deepEqual(await mapLimit([1, 2], 99, async (x) => x * 2), [2, 4]);
  });

  test("a limit of 1 is strictly sequential", async () => {
    const order = [];
    await mapLimit([3, 1, 2], 1, async (n) => {
      order.push(`start${n}`);
      await new Promise((r) => setTimeout(r, n));
      order.push(`end${n}`);
    });
    assert.deepEqual(order, ["start3", "end3", "start1", "end1", "start2", "end2"]);
  });
});
