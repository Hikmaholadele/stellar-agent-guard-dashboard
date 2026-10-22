import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REGISTRY_SYNC_VERSION,
  TAB_SYNC_CHANNEL,
  TAB_SYNC_STORAGE_KEY,
  acquireGuardWriteLock,
  createRegistryAnnouncer,
  createRegistryChangeFilter,
  createTabSync,
  isTabSyncEvent,
  parseRegistryChange,
  registryChangePayload,
  subscribeGuardWriteLock,
  type TabChannel,
  type TabEventTarget,
  type GuardWriteStorage,
  type TabLifecycleTarget,
  type TabStorage,
  type TabStorageEvent,
  type TabSyncEvent,
} from "../../lib/guard/tabSync.ts";

/**
 * A fake BroadcastChannel bus.
 *
 * Every channel created with the same name joins the same peer set, so two
 * coordinators wired to this hub behave like two browser tabs. `echo` turns the
 * sender back into a recipient, which is how the origin-echo guard is exercised
 * (in a real browser BroadcastChannel never echoes, and neither does the hub by
 * default).
 */
interface MockChannel extends TabChannel {
  deliver(data: unknown): void;
}

function createMockHub(options: { echo?: boolean } = {}) {
  const peersByName = new Map<string, Set<MockChannel>>();

  const create = (name: string): TabChannel => {
    const peers = peersByName.get(name) ?? new Set<MockChannel>();
    peersByName.set(name, peers);
    const listeners = new Set<(event: { data: unknown }) => void>();

    const channel: MockChannel = {
      deliver(data) {
        for (const listener of [...listeners]) listener({ data });
      },
      postMessage(message) {
        for (const peer of [...peers]) {
          if (!options.echo && peer === channel) continue;
          peer.deliver(message);
        }
      },
      addEventListener(_type, listener) {
        listeners.add(listener);
      },
      removeEventListener(_type, listener) {
        listeners.delete(listener);
      },
      close() {
        peers.delete(channel);
        listeners.clear();
      },
    };

    peers.add(channel);
    return channel;
  };

  return {
    create,
    peerCount: (name: string) => peersByName.get(name)?.size ?? 0,
  };
}

/** A fake `Storage` with the same tiny surface the fallback uses. */
function createMockStorage() {
  const map = new Map<string, string>();
  const storage: GuardWriteStorage = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
  return { storage, raw: () => map.get(TAB_SYNC_STORAGE_KEY) ?? null };
}

/** A fake `window` that records `storage` listeners so tests can emit at them. */
function createMockEventTarget() {
  const listeners = new Set<(event: TabStorageEvent) => void>();
  const target: TabEventTarget = {
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
  };
  return {
    target,
    emit(event: TabStorageEvent) {
      for (const listener of [...listeners]) listener(event);
    },
    listenerCount: () => listeners.size,
  };
}

const FIXED_TIME = new Date("2026-09-25T12:00:00.000Z");
const GUARD = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";

function createMockLifecycleTarget() {
  const listeners = new Set<() => void>();
  const target: TabLifecycleTarget = {
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
  };
  return {
    target,
    pagehide() {
      for (const listener of [...listeners]) listener();
    },
  };
}

