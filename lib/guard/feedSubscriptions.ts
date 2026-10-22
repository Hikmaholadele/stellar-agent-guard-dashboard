/**
 * Per-guard feed subscriptions — the multi-guard live tail.
 *
 * Issue #23's scope decision was option (a): one merged feed, with a
 * guard-attribution chip on every row. The SDK's telemetry listener is a
 * single-guard reader (`GuardTelemetryListener` filters server-side by contract
 * id), so tailing N guards means N listener instances and therefore N poll
 * loops. This module owns that fan-out, and the two things that make it safe:
 *
 *   1. **A hard cap.** Poll load scales linearly with the number of monitored
 *      guards, so the supervisor only ever runs `cap` listeners. Guards past the
 *      cap are reported (never silently dropped) so the UI can say plainly how
 *      many are not being tailed. See the README's poll-load clause.
 *   2. **Reconciliation, not accumulation.** `sync()` is the single mutation
 *      point: it diffs the desired registry against the running listeners,
 *      stops and removes the ones that are gone, and starts the ones that are
 *      new. Repeated registry mutations therefore leave exactly
 *      `current-registry-size` listeners behind — there is no growth path.
 *
 * Nothing here reads the chain by itself: it is handed a factory, so the same
 * class is exercised by the browser (real `GuardFeed` instances) and by the
 * unit tests (deterministic mock streams) without a network.
 */

import type { GuardEvent } from "stellar-agent-guard-sdk";
import type { FeedGap, FeedGapState } from "./telemetry.ts";

/**
 * The displayed cap on simultaneously tailed guards.
 *
 * Chosen as a small, honest number rather than an unbounded fan-out: each guard
 * is one more `getEvents` poll loop, so the cap is the point at which the
 * console says "add a guard to watch, but this one is not being tailed" instead
 * of quietly multiplying RPC load. The README documents that trade-off.
 */
export const FEED_GUARD_CAP = 5;

/** One guard to tail, with the label the registry knows it by. */
export interface FeedSource {
  guard: string;
  label: string;
}

/** The shape `GuardFeed` satisfies, narrowed so tests can supply a mock stream. */
export interface GuardFeedLike {
  readonly guard: string;
  pollOnce(limit?: number): Promise<{
    events: GuardEvent[];
    cursor: string;
    latestLedger: number;
    /** Holes in coverage this runner knows about; absent for runners that cannot tell. */
    gaps?: FeedGapState;
  }>;
  /** Release the runner. Absent on some runners; called when one is reconciled away. */
  stop?(): void;
}

/** A per-guard poll outcome, so one guard's RPC failure cannot blank the others. */
export interface FeedWatchStatus {
  guard: string;
  label: string;
  ok: boolean;
  error: string | null;
  latestLedger: number | null;
  /**
   * Holes in this guard's coverage. Kept from the last poll that reported them
   * when a later poll fails, so a transport error does not make a known gap
   * disappear from the screen.
   */
  gaps: FeedGapState | null;
}

/** One guard's coverage warning, ready to render. */
export interface FeedGapNotice {
  guard: string;
  label: string;
  /** Unrecoverable ranges. */
  lost: FeedGap[];
  /** A discontinuity from the latest poll that the next clean poll clears. */
  unsettled: FeedGap | null;
}

/** The guards that currently have something to warn about, in tailing order. */
export function feedGapNotices(watch: readonly FeedWatchStatus[]): FeedGapNotice[] {
  const notices: FeedGapNotice[] = [];
  for (const entry of watch) {
    const gaps = entry.gaps;
    if (!gaps || (gaps.lost.length === 0 && gaps.unsettled === null)) continue;
    notices.push({
      guard: entry.guard,
      label: entry.label,
      lost: gaps.lost,
      unsettled: gaps.unsettled,
    });
  }
  return notices;
}

export interface FeedPollResult {
  /** Events from every tailed guard, newest-first across guards. */
  events: GuardEvent[];
  /** The highest ledger any tailed stream has reached, for the header. */
  latestLedger: number | null;
  /** One entry per tailed guard, carrying its own success or failure. */
  watch: FeedWatchStatus[];
}

export interface MultiGuardFeedOptions {
  /** Defaults to `FEED_GUARD_CAP`. Pass 0 to tail nothing (used by tests). */
  cap?: number;
  /** Builds the runner for one guard. Called at most once per live subscription. */
  createFeed: (guard: string) => GuardFeedLike;
}

export class MultiGuardFeed {
  readonly cap: number;
  private readonly createFeed: (guard: string) => GuardFeedLike;
  private readonly runners = new Map<string, GuardFeedLike>();
  private readonly labels = new Map<string, string>();
  private readonly gapMemory = new Map<string, FeedGapState>();
  private overflow: FeedSource[] = [];
  private stopped = false;

  constructor(options: MultiGuardFeedOptions) {
    this.cap = Math.max(0, Math.floor(options.cap ?? FEED_GUARD_CAP));
    this.createFeed = options.createFeed;
  }

