/**
 * The contract storage explorer (issue #150).
 *
 * Two things are pinned here, and they are the two that can be wrong quietly:
 *
 *   - **Decoding.** A guard window entry holds `i128` stroop amounts, which
 *     `JSON.stringify` throws on; the explorer has to render them exactly. The
 *     fixtures are the SDK's own XDR, built the way the ledger builds them, so
 *     the decode path under test is the one a testnet read takes.
 *   - **Drawer state.** The rule the console keeps everywhere is that a failed
 *     read is not an empty-but-valid answer. These tests hold the reducer to
 *     it: a failed read clears the entries rather than leaving the previous
 *     map on screen looking current.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import { toHex } from "../../lib/guard/scval.ts";
import {
  INITIAL_EXPLORER_STATE,
  MAX_JSON_DEPTH,
  absentStorageEntry,
  classifyTtl,
  decodeStorageEntry,
  explorerReducer,
  formatAsJson,
  getOperatorStorageCategories,
  clearOperatorStorageCategory,
  jsonTree,
  storageKeyLabel,
  summarizeEntries,
  visibleEntries,
  type ExplorerState,
  type RawLedgerEntry,
  type StorageEntryView,
} from "../../lib/guard/storage.ts";

import {
  MOCK_GUARD,
  contractInstanceEntry,
  initializedFlag,
  persistentDataEntry,
  structScVal,
  u64,
  windowScVal,
} from "../mocks/sorobanFixtures.ts";
import { ADDRESS_BOOK_STORAGE_KEY } from "../../lib/guard/addressBook.ts";
import { TX_HISTORY_STORAGE_KEY } from "../../lib/guard/txHistory.ts";
import { LAYOUT_STORAGE_KEY } from "../../lib/guard/layoutStore.ts";
import { THEME_STORAGE_KEY } from "../../lib/guard/presentationStorageKeys.ts";
import { INSTANCE_STORAGE_PREFIX, LEGACY_INSTANCE_STORAGE_KEY } from "../../lib/guard/instance.ts";
import { SCOPED_STORAGE_PREFIX } from "../../lib/guard/guardScoped.ts";
import { installDom, loadReact } from "./domHarness.ts";
import { GuardContext, type GuardContextValue } from "../../components/GuardProvider.tsx";
import { StorageExplorerButton } from "../../components/StorageExplorer.tsx";

/** The ledger head the fixtures below are read against. */
const CURRENT_LEDGER = 1_000;

/** `getLedgerEntries` hands back a fixture as `{ key, val, … }`. */
function asRaw(fixture: {
  key: xdr.LedgerKey;
  data: xdr.LedgerEntryData;
  liveUntilLedgerSeq?: number;
}): RawLedgerEntry {
  return {
    key: fixture.key,
    val: fixture.data,
    lastModifiedLedgerSeq: CURRENT_LEDGER,
    liveUntilLedgerSeq: fixture.liveUntilLedgerSeq ?? CURRENT_LEDGER + 4_000,
  };
}

function decodeFixture(
  fixture: Parameters<typeof asRaw>[0],
  currentLedger: number | null = CURRENT_LEDGER,
): StorageEntryView {
  return decodeStorageEntry(asRaw(fixture), currentLedger);
}

// ── TTL tiering ─────────────────────────────────────────────────────────────

describe("classifyTtl", () => {
  test("tiers remaining lifetime against the ledger the read was made at", () => {
    assert.deepEqual(classifyTtl(4_100, CURRENT_LEDGER), {
      tier: "ok",
      remainingLedgers: 3_100,
    });
    assert.deepEqual(classifyTtl(1_200, CURRENT_LEDGER), {
      tier: "warn",
      remainingLedgers: 200,
    });
    assert.deepEqual(classifyTtl(1_050, CURRENT_LEDGER), {
      tier: "critical",
      remainingLedgers: 50,
    });
  });

  test("an entry at or past its TTL is expired, including exactly at the boundary", () => {
    assert.equal(classifyTtl(CURRENT_LEDGER, CURRENT_LEDGER).tier, "expired");
    assert.equal(classifyTtl(CURRENT_LEDGER - 1, CURRENT_LEDGER).tier, "expired");
    assert.equal(classifyTtl(CURRENT_LEDGER - 1, CURRENT_LEDGER).remainingLedgers, -1);
  });

  test("no TTL, or no ledger to judge it against, is 'unknown' — never a guess", () => {
    // No TTL on the entry: nothing to count down.
    assert.deepEqual(classifyTtl(null, CURRENT_LEDGER), {
      tier: "unknown",
      remainingLedgers: null,
    });
    // The latest-ledger read failed: an expiry cannot be judged without it.
    assert.deepEqual(classifyTtl(4_100, null), { tier: "unknown", remainingLedgers: null });
  });
});