describe("guard write leases", () => {
  it("prevents a duplicate guard/action claim and releases it on completion", () => {
    const { storage } = createMockStorage();
    const scope = { guard: GUARD, action: "freeze" as const, network: "testnet" };
    const first = acquireGuardWriteLock(scope, {
      storage,
      lifecycleTarget: null,
      randomId: () => "tab-a",
      now: () => FIXED_TIME.getTime(),
    });
    assert.ok(first);
    assert.equal(
      acquireGuardWriteLock(scope, {
        storage,
        lifecycleTarget: null,
        randomId: () => "tab-b",
        now: () => FIXED_TIME.getTime(),
      }),
      null,
    );

    first.release();
    const next = acquireGuardWriteLock(scope, {
      storage,
      lifecycleTarget: null,
      randomId: () => "tab-b",
      now: () => FIXED_TIME.getTime(),
    });
    assert.ok(next, "completion must release the claim");
    next.release();
  });

  it("expires abandoned claims and scopes them by guard, action, and network", () => {
    const { storage } = createMockStorage();
    let currentTime = FIXED_TIME.getTime();
    const options = {
      storage,
      lifecycleTarget: null,
      now: () => currentTime,
      ttlMs: 100,
    };
    const claim = acquireGuardWriteLock(
      { guard: GUARD, action: "freeze", network: "testnet" },
      { ...options, randomId: () => "tab-a" },
    );
    assert.ok(claim);
    assert.ok(
      acquireGuardWriteLock(
        { guard: GUARD, action: "unfreeze", network: "testnet" },
        { ...options, randomId: () => "tab-b" },
      ),
      "the opposite action has a separate pending state",
    );
    assert.ok(
      acquireGuardWriteLock(
        { guard: GUARD, action: "freeze", network: "mainnet" },
        { ...options, randomId: () => "tab-c" },
      ),
      "another network has a separate pending state",
    );

    currentTime += 101;
    const reclaimed = acquireGuardWriteLock(
      { guard: GUARD, action: "freeze", network: "testnet" },
      { ...options, randomId: () => "tab-d" },
    );
    assert.ok(reclaimed, "an abandoned claim must be reclaimable after expiry");
    claim.release();
    reclaimed.release();
  });

  it("releases its claim when the tab is closed", () => {
    const { storage } = createMockStorage();
    const lifecycle = createMockLifecycleTarget();
    const scope = { guard: GUARD, action: "unfreeze" as const, network: "testnet" };
    const claim = acquireGuardWriteLock(scope, {
      storage,
      lifecycleTarget: lifecycle.target,
      randomId: () => "tab-a",
      now: () => FIXED_TIME.getTime(),
    });
    assert.ok(claim);

    lifecycle.pagehide();
    assert.equal(
      acquireGuardWriteLock(scope, {
        storage,
        lifecycleTarget: null,
        randomId: () => "tab-b",
        now: () => FIXED_TIME.getTime(),
      }) !== null,
      true,
    );
  });

  it("notifies local subscribers when a claim starts and releases", () => {
    const { storage } = createMockStorage();
    const scope = { guard: GUARD, action: "freeze" as const, network: "testnet" };
    const updates: Array<string | null> = [];
    const unsubscribe = subscribeGuardWriteLock(
      scope,
      (record) => {
        updates.push(record?.owner ?? null);
      },
      { storage, eventTarget: null, now: () => FIXED_TIME.getTime() },
    );
    const claim = acquireGuardWriteLock(scope, {
      storage,
      lifecycleTarget: null,
      randomId: () => "tab-a",
      now: () => FIXED_TIME.getTime(),
    });
    assert.ok(claim);
    claim.release();
    unsubscribe();

    assert.deepEqual(updates, [null, "tab-a", null]);
  });
});

describe("tab sync event validation", () => {
  it("accepts a well-formed event", () => {
    assert.equal(
      isTabSyncEvent({
        type: "GUARD_CHANGED",
        origin: "tab-a",
        at: FIXED_TIME.toISOString(),
        guard: GUARD,
      }),
      true,
    );
  });

  it("rejects anything that is not one of the broadcastable changes", () => {
    assert.equal(isTabSyncEvent({ type: "NOT_A_TYPE", origin: "tab-a", at: "now" }), false);
    assert.equal(isTabSyncEvent(null), false);
    assert.equal(isTabSyncEvent("GUARD_CHANGED"), false);
    assert.equal(isTabSyncEvent({ type: "POLICY_UPDATED" }), false, "origin and at are required");
    assert.equal(
      isTabSyncEvent({ type: "POLICY_UPDATED", origin: "", at: "now" }),
      false,
      "an empty origin cannot be trusted",
    );
    assert.equal(
      isTabSyncEvent({
        type: "POLICY_UPDATED",
        origin: "tab-a",
        at: "now",
        payload: "not an object",
      }),
      false,
    );
  });
});

