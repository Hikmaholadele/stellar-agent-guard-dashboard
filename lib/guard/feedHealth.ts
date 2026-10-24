/**
 * Poll health — the feed's own liveness, kept apart from its traffic.
 *
 * Issue #311. The distinction this module exists to enforce: **no events** and
 * **no connection** are different operational states, and a feed that reports
 * them with the same number teaches the operator to distrust it. A healthy poll
 * of a quiet guard legitimately shows an empty table; a poll that has not landed
 * for two minutes shows an empty table too, and only one of those means the
 * telemetry endpoint is unreachable.
 *
 * So the inputs are read as three independent axes, never collapsed into a
 * single "last activity" field:
 *
 *   1. **the last round that completed successfully** (`lastSuccessAt`), written
 *      only when a poll returned — including when it returned nothing;
 *   2. **whether a round is in flight right now** (`polling`);
 *   3. **the most recent failure** (`error` + `lastFailureAt`).
 *
 * A timestamp written on the failure path would be an *attempt*, not a success,
 * which is why `lastAttemptAt` is carried separately and only ever used to date
 * the failure — never to satisfy the "last successful poll" clause.
 *
 * Recovery is part of the contract: after a failed round, one successful poll
 * moves the phase back to `healthy` even if it delivers zero events. The tests
 * pin that, because "the endpoint came back" must be visible without an event
 * having to arrive for the feed to look alive again.
 *
 * Nothing here reads the chain, and nothing here touches a cursor: this is a
 * reading of state the caller already has, so it can be exercised without RPC.
 */

import { formatTimeAgo } from "./time.ts";

/** How many poll intervals of silence make a watching feed overdue. */
export const OVERDUE_INTERVALS = 3;

/**
 * `off`        — not watching; nothing is being polled.
 * `pending`    — watching, and no round has completed successfully yet.
 * `healthy`    — a round completed within the overdue window.
 * `failing`    — the most recent round failed; later than the last success.
 * `overdue`    — watching, but no successful round has landed inside the window.
 */
export type PollPhase = "off" | "pending" | "healthy" | "failing" | "overdue";

export interface PollHealthInput {
  watching: boolean;
  /** A round is currently in flight. */
  polling: boolean;
  /** ISO time of the last round that returned. Never written on failure. */
  lastSuccessAt: string | null;
  /** ISO time of the last round that was attempted, success or not. */
  lastAttemptAt: string | null;
  /** ISO time of the last round that failed, if any. */
  lastFailureAt: string | null;
  /** The most recent poll error's text, or null when the last round succeeded. */
  error: string | null;
  /** Events delivered by the last successful round. May legitimately be 0. */
  eventsInLastRound: number;
  /** Clock to evaluate against, in ms. A parameter so tests can pin it. */
  nowMs: number;
  /** The configured poll interval, in ms. */
  intervalMs: number;
  /** Overrides the default `intervalMs * OVERDUE_INTERVALS` window. */
  overdueAfterMs?: number;
}

export interface PollHealth {
  phase: PollPhase;
  /** True when a round is in flight, independent of phase. */
  polling: boolean;
  /** ISO time of the last successful round, passed through for display. */
  lastSuccessAt: string | null;
  /** ISO time of the last failed round, passed through for display. */
  lastFailureAt: string | null;
  error: string | null;
  /** How long an empty success is still considered normal, in ms. */
  overdueAfterMs: number;
  /** A sentence for the feed header, written to be read aloud. */
  text: string;
  /** The pill class matching the phase: never `ok` for a failing or overdue feed. */
  tone: "ok" | "warn" | "danger" | "muted";
  /**
   * Whether the table's emptiness is explained. `false` when the feed is merely
   * quiet (healthy, zero events) — the UI must not imply a fault there.
   */
  emptyIsFault: boolean;
}