// ── Entry decoding ──────────────────────────────────────────────────────────

describe("decodeStorageEntry", () => {
  test("names the guard's own keys by their DataKey variant", () => {
    const view = decodeFixture(
      persistentDataEntry(
        MOCK_GUARD,
        "Window",
        windowScVal({
          total: 30n,
          entries: [{ ts: 100n, amount: 30n }],
        }),
      ),
    );
    assert.equal(view.label, "Window");
    assert.equal(view.durability, "persistent");
    assert.equal(view.present, true);
    assert.equal(view.decodeError, null);
  });

  test("renders bigint stroop amounts exactly, as JSON and in the tree", () => {
    // Above 2^53: a `Number()` round-trip here would silently lose digits.
    const huge = 12_345_678_901_234_567_890n;
    const window = windowScVal({ total: huge, entries: [{ ts: 1_700_000_000n, amount: huge }] });
    const view = decodeFixture(persistentDataEntry(MOCK_GUARD, "Window", window));

    const decoded = view.value as { total: bigint; entries: Array<{ ts: bigint }> };
    assert.equal(decoded.total, huge);
    assert.ok(
      (view.jsonText ?? "").includes('"total": "12345678901234567890"'),
      "the copied JSON must carry the exact decimal amount",
    );
    // The tree carries the same text as the copyable JSON, so what is shown and
    // what is copied cannot disagree.
    const tree = view.json;
    assert.equal(tree?.kind, "map");
    const total = (
      tree as { entries: Array<{ key: string; value: { text: string } }> }
    ).entries.find((entry) => entry.key === "total");
    assert.equal(total?.value.text, "12345678901234567890");
    // And the rendering itself is valid JSON, not a JS-object print.
    assert.deepEqual(JSON.parse(view.jsonText ?? "{}"), {
      total: "12345678901234567890",
      entries: [{ amount: "12345678901234567890", ts: "1700000000" }],
    });
  });

  test("decodes the contract instance into an executable and its instance storage", () => {
    const wasmHash = new Uint8Array(32).fill(9);
    const fixture = contractInstanceEntry({
      contractId: MOCK_GUARD,
      wasmHash,
      storage: [initializedFlag(true)],
    });
    const view = decodeFixture(fixture);

    assert.equal(view.label, "(contract instance)");
    // The instance entry is its own storage class, not reported as persistent.
    assert.equal(view.durability, "instance");
    const value = view.value as {
      executable: { kind: string; wasmHash: string | null };
      storage: Array<{ key: unknown; value: unknown }>;
    };
    assert.equal(value.executable.kind, "contractExecutableWasm");
    assert.equal(value.executable.wasmHash, toHex(wasmHash));
    // The guard stores its instance flag as `Vec[Symbol("Initialized")]`, exactly
    // as the contract writes it, so the decoded key is the whole vector.
    assert.deepEqual(value.storage, [{ key: ["Initialized"], value: true }]);
  });

  test("reports a scalar entry's type and TTL as the ledger stated them", () => {
    const fixture = persistentDataEntry(MOCK_GUARD, "DeadManSwitch", u64(1_789_481_700n));
    const view = decodeStorageEntry(
      { ...asRaw(fixture), liveUntilLedgerSeq: CURRENT_LEDGER + 4_000 },
      CURRENT_LEDGER,
    );
    assert.equal(view.value, 1_789_481_700n);
    assert.equal(view.ttlTier, "ok");
    assert.equal(view.remainingLedgers, 4_000);
    assert.equal(view.liveUntilLedgerSeq, CURRENT_LEDGER + 4_000);
    assert.equal(view.lastModifiedLedgerSeq, CURRENT_LEDGER);
    // Raw XDR for both halves, so the value can be pasted into a decoder.
    assert.ok(view.keyXdr.length > 0);
    assert.ok(view.valueXdr.length > 0);
    // The key XDR round-trips: it is the entry's identity, and it is the same
    // string the RPC accepts, so the id can be re-read directly.
    assert.equal(view.id, view.keyXdr);
    assert.equal(
      (
        xdr.LedgerKey.fromXDR(view.id, "base64") as unknown as {
          contractData: xdr.LedgerKeyContractData;
        }
      ).contractData.durability.name,
      "persistent",
    );
  });

  test("an entry with no TTL says unknown rather than a countdown", () => {
    const view = decodeStorageEntry(
      {
        key: persistentDataEntry(MOCK_GUARD, "Paused", xdr.ScVal.scvBool(true)).key,
        val: persistentDataEntry(MOCK_GUARD, "Paused", xdr.ScVal.scvBool(true)).data,
        lastModifiedLedgerSeq: CURRENT_LEDGER,
        liveUntilLedgerSeq: null,
      },
      CURRENT_LEDGER,
    );
    assert.equal(view.ttlTier, "unknown");
    assert.equal(view.remainingLedgers, null);
    assert.equal(view.liveUntilLedgerSeq, null);
  });

  test("an undecodable value keeps the entry and its TTL, and names the failure", () => {
    // A contract-data entry whose address arm this SDK build cannot normalise:
    // `scValToNative` throws on it. The entry is real and its identity, TTL and
    // key XDR are all readable — only the value is beyond this console.
    const broken: RawLedgerEntry = {
      key: persistentDataEntry(MOCK_GUARD, "Policy", xdr.ScVal.scvU32(1)).key,
      val: xdr.LedgerEntryData.contractData(
        new xdr.ContractDataEntry({
          ext: xdr.ExtensionPoint.v0(),
          contract: new Address(MOCK_GUARD).toScAddress(),
          key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Policy")]),
          durability: xdr.ContractDataDurability.persistent,
          val: xdr.ScVal.scvAddress(MOCK_GUARD as unknown as xdr.ScAddress),
        }),
      ),
      lastModifiedLedgerSeq: CURRENT_LEDGER,
      liveUntilLedgerSeq: CURRENT_LEDGER + 4_000,
    };
    const view = decodeStorageEntry(broken, CURRENT_LEDGER);
    // A row that could not be read is still a row: identity, key XDR and TTL
    // survive, and the failure is named rather than the entry being dropped.
    assert.equal(view.label, "Policy");
    assert.equal(view.present, true);
    assert.equal(view.ttlTier, "ok");
    assert.equal(view.remainingLedgers, 4_000);
    assert.ok(view.keyXdr.length > 0);
    assert.ok(view.decodeError, "the row must say why it could not be decoded");
    assert.equal(view.json, null);
    assert.equal(view.jsonText, null);
  });

  test("an entry whose value is not contract data at all is reported, not decoded", () => {
    // What an RPC hands back for a key whose entry is present but carries no
    // `contractData` arm: identity and TTL survive, the value does not exist.
    const view = decodeStorageEntry(
      {
        key: persistentDataEntry(MOCK_GUARD, "Paused", xdr.ScVal.scvBool(true)).key,
        val: xdr.LedgerEntryData.ttl(
          new xdr.TtlEntry({
            keyHash: new Uint8Array(32),
            liveUntilLedgerSeq: CURRENT_LEDGER + 4_000,
          }),
        ),
        lastModifiedLedgerSeq: CURRENT_LEDGER,
        liveUntilLedgerSeq: CURRENT_LEDGER + 4_000,
      },
      CURRENT_LEDGER,
    );
    assert.equal(view.label, "Paused");
    assert.match(view.decodeError ?? "", /no contract-data value/);
    assert.equal(view.json, null);
  });

  test("a key the ledger does not hold gets an absent row, not a gap", () => {
    const view = absentStorageEntry("abcd", "Policy");
    assert.equal(view.present, false);
    assert.equal(view.label, "Policy");
    assert.equal(view.ttlTier, "unknown");
    assert.equal(view.value, null);
    assert.equal(view.decodeError, null);
  });
});

