/**
 * Telemetry: the guard's own events, from the two places they can exist.
 *
 * The part that is easy to get wrong, and which this module is shaped around: a
 * refused decision never reaches the ledger. The guard returns `Err`, which rolls
 * the event back, so a listener that only tails committed ledger events sees a
 * contract that appears to approve everything. The two sources are:
 *
 *   1. **ledger events** — allowed decisions, heartbeats, and the admin lifecycle
 *      events, tailed from `getEvents` with a cursor
 *      (`GuardTelemetryListener`, from the SDK).
 *   2. **simulation diagnostics** — refused decisions, which by construction have
 *      no transaction. The only place these arise in this dashboard is a write the
 *      operator attempted and the enforced simulation refused; the SDK's
 *      `guardEventsFromDiagnostics` decodes exactly those, and they are labelled
 *      `diagnostic` in the feed so they are never mistaken for settled history.
 *
 * "Real time" here means cursor-based polling of `getEvents`, because Soroban RPC
 * offers no push stream. The floor on latency is the ledger close interval, so
 * the feed reports the latest ledger it has seen rather than implying it is
 * instantaneous.
 */

import {
  GuardTelemetryListener,
  guardEventsFromDiagnostics,
  topicSymbols,
  type GuardEvent,
  type PollResult,
  guardEventId,
} from "stellar-agent-guard-sdk";
import { scValToNative, xdr, type rpc } from "@stellar/stellar-sdk";
import { NETWORK } from "./network.ts";
import { withTimeout } from "./timeout.ts";
import {
  AVERAGE_LEDGER_CLOSE_SECS,
  estimateLedgerAtTime,
  type LedgerAnchor,
  type TimeRange,
} from "./ledgerTime.ts";

/**
 * The event exactly as the chain encoded it, kept next to the SDK's decoding.
 *
 * The SDK's `GuardEvent` is a decoded view and drops the XDR. An audit export
 * needs the original bytes, so a reviewer can re-decode them independently
 * instead of trusting this console's decoder. Every field is base64 XDR or an
 * RPC identifier, so it is stored as the RPC returned it.
 */
export interface RawEventXdr {
  /** stellar-rpc's event id (TOID-based, usable as a cursor); null for diagnostics. */
  eventId: string | null;
  /** Each topic as base64 `ScVal` XDR, in order. */
  topicXdr: string[];
  /** The event body as base64 `ScVal` XDR. */
  valueXdr: string | null;
  /** The whole `DiagnosticEvent` as base64 XDR, for refusals decoded from a simulation. */
  diagnosticEventXdr: string | null;
  inSuccessfulContractCall: boolean | null;
}

/**
 * A decoded guard event plus the raw XDR it came from.
 *
 * The SDK owns the decoding (`GuardEvent`, including its `id`, `stream` and
 * `observedAt`); the only field added here is `raw` — UI shape, not decode: an
 * audit export has to hand the reviewer the original bytes, and the SDK's
 * decoded view deliberately drops them (SDK #94 would carry them).
 */
export type TelemetryEvent = GuardEvent & {
  raw?: RawEventXdr | null;
};

/** One page of rows, carrying the SDK's own page fields (cursor, ledgers). */
export type TelemetryPage = Omit<PollResult, "events"> & {
  events: TelemetryEvent[];
  /** What this feed currently knows about holes in its coverage. */
  gaps?: FeedGapState;
};

// ── Coverage gaps ──────────────────────────────────────────────────────────
//
// A feed that looks complete when it is not is worse than one that says so. The
// RPC reports, on every response, the retention window it still holds and the
// cursor to resume from, and those two facts are enough to notice some — not
// all — ways the feed can have missed events. This section turns them into an
// explicit notice. It never fabricates an event for a hole, and it never reads
// an empty page as either "nothing happened" or "something was lost": only the
// retention window and the cursor decide.

export type FeedGapReason =
  /** The RPC's retention window moved past ledgers this feed had not read yet. */
  | "history_pruned"
  /** The RPC handed back a cursor earlier than the one this feed already held. */
  | "cursor_regressed";

export interface FeedGap {
  reason: FeedGapReason;
  /** First ledger that could not be read (inclusive); `null` when the range is unknown. */
  fromLedger: number | null;
  /** Last ledger that could not be read (inclusive); `null` when the range is unknown. */
  toLedger: number | null;
  /** The newest ledger the RPC reported in the response that exposed this. */
  detectedAtLedger: number;
}

