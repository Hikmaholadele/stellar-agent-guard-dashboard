/**
 * What an export is about to contain — computed before the operator downloads it.
 *
 * Issue #309. Incident and audit exports leave this console and are read by people
 * who were not in the room, so the two failures worth designing against are
 * over-sharing and under-sharing, both of which look identical from a button:
 *
 *   - A file whose time bounds the operator did not choose, because the scope was
 *     implied by whatever happened to be on screen.
 *   - A preview that counts one thing and a writer that emits another, so the
 *     number the operator confirmed is not the number in the file.
 *
 * The second one is solved structurally rather than by a test that compares two
 * code paths: `buildExportScope()` returns the **rows themselves**, and the caller
 * hands exactly those rows to `eventsToCsv()` / `eventsToJson()`. There is no
 * second selection step that could disagree, so a preview count cannot drift from
 * the file — the preview *is* the exporter's input.
 *
 * On the first: bounds are inclusive at both ends, applied to the event's own
 * authoritative instant (`ledgerClosedAt`, or `observedAt` for a diagnostic row,
 * which has no ledger to close). A row with neither is **undated** and is kept —
 * silently dropping a refused decision from an incident export because it carries
 * no timestamp would be the worse error, and pretending it fell inside the range
 * would be a lie. So undated rows are kept and counted separately, and the preview
 * says so.
 *
 * No secret or wallet material can enter, by construction rather than by review:
 * the column list is imported from `eventExport.ts` (so the preview cannot drift
 * from the exporter), and that list has no column fed by `event.data`, which is
 * where an event's decoded payload lives. The input to this module is
 * `GuardEvent[]` — nothing reads browser storage, so "unrelated browser-local
 * data" cannot be reached even accidentally.
 */

import type { GuardEvent } from "stellar-agent-guard-sdk";
import { EVENT_EXPORT_COLUMNS } from "./eventExport.ts";
import type { TimeRange } from "./ledgerTime.ts";

/**
 * The event fields the exporter deliberately never writes.
 *
 * `data` is the decoded contract payload (`{ by }` for admin events, and for an
 * auth decision whatever the caller carried). It is the only field on a
 * `GuardEvent` that can hold operator-relevant but export-sensitive material, so
 * naming the omission in the preview is what makes "secrets are not in here" a
 * statement the operator can check rather than one they must trust.
 */
export const EXPORT_OMITTED_FIELDS = ["data"] as const;

export interface ExportScope<T extends GuardEvent = GuardEvent> {
  /** Inclusive lower bound actually applied, ISO, or null when unbounded. */
  fromIso: string | null;
  /** Inclusive upper bound actually applied, ISO, or null when unbounded. */
  toIso: string | null;
  /** One-line description of the range in force, for the preview. */
  rangeLabel: string;
  /** True when neither bound was supplied, i.e. the live tail as displayed. */
  unbounded: boolean;
  /**
   * The exact rows the export will be built from. Give these to
   * `eventsToCsv()` / `eventsToJson()` and the counts above are the file's.
   */
  rows: T[];
  rowCount: number;
  /** Every event offered to the scope, before the range was applied. */
  considered: number;
  /** Dated rows that fell outside the range and were therefore dropped. */
  excludedByRange: number;
  /** Rows kept despite carrying no timestamp at all (diagnostics, mostly). */
  undatedIncluded: number;
  /** Rows produced by a refused write rather than a committed event. */
  diagnosticRows: number;
  /** Rows settled on the ledger. */
  committedRows: number;
  includesDiagnostics: boolean;
  /** The columns the file will carry, imported from the exporter itself. */
  fields: readonly string[];
  omittedFields: readonly string[];
}

/**
 * The instant an event can be placed on a timeline, or null when it cannot.
 *
 * `ledgerClosedAt` is authoritative for committed rows. `observedAt` is the SDK's
 * stamp for a diagnostic row seen through `watchAll()`; a diagnostic decoded
 * straight off simulation diagnostics has neither, and is therefore undated.
 */
