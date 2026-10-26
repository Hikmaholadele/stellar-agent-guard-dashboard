/**
 * Every chain-polling cadence in the console, in one place.
 *
 * The values below are the pre-centralization values, preserved exactly:
 * centralization is a reorganization, not a retune. If a cadence is ever
 * changed, change it here and cite the measurement or the RPC-load reason in
 * the commit — not at the call site.
 *
 * Defaults and their rationale:
 *
 * - `snapshotMs` (15s): the guard snapshot (status, policy, window) re-read.
 *   Slow enough to keep RPC load trivial, fast enough that a freeze made
 *   elsewhere shows up within a quarter minute.
 * - `feedMs` (5s): the telemetry feed poll. Matches the ledger close interval
 *   (~5s): polling faster cannot reveal events sooner, because Soroban has no
 *   push stream — SPEC §7's latency floor is the ledger, not the poll.
 * - `fleetMs` (5s): the fleet table's per-guard re-poll. Same ledger-close
 *   reasoning as `feedMs`.
 * - `demoEventMs` (4s): demo-mode synthetic event cadence. No RPC at all, so
 *   no load argument applies; it only sets how lively the fixture feed looks.
 * - `txInclusionMs` / `txInclusionAttempts` (2s × 30): the bounded
 *   post-broadcast poll for a submitted transaction's inclusion. Kept
 *   un-jittered on purpose: the operator has just signed and is waiting, so
 *   worst-case latency is bounded and predictable by design.
 */
export const POLLING = {
  snapshotMs: 15_000,
  feedMs: 5_000,
  fleetMs: 5_000,
  demoEventMs: 4_000,
  txInclusionMs: 2_000,
  txInclusionAttempts: 30,
} as const;

export type JitterMode = "full" | "none";

/**
 * De-synchronize pollers that share one RPC endpoint.
 *
 * Uniform in [0.8·I, I): the ceiling stays at the bare interval so the
 * worst-case staleness an operator sees is never worse than it was, while the
 * start phase of every timer is spread across the last fifth of the cycle.
 * An operator with two tabs open (or the fleet table plus the feed, which is
 * the same endpoint) no longer has every poller firing on the same tick —
 * the thundering-herd shape the SDK's jitter issue documents for agent fleets,
 * adapted to the dashboard's multi-tab reality. Jitter is applied once when a
 * timer is created, so each poller keeps a stable de-synchronized cadence
 * rather than re-rolling every tick.
 *
 * `mode: "none"` returns the interval unchanged, for callers (and tests) that
 * need the exact configured cadence.
 *
 * `rng` is injectable so tests can pin the distribution; production callers
 * use the default `Math.random`.
 */
export function jitteredInterval(
  intervalMs: number,
  mode: JitterMode = "full",
  rng: () => number = Math.random,
): number {
  if (mode === "none") return intervalMs;
  return Math.floor(intervalMs * (0.8 + rng() * 0.2));
}

/** Keep polling until the owning view unmounts, even when one read fails. */
export function startRefreshTimer(refresh: () => void, intervalMs: number): () => void {
  const timer = setInterval(refresh, intervalMs);
  return () => clearInterval(timer);
}