export interface FeedGapState {
  /** Unrecoverable holes, oldest first. They stay until the feed is restarted. */
  lost: FeedGap[];
  /** A discontinuity seen on the latest poll only; cleared by the next clean one. */
  unsettled: FeedGap | null;
}

export const EMPTY_FEED_GAP_STATE: FeedGapState = { lost: [], unsettled: null };

/** Cap on remembered lost ranges, so a long-running tab cannot grow without bound. */
export const FEED_GAP_LIMIT = 20;

/**
 * Compare two RPC event cursors. stellar-rpc ids are `<TOID>-<event index>`, both
 * decimal, so they compare numerically — not as strings, whose order differs once
 * the digit counts differ. `null` when either is not in that shape: an
 * unrecognised cursor can be neither trusted nor shown to have regressed.
 */
export function compareEventCursor(a: string, b: string): -1 | 0 | 1 | null {
  const left = /^(\d+)-(\d+)$/.exec(a);
  const right = /^(\d+)-(\d+)$/.exec(b);
  if (!left || !right) return null;
  const leftPos = [BigInt(left[1]!), BigInt(left[2]!)] as const;
  const rightPos = [BigInt(right[1]!), BigInt(right[2]!)] as const;
  for (let i = 0; i < 2; i += 1) {
    if (leftPos[i]! < rightPos[i]!) return -1;
    if (leftPos[i]! > rightPos[i]!) return 1;
  }
  return 0;
}

export interface FeedPollEvidence {
  /** The earliest ledger this feed has not yet confirmed reading; `null` before it has one. */
  expectedFrom: number | null;
  /** The last known-good cursor, if any. */
  heldCursor: string | null;
  page: { cursor: string; latestLedger: number; oldestLedger: number | null };
}

/**
 * The discontinuities one poll response proves.
 *
 * - `history_pruned`: the earliest ledger still owed to the operator is older
 *   than the oldest ledger the RPC retains, so ledgers `expectedFrom` through
 *   `oldestLedger - 1` can no longer be fetched. The same rule the SDK's
 *   `follow()` applies. Skipped when the RPC omits `oldestLedger` rather than
 *   guessing a boundary.
 * - `cursor_regressed`: the response's cursor is earlier than the held one. The
 *   range is unknown, because a regression says the position is unreliable, not
 *   which events fell in between.
 *
 * Whether the page has events is deliberately not an input.
 */
export function detectFeedGaps(evidence: FeedPollEvidence): FeedGap[] {
  const { expectedFrom, heldCursor, page } = evidence;
  const found: FeedGap[] = [];
  if (expectedFrom !== null && page.oldestLedger !== null && expectedFrom < page.oldestLedger) {
    found.push({
      reason: "history_pruned",
      fromLedger: expectedFrom,
      toLedger: page.oldestLedger - 1,
      detectedAtLedger: page.latestLedger,
    });
  }
  if (heldCursor && page.cursor && compareEventCursor(page.cursor, heldCursor) === -1) {
    found.push({
      reason: "cursor_regressed",
      fromLedger: null,
      toLedger: null,
      detectedAtLedger: page.latestLedger,
    });
  }
  return found;
}

/** "5 minutes", "2 hours", "3 days" — coarse on purpose; ledger times are an estimate. */
function approximateDuration(totalSecs: number): string {
  const minutes = Math.round(totalSecs / 60);
  if (totalSecs < 90) return `${Math.max(1, Math.round(totalSecs))} seconds`;
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.round(totalSecs / 3600);
  if (hours < 48) return `${hours} hours`;
  return `${Math.round(totalSecs / 86_400)} days`;
}

/** Operator-facing copy for one gap: what happened and exactly what range it covers. */
export function describeFeedGap(gap: FeedGap): { headline: string; range: string } {
  if (gap.reason === "history_pruned" && gap.fromLedger !== null && gap.toLedger !== null) {
    const ledgers = gap.toLedger - gap.fromLedger + 1;
    const span = approximateDuration(ledgers * AVERAGE_LEDGER_CLOSE_SECS);
    return {
      headline: "Events were missed and cannot be recovered from this RPC",
      range: `Ledgers ${gap.fromLedger}–${gap.toLedger} (about ${span}) are no longer retained.`,
    };
  }
  return {
    headline: "The RPC returned an earlier position than this feed had already reached",
    range: "The affected range is unknown. The feed kept its last known-good position.",
  };
}

