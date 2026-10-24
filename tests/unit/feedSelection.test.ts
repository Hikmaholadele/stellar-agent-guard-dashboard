/**
 * Operator-chosen feed tailing (issue #310).
 *
 * Two halves: the plan itself (does the operator's choice decide who gets the
 * capped slots?), and the supervisor that consumes it (does a changed choice
 * start and stop listeners without leaking any?). Storage is always injected,
 * so nothing here depends on a browser — and every read path is exercised with
 * a hostile record, because a tail selection is input, not truth.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  FEED_GUARD_CAP,
  MultiGuardFeed,
  type FeedSource,
  type GuardFeedLike,
} from "../../lib/guard/feedSubscriptions.ts";
import {
  TAIL_SELECTION_PREFIX,
  TAIL_SELECTION_SCHEMA,
  TAIL_SELECTION_VERSION,
  clearTailSelection,
  dedupeGuardList,
  loadTailSelection,
  planTailSources,
  prunePinned,
  saveTailSelection,
  tailSelectionStorageKey,
  type SelectionStorage,
} from "../../lib/guard/feedSelection.ts";

const GUARD_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const GUARD_B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const GUARD_C = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const GUARD_D = "CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
const GUARD_E = "CEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";
const GUARD_F = "CFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF";
const GUARD_G = "CGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG";

const NETWORK = "Test SDF Network ; epoch 0";
const OTHER_NETWORK = "Public Network";

function source(guard: string, label: string): FeedSource {
  return { guard, label };
}

const REGISTRY: FeedSource[] = [
  source(GUARD_A, "Guard A"),
  source(GUARD_B, "Guard B"),
  source(GUARD_C, "Guard C"),
  source(GUARD_D, "Guard D"),
  source(GUARD_E, "Guard E"),
  source(GUARD_F, "Guard F"),
  source(GUARD_G, "Guard G"),
];

/** A records-only double: this module must never touch a real `Storage`. */
function fakeStorage(initial: Record<string, string> = {}): SelectionStorage & {
  records: Map<string, string>;
} {
  const records = new Map(Object.entries(initial));
  return {
    records,
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => {
      records.set(key, value);
    },
    removeItem: (key: string) => {
      records.delete(key);
    },
  };
}

function envelope(data: unknown): string {
  return JSON.stringify({
    schema: TAIL_SELECTION_SCHEMA,
    version: TAIL_SELECTION_VERSION,
    data,
  });
}

