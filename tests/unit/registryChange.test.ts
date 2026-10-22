import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fallbackAfterRemoval, registryAfterChange } from "../../lib/guard/registry.ts";
import type { GuardInstance } from "../../lib/guard/instance.ts";

/**
 * How a tab follows a registry change announced by another tab (#305).
 *
 * The saved registry is the authority and is re-read from storage; these two
 * pure functions decide what the tab then holds and whether the guard on screen
 * has to move. The interesting cases are the guard that only this tab knows
 * about (adopted from a link) and the guard that was just deleted.
 */

const A = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";
const B = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
const C = "CBUDXWQ6LRWPD6ONRYPZB3PMCUYYTQ2WX2NV4HDXBIPFRQ3NVTIC2UKQ";
const DEFAULT = "CDEFAULTDEFAULTDEFAULTDEFAULTDEFAULTDEFAULTDEFAULTDEFAULT";

function instance(guard: string, label: string): GuardInstance {
  return {
    guard,
    label,
    network: "testnet",
    addedAt: "2026-01-01T00:00:00.000Z",
    provenance: "Added from this browser.",
  };
}

describe("registryAfterChange", () => {
  it("takes the re-read registry as the list, including a guard another tab added", () => {
    const saved = [instance(A, "Treasury"), instance(B, "New from tab 2")];
    const result = registryAfterChange({
      saved,
      current: [instance(A, "Treasury")],
      activeGuard: A,
      notice: { kind: "add", guard: B },
    });
    assert.deepEqual(
      result.map((i) => i.guard),
      [A, B],
    );
  });

  it("shows another tab's rename", () => {
    const result = registryAfterChange({
      saved: [instance(A, "Treasury (renamed)")],
      current: [instance(A, "Treasury")],
      activeGuard: A,
      notice: { kind: "rename", guard: A },
    });
    assert.equal(result[0]!.label, "Treasury (renamed)");
  });

  it("drops a guard another tab removed", () => {
    const result = registryAfterChange({
      saved: [instance(A, "Treasury")],
      current: [instance(A, "Treasury"), instance(B, "Payroll")],
      activeGuard: A,
      notice: { kind: "remove", guard: B },
    });
    assert.deepEqual(
      result.map((i) => i.guard),
      [A],
    );
  });

  it("drops the active guard when it is the one that was removed", () => {
    const result = registryAfterChange({
      saved: [instance(A, "Treasury")],
      current: [instance(A, "Treasury"), instance(B, "Payroll")],
      activeGuard: B,
      notice: { kind: "remove", guard: B },
    });
    assert.deepEqual(
      result.map((i) => i.guard),
      [A],
    );
  });

  it("keeps a link-adopted active guard that exists only in this tab", () => {
    const adopted = instance(C, "From a link");
    const result = registryAfterChange({
      saved: [instance(A, "Treasury"), instance(B, "Payroll")],
      current: [instance(A, "Treasury"), adopted],
      activeGuard: C,
      notice: { kind: "add", guard: B },
    });
    assert.deepEqual(
      result.map((i) => i.guard),
      [A, B, C],
    );
    assert.equal(result.at(-1), adopted);
  });

  it("does not resurrect a removed guard just because it was active", () => {
    const result = registryAfterChange({
      saved: [instance(A, "Treasury")],
      current: [instance(A, "Treasury"), instance(B, "Payroll")],
      activeGuard: B,
      notice: { kind: "remove", guard: B },
    });
    assert.ok(!result.some((i) => i.guard === B));
  });

  it("does not mutate what it was given", () => {
    const saved = [instance(A, "Treasury")];
    const current = [instance(A, "Treasury"), instance(C, "From a link")];
    registryAfterChange({ saved, current, activeGuard: C, notice: { kind: "add", guard: A } });
    assert.equal(saved.length, 1);
    assert.equal(current.length, 2);
  });
});

describe("fallbackAfterRemoval", () => {
  const saved = [instance(A, "Treasury"), instance(B, "Payroll")];

  it("moves to the first remaining guard when the active one was removed elsewhere", () => {
    assert.equal(
      fallbackAfterRemoval({
        saved,
        activeGuard: C,
        notice: { kind: "remove", guard: C },
        defaultGuard: DEFAULT,
      }),
      A,
    );
  });

  it("falls back to the default guard when nothing is left", () => {
    assert.equal(
      fallbackAfterRemoval({
        saved: [],
        activeGuard: C,
        notice: { kind: "remove", guard: C },
        defaultGuard: DEFAULT,
      }),
      DEFAULT,
    );
  });

  it("stays put when a different guard was removed", () => {
    assert.equal(
      fallbackAfterRemoval({
        saved,
        activeGuard: A,
        notice: { kind: "remove", guard: C },
        defaultGuard: DEFAULT,
      }),
      null,
    );
  });

  it("stays put when the change was an add or a rename", () => {
    for (const kind of ["add", "rename"] as const) {
      assert.equal(
        fallbackAfterRemoval({
          saved,
          activeGuard: A,
          notice: { kind, guard: A },
          defaultGuard: DEFAULT,
        }),
        null,
      );
    }
  });

  it("stays put when the guard is still saved, as a build-seeded guard always is", () => {
    assert.equal(
      fallbackAfterRemoval({
        saved,
        activeGuard: A,
        notice: { kind: "remove", guard: A },
        defaultGuard: DEFAULT,
      }),
      null,
    );
  });
});
