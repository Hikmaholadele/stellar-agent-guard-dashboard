/**
 * The saved-guard registry: CRUD, per-network namespacing and the one-time v1
 * migration. These are the pure-storage guarantees the switcher depends on, so
 * every write is checked against a fake `Storage` rather than a browser.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  INSTANCE_LIMIT,
  INSTANCE_STORAGE_PREFIX,
  KNOWN_INSTANCES,
  KNOWN_INSTANCE_ADDED_AT,
  LEGACY_INSTANCE_STORAGE_KEY,
  defaultGuardLabel,
  findInstance,
  instanceStorageKey,
  isKnownInstance,
  loadInstances,
  rememberInstance,
  renameInstance,
  removeInstance,
  type StorageLike,
} from "../../lib/guard/instance.ts";

const PHASE1 = KNOWN_INSTANCES[0]!.guard;
const PHASE2 = KNOWN_INSTANCES[1]!.guard;
const ADDED = "CBLQLJAG72M4XQRJMQHSKYIFVHQD7LNTNOQH2GRMCMBWMSLBSLTGTJC7";
const OTHER = "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB";

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

/** A syntactically valid, unique `C…` address, used to fill past the storage cap. */
function syntheticAddress(index: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const low = alphabet[index % alphabet.length]!;
  const high = alphabet[Math.floor(index / alphabet.length) % alphabet.length]!;
  return `C${"A".repeat(53)}${low}${high}`;
}

describe("loading and defaults", () => {
  it("offers the known instances with a network and addedAt when storage is empty", () => {
    const loaded = loadInstances({ storage: memoryStorage() });
    assert.deepEqual(
      loaded.map((instance) => instance.guard),
      KNOWN_INSTANCES.map((instance) => instance.guard),
    );
    for (const instance of loaded) {
      assert.equal(instance.network, "testnet");
      assert.equal(instance.addedAt, KNOWN_INSTANCE_ADDED_AT);
    }
  });

  it("is inert without storage (server render, private mode)", () => {
    assert.equal(loadInstances({ storage: null }).length, KNOWN_INSTANCES.length);
  });

  it("drops corrupted, non-array and invalid entries instead of throwing", () => {
    const corrupt = memoryStorage({ [instanceStorageKey("testnet")]: "{ not json" });
    assert.equal(loadInstances({ storage: corrupt }).length, KNOWN_INSTANCES.length);

    const notArray = memoryStorage({ [instanceStorageKey("testnet")]: '{"a":1}' });
    assert.equal(loadInstances({ storage: notArray }).length, KNOWN_INSTANCES.length);

    const mixed = memoryStorage({
      [instanceStorageKey("testnet")]: JSON.stringify([
        { guard: ADDED, label: "Good" },
        { guard: "not-an-address", label: "Bad" },
        { guard: OTHER, label: "   " },
      ]),
    });
    const loaded = loadInstances({ storage: mixed });
    // Both valid addresses survive; the blank label falls back to a default.
    const added = loaded.find((instance) => instance.guard === ADDED)!;
    assert.equal(added.label, "Good");
    const other = loaded.find((instance) => instance.guard === OTHER)!;
    assert.equal(other.label, defaultGuardLabel(OTHER));
    assert.equal(
      loaded.some((instance) => instance.guard === "not-an-address"),
      false,
    );
  });

  it("caps the saved list at INSTANCE_LIMIT", () => {
    const entries = Array.from({ length: INSTANCE_LIMIT + 20 }, (_, index) => ({
      guard: syntheticAddress(index),
      label: `Guard ${index}`,
      network: "testnet",
      addedAt: KNOWN_INSTANCE_ADDED_AT,
      provenance: "test",
    }));
    const storage = memoryStorage({ [instanceStorageKey("testnet")]: JSON.stringify(entries) });
    const saved = loadInstances({ storage }).filter((instance) => !isKnownInstance(instance.guard));
    assert.equal(saved.length, INSTANCE_LIMIT);
  });
});

describe("adding and remembering", () => {
  it("persists under the network-namespaced key with the full shape", () => {
    const storage = memoryStorage();
    const saved = rememberForTest(ADDED, "Treasury", "testnet", storage);
    const entry = saved.find((instance) => instance.guard === ADDED)!;
    assert.equal(entry.label, "Treasury");
    assert.equal(entry.network, "testnet");
    assert.match(entry.addedAt, /^\d{4}-\d{2}-\d{2}T/);
    const raw = storage.dump()[instanceStorageKey("testnet")];
    assert.ok(raw, "written under the namespaced key");
    assert.equal(
      storage.dump()[instanceStorageKey("mainnet")],
      undefined,
      "not written to another network",
    );
  });

  it("namespaces per network: a Testnet guard never appears in the Mainnet list", () => {
    const storage = memoryStorage();
    rememberForTest(ADDED, "Testnet guard", "testnet", storage);
    const mainnet = loadInstances({ network: "mainnet", storage });
    assert.equal(
      mainnet.some((instance) => instance.guard === ADDED),
      false,
    );
    assert.equal(instanceStorageKey("mainnet"), `${INSTANCE_STORAGE_PREFIX}.mainnet`);
  });

  it("does not duplicate or overwrite a known instance", () => {
    const storage = memoryStorage();
    const saved = rememberForTest(PHASE1, "Renamed by add", "testnet", storage);
    assert.equal(saved.find((instance) => instance.guard === PHASE1)!.label, "Phase 1 guard");
    assert.equal(saved.filter((instance) => instance.guard === PHASE1).length, 1);
  });
});

