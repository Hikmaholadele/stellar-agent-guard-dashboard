/**
 * Dead-man-switch expiration alerting.
 *
 * The switch itself lives on-chain: `status()` reports `last_heartbeat` and the
 * ledger's `now`, `policy()` reports `dms_grace_secs`, and the account refuses
 * agent activity once `last_heartbeat + dms_grace_secs` is behind the ledger
 * clock. This module is the dashboard's *proactive* layer over those three
 * numbers — it classifies how close the console is to that deadline so the UI
 * can escalate before the switch trips, rather than only reporting it after.
 *
 * Every calculation here reads the **ledger clock** (`status.now`), never
 * `Date.now()`. The switch is judged by ledger time on chain, so an operator's
 * skewed local clock must not be able to green-wash a late heartbeat or
 * cry-wolf an early one. The calendar estimate is one wall-clock translation,
 * and it is labelled an estimate because ledger close time tracks wall clock
 * only approximately; the freshness check (`countdownStale`) is the other —
 * it compares the read's own timestamp against the local clock to say how old
 * the read is, an age rather than a deadline.
 *
 * Thresholds (from the alerting spec):
 * - `warning` (yellow) when less than 25% of the grace remains, or less than
 *   one hour of absolute time remains — the acceptance criterion's "under 1
 *   hour or 20%" bar is fully covered, since 20% < 25%.
 * - `critical` (red, pulsing) when less than 10% of the grace remains.
 * - `expired` (dark red) once the deadline is reached or `status()` reports
 *   `heartbeat_expired`.
 *
 * The remaining-time formula mirrors the SDK's `deadManRemaining` exactly
 * (`last_heartbeat + dms_grace_secs - now`); it is recomputed here rather than
 * delegated because the alert layer needs the whole timeline — remaining,
 * elapsed, fraction, calendar expiry — from the same three fields in one pass.
 */

import type { GuardStatus, PolicyConfig } from "stellar-agent-guard-sdk";

/** Escalation tier of the dead-man-switch deadline alert. */
export type DmsAlertLevel = "none" | "warning" | "critical" | "expired";

/** Yellow below this fraction of the grace period (spec: warning < 25%). */
export const DMS_WARNING_FRACTION = 0.25;

/** Red-pulse below this fraction of the grace period (spec: critical < 10%). */
export const DMS_CRITICAL_FRACTION = 0.1;

/** Yellow below this absolute remaining time (acceptance: under 1 hour). */
export const DMS_WARNING_SECONDS = 3600;

/** Everything the banner needs to render, all derived from the ledger clock. */
export interface DmsAlert {
  /** Escalation tier; `"none"` means no banner is shown. */
  level: DmsAlertLevel;
  /**
   * `last_heartbeat + dms_grace_secs - now` in seconds — positive while the
   * agent is still inside its grace window, zero or negative once the deadline
   * is reached. `null` when the clock cannot run (no policy, switch disabled,
   * or the agent has never sent a heartbeat).
   */
  remainingSecs: number | null;
  /** The configured grace window (`dms_grace_secs`) in seconds. */
  totalSecs: number | null;
  /** `remainingSecs / totalSecs` — drives the percentage-based escalation. */
  fractionRemaining: number | null;
  /** `now - last_heartbeat` in seconds: how long since the last heartbeat. */
  elapsedSecs: number | null;
  /**
   * Estimated calendar expiration as a Unix-millisecond timestamp:
   * `(last_heartbeat + dms_grace_secs) * 1000`. Ledger close time tracks wall
   * clock, so this is an operator-facing estimate, not a guarantee.
   */
  expiresAtMs: number | null;
}

/** No alert, and no clock to run: the fields a banner would read are absent. */
function inertAlert(level: DmsAlertLevel): DmsAlert {
  return {
    level,
    remainingSecs: null,
    totalSecs: null,
    fractionRemaining: null,
    elapsedSecs: null,
    expiresAtMs: null,
  };
}

