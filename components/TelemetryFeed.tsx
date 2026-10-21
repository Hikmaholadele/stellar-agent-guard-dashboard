"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { describeGuardEvent, explainReason, GUARD_EVENT_TOPICS } from "stellar-agent-guard-sdk";
import type { GuardEvent } from "stellar-agent-guard-sdk";
import { STREAM_BUFFER_LIMIT, type TelemetryEvent } from "../lib/guard/telemetry.ts";
import { useGuard, useGuardEvents } from "./GuardProvider.tsx";
import { TelemetryAlerts } from "./TelemetryAlerts.tsx";
import { TelemetryChart } from "./TelemetryChart.tsx";
import { ErrorBlock, Skeleton, TimeAgo, short, starLink, TxHashCell } from "./bits.tsx";
import { DateRangePicker } from "./DateRangePicker.tsx";
import type { RangePreset, TimeRange } from "../lib/guard/ledgerTime.ts";
import { density, initDensityStore } from "../lib/guard/densityStore.ts";
import {
  NDJSON_MIME,
  auditLogFilename,
  isFilterActive,
  telemetryToAuditLog,
} from "../lib/guard/exportFormats.ts";
import { NETWORK } from "../lib/guard/network.ts";
import { loadScopedValue, saveScopedValue } from "../lib/guard/guardScoped.ts";
import { useAnnounce } from "../lib/guard/useAnnounce.ts";
import { eventsToCsv, eventsToJson, exportFilename } from "../lib/guard/eventExport.ts";
import { streamPaused, streamResumed } from "../lib/guard/announceCopy.ts";
import { BlockedEventBadge } from "./BlockedEventBadge.tsx";
import { useDemoMode } from "../lib/guard/useDemoMode.ts";
import {
  EMPTY_TELEMETRY_FILTER,
  filterGuardEvents,
  telemetryToCsv,
  telemetryToNdjson,
  type TelemetryFilter,
  type VerdictFilter,
} from "../lib/guard/telemetryExport.ts";
import { severityFor } from "../lib/guard/feedSeverity.ts";
import { formatEventTimestamp } from "../lib/guard/time.ts";
import { decodeUrlState, writeUrlState } from "../lib/guard/urlState.ts";
import {
  FEED_GUARD_CAP,
  attributionLabel,
  matchesGuardFilter,
  toggleGuardFilter,
} from "../lib/guard/feedSubscriptions.ts";

/** The scoped-state base under which each guard's feed filter is remembered. */
const SCOPED_FILTER_BASE = "feedFilter";

/** Human names for the topic filter's options, keyed by the topic symbol. */
const TOPIC_LABELS: Record<string, string> = {
  [GUARD_EVENT_TOPICS.authChecked]: "Authorization decisions",
  [GUARD_EVENT_TOPICS.heartbeat]: "Agent heartbeats",
  [GUARD_EVENT_TOPICS.initialized]: "Account initialized",
  [GUARD_EVENT_TOPICS.frozen]: "Admin freeze",
  [GUARD_EVENT_TOPICS.unfrozen]: "Admin unfreeze",
  [GUARD_EVENT_TOPICS.policySet]: "Policy installed",
  [GUARD_EVENT_TOPICS.policyRevoked]: "Policy revoked",
};

/**
 * Save a text payload as a download.
 *
 * A blob URL with the `download` attribute, not a `data:` URL: the content can
 * be arbitrarily large (10k-event exports) and browsers cap data-URL
 * navigation. Revoking immediately after the click is safe — the browser has
 * already captured the blob by then.
 */