describe("rename and delete", () => {
  it("renames a saved instance in place", () => {
    const storage = memoryStorage();
    rememberForTest(ADDED, "Old", "testnet", storage);
    const renamed = renameInstance(ADDED, "New", { storage });
    assert.equal(renamed.find((instance) => instance.guard === ADDED)!.label, "New");
    // Persisted: a fresh load still sees the new name.
    assert.equal(findInstance(ADDED, { storage })!.label, "New");
  });

  it("renames a known instance with a shadow override that wins on load", () => {
    const storage = memoryStorage();
    const renamed = renameInstance(PHASE2, "My Phase 2", { storage });
    const matches = renamed.filter((instance) => instance.guard === PHASE2);
    assert.equal(matches.length, 1, "the known instance is not duplicated");
    assert.equal(matches[0]!.label, "My Phase 2");
    assert.match(matches[0]!.provenance, /Renamed from this browser/);
  });

  it("ignores a blank rename rather than wiping the label", () => {
    const storage = memoryStorage();
    rememberForTest(ADDED, "Keep me", "testnet", storage);
    const after = renameInstance(ADDED, "   ", { storage });
    assert.equal(after.find((instance) => instance.guard === ADDED)!.label, "Keep me");
  });

  it("removes a saved instance and leaves the rest and the known ones", () => {
    const storage = memoryStorage();
    rememberForTest(ADDED, "A", "testnet", storage);
    rememberForTest(OTHER, "B", "testnet", storage);
    const after = removeInstance(ADDED, { storage });
    assert.equal(
      after.some((instance) => instance.guard === ADDED),
      false,
    );
    assert.equal(
      after.some((instance) => instance.guard === OTHER),
      true,
    );
    assert.equal(
      after.filter((instance) => isKnownInstance(instance.guard)).length,
      KNOWN_INSTANCES.length,
    );
  });

  it("cannot delete a build-seeded instance", () => {
    const storage = memoryStorage();
    const after = removeInstance(PHASE1, { storage });
    assert.equal(
      after.some((instance) => instance.guard === PHASE1),
      true,
    );
  });
});

describe("v1 → v2 migration", () => {
  it("leaves a partially malformed legacy list unchanged for recovery", () => {
    const raw = JSON.stringify([
      { guard: ADDED, label: "Legacy" },
      { guard: "not-an-address", label: "Malformed" },
    ]);
    const storage = memoryStorage({ [LEGACY_INSTANCE_STORAGE_KEY]: raw });
    loadInstances({ storage });
    assert.equal(storage.dump()[LEGACY_INSTANCE_STORAGE_KEY], raw);
    assert.equal(storage.dump()[instanceStorageKey("testnet")], undefined);
  });

  it("adopts legacy entries into the current network and removes the old key", () => {
    const storage = memoryStorage({
      [LEGACY_INSTANCE_STORAGE_KEY]: JSON.stringify([{ guard: ADDED, label: "Legacy" }]),
    });
    const loaded = loadInstances({ storage });
    const migrated = loaded.find((instance) => instance.guard === ADDED)!;
    assert.ok(migrated, "the legacy entry survives");
    assert.equal(migrated.network, "testnet", "adopted into the current network");
    assert.match(migrated.addedAt, /^\d{4}-\d{2}-\d{2}T/, "given an addedAt");
    assert.equal(storage.dump()[LEGACY_INSTANCE_STORAGE_KEY], undefined, "legacy key removed");
    assert.ok(storage.dump()[instanceStorageKey("testnet")], "written to the v2 key");
  });

  it("runs only when the v2 key is absent, so an emptied v2 list is not re-seeded", () => {
    const storage = memoryStorage({
      [instanceStorageKey("testnet")]: "[]",
      [LEGACY_INSTANCE_STORAGE_KEY]: JSON.stringify([{ guard: ADDED, label: "Legacy" }]),
    });
    const loaded = loadInstances({ storage });
    assert.equal(
      loaded.some((instance) => instance.guard === ADDED),
      false,
      "no re-seed",
    );
    assert.ok(storage.dump()[LEGACY_INSTANCE_STORAGE_KEY], "legacy key is left alone");
  });

  it("does not migrate for a different network's first load", () => {
    const storage = memoryStorage({
      [LEGACY_INSTANCE_STORAGE_KEY]: JSON.stringify([{ guard: ADDED, label: "Legacy" }]),
    });
    const mainnet = loadInstances({ network: "mainnet", storage });
    assert.equal(
      mainnet.some((instance) => instance.guard === ADDED),
      false,
    );
    // The migration is not consumed: Testnet's first load can still adopt it.
    const testnet = loadInstances({ network: "testnet", storage });
    assert.equal(
      testnet.some((instance) => instance.guard === ADDED),
      true,
    );
  });
});

function rememberForTest(
  guard: string,
  label: string,
  network: string,
  storage: StorageLike,
): ReturnType<typeof loadInstances> {
  return rememberInstance(guard, label, { network, storage });
}
