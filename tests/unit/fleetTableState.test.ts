import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FLEET_VIEW,
  FLEET_SEARCH_MAX_LENGTH,
  FLEET_VIEW_STORAGE_KEY,
  applyFleetView,
  createFleetViewStore,
  fleetTableState,
  fleetEmptyCopy,
  hasActiveFleetFilter,
  isDefaultFleetView,
  loadFleetView,
  parseFleetView,
  saveFleetView,
  type FleetTableState,
  type FleetViewState,
} from "../../lib/guard/fleetTableState.ts";
import { instanceStorageKey } from "../../lib/guard/instance.ts";
import type { DerivedStatus, FleetRow } from "../../lib/guard/fleet.ts";
import type { StorageLike } from "../../lib/guard/instance.ts";

/**
 * Empty-state contract for the fleet table (upstream issue #32): three
 * situations that all render an "empty" tbody are distinct states with
 * distinct copy and recovery paths. Cause-inventory as tests.
 */

test("fleetTableState trichotomy", async (t) => {
  await t.test("pending (loading, registry not yet read) → loading", () => {
    const state = fleetTableState({ loading: true, registryCount: 0, filteredCount: 0 });
    assert.equal(state.kind, "loading");
  });

  await t.test("registry-empty (zero guards saved, not loading) → registry-empty", () => {
    const state = fleetTableState({ loading: false, registryCount: 0, filteredCount: 0 });
    assert.equal(state.kind, "registry-empty");
  });

  await t.test("filters exclude every row → filter-empty (never registry-empty)", () => {
    const state = fleetTableState({ loading: false, registryCount: 3, filteredCount: 0 });
    assert.equal(state.kind, "filter-empty");
  });

  await t.test("rows present → rows (loading flag alone cannot mask rows)", () => {
    const state = fleetTableState({ loading: true, registryCount: 2, filteredCount: 2 });
    assert.equal(state.kind, "rows");
  });
});

test("every non-rows state carries copy and a recovery path", async (t) => {
  await t.test("filter-empty copy names the fix: clear the filters", () => {
    const copy = fleetEmptyCopy({ kind: "filter-empty" })!;
    assert.match(copy.title, /[Nn]o guards match/);
    assert.match(copy.hint, /lear/); // recovery says clear
  });

  await t.test("registry-empty copy points at the add-flow (Configure page)", () => {
    const copy = fleetEmptyCopy({ kind: "registry-empty" })!;
    assert.match(copy.hint, /Configure/);
  });

  await t.test("loading copy is pending phrasing, not an empty claim", () => {
    const copy = fleetEmptyCopy({ kind: "loading" })!;
    assert.match(copy.title, /[Ll]oading/);
  });

  await t.test("rows state has no empty copy (must never render one)", () => {
    const state: FleetTableState = { kind: "rows" };
    assert.equal(fleetEmptyCopy(state), null);
  });
});

// ── The operator's view: filters, sort, persistence ────────────────────────

function viewRow(
  label: string,
  address: string,
  derivedStatus: DerivedStatus,
  network = "testnet",
): FleetRow {
  return {
    contact: { label, address, addedAt: "" },
    snapshot: null,
    derivedStatus,
    spend24h: 0n,
    dmsCountdownSecs: null,
    network,
  };
}

const FLEET: FleetRow[] = [
  viewRow("Treasury", "CAAA", "Active"),
  viewRow("Treasury backup", "CBBB", "Frozen"),
  viewRow("Payroll", "CCCC", "Unknown"),
  viewRow("Payroll staging", "CDDD", "Active", "public"),
  viewRow("Vendor", "CEEE", "Expired"),
];

function view(patch: Partial<FleetViewState>): FleetViewState {
  return { ...DEFAULT_FLEET_VIEW, ...patch };
}

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