describe("the choice is remembered per network, and only as public addresses", () => {
  test("the key is namespaced by network, so two networks never share a tail set", () => {
    assert.equal(tailSelectionStorageKey("testnet"), `${TAIL_SELECTION_PREFIX}.testnet`);
    const storage = fakeStorage();
    assert.ok(saveTailSelection([GUARD_A], { network: NETWORK, storage }));
    assert.ok(saveTailSelection([GUARD_B, GUARD_C], { network: OTHER_NETWORK, storage }));
    assert.deepEqual(loadTailSelection({ network: NETWORK, storage }), [GUARD_A]);
    assert.deepEqual(loadTailSelection({ network: OTHER_NETWORK, storage }), [GUARD_B, GUARD_C]);
    assert.equal(storage.records.size, 2, "one record per network, no third bucket");
  });

  test("a saved selection survives a reload, in the operator's own order", () => {
    const storage = fakeStorage();
    saveTailSelection([GUARD_C, GUARD_A, GUARD_B], { network: NETWORK, storage });
    // "Reload" is a fresh read of the same storage with no in-memory state left.
    assert.deepEqual(loadTailSelection({ network: NETWORK, storage }), [GUARD_C, GUARD_A, GUARD_B]);
  });

  test("the stored record is the versioned envelope, and only addresses are in it", () => {
    const storage = fakeStorage();
    saveTailSelection([GUARD_A, GUARD_A, "  "], { network: NETWORK, storage });
    const raw = storage.records.get(tailSelectionStorageKey(NETWORK))!;
    const parsed = JSON.parse(raw) as { schema: string; version: number; data: unknown };
    assert.equal(parsed.schema, TAIL_SELECTION_SCHEMA);
    assert.equal(parsed.version, TAIL_SELECTION_VERSION);
    assert.deepEqual(parsed.data, [GUARD_A], "duplicates and blanks are never persisted");
    assert.doesNotMatch(raw, /secret|seed|private|key|token|label/i);
  });

  test("clearing forgets the network's record and nothing else", () => {
    const storage = fakeStorage();
    saveTailSelection([GUARD_A], { network: NETWORK, storage });
    saveTailSelection([GUARD_B], { network: OTHER_NETWORK, storage });
    clearTailSelection({ network: NETWORK, storage });
    assert.deepEqual(loadTailSelection({ network: NETWORK, storage }), []);
    assert.deepEqual(loadTailSelection({ network: OTHER_NETWORK, storage }), [GUARD_B]);
  });

  test("a rejected write is reported, because the session's choice still applies", () => {
    const refusing: SelectionStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    assert.equal(saveTailSelection([GUARD_A], { network: NETWORK, storage: refusing }), false);
  });

  test("a storage that throws on read is read as no selection rather than thrown through", () => {
    const hostile: SelectionStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {},
    };
    assert.deepEqual(loadTailSelection({ network: NETWORK, storage: hostile }), []);
  });

  test("absent, corrupt, foreign-schema, future-versioned and wrong-typed records all read as empty", () => {
    const cases: Array<[string, string | null]> = [
      ["absent", null],
      ["not json", "{{{"],
      ["bare array (no envelope)", JSON.stringify([GUARD_A])],
      ["foreign schema", JSON.stringify({ schema: "other/thing", version: 1, data: [GUARD_A] })],
      [
        "future version",
        JSON.stringify({
          schema: TAIL_SELECTION_SCHEMA,
          version: TAIL_SELECTION_VERSION + 5,
          data: [GUARD_A],
        }),
      ],
      ["not an array", envelope({ guard: GUARD_A })],
      ["array of non-strings", envelope([1, 2, 3])],
    ];
    for (const [name, raw] of cases) {
      const storage = fakeStorage(raw === null ? {} : { [tailSelectionStorageKey(NETWORK)]: raw });
      assert.deepEqual(loadTailSelection({ network: NETWORK, storage }), [], name);
      if (raw !== null) {
        assert.equal(
          storage.records.get(tailSelectionStorageKey(NETWORK)),
          raw,
          `${name}: the unreadable record is left in place, not overwritten by a default`,
        );
      }
    }
  });

  test("a stored list is de-duplicated on the way out, so a doubled address cannot buy two slots", () => {
    const storage = fakeStorage({
      [tailSelectionStorageKey(NETWORK)]: envelope([GUARD_B, GUARD_B, GUARD_A, "", GUARD_B]),
    });
    assert.deepEqual(loadTailSelection({ network: NETWORK, storage }), [GUARD_B, GUARD_A]);
  });
});

describe("dedupe and prune", () => {
  test("blank and duplicate addresses go, first-seen order stays", () => {
    assert.deepEqual(dedupeGuardList([GUARD_A, GUARD_A, "", "   ", GUARD_B, GUARD_C, GUARD_B]), [
      GUARD_A,
      GUARD_B,
      GUARD_C,
    ]);
    assert.deepEqual(dedupeGuardList([`  ${GUARD_A}  `, GUARD_A]), [GUARD_A]);
    assert.deepEqual(dedupeGuardList([]), []);
  });

  test("a guard removed from the registry stops holding a slot", () => {
    const pinned = [GUARD_C, GUARD_A, GUARD_B];
    // Guard C is gone; A and B remain.
    assert.deepEqual(
      prunePinned(pinned, [source(GUARD_A, "Guard A"), source(GUARD_B, "Guard B")]),
      [GUARD_A, GUARD_B],
    );
    assert.deepEqual(
      prunePinned(pinned, []),
      [],
      "an emptied registry cannot leave a live selection behind",
    );
    assert.deepEqual(prunePinned([GUARD_A, GUARD_A], REGISTRY), [GUARD_A]);
  });
});

