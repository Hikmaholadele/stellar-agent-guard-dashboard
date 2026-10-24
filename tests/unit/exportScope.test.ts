/**
 * Export scope preview (issue #309).
 *
 * The acceptance criteria this file exists to satisfy are "preview counts match
 * the generated export", "test empty ranges, boundary timestamps", and "do not
 * include secrets, wallet material, or unrelated browser-local data". The first
 * is asserted against the real writers (`eventsToCsv` / `eventsToJson`) rather
 * than against a second copy of the counting logic, and the last by putting a
 * payload value into an event and then looking for it in the output.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GUARD_EVENT_TOPICS } from "stellar-agent-guard-sdk";
import type { GuardEvent } from "stellar-agent-guard-sdk";
import { withIdentity } from "../mocks/eventFixtures.ts";
import { EVENT_EXPORT_COLUMNS, eventsToCsv, eventsToJson } from "../../lib/guard/eventExport.ts";
import {
  EXPORT_OMITTED_FIELDS,
  buildExportScope,
  describeExportScope,
  eventInstant,
} from "../../lib/guard/exportScope.ts";
import type { TimeRange } from "../../lib/guard/ledgerTime.ts";

const GUARD = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** Anchor every fixture on a fixed second so the range arithmetic is exact. */
const T0 = 1_760_000_000;

function isoAt(secs: number): string {
  return new Date(secs * 1000).toISOString();
}

/**
 * One event closed at `secs`.
 *
 * `observedAt` is set explicitly because the fixture's `withIdentity` defaults
 * it to a real timestamp — and this module's undated path can only be exercised
 * by an event that genuinely carries neither a close time nor an observation.
 */
function closedAt(secs: number, overrides: Partial<GuardEvent> = {}): GuardEvent {
  return withIdentity({
    kind: "auth_checked",
    topic: GUARD_EVENT_TOPICS.authChecked,
    source: "ledger",
    contractId: GUARD,
    ledger: Math.round(secs / 5),
    ledgerClosedAt: isoAt(secs),
    transactionHash: `tx-${secs}`,
    decision: { result: "allowed", reason: null, source: "ledger" },
    data: {},
    observedAt: null,
    ...overrides,
  });
}

function refused(secs: number | null, data: Record<string, unknown> = {}): GuardEvent {
  const event = withIdentity({
    kind: "auth_checked",
    topic: GUARD_EVENT_TOPICS.authChecked,
    source: "diagnostic",
    contractId: GUARD,
    ledger: null,
    ledgerClosedAt: secs === null ? null : isoAt(secs),
    transactionHash: null,
    decision: { result: "blocked", reason: "per_tx_cap_exceeded", source: "diagnostic" },
    data,
    observedAt: null,
  });
  // `withIdentity` stamps everything it builds, so an event with neither a close
  // time nor an observation — a refusal decoded straight off simulation
  // diagnostics, which is the case this scope has to handle — can only be made by
  // removing that stamp afterwards.
  return secs === null ? ({ ...event, observedAt: undefined } as unknown as GuardEvent) : event;
}

const RANGE: TimeRange = { fromUnixSecs: T0, toUnixSecs: T0 + 100 };

