/**
 * The telemetry feed's filter and export logic, kept out of the component so
 * the exact predicate and serializers the UI uses are unit-testable — and so a
 * CSV/NDJSON download is provably the *filtered* view, not a hidden superset.
 *
 * Column order is fixed and documented (it is a small public format: spreadsheets
 * and log shippers consume these files), and every row is derived from the same
 * `GuardEvent` the table renders — one row in, one line out.
 */

import type { GuardEvent } from "stellar-agent-guard-sdk";
import { neutralizeFormulaCell } from "./csv.ts";

export type VerdictFilter = "all" | "allowed" | "blocked";

export interface TelemetryFilter {
  verdict: VerdictFilter;
  /** Topic symbol (`event_heartbeat`, …) or `"all"`. */
  topic: string;
  /** Case-insensitive substring of the event's contract id; `""` disables it. */
  contract: string;
}

export const ALL_TOPICS = "all";

export const EMPTY_TELEMETRY_FILTER: TelemetryFilter = {
  verdict: "all",
  topic: ALL_TOPICS,
  contract: "",
};

/**
 * Apply the feed's three controls.
 *
 * The verdict filter only constrains events that *have* a decision: a
 * heartbeat neither was allowed nor was blocked, so "Allowed Only" and
 * "Blocked Only" both exclude it rather than pretending it carries a verdict.
 */
// Generic so a richer event (one carrying its raw XDR) survives filtering intact.
export function filterGuardEvents<T extends GuardEvent>(
  events: readonly T[],
  filter: TelemetryFilter,
): T[] {
  const contract = filter.contract.trim().toLowerCase();
  return events.filter((event) => {
    if (filter.verdict !== "all" && event.decision?.result !== filter.verdict) return false;
    if (filter.topic !== ALL_TOPICS && event.topic !== filter.topic) return false;
    if (contract.length > 0 && !(event.contractId ?? "").toLowerCase().includes(contract)) {
      return false;
    }
    return true;
  });
}

/**
 * The CSV header, in order. `data` is the event body as compact JSON — it is
 * quoted like any other field, so a body containing commas or newlines stays
 * one cell.
 */
export const TELEMETRY_CSV_COLUMNS = [
  "kind",
  "topic",
  "decision",
  "reason",
  "source",
  "ledger",
  "ledger_closed_at",
  "transaction_hash",
  "contract_id",
  "data",
] as const;

/** Compact JSON that survives `bigint` (ScVal decoding produces them). */
function dataJson(data: unknown): string {
  return JSON.stringify(data, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function csvRow(cells: string[]): string {
  return cells.map(csvCell).join(",");
}

function rowCells(event: GuardEvent): string[] {
  return [
    event.kind,
    event.topic,
    event.decision?.result ?? "",
    event.decision?.reason ?? "",
    event.source,
    event.ledger === null || event.ledger === undefined ? "" : String(event.ledger),
    event.ledgerClosedAt ?? "",
    event.transactionHash ?? "",
    event.contractId ?? "",
    dataJson(event.data),
  ];
}

/** The events as CSV: fixed header, one row per event, trailing newline. */
export function telemetryToCsv(events: GuardEvent[]): string {
  const lines = [csvRow([...TELEMETRY_CSV_COLUMNS])];
  for (const event of events) {
    const cells = rowCells(event).map(neutralizeFormulaCell);
    lines.push(csvRow(cells));
  }
  return `${lines.join("\n")}\n`;
}

/** One JSON document per line (trailing newline), for log pipelines. */
export function telemetryToNdjson(events: GuardEvent[]): string {
  const lines = events.map((event) => {
    const [kind, topic, decision, reason, source, ledger, closedAt, hash, contractId, data] =
      rowCells(event);
    return JSON.stringify({
      kind,
      topic,
      decision,
      reason,
      source,
      ledger,
      ledger_closed_at: closedAt,
      transaction_hash: hash,
      contract_id: contractId,
      data: JSON.parse(data ?? "null") as unknown,
    });
  });
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
