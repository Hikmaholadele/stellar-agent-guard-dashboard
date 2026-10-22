import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TAB_SYNC_CHANNEL,
  TAB_SYNC_STORAGE_KEY,
  acquireGuardWriteLock,
  createTabSync,
  isTabSyncEvent,
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

  it("rejects anything that is not one of the four broadcastable changes", () => {
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