describe("the plan spends the cap on the operator's choices", () => {
  test("the guard on screen is first, so a full registry cannot starve it", () => {
    const plan = planTailSources({
      registry: REGISTRY,
      active: GUARD_G,
      pinned: [],
      cap: FEED_GUARD_CAP,
    });
    assert.equal(plan.ordered[0]?.guard, GUARD_G);
    assert.deepEqual(
      plan.tailed.map((entry) => entry.guard),
      [GUARD_G, GUARD_A, GUARD_B, GUARD_C, GUARD_D],
      "after the active guard, the leftover slots fall back to registry order",
    );
  });

  test("pinned guards take the slots ahead of registry order", () => {
    const plan = planTailSources({
      registry: REGISTRY,
      active: GUARD_A,
      pinned: [GUARD_F, GUARD_G],
      cap: FEED_GUARD_CAP,
    });
    assert.deepEqual(
      plan.tailed.map((entry) => entry.guard),
      [GUARD_A, GUARD_F, GUARD_G, GUARD_B, GUARD_C],
    );
    assert.deepEqual(
      plan.untailed.map((entry) => entry.guard),
      [GUARD_D, GUARD_E],
    );
  });

  test("the pinned order is the operator's, not the registry's", () => {
    const plan = planTailSources({
      registry: REGISTRY,
      active: GUARD_A,
      pinned: [GUARD_D, GUARD_B],
      cap: 3,
    });
    assert.deepEqual(
      plan.tailed.map((entry) => entry.guard),
      [GUARD_A, GUARD_D, GUARD_B],
    );
  });

  test("an active guard that is also pinned occupies exactly one slot", () => {
    const plan = planTailSources({
      registry: REGISTRY,
      active: GUARD_B,
      pinned: [GUARD_B],
      cap: 2,
    });
    assert.equal(plan.ordered.filter((entry) => entry.guard === GUARD_B).length, 1);
    assert.deepEqual(
      plan.tailed.map((entry) => entry.guard),
      [GUARD_B, GUARD_A],
    );
  });

  test("a selection naming a removed guard is pruned out of the plan, not counted", () => {
    const registry = [
      source(GUARD_A, "Guard A"),
      source(GUARD_B, "Guard B"),
      source(GUARD_C, "Guard C"),
    ];
    const plan = planTailSources({ registry, active: GUARD_A, pinned: [GUARD_D, GUARD_C], cap: 2 });
    assert.deepEqual(
      plan.tailed.map((entry) => entry.guard),
      [GUARD_A, GUARD_C],
    );
    assert.deepEqual(
      plan.untailed.map((entry) => entry.guard),
      [GUARD_B],
    );
    assert.equal(
      plan.tailed.length,
      2,
      "the dead address did not spend a slot that Guard B could have used",
    );
  });

  test("cap changes redivide the same registry without losing or duplicating a guard", () => {
    for (const cap of [0, 1, 3, FEED_GUARD_CAP, REGISTRY.length, REGISTRY.length + 4]) {
      const plan = planTailSources({ registry: REGISTRY, active: GUARD_A, pinned: [GUARD_G], cap });
      assert.equal(plan.cap, cap);
      assert.equal(
        plan.tailed.length + plan.untailed.length,
        plan.ordered.length,
        `cap ${cap}: the partition is the whole plan`,
      );
      assert.equal(plan.tailed.length, Math.min(cap, plan.ordered.length), `cap ${cap}: bounded`);
      assert.deepEqual(
        plan.ordered.map((entry) => entry.guard).sort(),
        REGISTRY.map((entry) => entry.guard).sort(),
        `cap ${cap}: every guard is accounted for exactly once`,
      );
      assert.equal(new Set(plan.ordered.map((entry) => entry.guard)).size, plan.ordered.length);
    }
  });

  test("a cap of zero tails nothing, which is the 'not watching' extreme rather than a crash", () => {
    const plan = planTailSources({ registry: REGISTRY, active: GUARD_A, pinned: [], cap: 0 });
    assert.deepEqual(plan.tailed, []);
    assert.equal(plan.untailed.length, REGISTRY.length);
  });

  test("a duplicated registry entry cannot occupy two slots", () => {
    const plan = planTailSources({
      registry: [
        source(GUARD_A, "Guard A"),
        source(GUARD_A, "Guard A (copy)"),
        source(GUARD_B, "Guard B"),
      ],
      active: GUARD_B,
      pinned: [],
      cap: FEED_GUARD_CAP,
    });
    assert.equal(plan.ordered.length, 2);
    assert.deepEqual(
      plan.ordered.map((entry) => entry.guard),
      [GUARD_B, GUARD_A],
    );
    assert.equal(plan.ordered[1]?.label, "Guard A", "the first label for an address wins");
  });

  test("an unregistered active guard still enters the plan", () => {
    const plan = planTailSources({ registry: REGISTRY, active: GUARD_G + "x", pinned: [], cap: 1 });
    assert.equal(plan.ordered.length, REGISTRY.length + 1);
    assert.equal(plan.tailed[0]?.label, "Active account");
  });
});