describe("BroadcastChannel transport", () => {
  it("broadcasts an event to another tab on the same channel name", () => {
    const hub = createMockHub();
    const tabA = createTabSync({
      channelFactory: hub.create,
      origin: "tab-a",
      now: () => FIXED_TIME,
    });
    const tabB = createTabSync({ channelFactory: hub.create, origin: "tab-b" });

    try {
      const received: TabSyncEvent[] = [];
      tabB.subscribe((event) => received.push(event));

      const sent = tabA.broadcast("FREEZE_STATE_CHANGED", { guard: GUARD });

      assert.equal(tabA.transport, "broadcast");
      assert.equal(tabA.channelName, TAB_SYNC_CHANNEL);
      assert.equal(sent.type, "FREEZE_STATE_CHANGED");
      assert.equal(sent.origin, "tab-a");
      assert.equal(sent.at, FIXED_TIME.toISOString());
      assert.equal(sent.guard, GUARD);

      assert.equal(received.length, 1);
      assert.deepEqual(received[0], sent);
    } finally {
      tabA.close();
      tabB.close();
    }
  });

  it("synchronises state across two tabs, in both directions", () => {
    const hub = createMockHub();
    const tabA = createTabSync({ channelFactory: hub.create, origin: "tab-a" });
    const tabB = createTabSync({ channelFactory: hub.create, origin: "tab-b" });
    const SECOND_GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";

    try {
      // Two independent "React contexts". The acting tab updates its own state
      // directly (that is the user's click) and then announces it; the peer only
      // ever learns the new value from the bus, which is the guarantee under test.
      const contexts: Record<string, string> = { "tab-a": "CAAA", "tab-b": "CBBB" };
      const follow = (tab: string) => (event: TabSyncEvent) => {
        if (event.type === "GUARD_CHANGED" && event.guard) contexts[tab] = event.guard;
      };
      tabA.subscribe(follow("tab-a"));
      tabB.subscribe(follow("tab-b"));

      contexts["tab-a"] = GUARD;
      tabA.broadcast("GUARD_CHANGED", { guard: GUARD });
      assert.equal(contexts["tab-b"], GUARD, "the other tab follows the switch");

      contexts["tab-b"] = SECOND_GUARD;
      tabB.broadcast("GUARD_CHANGED", { guard: SECOND_GUARD });
      assert.equal(contexts["tab-a"], SECOND_GUARD, "synchronisation is symmetric");
      assert.equal(contexts["tab-b"], SECOND_GUARD, "a tab never reapplies its own broadcast");
    } finally {
      tabA.close();
      tabB.close();
    }
  });

  it("ignores a transport that echoes a tab's own event back to it", () => {
    const hub = createMockHub({ echo: true });
    const tabA = createTabSync({ channelFactory: hub.create, origin: "tab-a" });

    try {
      const received: TabSyncEvent[] = [];
      tabA.subscribe((event) => received.push(event));
      tabA.broadcast("WALLET_DISCONNECTED");
      assert.deepEqual(received, [], "the emitting tab must not react to itself");
    } finally {
      tabA.close();
    }
  });

  it("stops delivering and detaches the channel once closed", () => {
    const hub = createMockHub();
    const tabA = createTabSync({ channelFactory: hub.create, origin: "tab-a" });
    const tabB = createTabSync({ channelFactory: hub.create, origin: "tab-b" });

    try {
      const received: TabSyncEvent[] = [];
      tabB.subscribe((event) => received.push(event));
      tabA.broadcast("POLICY_UPDATED");
      assert.equal(received.length, 1);

      tabA.close();
      assert.equal(tabA.closed, true);
      assert.equal(hub.peerCount(TAB_SYNC_CHANNEL), 1, "the closed channel leaves the bus");

      // A later broadcast from a still-open tab must not reach the closed one.
      tabB.broadcast("POLICY_UPDATED");
      assert.equal(received.length, 1);
    } finally {
      tabA.close();
      tabB.close();
    }
  });

  it("drops malformed channel messages instead of throwing", () => {
    const hub = createMockHub();
    const tabA = createTabSync({ channelFactory: hub.create, origin: "tab-a" });
    const tabB = createTabSync({ channelFactory: hub.create, origin: "tab-b" });

    try {
      const received: TabSyncEvent[] = [];
      tabB.subscribe((event) => received.push(event));
      // `broadcast` is typed, so this goes through a channel the way a foreign
      // page on the same origin could: raw and unvalidated.
      const raw = hub.create(TAB_SYNC_CHANNEL);
      raw.postMessage({ type: "GUARD_CHANGED" });
      raw.postMessage("not an event at all");
      raw.close();

      assert.deepEqual(received, []);
    } finally {
      tabA.close();
      tabB.close();
    }
  });
});

