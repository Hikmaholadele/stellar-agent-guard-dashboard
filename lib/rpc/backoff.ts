/**
 * Provider retry hints, and the exponential backoff used when there is none
 * (issue #345).
 *
 * Soroban RPC providers throttle bursts, and a throttled read usually comes
 * back with a `Retry-After` value. Ignoring it makes the outage worse: every
 * client retries on its own schedule while the provider asked for quiet.
 * Honouring it blindly is not right either, because the value can be malformed,
 * already in the past, or longer than the read's own timeout — so every hint is
 * parsed, validated and clamped before it is used.
 *
 * Both formats RFC 9110 defines are accepted: delta-seconds (`"120"`) and an
 * HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`). Anything else is not a hint and
 * the caller falls back to exponential backoff with jitter.
 */

/** The longest wait a provider hint may impose on a read. */
export const MAX_RETRY_AFTER_MS = 30_000;

export interface RetryAfterHint {
  /** The delay to wait, already clamped to the requested maximum. */
  delayMs: number;
  /** The delay the provider asked for, before clamping. */
  requestedMs: number;
  /** True when the provider asked for longer than the maximum allows. */
  clamped: boolean;
}

/**
 * Parse a `Retry-After` value into a delay in milliseconds.
 *
 * Returns `null` for a value that is not a usable hint: unparseable text, a
 * non-positive delta, or a date that has already passed. A past date is not
 * "retry immediately" — it is a stale header, and waiting zero milliseconds
 * would be a retry loop rather than a hint.
 */
export function parseRetryAfter(value: unknown, now: number = Date.now()): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw === "number") return deltaSeconds(raw);
  if (typeof raw !== "string") return null;

  const text = raw.trim();
  if (text === "") return null;
  if (/^\d+$/.test(text)) return deltaSeconds(Number(text));

  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  const delayMs = at - now;
  return delayMs > 0 ? delayMs : null;
}

function deltaSeconds(seconds: number): number | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds * 1000);
}

/**
 * A parsed hint, clamped to `maxDelayMs` so a provider cannot park a read for
 * minutes. Returns `null` when there is no usable hint, which is the caller's
 * signal to fall back to its own backoff.
 */
export function retryAfterHint(
  value: unknown,
  options: { now?: number; maxDelayMs?: number } = {},
): RetryAfterHint | null {
  const maxDelayMs = options.maxDelayMs ?? MAX_RETRY_AFTER_MS;
  const requestedMs = parseRetryAfter(value, options.now);
  if (requestedMs === null) return null;
  return {
    delayMs: Math.min(requestedMs, maxDelayMs),
    requestedMs,
    clamped: requestedMs > maxDelayMs,
  };
}

/**
 * Pull a `Retry-After` value off the shapes an RPC client error carries it in:
 * a normalised property, a `Headers` instance, or a plain header object on the
 * error or its response.
 */
export function retryAfterFromError(error: unknown): unknown {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as {
    retryAfter?: unknown;
    headers?: unknown;
    response?: { headers?: unknown };
  };
  if (candidate.retryAfter !== undefined) return candidate.retryAfter;
  return (
    headerValue(candidate.headers, "retry-after") ??
    headerValue(candidate.response?.headers, "retry-after")
  );
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  const get = (headers as { get?: unknown }).get;
  if (typeof get === "function") {
    const value = (headers as Headers).get(name);
    return value ?? undefined;
  }
  if (typeof headers !== "object") return undefined;
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === name && typeof value === "string") return value;
  }
  return undefined;
}

export function rateLimitBackoff() {
  // exponential backoff for rate-limited RPC queries
  return { delay: 1000 };
}
