import assert from "node:assert/strict";
import { test } from "node:test";
import { RetryableError, withBackoff, type RetryWait } from "../../lib/guard/retry.ts";
import { MAX_RETRY_AFTER_MS, parseRetryAfter } from "../../lib/rpc/backoff.ts";

/**
 * Runs `operation` with `setTimeout` and `Math.random` stubbed so the backoff
 * delays can be captured without actually waiting, and with jitter made
 * deterministic.
 */
async function captureDelays(random: number, operation: () => Promise<unknown>): Promise<number[]> {
  const delays: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const realRandom = Math.random;

  Math.random = () => random;
  globalThis.setTimeout = ((handler: () => void, timeout?: number) => {
    delays.push(timeout ?? 0);
    return realSetTimeout(handler, 0);
  }) as typeof setTimeout;

  try {
    await operation();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    Math.random = realRandom;
  }

  return delays;
}

test("retries retryable failures with an exponentially growing delay", async () => {
  let calls = 0;
  const delays = await captureDelays(1, () =>
    withBackoff(
      async () => {
        calls += 1;
        if (calls < 3) throw new RetryableError("RPC TIMEOUT");
        return "ok";
      },
      { maxRetries: 5, baseDelayMs: 500, maxDelayMs: 8000 },
    ),
  );

  // With Math.random() === 1 the jitter equals the whole computed delay.
  assert.deepEqual(delays, [500, 1000], "each retry doubles the previous delay");
  assert.equal(calls, 3);
});

test("applies jitter drawn from the current delay", async () => {
  let calls = 0;
  const delays = await captureDelays(0.25, () =>
    withBackoff(
      async () => {
        calls += 1;
        if (calls < 2) throw new RetryableError("TRY_AGAIN_LATER");
        return calls;
      },
      { maxRetries: 3, baseDelayMs: 400 },
    ),
  );

  assert.deepEqual(delays, [100], "jitter is 0.25 × the 400 ms base delay");
});

test("does not retry or wait on a non-retryable error", async () => {
  let calls = 0;
  let scheduled = 0;
  const realSetTimeout = globalThis.setTimeout;

  globalThis.setTimeout = ((handler: () => void, timeout?: number) => {
    scheduled += 1;
    return realSetTimeout(handler, timeout);
  }) as typeof setTimeout;

  try {
    await assert.rejects(
      () =>
        withBackoff(
          async () => {
            calls += 1;
            throw new Error("Invalid contract id");
          },
          { maxRetries: 5, baseDelayMs: 10 },
        ),
      /Invalid contract id/,
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }

  assert.equal(calls, 1, "the operation is attempted once");
  assert.equal(scheduled, 0, "no retry delay is scheduled");
});

test("rethrows after exhausting maxRetries", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withBackoff(
        async () => {
          calls += 1;
          throw new RetryableError("NOT_FOUND");
        },
        { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 4 },
      ),
    /NOT_FOUND/,
  );
  assert.equal(calls, 3, "one initial attempt plus maxRetries retries");
});

// ── Provider retry hints (#345) ────────────────────────────────────────────

/** A rate-limited RPC failure, shaped the way the SDK surfaces it. */
function rateLimited(headers: Record<string, string>): Error {
  const error = new Error("RPC responded 429 Too Many Requests") as Error & {
    status: number;
    headers: Record<string, string>;
  };
  error.status = 429;
  error.headers = headers;
  return error;
}

/** Runs a read that fails once with `failure`, capturing the waits it took. */
async function captureHintDelays(
  failure: Error,
  options: { maxRetries?: number; baseDelayMs?: number; maxRetryAfterMs?: number } = {},
): Promise<number[]> {
  let calls = 0;
  return captureDelays(1, () =>
    withBackoff(
      async () => {
        calls += 1;
        if (calls === 1) throw failure;
        return "ok";
      },
      { baseDelayMs: 400, ...options },
    ),
  );
}