/**
 * The earliest ledger still unconfirmed after a page. A page that reached the head
 * confirms everything up to `latestLedger`; a full page (more to come) confirms
 * only through its last event, so the boundary check stays armed for the next poll.
 * Same rule as the SDK's `follow()`.
 */
function nextExpectedLedger(
  page: { events: readonly { ledger: number | null }[]; latestLedger: number },
  limit: number,
): number {
  const ledgers = page.events
    .map((event) => event.ledger)
    .filter((ledger): ledger is number => ledger !== null);
  if (page.events.length >= limit && ledgers.length > 0) return Math.max(...ledgers) + 1;
  return page.latestLedger + 1;
}

/**
 * A cursor-carrying reader over one guard's event stream.
 *
 * The cursor is held here rather than re-derived from a ledger number on every
 * poll, because `getEvents` pagination is only stable while a cursor is carried
 * forward — re-scanning from a ledger can miss events that fell outside the
 * window between polls.
 */
/**
 * Note the explicit field declarations rather than constructor parameter
 * properties: this module is loaded by `node --test` and by the proof script
 * through Node's type-stripping loader, which rejects parameter properties
 * outright. Keeping the whole library strippable means the browser, the test
 * runner and the proof script execute the same source rather than three builds
 * of it.
 */
export class GuardFeed {
  readonly guard: string;
  private readonly listener: GuardTelemetryListener;
  private cursor: string | null = null;
  private latestLedger: number | null = null;
  /** The earliest ledger not yet confirmed read; the boundary gap detection checks. */
  private expectedFrom: number | null = null;
  private lostGaps: FeedGap[] = [];
  private unsettledGap: FeedGap | null = null;

  /** The raw `getEvents` page behind the most recent poll, captured for `raw`. */
  private lastRawEvents: readonly rpc.Api.EventResponse[] = [];

  /** Set by `stop()`. A stopped feed never polls again, even if referenced. */
  private stopped = false;

  constructor(server: rpc.Server, guard: string, rpcUrl: string = NETWORK.rpcUrl) {
    this.guard = guard;
    // The listener decodes and discards the XDR. Hand it a view of the server
    // whose `getEvents` also records the raw page, so the export can carry the
    // original bytes without re-implementing the SDK's decoding here.
    const recording = Object.create(server) as rpc.Server;
    recording.getEvents = async (request) => {
      const response = await server.getEvents(request);
      this.lastRawEvents = response.events;
      return response;
    };
    this.listener = new GuardTelemetryListener({ server: recording, guard, rpcUrl });
  }

  /**
   * Release this feed. The multi-guard supervisor calls this the moment a guard
   * is removed from the registry, so a reconciled-away listener cannot keep
   * emitting events through a stale reference.
   */
  stop(): void {
    this.stopped = true;
  }

  /** True once `stop()` has been called. Exposed for lifecycle assertions. */
  isStopped(): boolean {
    return this.stopped;
  }

  /** One page of committed ledger events. Advances the cursor. */
  async pollOnce(limit = 50): Promise<TelemetryPage> {
    if (this.stopped) {
      const ledger = this.latestLedger ?? 0;
      return { events: [], cursor: this.cursor ?? "", latestLedger: ledger, oldestLedger: ledger };
    }
    return await withTimeout(async () => {
      const params: { cursor?: string; limit: number; startLedger?: number } = { limit };
      if (this.cursor) {
        params.cursor = this.cursor;
      } else if (this.latestLedger !== null) {
        params.startLedger = this.latestLedger;
      }
      this.lastRawEvents = [];
      const decoded = await this.listener.poll(params);
      const page = { ...decoded, events: attachLedgerXdr(decoded.events, this.lastRawEvents) };

      // Look for discontinuities before moving any pointer, against where the
      // feed was. Received events are never dropped for it: the page is returned
      // whole and the stream buffer de-duplicates anything it already holds.
      const found = detectFeedGaps({
        expectedFrom: this.expectedFrom,
        heldCursor: this.cursor,
        page: {
          cursor: page.cursor,
          latestLedger: page.latestLedger,
          oldestLedger: page.oldestLedger,
        },
      });
      this.recordGaps(found);

      // A page with no events still advances the ledger pointer, so the next poll
      // does not re-scan a stretch of empty ledgers.
      this.latestLedger = Math.max(this.latestLedger ?? 0, page.latestLedger);
      // The cursor only ever moves forward. A regressed one is not adopted, so the
      // next poll resumes from the last known-good position.
      if (page.cursor && !found.some((gap) => gap.reason === "cursor_regressed")) {
        this.cursor = page.cursor;
      }
      this.expectedFrom = Math.max(this.expectedFrom ?? 0, nextExpectedLedger(page, limit));
      return { ...page, gaps: this.gapState() };
    });
  }

