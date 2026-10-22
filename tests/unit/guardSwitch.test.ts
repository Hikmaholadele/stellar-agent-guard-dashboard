/**
 * The GuardProvider under a guard switch: stale-read suppression and the delete
 * cascade, rendered through React so they are tested at the level the operator
 * experiences them.
 *
 * The race is the one that matters: guard A's `status()` read is still in flight
 * when the operator switches to guard B. A's read resolves *after* B's, and the
 * provider must drop it rather than paint A's numbers over B's view. The fake
 * server below hands out a deferred promise per guard so the test controls the
 * resolution order exactly.
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
import { KNOWN_INSTANCES, instanceStorageKey } from "../../lib/guard/instance.ts";
import { scopedStorageKey } from "../../lib/guard/guardScoped.ts";
import { guardStatusScVal } from "../mocks/sorobanFixtures.ts";

installDom();
// Force the storage fallback transport so no real BroadcastChannel is left open
// by the test process.
(globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = undefined;

const G0 = KNOWN_INSTANCES[0]!.guard;
const GUARD_A = "CBLQLJAG72M4XQRJMQHSKYIFVHQD7LNTNOQH2GRMCMBWMSLBSLTGTJC7";
const GUARD_B = "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB";
const SAVED = "CDEMOT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";

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
});

interface FakeServer {
  server: rpc.Server;
  statusGuards: string[];
  pending: (guard: string) => number;
  resolveStatus: (guard: string, adminFrozen: boolean) => void;
}

function statusValue(adminFrozen: boolean): xdr.ScVal {
  return guardStatusScVal({
    admin_frozen: adminFrozen,
    has_policy: true,
    heartbeat_expired: false,
    last_heartbeat: 1n,
    now: 2n,
  });
}

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

function createFakeServer(): FakeServer {
  const pendingByGuard = new Map<string, Array<(value: unknown) => void>>();
  const statusGuards: string[] = [];
  const success = (retval: xdr.ScVal) => ({
    result: { auth: [], retval },
    minResourceFee: "1",
    transactionData: undefined,
    latestLedger: 1,
  });
  const server = {
    async simulateTransaction(tx: unknown) {
      const { guard, fn } = decodeInvocation(tx);
      if (fn !== "status") return success(xdr.ScVal.scvVoid());
      statusGuards.push(guard);
      return await new Promise((resolve) => {
        const list = pendingByGuard.get(guard) ?? [];
        list.push(resolve as (value: unknown) => void);
        pendingByGuard.set(guard, list);
      });
    },
    async getLedgerEntries() {
      return { entries: [], latestLedger: 1 };
    },
    async getContractInstance() {
      throw new Error("no contract instance in the unit-test server");
    },
    async getContractWasmByContractId() {
      throw new Error("no bytecode in the unit-test server");
    },
  } as unknown as rpc.Server;
  return {
    server,
    statusGuards,
    pending: (guard) => pendingByGuard.get(guard)?.length ?? 0,
    resolveStatus: (guard, adminFrozen) => {
      const list = pendingByGuard.get(guard) ?? [];
      const resolve = list.shift();
      if (!resolve) throw new Error(`no pending status() read for ${guard}`);
      pendingByGuard.set(guard, list);
      resolve(success(statusValue(adminFrozen)));
    },
  };
}

function Probe({ guards = [], remove }: { guards?: string[]; remove?: string }): ReactElement {
  const { guard, snapshot, selectGuard, removeInstance, instances, activeInstance } = useGuard();
  const status = snapshot?.status.ok
    ? snapshot.status.value.admin_frozen
      ? "FROZEN"
      : "CLEAR"
    : "LOADING";
  return react.createElement(
    "div",
    null,
    react.createElement("span", { "data-testid": "guard" }, guard),
    react.createElement("span", { "data-testid": "status" }, status),
    react.createElement("span", { "data-testid": "count" }, String(instances.length)),
    react.createElement(
      "span",
      { "data-testid": "active-network" },
      activeInstance?.network ?? "none",
    ),
    ...guards.map((target, index) =>
      react.createElement(
        "button",
        { key: target, "data-testid": `select-${index}`, onClick: () => selectGuard(target) },
        `select ${index}`,
      ),
    ),
    remove
      ? react.createElement(
          "button",
          { "data-testid": "remove", onClick: () => removeInstance(remove) },
          "Remove",
        )
      : null,
  );
}

function text(container: HTMLElement, testid: string): string {
  return container.querySelector(`[data-testid="${testid}"]`)?.textContent ?? "";
}

async function render(
  node: ReactNode,
): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: ReturnType<typeof createRoot> | undefined;
  await act(async () => {
    root = createRoot(container);
    root.render(
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
        react.createElement(PathnameContext.Provider, { value: "/" }, node),
      ),
    );
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

async function settle(): Promise<void> {
  await act(async () => {
    await sleep(30);
  });
}

async function click(container: HTMLElement, testid: string): Promise<void> {
  await act(async () => {
    container.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`)!.click();
  });
}

test("a stale read from the previous guard never paints over the new guard", async () => {
  const fake = createFakeServer();
  const rendered = await render(
    react.createElement(GuardProvider, {
      server: fake.server,
      children: react.createElement(Probe, { guards: [GUARD_A, GUARD_B] }),
    }),
  );
  try {
    await settle();
    fake.resolveStatus(G0, false);
    await settle();
    assert.equal(text(rendered.container, "status"), "CLEAR", "the initial guard renders");

    // Switch to A; its status() read is left pending.
    await click(rendered.container, "select-0");
    await settle();
    assert.equal(text(rendered.container, "guard"), GUARD_A);
    assert.equal(fake.pending(GUARD_A), 1, "A's read is in flight");

    // Switch to B before A resolves, then resolve B.
    await click(rendered.container, "select-1");
    await settle();
    assert.equal(text(rendered.container, "guard"), GUARD_B);
    fake.resolveStatus(GUARD_B, false);
    await settle();
    assert.equal(text(rendered.container, "status"), "CLEAR", "B's read is painted");

    // Now the older read resolves. It belongs to A, so it must be dropped.
    assert.equal(fake.pending(GUARD_A), 1, "A is still pending");
    fake.resolveStatus(GUARD_A, true);
    await settle();
    assert.equal(text(rendered.container, "guard"), GUARD_B, "still on B");
    assert.equal(text(rendered.container, "status"), "CLEAR", "A's FROZEN never lands");
  } finally {
    await rendered.unmount();
  }
});

test("deleting a saved guard clears the state scoped to it and keeps other guards' state", async () => {
  const savedEntry = {
    guard: SAVED,
    label: "Saved guard",
    network: "testnet",
    addedAt: "2026-01-01T00:00:00.000Z",
    provenance: "test",
  };
  window.localStorage.setItem(instanceStorageKey("testnet"), JSON.stringify([savedEntry]));
  const savedFilterKey = scopedStorageKey("feedFilter", "testnet", SAVED);
  const otherFilterKey = scopedStorageKey("feedFilter", "testnet", GUARD_B);
  window.localStorage.setItem(savedFilterKey, JSON.stringify({ contract: "saved" }));
  window.localStorage.setItem(otherFilterKey, JSON.stringify({ contract: "other" }));

  const fake = createFakeServer();
  const rendered = await render(
    react.createElement(GuardProvider, {
      server: fake.server,
      children: react.createElement(Probe, { remove: SAVED }),
    }),
  );
  try {
    await settle();
    fake.resolveStatus(G0, false);
    await settle();
    const before = Number(text(rendered.container, "count"));
    assert.ok(before >= KNOWN_INSTANCES.length + 1, "the saved guard is in the list");

    await click(rendered.container, "remove");
    await settle();

    assert.equal(
      window.localStorage.getItem(savedFilterKey),
      null,
      "the deleted guard's state is gone",
    );
    assert.equal(
      window.localStorage.getItem(otherFilterKey),
      JSON.stringify({ contract: "other" }),
      "another guard's state is untouched",
    );
    const persisted = JSON.parse(
      window.localStorage.getItem(instanceStorageKey("testnet")) ?? "[]",
    ) as { data?: Array<{ guard: string }> };
    assert.equal(
      persisted.data?.some((entry) => entry.guard === SAVED),
      false,
      "removed from the saved list",
    );
    assert.equal(Number(text(rendered.container, "count")), before - 1);
  } finally {
    await rendered.unmount();
  }
});