describe("the plan drives the supervisor, and reconciliation leaks nothing", () => {
  function harness() {
    const created: string[] = [];
    const stopped: string[] = [];
    const live = new Map<string, GuardFeedLike>();
    let stopCalls = 0;
    const createFeed = (guard: string): GuardFeedLike => {
      const runner: GuardFeedLike = {
        guard,
        pollOnce: async () => ({ events: [], cursor: guard, latestLedger: 0 }),
        stop: () => {
          stopCalls += 1;
          live.delete(guard);
          stopped.push(guard);
        },
      };
      created.push(guard);
      live.set(guard, runner);
      return runner;
    };
    return {
      created,
      stopped,
      live,
      createFeed,
      get stopCalls() {
        return stopCalls;
      },
    };
  }

  /** `guards()` reports map order, so comparisons sort both sides. */
  const tailedGuards = (feed: MultiGuardFeed) =>
    feed
      .guards()
      .map((entry) => entry.guard)
      .sort();

  test("a selection change moves the listener set, not its size", () => {
    const h = harness();
    const feed = new MultiGuardFeed({ cap: FEED_GUARD_CAP, createFeed: h.createFeed });

    feed.sync(
      planTailSources({ registry: REGISTRY, active: GUARD_A, pinned: [], cap: FEED_GUARD_CAP })
        .ordered,
    );
    assert.deepEqual(
      feed.droppedLabels(),
      ["Guard F", "Guard G"],
      "registry order tails the first five",
    );

    // The operator wants the last two guards in the registry instead.
    feed.sync(
      planTailSources({
        registry: REGISTRY,
        active: GUARD_A,
        pinned: [GUARD_F, GUARD_G],
        cap: FEED_GUARD_CAP,
      }).ordered,
    );
    assert.equal(feed.listenerCount(), FEED_GUARD_CAP, "the cap is still exactly the cap");
    assert.deepEqual(tailedGuards(feed), [GUARD_A, GUARD_B, GUARD_C, GUARD_F, GUARD_G].sort());
    assert.deepEqual(feed.droppedLabels(), ["Guard D", "Guard E"], "the untailed are named");
    assert.deepEqual(h.stopped.sort(), [GUARD_D, GUARD_E]);
  });

  test("unselecting a guard stops its listener and frees the slot for the next one", () => {
    const h = harness();
    const feed = new MultiGuardFeed({ cap: 2, createFeed: h.createFeed });
    const pinned = [GUARD_B];
    feed.sync(planTailSources({ registry: REGISTRY, active: GUARD_A, pinned, cap: 2 }).ordered);
    assert.deepEqual(
      feed.guards().map((entry) => entry.guard),
      [GUARD_A, GUARD_B],
    );

    feed.sync(planTailSources({ registry: REGISTRY, active: GUARD_A, pinned: [], cap: 2 }).ordered);
    assert.deepEqual(tailedGuards(feed), [GUARD_A, GUARD_B].sort());
    // ...which is why the toggle has to persist and re-plan: dropping B in favour
    // of nothing lets registry order back in, so B is still the second slot.
    feed.sync(
      planTailSources({ registry: REGISTRY, active: GUARD_A, pinned: [GUARD_C], cap: 2 }).ordered,
    );
    assert.deepEqual(tailedGuards(feed), [GUARD_A, GUARD_C].sort());
    assert.deepEqual(h.stopped, [GUARD_B], "exactly one listener was stopped, once");
    assert.equal(feed.listenerCount(), 2);
  });

  test("a guard deleted from the registry while selected stops polling and is pruned from storage", () => {
    const h = harness();
    const feed = new MultiGuardFeed({ cap: FEED_GUARD_CAP, createFeed: h.createFeed });
    const storage = fakeStorage();
    saveTailSelection([GUARD_B, GUARD_C], { network: NETWORK, storage });

    const first = planTailSources({
      registry: REGISTRY,
      active: GUARD_A,
      pinned: loadTailSelection({ network: NETWORK, storage }),
      cap: FEED_GUARD_CAP,
    });
    feed.sync(first.ordered);
    assert.equal(first.tailed.length, FEED_GUARD_CAP);

    // Guard C is removed from the saved registry.
    const remaining = REGISTRY.filter((entry) => entry.guard !== GUARD_C);
    const pruned = prunePinned(loadTailSelection({ network: NETWORK, storage }), remaining);
    assert.deepEqual(pruned, [GUARD_B], "the deleted guard cannot stay selected");
    saveTailSelection(pruned, { network: NETWORK, storage });

    const second = planTailSources({
      registry: remaining,
      active: GUARD_A,
      pinned: loadTailSelection({ network: NETWORK, storage }),
      cap: FEED_GUARD_CAP,
    });
    feed.sync(second.ordered);
    assert.equal(
      second.tailed.some((entry) => entry.guard === GUARD_C),
      false,
      "the deleted guard holds no slot after removal",
    );
    assert.deepEqual(h.stopped, [GUARD_C]);
    assert.equal(feed.listenerCount(), FEED_GUARD_CAP);
    assert.deepEqual(h.live.size, FEED_GUARD_CAP, "no stopped listener is left running");
  });

  test("repeated selection churn leaves one listener per tailed guard and no residue (leak test)", () => {
    const h = harness();
    const feed = new MultiGuardFeed({ cap: 3, createFeed: h.createFeed });
    const storage = fakeStorage();
    // Each cycle changes who is tailed, so reconciliation must move the set
    // rather than merely re-affirm it.
    const PINNED_BY_CYCLE: string[][] = [[GUARD_G], [GUARD_F, GUARD_G], [GUARD_E], []];

    for (let cycle = 0; cycle < 12; cycle += 1) {
      const pinned = PINNED_BY_CYCLE[cycle % PINNED_BY_CYCLE.length]!;
      assert.ok(saveTailSelection(pinned, { network: NETWORK, storage }));
      const plan = planTailSources({
        registry: REGISTRY,
        active: GUARD_A,
        pinned: loadTailSelection({ network: NETWORK, storage }),
        cap: 3,
      });
      feed.sync(plan.ordered);
      assert.equal(feed.listenerCount(), 3, `cycle ${cycle}: exactly the cap`);
      assert.equal(
        plan.tailed[0]?.guard,
        GUARD_A,
        `cycle ${cycle}: the active guard is never starved`,
      );
      assert.deepEqual(
        [...h.live.keys()].sort(),
        plan.tailed.map((entry) => entry.guard).sort(),
        `cycle ${cycle}: the live runners are exactly the tailed guards`,
      );
      assert.equal(
        h.live.size,
        feed.listenerCount(),
        `cycle ${cycle}: no stopped runner is still live`,
      );
      assert.equal(
        feed.droppedLabels().length,
        REGISTRY.length - 3,
        `cycle ${cycle}: the rest is named, not dropped silently`,
      );
    }

    // Every runner instance created was either live now or explicitly stopped
    // once: no orphan poll loop survives the churn.
    assert.equal(h.live.size, 3);
    assert.ok(h.stopCalls > 0, "the churn did reconcile listeners away");
    assert.equal(
      h.created.length,
      h.live.size + h.stopCalls,
      "created instances are accounted for by live + stopped",
    );
  });

  test("stopAll leaves no listener behind after a selection-driven sync", () => {
    const h = harness();
    const feed = new MultiGuardFeed({ cap: FEED_GUARD_CAP, createFeed: h.createFeed });
    feed.sync(
      planTailSources({
        registry: REGISTRY,
        active: GUARD_A,
        pinned: [GUARD_G],
        cap: FEED_GUARD_CAP,
      }).ordered,
    );
    assert.equal(feed.listenerCount(), FEED_GUARD_CAP);
    feed.stopAll();
    assert.equal(feed.listenerCount(), 0);
    assert.equal(h.live.size, 0, "every listener the plan created was released");
  });
});