test("parses both supported Retry-After formats and rejects the rest", () => {
  const now = Date.parse("2026-10-21T08:00:00Z");
  assert.equal(parseRetryAfter("7", now), 7000, "delta-seconds");
  assert.equal(parseRetryAfter(7, now), 7000, "a numeric delta");
  assert.equal(
    parseRetryAfter("Wed, 21 Oct 2026 08:00:05 GMT", now),
    5000,
    "an HTTP-date is measured from now",
  );
  assert.equal(parseRetryAfter("soon", now), null, "malformed text is not a hint");
  assert.equal(parseRetryAfter("Wed, 21 Oct 2026 07:59:00 GMT", now), null, "a past date is stale");
  assert.equal(parseRetryAfter("0", now), null, "a zero delta would be a retry loop, not a wait");
  assert.equal(parseRetryAfter(undefined, now), null);
});

test("honours a delta-seconds hint for a rate-limited read", async () => {
  const delays = await captureHintDelays(rateLimited({ "retry-after": "7" }));
  assert.deepEqual(delays, [7000], "the provider's wait replaces the client's backoff");
});

test("honours an HTTP-date hint", async () => {
  const retryAt = new Date(Date.now() + 5000).toUTCString();
  const delays = await captureHintDelays(rateLimited({ "retry-after": retryAt }), {
    maxRetryAfterMs: 60_000,
  });
  assert.equal(delays.length, 1);
  const first = delays[0];
  assert.ok(first !== undefined, "one wait was captured");
  assert.ok(first > 3000 && first <= 5000, `the wait should be about five seconds, got ${first}`);
});

test("clamps an excessive hint to the documented maximum", async () => {
  const delays = await captureHintDelays(rateLimited({ "retry-after": "3600" }));
  assert.deepEqual(delays, [MAX_RETRY_AFTER_MS], "an hour becomes the 30 s ceiling");

  const waits: RetryWait[] = [];
  await captureDelays(1, () =>
    withBackoff(
      async () => {
        throw rateLimited({ "retry-after": "3600" });
      },
      { maxRetries: 1, maxRetryAfterMs: 2000, onWait: (wait) => waits.push(wait) },
    ).catch(() => undefined),
  );
  assert.equal(waits[0]?.delayMs, 2000, "a caller can lower the ceiling");
  assert.equal(waits[0]?.requestedMs, 3_600_000);
  assert.equal(waits[0]?.clamped, true);
});

test("ignores malformed and past hints, falling back to backoff", async () => {
  assert.deepEqual(await captureHintDelays(rateLimited({ "retry-after": "soon" })), [400]);
  const past = new Date(Date.now() - 60_000).toUTCString();
  assert.deepEqual(await captureHintDelays(rateLimited({ "retry-after": past })), [400]);
});

test("applies a hint only to rate-limited failures", async () => {
  const timeout = new Error("RPC TIMEOUT") as Error & { headers: Record<string, string> };
  timeout.headers = { "retry-after": "7" };
  assert.deepEqual(
    await captureHintDelays(timeout),
    [400],
    "a Retry-After on a timeout is not a hint about that timeout",
  );
});

test("reports each wait so the operator can be told why the read paused", async () => {
  const waits: RetryWait[] = [];
  await captureDelays(1, () =>
    withBackoff(
      async () => {
        if (waits.length === 0) throw rateLimited({ "retry-after": "3" });
        return "ok";
      },
      { maxRetries: 2, onWait: (wait) => waits.push(wait) },
    ),
  );
  assert.deepEqual(waits, [
    { attempt: 0, delayMs: 3000, source: "retry-after", requestedMs: 3000, clamped: false },
  ]);
});

test("a cancellation aborts a pending wait instead of retrying", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    () =>
      withBackoff(
        async () => {
          calls += 1;
          throw rateLimited({ "retry-after": "5" });
        },
        { maxRetries: 3, onWait: () => controller.abort(), signal: controller.signal },
      ),
    /abort/i,
  );
  assert.equal(calls, 1, "no further attempt is made after cancellation");
});