function downloadText(filename: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * The live event feed.
 *
 * Three things are stated on the panel rather than glossed over, because all three
 * change how the feed should be read:
 *
 *   - Soroban RPC has no push stream, so this polls `getEvents` with a cursor and
 *     the real latency floor is the ledger close interval, not the poll interval.
 *   - A *refused* decision never becomes a transaction: the guard returns `Err`,
 *     which rolls the event back. So the feed can only carry refused decisions
 *     that this console produced itself, decoded from the enforced simulation's
 *     diagnostics and labelled `diagnostic`. Absence of refusals here does not
 *     mean absence of refusals on chain.
 *   - Rows are tiered by severity so a block is findable by looking, not by
 *     reading: the tier is a class and a `data-severity`, and every tier's wording
 *     is already in the row, so nothing here depends on colour.
 *   - Since issue #23 the feed tails *several* guards at once, merging their
 *     streams into one table with a guard-attribution chip per row. Each tailed
 *     guard is one more poll loop, so only the first `FEED_GUARD_CAP` are watched
 *     and the rest are named as not tailed rather than silently dropped.
 *
 * There is deliberately no sound. An operator console runs unattended and muted;
 * a noise that can only be silenced in the tab that made it is not an alert.
 */
export function TelemetryFeed() {
  // The feed subscribes to the events context itself: batches re-render this
  // panel and nothing else (see `GuardEventsContext`).
  const events = useGuardEvents();
  const {
    feed,
    stream,
    pauseStream,
    resumeStream,
    startWatching,
    stopWatching,
    clearEvents,
    guard,
    queryRange,
    rangeLabel,
    instances,
  } = useGuard();
  // Restore a shared verdict filter from the URL, while retaining the other
  // filter dimensions independently for each guard in local storage.
  const [filters, setFilters] = useState<Record<string, TelemetryFilter>>(() => {
    const saved =
      loadScopedValue<TelemetryFilter>(SCOPED_FILTER_BASE, NETWORK.name, guard) ??
      EMPTY_TELEMETRY_FILTER;
    const shared =
      typeof window === "undefined" ? undefined : decodeUrlState(window.location.search).filter;
    return {
      [guard]: shared === undefined ? saved : { ...saved, verdict: shared },
    };
  });
  const filter =
    filters[guard] ??
    loadScopedValue<TelemetryFilter>(SCOPED_FILTER_BASE, NETWORK.name, guard) ??
    EMPTY_TELEMETRY_FILTER;

  function applyFilter(update: (current: TelemetryFilter) => TelemetryFilter) {
    const next = update(filter);
    setFilters((current) => ({ ...current, [guard]: next }));
    saveScopedValue(SCOPED_FILTER_BASE, NETWORK.name, guard, next);
    // Keep the shareable verdict and panel in the URL without navigating.
    writeUrlState({
      filter: next.verdict,
      tab: next.verdict === "all" ? "console" : "telemetry",
    });
  }

  const [densityState, setDensityState] = useState<"comfortable" | "compact">("comfortable");

  useEffect(() => {
    const unsubscribe = initDensityStore();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDensityState(density.get());
    const densityUnsubscribe = density.subscribe((value) => {
      setDensityState(value);
    });
    return () => {
      unsubscribe();
      densityUnsubscribe();
    };
  }, []);

  const announce = useAnnounce();
  const demo = useDemoMode();

  /**
   * Download the feed through the shared export path (issue #37). The schema,
   * BOM and filename rules all live in `lib/guard/eventExport.ts` — this is a
   * thin binding, not a second exporter.
   */
  function downloadExport(format: "csv" | "json") {
    const content =
      format === "csv"
        ? eventsToCsv(rows, guard)
        : JSON.stringify(eventsToJson(rows, guard), null, 2);
    const type = format === "csv" ? "text/csv;charset=utf-8" : "application/json";
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFilename(guard, format, rows.length);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    announce(
      `Exported ${rows.length} event${rows.length === 1 ? "" : "s"} as ${format.toUpperCase()}`,
    );
  }

  // The guard-chip filter (issue #23) is one more feed criterion, composed ahead
  // of the verdict/topic/contract filter rather than instead of it: an empty
  // selection means "every guard", which is the state the panel opens in.
  const [selectedGuards, setSelectedGuards] = useState<Set<string>>(() => new Set());
  const guardVisible = useMemo(
    () => events.filter((event) => matchesGuardFilter(event.contractId, selectedGuards)),
    [events, selectedGuards],
  );
  // The three controls and the exports all act on the same projection, so a
  // CSV/NDJSON download is provably the filtered view on screen — one row in,
  // one line out, never a hidden superset. The guard chip feeds that same
  // projection, so an export is the filtered multi-guard view and nothing more.
  const rows = filterGuardEvents(guardVisible, filter);
  const filterActive = isFilterActive(filter) || selectedGuards.size > 0;

  /**
   * Chips describe what is actually tailed: the live tail's (capped) set while
   * watching, and the full registry otherwise, so the controls never offer a
   * guard the feed is not reading.
   */
  const chipSources = useMemo(
    () =>
      feed.guards.length > 0
        ? feed.guards
        : instances.map((instance) => ({ guard: instance.guard, label: instance.label })),
    [feed.guards, instances],
  );

  /**
   * Download the structured audit log: a header line naming the guard, network
   * and filter, then one record per event with its raw XDR and every 64-bit
   * value as a decimal string. Like the other exports it is the filtered view
   * on screen; the header's `bufferedCount` shows how much the filter left out.
   */
  function exportAuditLog() {
    const exportedAt = new Date();
    const body = telemetryToAuditLog({
      events: rows,
      bufferedCount: events.length,
      guard,
      network: NETWORK.name,
      filter,
      latestLedger: feed.latestLedger,
      demo,
      exportedAt,
    });
    downloadText(
      auditLogFilename(exportedAt, filterActive ? "filtered" : "full"),
      body,
      `${NDJSON_MIME};charset=utf-8`,
    );
    announce(`Exported ${rows.length} event${rows.length === 1 ? "" : "s"} to the audit log`);
  }

  function applyRange(range: TimeRange, preset: RangePreset) {
    // A historical query replaces the live tail view: the feed shows exactly
    // the window asked for, and watching stops so a poll cannot overwrite it.
    stopWatching();
    void queryRange(range, preset);
  }

  function backToLive() {
    clearEvents();
    startWatching();
  }

  /**
   * Pausing and resuming are announced once each, through the shell's polite
   * region, and the count that goes with them is the operator's own number to
   * check the table against.
   *
   * The notice below is deliberately *not* a live region. It carries the queue
   * depth, so as a live region it would re-announce on every event that arrived
   * while the table was frozen — a burst of interruptions for a number that is
   * already on screen. One announcement per transition, and the live number
   * stays where the operator can read it.
   */
  function onPause() {
    pauseStream();
    const spoken = streamPaused();
    announce(spoken.message, spoken.priority);
  }

  function onResume() {
    // Read the depth before the buffer is drained: afterwards it is always zero,
    // and "resumed with 0 queued" is a claim the operator can check against the
    // badge they just watched fill.
    const queued = stream.pendingCount;
    resumeStream();
    const spoken = streamResumed(queued);
    announce(spoken.message, spoken.priority);
  }

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Telemetry</h2>
        <div className="row">
          {feed.watching && <span className="pill ok">polling</span>}
          {stream.paused && <span className="pill warn">paused</span>}
          {/* Counted from the buffer, not from the rows on screen: a paused,
              filtered or empty table can hide a blocked decision that is plainly
              in the stream, and a count the operator cannot reconcile with the
              feed is worse than no count. */}
          <BlockedEventBadge events={events} />
          {feed.latestLedger !== null && (
            <span className="tiny muted">ledger {feed.latestLedger}</span>
          )}
          {feed.watching ? (
            <button className="secondary" onClick={stopWatching}>
              Stop
            </button>
          ) : (
            <button onClick={startWatching}>Start watching</button>
          )}
          {stream.paused ? (
            <button onClick={onResume}>
              Resume{stream.pendingCount > 0 ? ` (${stream.pendingCount})` : ""}
            </button>
          ) : (
            <button
              className="secondary"
              onClick={onPause}
              disabled={!feed.watching}
              title="Freeze the table so rows stop moving. Polling continues; new events queue until you resume."
            >
              Pause stream
            </button>
          )}
          <button
            className="secondary"
            onClick={clearEvents}
            disabled={events.length === 0}
            title="Empty the list. The poll cursor is kept, so nothing is re-fetched and nothing is skipped."
          >
            Clear buffer
          </button>
          {/* Density toggle */}
          <button
            className="secondary"
            onClick={() => {
              density.set(densityState === "comfortable" ? "compact" : "comfortable");
            }}
          >
            {densityState === "comfortable" ? "Compact" : "Comfortable"}
          </button>
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        <DateRangePicker onApply={applyRange} />
        {rangeLabel && (
          <div className="row" style={{ marginTop: 8 }}>
            <span className="pill warn">historical: {rangeLabel}</span>
            <button className="secondary" onClick={backToLive}>
              Back to live tail
            </button>
          </div>
        )}
      </div>

      <div>
        {stream.paused && (
          <div className="notice" style={{ marginTop: 12 }}>
            <strong>
              Stream paused ({stream.pendingCount} new event{stream.pendingCount === 1 ? "" : "s"}{" "}
              pending)
            </strong>
            <span className="tiny">
              The table is frozen so you can read it. Polling carries on in the background and new
              events queue here; resume to add them in order, with no duplicates and none skipped.
              {stream.dropped > 0 &&
                ` ${stream.dropped} older queued event${stream.dropped === 1 ? "" : "s"} fell past the ${STREAM_BUFFER_LIMIT}-event buffer and will not be shown.`}
            </span>
          </div>
        )}
      </div>

      <div className="row" style={{ marginTop: 10, flexWrap: "wrap", gap: 8 }}>
        <label
          className="tiny muted"
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
        >
          Verdict
          <select
            aria-label="Verdict filter"
            value={filter.verdict}
            onChange={(event) =>
              applyFilter((current) => ({
                ...current,
                verdict: event.target.value as VerdictFilter,
              }))
            }
          >
            <option value="all">All verdicts</option>
            <option value="allowed">Allowed Only</option>
            <option value="blocked">Blocked Only</option>
          </select>
        </label>
        <label
          className="tiny muted"
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
        >
          Topic
          <select
            aria-label="Topic filter"
            value={filter.topic}
            onChange={(event) =>
              applyFilter((current) => ({ ...current, topic: event.target.value }))
            }
          >
            <option value="all">All topics</option>
            {Object.entries(TOPIC_LABELS).map(([topic, label]) => (
              <option key={topic} value={topic}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <input
          aria-label="Contract address search"
          placeholder="Contract address contains…"
          value={filter.contract}
          onChange={(event) =>
            applyFilter((current) => ({ ...current, contract: event.target.value }))
          }
          style={{ maxWidth: 240 }}
        />
        <button
          className="secondary"
          onClick={() => downloadExport("csv")}
          disabled={rows.length === 0}
          title="Stable append-only schema (docs/export-schema.md): schema_version, guard, topic, kind, source, decision, reason, reason_label, ledger, ledger_closed_at, transaction_hash — BOM-prefixed for Excel"
        >
          Export CSV
        </button>
        <button
          className="secondary"
          onClick={() => downloadExport("json")}
          disabled={rows.length === 0}
          title="Same schema as the CSV export, as one JSON object: schemaVersion, columns, guard, rows"
        >
          Export JSON
        </button>
        <button
          className="secondary"
          onClick={() =>
            downloadText("guard-telemetry.ndjson", telemetryToNdjson(rows), "application/x-ndjson")
          }
          disabled={rows.length === 0}
        >
          Export NDJSON
        </button>
        <button
          className="secondary"
          onClick={exportAuditLog}
          disabled={rows.length === 0}
          title="NDJSON audit log: a header line, then decoded fields, verdict, ledger, transaction hash and the raw event XDR per event (terms in docs/glossary.md — XDR, Ledger, Stroop)"
        >
          Export audit log
        </button>
        {filterActive && (
          <button
            className="secondary"
            onClick={() => {
              applyFilter(() => EMPTY_TELEMETRY_FILTER);
              // "Clear filters" clears every criterion, the chip filter included.
              setSelectedGuards(new Set());
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {chipSources.length > 1 && (
        <div
          className="row"
          style={{ marginTop: 8, flexWrap: "wrap", gap: 8 }}
          role="group"
          aria-label="Filter events by guard"
        >
          <span className="tiny muted">Filter by guard:</span>
          {chipSources.map((source) => {
            const active = selectedGuards.has(source.guard);
            return (
              <button
                key={source.guard}
                className={active ? "pill ok" : "pill"}
                aria-pressed={active}
                title={source.guard}
                onClick={() =>
                  setSelectedGuards((current) => toggleGuardFilter(current, source.guard))
                }
              >
                {source.label}
              </button>
            );
          })}
          {selectedGuards.size > 0 && (
            <button className="secondary" onClick={() => setSelectedGuards(new Set())}>
              All guards
            </button>
          )}
        </div>
      )}

      <p className="tiny muted" style={{ marginTop: 8 }}>
        Tailed from Soroban RPC&apos;s <code>getEvents</code> with a cursor, so no event is
        delivered twice and none is skipped between polls. Soroban has no push stream — the floor on
        latency is the ledger close interval (roughly 5s), not the 5s poll.
        {feed.lastPolledAt && (
          <>
            {" "}
            Last poll <TimeAgo iso={feed.lastPolledAt} suffix=" ago" />.
          </>
        )}
      </p>

      {feed.guards.length > 0 && (
        <p className="tiny muted" style={{ marginTop: 8 }}>
          Tailing {feed.guards.length} guard{feed.guards.length === 1 ? "" : "s"} simultaneously, up
          to the {FEED_GUARD_CAP}-guard cap. Each tailed guard is its own poll loop, so RPC load
          scales with the number watched.
        </p>
      )}

      {feed.capped > 0 && (
        <div className="notice" role="status">
          <strong>
            {feed.capped} guard{feed.capped === 1 ? "" : "s"} beyond the {FEED_GUARD_CAP}-guard cap{" "}
            {feed.capped === 1 ? "is" : "are"} not being tailed
          </strong>
          <span className="tiny">
            {feed.cappedLabels.join(", ")}. Their events will not appear in this feed. Remove a
            guard from the registry, or stop watching, to tail a different set — the cap keeps poll
            load bounded rather than silently multiplying RPC traffic.
          </span>
        </div>
      )}

      <div className="notice info">
        <strong>Refused decisions cannot reach this feed from the ledger</strong>
        <span className="tiny">
          When the guard refuses a call it returns an error, which rolls the event back — so a
          refused decision has no transaction and no committed event. Rows marked{" "}
          <em>diagnostic</em> are the refusals this console produced itself, decoded from the failed
          enforced simulation before broadcast. An empty feed is not evidence that nothing was
          refused on chain.
        </span>
      </div>

      {feed.error && <ErrorBlock title="The event feed could not poll" detail={feed.error} />}

      <TelemetryAlerts />

      <TelemetryChart />

      {events.length === 0 ? (
        feed.watching && feed.latestLedger === null ? (
          /* The initial load: watching has started but the first poll has not
             returned (no ledger cursor yet). This is a pending read, not an
             empty result, so it renders as skeleton rows in the same table
             shape the events will land in — not as an empty-looking message
             and not as zeros. */
          <div className="scrolly" aria-busy="true">
            <table className={`events ${densityState === "compact" ? "compact" : ""}`}>
              {feedHead}
              <tbody aria-hidden="true">
                {[0, 1, 2].map((row) => (
                  <tr key={row}>
                    <td>
                      <Skeleton lines={1} />
                    </td>
                    <td>
                      <Skeleton lines={1} />
                    </td>
                    <td>
                      <Skeleton lines={1} />
                    </td>
                    <td>
                      <Skeleton lines={1} />
                    </td>
                    <td>
                      <Skeleton lines={1} />
                    </td>
                    <td>
                      <Skeleton lines={1} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="tiny muted">
            {feed.watching
              ? feed.guards.length > 1
                ? "No events from these guards yet. Lifecycle events (policy set, frozen, heartbeat) and allowed decisions appear here as they settle."
                : "No events from this guard yet. Lifecycle events (policy set, frozen, heartbeat) and allowed decisions appear here as they settle."
              : feed.guards.length > 1
                ? "Start watching to tail these guards' events."
                : "Start watching to tail this guard's events."}
          </p>
        )
      ) : rows.length === 0 ? (
        <p className="tiny muted">
          No events match the current filter. The feed still holds {guardVisible.length} event(s);
          widen the verdict, topic, contract{selectedGuards.size > 0 ? " or guard" : ""} filter to
          see them.
        </p>
      ) : (
        <div className="scrolly">
          <table className={`events ${densityState === "compact" ? "compact" : ""}`}>
            {feedHead}
            <tbody>
              {rows.map((event) => (
                <TelemetryRow
                  key={event.id}
                  event={event}
                  guardLabel={attributionLabel(event.contractId, chipSources)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="tiny muted" style={{ marginTop: 8 }}>
        Feed holds the most recent {events.length} event(s) from{" "}
        {feed.guards.length > 1 ? (
          `${feed.guards.length} tailed guards`
        ) : (
          <span className="mono">{short(guard, 8, 6)}</span>
        )}
        .{filterActive && <> Showing {rows.length} matching the current filter.</>} The audit log
        keeps 64-bit values (ledgers, stroop amounts, timestamps) as strings so no precision is
        lost.
      </p>
    </div>
  );
}

/**
 * One feed row, memoised.
 *
 * The feed re-renders on every poll batch (and, under the #114 benchmark's
 * injection seam, many times a second), while a row's content is a pure
 * function of its own event. Memoising keeps the cost of a batch proportional
 * to the rows the batch actually added instead of to the feed's whole 250-row
 * cap — the difference between holding frame rate and remounting the table on
 * every update.
 *
 * The key is the SDK's `event.id`, the same identity the feed de-duplicates
 * on, so React reconciles against the same uniqueness the feed guarantees: a new
 * event prepending shifts nothing, and no row is ever unmounted and rebuilt
 * merely because rows above it changed.
 *
 * Severity rides here, on the row's own attributes, so the tier costs no extra
 * element and the cells stay exactly as they were — O(1) from fields the decoder
 * already produced, with no topic or reason string parsed (see `severityFor`).
 */
const TelemetryRow = memo(function TelemetryRow({
  event,
  guardLabel,
}: {
  event: TelemetryEvent;
  /** The registry label for this row's guard, resolved by the caller. */
  guardLabel: string | null;
}) {
  const severity = severityFor(event);
  const iso = event.ledgerClosedAt ?? event.observedAt ?? null;
  // Both renderings of the same instant: the local wall time with an explicit
  // zone label for at-a-glance reading, and the stable UTC value to quote in a
  // report. The UTC value comes from the parsed instant, so it is unaffected
  // by this operator's zone or by DST; invalid timestamps yield null and the
  // cell falls back to the relative time plus `—`.
  const timestamp = formatEventTimestamp(iso);
  return (
    <tr className={`severity-${severity}`} data-severity={severity} data-stream={event.source}>
      <td>
        <div>{labelFor(event)}</div>
        <div className="tiny muted mono">{describeGuardEvent(event)}</div>
      </td>
      <td>
        {event.decision ? (
          event.decision.result === "blocked" ? (
            <span className="pill danger">{event.decision.reason ?? "blocked"}</span>
          ) : (
            <span className="pill ok">allowed</span>
          )
        ) : (
          <span className="muted tiny">—</span>
        )}
        {event.decision?.result === "blocked" && event.decision.reason && (
          <div className="tiny muted">{explainReason(event.decision.reason)}</div>
        )}
      </td>
      <td>
        {guardLabel !== null ? (
          <span className="pill" title={event.contractId ?? "unknown contract"}>
            {guardLabel}
          </span>
        ) : (
          <span className="tiny muted">—</span>
        )}
      </td>
      <td>
        <span className={`pill${event.source === "diagnostic" ? " warn" : ""}`}>
          {event.source}
        </span>
      </td>
      <td className="mono tiny">
        {iso ? <TimeAgo iso={iso} /> : "—"}
        {timestamp && (
          <div
            className="muted"
            style={{ marginTop: 2 }}
            title={`${timestamp.local} ${timestamp.zoneLabel} · ${timestamp.utc} UTC`}
          >
            {timestamp.local} {timestamp.zoneLabel}
            <br />
            {timestamp.utc} UTC
          </div>
        )}
        {event.ledger ? (
          <div className="muted" style={{ marginTop: 2 }}>
            L{event.ledger}
          </div>
        ) : null}
      </td>
      <td>
        {event.transactionHash ? (
          <TxHashCell hash={event.transactionHash} />
        ) : (
          <span className="tiny muted">none — never broadcast</span>
        )}
      </td>
    </tr>
  );
});

const feedHead = (
  <thead>
    <tr>
      <th>Event</th>
      <th>Decision</th>
      <th>Guard</th>
      <th>Source</th>
      <th>Time</th>
      <th>Transaction</th>
    </tr>
  </thead>
);

function labelFor(event: GuardEvent): string {
  switch (event.kind) {
    case "auth_checked":
      return "Authorization decision";
    case "heartbeat":
      return "Agent heartbeat";
    case "initialized":
      return "Account initialized";
    case "frozen":
      return "Admin freeze";
    case "unfrozen":
      return "Admin unfreeze";
    case "policy_set":
      return "Policy installed";
    case "policy_revoked":
      return "Policy revoked";
    default:
      return event.topic;
  }
}