describe("the exact selected time range", () => {
  test("both bounds are inclusive, and one second outside either side is excluded", () => {
    const scope = buildExportScope({
      events: [
        closedAt(T0 - 1),
        closedAt(T0),
        closedAt(T0 + 50),
        closedAt(T0 + 100),
        closedAt(T0 + 101),
      ],
      range: RANGE,
    });
    assert.equal(scope.rowCount, 3, "the two boundary events and the middle one are in scope");
    assert.equal(scope.excludedByRange, 2);
    assert.equal(scope.considered, 5);
    assert.deepEqual(
      scope.rows.map((event) => event.ledgerClosedAt),
      [isoAt(T0), isoAt(T0 + 50), isoAt(T0 + 100)],
      "display order is preserved, so the file's sequence matches the preview's",
    );
  });

  test("the bounds are reported as ISO, not as the caller's seconds", () => {
    const scope = buildExportScope({ events: [], range: RANGE });
    assert.equal(scope.fromIso, isoAt(T0));
    assert.equal(scope.toIso, isoAt(T0 + 100));
    assert.equal(scope.unbounded, false);
    assert.equal(
      scope.rangeLabel,
      `${isoAt(T0)} → ${isoAt(T0 + 100)}`,
      "the label carries both bounds as ISO instants, not as raw seconds",
    );
    assert.deepEqual(describeExportScope(scope)[0], `Time range: ${scope.rangeLabel}`);
  });

  test("an empty range still says zero rows, so 'no data' is never mistaken for 'no selection'", () => {
    const scope = buildExportScope({ events: [], range: RANGE });
    assert.equal(scope.rowCount, 0);
    assert.equal(scope.considered, 0);
    assert.equal(scope.excludedByRange, 0);
    assert.equal(scope.includesDiagnostics, false);
    const lines = describeExportScope(scope);
    assert.match(lines.join("\n"), /^0 of 0 event\(s\) in scope$/m);
    assert.match(lines.join("\n"), /Diagnostics: none in range/);
  });

  test("a range that selects nothing from a full buffer is stated as excluded, not absent", () => {
    const scope = buildExportScope({
      events: [closedAt(T0 - 5_000), closedAt(T0 - 4_000)],
      range: RANGE,
    });
    assert.equal(scope.rowCount, 0);
    assert.equal(scope.excludedByRange, 2);
    assert.match(describeExportScope(scope).join("\n"), /2 outside the range excluded/);
  });

  test("one-sided ranges bound one side only", () => {
    const open = buildExportScope({
      events: [closedAt(T0 - 10), closedAt(T0), closedAt(T0 + 9_999)],
      range: { fromUnixSecs: T0, toUnixSecs: null },
    });
    assert.equal(open.rowCount, 2);
    assert.equal(open.toIso, null);
    assert.match(open.rangeLabel, /now$/, "an open upper bound is described as open");

    const head = buildExportScope({
      events: [closedAt(T0 - 10), closedAt(T0)],
      range: { fromUnixSecs: null, toUnixSecs: T0 },
    });
    assert.equal(head.rowCount, 2);
    assert.equal(head.fromIso, null);
  });

  test("the live tail is labelled as unbounded rather than as a range", () => {
    const scope = buildExportScope({ events: [closedAt(T0)] });
    assert.equal(scope.unbounded, true);
    assert.match(scope.rangeLabel, /Live tail/);
    assert.equal(
      buildExportScope({ events: [closedAt(T0)], range: null }).rangeLabel,
      scope.rangeLabel,
    );
  });

  test("a caller-supplied label overrides the computed one (the historical-query case)", () => {
    const scope = buildExportScope({ events: [], rangeLabel: "Last 24 Hours" });
    assert.equal(scope.rangeLabel, "Last 24 Hours");
    assert.equal(scope.unbounded, true, "the tail is still unbounded; only the wording changed");
  });
});

describe("diagnostic events are declared, not implied", () => {
  test("a mixed buffer reports both classes and whether refusals are included", () => {
    const scope = buildExportScope({
      events: [closedAt(T0 + 10), refused(T0 + 20), refused(T0 + 30)],
      range: RANGE,
    });
    assert.equal(scope.diagnosticRows, 2);
    assert.equal(scope.committedRows, 1);
    assert.equal(scope.includesDiagnostics, true);
    assert.match(describeExportScope(scope).join("\n"), /Diagnostics: included \(2 row\(s\)\)/);
  });

  test("a committed-only buffer says so explicitly instead of leaving the reader to infer", () => {
    const scope = buildExportScope({ events: [closedAt(T0 + 10)], range: RANGE });
    assert.equal(scope.includesDiagnostics, false);
    assert.match(describeExportScope(scope).join("\n"), /Diagnostics: none in range/);
  });

  test("a refusal with no timestamp at all is kept and counted, never silently dropped", () => {
    const scope = buildExportScope({
      events: [closedAt(T0 - 1_000), refused(null)],
      range: RANGE,
    });
    assert.equal(
      scope.rowCount,
      1,
      "the dated row outside the range went; the undated refusal stayed",
    );
    assert.equal(scope.undatedIncluded, 1);
    assert.equal(scope.excludedByRange, 1);
    assert.match(
      describeExportScope(scope).join("\n"),
      /1 undated row\(s\) included regardless of range/,
    );
  });

  test("instant falls back to the observation stamp and yields null only when there is neither", () => {
    assert.equal(eventInstant(closedAt(T0)), isoAt(T0));
    assert.equal(eventInstant(refused(null)), null, "no close time and no observation is undated");
    const observed = withIdentity({
      kind: "heartbeat",
      topic: GUARD_EVENT_TOPICS.heartbeat,
      source: "diagnostic",
      contractId: GUARD,
      ledger: null,
      ledgerClosedAt: null,
      transactionHash: null,
      decision: null,
      data: {},
      observedAt: isoAt(T0 + 5),
    });
    assert.equal(eventInstant(observed), isoAt(T0 + 5), "ledgerClosedAt wins, observedAt backs it");
  });
});

