import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";
import type { ReactElement, ContextType } from "react";
import type axeCore from "axe-core";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import { PolicyForm } from "../../components/PolicyForm.tsx";
import { PanicPanel } from "../../components/PanicPanel.tsx";
import { DeployPanel } from "../../components/DeployPanel.tsx";
import { SetupWizard } from "../../components/SetupWizard.tsx";
import { StatusPanel } from "../../components/StatusPanel.tsx";
import { TxHistoryTable } from "../../components/TxHistoryTable.tsx";
import { TelemetryFeed } from "../../components/TelemetryFeed.tsx";
import { GuardContext, GuardEventsContext } from "../../components/GuardProvider.tsx";
import { POLL_OFF } from "../../lib/guard/feedHealth.ts";
import { TX_HISTORY_STORAGE_KEY, type TxHistoryEntry } from "../../lib/guard/txHistory.ts";
import type { GuardSnapshot } from "../../lib/guard/guardOps.ts";

type GuardEventsContextValue = NonNullable<ContextType<typeof GuardEventsContext>>;

installDom();

let react: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: Act;
let axe: typeof axeCore;

before(async () => {
  const loaded = await loadReact();
  react = loaded.react;
  createRoot = loaded.createRoot;
  act = loaded.act;
  const axeModule = (await import("axe-core")) as unknown as { default: typeof axeCore };
  axe = axeModule.default;
});

/**
 * A guard context with no network behind it. Every `server` method rejects
 * immediately, so panels whose mount effects read the chain settle into their
 * error states without a single packet leaving the process.
 */
const noNetworkServer = new Proxy(
  {},
  { get: () => () => Promise.reject(new Error("network disabled in unit tests")) },
);

const TEST_GUARD = {
  server: noNetworkServer,
  wallet: {
    address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWH",
    networkPassphrase: "Test SDF Network ; September 2015",
    network: "Testnet",
  },
  walletError: null,
  connecting: false,
  connect: async () => {},
  disconnect: () => {},
  signer: () => {
    throw new Error("no signing in a11y tests");
  },
  instances: [],
  guard: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  selectGuard: () => {},
  addInstance: () => {},
  snapshot: null,
  snapshotError: null,
  refreshing: false,
  refresh: async () => {},
  feed: {
    watching: false,
    latestLedger: null,
    error: null,
    lastPolledAt: null,
    guards: [],
    capped: 0,
    cappedLabels: [],
    health: POLL_OFF,
    gaps: [],
  },
  startWatching: () => {},
  stopWatching: () => {},
  tailSelection: [],
  toggleTailedGuard: () => {},
  exportRange: null,
  stream: { paused: false, pendingCount: 0, dropped: 0 },
  pauseStream: () => {},
  resumeStream: () => {},
  clearEvents: () => {},
  pushEvents: () => {},
  queryRange: async () => {},
  rangeLabel: null,
} as any;

interface Rendered {
  container: HTMLElement;
  unmount: () => Promise<void>;
}

async function renderPanel(element: ReactElement): Promise<Rendered> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: ReturnType<typeof createRoot> | undefined;
  await act(async () => {
    root = createRoot(container);
    root.render(element);
  });
  // Let mount effects (artifact checks, store reads) settle inside act.
  await act(async () => {
    await sleep(60);
  });
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
    },
  };
}

function renderGuarded(panel: ReactElement): ReactElement {
  // PolicySimulationView reads the live event feed through `useGuardEvents`,
  // so the events context needs an (empty) value alongside the guard context.
  return react.createElement(
    GuardEventsContext.Provider,
    { value: [] },
    react.createElement(GuardContext.Provider, { value: TEST_GUARD }, panel),
  );
}

/** Run axe-core scoped to WCAG 2.1 A/AA and return human-readable violations. */
async function axeViolations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    rules: {
      // jsdom performs no layout, so pixel contrast cannot be computed here.
      // Focus-indicator contrast is asserted separately against globals.css.
      "color-contrast": { enabled: false },
    },
  });
  return results.violations.map(
    (violation) =>
      `${violation.id} (${violation.impact}): ${violation.help} — ` +
      `${violation.nodes.length} node(s): ${violation.nodes[0]?.target.join(" ") ?? ""}`,
  );
}

async function assertCleanScan(panel: ReactElement, name: string): Promise<void> {
  const rendered = await renderPanel(panel);
  try {
    const violations = await axeViolations(rendered.container);
    assert.deepEqual(violations, [], `${name} must have zero WCAG 2.1 A/AA violations`);
  } finally {
    await rendered.unmount();
  }
}

test("PolicyForm passes automated axe-core WCAG 2.1 AA checks", async () => {
  await assertCleanScan(renderGuarded(react.createElement(PolicyForm)), "PolicyForm");
});