export function eventInstant(event: GuardEvent): string | null {
  return event.ledgerClosedAt ?? event.observedAt ?? null;
}

function toMs(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** `null` bounds mean "no constraint on that side", matching `TimeRange`. */
function isWithin(iso: string | null, fromBound: number | null, toBound: number | null): boolean {
  if (iso === null) return true;
  const ms = toMs(iso);
  if (ms === null) return true;
  if (fromBound !== null && ms < fromBound) return false;
  if (toBound !== null && ms > toBound) return false;
  return true;
}

function isoOf(unixSecs: number | null): string | null {
  return unixSecs === null ? null : new Date(unixSecs * 1000).toISOString();
}

/**
 * Resolve the range into the rows and the numbers to show alongside them.
 *
 * Order is preserved: the export keeps whatever order the feed displayed, so the
 * preview and the file agree on sequence as well as on count.
 */
export function buildExportScope<T extends GuardEvent>(input: {
  events: readonly T[];
  range?: TimeRange | null;
  /** Overrides the range entirely when only a label is known (live tail). */
  rangeLabel?: string | null;
}): ExportScope<T> {
  const range = input.range ?? null;
  const fromSecs = range?.fromUnixSecs ?? null;
  const toSecs = range?.toUnixSecs ?? null;
  const fromMs = fromSecs === null ? null : fromSecs * 1000;
  const toMsBound = toSecs === null ? null : toSecs * 1000;

  const rows: T[] = [];
  let undatedIncluded = 0;
  for (const event of input.events) {
    const instant = eventInstant(event);
    if (instant === null) {
      undatedIncluded += 1;
      rows.push(event);
      continue;
    }
    if (isWithin(instant, fromMs, toMsBound)) rows.push(event);
  }

  const diagnosticRows = rows.filter((event) => event.source === "diagnostic").length;
  const excludedByRange = input.events.length - rows.length;

  return {
    fromIso: isoOf(fromSecs),
    toIso: isoOf(toSecs),
    unbounded: range === null || (fromSecs === null && toSecs === null),
    rangeLabel:
      input.rangeLabel ??
      (range === null
        ? "Live tail — no time bound"
        : `${isoOf(fromSecs) ?? "the beginning"} → ${isoOf(toSecs) ?? "now"}`),
    rows,
    rowCount: rows.length,
    considered: input.events.length,
    excludedByRange,
    undatedIncluded,
    diagnosticRows,
    committedRows: rows.length - diagnosticRows,
    includesDiagnostics: diagnosticRows > 0,
    fields: EVENT_EXPORT_COLUMNS,
    omittedFields: EXPORT_OMITTED_FIELDS,
  };
}

/**
 * The preview's lines, in reading order, phrased so each is checkable.
 *
 * Returned as data rather than markup so the component can label it and the unit
 * test can assert the wording without a DOM.
 */
export function describeExportScope(scope: ExportScope): string[] {
  const lines = [
    `Time range: ${scope.rangeLabel}`,
    `${scope.rowCount} of ${scope.considered} event(s) in scope` +
      (scope.excludedByRange > 0 ? `; ${scope.excludedByRange} outside the range excluded` : ""),
    `Diagnostics: ${scope.includesDiagnostics ? "included" : "none in range"}` +
      (scope.diagnosticRows > 0 ? ` (${scope.diagnosticRows} row(s))` : ""),
  ];
  if (scope.undatedIncluded > 0) {
    lines.push(
      `${scope.undatedIncluded} undated row(s) included regardless of range — a refused decision has no ledger close time`,
    );
  }
  lines.push(`Fields: ${scope.fields.join(", ")}`);
  lines.push(
    `Not exported: ${scope.omittedFields.join(", ")} — the decoded event payload, so no wallet material or secrets can appear`,
  );
  return lines;
}