describe("localStorage fallback transport", () => {
  it("is chosen when BroadcastChannel is unavailable", () => {
    const { storage } = createMockStorage();
    const events = createMockEventTarget();
    const coordinator = createTabSync({
      channelFactory: null,
      storage,
      eventTarget: events.target,
      origin: "tab-a",
    });
    try {
      assert.equal(coordinator.transport, "storage");
    } finally {
      coordinator.close();
    }
  });

  it("delivers an event written by another tab through a storage event", () => {
    const { storage, raw } = createMockStorage();
    const events = createMockEventTarget();
    const tabA = createTabSync({
      channelFactory: null,
      storage,
      eventTarget: events.target,
      origin: "tab-a",
      now: () => FIXED_TIME,
    });
    const tabB = createTabSync({
      channelFactory: null,
      storage,
      eventTarget: events.target,
      origin: "tab-b",
    });

    try {
      const received: TabSyncEvent[] = [];
      tabB.subscribe((event) => received.push(event));

      tabA.broadcast("POLICY_UPDATED", { guard: GUARD, payload: { operation: "set_policy" } });
      const stored = raw();
      assert.ok(stored, "the fallback must write the event to the storage key");

      // The browser fires `storage` in the *other* tabs; emulate exactly that.
      events.emit({ key: TAB_SYNC_STORAGE_KEY, newValue: stored });

      assert.equal(received.length, 1);
      assert.equal(received[0]!.type, "POLICY_UPDATED");
      assert.equal(received[0]!.origin, "tab-a");
      assert.equal(received[0]!.guard, GUARD);
      assert.deepEqual(received[0]!.payload, { operation: "set_policy" });
    } finally {
      tabA.close();
      tabB.close();
    }
  });

  it("never replays its own write to the tab that wrote it", () => {
    const { storage, raw } = createMockStorage();
    const events = createMockEventTarget();
    const tabA = createTabSync({
      channelFactory: null,
      storage,
      eventTarget: events.target,
      origin: "tab-a",
    });

    try {
      const received: TabSyncEvent[] = [];
      tabA.subscribe((event) => received.push(event));
      tabA.broadcast("FREEZE_STATE_CHANGED");
      events.emit({ key: TAB_SYNC_STORAGE_KEY, newValue: raw() });
      assert.deepEqual(received, []);
    } finally {
      tabA.close();
    }
  });

  it("writes a fresh nonce so repeated identical events are never deduplicated", () => {
    const { storage, raw } = createMockStorage();
    const events = createMockEventTarget();
    const tabA = createTabSync({
      channelFactory: null,
      storage,
      eventTarget: events.target,
      origin: "tab-a",
      // A fixed clock, so the two events differ only by their nonce.
      now: () => FIXED_TIME,
    });

    try {
      tabA.broadcast("FREEZE_STATE_CHANGED");
      const first = raw();
      tabA.broadcast("FREEZE_STATE_CHANGED");
      const second = raw();
      assert.ok(first && second);
      assert.notEqual(first, second, "a storage event only fires when the value changes");

      const firstEnvelope = JSON.parse(first) as { nonce?: unknown; event?: unknown };
      const secondEnvelope = JSON.parse(second) as { nonce?: unknown; event?: unknown };
      assert.equal(typeof firstEnvelope.nonce, "string");
      assert.notEqual(firstEnvelope.nonce, secondEnvelope.nonce);
      assert.deepEqual(firstEnvelope.event, secondEnvelope.event);
    } finally {
      tabA.close();
    }
  });

  it("ignores a corrupt value, a foreign key and a valid-shaped unknown event", () => {
    const { storage } = createMockStorage();
    const events = createMockEventTarget();
    const coordinator = createTabSync({
      channelFactory: null,
      storage,
      eventTarget: events.target,
      origin: "tab-b",
    });

    try {
      const received: TabSyncEvent[] = [];
      coordinator.subscribe((event) => received.push(event));

      events.emit({
        key: "some.other.key",
        newValue: '{"nonce":"x","event":{"type":"POLICY_UPDATED","origin":"tab-a","at":"now"}}',
      });
      events.emit({ key: TAB_SYNC_STORAGE_KEY, newValue: "{not json" });
      events.emit({
        key: TAB_SYNC_STORAGE_KEY,
        newValue: JSON.stringify({ nonce: "y", event: { type: "NOPE" } }),
      });
      events.emit({ key: TAB_SYNC_STORAGE_KEY, newValue: null });

      assert.deepEqual(received, []);
    } finally {
      coordinator.close();
    }
  });

  it("detaches its storage listener on close", () => {
    const { storage } = createMockStorage();
    const events = createMockEventTarget();
    const coordinator = createTabSync({
      channelFactory: null,
      storage,
      eventTarget: events.target,
      origin: "tab-a",
    });

    coordinator.subscribe(() => {});
    assert.equal(events.listenerCount(), 1);
    coordinator.close();
    assert.equal(events.listenerCount(), 0);
    assert.equal(coordinator.closed, true);
  });
});

