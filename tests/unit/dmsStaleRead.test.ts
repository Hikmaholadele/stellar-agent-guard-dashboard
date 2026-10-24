/**
 * The dead-man countdown banner under a stale ledger read (issue #389).
 *
 * The rule being pinned: a countdown that derives from a read the console has
 * not refreshed within the ledger clock's freshness bound (`LEDGER_CLOCK_MAX_AGE_SECS`)
 * is presented as *uncertain* — the
 * banner keeps the ledger-derived numbers (an old deadline is shown as old,
 * never re-derived from the local clock) and says the read is stale. The next
 * fresh read removes the caveat without touching the countdown itself.
 *
 * The two snapshots differ only in `fetchedAt` and the ledger's own `now`, so
 * the only thing that can flip the caveat is a fresh ledger-time update.
 */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { ReactElement } from "react";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import { StatusPanel } from "../../components/StatusPanel.tsx";
import { GuardContext } from "../../components/GuardProvider.tsx";
import type { GuardSnapshot } from "../../lib/guard/guardOps.ts";
import { PHASE1_ARTIFACT } from "../../lib/guard/network.ts";

installDom();

let react: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: Act;

before(async () => {
  const loaded = await loadReact();
  react = loaded.react;
  createRoot = loaded.createRoot;
  act = loaded.act;
});

const GUARD = "CBLQLJAG72M4XQRJMQHSKYIFVHQD7LNTNOQH2GRMCMBWMSLBSLTGTJC7";

/** The context StatusPanel reads, wired exactly as the provider wires it. */
function contextValue(snapshot: GuardSnapshot) {
  return {
    server: {} as never,
    wallet: null,
    walletError: null,
    connecting: false,
    connect: async () => {},
    disconnect: () => {},
    signer: () => {
      throw new Error("no signing in this test");
    },
    instances: [{ guard: GUARD, label: "Test guard", provenance: "test" }],
    guard: GUARD,
    selectGuard: () => {},
    addInstance: () => {},
    snapshot,
    snapshotError: null,
    refreshing: false,
    refresh: async () => {},
    retryRead: async () => {},
    retryingField: null,
    events: [],
    feed: {
      watching: false,
      latestLedger: null,
      error: null,
      lastPolledAt: null,
      guards: [],
      capped: 0,
      cappedLabels: [],
    },
    startWatching: () => {},
    stopWatching: () => {},
    clearEvents: () => {},
    pushEvents: () => {},
    notifyTabs: () => {},
  } as any;
}

/**
 * A snapshot with a near-deadline countdown (300s of a 100 000s grace left),
 * fetched at `fetchedAtMs` and reporting ledger `now`.
 */
function countdownSnapshot(fetchedAtMs: number, ledgerNow: bigint): GuardSnapshot {
  return {
    guard: GUARD,
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    status: {
      ok: true,
      value: {
        has_policy: true,
        admin_frozen: false,
        heartbeat_expired: false,
        last_heartbeat: 1_000_000n,
        now: ledgerNow,
      },
    },
    policy: {
      ok: true,
      value: {
        per_tx_cap: 1_000n,
        window_secs: 3_600n,
        window_cap: 10_000n,
        assets: [],
        protocols: [],
        recipients: [],
        allow_any_recipient: false,
        active_from: 0n,
        active_until: 0n,
        paused: false,
        dms_grace_secs: 100_000n,
      },
    },
    window: { ok: true, value: null },
    identity: {
      ok: true,
      value: {
        reportedWasmHash: PHASE1_ARTIFACT.wasmHash,
        fetchedSha256: PHASE1_ARTIFACT.wasmHash,
        bytes: PHASE1_ARTIFACT.wasmBytes,
        match: true,
      },
    },
  };
}

async function render(snapshot: GuardSnapshot): Promise<{
  container: HTMLElement;
  rerender: (next: GuardSnapshot) => Promise<void>;
  unmount: () => Promise<void>;
}> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: ReturnType<typeof createRoot> | undefined;
  const mount = (value: GuardSnapshot): ReactElement =>
    react.createElement(
      GuardContext.Provider,
      { value: contextValue(value) },
      react.createElement(StatusPanel),
    );
  await act(async () => {
    root = createRoot(container);
    root.render(mount(snapshot));
  });
  return {
    container,
    rerender: async (next) => {
      await act(async () => {
        root?.render(mount(next));
      });
    },
    unmount: async () => {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
    },
  };
}

test("a stale read's countdown is marked uncertain; a fresh read removes the caveat", async () => {
  const now = Date.now();
  // Ten minutes old — far beyond the staleness threshold — with a live
  // near-deadline countdown frozen at the ledger time it was read at.
  const stale = await render(countdownSnapshot(now - 10 * 60_000, 1_099_700n));
  try {
    const banner = stale.container.querySelector(".dms-banner");
    assert.ok(banner, "the countdown banner renders");
    assert.match(banner.textContent ?? "", /5m 0s of grace left/, "the ledger-derived figure");
    const note = stale.container.querySelector('[data-testid="dms-stale-note"]');
    assert.ok(note, "the stale read is labelled uncertain");
    assert.match(note.textContent ?? "", /stale read/);
    assert.match(note.textContent ?? "", /not a fresh deadline/);

    // The next successful ledger-time update: same countdown window, newer
    // read, ledger clock advanced by exactly the same seconds.
    await stale.rerender(countdownSnapshot(Date.now(), 1_099_715n));
    assert.equal(
      stale.container.querySelector('[data-testid="dms-stale-note"]'),
      null,
      "a fresh read removes the uncertainty note",
    );
    assert.match(
      stale.container.querySelector(".dms-banner")?.textContent ?? "",
      /4m 45s of grace left/,
      "the countdown itself moved only by the ledger's own seconds",
    );
  } finally {
    await stale.unmount();
  }
});

test("a fresh read carries no caveat at all", async () => {
  const rendered = await render(countdownSnapshot(Date.now(), 1_099_700n));
  try {
    assert.ok(rendered.container.querySelector(".dms-banner"), "the banner renders");
    assert.equal(
      rendered.container.querySelector('[data-testid="dms-stale-note"]'),
      null,
      "a fresh read is presented as current",
    );
  } finally {
    await rendered.unmount();
  }
});
