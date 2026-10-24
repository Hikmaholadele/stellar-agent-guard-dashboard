/**
 * Which guards the operator chose to spend feed capacity on.
 *
 * Issue #310. `feedSubscriptions.ts` caps the tail at `FEED_GUARD_CAP` listeners
 * because each guarded guard is one more `getEvents` poll loop, and it fills that
 * cap in **registry order**. Filling it in registry order is what makes the cap
 * an accident: the five guards that happen to be oldest in the registry are
 * tailed, and the one the operator actually cares about — added last, say — is
 * silently outside the feed. Selection should be deliberate and visible, which is
 * this module: it turns a registry plus an operator's choices into the ordered
 * source list the supervisor consumes, and names every guard left outside.
 *
 * Two properties keep it honest:
 *
 *   1. **The plan is the whole story.** `MultiGuardFeed.sync()` keeps the first
 *      `cap` sources it is handed, so ordering the operator's choices first is
 *      the only change needed to make selection authoritative. No second cap,
 *      no parallel bookkeeping that could disagree with the supervisor.
 *   2. **The guard on screen stays tailed.** The active guard is placed first,
 *      ahead of the pinned list, preserving #23's rule that a full registry must
 *      never starve the guard the operator is looking at. Choices fill the rest.
 *
 * Selection is *public addresses only*, stored per network, and never treated as
 * chain state: the tail set decides what gets polled, not what is true.
 */

import type { FeedSource } from "./feedSubscriptions.ts";
import { NETWORK } from "./network.ts";
import {
  decodeVersionedRecord,
  encodeVersionedRecord,
  writeStoredValue,
  type BrowserStorageLike,
} from "./versionedStorage.ts";

/** The versioned storage key prefix; one tail selection per network. */
export const TAIL_SELECTION_PREFIX = "stellar-agent-guard-dashboard.tailSelection.v1";
export const TAIL_SELECTION_SCHEMA = "stellar-agent-guard/feed-tail-selection";
export const TAIL_SELECTION_VERSION = 1;

/** The subset of `Storage` the store needs, so tests can inject a fake. */
export type SelectionStorage = BrowserStorageLike & { removeItem?(key: string): void };

/** The namespaced key for one network's selection. */
export function tailSelectionStorageKey(network: string): string {
  return `${TAIL_SELECTION_PREFIX}.${network}`;
}

function defaultStorage(): SelectionStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage as unknown as SelectionStorage;
  } catch {
    return null;
  }
}

export interface SelectionOptions {
  /** Which network's bucket to read or write. Defaults to this build's network. */
  network?: string;
  /** Injected storage; defaults to `localStorage`, `null` on the server. */
  storage?: SelectionStorage | null;
}

function resolve(options?: SelectionOptions): {
  network: string;
  storage: SelectionStorage | null;
} {
  return {
    network: options?.network ?? NETWORK.name,
    storage: options?.storage === undefined ? defaultStorage() : options.storage,
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * The operator's saved selection for a network.
 *
 * A corrupted, foreign-schema or future-versioned record reads as "no selection"
 * rather than throwing: the feed must still open on registry order, and the
 * record itself is left in place rather than overwritten by a default.
 */
export function loadTailSelection(options?: SelectionOptions): string[] {
  const { network, storage } = resolve(options);
  if (!storage) return [];
  let raw: string | null;
  try {
    raw = storage.getItem(tailSelectionStorageKey(network));
  } catch {
    return [];
  }
  if (raw === null) return [];
  const decoded = decodeVersionedRecord({
    raw,
    schema: TAIL_SELECTION_SCHEMA,
    version: TAIL_SELECTION_VERSION,
    migrations: {},
    validate: isStringArray,
  });
  if (!decoded.ok) return [];
  return dedupeGuardList(decoded.value);
}

/**
 * Save the selection. Returns false when storage rejected it — the in-memory
 * selection still applies for this session, which is what the caller announces.
 */
export function saveTailSelection(guards: readonly string[], options?: SelectionOptions): boolean {
  const { network, storage } = resolve(options);
  return writeStoredValue(
    storage,
    tailSelectionStorageKey(network),
    encodeVersionedRecord(TAIL_SELECTION_SCHEMA, TAIL_SELECTION_VERSION, dedupeGuardList(guards)),
  ).ok;
}

/** Forget a network's selection, e.g. when the operator clears the tail set. */
export function clearTailSelection(options?: SelectionOptions): void {
  const { network, storage } = resolve(options);
  try {
    storage?.removeItem?.(tailSelectionStorageKey(network));
  } catch {
    // Storage that refuses a removal is already not holding the selection for us.
  }
}

/** Trim, drop blanks, collapse duplicates, keep first-seen order. */
export function dedupeGuardList(guards: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const guard of guards) {
    const trimmed = guard.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Drop pinned addresses the registry no longer contains.
 *
 * A removed guard must not keep occupying a slot in the plan, or the cap would be
 * spent tailing nothing while a live guard sat outside the feed. Called on load
 * and whenever the registry changes.
 */
export function prunePinned(pinned: readonly string[], registry: readonly FeedSource[]): string[] {
  const known = new Set(registry.map((source) => source.guard.trim()));
  return dedupeGuardList(pinned).filter((guard) => known.has(guard));
}

export interface TailPlan {
  /** Sources in the exact order to hand `MultiGuardFeed.sync()`. */
  ordered: FeedSource[];
  /** The first `cap` of those — the guards actually being polled. */
  tailed: FeedSource[];
  /** Everything else the operator could look at, named rather than counted. */
  untailed: FeedSource[];
  cap: number;
}

/**
 * Order the registry so the supervisor's cap falls out of the operator's choices.
 *
 * Precedence, first to last: the active guard (never starved), the pinned set in
 * the operator's own order, then the rest of the registry in registry order. The
 * input is deduped by address, so a guard that is both active and pinned cannot
 * consume two slots.
 */
export function planTailSources(input: {
  registry: readonly FeedSource[];
  active: string;
  pinned: readonly string[];
  cap: number;
}): TailPlan {
  const cap = Math.max(0, Math.floor(input.cap));
  const byGuard = new Map<string, FeedSource>();
  for (const source of input.registry) {
    const guard = source.guard.trim();
    if (!guard || byGuard.has(guard)) continue;
    byGuard.set(guard, { guard, label: source.label });
  }

  const active = input.active.trim();
  // The active guard is always part of the plan even when it is not (yet) in the
  // registry — the selector can point at an address added for this session.
  if (active && !byGuard.has(active)) {
    byGuard.set(active, { guard: active, label: "Active account" });
  }

  const ordered: FeedSource[] = [];
  const used = new Set<string>();
  const push = (guard: string | null): void => {
    if (guard === null || used.has(guard) || !byGuard.has(guard)) return;
    used.add(guard);
    ordered.push(byGuard.get(guard)!);
  };

  push(active || null);
  const pinned = prunePinned(input.pinned, [...byGuard.values()]);
  for (const guard of pinned) push(guard);
  for (const guard of byGuard.keys()) push(guard);

  const tailed = ordered.slice(0, cap);
  return {
    ordered,
    tailed,
    untailed: ordered.slice(cap),
    cap,
  };
}