test("applyFleetView", async (t) => {
  await t.test("the default view shows every row in registry order", () => {
    assert.deepEqual(
      applyFleetView(FLEET, DEFAULT_FLEET_VIEW).map((r) => r.contact.address),
      ["CAAA", "CBBB", "CCCC", "CDDD", "CEEE"],
    );
  });

  await t.test("search matches the label or the address, case-insensitively", () => {
    assert.deepEqual(
      applyFleetView(FLEET, view({ search: "PAYROLL" })).map((r) => r.contact.label),
      ["Payroll", "Payroll staging"],
    );
    assert.deepEqual(
      applyFleetView(FLEET, view({ search: "cbb" })).map((r) => r.contact.address),
      ["CBBB"],
    );
  });

  await t.test("combined filters narrow together: search, status and network", () => {
    assert.deepEqual(
      applyFleetView(FLEET, view({ search: "payroll", status: "Active" })).map(
        (r) => r.contact.address,
      ),
      ["CDDD"],
    );
    assert.deepEqual(
      applyFleetView(FLEET, view({ search: "payroll", status: "Active", network: "testnet" })),
      [],
    );
    assert.deepEqual(
      applyFleetView(FLEET, view({ status: "Active", network: "public" })).map(
        (r) => r.contact.address,
      ),
      ["CDDD"],
    );
  });

  await t.test(
    "a filter that matches nothing yields an empty list, which the table reports as filter-empty",
    () => {
      const shown = applyFleetView(FLEET, view({ search: "no such guard" }));
      assert.deepEqual(shown, []);
      assert.equal(
        fleetTableState({
          loading: false,
          registryCount: FLEET.length,
          filteredCount: shown.length,
        }).kind,
        "filter-empty",
      );
    },
  );

  await t.test("an unread guard matches the Unknown filter and never the Active one", () => {
    const unknown = applyFleetView(FLEET, view({ status: "Unknown" }));
    assert.deepEqual(
      unknown.map((r) => r.contact.address),
      ["CCCC"],
    );
    const active = applyFleetView(FLEET, view({ status: "Active" }));
    assert.ok(!active.some((r) => r.contact.address === "CCCC"));
  });

  await t.test("filters and sort apply together, with the sort breaking nothing but order", () => {
    const shown = applyFleetView(
      FLEET,
      view({ search: "payroll", sortKey: "label", sortDirection: "desc" }),
    );
    assert.deepEqual(
      shown.map((r) => r.contact.label),
      ["Payroll staging", "Payroll"],
    );
    assert.deepEqual(
      FLEET.map((r) => r.contact.address),
      ["CAAA", "CBBB", "CCCC", "CDDD", "CEEE"],
      "the registry order itself is untouched",
    );
  });

  await t.test(
    "it filters from the rows as read now: a status change moves the row in or out",
    () => {
      const frozenOnly = view({ status: "Frozen" });
      assert.deepEqual(
        applyFleetView(FLEET, frozenOnly).map((r) => r.contact.address),
        ["CBBB"],
      );
      // Next poll: CAAA is now frozen and CBBB has been unfrozen.
      const nextPoll = FLEET.map((r) =>
        r.contact.address === "CAAA"
          ? { ...r, derivedStatus: "Frozen" as const }
          : r.contact.address === "CBBB"
            ? { ...r, derivedStatus: "Active" as const }
            : r,
      );
      assert.deepEqual(
        applyFleetView(nextPoll, frozenOnly).map((r) => r.contact.address),
        ["CAAA"],
      );
    },
  );
});

test("view helpers", async (t) => {
  await t.test("the default view is recognised, and any narrowing or sort is not", () => {
    assert.equal(isDefaultFleetView(DEFAULT_FLEET_VIEW), true);
    assert.equal(isDefaultFleetView(view({ search: "x" })), false);
    assert.equal(isDefaultFleetView(view({ status: "Active" })), false);
    assert.equal(isDefaultFleetView(view({ network: "testnet" })), false);
    assert.equal(isDefaultFleetView(view({ sortKey: "label" })), false);
  });

  await t.test("sorting alone is not filtering", () => {
    assert.equal(hasActiveFleetFilter(view({ sortKey: "label" })), false);
    assert.equal(hasActiveFleetFilter(view({ search: "  " })), false);
    assert.equal(hasActiveFleetFilter(view({ search: "a" })), true);
    assert.equal(hasActiveFleetFilter(view({ status: "Unknown" })), true);
  });
});