describe("storageKeyLabel", () => {
  test("a one-element Vec[Symbol] renders as the bare variant name", () => {
    assert.equal(storageKeyLabel(xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Window")])), "Window");
  });

  test("a key this console does not recognise renders as its JSON, whole", () => {
    const label = storageKeyLabel(
      xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Balances"), new Address(MOCK_GUARD).toScVal()]),
    );
    assert.match(label, /Balances/);
    assert.match(label, /C[A-Z0-9]{10}/);
  });

  test("the contract-instance key is named, not rendered as raw JSON", () => {
    assert.equal(storageKeyLabel(xdr.ScVal.scvLedgerKeyContractInstance()), "(contract instance)");
  });
});

// ── JSON tree ───────────────────────────────────────────────────────────────

describe("jsonTree / formatAsJson", () => {
  test("every node kind renders text a copy can carry", () => {
    assert.deepEqual(jsonTree("Policy"), { kind: "string", text: "Policy" });
    assert.deepEqual(jsonTree(42n), { kind: "number", text: "42" });
    assert.deepEqual(jsonTree(false), { kind: "boolean", text: "false" });
    assert.deepEqual(jsonTree(null), { kind: "null", text: "null" });
    assert.deepEqual(jsonTree(undefined), { kind: "undefined", text: "undefined" });
    assert.deepEqual(jsonTree(new Uint8Array([0xde, 0xad])), {
      kind: "bytes",
      text: "dead",
      bytes: 2,
    });
  });

  test("a struct decodes to a map of symbol-named fields", () => {
    const policy = structScVal({
      per_tx_cap: xdr.ScVal.scvU32(1_000),
      paused: xdr.ScVal.scvBool(false),
    });
    const tree = jsonTree(scValToNative(policy));
    assert.equal(tree.kind, "map");
  });

  test("a value deeper than MAX_JSON_DEPTH is truncated rather than walked", () => {
    let deep: unknown = 1n;
    for (let level = 0; level < MAX_JSON_DEPTH + 3; level += 1) deep = { next: deep };
    const tree = jsonTree(deep);
    // The walk terminates and the truncation is visible in the text, not silent.
    assert.equal(tree.kind, "map");
    assert.match(JSON.stringify(tree), /truncated/);
  });

  test("formatAsJson emits JSON-parseable text for values JSON.stringify rejects", () => {
    const text = formatAsJson({ total: 9007199254740993n, bytes: new Uint8Array([1, 255]) });
    assert.deepEqual(JSON.parse(text), { total: "9007199254740993", bytes: "01ff" });
  });
});

// ── Drawer state ────────────────────────────────────────────────────────────

/** A drawer holding two successfully-read entries. */
function loadedState(): ExplorerState {
  return explorerReducer(INITIAL_EXPLORER_STATE, {
    type: "loaded",
    entries: [
      decodeFixture(
        persistentDataEntry(
          MOCK_GUARD,
          "Window",
          windowScVal({ total: 30n, entries: [{ ts: 100n, amount: 30n }] }),
        ),
      ),
      decodeFixture(persistentDataEntry(MOCK_GUARD, "Policy", xdr.ScVal.scvU32(1))),
    ],
  });
}

describe("explorerReducer", () => {
  test("opens, closes and toggles, and closing keeps the entries for the reopen", () => {
    const open = explorerReducer(INITIAL_EXPLORER_STATE, { type: "open" });
    assert.equal(open.open, true);
    assert.equal(explorerReducer(open, { type: "close" }).open, false);
    assert.equal(explorerReducer(open, { type: "toggle" }).open, false);

    // The map survives the close: reopening shows the previous read immediately
    // rather than an empty drawer, while the fresh read is in flight.
    const withEntries = explorerReducer(loadedState(), { type: "close" });
    assert.equal(withEntries.entries.length, 2);
  });

  test("a successful read replaces the entries and drops a now-stale selection", () => {
    const selected = explorerReducer(loadedState(), { type: "select", id: "policy-id" });
    assert.equal(selected.selected, "policy-id");
    const reloaded = explorerReducer(selected, {
      type: "loaded",
      entries: [decodeFixture(persistentDataEntry(MOCK_GUARD, "Paused", xdr.ScVal.scvBool(true)))],
    });
    assert.equal(reloaded.entries.length, 1);
    assert.equal(reloaded.selected, null);
    assert.equal(reloaded.error, null);
    assert.equal(reloaded.loading, false);
  });

  test("a failed read clears the entries — a stale map is not the current state", () => {
    const failed = explorerReducer(loadedState(), { type: "failed", error: "rpc timeout" });
    assert.equal(failed.error, "rpc timeout");
    assert.deepEqual(failed.entries, []);
    assert.equal(failed.loading, false);
    assert.equal(failed.selected, null);
  });

  test("a new read starts by clearing the previous error", () => {
    const failed = explorerReducer(loadedState(), { type: "failed", error: "rpc timeout" });
    const retrying = explorerReducer(failed, { type: "loading" });
    assert.equal(retrying.error, null);
    assert.equal(retrying.loading, true);
  });

  test("selecting the expanded entry again collapses it", () => {
    const state = loadedState();
    const first = explorerReducer(state, { type: "select", id: "policy-id" });
    assert.equal(first.selected, "policy-id");
    assert.equal(explorerReducer(first, { type: "select", id: "policy-id" }).selected, null);
  });

  test("the durability filter toggles each class independently", () => {
    const persistentOnly = explorerReducer(loadedState(), {
      type: "toggleDurability",
      durability: "persistent",
    });
    assert.deepEqual(persistentOnly.durabilityFilter, ["persistent"]);
    assert.deepEqual(
      explorerReducer(persistentOnly, { type: "toggleDurability", durability: "persistent" })
        .durabilityFilter,
      [],
    );
    const both = explorerReducer(persistentOnly, {
      type: "toggleDurability",
      durability: "temporary",
    });
    assert.deepEqual(both.durabilityFilter, ["persistent", "temporary"]);
  });
});

describe("visibleEntries", () => {
  test("orders instance first, then persistent, then temporary, alphabetically", () => {
    const state: ExplorerState = {
      ...INITIAL_EXPLORER_STATE,
      entries: [
        { ...absentStorageEntry("3", "Window"), durability: "persistent" },
        { ...absentStorageEntry("4", "AdminFrozen"), durability: "temporary" },
        { ...absentStorageEntry("1", "(contract instance)"), durability: "instance" },
        { ...absentStorageEntry("2", "Policy"), durability: "persistent" },
      ],
    };
    assert.deepEqual(
      visibleEntries(state).map((entry) => entry.label),
      ["(contract instance)", "Policy", "Window", "AdminFrozen"],
    );
  });

  test("the label filter is case-insensitive and combines with the durability filter", () => {
    const state = loadedState();
    const filtered = visibleEntries({ ...state, query: "POL" });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]?.label, "Policy");

    // No overlap between the two filters yields no rows rather than all rows.
    assert.deepEqual(
      visibleEntries({ ...state, query: "Policy", durabilityFilter: ["temporary"] }),
      [],
    );
  });

  test("sorting does not mutate the state's own entry order", () => {
    const state = loadedState();
    const before = state.entries.map((entry) => entry.label);
    visibleEntries(state);
    assert.deepEqual(
      state.entries.map((entry) => entry.label),
      before,
    );
  });
});

