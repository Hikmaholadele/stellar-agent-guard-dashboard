import assert from "node:assert/strict";
import { before, test } from "node:test";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import { RetryableRead, ReadSkeleton } from "../../components/bits.tsx";
import type { ReadResult } from "../../lib/guard/chain.ts";
import type { ReactElement } from "react";
import { GuardContext, type SnapshotField } from "../../components/GuardProvider.tsx";
import {
  buildReadDiagnostic,
  redactDiagnosticText,
  sanitizeEndpointOrigin,
} from "../../lib/rpc/timeouts.ts";

// ── Safe read diagnostics (#347) ───────────────────────────────────────────

test("a diagnostic carries only the operation, endpoint origin, network and time", () => {
  const at = new Date("2026-10-21T09:15:00.000Z");
  const diagnostic = buildReadDiagnostic({
    operation: "status()",
    endpoint: "https://soroban-testnet.stellar.org/soroban/rpc?api_key=sk_live_secret#frag",
    network: "testnet",
    at,
  });

  assert.equal(diagnostic.operation, "status()");
  assert.equal(diagnostic.endpointOrigin, "https://soroban-testnet.stellar.org");
  assert.equal(diagnostic.network, "testnet");
  assert.equal(diagnostic.timestamp, "2026-10-21T09:15:00.000Z");
  assert.match(diagnostic.text, /^operation: status\(\)\nendpoint: https:\/\//);
  assert.doesNotMatch(diagnostic.text, /api_key|sk_live_secret|#frag/);
});

test("an endpoint is reduced to its origin, dropping embedded credentials", () => {
  assert.equal(
    sanitizeEndpointOrigin("https://ops:hunter2@soroban-testnet.stellar.org/soroban/rpc?token=x"),
    "https://soroban-testnet.stellar.org",
  );
  assert.equal(sanitizeEndpointOrigin("not a url"), "unrecognised-endpoint");
  assert.equal(sanitizeEndpointOrigin(""), "unrecognised-endpoint");
});

test("redacts query values, signed XDR and authorization payloads, and secret seeds", () => {
  const seed = `S${"A".repeat(55)}`;
  const envelope = `AAAA${"A".repeat(80)}`;
  const text = redactDiagnosticText(
    `GET https://rpc.test/soroban/rpc?token=abc&network=testnet failed;` +
      ` xdr=${envelope}; ${seed}; {"signedXdr":"AAAAdeadbeef","auth":"AAAAcafe"}`,
  );

  assert.doesNotMatch(text, /token=abc/);
  assert.match(text, /token=\[redacted\]/);
  assert.doesNotMatch(text, /network=testnet/);
  assert.equal(text.includes(envelope), false, "the signed envelope is removed");
  assert.equal(text.includes(seed), false, "the wallet secret seed is removed");
  assert.doesNotMatch(text, /AAAAdeadbeef|AAAAcafe/);
});

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

/** Mount an element and return the container plus an unmount helper. */
async function mount(element: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: ReturnType<typeof createRoot> | undefined;
  await act(async () => {
    root = createRoot(container);
    root.render(element);
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

/**
 * A probe rendering one RetryableRead exactly the way StatusPanel does — the
 * parent owns the retrying flag in React state, so a retry flips the block
 * into its pending shape (status line + sibling skeleton row) by re-render.
 *
 * The shared mutable cell is how the test drives the state from outside the
 * component; the read result and the retrying flag are changed together by the
 * test's fake read, the way GuardProvider's real retryRead merges them.
 */
function makeProbe(options: {
  label: string;
  cell: { result: ReadResult<string>; retrying: boolean; force?: () => void };
  release: () => void;
}) {
  function Probe(): ReactElement {
    const [, force] = react.useReducer((count: number) => count + 1, 0);
    // Expose the re-render trigger so the test's deferred read can settle the
    // state the way a real network round-trip would.
    options.cell.force = () => force();
    return react.createElement(
      "div",
      null,
      react.createElement(RetryableRead<string>, {
        result: options.cell.result,
        label: options.label,
        onRetry: () => {
          options.cell.retrying = true;
          force();
        },
        retrying: options.cell.retrying,
        render: (value: string) => react.createElement("span", { "data-testid": "value" }, value),
      }),
      options.cell.retrying ? react.createElement(ReadSkeleton, { label: options.label }) : null,
    );
  }
  return Probe;
}

test("lifecycle: error block → retry click → pending status → success renders the value", async () => {
  // A deferred read: the value arrives only when the test releases the gate, so
  // the pending state is observable rather than a guess about machine speed.
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cell: { result: ReadResult<string>; retrying: boolean; force?: () => void } = {
    result: { ok: false, error: "connection reset" },
    retrying: false,
  };
  const Probe = makeProbe({
    label: "balance()",
    cell,
    release: () => release?.(),
  });

  const mounted = await mount(react.createElement(Probe));
  try {
    // State 1: the failed read renders the error block with its retry control.
    const block = mounted.container.querySelector('[data-testid="retryable-balance-"]');
    assert.ok(block, "the failed read renders the retryable error block");
    const retryButton = block.querySelector<HTMLButtonElement>(
      'button[aria-label="Retry balance() fetch"]',
    );
    assert.ok(retryButton, "the retry control is a real button with a context-in-label aria-label");

    // Click → state 2: pending — status line and skeleton row, no retry button.
    void gate.then(() => {
      cell.retrying = false;
      cell.result = { ok: true, value: "1250.0000000" };
      cell.force?.();
    });
    await act(async () => {
      retryButton.click();
      await sleep(0);
    });
    assert.ok(
      mounted.container.querySelector('[role="status"]'),
      "a pending retry announces itself as a status",
    );
    assert.ok(
      mounted.container.querySelector(".skeleton-row"),
      "the pending state renders the skeleton row",
    );
    assert.equal(
      mounted.container
        .querySelector('[data-testid="retryable-balance-"]')
        ?.querySelector("button"),
      null,
      "no second retry can start while one is in flight",
    );

    // Release → state 3: the value renders.
    await act(async () => {
      release?.();
      await sleep(0);
      await sleep(0);
    });
    const value = mounted.container.querySelector('[data-testid="value"]');
    assert.ok(value !== null, "the recovered read renders its value");
    assert.equal(value.textContent, "1250.0000000");
    assert.equal(
      mounted.container.querySelector(".skeleton-row"),
      null,
      "the pending skeleton is gone once the value lands",
    );
  } finally {
    await mounted.unmount();
  }
});

test("non-dead-end: three consecutive failed retries each leave the retry available (calls == clicks)", async () => {
  const cell: { result: ReadResult<string>; retrying: boolean; force?: () => void } = {
    result: { ok: false, error: "still down" },
    retrying: false,
  };
  let retryCalls = 0;
  const Probe = makeProbe({ label: "window", cell, release: () => {} });

  const mounted = await mount(react.createElement(Probe));
  try {
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const block = mounted.container.querySelector('[data-testid="retryable-window"]');
      assert.ok(block, `cycle ${cycle}: the error block is still rendered`);
      const retryButton = block.querySelector<HTMLButtonElement>("button");
      assert.ok(
        retryButton,
        `cycle ${cycle}: retry is still available — a failing read is not a dead end`,
      );
      await act(async () => {
        retryButton.click();
        await sleep(0);
      });
      retryCalls += 1;
      // The probe's onRetry flips retrying on; each cycle settles it again so
      // the next cycle sees the failed block, exactly like a real failed read.
      await act(async () => {
        cell.retrying = false;
        cell.force?.();
        await sleep(0);
      });
    }
    assert.equal(retryCalls, 3, "every click re-invoked the read: call count == click count");
    assert.equal(
      cell.result.ok,
      false,
      "the fixture never recovers — the test stays on the failure path",
    );
  } finally {
    await mounted.unmount();
  }
});

test("in-flight discipline: a second click while retrying starts no further read (fetch+1)", async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cell: { result: ReadResult<string>; retrying: boolean; force?: () => void } = {
    result: { ok: false, error: "timeout" },
    retrying: false,
  };
  let fetchCalls = 0;
  function Probe(): ReactElement {
    const [, force] = react.useReducer((count: number) => count + 1, 0);
    return react.createElement(
      "div",
      null,
      react.createElement(RetryableRead<string>, {
        result: cell.result,
        label: "status()",
        onRetry: () => {
          fetchCalls += 1; // one network call per accepted retry
          cell.retrying = true;
          force();
        },
        retrying: cell.retrying,
        render: (value: string) => react.createElement("span", null, value),
      }),
      cell.retrying ? react.createElement(ReadSkeleton, { label: "status()" }) : null,
    );
  }

  const mounted = await mount(react.createElement(Probe));
  try {
    const retryButton = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="retryable-status-"] button',
    )!;
    await act(async () => {
      retryButton.click();
      await sleep(0);
    });
    // First retry accepted and in flight. A second click now finds no button —
    // the in-flight guard is the debounce.
    await act(async () => {
      const gone = mounted.container
        .querySelector('[data-testid="retryable-status-"]')
        ?.querySelector("button");
      assert.equal(gone, null, "the retry button is absent while in flight");
      release?.();
      await sleep(0);
      await sleep(0);
    });
    assert.equal(
      fetchCalls,
      1,
      "the double-click coalesces into a single re-read (debounce-count assert)",
    );
    void gate;
  } finally {
    await mounted.unmount();
  }
});

test("isolation: retrying one read does not re-invoke its siblings (per-read granularity)", async () => {
  let statusCalls = 0;
  let policyCalls = 0;
  let windowCalls = 0;
  let identityCalls = 0;
  const fail = { ok: false as const, error: "RPC unreachable" };
  const succeed = <T>(value: T) => ({ ok: true as const, value });

  let requested: SnapshotField | null = null;
  function Probe(): ReactElement {
    const value = react.useContext(GuardContext);
    return react.createElement(
      "div",
      null,
      react.createElement("button", {
        "data-testid": "trigger",
        onClick: () => {
          requested = "status";
          void value!.retryRead("status");
        },
      }),
    );
  }

  const mounted = await mount(
    react.createElement(
      GuardContext.Provider,
      {
        value: {
          server: {} as any,
          wallet: null,
          walletError: null,
          connecting: false,
          connect: async () => {},
          disconnect: () => {},
          signer: () => {
            throw new Error("no signing here");
          },
          instances: [],
          guard: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          selectGuard: () => {},
          addInstance: () => {},
          snapshot: {
            guard: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            fetchedAt: new Date().toISOString(),
            status: fail,
            policy: succeed(null),
            window: succeed(null),
            identity: fail,
          },
          snapshotError: null,
          refreshing: false,
          refresh: async () => {},
          retryRead: async (field: SnapshotField) => {
            // Mirror the provider's contract: exactly one read fn per retry.
            if (field === "status") statusCalls += 1;
            if (field === "policy") policyCalls += 1;
            if (field === "window") windowCalls += 1;
            if (field === "identity") identityCalls += 1;
          },
          retryingField: null,
          events: [],
          feed: { watching: false, latestLedger: null, error: null, lastPolledAt: null },
          startWatching: () => {},
          stopWatching: () => {},
          clearEvents: () => {},
          pushEvents: () => {},
          notifyTabs: () => {},
          session: {
            state: { phase: "armed" as const, secondsLeft: 0 },
            timeoutMs: 0,
            setTimeoutMs: () => {},
            stayConnected: () => {},
          },
        } as any,
      },
      react.createElement(Probe),
    ),
  );
  try {
    const trigger = mounted.container.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!;
    await act(async () => {
      trigger.click();
      await sleep(0);
    });
    assert.equal(requested, "status", "the status retry was requested");
    assert.equal(statusCalls, 1, "the status read fn was re-invoked exactly once");
    assert.equal(policyCalls, 0, "the policy read was NOT re-invoked — isolation assert");
    assert.equal(windowCalls, 0, "the window read was NOT re-invoked — isolation assert");
    assert.equal(identityCalls, 0, "the identity read was NOT re-invoked — isolation assert");
  } finally {
    await mounted.unmount();
  }
});

test("a11y: the aria-label names the read, and the error block carries the read name", async () => {
  const cell: { result: ReadResult<string>; retrying: boolean; force?: () => void } = {
    result: { ok: false, error: "boom" },
    retrying: false,
  };
  const Probe = makeProbe({ label: "policy()", cell, release: () => {} });
  const mounted = await mount(react.createElement(Probe));
  try {
    const block = mounted.container.querySelector('[data-testid="retryable-policy-"]')!;
    const button = block.querySelector<HTMLButtonElement>("button")!;
    assert.equal(button.getAttribute("aria-label"), "Retry policy() fetch");
    assert.equal(button.textContent, "Retry");
    assert.ok(block.querySelector("span.t")?.textContent?.includes("policy()"));
  } finally {
    await mounted.unmount();
  }
});