  /** Where the feed currently is, for display. */
  position(): { cursor: string | null; latestLedger: number | null } {
    return { cursor: this.cursor, latestLedger: this.latestLedger };
  }

  /** What this feed knows about holes in its coverage, as of the last poll. */
  gapState(): FeedGapState {
    return { lost: [...this.lostGaps], unsettled: this.unsettledGap };
  }

  /** Forget the cursor so the feed re-scans from a given ledger. */
  resetFrom(ledger: number | null): void {
    this.cursor = null;
    this.latestLedger = ledger;
    // A new starting point is a new baseline: what is owed begins at `ledger`, and
    // notices about the old position no longer describe this feed.
    this.expectedFrom = ledger;
    this.lostGaps = [];
    this.unsettledGap = null;
  }

  private recordGaps(found: readonly FeedGap[]): void {
    this.unsettledGap = found.find((gap) => gap.reason === "cursor_regressed") ?? null;
    for (const gap of found) {
      if (gap.reason !== "history_pruned") continue;
      const known = this.lostGaps.some(
        (lost) => lost.fromLedger === gap.fromLedger && lost.toLedger === gap.toLedger,
      );
      if (!known) this.lostGaps = [...this.lostGaps, gap].slice(-FEED_GAP_LIMIT);
    }
  }

  /**
   * One page of committed events from a historical time range (#148).
   *
   * The range's timestamps are converted to a ledger window with
   * `ledgerTime.ts` — anchored to the server's latest ledger, or to the last
   * observed ledger this feed has seen — and the resulting events are
   * filtered by their close timestamps so the inaccuracy of the ~5s ledger
   * estimate does not hand the operator rows from outside the range they
   * asked for. The estimate deliberately starts the window one ledger early
   * (`estimateLedgerAtTime`), and this filter is what makes that safe rather
   * than sloppy: extra rows are dropped, missed rows would be gone.
   *
   * The feed's live cursor is untouched — a historical query must not move
   * where "live" resumes.
   */
  async pollRange(range: TimeRange, limit = 200): Promise<TelemetryPage> {
    const anchor = await this.currentAnchor();
    const startLedger = Math.max(
      1,
      estimateLedgerAtTime(anchor, range.fromUnixSecs ?? anchor.closeTimeSecs),
    );
    const endLedger =
      range.toUnixSecs === null
        ? null
        : Math.max(startLedger, estimateLedgerAtTime(anchor, range.toUnixSecs));

    // The SDK listener owns the topic/value decoding and the filter shape, so
    // the page is fetched through it. `poll` with a `startLedger` (no cursor)
    // issues exactly one `getEvents` over the window's head; the range's end
    // bound is then applied locally by timestamp.
    this.lastRawEvents = [];
    const decoded = await this.listener.poll({ startLedger, limit });
    const page = { ...decoded, events: attachLedgerXdr(decoded.events, this.lastRawEvents) };
    const filtered = page.events.filter((event) => {
      if (range.fromUnixSecs !== null && event.ledgerClosedAt) {
        if (Number(new Date(event.ledgerClosedAt)) / 1000 < range.fromUnixSecs) return false;
      }
      if (range.toUnixSecs !== null && event.ledgerClosedAt) {
        if (Number(new Date(event.ledgerClosedAt)) / 1000 > range.toUnixSecs) return false;
      }
      return true;
    });
    return { ...page, events: filtered };
  }

