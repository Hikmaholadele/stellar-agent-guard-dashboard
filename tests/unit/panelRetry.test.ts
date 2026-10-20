/**
 * The independent panel retry (issue #386), driven through the real
 * `GuardProvider` with a controllable fake server.
 *
 * Three properties are pinned here, at the level the operator experiences them:
 *
 *   1. Retrying one failed read re-invokes ONLY that read, and the other
 *      panels' successful data is left untouched — same values, same objects.
 *   2. A retry is bound to the guard it started under: if the operator
 *      switches guards while the re-read is in flight, the late response is
 *      discarded whole — not merged, not announced.
 *   3. A retry is likewise bound to the RPC server (the network context) it
 *      started against: a late response from a replaced server never paints
 *      over the new server's view.
 *
 * The fake server hands out a controllable answer per read function so the
 * test drives resolution order exactly, the way the network would not
 * cooperate in the field.
 */

import assert from "node:assert/strict";
import { afterEach, before, test } from "node:test";
import { Address, xdr } from "@stellar/stellar-sdk";
import type { rpc } from "@stellar/stellar-sdk";
import type { ReactElement, ReactNode } from "react";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import { GuardProvider, useGuard } from "../../components/GuardProvider.tsx";
import { ReadWithRetry, ReadSkeleton } from "../../components/bits.tsx";
import { KNOWN_INSTANCES } from "../../lib/guard/instance.ts";
import { clearAnnouncements, pendingAnnouncements } from "../../lib/guard/useAnnounce.ts";
import { guardStatusScVal } from "../mocks/sorobanFixtures.ts";

installDom();
// Force the storage fallback transport so no real BroadcastChannel is left open
// by the test process.
(globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = undefined;

const G0 = KNOWN_INSTANCES[0]!.guard;
const GUARD_A = "CBLQLJAG72M4XQRJMQHSKYIFVHQD7LNTNOQH2GRMCMBWMSLBSLTGTJC7";

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
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  clearAnnouncements();
});

// ── Fake server ─────────────────────────────────────────────────────────────

type PolicyMode = "ok" | "fail" | "deferred";

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

interface PanelServer {
  server: rpc.Server;
  calls: { status: number; policy: number; window: number; identity: number };
  pendingPolicy: () => number;
  setPolicyMode: (mode: PolicyMode) => void;
  /** Reject the oldest deferred policy read — a *late* failure, used as the stale response. */
  rejectPendingPolicy: () => void;
}

function createPanelServer(): PanelServer {
  const calls = { status: 0, policy: 0, window: 0, identity: 0 };
  let policyMode: PolicyMode = "ok";
  const deferred: Array<() => void> = [];
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
        calls.status += 1;
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
      if (fn === "policy") {
        calls.policy += 1;
        if (policyMode === "fail") throw new Error("policy read failed (fixture)");
        if (policyMode === "deferred") {
          return await new Promise((resolve, reject) => {
            deferred.push(() => reject(new Error("late policy failure (fixture)")));
            void resolve;
          });
        }
        // A void policy simulation decodes as `null` — a successful default-deny read.
        return success(xdr.ScVal.scvVoid());
      }
      return success(xdr.ScVal.scvVoid());
    },
    async getLedgerEntries() {
      calls.window += 1;
      return { entries: [], latestLedger: 1 };
    },
    async getContractInstance() {
      calls.identity += 1;
      throw new Error("no contract instance in the unit-test server");
    },
    async getContractWasmByContractId() {
      throw new Error("no bytecode in the unit-test server");
    },
  } as unknown as rpc.Server;
  return {
    server,
    calls,
    pendingPolicy: () => deferred.length,
    setPolicyMode: (mode) => {
      policyMode = mode;
    },
    rejectPendingPolicy: () => {
      const reject = deferred.shift();
      if (!reject) throw new Error("no deferred policy read is pending");
      reject();
    },
  };
}

// ── Probe: the panel wiring, exactly as StatusPanel wires it ────────────────

/** The last snapshot each render saw, for identity comparisons across renders. */
let lastSnapshot: ReturnType<typeof useGuard>["snapshot"] = null;

