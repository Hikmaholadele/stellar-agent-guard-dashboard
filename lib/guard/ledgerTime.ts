/**
 * Mapping wall-clock time to ledger sequences, for historical event queries.
 *
 * Soroban RPC's `getEvents` takes a ledger *sequence*, not a timestamp, so an
 * operator who wants "everything since Tuesday 14:00" first needs to know
 * which ledger that was. The chain does not index ledgers by time, so the
 * mapping is an estimate: ledgers close on average every ~5 seconds (the
 * protocol target enforced by Stellar's consensus timing), which gives
 *
 *     ledger ≈ reference + (t − t_reference) / AVERAGE_LEDGER_CLOSE_SECS
 *
 * anchored to a ledger whose close time is actually known (the latest ledger
 * the RPC reported, or any observed `ledgerClosedAt`). The estimate is
 * deliberately conservative in the useful direction: a starting ledger a few
 * *early* is corrected by the first page of results, while a starting ledger
 * too late silently misses events.
 *
 * The same arithmetic runs backwards for display: a ledger sequence maps to an
 * approximate wall-clock time so a query's range can be shown to the operator
 * in the terms they picked it in.
 */

/** Stellar's protocol target: one ledger close every ~5 seconds. */
export const AVERAGE_LEDGER_CLOSE_SECS = 5;

/**
 * How old a chain-time reading may be and still be called *fresh* (issue
 * #388). Two to three missed ledger closes at the protocol target: within it,
 * elapsed real time is elapsed chain time for countdown purposes; beyond it,
 * the chain may have moved on in ways this console has not read, so a
 * countdown may keep ticking but must stop claiming to be chain-verified.
 */
export const LEDGER_CLOCK_MAX_AGE_SECS = 90;

/**
 * An observation that anchors the ledger clock: a ledger sequence known to
 * have closed at a given time. `getLatestLedger` and every `getEvents` page
 * both produce one.
 */
export interface LedgerAnchor {
  ledger: number;
  /** Unix seconds at which this ledger closed. */
  closeTimeSecs: number;
}

/**
 * Estimate the ledger sequence that closed at `unixSecs`.
 *
 * Rounds *down* (floors, then subtracts a small safety margin of one ledger)
 * so a range query starts slightly early rather than slightly late: extra
 * pages are filtered by their own timestamps, a missed event is gone.
 */
export function estimateLedgerAtTime(
  anchor: LedgerAnchor,
  unixSecs: number,
  averageCloseSecs: number = AVERAGE_LEDGER_CLOSE_SECS,
): number {
  const deltaSecs = unixSecs - anchor.closeTimeSecs;
  const deltaLedgers = deltaSecs / averageCloseSecs;
  // Floor, and step one ledger further back for margin: a query that begins
  // one ledger early costs a filter pass; one that begins late costs events.
  return Math.floor(anchor.ledger + deltaLedgers) - 1;
}

/**
 * Estimate when a ledger closed, as Unix seconds.
 *
 * The inverse of `estimateLedgerAtTime`, without the safety margin: this is
 * for display ("events from approximately…"), where being roughly right is
 * the point.
 */
export function estimateTimeAtLedger(
  anchor: LedgerAnchor,
  ledger: number,
  averageCloseSecs: number = AVERAGE_LEDGER_CLOSE_SECS,
): number {
  return Math.round(anchor.closeTimeSecs + (ledger - anchor.ledger) * averageCloseSecs);
}

/** A relative query range the picker offers as presets, resolved against now. */
export interface TimeRange {
  /** Unix seconds (inclusive lower bound), or null for "no lower bound". */
  fromUnixSecs: number | null;
  /** Unix seconds (inclusive upper bound), or null for "up to now". */
  toUnixSecs: number | null;
}

export type RangePreset = "1h" | "24h" | "7d" | "custom";

/** The human-readable labels for the presets, in display order. */
export const RANGE_PRESETS: readonly { id: RangePreset; label: string }[] = [
  { id: "1h", label: "Last 1 Hour" },
  { id: "24h", label: "Last 24 Hours" },
  { id: "7d", label: "Last 7 Days" },
  { id: "custom", label: "Custom Range" },
];

/**
 * Resolve a preset against `nowSecs`.
 *
 * Presets are lower-bound-only ranges — "the last hour" means "from an hour
 * ago to now", and `now` is expressed as a null upper bound so the query
 * naturally includes the newest ledger.
 */
export function resolvePreset(preset: RangePreset, nowSecs: number): TimeRange {
  switch (preset) {
    case "1h":
      return { fromUnixSecs: nowSecs - 3_600, toUnixSecs: null };
    case "24h":
      return { fromUnixSecs: nowSecs - 86_400, toUnixSecs: null };
    case "7d":
      return { fromUnixSecs: nowSecs - 7 * 86_400, toUnixSecs: null };
    case "custom":
      // A custom range is filled in by the picker before it is usable.
      return { fromUnixSecs: null, toUnixSecs: null };
  }
}