test("parseFleetView treats stored data as untrusted", async (t) => {
  await t.test("a valid record round-trips", () => {
    const stored = view({
      search: "pay",
      network: "testnet",
      status: "Unknown",
      sortKey: "status",
      sortDirection: "desc",
    });
    assert.deepEqual(parseFleetView(JSON.parse(JSON.stringify(stored)), ["testnet"]), stored);
  });

  await t.test("anything that is not an object yields the default view", () => {
    for (const raw of [null, undefined, "x", 3, true, [], ["label"]]) {
      assert.deepEqual(parseFleetView(raw, ["testnet"]), DEFAULT_FLEET_VIEW);
    }
  });

  await t.test("each bad field falls back on its own without discarding the others", () => {
    const parsed = parseFleetView(
      {
        search: 42,
        network: "mainnet-typo",
        status: "Healthy",
        sortKey: "balance",
        sortDirection: "sideways",
      },
      ["testnet"],
    );
    assert.deepEqual(parsed, DEFAULT_FLEET_VIEW);

    const partial = parseFleetView({ search: "ok", status: "Frozen", sortKey: "bogus" }, [
      "testnet",
    ]);
    assert.equal(partial.search, "ok");
    assert.equal(partial.status, "Frozen");
    assert.equal(partial.sortKey, null);
  });

  await t.test("a remembered network this build cannot show is dropped, not applied", () => {
    assert.equal(parseFleetView({ network: "public" }, ["testnet"]).network, null);
    assert.equal(parseFleetView({ network: "testnet" }, ["testnet"]).network, "testnet");
  });

  await t.test("a sort key without a direction takes that key's default direction", () => {
    assert.equal(parseFleetView({ sortKey: "spend" }).sortDirection, "desc");
    assert.equal(parseFleetView({ sortKey: "label" }).sortDirection, "asc");
  });

  await t.test("remembered search text is capped", () => {
    const parsed = parseFleetView({ search: "x".repeat(FLEET_SEARCH_MAX_LENGTH + 500) });
    assert.equal(parsed.search.length, FLEET_SEARCH_MAX_LENGTH);
  });
});

test("persistence stores the view only, never chain state or registry data", async (t) => {
  await t.test("it writes exactly the five view fields", () => {
    const storage = memoryStorage();
    saveFleetView(view({ search: "pay", status: "Frozen", sortKey: "label" }), { storage });
    const stored = JSON.parse(storage.dump()[FLEET_VIEW_STORAGE_KEY]!) as Record<string, unknown>;
    assert.deepEqual(Object.keys(stored).sort(), [
      "network",
      "search",
      "sortDirection",
      "sortKey",
      "status",
    ]);
  });

  await t.test("showing and sorting rows leaves no row, address or status behind", () => {
    const storage = memoryStorage();
    const current = view({ status: "Frozen", sortKey: "address" });
    applyFleetView(FLEET, current);
    saveFleetView(current, { storage });
    const written = JSON.stringify(storage.dump());
    for (const row of FLEET) {
      assert.ok(
        !written.includes(row.contact.address),
        `${row.contact.address} must not be stored`,
      );
      assert.ok(!written.includes(row.contact.label), `${row.contact.label} must not be stored`);
    }
    assert.deepEqual(Object.keys(storage.dump()), [FLEET_VIEW_STORAGE_KEY]);
  });

  await t.test("it never touches the guard registry's own storage", () => {
    const registryKey = instanceStorageKey("testnet");
    const registryValue = JSON.stringify([{ guard: "CAAA", label: "Treasury" }]);
    const storage = memoryStorage({ [registryKey]: registryValue });
    saveFleetView(view({ search: "x", sortKey: "status" }), { storage });
    saveFleetView(DEFAULT_FLEET_VIEW, { storage });
    assert.equal(storage.getItem(registryKey), registryValue);
  });

  await t.test("returning to the default view clears the entry", () => {
    const storage = memoryStorage();
    saveFleetView(view({ search: "x" }), { storage });
    assert.ok(storage.getItem(FLEET_VIEW_STORAGE_KEY));
    saveFleetView(DEFAULT_FLEET_VIEW, { storage });
    assert.equal(storage.getItem(FLEET_VIEW_STORAGE_KEY), null);
  });

  await t.test("a remembered view loads back", () => {
    const storage = memoryStorage();
    const original = view({
      search: "pay",
      network: "testnet",
      status: "Unknown",
      sortKey: "spend",
      sortDirection: "asc",
    });
    saveFleetView(original, { storage });
    assert.deepEqual(loadFleetView({ storage, networks: ["testnet"] }), original);
  });

  await t.test("corrupt, empty or unavailable storage yields the default view", () => {
    assert.deepEqual(
      loadFleetView({ storage: memoryStorage({ [FLEET_VIEW_STORAGE_KEY]: "{not json" }) }),
      DEFAULT_FLEET_VIEW,
    );
    assert.deepEqual(
      loadFleetView({ storage: memoryStorage({ [FLEET_VIEW_STORAGE_KEY]: "" }) }),
      DEFAULT_FLEET_VIEW,
    );
    assert.deepEqual(loadFleetView({ storage: null }), DEFAULT_FLEET_VIEW);
  });

  await t.test("a storage that throws on write does not break the table", () => {
    const hostile: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    assert.doesNotThrow(() => saveFleetView(view({ search: "x" }), { storage: hostile }));
    assert.doesNotThrow(() => saveFleetView(DEFAULT_FLEET_VIEW, { storage: hostile }));
  });
});