describe("no transport available", () => {
  it("degrades to an inert coordinator rather than throwing", () => {
    const coordinator = createTabSync({
      channelFactory: null,
      storage: null,
      eventTarget: null,
      origin: "tab-a",
    });
    try {
      assert.equal(coordinator.transport, "none");
      const received: TabSyncEvent[] = [];
      coordinator.subscribe((event) => received.push(event));
      const sent = coordinator.broadcast("POLICY_UPDATED");
      assert.equal(sent.type, "POLICY_UPDATED");
      assert.deepEqual(received, []);
    } finally {
      coordinator.close();
    }
  });
});

// ── Registry changes (#305) ────────────────────────────────────────────────

const SECOND_GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";

function registryEvent(overrides: Record<string, unknown> = {}): TabSyncEvent {
  return {
    type: "REGISTRY_CHANGED",
    origin: "tab-a",
    at: FIXED_TIME.toISOString(),
    guard: GUARD,
    payload: registryChangePayload("add", 1),
    ...overrides,
  } as TabSyncEvent;
}

describe("registry change payload", () => {
  it("is versioned and names the kind and revision, never the new state", () => {
    assert.deepEqual(registryChangePayload("rename", 3), {
      v: REGISTRY_SYNC_VERSION,
      kind: "rename",
      revision: 3,
    });
    assert.equal(REGISTRY_SYNC_VERSION, 1);
  });

  it("is a broadcastable event type", () => {
    assert.equal(isTabSyncEvent(registryEvent()), true);
  });

  it("accepts add, rename and remove", () => {
    for (const kind of ["add", "rename", "remove"] as const) {
      const notice = parseRegistryChange(
        registryEvent({ payload: registryChangePayload(kind, 2) }),
      );
      assert.deepEqual(notice, { kind, guard: GUARD, revision: 2, origin: "tab-a" });
    }
  });

  it("rejects every event that is not a well-formed registry change", () => {
    const bad: Array<[string, TabSyncEvent]> = [
      ["another event type", registryEvent({ type: "GUARD_CHANGED" })],
      ["no payload", registryEvent({ payload: undefined })],
      ["an array payload", registryEvent({ payload: [] as unknown as Record<string, unknown> })],
      ["an unknown version", registryEvent({ payload: { v: 2, kind: "add", revision: 1 } })],
      ["a string version", registryEvent({ payload: { v: "1", kind: "add", revision: 1 } })],
      ["no version", registryEvent({ payload: { kind: "add", revision: 1 } })],
      ["an unknown kind", registryEvent({ payload: { v: 1, kind: "replace", revision: 1 } })],
      ["an empty kind", registryEvent({ payload: { v: 1, kind: "", revision: 1 } })],
      ["a zero revision", registryEvent({ payload: { v: 1, kind: "add", revision: 0 } })],
      ["a negative revision", registryEvent({ payload: { v: 1, kind: "add", revision: -1 } })],
      ["a fractional revision", registryEvent({ payload: { v: 1, kind: "add", revision: 1.5 } })],
      ["a string revision", registryEvent({ payload: { v: 1, kind: "add", revision: "1" } })],
      ["a NaN revision", registryEvent({ payload: { v: 1, kind: "add", revision: Number.NaN } })],
      ["an unsafe revision", registryEvent({ payload: { v: 1, kind: "add", revision: 2 ** 60 } })],
      ["no guard", registryEvent({ guard: undefined })],
      ["a guard that is not a contract address", registryEvent({ guard: "GABC" })],
      ["an account address", registryEvent({ guard: `G${GUARD.slice(1)}` })],
      ["a lower-case address", registryEvent({ guard: GUARD.toLowerCase() })],
    ];
    for (const [name, event] of bad) {
      assert.equal(parseRegistryChange(event), null, name);
    }
  });
});

