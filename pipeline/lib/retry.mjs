// Retry and bounded concurrency.
//
// The hard part of retrying in a TEST tool is knowing what you are allowed to retry. Retrying a
// real failure until it passes is how a suite starts lying — it turns a genuine defect into a
// flake and hides it. So the rule here is narrow and deliberate:
//
//   RETRY:      transport failures — the request never got an answer (connection refused, reset,
//               DNS, timeout). Nothing was learned about the app, so asking again is not a
//               second opinion, it is a first one.
//
//   NEVER RETRY: any answered request. A 500 is a result. A 409 is a result. If the app answered,
//               the answer is the evidence, and repeating the call until a different answer
//               arrives is precisely the behaviour this framework exists to refuse.
//
// A retried probe records its attempts in the artifact, so "passed on attempt 3" is visible
// rather than indistinguishable from "passed".

/** Transport-level failures worth another attempt. */
const RETRYABLE = /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|timed out/i;

export const isRetryable = (result) =>
  result != null && result.ok === false && RETRYABLE.test(String(result.error ?? ""));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` until it returns a non-retryable result, or attempts run out.
 * Returns { ...lastResult, attempts, retried } — the shape is the caller's, plus the record.
 *
 * Backoff is exponential with full jitter: a flapping dependency should not be hit by every
 * worker on the same schedule.
 */
export async function withRetry(fn, { attempts = 3, baseMs = 120, maxMs = 2000, sleepFn = sleep, random = Math.random } = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await fn(attempt);
    if (!isRetryable(last)) {
      return { ...last, attempts: attempt, retried: attempt > 1 };
    }
    if (attempt < attempts) {
      const ceiling = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      await sleepFn(Math.round(random() * ceiling));
    }
  }
  return { ...last, attempts, retried: attempts > 1, exhausted: true };
}

/**
 * Map over items with at most `limit` in flight, preserving input order in the output.
 *
 * Probes are IO-bound, so running them one at a time makes a real suite unusably slow; running
 * them all at once turns the tool into a load test of the app under test, which changes the very
 * timings the performance track is trying to measure. Bounded is the only correct answer.
 */
export async function mapLimit(items, limit, fn) {
  const list = [...items];
  const out = new Array(list.length);
  const width = Math.max(1, Math.min(limit | 0 || 1, list.length || 1));
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      out[i] = await fn(list[i], i);
    }
  }

  await Promise.all(Array.from({ length: width }, worker));
  return out;
}