describe("summarizeEntries", () => {
  test("counts what is present and calls out entries near expiry", () => {
    const expiring = decodeStorageEntry(
      asRaw(persistentDataEntry(MOCK_GUARD, "Paused", xdr.ScVal.scvBool(true))),
      CURRENT_LEDGER,
    );
    const doomed = decodeStorageEntry(
      {
        ...asRaw(persistentDataEntry(MOCK_GUARD, "Policy", xdr.ScVal.scvU32(1))),
        liveUntilLedgerSeq: CURRENT_LEDGER - 5,
      },
      CURRENT_LEDGER,
    );
    const summary = summarizeEntries([expiring, doomed, absentStorageEntry("z", "Window")]);
    assert.match(summary, /2 of 3 entries present/);
    assert.match(summary, /1 at or past its expiration warning/);
  });

  test("the singular is singular", () => {
    assert.match(summarizeEntries([absentStorageEntry("a", "Policy")]), /0 of 1 entry present/);
  });
});

describe("operator browser-local storage controls and category isolation (#332)", () => {
  function makeFakeStore() {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => data.set(k, v),
      removeItem: (k: string) => data.delete(k),
    };
  }

  test("getOperatorStorageCategories lists every supported category with descriptions and counts", () => {
    const store = makeFakeStore();
    store.setItem(
      TX_HISTORY_STORAGE_KEY,
      JSON.stringify([
        { hash: "h1", operation: "freeze", status: "confirmed", recordedAt: "2026-10-20" },
      ]),
    );
    store.setItem(ADDRESS_BOOK_STORAGE_KEY, JSON.stringify([{ address: "GA...", alias: "Alice" }]));
    store.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(["status", "txhistory"]));
    store.setItem(THEME_STORAGE_KEY, "dark");
    store.setItem(
      `${INSTANCE_STORAGE_PREFIX}.testnet`,
      JSON.stringify([{ address: "CA...", label: "My Guard" }]),
    );

    const categories = getOperatorStorageCategories(store);
    assert.equal(categories.length, 4);

    const historyCat = categories.find((c) => c.id === "history")!;
    assert.equal(historyCat.name, "Transaction History");
    assert.equal(historyCat.itemCount, 1);
    assert.ok(historyCat.description.length > 0);

    const addressCat = categories.find((c) => c.id === "address-book")!;
    assert.equal(addressCat.name, "Address Book");
    assert.equal(addressCat.itemCount, 1);

    const layoutCat = categories.find((c) => c.id === "layouts")!;
    assert.equal(layoutCat.name, "Layouts & UI Preferences");
    assert.equal(layoutCat.itemCount, 2);

    const guardCat = categories.find((c) => c.id === "guard-registry")!;
    assert.equal(guardCat.name, "Guard Registry");
    assert.equal(guardCat.itemCount, 1);
  });

  test("category isolation: clearing history leaves address-book, layouts, and guard-registry untouched", () => {
    const store = makeFakeStore();
    store.setItem(TX_HISTORY_STORAGE_KEY, JSON.stringify([{ hash: "h1" }]));
    store.setItem(ADDRESS_BOOK_STORAGE_KEY, JSON.stringify([{ address: "GA..." }]));
    store.setItem(LAYOUT_STORAGE_KEY, "layouts");
    store.setItem(`${INSTANCE_STORAGE_PREFIX}.testnet`, "guards");

    clearOperatorStorageCategory("history", store);

    assert.equal(store.getItem(TX_HISTORY_STORAGE_KEY), null);
    assert.equal(store.getItem(ADDRESS_BOOK_STORAGE_KEY), JSON.stringify([{ address: "GA..." }]));
    assert.equal(store.getItem(LAYOUT_STORAGE_KEY), "layouts");
    assert.equal(store.getItem(`${INSTANCE_STORAGE_PREFIX}.testnet`), "guards");
  });

  test("category isolation: clearing address-book leaves other categories untouched", () => {
    const store = makeFakeStore();
    store.setItem(TX_HISTORY_STORAGE_KEY, "history");
    store.setItem(ADDRESS_BOOK_STORAGE_KEY, "addressbook");
    store.setItem(LAYOUT_STORAGE_KEY, "layouts");
    store.setItem(`${INSTANCE_STORAGE_PREFIX}.testnet`, "guards");

    clearOperatorStorageCategory("address-book", store);

    assert.equal(store.getItem(ADDRESS_BOOK_STORAGE_KEY), null);
    assert.equal(store.getItem(TX_HISTORY_STORAGE_KEY), "history");
    assert.equal(store.getItem(LAYOUT_STORAGE_KEY), "layouts");
    assert.equal(store.getItem(`${INSTANCE_STORAGE_PREFIX}.testnet`), "guards");
  });

  test("category isolation: clearing layouts leaves other categories untouched", () => {
    const store = makeFakeStore();
    store.setItem(TX_HISTORY_STORAGE_KEY, "history");
    store.setItem(ADDRESS_BOOK_STORAGE_KEY, "addressbook");
    store.setItem(LAYOUT_STORAGE_KEY, "layouts");
    store.setItem(THEME_STORAGE_KEY, "dark");
    store.setItem(`${INSTANCE_STORAGE_PREFIX}.testnet`, "guards");

    clearOperatorStorageCategory("layouts", store);

    assert.equal(store.getItem(LAYOUT_STORAGE_KEY), null);
    assert.equal(store.getItem(THEME_STORAGE_KEY), null);
    assert.equal(store.getItem(TX_HISTORY_STORAGE_KEY), "history");
    assert.equal(store.getItem(ADDRESS_BOOK_STORAGE_KEY), "addressbook");
    assert.equal(store.getItem(`${INSTANCE_STORAGE_PREFIX}.testnet`), "guards");
  });

  test("category isolation: clearing guard-registry leaves other categories untouched", () => {
    const store = makeFakeStore();
    store.setItem(TX_HISTORY_STORAGE_KEY, "history");
    store.setItem(ADDRESS_BOOK_STORAGE_KEY, "addressbook");
    store.setItem(LAYOUT_STORAGE_KEY, "layouts");
    store.setItem(`${INSTANCE_STORAGE_PREFIX}.testnet`, "guards");
    store.setItem(`${SCOPED_STORAGE_PREFIX}.base.testnet.guard`, "scoped");
    store.setItem(LEGACY_INSTANCE_STORAGE_KEY, "legacy");

    clearOperatorStorageCategory("guard-registry", store);

    assert.equal(store.getItem(`${INSTANCE_STORAGE_PREFIX}.testnet`), null);
    assert.equal(store.getItem(`${SCOPED_STORAGE_PREFIX}.base.testnet.guard`), null);
    assert.equal(store.getItem(LEGACY_INSTANCE_STORAGE_KEY), null);
    assert.equal(store.getItem(TX_HISTORY_STORAGE_KEY), "history");
    assert.equal(store.getItem(ADDRESS_BOOK_STORAGE_KEY), "addressbook");
    assert.equal(store.getItem(LAYOUT_STORAGE_KEY), "layouts");
  });

  test("StorageExplorerButton confirmation dialog states that clearing local data does not change the chain", async () => {
    installDom();
    const { react, createRoot, act } = await loadReact();

    localStorage.setItem(
      TX_HISTORY_STORAGE_KEY,
      JSON.stringify([
        { hash: "h1", operation: "freeze", status: "confirmed", recordedAt: "2026-10-20" },
      ]),
    );

    const div = document.createElement("div");
    document.body.appendChild(div);
    const root = createRoot(div);

    await act(async () => {
      root.render(
        react.createElement(
          GuardContext.Provider,
          { value: { server: {} as any, guard: "CA..." } as GuardContextValue },
          react.createElement(StorageExplorerButton),
        ),
      );
    });

    // Toggle inventory open
    const toggleBtn = div.querySelector(
      'button[data-testid="storage-inventory-toggle"]',
    ) as HTMLButtonElement;
    assert.ok(toggleBtn);
    await act(async () => toggleBtn.click());

    assert.ok(div.textContent?.includes("Operator Data Categories"));
    assert.ok(div.textContent?.includes("Transaction History"));

    // Click clear for history
    const clearHistoryBtn = div.querySelector(
      'button[data-testid="clear-category-history"]',
    ) as HTMLButtonElement;
    assert.ok(clearHistoryBtn);
    await act(async () => clearHistoryBtn.click());

    // Confirmation dialog appears
    assert.ok(div.textContent?.includes("Clear Transaction History?"));
    assert.ok(div.textContent?.includes("It does not change the chain"));

    // Confirm clear
    const confirmClearBtn = div.querySelector(
      'button[data-testid="confirm-clear-history"]',
    ) as HTMLButtonElement;
    assert.ok(confirmClearBtn);
    await act(async () => confirmClearBtn.click());

    assert.equal(localStorage.getItem(TX_HISTORY_STORAGE_KEY), null);
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    localStorage.clear();
  });
});