describe("registry change filter", () => {
  it("acts on each announcement once", () => {
    const accept = createRegistryChangeFilter();
    const first = registryEvent({ payload: registryChangePayload("add", 1) });
    assert.ok(accept(first));
    assert.equal(accept(first), null, "the same event delivered twice");
    assert.equal(accept(registryEvent({ payload: registryChangePayload("add", 1) })), null);
  });

  it("drops an older revision that arrives late and accepts a newer one", () => {
    const accept = createRegistryChangeFilter();
    assert.ok(accept(registryEvent({ payload: registryChangePayload("rename", 5) })));
    assert.equal(accept(registryEvent({ payload: registryChangePayload("remove", 4) })), null);
    assert.ok(accept(registryEvent({ payload: registryChangePayload("remove", 6) })));
  });

  it("tracks each tab on its own", () => {
    const accept = createRegistryChangeFilter();
    assert.ok(accept(registryEvent({ origin: "tab-a", payload: registryChangePayload("add", 1) })));
    assert.ok(accept(registryEvent({ origin: "tab-b", payload: registryChangePayload("add", 1) })));
    assert.equal(
      accept(registryEvent({ origin: "tab-a", payload: registryChangePayload("add", 1) })),
      null,
    );
  });

  it("ignores events that are not registry changes and does not let them move the counter", () => {
    const accept = createRegistryChangeFilter();
    assert.equal(accept(registryEvent({ type: "GUARD_CHANGED" })), null);
    assert.ok(accept(registryEvent({ payload: registryChangePayload("add", 1) })));
    assert.equal(accept(registryEvent({ payload: { v: 9, kind: "add", revision: 99 } })), null);
    assert.ok(
      accept(registryEvent({ payload: registryChangePayload("add", 2) })),
      "a rejected event moved nothing",
    );
  });

  it("bounds the tabs it remembers", () => {
    const accept = createRegistryChangeFilter();
    for (let tab = 0; tab < 200; tab += 1) {
      assert.ok(
        accept(registryEvent({ origin: `tab-${tab}`, payload: registryChangePayload("add", 1) })),
      );
    }
    // The oldest tabs were forgotten, so a very old tab's revision 1 is accepted
    // again rather than memory growing without bound; recent tabs are still deduplicated.
    assert.ok(accept(registryEvent({ origin: "tab-0", payload: registryChangePayload("add", 1) })));
    assert.equal(
      accept(registryEvent({ origin: "tab-199", payload: registryChangePayload("add", 1) })),
      null,
    );
  });
});

describe("registry change announcer", () => {
  it("numbers announcements 1, 2, 3… and sends the guard with a versioned payload", () => {
    const sent: Array<{
      type: string;
      options?: { guard?: string; payload?: Record<string, unknown> };
    }> = [];
    const announce = createRegistryAnnouncer({
      broadcast: (type, options) => {
        sent.push({ type, ...(options === undefined ? {} : { options }) });
        return registryEvent();
      },
    });
    announce("add", GUARD);
    announce("rename", GUARD);
    announce("remove", SECOND_GUARD);

    assert.deepEqual(
      sent.map((entry) => [entry.type, entry.options?.guard, entry.options?.payload]),
      [
        ["REGISTRY_CHANGED", GUARD, registryChangePayload("add", 1)],
        ["REGISTRY_CHANGED", GUARD, registryChangePayload("rename", 2)],
        ["REGISTRY_CHANGED", SECOND_GUARD, registryChangePayload("remove", 3)],
      ],
    );
  });
});