/**
 * Convert a `datetime-local` input value to Unix seconds.
 *
 * The input carries no timezone suffix, so it is interpreted in the
 * operator's local timezone — the same convention every browser datepicker
 * and the rest of this console uses. Returns null for an empty or invalid
 * value, which the caller renders as a validation message.
 */
export function datetimeLocalToUnixSecs(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = new Date(value).getTime();
  if (Number.isNaN(parsed)) return null;
  return Math.floor(parsed / 1000);
}

/** Inverse of `datetimeLocalToUnixSecs`, for pre-filling the picker. */
export function unixSecsToDatetimeLocal(unixSecs: number): string {
  const date = new Date(unixSecs * 1000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * Validate an operator-supplied custom range.
 *
 * A range is usable when both bounds parse and the lower bound does not sit
 * above the upper. The returned message is shown verbatim in the panel.
 */
export function validateRange(range: TimeRange): string | null {
  if (range.fromUnixSecs === null && range.toUnixSecs === null) {
    return "Pick a start and end date, or use a preset.";
  }
  if (
    range.fromUnixSecs !== null &&
    range.toUnixSecs !== null &&
    range.fromUnixSecs > range.toUnixSecs
  ) {
    return "The start date must not be after the end date.";
  }
  return null;
}

/**
 * The ledger window a time range queries, from the anchor.
 *
 * Returns null when the range cannot be resolved (custom range not filled in,
 * or an invalid one): the caller renders the validation message instead of
 * issuing a query it cannot express.
 */
export function ledgerWindowForRange(
  anchor: LedgerAnchor,
  range: TimeRange,
  averageCloseSecs: number = AVERAGE_LEDGER_CLOSE_SECS,
): { startLedger: number; endLedger: number | null } | null {
  if (validateRange(range) !== null) return null;
  if (range.fromUnixSecs === null) return null;
  // The oldest ledger RPC may still serve bounds how far back a query can
  // reach at all; a start earlier than that is clamped so the request does
  // not fail outright (the caller can warn on the clamp).
  const startLedger = Math.max(
    1,
    estimateLedgerAtTime(anchor, range.fromUnixSecs, averageCloseSecs),
  );
  const endLedger =
    range.toUnixSecs === null
      ? null
      : estimateLedgerAtTime(anchor, range.toUnixSecs, averageCloseSecs);
  return { startLedger, endLedger };
}

/**
 * The reference clock a countdown is judged against (issue #388).
 *
 * The chain is the authority: `status().now` is the ledger clock, and every
 * policy deadline (dead-man threshold, active window) is judged against *it*
 * on chain. The browser clock only ever enters as a bounded measure of how old
 * a chain reading is — never as the value the countdown is computed from —
 * because a skewed device clock must not be able to make a window look closer
 * to expiry than the chain considers it to be.
 */
export type ReferenceTimeSource = "ledger" | "browser";

export interface ReferenceTime {
  /** Unix seconds to judge countdowns against. */
  unixSecs: number;
  /** Which clock produced this reference. */
  source: ReferenceTimeSource;
  /**
   * Age of the chain reading behind the reference, in seconds — measured on
   * the browser clock (the only watch available), floored at zero so a device
   * clock running behind reads as "just read", never as "from the future".
   * Null when there is no chain reading at all.
   */
  ageSecs: number | null;
  /**
   * True only for a fresh chain-derived reading: a countdown may state its
   * expiry from this reference. When false, the UI must mark any countdown as
   * an estimate and show its age rather than asserting an exact deadline.
   */
  authoritative: boolean;
}

/** A ledger clock reading and when this console performed it. */
export interface LedgerClockReading {
  /** `status().now` — the ledger clock at read time. */
  ledgerNowSecs: number;
  /** When the read happened, in Unix seconds on the browser clock. */
  readAtSecs: number;
}

/**
 * Resolve the reference time for chain-derived countdowns.
 *
 * With a fresh ledger reading the reference is the ledger clock itself; the
 * reading's age is measured against the browser clock and clamped at zero, so
 * a device clock running *behind* cannot manufacture staleness. A delayed
 * reading (RPC outage, backgrounded tab) still resolves to the ledger value —
 * chain state stays authoritative — but is flagged non-authoritative so the
 * caller marks the countdown an estimate instead of asserting an exact
 * expiry. Only with no chain reading at all does the reference fall back to
 * the browser clock, and then it is never authoritative.
 */
export function resolveReferenceTime(
  reading: LedgerClockReading | null,
  browserNowSecs: number,
  maxAgeSecs: number = LEDGER_CLOCK_MAX_AGE_SECS,
): ReferenceTime {
  if (reading === null) {
    return {
      unixSecs: browserNowSecs,
      source: "browser",
      ageSecs: null,
      authoritative: false,
    };
  }
  const ageSecs = Math.max(0, browserNowSecs - reading.readAtSecs);
  return {
    unixSecs: reading.ledgerNowSecs,
    source: "ledger",
    ageSecs,
    authoritative: ageSecs <= maxAgeSecs,
  };
}