  /**
   * Reconcile the running listeners with the current registry.
   *
   * Idempotent and order-stable: duplicates are collapsed, the first `cap`
   * sources win, and every listener not in that set is stopped and removed
   * before any new one is created. This is the only place the listener set
   * changes, which is what makes the leak test meaningful.
   */
  sync(sources: readonly FeedSource[]): void {
    if (this.stopped) return;

    const unique: FeedSource[] = [];
    const seen = new Set<string>();
    for (const source of sources) {
      const guard = source.guard.trim();
      if (!guard || seen.has(guard)) continue;
      seen.add(guard);
      unique.push({ guard, label: source.label });
    }

    const accepted = unique.slice(0, this.cap);
    this.overflow = unique.slice(this.cap);
    const keep = new Set(accepted.map((source) => source.guard));

    // Remove first: a guard that dropped out of the registry must stop polling
    // before a replacement is created, so the listener count never transiently
    // exceeds the cap.
    for (const [guard, runner] of [...this.runners]) {
      if (keep.has(guard)) continue;
      this.runners.delete(guard);
      this.labels.delete(guard);
      this.gapMemory.delete(guard);
      runner.stop?.();
    }

    for (const source of accepted) {
      this.labels.set(source.guard, source.label);
      if (!this.runners.has(source.guard)) {
        this.runners.set(source.guard, this.createFeed(source.guard));
      }
    }
  }

  /** The guards currently being tailed, with their registry labels. */
  guards(): FeedSource[] {
    return [...this.runners.keys()].map((guard) => ({
      guard,
      label: this.labels.get(guard) ?? guard,
    }));
  }

  /** How many listeners are live right now. The leak assertion reads this. */
  listenerCount(): number {
    return this.runners.size;
  }

  /** The registry entries past the cap, in registry order. */
  dropped(): FeedSource[] {
    return this.overflow.map((source) => ({ ...source }));
  }

  droppedCount(): number {
    return this.overflow.length;
  }

  /** True when at least one registry entry is not being tailed. */
  isCapped(): boolean {
    return this.overflow.length > 0;
  }

  /**
   * A guard you asked for but are not watching, because of the cap. Surfaced so
   * the UI can name it rather than pretending the registry is fully covered.
   */
  droppedLabels(): string[] {
    return this.overflow.map((source) => source.label);
  }

  /**
   * Poll every tailed guard once and merge the results.
   *
   * A guard whose poll throws is recorded as failed and contributes no events;
   * the other guards still deliver. The merged page is newest-first across
   * guards (diagnostic rows, which carry no ledger, sort first as the freshest
   * un-broadcast refusals).
   */
  async pollAll(limit = 50): Promise<FeedPollResult> {
    if (this.stopped) return { events: [], latestLedger: null, watch: [] };

    const watch: FeedWatchStatus[] = [];
    const merged: GuardEvent[] = [];
    let latestLedger: number | null = null;

    for (const [guard, runner] of this.runners) {
      const label = this.labels.get(guard) ?? guard;
      try {
        const page = await runner.pollOnce(limit);
        if (page.gaps) this.gapMemory.set(guard, page.gaps);
        watch.push({
          guard,
          label,
          ok: true,
          error: null,
          latestLedger: page.latestLedger,
          gaps: this.gapMemory.get(guard) ?? null,
        });
        merged.push(...page.events);
        latestLedger =
          latestLedger === null ? page.latestLedger : Math.max(latestLedger, page.latestLedger);
      } catch (error) {
        watch.push({
          guard,
          label,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          latestLedger: null,
          gaps: this.gapMemory.get(guard) ?? null,
        });
      }
    }

    merged.sort((a, b) => rank(b.ledger) - rank(a.ledger));
    return { events: merged, latestLedger, watch };
  }

  /** Stop every listener and refuse further syncs. Used on stop-watching/unmount. */
  stopAll(): void {
    this.stopped = true;
    for (const runner of this.runners.values()) runner.stop?.();
    this.runners.clear();
    this.labels.clear();
    this.gapMemory.clear();
    this.overflow = [];
  }
}

/** Diagnostics (no ledger) rank above any committed event; higher ledgers first. */
function rank(ledger: number | null): number {
  return ledger === null ? Number.MAX_SAFE_INTEGER : ledger;
}

/**
 * The guard-chip filter, composed the same way as any other feed criterion: an
 * empty selection means "no filter", otherwise only the selected contract ids
 * pass. Returning `true` for an empty selection (rather than `false`) keeps the
 * default feed unfiltered, which is the state the panel opens in.
 */
export function matchesGuardFilter(
  contractId: string | null,
  selected: ReadonlySet<string>,
): boolean {
  if (selected.size === 0) return true;
  return contractId !== null && selected.has(contractId);
}

/** Toggle one guard in the chip filter, returning a new set (never mutating). */
export function toggleGuardFilter(selected: ReadonlySet<string>, guard: string): Set<string> {
  const next = new Set(selected);
  if (next.has(guard)) next.delete(guard);
  else next.add(guard);
  return next;
}

/**
 * The label to show for an event's contract id. Falls back to the address
 * itself so an event from a guard the registry has not labelled is still
 * attributed rather than left blank.
 */
export function attributionLabel(
  contractId: string | null,
  sources: readonly FeedSource[],
): string | null {
  if (contractId === null) return null;
  return sources.find((source) => source.guard === contractId)?.label ?? contractId;
}