describe("registry sync across tabs over BroadcastChannel", () => {
  it("delivers add, rename and remove to the other tab, validated and in order", () => {
    const hub = createMockHub();
    const tabA = createTabSync({ channelFactory: hub.create, origin: "tab-a" });
    const tabB = createTabSync({ channelFactory: hub.create, origin: "tab-b" });
    try {
      const accept = createRegistryChangeFilter();
      const notices: Array<[string, string]> = [];
      tabB.subscribe((event) => {
        const notice = accept(event);
        if (notice) notices.push([notice.kind, notice.guard]);
      });
      const announce = createRegistryAnnouncer(tabA);

      announce("add", GUARD);
      announce("rename", GUARD);
      announce("remove", GUARD);

      assert.deepEqual(notices, [
        ["add", GUARD],
        ["rename", GUARD],
        ["remove", GUARD],
      ]);
    } finally {
      tabA.close();
      tabB.close();
    }
  });

  it("never echoes a tab's own announcement back to it, even on a bus that echoes", () => {
    const hub = createMockHub({ echo: true });
    const tabA = createTabSync({ channelFactory: hub.create, origin: "tab-a" });
    try {
      const received: TabSyncEvent[] = [];
      tabA.subscribe((event) => received.push(event));
      createRegistryAnnouncer(tabA)("add", GUARD);
      assert.deepEqual(received, []);
    } finally {
      tabA.close();
    }
  });

  it("acts once when the same announcement arrives twice", () => {
    const hub = createMockHub();
    const tabB = createTabSync({ channelFactory: hub.create, origin: "tab-b" });
    const raw = hub.create(TAB_SYNC_CHANNEL);
    try {
      const accept = createRegistryChangeFilter();
      let acted = 0;
      tabB.subscribe((event) => {
        if (accept(event)) acted += 1;
      });
      const event = registryEvent({ payload: registryChangePayload("remove", 1) });
      raw.postMessage(event);
      raw.postMessage(event);
      assert.equal(acted, 1);
    } finally {
      raw.close();
      tabB.close();
    }
  });

  it("drops a forged or malformed announcement without acting on it", () => {
    const hub = createMockHub();
    const tabB = createTabSync({ channelFactory: hub.create, origin: "tab-b" });
    const raw = hub.create(TAB_SYNC_CHANNEL);
    try {
      const accept = createRegistryChangeFilter();
      let acted = 0;
      tabB.subscribe((event) => {
        if (accept(event)) acted += 1;
      });
      raw.postMessage(registryEvent({ payload: { v: 99, kind: "remove", revision: 1 } }));
      raw.postMessage(registryEvent({ payload: { v: 1, kind: "wipe", revision: 1 } }));
      raw.postMessage(registryEvent({ guard: "<script>alert(1)</script>" }));
      raw.postMessage({ type: "REGISTRY_CHANGED", origin: "tab-a" });
      raw.postMessage("REGISTRY_CHANGED");
      assert.equal(acted, 0);
    } finally {
      raw.close();
      tabB.close();
    }
  });

  it("registers one listener however many subscribers, and releases the tab on close", () => {
    const hub = createMockHub();
    const tabA = createTabSync({ channelFactory: hub.create, origin: "tab-a" });
    const tabB = createTabSync({ channelFactory: hub.create, origin: "tab-b" });
    const received: string[] = [];
    tabB.subscribe(() => received.push("one"));
    tabB.subscribe(() => received.push("two"));
    tabB.subscribe(() => received.push("three"));
    createRegistryAnnouncer(tabA)("add", GUARD);
    assert.deepEqual(received, ["one", "two", "three"]);
    assert.equal(hub.peerCount(TAB_SYNC_CHANNEL), 2);

    // Disposing the tab releases the channel and drops its listeners.
    tabB.close();
    assert.equal(hub.peerCount(TAB_SYNC_CHANNEL), 1);
    createRegistryAnnouncer(tabA)("remove", GUARD);
    assert.equal(received.length, 3, "a closed tab receives nothing more");
    tabA.close();
    assert.equal(hub.peerCount(TAB_SYNC_CHANNEL), 0);
  });

  it("announcing after close is inert", () => {
    const hub = createMockHub();
    const tabA = createTabSync({ channelFactory: hub.create, origin: "tab-a" });
    const tabB = createTabSync({ channelFactory: hub.create, origin: "tab-b" });
    try {
      const received: TabSyncEvent[] = [];
      tabB.subscribe((event) => received.push(event));
      tabA.close();
      createRegistryAnnouncer(tabA)("add", GUARD);
      assert.deepEqual(received, []);
    } finally {
      tabB.close();
    }
  });
});

