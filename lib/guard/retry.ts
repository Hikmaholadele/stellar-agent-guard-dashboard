import { MAX_RETRY_AFTER_MS, retryAfterFromError, retryAfterHint } from "../rpc/backoff.ts";

export class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableError";
  }
}

/** One retry wait, described for whoever needs to tell the operator about it. */
export interface RetryWait {
  /** Zero-based retry number that is about to be attempted. */
  attempt: number;
  /** How long the wait will be, after clamping and (for backoff) jitter. */
  delayMs: number;
  /** Where the delay came from: the provider's hint or this client's backoff. */
  source: "retry-after" | "backoff";
  /** The provider's unclamped request, when it sent a hint. */
  requestedMs: number | null;
  /** True when the provider asked for longer than the clamp allows. */
  clamped: boolean;
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /**
   * Ceiling for a provider `Retry-After` hint. Deliberately separate from
   * `maxDelayMs`: exponential backoff and a provider's requested quiet period
   * are different promises, and only the latter is clamped here.
   */
  maxRetryAfterMs?: number;
  /**
   * Called with each wait before it starts, so a caller can show the operator
   * why the read is paused and for how long.
   */
  onWait?: (wait: RetryWait) => void;
  /** Cancels a pending wait and stops further retries. */
  signal?: AbortSignal;
}

export async function withBackoff<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 8000;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? MAX_RETRY_AFTER_MS;

  let attempt = 0;
  while (true) {
    options.signal?.throwIfAborted();
    try {
      const result = await operation();
      return result;
    } catch (error: any) {
      if (attempt >= maxRetries) {
        throw error;
      }

      const isRetryable =
        error instanceof RetryableError ||
        error.message?.includes("TIMEOUT") ||
        error.message?.includes("TRY_AGAIN_LATER") ||
        error.message?.includes("NOT_FOUND") ||
        error.message?.includes("429");

      if (!isRetryable) {
        throw error;
      }

      const wait = retryWait(error, attempt, {
        baseDelayMs,
        maxDelayMs,
        maxRetryAfterMs,
      });
      options.onWait?.(wait);
      await waitFor(wait.delayMs, options.signal);
      attempt++;
    }
  }
}

/**
 * The next wait: the provider's hint when this is a rate-limited read and the
 * hint is usable, otherwise the client's own capped, jittered backoff.
 *
 * A hint is honoured only for rate-limit signals. A `Retry-After` attached to a
 * timeout or a not-found error says nothing about that failure, so applying it
 * there would turn an unrelated header into an extra wait.
 */
function retryWait(
  error: any,
  attempt: number,
  limits: { baseDelayMs: number; maxDelayMs: number; maxRetryAfterMs: number },
): RetryWait {
  if (isRateLimited(error)) {
    const hint = retryAfterHint(retryAfterFromError(error), {
      maxDelayMs: limits.maxRetryAfterMs,
    });
    if (hint) {
      return {
        attempt,
        delayMs: hint.delayMs,
        source: "retry-after",
        requestedMs: hint.requestedMs,
        clamped: hint.clamped,
      };
    }
  }

  const delay = Math.min(limits.maxDelayMs, limits.baseDelayMs * Math.pow(2, attempt));
  // Jitter is drawn from the current delay so retries from a fleet do not
  // arrive together; it never exceeds the ceiling above.
  return {
    attempt,
    delayMs: Math.random() * delay,
    source: "backoff",
    requestedMs: null,
    clamped: false,
  };
}

function isRateLimited(error: any): boolean {
  const message = typeof error?.message === "string" ? error.message : "";
  return (
    error?.status === 429 ||
    error?.statusCode === 429 ||
    /\b429\b/.test(message) ||
    /TRY_AGAIN_LATER/i.test(message) ||
    /rate.?limit/i.test(message)
  );
}

/**
 * Wait, but stop immediately if the caller's signal aborts. Rejecting with the
 * signal's own reason keeps cancellation and timeout behaviour identical to the
 * rest of the read path, instead of swallowing the abort and retrying on.
 */
function waitFor(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(id);
      reject(signal.reason);
    };
    const id = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