test("PanicPanel passes automated axe-core WCAG 2.1 AA checks", async () => {
  await assertCleanScan(renderGuarded(react.createElement(PanicPanel)), "PanicPanel");
});

test("DeployPanel passes automated axe-core WCAG 2.1 AA checks", async () => {
  await assertCleanScan(renderGuarded(react.createElement(DeployPanel)), "DeployPanel");
});

test("the freeze confirmation dialog passes axe-core while open", async () => {
  // Issue #15: this fixture's server fails every read, so the freeze-challenge
  // balance read fails too and the typed-challenge block renders here — the
  // scan below therefore covers the challenge input, its label and its error
  // association as they actually ship (basic pairing asserted directly in
  // tests/unit/panicFreezeChallenge.test.ts; full a11y checklist audit pending).
  const rendered = await renderPanel(renderGuarded(react.createElement(PanicPanel)));
  try {
    const trigger = buttonByText(rendered.container, "Freeze this account");
    await act(async () => {
      trigger.click();
    });

    const dialog = rendered.container.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog, "the confirmation must render as a dialog");
    assert.equal(dialog.getAttribute("aria-modal"), "true");
    const labelledBy = dialog.getAttribute("aria-labelledby");
    assert.ok(labelledBy, "the dialog must be labelled");
    assert.ok(
      dialog.ownerDocument.getElementById(labelledBy),
      "aria-labelledby must reference an existing element",
    );

    const violations = await axeViolations(rendered.container);
    assert.deepEqual(violations, [], "the open dialog must pass axe-core");
  } finally {
    await rendered.unmount();
  }
});

test("SetupWizard passes automated axe-core WCAG 2.1 AA checks", async () => {
  window.localStorage.removeItem("stellar-agent-guard-dashboard.setup-wizard.v1");
  try {
    await assertCleanScan(renderGuarded(react.createElement(SetupWizard)), "SetupWizard");
  } finally {
    window.localStorage.removeItem("stellar-agent-guard-dashboard.setup-wizard.v1");
  }
});

test("StatusPanel passes axe-core with the default-deny banner showing", async () => {
  // The banner is the loudest thing this interface ever renders, so it is
  // scanned in the state that makes it appear (issue #25).
  const noPolicy: GuardSnapshot = {
    guard: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    fetchedAt: "2026-09-25T10:00:00.000Z",
    status: {
      ok: true,
      value: {
        has_policy: false,
        admin_frozen: false,
        heartbeat_expired: false,
        last_heartbeat: 1_700_000_000n,
        now: 1_700_000_060n,
      },
    },
    policy: { ok: true, value: null },
    window: { ok: true, value: null },
    identity: {
      ok: true,
      value: { reportedWasmHash: null, fetchedSha256: "abc123", bytes: 39673, match: false },
    },
  };
  const context = { ...TEST_GUARD, snapshot: noPolicy };
  const rendered = await renderPanel(
    react.createElement(
      GuardContext.Provider,
      { value: context },
      react.createElement(StatusPanel),
    ),
  );
  try {
    assert.ok(
      rendered.container.querySelector("[data-tier]"),
      "the scan must have covered a render where the banner is actually present",
    );
    const violations = await axeViolations(rendered.container);
    assert.deepEqual(violations, [], "the default-deny banner must pass axe-core");
  } finally {
    await rendered.unmount();
  }
});

test("TelemetryFeed passes axe-core with severity tiers on every row kind", async () => {
  // Scanned populated, not empty: a blocked, an allowed, and a lifecycle row
  // each in the DOM, so the tier markup is what gets audited (issue #26).
  const events: unknown[] = [
    {
      kind: "auth_checked",
      topic: "event_auth_checked",
      source: "diagnostic",
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      ledger: null,
      ledgerClosedAt: null,
      transactionHash: null,
      decision: { result: "blocked", reason: "per_tx_cap_exceeded" },
      data: {},
    },
    {
      kind: "auth_checked",
      topic: "event_auth_checked",
      source: "ledger",
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      ledger: 1_000,
      ledgerClosedAt: "2026-09-25T10:00:00.000Z",
      transactionHash: "b".repeat(64),
      decision: { result: "allowed", reason: null },
      data: {},
    },
    {
      kind: "heartbeat",
      topic: "event_heartbeat",
      source: "ledger",
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      ledger: 1_000,
      ledgerClosedAt: "2026-09-25T10:00:00.000Z",
      transactionHash: null,
      decision: null,
      data: { at: 1_700_000_000 },
    },
  ];
  const context = { ...TEST_GUARD, events, feed: { ...TEST_GUARD.feed, watching: true } };
  const rendered = await renderPanel(
    react.createElement(
      GuardContext.Provider,
      { value: context },
      // TelemetryFeed reads its rows through `useGuardEvents`, which is the
      // second context — the live rows are split from the guard session on
      // purpose (see `GuardEventsContext`).
      react.createElement(
        GuardEventsContext.Provider,
        { value: events as GuardEventsContextValue },
        react.createElement(TelemetryFeed),
      ),
    ),
  );
  try {
    assert.equal(
      rendered.container.querySelectorAll("table.events tbody tr").length,
      3,
      "the scan must cover a populated feed",
    );
    const violations = await axeViolations(rendered.container);
    assert.deepEqual(violations, [], "the tiered feed must pass axe-core");
  } finally {
    await rendered.unmount();
  }
});

