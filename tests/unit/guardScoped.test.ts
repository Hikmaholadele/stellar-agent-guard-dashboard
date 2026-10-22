/**
 * Per-guard state scoping: the key naming rule and the delete cascade.
 *
 * The isolation guarantee is the whole point — a draft or filter saved for one
 * guard must be unreachable from another, including across networks — so both
 * the positive round-trip and the negative cross-guard reads are pinned here.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SCOPED_STORAGE_BASES,
  SCOPED_STORAGE_PREFIX,
  bindToScope,
  clearGuardScopedState,
  clearScopedValue,
  guardScope,
  loadScopedValue,
  runScopedWrite,
  sameGuardScope,
  saveScopedValue,
  scopedStorageKey,
  valueInScope,
  type GuardScope,
  type ScopedOptions,
} from "../../lib/guard/guardScoped.ts";
import type { StorageLike } from "../../lib/guard/instance.ts";

const GUARD_A = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";
const GUARD_B = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";

function memoryStorage(
  initial: Record<string, string> = {},
): StorageLike & { dump(): Record<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
    dump: () => Object.fromEntries(data),
  };
}

describe("the scoped key", () => {
  it("namespaces by base, network and guard address", () => {
    const key = scopedStorageKey("feedFilter", "testnet", GUARD_A);
    assert.equal(key, `${SCOPED_STORAGE_PREFIX}.feedFilter.testnet.${GUARD_A}`);
    assert.notEqual(key, scopedStorageKey("feedFilter", "mainnet", GUARD_A));
    assert.notEqual(key, scopedStorageKey("feedFilter", "testnet", GUARD_B));
    assert.notEqual(key, scopedStorageKey("policyDraft", "testnet", GUARD_A));
  });
});

describe("round-trip and corruption", () => {
  it("stores and retrieves a value", () => {
    const storage = memoryStorage();
    saveScopedValue("feedFilter", "testnet", GUARD_A, { verdict: "blocked" }, { storage });
    assert.deepEqual(loadScopedValue("feedFilter", "testnet", GUARD_A, { storage }), {
      verdict: "blocked",
    });
  });

  it("returns null for a corrupt payload rather than throwing", () => {
    const storage = memoryStorage({
      [scopedStorageKey("feedFilter", "testnet", GUARD_A)]: "{nope",
    });
    assert.equal(loadScopedValue("feedFilter", "testnet", GUARD_A, { storage }), null);
  });

  it("is inert without storage", () => {
    const options: ScopedOptions = { storage: null };
    assert.doesNotThrow(() => saveScopedValue("feedFilter", "testnet", GUARD_A, 1, options));
    assert.equal(loadScopedValue("feedFilter", "testnet", GUARD_A, options), null);
  });
});

describe("cross-guard isolation", () => {
  it("keeps same-network, different-address entries apart", () => {
    const storage = memoryStorage();
    saveScopedValue("feedFilter", "testnet", GUARD_A, "A-blocked", { storage });
    saveScopedValue("feedFilter", "testnet", GUARD_B, "B-allowed", { storage });
    assert.equal(loadScopedValue("feedFilter", "testnet", GUARD_A, { storage }), "A-blocked");
    assert.equal(loadScopedValue("feedFilter", "testnet", GUARD_B, { storage }), "B-allowed");
  });

  it("keeps the same address on different networks apart", () => {
    const storage = memoryStorage();
    saveScopedValue("feedFilter", "testnet", GUARD_A, "testnet-view", { storage });
    saveScopedValue("feedFilter", "mainnet", GUARD_A, "mainnet-view", { storage });
    assert.equal(loadScopedValue("feedFilter", "testnet", GUARD_A, { storage }), "testnet-view");
    assert.equal(loadScopedValue("feedFilter", "mainnet", GUARD_A, { storage }), "mainnet-view");
  });
});

describe("the delete cascade", () => {
  it("clears every known base for one guard on one network, and nothing else", () => {
    const storage = memoryStorage();
    for (const base of SCOPED_STORAGE_BASES) {
      saveScopedValue(base, "testnet", GUARD_A, `${base}-A`, { storage });
      saveScopedValue(base, "testnet", GUARD_B, `${base}-B`, { storage });
      saveScopedValue(base, "mainnet", GUARD_A, `${base}-mainnet`, { storage });
    }

    clearGuardScopedState("testnet", GUARD_A, { storage });

    for (const base of SCOPED_STORAGE_BASES) {
      assert.equal(loadScopedValue(base, "testnet", GUARD_A, { storage }), null, `${base} cleared`);
      assert.equal(
        loadScopedValue(base, "testnet", GUARD_B, { storage }),
        `${base}-B`,
        `${base} kept`,
      );
      assert.equal(
        loadScopedValue(base, "mainnet", GUARD_A, { storage }),
        `${base}-mainnet`,
        `${base} on another network kept`,
      );
    }
  });

  it("clearScopedValue removes exactly one key", () => {
    const storage = memoryStorage();
    saveScopedValue("feedFilter", "testnet", GUARD_A, "x", { storage });
    clearScopedValue("feedFilter", "testnet", GUARD_A, { storage });
    assert.equal(loadScopedValue("feedFilter", "testnet", GUARD_A, { storage }), null);
  });
});

// ── Binding in-flight work to the guard that produced it (#304) ────────────

describe("guard scope", () => {
  it("is equal only for the same guard on the same network", () => {
    assert.equal(
      sameGuardScope(guardScope(GUARD_A, "testnet"), guardScope(GUARD_A, "testnet")),
      true,
    );
    assert.equal(
      sameGuardScope(guardScope(GUARD_A, "testnet"), guardScope(GUARD_B, "testnet")),
      false,
    );
    assert.equal(
      sameGuardScope(guardScope(GUARD_A, "testnet"), guardScope(GUARD_A, "mainnet")),
      false,
    );
  });

  it("is never equal to nothing", () => {
    const scope = guardScope(GUARD_A, "testnet");
    assert.equal(sameGuardScope(scope, null), false);
    assert.equal(sameGuardScope(undefined, scope), false);
    assert.equal(sameGuardScope(null, null), false);
  });

  it("hands a bound value back only while its guard and network are the active ones", () => {
    const held = bindToScope(guardScope(GUARD_A, "testnet"), { cap: "100" });
    assert.deepEqual(valueInScope(held, guardScope(GUARD_A, "testnet")), { cap: "100" });
    assert.equal(valueInScope(held, guardScope(GUARD_B, "testnet")), null);
    assert.equal(valueInScope(held, guardScope(GUARD_A, "mainnet")), null);
    assert.equal(valueInScope(null, guardScope(GUARD_A, "testnet")), null);
  });

  it("copies the scope it is bound to, so a later change to the original cannot rebind it", () => {
    const scope: GuardScope = guardScope(GUARD_A, "testnet");
    const held = bindToScope(scope, "draft");
    scope.guard = GUARD_B;
    assert.equal(valueInScope(held, guardScope(GUARD_A, "testnet")), "draft");
    assert.equal(valueInScope(held, guardScope(GUARD_B, "testnet")), null);
  });
});

describe("runScopedWrite: an approval is only ever spent on the guard it was made for", () => {
  /** A write that records every guard it was asked to build a transaction for. */
  function recorder() {
    const built: string[] = [];
    return {
      built,
      write: async (guard: string) => {
        built.push(guard);
        return `tx-for-${guard}`;
      },
    };
  }

  it("builds the transaction for the approved guard when it is still active", async () => {
    const { built, write } = recorder();
    const run = await runScopedWrite({
      approval: guardScope(GUARD_A, "testnet"),
      activeScope: () => guardScope(GUARD_A, "testnet"),
      write,
    });
    assert.deepEqual(built, [GUARD_A]);
    assert.equal(run.kind, "done");
    if (run.kind === "done") {
      assert.equal(run.result, `tx-for-${GUARD_A}`);
      assert.equal(run.stillActive, true);
    }
  });

  it("builds nothing when the guard changed after the approval and before the write", async () => {
    const { built, write } = recorder();
    // The operator approved for A, then the selection moved to B.
    const run = await runScopedWrite({
      approval: guardScope(GUARD_A, "testnet"),
      activeScope: () => guardScope(GUARD_B, "testnet"),
      write,
    });
    assert.deepEqual(built, [], "no transaction is built for B from A's approval");
    assert.equal(run.kind, "stale");
    if (run.kind === "stale") {
      assert.equal(run.approved.guard, GUARD_A);
      assert.equal(run.active.guard, GUARD_B);
    }
  });

  it("treats the same address on another network as a different guard", async () => {
    const { built, write } = recorder();
    const run = await runScopedWrite({
      approval: guardScope(GUARD_A, "testnet"),
      activeScope: () => guardScope(GUARD_A, "mainnet"),
      write,
    });
    assert.deepEqual(built, []);
    assert.equal(run.kind, "stale");
  });

  it("keeps the write on the approved guard when the selection changes during the simulation", async () => {
    let active = guardScope(GUARD_A, "testnet");
    const built: string[] = [];
    let release!: () => void;
    const simulating = new Promise<void>((resolve) => {
      release = resolve;
    });

    const pending = runScopedWrite({
      approval: guardScope(GUARD_A, "testnet"),
      activeScope: () => active,
      write: async (guard) => {
        built.push(guard); // the transaction is built for the approved guard...
        await simulating; // ...and simulated while the operator switches away
        return `signed-for-${guard}`;
      },
    });

    active = guardScope(GUARD_B, "testnet"); // switch during the simulation
    release();
    const run = await pending;

    assert.deepEqual(built, [GUARD_A], "never rebuilt or retargeted for the newly selected guard");
    assert.equal(run.kind, "done");
    if (run.kind === "done") {
      assert.equal(run.result, `signed-for-${GUARD_A}`);
      assert.equal(run.stillActive, false, "its outcome no longer belongs on B's screen");
    }
  });

  it("reports a switch away and back as still active, since it is the approved guard again", async () => {
    let active = guardScope(GUARD_A, "testnet");
    const run = await runScopedWrite({
      approval: guardScope(GUARD_A, "testnet"),
      activeScope: () => active,
      write: async () => {
        active = guardScope(GUARD_B, "testnet");
        active = guardScope(GUARD_A, "testnet");
        return "ok";
      },
    });
    assert.equal(run.kind, "done");
    if (run.kind === "done") assert.equal(run.stillActive, true);
  });

  it("lets a failing write reject instead of swallowing it", async () => {
    await assert.rejects(
      runScopedWrite({
        approval: guardScope(GUARD_A, "testnet"),
        activeScope: () => guardScope(GUARD_A, "testnet"),
        write: async () => {
          throw new Error("wallet closed");
        },
      }),
      /wallet closed/,
    );
  });
});