/** Parse an ISO stamp to ms, tolerating a malformed stored value. */
function toMs(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** The wording used whenever a feed is not watching, shared by both producers. */
export const POLL_OFF_TEXT = "Not watching this feed. No events are being polled.";

/**
 * "5s ago", "2m ago" — or "just now".
 *
 * `formatTimeAgo` already spells the sub-ten-second case as the phrase "just
 * now", so appending " ago" to it produces "just now ago". The rounding is the
 * helper's; only the suffix is guarded here, because every sentence below reads
 * better without a second copy of that rule.
 */
function sinceWords(thenMs: number, nowMs: number): string {
  const phrase = formatTimeAgo(Math.floor(thenMs / 1000), Math.floor(nowMs / 1000));
  return phrase === "just now" ? "just now" : `${phrase} ago`;
}

/**
 * The health of a feed that is not polling: the initial client state and the
 * server render, where no clock applies. Exported so a caller that has no poll
 * state yet says the same thing the evaluator would, instead of inventing one.
 */
export const POLL_OFF: PollHealth = {
  phase: "off",
  polling: false,
  lastSuccessAt: null,
  lastFailureAt: null,
  error: null,
  overdueAfterMs: 0,
  text: POLL_OFF_TEXT,
  tone: "muted",
  emptyIsFault: false,
};

/**
 * Evaluate one feed's liveness from the state the provider already holds.
 *
 * The precedence is deliberate: a failure outranks staleness (an error we have
 * is more informative than an absence we inferred), and a success newer than the
 * failure outranks the failure — that is the recovery case. `overdue` is only
 * reached while watching, because a stopped feed is not late, it is stopped.
 */
export function pollHealth(input: PollHealthInput): PollHealth {
  const overdueAfterMs = input.overdueAfterMs ?? Math.max(input.intervalMs, 1) * OVERDUE_INTERVALS;
  const successMs = toMs(input.lastSuccessAt);
  const failureMs = toMs(input.lastFailureAt);

  const base = {
    polling: input.polling,
    lastSuccessAt: input.lastSuccessAt,
    lastFailureAt: input.lastFailureAt,
    error: input.error,
    overdueAfterMs,
  };

  if (!input.watching) {
    return {
      ...base,
      phase: "off",
      tone: "muted",
      emptyIsFault: false,
      text: POLL_OFF_TEXT,
    };
  }

  const failedAfterSuccess = failureMs !== null && (successMs === null || failureMs >= successMs);

  if (failedAfterSuccess) {
    const since = failureMs === null ? "" : ` ${sinceWords(failureMs, input.nowMs)}`;
    return {
      ...base,
      phase: "failing",
      tone: "danger",
      emptyIsFault: true,
      text:
        `The last poll failed${since}. Events stopped arriving when it did — an empty table ` +
        `here reflects the failed poll, not a quiet guard.`,
    };
  }

  if (successMs === null) {
    return {
      ...base,
      phase: "pending",
      tone: input.polling ? "warn" : "muted",
      emptyIsFault: false,
      text: input.polling
        ? "Waiting for the first poll to return."
        : "Watching, but no poll has completed yet.",
    };
  }

  const ageMs = input.nowMs - successMs;
  if (ageMs > overdueAfterMs) {
    const since = formatTimeAgo(Math.floor(successMs / 1000), Math.floor(input.nowMs / 1000));
    return {
      ...base,
      phase: "overdue",
      tone: "warn",
      emptyIsFault: true,
      text: input.polling
        ? `No poll has landed for ${since}; one is currently in flight. The feed may be behind.`
        : `No poll has landed for ${since}, and none is in flight. The feed is not updating.`,
    };
  }

  const since = sinceWords(successMs, input.nowMs);
  return {
    ...base,
    phase: "healthy",
    tone: "ok",
    emptyIsFault: false,
    text:
      input.eventsInLastRound > 0
        ? `Last successful poll ${since}; ${input.eventsInLastRound} event(s) in that round.`
        : `Last successful poll ${since}. That round returned no events, which is normal for a quiet guard.`,
  };
}
