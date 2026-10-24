import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, before, afterEach } from "node:test";
import type { ContextType, ReactElement } from "react";
import type { GuardEvent } from "stellar-agent-guard-sdk";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import { TelemetryFeed } from "../../components/TelemetryFeed.tsx";
import { GuardContext, GuardEventsContext } from "../../components/GuardProvider.tsx";
import { POLL_OFF } from "../../lib/guard/feedHealth.ts";
import { SEVERITY_TIER, severityFor } from "../../lib/guard/feedSeverity.ts";

installDom();

const GUARD = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";

let react: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: Act;

before(async () => {
  const loaded = await loadReact();
  react = loaded.react;
  createRoot = loaded.createRoot;
  act = loaded.act;
});

afterEach(() => {
  document.body.innerHTML = "";
});

/**
 * A `GuardEvent` as the SDK's decoder produces it. `source` is the SDK's
 * `GuardEventSource` stream discriminator and `decision.result` its
 * `GuardAuthResult` pair (`dist/telemetry.d.ts`); nothing here is shaped to suit
 * the renderer.
 */
function event(overrides: Partial<GuardEvent> & Pick<GuardEvent, "kind" | "source">): GuardEvent {
  return {
    topic: "event_auth_checked",
    contractId: GUARD,
    ledger: 1_000,
    ledgerClosedAt: "2026-09-25T10:00:00.000Z",
    transactionHash: "a".repeat(64),
    decision: null,
    data: {},
    ...overrides,
  } as GuardEvent;
}

const BLOCKED = event({
  kind: "auth_checked",
  source: "diagnostic",
  topic: "event_auth_checked",
  // A refusal rolls its event back, so there is no transaction and no ledger.
  ledger: null,
  transactionHash: null,
  decision: {
    result: "blocked",
    reason: "per_tx_cap_exceeded",
    source: "diagnostic",
  } as GuardEvent["decision"],
});

const ALLOWED = event({
  kind: "auth_checked",
  source: "ledger",
  decision: { result: "allowed", reason: null, source: "ledger" } as GuardEvent["decision"],
});

const LIFECYCLE = event({
  kind: "policy_revoked",
  source: "ledger",
  topic: "event_policy_revoked",
  decision: null,
});

/** A refused-simulation row that carries no decision of its own. */
const UNDETERMINED = event({
  kind: "auth_checked",
  source: "diagnostic",
  topic: "event_auth_checked",
  ledger: null,
  transactionHash: null,
  decision: null,
});

// ── The derivation ──────────────────────────────────────────────────────────

test("severityFor reads decoded fields only, one branch per row", () => {
  assert.equal(severityFor(BLOCKED), "blocked");
  assert.equal(severityFor(ALLOWED), "allowed");
  assert.equal(severityFor(LIFECYCLE), "lifecycle");
  assert.equal(severityFor(UNDETERMINED), "diagnostic");
  // A blocked decision is a block whichever stream carried it — the decision
  // outranks the stream.
  assert.equal(
    severityFor(
      event({
        kind: "auth_checked",
        source: "ledger",
        decision: {
          result: "blocked",
          reason: "admin_frozen",
          source: "ledger",
        } as GuardEvent["decision"],
      }),
    ),
    "blocked",
  );
});

test("the tiers use the two existing tokens, not new colours", () => {
  assert.deepEqual(SEVERITY_TIER, {
    blocked: "danger",
    allowed: "neutral",
    diagnostic: "warn",
    lifecycle: "neutral",
  });
});

// ── The rendered rows ───────────────────────────────────────────────────────

type GuardContextValue = NonNullable<ContextType<typeof GuardContext>>;

/**
 * The session half of the guard context, with no network behind it.
 *
 * The rows themselves are *not* here: `TelemetryFeed` reads them from
 * `GuardEventsContext`, so a stub carrying an `events` field would look right
 * and render nothing. Every field the panel touches at render time is present —
 * an omitted one is a `TypeError` in the component under test, not a gap in the
 * fixture.
 */
function contextFor() {
  return {
    guard: GUARD,
    instances: [],
    feed: {
      watching: true,
      latestLedger: 1_000,
      error: null,
      lastPolledAt: null,
      guards: [],
      capped: 0,
      cappedLabels: [],
      health: POLL_OFF,
      gaps: [],
    },
    stream: { paused: false, pendingCount: 0, dropped: 0 },
    startWatching: () => {},
    stopWatching: () => {},
    tailSelection: [],
    toggleTailedGuard: () => {},
    exportRange: null,
    clearEvents: () => {},
    pauseStream: () => {},
    resumeStream: () => {},
    queryRange: async () => {},
    rangeLabel: null,
  } as unknown as GuardContextValue;
}

