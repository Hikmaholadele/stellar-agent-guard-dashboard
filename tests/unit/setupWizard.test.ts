import assert from "node:assert/strict";
import { before, test } from "node:test";
import { Address, xdr } from "@stellar/stellar-sdk";
import type { ReactElement } from "react";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import { SetupWizard } from "../../components/SetupWizard.tsx";
import { StatusPanel } from "../../components/StatusPanel.tsx";
import { GuardContext } from "../../components/GuardProvider.tsx";
import type { GuardSnapshot } from "../../lib/guard/guardOps.ts";
import { SETUP_STORAGE_KEY } from "../../lib/guard/setupChecklist.ts";
import { PHASE1_ARTIFACT } from "../../lib/guard/network.ts";
import { guardStatusScVal } from "../mocks/sorobanFixtures.ts";

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

/** A server whose every method rejects, so reads settle into their error states. */
const noNetworkServer = new Proxy(
  {},
  {
    get: () => () => Promise.reject(new Error("network disabled in unit tests")),
  },
);

/**
 * A mounted snapshot for a freshly deployed guard with no policy — the exact
 * state the checklist exists to surface: default-deny.
 */
function policyMissingSnapshot(): GuardSnapshot {
  return {
    guard: GUARD,
    fetchedAt: new Date().toISOString(),
    status: {
      ok: true,
      value: {
        has_policy: false,
        admin_frozen: false,
        heartbeat_expired: false,
        last_heartbeat: 0n,
        now: 1n,
      },
    },
    policy: { ok: true, value: null },
    window: { ok: true, value: { total: 0n, entries: [] } },
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

/**
 * A snapshot whose write has *already succeeded* on chain: a policy is in
 * force. This is the state issue #394 starts from — the write landed, and what
 * can still fail is the read that verifies it.
 */
function policyInstalledSnapshot(): GuardSnapshot {
  const snapshot = policyMissingSnapshot();
  if (!snapshot.status.ok) throw new Error("the fixture snapshot starts from a successful read");
  return {
    ...snapshot,
    status: {
      ok: true,
      value: { ...snapshot.status.value, has_policy: true, last_heartbeat: 1n, now: 2n },
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
  };
}

// ── A controllable read/write server (issue #394) ───────────────────────────

function decodeInvocation(tx: unknown): { guard: string; fn: string } {
  const raw = xdr.TransactionEnvelope.fromXDR((tx as { toXDR(): string }).toXDR(), "base64");
  const body = raw.type === "envelopeTypeTx" ? raw.v1.tx.operations[0]?.body : undefined;
  const hostFunction =
    body && body.type === "invokeHostFunction" ? body.invokeHostFunctionOp.hostFunction : undefined;
  if (!hostFunction || hostFunction.type !== "hostFunctionTypeInvokeContract") {
    return { guard: "", fn: "" };
  }
  const call = hostFunction.invokeContract;
  return {
    guard: Address.fromScAddress(call.contractAddress).toString(),
    fn: String(call.functionName),
  };
}

interface SetupServer {
  server: any;
  calls: { initializeReads: number; statusReads: number; sendTransaction: number };
  setStatusMode: (mode: "fail" | "ok") => void;
  setInitializeMode: (mode: "fail" | "ok") => void;
}

/**
 * A server whose reads can be failed and recovered on demand, and whose
 * `sendTransaction` counts every attempted write — the counter the read-only
 * retry tests assert stays at zero.
 */
function createSetupServer(): SetupServer {
  const calls = { initializeReads: 0, statusReads: 0, sendTransaction: 0 };
  let statusMode: "fail" | "ok" = "fail";
  let initializeMode: "fail" | "ok" = "fail";
  const success = (retval: xdr.ScVal) => ({
    result: { auth: [], retval },
    minResourceFee: "1",
    transactionData: undefined,
    latestLedger: 1,
  });
  const server = {
    async simulateTransaction(tx: unknown) {
      const { fn } = decodeInvocation(tx);
      if (fn === "status") {
        calls.statusReads += 1;
        if (statusMode === "fail") throw new Error("RPC unavailable (fixture)");
        return success(
          guardStatusScVal({
            admin_frozen: false,
            has_policy: true,
            heartbeat_expired: false,
            last_heartbeat: 1n,
            now: 2n,
          }),
        );
      }
      // `policy()` answering void decodes as null — a successful default-deny read.
      return success(xdr.ScVal.scvVoid());
    },
    async getContractInstance() {
      calls.initializeReads += 1;
      if (initializeMode === "fail") throw new Error("instance unreachable (fixture)");
      return {
        storage: [{ key: { vec: [{ symbol: "Initialized" }] }, val: { bool: true } }],
      };
    },
    async sendTransaction() {
      calls.sendTransaction += 1;
      throw new Error("no write may ever be broadcast by a checklist retry");
    },
  } as any;
  return {
    server,
    calls,
    setStatusMode: (mode) => {
      statusMode = mode;
    },
    setInitializeMode: (mode) => {
      initializeMode = mode;
    },
  };
}

function contextValue(snapshot: GuardSnapshot, server: unknown = noNetworkServer) {
  return {
    server,
    wallet: null,
    walletError: null,
    connecting: false,
    connect: async () => {},
    disconnect: () => {},
    signer: () => {
      throw new Error("no signing in setup-wizard tests");
    },
    instances: [{ guard: GUARD, label: "Test guard", provenance: "test" }],
    guard: GUARD,
    selectGuard: () => {},
    addInstance: () => {},
    snapshot,
    snapshotError: null,
    refreshing: false,
    refresh: async () => {},
    events: [],
    feed: {
      watching: false,
      latestLedger: null,
      error: null,
      lastPolledAt: null,
      guards: [],
      capped: 0,
      cappedLabels: [],
      gaps: [],
    },
    startWatching: () => {},
    stopWatching: () => {},
    clearEvents: () => {},
    pushEvents: () => {},
    notifyTabs: () => {},
  } as any;
}

interface Rendered {
  container: HTMLElement;
  unmount: () => Promise<void>;
}

async function render(
  element: ReactElement,
  snapshot: GuardSnapshot,
  server: unknown = noNetworkServer,
): Promise<Rendered> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: ReturnType<typeof createRoot> | undefined;
  await act(async () => {
    root = createRoot(container);
    root.render(
      react.createElement(
        GuardContext.Provider,
        { value: contextValue(snapshot, server) },
        element,
      ),
    );
  });
  // Let mount effects (the initialize read) settle inside act.
  await act(async () => {
    await sleep(80);
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

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  assert.ok(button, `expected a button labelled "${text}"`);
  return button;
}

async function click(container: HTMLElement, text: string): Promise<void> {
  const button = buttonByText(container, text);
  await act(async () => {
    button.click();
  });
  await act(async () => {
    await sleep(40);
  });
}

function step(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`li[data-step="${id}"]`);
}

test("the checklist is a semantic ordered list with text status on every step", async () => {
  window.localStorage.removeItem(SETUP_STORAGE_KEY);
  const rendered = await render(react.createElement(SetupWizard), policyMissingSnapshot());
  try {
    const list = rendered.container.querySelector<HTMLOListElement>(
      "ol[data-testid='setup-steps']",
    );
    assert.ok(list, "the steps must be rendered as an ordered list");
    const items = list.querySelectorAll("li");
    assert.equal(items.length, 4, "four steps: deployed, initialized, policy, verified");

    // Status is conveyed as text (and an icon), not by colour alone.
    for (const item of Array.from(items)) {
      assert.match(
        item.textContent ?? "",
        /Done|Pending|Error/,
        "each step must carry a text status label",
      );
    }
    assert.equal(step(rendered.container, "deployed")?.dataset.state, "pending");
    assert.equal(step(rendered.container, "policy")?.dataset.state, "pending");
    assert.equal(step(rendered.container, "verified")?.dataset.state, "pending");
  } finally {
    await rendered.unmount();
  }
});

test("a dismissed wizard still leaves the default-deny warning visible (safety invariant)", async () => {
  window.localStorage.setItem(
    SETUP_STORAGE_KEY,
    JSON.stringify({ [GUARD]: { dismissed: true, deployedMarker: null } }),
  );
  const rendered = await render(
    react.createElement(
      react.Fragment,
      null,
      react.createElement(StatusPanel),
      react.createElement(SetupWizard),
    ),
    policyMissingSnapshot(),
  );
  try {
    // The wizard is hidden...
    assert.equal(
      rendered.container.querySelector("ol[data-testid='setup-steps']"),
      null,
      "the checklist steps must be hidden once dismissed",
    );
    // ...but the chain-derived warning is not concealed by that dismissal.
    // Matched loosely on the middle clause so this asserts the *banner* — the
    // safety invariant — rather than one wording of it, which `StatusPanel` owns.
    assert.match(
      rendered.container.textContent ?? "",
      /No policy installed .* in default-deny/,
      "StatusPanel must still warn about default-deny while the wizard is dismissed",
    );
    assert.ok(
      buttonByText(rendered.container, "Show setup checklist"),
      "a reopen affordance must exist",
    );
  } finally {
    await rendered.unmount();
    window.localStorage.removeItem(SETUP_STORAGE_KEY);
  }
});

test("reopening the wizard restores it with the derived steps", async () => {
  window.localStorage.setItem(
    SETUP_STORAGE_KEY,
    JSON.stringify({ [GUARD]: { dismissed: true, deployedMarker: null } }),
  );
  const rendered = await render(react.createElement(SetupWizard), policyMissingSnapshot());
  try {
    assert.equal(rendered.container.querySelector("ol[data-testid='setup-steps']"), null);
    await click(rendered.container, "Show setup checklist");
    const list = rendered.container.querySelector("ol[data-testid='setup-steps']");
    assert.ok(list, "the checklist must come back after reopening");
    assert.equal(list.querySelectorAll("li").length, 4);
    assert.equal(step(rendered.container, "policy")?.dataset.state, "pending");
  } finally {
    await rendered.unmount();
    window.localStorage.removeItem(SETUP_STORAGE_KEY);
  }
});

test("a failed verification re-read leaves step 4 in error, never optimistically green", async () => {
  window.localStorage.removeItem(SETUP_STORAGE_KEY);
  const rendered = await render(react.createElement(SetupWizard), policyMissingSnapshot());
  try {
    assert.equal(step(rendered.container, "verified")?.dataset.state, "pending");
    await click(rendered.container, "Re-verify status & policy (read-only)");

    const verified = step(rendered.container, "verified");
    assert.equal(verified?.dataset.state, "error", "a failed re-read must not turn the step green");
    assert.match(verified?.textContent ?? "", /Error/);
    assert.match(rendered.container.textContent ?? "", /verification read failed/i);
    // The recovery affordance is explicitly labelled read-only: the operator
    // must be able to tell that retrying re-reads the chain rather than
    // repeating a write (#394).
    assert.match(rendered.container.textContent ?? "", /read-only/);

    // The verification result is held in the component and derived from the
    // fetch; no local write records it.
    const raw = window.localStorage.getItem(SETUP_STORAGE_KEY);
    if (raw) {
      const entry = (JSON.parse(raw) as Record<string, Record<string, unknown>>)[GUARD] ?? {};
      assert.deepEqual([...Object.keys(entry)].sort(), ["deployedMarker", "dismissed"]);
    }
  } finally {
    await rendered.unmount();
  }
});

test("a successful write followed by a failed verification read recovers read-only, with no second write", async () => {
  window.localStorage.removeItem(SETUP_STORAGE_KEY);
  const fake = createSetupServer(); // status reads start failing; initialize already ran
  fake.setInitializeMode("ok");
  const rendered = await render(
    react.createElement(SetupWizard),
    policyInstalledSnapshot(),
    fake.server,
  );
  try {
    // The write already landed: policy installed, initialize done.
    assert.equal(step(rendered.container, "policy")?.dataset.state, "done");
    assert.equal(step(rendered.container, "initialized")?.dataset.state, "done");
    assert.equal(step(rendered.container, "verified")?.dataset.state, "pending");

    // The verification read fails after that successful write.
    await click(rendered.container, "Re-verify status & policy (read-only)");
    assert.equal(step(rendered.container, "verified")?.dataset.state, "error");
    assert.equal(fake.calls.sendTransaction, 0, "a failed read never triggers a write");

    // The RPC recovers; the operator retries the read — and only the read.
    fake.setStatusMode("ok");
    const statusReadsBefore = fake.calls.statusReads;
    await click(rendered.container, "Re-verify status & policy (read-only)");

    assert.equal(
      step(rendered.container, "verified")?.dataset.state,
      "done",
      "the fresh chain result turns step 4 green",
    );
    assert.equal(
      fake.calls.statusReads - statusReadsBefore,
      1,
      "the retry re-read status() exactly once",
    );
    assert.equal(
      fake.calls.sendTransaction,
      0,
      "recovery issued no second write — initialize and set_policy are never replayed",
    );
  } finally {
    await rendered.unmount();
  }
});

test("a failed initialize read can be re-read in place, read-only, without any write", async () => {
  window.localStorage.removeItem(SETUP_STORAGE_KEY);
  const fake = createSetupServer();
  fake.setStatusMode("ok"); // initialize reads start failing
  const rendered = await render(
    react.createElement(SetupWizard),
    policyInstalledSnapshot(),
    fake.server,
  );
  try {
    const initialized = step(rendered.container, "initialized");
    assert.equal(initialized?.dataset.state, "error", "an unreadable read is an error, not a no");
    assert.match(initialized?.textContent ?? "", /initialize state could not be read/);

    // The chain answers again; the operator re-reads just that field.
    fake.setInitializeMode("ok");
    await click(rendered.container, "Re-read initialize state (read-only)");

    assert.equal(step(rendered.container, "initialized")?.dataset.state, "done");
    assert.equal(fake.calls.initializeReads, 2, "one mount read plus exactly one manual re-read");
    assert.equal(
      fake.calls.sendTransaction,
      0,
      "the re-read is read-only — no write path is touched",
    );
  } finally {
    await rendered.unmount();
  }
});