function Probe({ guards = [] }: { guards?: string[] }): ReactElement {
  const { snapshot, retryRead, retryingField, guard, selectGuard } = useGuard();
  // Recorded after every render (never during it), so the test can compare the
  // objects the panel actually rendered across a retry.
  react.useEffect(() => {
    lastSnapshot = snapshot;
  });
  return react.createElement(
    "div",
    null,
    react.createElement("span", { "data-testid": "guard" }, guard),
    react.createElement(
      "span",
      { "data-testid": "status" },
      snapshot?.status.ok ? (snapshot.status.value.admin_frozen ? "FROZEN" : "CLEAR") : "NO-STATUS",
    ),
    react.createElement(
      "span",
      { "data-testid": "window" },
      snapshot?.window.ok ? "WINDOW-OK" : "NO-WINDOW",
    ),
    snapshot
      ? react.createElement(
          "div",
          null,
          retryingField === "policy"
            ? react.createElement(ReadSkeleton, { label: "policy" })
            : null,
          react.createElement(ReadWithRetry, {
            result: snapshot.policy,
            label: "policy()",
            onRetry: () => void retryRead("policy"),
            retrying: retryingField === "policy",
            render: () => react.createElement("span", { "data-testid": "policy" }, "POLICY-OK"),
          }),
        )
      : null,
    ...guards.map((target, index) =>
      react.createElement(
        "button",
        { key: target, "data-testid": `select-${index}`, onClick: () => selectGuard(target) },
        `select ${index}`,
      ),
    ),
  );
}

function text(container: HTMLElement, testid: string): string {
  return container.querySelector(`[data-testid="${testid}"]`)?.textContent ?? "";
}

interface Rendered {
  container: HTMLElement;
  rerender: (node: ReactNode) => Promise<void>;
  unmount: () => Promise<void>;
}