async function renderFeed(events: GuardEvent[]): Promise<{
  container: HTMLElement;
  rows: () => HTMLTableRowElement[];
  rowFor: (severity: string) => HTMLTableRowElement;
  unmount: () => Promise<void>;
}> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      react.createElement(
        GuardContext.Provider,
        { value: contextFor() },
        // Two contexts, not one: `useGuardEvents` reads the live rows, which the
        // provider deliberately keeps separate from the guard session.
        react.createElement(
          GuardEventsContext.Provider,
          { value: events },
          react.createElement(TelemetryFeed),
        ),
      ),
    );
  });
  await act(async () => {
    await sleep(10);
  });
  const rows = () =>
    Array.from(container.querySelectorAll<HTMLTableRowElement>("table.events tbody tr"));
  return {
    container,
    rows,
    rowFor: (severity) => {
      const row = rows().find((candidate) => candidate.dataset.severity === severity);
      assert.ok(row, `expected a ${severity} row`);
      return row;
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

test("a blocked row is marked danger and still says why, in text", async () => {
  const rendered = await renderFeed([BLOCKED]);
  try {
    const row = rendered.rowFor("blocked");
    assert.ok(row.classList.contains("severity-blocked"), "the row must carry its severity class");
    assert.equal(row.dataset.stream, "diagnostic");
    // Not colour-only: the reason is in the row as words, and the badge is the
    // thing a screen reader reads out.
    const badge = row.querySelector(".pill.danger");
    assert.ok(badge, "a blocked row keeps its danger badge");
    assert.equal(badge.textContent, "per_tx_cap_exceeded");
    assert.match(row.textContent ?? "", /per-transaction cap/);
  } finally {
    await rendered.unmount();
  }
});

test("an allowed row is neutral and raises no alarm", async () => {
  const rendered = await renderFeed([ALLOWED]);
  try {
    const row = rendered.rowFor("allowed");
    assert.ok(row.classList.contains("severity-allowed"));
    assert.equal(row.dataset.stream, "ledger");
    assert.equal(
      row.querySelector(".pill.danger"),
      null,
      "an allowed row must not look like a block",
    );
    assert.match(row.textContent ?? "", /allowed/);
  } finally {
    await rendered.unmount();
  }
});

test("a committed lifecycle row and a diagnostic row are distinguishable", async () => {
  const rendered = await renderFeed([LIFECYCLE, UNDETERMINED]);
  try {
    const lifecycle = rendered.rowFor("lifecycle");
    const diagnostic = rendered.rowFor("diagnostic");
    // The stream discriminator, as the SDK names it, on both rows…
    assert.equal(lifecycle.dataset.stream, "ledger");
    assert.equal(diagnostic.dataset.stream, "diagnostic");
    // …and as a chip an operator reads, not only as an attribute.
    assert.match(lifecycle.textContent ?? "", /ledger/);
    assert.match(diagnostic.textContent ?? "", /diagnostic/);
    assert.ok(diagnostic.querySelector(".pill.warn"), "a diagnostic row keeps its warning chip");
    // A lifecycle event made no decision, and the row says so rather than
    // borrowing a decision word it does not have.
    assert.match(lifecycle.textContent ?? "", /Policy revoked/);
  } finally {
    await rendered.unmount();
  }
});

test("severity is an attribute on the row, not a rearrangement of its cells", async () => {
  // No layout shift: the row's child elements and their order are exactly what
  // they were before severity existed — the tier rides on the <tr>'s attributes.
  // Six cells: Event, Decision, Guard, Source, Time, Transaction.
  const rendered = await renderFeed([BLOCKED, ALLOWED, LIFECYCLE, UNDETERMINED]);
  try {
    const expected = ["TD", "TD", "TD", "TD", "TD", "TD"];
    for (const row of rendered.rows()) {
      assert.deepEqual(
        Array.from(row.children).map((cell) => cell.tagName),
        expected,
        `row severity must not change the ${row.dataset.severity} row's structure`,
      );
    }
    // And the decision cell's own children are unchanged per tier: a block still
    // carries badge-then-explanation, everything else still its single node.
    assert.deepEqual(
      Array.from(rendered.rowFor("blocked").children[1]!.children).map((node) => node.tagName),
      ["SPAN", "DIV"],
    );
    assert.deepEqual(
      Array.from(rendered.rowFor("allowed").children[1]!.children).map((node) => node.tagName),
      ["SPAN"],
    );
    assert.deepEqual(
      Array.from(rendered.rowFor("lifecycle").children[1]!.children).map((node) => node.tagName),
      ["SPAN"],
    );
  } finally {
    await rendered.unmount();
  }
});

test("the stylesheet defines the tiers from the shared tokens", () => {
  // Textual, because jsdom lays nothing out: the assertion a11yAudit already
  // makes about focus indicators, applied to severity.
  const css = readFileSync("app/globals.css", "utf8");
  assert.match(
    css,
    /table\.events tbody tr\.severity-blocked td:first-child\s*\{[^}]*inset 3px 0 0 var\(--danger\)/,
    "a blocked row must be marked from the danger token",
  );
  assert.match(
    css,
    /table\.events tbody tr\.severity-diagnostic td:first-child\s*\{[^}]*inset 3px 0 0 var\(--warn\)/,
    "a diagnostic row must be marked from the warn token",
  );
  // Allowed and lifecycle are intentionally unmarked — the tiers that shout are
  // the ones asserted, so a future "let's mark everything" edit has to be
  // deliberate.
  assert.doesNotMatch(css, /severity-allowed\s+td:first-child/);
  assert.doesNotMatch(css, /severity-lifecycle\s+td:first-child/);
  assert.match(css, /@media print[\s\S]*severity-blocked td:first-child/);
});