describe("registry sync over the localStorage fallback", () => {
  function twoTabs() {
    const { storage, raw } = createMockStorage();
    const events = createMockEventTarget();
    const tabA = createTabSync({
      channelFactory: null,
      storage,
      eventTarget: events.target,
      origin: "tab-a",
    });
    const tabB = createTabSync({
      channelFactory: null,
      storage,
      eventTarget: events.target,
      origin: "tab-b",
    });
    return { raw, events, tabA, tabB };
  }

  it("is the transport when BroadcastChannel is unavailable", () => {
    const { tabA, tabB } = twoTabs();
    try {
      assert.equal(tabA.transport, "storage");
      assert.equal(tabB.transport, "storage");
    } finally {
      tabA.close();
      tabB.close();
    }
  });

  it("delivers add, rename and remove through storage events", () => {
    const { raw, events, tabA, tabB } = twoTabs();
    try {
      const accept = createRegistryChangeFilter();
      const notices: Array<[string, string]> = [];
      tabB.subscribe((event) => {
        const notice = accept(event);
        if (notice) notices.push([notice.kind, notice.guard]);
      });
      const announce = createRegistryAnnouncer(tabA);

      for (const [kind, guard] of [
        ["add", GUARD],
        ["rename", GUARD],
        ["remove", SECOND_GUARD],
      ] as const) {
        announce(kind, guard);
        // The browser fires `storage` in the other tabs; emulate exactly that.
        events.emit({ key: TAB_SYNC_STORAGE_KEY, newValue: raw() });
      }

      assert.deepEqual(notices, [
        ["add", GUARD],
        ["rename", GUARD],
        ["remove", SECOND_GUARD],
      ]);
    } finally {
      tabA.close();
      tabB.close();
    }
  });

  it("does not replay a tab's own write to it, and ignores a replayed storage event", () => {
    const { raw, events, tabA, tabB } = twoTabs();
    try {
      const accept = createRegistryChangeFilter();
      const ownReceived: TabSyncEvent[] = [];
      let acted = 0;
      tabA.subscribe((event) => ownReceived.push(event));
      tabB.subscribe((event) => {
        if (accept(event)) acted += 1;
      });

      createRegistryAnnouncer(tabA)("add", GUARD);
      const written = raw();
      events.emit({ key: TAB_SYNC_STORAGE_KEY, newValue: written });
      events.emit({ key: TAB_SYNC_STORAGE_KEY, newValue: written });

      assert.deepEqual(ownReceived, [], "the writer never hears itself");
      assert.equal(acted, 1, "the same storage event delivered twice acts once");
    } finally {
      tabA.close();
      tabB.close();
    }
  });

  it("registers one storage listener however many subscribers, and removes it on close", () => {
    const { events, tabA, tabB } = twoTabs();
    tabB.subscribe(() => {});
    tabB.subscribe(() => {});
    tabB.subscribe(() => {});
    tabA.subscribe(() => {});
    assert.equal(events.listenerCount(), 2, "one per tab, not one per subscriber");

    tabB.close();
    assert.equal(events.listenerCount(), 1);
    tabA.close();
    assert.equal(events.listenerCount(), 0);
  });

  it("ignores a corrupt storage value", () => {
    const { events, tabA, tabB } = twoTabs();
    try {
      const accept = createRegistryChangeFilter();
      let acted = 0;
      tabB.subscribe((event) => {
        if (accept(event)) acted += 1;
      });
      events.emit({ key: TAB_SYNC_STORAGE_KEY, newValue: "{not json" });
      events.emit({
        key: TAB_SYNC_STORAGE_KEY,
        newValue: JSON.stringify({
          nonce: "n",
          event: registryEvent({ payload: { v: 1, kind: "x", revision: 1 } }),
        }),
      });
      assert.equal(acted, 0);
    } finally {
      tabA.close();
      tabB.close();
    }
  });
});