  /**
   * The anchor the range arithmetic uses: the server's latest ledger when it
   * can be read, falling back to the freshest close time this feed itself
   * observed. A feed that never polled has no fallback and reports the error.
   */
  private async currentAnchor(): Promise<LedgerAnchor> {
    try {
      const latest = await (
        this.listener as unknown as {
          config: { server: rpc.Server };
        }
      ).config.server.getLatestLedger();
      return { ledger: latest.sequence, closeTimeSecs: Number(latest.closeTime) };
    } catch (error) {
      if (this.latestLedger !== null) {
        // Without a close time the best available anchor is "now": the latest
        // ledger this feed saw is, by definition of "latest", recent.
        return { ledger: this.latestLedger, closeTimeSecs: Math.floor(Date.now() / 1000) };
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
}

/** The slice of `GuardFeed` a coordinator drives. `GuardFeed` satisfies it structurally. */
export interface PolledFeed {
  readonly guard: string;
  pollOnce(limit?: number): Promise<TelemetryPage>;
  position(): { cursor: string | null; latestLedger: number | null };
  resetFrom(ledger: number | null): void;
}

/**
 * How far back a freshly-switched-to feed asks for history, in ledgers.
 *
 * A guard switch must land with context, not a blank page: the SDK's own
 * default for an unprimed feed is "start at the current head" (its comment:
 * replaying a year of history by accident is a mean surprise), which is right
 * for a first watch but wrong for an operator arriving from another guard —
 * they expect to see what the guard has been doing lately. Priming a new feed
 * with `latestKnown − FEED_SWITCH_HISTORY_LEDGERS` asks for roughly the last
 * five minutes (at ~5s ledger closes) without ever replaying a year. Ledgers
 * are chain-global, so the currently-known head is valid across guards.
 */
export const FEED_SWITCH_HISTORY_LEDGERS = 60;

export interface FeedCoordinatorStats {
  /** Feeds constructed since this coordinator existed. */
  created: number;
  /** Feeds replaced because the operator switched identity — each held a cursor
   * that must never be resumed onto another guard's stream. */
  abandoned: number;
}

/**
 * Exactly one live feed per guard identity, and a fresh cursor on every change.
 *
 * Guard switches are where feed data isolation can silently fail: a feed built
 * for guard A carries A's cursor, and resuming that cursor under guard B would
 * tail B's stream from a position that meant something on A — wrong-attribution
 * incidents waiting to happen. The rule is deliberately blunt: a different
 * guard id means a new `GuardFeed` with a null cursor, and the old feed is
 * abandoned, never resumed. A rapid A→B→A therefore lands on a *fresh* A stream,
 * not A's stale position (the deferred-init race dies here, synchronously, by
 * identity check). Counting is exposed so tests can prove abandonment.
 */
export class GuardFeedCoordinator<T extends PolledFeed = PolledFeed> {
  private feed: T | null = null;
  private readonly stats: FeedCoordinatorStats = { created: 0, abandoned: 0 };
  private readonly factory: (guard: string) => T;

  constructor(factory: (guard: string) => T) {
    this.factory = factory;
  }

  /** The feed for `guard`: reused when identity matches, replaced when it does not. */
  ensure(guard: string): T {
    if (this.feed && this.feed.guard === guard) return this.feed;
    if (this.feed) this.stats.abandoned += 1;
    this.feed = this.factory(guard);
    this.stats.created += 1;
    return this.feed;
  }

  /** The live feed, if one exists. Callers poll through this, never a cached ref. */
  current(): T | null {
    return this.feed;
  }

  statsSnapshot(): FeedCoordinatorStats {
    return { ...this.stats };
  }
}

/**
 * Decode refused-decision events out of an attempted write's diagnostics.
 *
 * These are the only refused decisions this interface can ever see, and they are
 * returned with `source: "diagnostic"` so the feed can say plainly that they were
 * never committed — a distinction that matters, because a rolled-back event is
 * evidence of a refusal, not of settled state.
 *
 * Decode is the SDK's (`guardEventsFromDiagnostics`); the wrapper stays because
 * the feed shows *when this console saw the refusal* and exports its raw bytes.
 */
export function refusedEventsFromDiagnostics(
  diagnosticEvents: readonly unknown[],
  guard: string,
): TelemetryEvent[] {
  // Some RPC paths hand back base64 strings rather than decoded events; the
  // SDK's decoder only reads decoded ones, so normalise first.
  const normalised = diagnosticEvents.map(decodeIfBase64);
  const decoded = guardEventsFromDiagnostics(normalised, guard);
  const observedAt = new Date().toISOString();
  // The SDK skips events whose topics it does not recognise but keeps the
  // order of the rest, so walk both lists together and pair them by name topic.
  let cursor = 0;
  return decoded.map((event, index) => {
    const stream = "diagnostic";
    const id = guardEventId({ ...event, topics: [event.topic], simulationIndex: index });
    while (cursor < normalised.length) {
      const candidate = normalised[cursor++];
      if (topicSymbols(candidate)[0] === event.topic) {
        return { ...event, observedAt, id, stream, raw: diagnosticXdr(candidate) };
      }
    }
    return { ...event, observedAt, id, stream, raw: null };
  });
}

/**
 * Pair decoded ledger events with the raw page they came from.
 *
 * The listener drops unrecognised topics but keeps the order of the rest, so a
 * single forward walk matching ledger, transaction and name topic lines the two
 * lists up.
 *
 * Retained for UI shape only: the audit export needs the original base64 XDR,
 * which the SDK's decoded `GuardEvent` does not carry (SDK #94 would).
 */
export function attachLedgerXdr(
  decoded: readonly GuardEvent[],
  raw: readonly rpc.Api.EventResponse[],
): TelemetryEvent[] {
  const observedAt = new Date().toISOString();
  let cursor = 0;
  return decoded.map((event) => {
    const stream = "committed";
    const id = guardEventId({ ...event, topics: [event.topic], simulationIndex: null });
    while (cursor < raw.length) {
      const candidate = raw[cursor++]!;
      if (
        candidate.ledger === event.ledger &&
        (candidate.txHash ?? null) === event.transactionHash &&
        firstTopic(candidate) === event.topic
      ) {
        return {
          ...event,
          observedAt,
          id,
          stream,
          raw: {
            eventId: candidate.id,
            topicXdr: candidate.topic.map((topic) => topic.toXDR("base64")),
            valueXdr: candidate.value.toXDR("base64"),
            diagnosticEventXdr: null,
            inSuccessfulContractCall: candidate.inSuccessfulContractCall ?? null,
          },
        };
      }
    }
    return { ...event, observedAt, id, stream, raw: null };
  });
}

// UI shape: pairing the raw `getEvents` page with the SDK's decoded rows needs
// the name topic of an RPC event, and the SDK's `topicSymbols` reads a
// `DiagnosticEvent`/base64 shape, not `rpc.Api.EventResponse`.
function firstTopic(event: rpc.Api.EventResponse): string | null {
  const [first] = event.topic;
  if (!first) return null;
  try {
    return String(scValToNative(first));
  } catch {
    return null;
  }
}

// UI shape: some RPC paths hand diagnostics back as base64 strings, and the
// SDK's decoder reads decoded events only — normalise before handing them over.
function decodeIfBase64(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return xdr.DiagnosticEvent.fromXDR(value, "base64");
  } catch {
    return value;
  }
}

interface XdrEncodable {
  toXDR(format: "base64"): string;
}

function isXdrEncodable(value: unknown): value is XdrEncodable {
  return typeof (value as XdrEncodable | null)?.toXDR === "function";
}

// UI shape: raw bytes for the audit export — the SDK decodes and drops the XDR.
/** Raw XDR for one diagnostic event, whether it arrived decoded or as base64. */
function diagnosticXdr(value: unknown): RawEventXdr | null {
  try {
    const event = typeof value === "string" ? xdr.DiagnosticEvent.fromXDR(value, "base64") : value;
    if (!(event instanceof xdr.DiagnosticEvent)) {
      return isXdrEncodable(value)
        ? {
            eventId: null,
            topicXdr: [],
            valueXdr: null,
            diagnosticEventXdr: value.toXDR("base64"),
            inSuccessfulContractCall: null,
          }
        : null;
    }
    const body = event.event.body.v0;
    return {
      eventId: null,
      topicXdr: body.topics.map((topic) => topic.toXDR("base64")),
      valueXdr: body.data.toXDR("base64"),
      diagnosticEventXdr: event.toXDR("base64"),
      inSuccessfulContractCall: event.inSuccessfulContractCall,
    };
  } catch {
    return null;
  }
}

/**
 * The feed's display buffer, with a pause control.
 *
 * During a burst, new rows arriving at the top push the row an operator is
 * reading off screen. Pausing freezes what is displayed, **not** the poller:
 * the cursor keeps advancing in the background and new events wait in
 * `pending`. Resuming applies them exactly as if the stream had never been
 * paused, so a pause cannot duplicate a row or skip past one.
 *
 * Pure and immutable, so it drops straight into a React state updater and can
 * be tested without a DOM. Events are held newest first, the order the table
 * renders them.
 */
export interface StreamBuffer {
  /** What the table shows, newest first. */
  rows: TelemetryEvent[];
  /** Events that arrived while paused, newest first. They are not shown until resume. */
  pending: TelemetryEvent[];
  paused: boolean;
  /** SDK event ids already accepted, so a re-polled page or re-pushed diagnostic is not shown twice. */
  seen: ReadonlySet<string>;
  /** Events that fell out of the pending queue while paused because it exceeded the buffer limit. */
  dropped: number;
}

/** How many rows the feed keeps. The feed is a live view, not an archive. */
export const STREAM_BUFFER_LIMIT = 250;

/**
 * A stable identity for an event, so re-polling the same page cannot duplicate
 * rows. Decoded event data can hold bigints (a heartbeat's `at`), which plain
 * `JSON.stringify` rejects, so they are written as decimal strings.
 */
export function eventKey(event: GuardEvent): string {
  return [
    event.source,
    event.transactionHash ?? "-",
    event.ledger ?? "-",
    event.topic,
    event.decision?.result ?? "-",
    event.decision?.reason ?? "-",
    typeof event.data === "object" && event.data !== null
      ? JSON.stringify(event.data, (_key, value: unknown) =>
          typeof value === "bigint" ? `${value}n` : value,
        )
      : String(event.data),
  ].join("|");
}

export function emptyStreamBuffer(): StreamBuffer {
  return { rows: [], pending: [], paused: false, seen: new Set(), dropped: 0 };
}

/**
 * Accept a batch of incoming events.
 *
 * Unseen events go on top of the visible rows, or into `pending` while paused.
 * `dedupe: false` is for sources that make every event unique by construction
 * but can repeat the same fields, such as the demo generator.
 */
export function ingestEvents(
  buffer: StreamBuffer,
  incoming: readonly TelemetryEvent[],
  options: { limit?: number; dedupe?: boolean } = {},
): StreamBuffer {
  const limit = options.limit ?? STREAM_BUFFER_LIMIT;
  const dedupe = options.dedupe ?? true;
  let seen = buffer.seen;
  const fresh: TelemetryEvent[] = [];
  for (const event of incoming) {
    if (dedupe) {
      const key = event.id;
      if (seen.has(key)) continue;
      if (seen === buffer.seen) seen = new Set(buffer.seen);
      (seen as Set<string>).add(key);
    }
    fresh.push(event);
  }
  if (fresh.length === 0) return buffer;

  if (buffer.paused) {
    const queued = [...fresh, ...buffer.pending];
    return {
      ...buffer,
      seen,
      pending: queued.slice(0, limit),
      dropped: buffer.dropped + Math.max(0, queued.length - limit),
    };
  }
  return { ...buffer, seen, rows: [...fresh, ...buffer.rows].slice(0, limit) };
}

/**
 * A buffer holding a historical window's events as its rows, live and unpaused.
 * `seen` is rebuilt from exactly those rows, so returning to the live tail does
 * not re-suppress events the window displayed, nor re-show ones it did.
 */
export function historicalBuffer(events: readonly TelemetryEvent[]): StreamBuffer {
  return {
    ...emptyStreamBuffer(),
    rows: [...events],
    seen: new Set(events.map((event) => event.id)),
  };
}

export function pauseStream(buffer: StreamBuffer): StreamBuffer {
  return buffer.paused ? buffer : { ...buffer, paused: true };
}

/** Put the queued events on top of the rows, in arrival order, and go live again. */
export function resumeStream(
  buffer: StreamBuffer,
  limit: number = STREAM_BUFFER_LIMIT,
): StreamBuffer {
  if (!buffer.paused) return buffer;
  return {
    ...buffer,
    paused: false,
    rows: [...buffer.pending, ...buffer.rows].slice(0, limit),
    pending: [],
    dropped: 0,
  };
}

/**
 * Empty the visible list only.
 *
 * The poll cursor lives in `GuardFeed` and is not touched, so clearing never
 * re-scans the chain. `seen` is kept, so nothing already delivered can come
 * back. `pending` is kept too: those are events the operator has not seen yet,
 * and clearing what is on screen should not discard them silently.
 */
export function clearStreamRows(buffer: StreamBuffer): StreamBuffer {
  return { ...buffer, rows: [] };
}