test("TxHistoryTable passes automated axe-core WCAG 2.1 AA checks", async () => {
  // Seed the store so the scan sees the populated table, not just empty state.
  // The timestamps are relative to now: loadTxHistory prunes records older than
  // TX_HISTORY_MAX_AGE_DAYS, so a fixed date would eventually seed nothing.
  const seeded: TxHistoryEntry[] = [
    {
      hash: "abc123def456",
      operation: "set_policy",
      status: "confirmed",
      feeStroops: "310",
      networkName: null,
      networkPassphrase: null,
      recordedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    },
    {
      hash: "789xyz012345",
      operation: "freeze",
      status: "failed",
      feeStroops: "100",
      networkName: null,
      networkPassphrase: null,
      recordedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    },
  ];
  window.localStorage.setItem(TX_HISTORY_STORAGE_KEY, JSON.stringify(seeded));
  try {
    await assertCleanScan(renderGuarded(react.createElement(TxHistoryTable)), "TxHistoryTable");
  } finally {
    window.localStorage.removeItem(TX_HISTORY_STORAGE_KEY);
  }
});

test("the freeze dialog traps keyboard focus and cycles Tab in both directions", async () => {
  // Order note (issue #15): in this fixture the typed-challenge input renders
  // *after* the acknowledgement checkbox and before the buttons, so the
  // boundary controls this test walks — first = checkbox, last = Cancel — are
  // unchanged from before the challenge existed.
  const rendered = await renderPanel(renderGuarded(react.createElement(PanicPanel)));
  try {
    const trigger = buttonByText(rendered.container, "Freeze this account");
    await act(async () => {
      trigger.click();
    });

    const dialog = rendered.container.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog);
    assert.equal(document.activeElement, dialog, "opening the dialog must move focus into it");

    // Acknowledge so every control in the dialog is enabled, then walk the trap.
    const ack = rendered.container.querySelector<HTMLInputElement>("#ack-freeze");
    assert.ok(ack);
    await act(async () => {
      ack.click();
    });

    const cancel = buttonByText(rendered.container, "Cancel");
    cancel.focus();
    assert.equal(document.activeElement, cancel);

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
      );
    });
    assert.equal(
      document.activeElement,
      ack,
      "Tab on the last control must wrap to the first control inside the dialog",
    );

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    assert.equal(
      document.activeElement,
      cancel,
      "Shift+Tab on the first control must wrap to the last control inside the dialog",
    );
  } finally {
    await rendered.unmount();
  }
});

test("Escape dismisses the dialog and restores focus to its trigger", async () => {
  const rendered = await renderPanel(renderGuarded(react.createElement(PanicPanel)));
  try {
    const trigger = buttonByText(rendered.container, "Freeze this account");
    await act(async () => {
      trigger.click();
    });
    assert.ok(rendered.container.querySelector('[role="dialog"]'));

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });

    assert.equal(
      rendered.container.querySelector('[role="dialog"]'),
      null,
      "Escape must close the dialog",
    );
    // The trigger row is re-created when the dialog closes, so the live
    // button — not the pre-open node — must be the focused element.
    const restored = buttonByText(rendered.container, "Freeze this account");
    assert.equal(
      document.activeElement,
      restored,
      "focus must return to the control that opened the dialog",
    );
  } finally {
    await rendered.unmount();
  }
});

test("the stylesheet ships the focus indicator and dialog styles the audit relies on", () => {
  // axe cannot compute visual contrast in jsdom, so the indicator itself is
  // asserted textually: every interactive element's :focus-visible rule uses
  // the accent token, whose contrast against the surfaces is documented there.
  const css = readFileSync("app/globals.css", "utf8");
  assert.match(
    css,
    /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/,
    "globals.css must define a visible :focus-visible outline in the accent colour",
  );
  assert.match(css, /\.visually-hidden\s*\{/, "a visually-hidden utility must exist");
  assert.match(css, /\.modal-backdrop\s*\{/, "modal backdrop styles must exist");
  assert.match(css, /\.modal\s*\{/, "modal card styles must exist");
});

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  assert.ok(button, `expected a button labelled "${text}"`);
  return button;
}