/**
 * Classify how close the guard's dead-man switch is to tripping, and compute
 * the timeline the alert banner displays.
 *
 * Accepts `null` for either read so the component can pass a failed read
 * straight through: a failed read yields no alert rather than a guessed one,
 * consistent with the console's "a failed read is not an empty policy" rule.
 */
export function evaluateDmsAlert(
  status: GuardStatus | null,
  policy: PolicyConfig | null,
): DmsAlert {
  if (!status) return inertAlert("none");

  // The switch has never been armed against a heartbeat it can compare to:
  // either the agent has never beaten (`last_heartbeat == 0`) or the operator
  // disabled it (`dms_grace_secs == 0`). Nothing is counting down.
  const heartbeatSecs = status.last_heartbeat;
  const graceSecs = policy?.dms_grace_secs ?? 0n;
  const clockRunning = heartbeatSecs !== 0n && graceSecs > 0n;

  // Elapsed time needs only the ledger's own two timestamps, so it survives a
  // failed policy read; the deadline fields below additionally need the grace.
  const elapsedSecs = heartbeatSecs !== 0n ? Number(status.now - heartbeatSecs) : null;

  let remainingSecs: number | null = null;
  let fractionRemaining: number | null = null;
  let expiresAtMs: number | null = null;
  if (clockRunning) {
    remainingSecs = Number(heartbeatSecs + graceSecs - status.now);
    fractionRemaining = remainingSecs / Number(graceSecs);
    expiresAtMs = Number((heartbeatSecs + graceSecs) * 1000n);
  }

  let level: DmsAlertLevel = "none";
  if (status.heartbeat_expired) {
    // `status()` is the chain's own verdict — authoritative even if the policy
    // read needed to reconstruct the countdown failed.
    level = "expired";
  } else if (remainingSecs !== null && fractionRemaining !== null) {
    if (remainingSecs <= 0) {
      level = "expired"; // deadline reached (or passed) on the ledger clock
    } else if (fractionRemaining < DMS_CRITICAL_FRACTION) {
      level = "critical";
    } else if (fractionRemaining < DMS_WARNING_FRACTION || remainingSecs < DMS_WARNING_SECONDS) {
      level = "warning";
    }
  }

  return {
    level,
    remainingSecs,
    totalSecs: clockRunning ? Number(graceSecs) : null,
    fractionRemaining,
    elapsedSecs,
    expiresAtMs,
  };
}

// ── Read freshness (issue #389) ───────────────────────────────────────────

/**
 * How old the ledger read behind a countdown may be before the UI presents
 * that countdown as *uncertain* rather than current.
 *
 * Four times the 15-second snapshot poll: one missed poll is normal jitter,
 * four is a stalled read — a throttled background tab, an RPC that stopped
 * answering after its last success — and a countdown drawn from it describes
 * the past, not the switch the contract will judge. The threshold marks the
 * point where the banner must say so instead of letting a stale figure read
 * as a live one.
 */
export const DMS_STALE_READ_MS = 60_000;

/**
 * Is the ledger read this countdown derives from too old to present as
 * current?
 *
 * `fetchedAtMs` is the read's own timestamp (the snapshot's `fetchedAt`);
 * `nowMs` is the local clock. The local clock is used only for the *age* of
 * the read — never for the deadline, which stays ledger-derived. Clock skew
 * is therefore bounded in the safe direction: a local clock that jumped
 * backwards makes the read look *fresher*, never staler, and an unparseable
 * timestamp is uncertainty (stale), not a free pass.
 */
export function countdownStale(fetchedAtMs: number, nowMs: number): boolean {
  if (!Number.isFinite(fetchedAtMs)) return true;
  return nowMs - fetchedAtMs >= DMS_STALE_READ_MS;
}

/**
 * Format seconds the way an operator reads a countdown: the two largest
 * units, largest first (`1d 3h`, `2h 15m`, `12m 4s`, `47s`). Negative input
 * clamps to `0s` — a duration display never speaks in minus signs.
 */
export function formatDmsDuration(totalSeconds: number): string {
  const secs = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(secs / 86_400);
  const hours = Math.floor((secs % 86_400) / 3_600);
  const minutes = Math.floor((secs % 3_600) / 60);
  const seconds = secs % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