test("createFleetViewStore", async (t) => {
  function fakeTarget() {
    const listeners = new Set<(event: { key: string | null }) => void>();
    return {
      listeners,
      addEventListener: (_type: "storage", fn: (event: { key: string | null }) => void) =>
        listeners.add(fn),
      removeEventListener: (_type: "storage", fn: (event: { key: string | null }) => void) =>
        listeners.delete(fn),
      fire: (key: string | null) => listeners.forEach((fn) => fn({ key })),
    };
  }

  await t.test("the server and first render see the default view whatever is stored", () => {
    const storage = memoryStorage({
      [FLEET_VIEW_STORAGE_KEY]: JSON.stringify(view({ search: "x" })),
    });
    const store = createFleetViewStore({ storage, eventTarget: null });
    assert.equal(store.getServerSnapshot(), DEFAULT_FLEET_VIEW);
    assert.equal(store.getSnapshot().search, "x");
  });

  await t.test("the snapshot is the same object until the view changes", () => {
    const store = createFleetViewStore({ storage: memoryStorage(), eventTarget: null });
    assert.equal(store.getSnapshot(), store.getSnapshot());
    const next = view({ sortKey: "label" });
    store.set(next);
    assert.equal(store.getSnapshot(), next);
    assert.equal(store.getSnapshot(), store.getSnapshot());
  });

  await t.test("set remembers the view and notifies subscribers once", () => {
    const storage = memoryStorage();
    const store = createFleetViewStore({ storage, eventTarget: null });
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    store.set(view({ status: "Unknown" }));
    assert.equal(calls, 1);
    assert.equal(JSON.parse(storage.getItem(FLEET_VIEW_STORAGE_KEY)!).status, "Unknown");
    unsubscribe();
    store.set(view({ status: "Frozen" }));
    assert.equal(calls, 1, "an unsubscribed listener is not called");
  });

  await t.test(
    "a change made in another tab is re-read from storage, not taken from the event",
    () => {
      const storage = memoryStorage();
      const target = fakeTarget();
      const store = createFleetViewStore({ storage, eventTarget: target });
      let calls = 0;
      store.subscribe(() => {
        calls += 1;
      });
      assert.equal(store.getSnapshot().search, "");

      storage.setItem(FLEET_VIEW_STORAGE_KEY, JSON.stringify(view({ search: "from another tab" })));
      target.fire(FLEET_VIEW_STORAGE_KEY);
      assert.equal(calls, 1);
      assert.equal(store.getSnapshot().search, "from another tab");

      target.fire("some.other.key");
      assert.equal(calls, 1, "events for other keys are ignored");
    },
  );

  await t.test("it listens to storage only while subscribed, and registers one listener", () => {
    const target = fakeTarget();
    const store = createFleetViewStore({ storage: memoryStorage(), eventTarget: target });
    const a = store.subscribe(() => {});
    const b = store.subscribe(() => {});
    assert.equal(target.listeners.size, 1);
    a();
    assert.equal(target.listeners.size, 1);
    b();
    assert.equal(target.listeners.size, 0);
  });

  await t.test("it works for the session when storage is unavailable", () => {
    const store = createFleetViewStore({ storage: null, eventTarget: null });
    store.set(view({ search: "kept in memory" }));
    assert.equal(store.getSnapshot().search, "kept in memory");
  });
});