async function render(node: ReactNode): Promise<Rendered> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: ReturnType<typeof createRoot> | undefined;
  const wrap = (child: ReactNode): ReactElement =>
    react.createElement(
      AppRouterContext.Provider,
      {
        value: {
          back: () => {},
          forward: () => {},
          refresh: () => {},
          hmrRefresh: () => {},
          push: () => {},
          replace: () => {},
          prefetch: async () => {},
        } as never,
      },
      react.createElement(PathnameContext.Provider, { value: "/" }, child),
    );
  await act(async () => {
    root = createRoot(container);
    root.render(wrap(node));
  });
  return {
    container,
    rerender: async (child) => {
      await act(async () => {
        root?.render(wrap(child));
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

async function settle(): Promise<void> {
  await act(async () => {
    await sleep(30);
  });
}

async function click(container: HTMLElement, selector: string): Promise<void> {
  await act(async () => {
    container.querySelector<HTMLButtonElement>(selector)!.click();
  });
}

function policyRetryButton(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector('[data-testid="retryable-policy-"] button');
}

// ── Tests ───────────────────────────────────────────────────────────────────

test("retrying the failed policy read touches nothing else: one re-read, siblings unchanged", async () => {
  const fake = createPanelServer();
  fake.setPolicyMode("fail");
  clearAnnouncements();
  const rendered = await render(
    react.createElement(GuardProvider, {
      server: fake.server,
      children: react.createElement(Probe),
    }),
  );
  try {
    await settle();
    // The initial load: status and window succeeded, policy failed and offers
    // its own retry — one panel down, the rest of the dashboard intact.
    assert.equal(text(rendered.container, "status"), "CLEAR");
    assert.equal(text(rendered.container, "window"), "WINDOW-OK");
    const block = rendered.container.querySelector('[data-testid="retryable-policy-"]');
    assert.ok(block, "the failed policy read renders its own retryable error block");
    const retryButton = policyRetryButton(rendered.container);
    assert.ok(retryButton, "the policy retry is a real button");

    const before = {
      status: fake.calls.status,
      policy: fake.calls.policy,
      window: fake.calls.window,
      identity: fake.calls.identity,
      statusValue: lastSnapshot?.status,
      windowValue: lastSnapshot?.window,
      identityValue: lastSnapshot?.identity,
    };
    assert.equal(before.policy >= 1, true, "the failed read was actually invoked");

    // The RPC recovers; the operator retries only the panel that failed.
    fake.setPolicyMode("ok");
    await click(rendered.container, '[data-testid="retryable-policy-"] button');
    await settle();

    assert.equal(fake.calls.policy, before.policy + 1, "exactly one policy re-read");
    assert.equal(fake.calls.status, before.status, "status was NOT re-invoked");
    assert.equal(fake.calls.window, before.window, "window was NOT re-invoked");
    assert.equal(fake.calls.identity, before.identity, "identity was NOT re-invoked");

    // The successful panels' data is not merely equal — it is the same objects
    // the operator was already looking at.
    assert.equal(lastSnapshot?.status, before.statusValue, "status data untouched");
    assert.equal(lastSnapshot?.window, before.windowValue, "window data untouched");
    assert.equal(lastSnapshot?.identity, before.identityValue, "identity data untouched");

    assert.equal(text(rendered.container, "policy"), "POLICY-OK", "the policy panel recovered");
    assert.equal(
      rendered.container.querySelector('[data-testid="retryable-policy-"]'),
      null,
      "the error block is gone once the read succeeds",
    );
    assert.ok(
      pendingAnnouncements().some((entry) => entry.message === "policy read recovered"),
      "the recovery is announced",
    );
  } finally {
    await rendered.unmount();
  }
});

test("a late policy retry from the previous guard is discarded, not painted over the new one", async () => {
  const fake = createPanelServer();
  fake.setPolicyMode("fail");
  clearAnnouncements();
  const rendered = await render(
    react.createElement(GuardProvider, {
      server: fake.server,
      children: react.createElement(Probe, { guards: [GUARD_A] }),
    }),
  );
  try {
    await settle();
    assert.equal(text(rendered.container, "guard"), G0);
    const retryButton = policyRetryButton(rendered.container);
    assert.ok(retryButton, "the policy read failed and offers a retry");

    // The retry starts against G0 and hangs in flight.
    fake.setPolicyMode("deferred");
    await click(rendered.container, '[data-testid="retryable-policy-"] button');
    assert.equal(fake.pendingPolicy(), 1, "the retry's read is in flight");

    // The operator switches guards while it is in flight; the new guard's own
    // reads succeed.
    fake.setPolicyMode("ok");
    await click(rendered.container, '[data-testid="select-0"]');
    await settle();
    assert.equal(text(rendered.container, "guard"), GUARD_A);
    assert.equal(text(rendered.container, "policy"), "POLICY-OK", "GUARD_A's policy is on screen");

    // Now the stale retry settles — as a failure, so an accidental merge would
    // be visible as GUARD_A's policy panel flipping back to its error block.
    fake.rejectPendingPolicy();
    await settle();

    assert.equal(text(rendered.container, "guard"), GUARD_A, "still on GUARD_A");
    assert.equal(
      text(rendered.container, "policy"),
      "POLICY-OK",
      "the previous guard's late failure never lands on the new guard's panel",
    );
    assert.equal(
      rendered.container.querySelector('[data-testid="retryable-policy-"]'),
      null,
      "no error block appears for a context the operator has left",
    );
    assert.equal(
      pendingAnnouncements().some((entry) => /policy read/.test(entry.message)),
      false,
      "a discarded retry announces nothing",
    );
  } finally {
    await rendered.unmount();
  }
});

test("a late policy retry from a replaced RPC server is discarded", async () => {
  const first = createPanelServer();
  first.setPolicyMode("fail");
  const second = createPanelServer();
  second.setPolicyMode("ok");
  clearAnnouncements();
  const provider = (server: rpc.Server): ReactElement =>
    react.createElement(GuardProvider, {
      server,
      children: react.createElement(Probe),
    });
  const rendered = await render(provider(first.server));
  try {
    await settle();
    const retryButton = policyRetryButton(rendered.container);
    assert.ok(retryButton, "the policy read failed against the first server");

    // The retry starts against the first server and hangs in flight.
    first.setPolicyMode("deferred");
    await click(rendered.container, '[data-testid="retryable-policy-"] button');
    assert.equal(first.pendingPolicy(), 1);

    // The network context changes: the provider is re-rendered against a
    // different server, whose reads all succeed.
    await rendered.rerender(provider(second.server));
    await settle();
    assert.equal(text(rendered.container, "policy"), "POLICY-OK", "the new server's read is shown");

    // The old server's retry settles late, as a failure.
    first.rejectPendingPolicy();
    await settle();

    assert.equal(
      text(rendered.container, "policy"),
      "POLICY-OK",
      "the replaced server's late failure never paints over the new server's view",
    );
    assert.equal(
      pendingAnnouncements().some((entry) => /policy read/.test(entry.message)),
      false,
      "a discarded retry announces nothing",
    );
  } finally {
    await rendered.unmount();
  }
});