describe("the preview counts match the generated export", () => {
  test("the CSV the exporter writes has exactly the previewed number of data rows", () => {
    const events = [
      closedAt(T0 - 10),
      closedAt(T0),
      refused(T0 + 10),
      closedAt(T0 + 50),
      refused(null),
      closedAt(T0 + 500),
    ];
    const scope = buildExportScope({ events, range: RANGE });
    const csv = eventsToCsv(scope.rows, GUARD);
    const dataLines = csv
      .replace(/^\uFEFF/, "")
      .trimEnd()
      .split("\n")
      .slice(1);
    assert.equal(
      dataLines.length,
      scope.rowCount,
      "the header is not a row, and nothing else is written",
    );
    assert.equal(eventsToJson(scope.rows, GUARD).rows.length, scope.rowCount);
  });

  test("the JSON export carries the same rows in the same order as the preview", () => {
    const events = [closedAt(T0 + 20), refused(T0 + 30), closedAt(T0 + 40), closedAt(T0 + 900)];
    const scope = buildExportScope({ events, range: RANGE });
    const json = eventsToJson(scope.rows, GUARD);
    assert.equal(json.rows.length, scope.rowCount);
    assert.deepEqual(
      json.rows.map((row) => row.ledger_closed_at),
      scope.rows.map((event) => event.ledgerClosedAt),
    );
    assert.deepEqual([...json.columns], [...EVENT_EXPORT_COLUMNS]);
  });

  test("an empty preview produces a header-only file, so a disabled button and an empty file agree", () => {
    const scope = buildExportScope({ events: [closedAt(T0 + 10_000)], range: RANGE });
    assert.equal(scope.rowCount, 0);
    const csv = eventsToCsv(scope.rows, GUARD);
    assert.equal(csv.replace(/^\uFEFF/, "").trimEnd(), EVENT_EXPORT_COLUMNS.join(","));
    assert.equal(eventsToJson(scope.rows, GUARD).rows.length, 0);
  });

  test("the previewed field list is the exporter's own, so the two cannot drift apart", () => {
    const scope = buildExportScope({ events: [closedAt(T0)], range: RANGE });
    assert.deepEqual([...scope.fields], [...EVENT_EXPORT_COLUMNS]);
    assert.deepEqual([...scope.omittedFields], [...EXPORT_OMITTED_FIELDS]);
    assert.ok(
      describeExportScope(scope).join("\n").includes(EVENT_EXPORT_COLUMNS.join(", ")),
      "the named fields are the ones the writer emits",
    );
  });
});

describe("no secrets, wallet material, or browser-local data can be exported", () => {
  test("the decoded payload is named as omitted and never appears in either format", () => {
    // Whatever an event's `data` carries — a caller address, a memo, a seed-like
    // string — the export must not echo it. This is the check the issue asks for:
    // not a review of the column list, but a rejected search of the output.
    const payload = {
      by: "GSECRETWALLETSEEDS11111111111111111111111111",
      memo: "seed: my secret recovery phrase",
      amount_stroops: "5000000000",
    };
    const events = [closedAt(T0 + 10), refused(T0 + 20, payload), refused(null, payload)];
    const scope = buildExportScope({ events, range: RANGE });
    const csv = eventsToCsv(scope.rows, GUARD);
    const json = JSON.stringify(eventsToJson(scope.rows, GUARD));

    assert.deepEqual(scope.omittedFields, ["data"]);
    assert.equal((EVENT_EXPORT_COLUMNS as readonly string[]).includes("data"), false);
    for (const value of Object.values(payload)) {
      assert.ok(!csv.includes(value), `the CSV must not carry ${value}`);
      assert.ok(!json.includes(value), `the JSON must not carry ${value}`);
    }
    assert.ok(!csv.includes("recovery"), "and no fragment of it either");
  });

  test("the preview states the omission in words the operator can check", () => {
    const lines = describeExportScope(buildExportScope({ events: [], range: RANGE }));
    const last = lines[lines.length - 1] ?? "";
    assert.match(last, /Not exported: data/);
    assert.match(last, /wallet material or secrets/);
  });

  test("nothing outside the offered events reaches the scope", () => {
    // The scope's only inputs are the events array and the range; there is no
    // storage, window, or wallet accessor to assert the absence of. So the
    // assertion is the structural one: identical input, identical output.
    const events = [closedAt(T0 + 10), refused(null)];
    const a = buildExportScope({ events, range: RANGE });
    const b = buildExportScope({ events, range: RANGE });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.equal(a.rows.length, 2);
  });
});
