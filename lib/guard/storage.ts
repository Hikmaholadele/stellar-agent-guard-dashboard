import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { hashToHex, jsonWithBigints, toHex } from "./scval.ts";
import { ADDRESS_BOOK_STORAGE_KEY } from "./addressBook.ts";
import { ALERT_SETTINGS_STORAGE_KEY } from "./audioAlert.ts";
import { DENSITY_STORAGE_KEY } from "./densityStore.ts";
import { SCOPED_STORAGE_PREFIX } from "./guardScoped.ts";
import { INSTANCE_STORAGE_PREFIX, LEGACY_INSTANCE_STORAGE_KEY } from "./instance.ts";
import { LAYOUT_STORAGE_KEY } from "./layoutStore.ts";
import { SIDEBAR_COLLAPSED_STORAGE_KEY, THEME_STORAGE_KEY } from "./presentationStorageKeys.ts";
import { PRIVACY_MASK_STORAGE_KEY } from "./privacyStore.ts";
import { SETUP_STORAGE_KEY } from "./setupChecklist.ts";
import { clearTxHistory, loadTxHistory, type StorageLike } from "./txHistory.ts";
import { IDLE_TIMEOUT_STORAGE_KEY } from "./useIdleTimer.ts";
import { PREFERRED_WALLET_STORAGE_KEY } from "./walletConnector.ts";

/**
 * Decoding what the guard contract has actually stored on the ledger.
 *
 * Two surfaces live here, and they answer different questions:
 *
 *   - `decodeStorageFootprint` decodes the entries a transaction footprint
 *     declared, keyed by the `DataKey` the caller asked about.
 *   - `decodeStorageEntry` decodes whatever `getLedgerEntries` returned for the
 *     whole contract, for the storage explorer (issue #150): no footprint, no
 *     prior knowledge of the key names, and a TTL for every entry.
 *
 * Everything decodes through the SDK (`scValToNative`) rather than a private
 * XDR walk, and nothing throws: an entry the console cannot read is reported as
 * such next to the entries it can, because a partially-readable storage map is
 * the honest answer and an exception would throw away the readable half.
 */

/**
 * The guard's persistent storage keys, as they exist on the ledger. A Rust
 * `contracttype` enum variant is stored as `Vec[Symbol("Name")]`, but the
 * decoder only needs to know which logical key it was asked for.
 */
export type DataKey = "Policy" | "Window" | "DeadManSwitch" | "Paused";

export interface DecodedStorage<T> {
  /** True when the entry decoded into a known contract-data value. */
  decoded: boolean;
  /** Remaining lifetime in ledgers, when a Soroban TTL entry was supplied. */
  ttl?: number;
  dataKey?: DataKey;
  value?: T | "Uninitialized";
}

const uninitialized = <T>(): DecodedStorage<T> => ({ decoded: false, value: "Uninitialized" });

/**
 * Accept either a full `LedgerEntry` (what `getLedgerEntries` returns) or a
 * bare `LedgerEntryData`, so callers can pass whichever the RPC handed them.
 */
function readEntryData(xdrBase64: string): xdr.LedgerEntryData | null {
  try {
    return xdr.LedgerEntry.fromXdr(xdrBase64, "base64").data;
  } catch {
    try {
      return xdr.LedgerEntryData.fromXdr(xdrBase64, "base64");
    } catch {
      return null;
    }
  }
}

/**
 * Decode one contract storage footprint into a typed value.
 *
 * Missing or uninitialized storage decodes to an `Uninitialized` marker rather
 * than throwing, so a caller can render "not set" without a try/catch. A TTL
 * entry (Soroban keeps it as a sibling `LedgerEntryData.ttl`) reports the
 * remaining ledger lifetime instead.
 */
export function decodeStorageFootprint<T = unknown>(
  xdrBase64: string,
  dataKey: DataKey,
): DecodedStorage<T> {
  if (!xdrBase64) return uninitialized<T>();

  const data = readEntryData(xdrBase64);
  if (!data) return uninitialized<T>();

  if (data.type === "ttl") {
    return { decoded: true, ttl: data.ttl.liveUntilLedgerSeq };
  }

  if (data.type !== "contractData") return uninitialized<T>();

  const value = scValToNative(data.contractData.val) as T;
  return { decoded: true, dataKey, value };
}

// ---------------------------------------------------------------------------
// Storage explorer (issue #150)
// ---------------------------------------------------------------------------

/**
 * Which of Soroban's three storage classes a key lives in.
 *
 * `instance` is not a durability a key declares — it is the shape of the
 * contract-instance entry itself (the executable plus its embedded instance
 * storage), which is why it gets its own name here rather than being reported
 * as persistent and leaving the operator to work out which entry it was.
 */
export type StorageDurability = "instance" | "persistent" | "temporary";

/**
 * How close an entry is to expiring, as a tier the drawer can colour.
 *
 * Thresholds are in ledgers remaining, because that is the unit the ledger
 * reports TTL in and the unit an operator can act on (restore the entry before
 * ledger N closes). Testnet closes a ledger about every 5 seconds, so the
 * numbers below are roughly 40 minutes and 8 minutes respectively.
 */
export type TtlTier = "ok" | "warn" | "critical" | "expired" | "unknown";

/** Yellow below this many ledgers of remaining lifetime. */
export const TTL_WARN_LEDGERS = 500;
/** Red below this many ledgers of remaining lifetime. */
export const TTL_CRITICAL_LEDGERS = 100;

/**
 * Tier an entry's remaining lifetime, or `"unknown"` when the ledger reported no
 * TTL for it. `currentLedger` being `null` — the latest-ledger read failed —
 * yields `"unknown"` rather than a fabricated countdown: a storage entry's
 * expiry cannot be judged without knowing where the chain is.
 */
export function classifyTtl(
  liveUntilLedgerSeq: number | null,
  currentLedger: number | null,
): { tier: TtlTier; remainingLedgers: number | null } {
  if (liveUntilLedgerSeq === null) return { tier: "unknown", remainingLedgers: null };
  if (currentLedger === null) return { tier: "unknown", remainingLedgers: null };
  const remainingLedgers = liveUntilLedgerSeq - currentLedger;
  if (remainingLedgers <= 0) return { tier: "expired", remainingLedgers };
  if (remainingLedgers < TTL_CRITICAL_LEDGERS) return { tier: "critical", remainingLedgers };
  if (remainingLedgers < TTL_WARN_LEDGERS) return { tier: "warn", remainingLedgers };
  return { tier: "ok", remainingLedgers };
}

/**
 * A JSON tree the drawer can render as syntax-highlighted markup.
 *
 * Deliberately not the raw native value: `bigint` is not JSON, bytes are not
 * JSON, and `JSON.stringify` throws on the first of them it meets — which is
 * every window entry the guard keeps. Each node carries the exact text to show,
 * so the rendered JSON and the copied JSON cannot disagree.
 */
export type JsonNode =
  | { kind: "string"; text: string }
  | { kind: "number"; text: string }
  | { kind: "boolean"; text: string }
  | { kind: "null"; text: "null" }
  | { kind: "bytes"; text: string; bytes: number }
  | { kind: "undefined"; text: "undefined" }
  | { kind: "array"; items: JsonNode[] }
  | { kind: "map"; entries: Array<{ key: string; value: JsonNode }> }
  /** Past `MAX_JSON_DEPTH`: shown rather than walked, so a deep value cannot hang the tab. */
  | { kind: "truncated"; text: "…" };

/** How deep the explorer walks a value before it says "…" instead. */
export const MAX_JSON_DEPTH = 12;

/**
 * Turn a decoded value into a `JsonNode` tree.
 *
 * `bigint` is rendered exactly, as a decimal string, rather than through
 * `Number()` — a stroop amount above 2^53 would silently lose digits in a
 * console whose whole point is that operators trust its numbers.
 */
export function jsonTree(value: unknown, depth = 0): JsonNode {
  if (value === null) return { kind: "null", text: "null" };
  if (value === undefined) return { kind: "undefined", text: "undefined" };
  if (typeof value === "bigint") return { kind: "number", text: value.toString() };
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { kind: "number", text: String(value) }
      : { kind: "number", text: String(value) };
  }
  if (typeof value === "boolean") return { kind: "boolean", text: String(value) };
  if (typeof value === "string") return { kind: "string", text: value };
  if (value instanceof Uint8Array) {
    // `Buffer` is a `Uint8Array` subclass, so this covers the SDK's byte output
    // too; hex is what an operator can paste into a decoder.
    return { kind: "bytes", text: toHex(value), bytes: value.byteLength };
  }
  if (depth >= MAX_JSON_DEPTH) return { kind: "truncated", text: "…" };
  if (Array.isArray(value))
    return { kind: "array", items: value.map((item) => jsonTree(item, depth + 1)) };
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return {
      kind: "map",
      entries: Object.keys(record).map((key) => ({ key, value: jsonTree(record[key], depth + 1) })),
    };
  }
  // A function or symbol has no ledger meaning; show its type rather than drop it.
  return { kind: "string", text: String(value) };
}

/** The exact JSON text for a value — what "copy as JSON" puts on the clipboard. */
export function formatAsJson(value: unknown): string {
  return jsonWithBigints(jsonSafe(value));
}

/** `formatAsJson`'s rewriter: bigints to strings, bytes to hex, in one pass. */
function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return toHex(value);
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) out[key] = jsonSafe(item);
    return out;
  }
  return value;
}

/** One contract-data entry as `getLedgerEntries` hands it back. */
export interface RawLedgerEntry {
  key: unknown;
  val: unknown;
  lastModifiedLedgerSeq?: number;
  liveUntilLedgerSeq?: number | null;
}

/** One decoded entry, as the storage explorer renders it. */
export interface StorageEntryView {
  /**
   * Stable identity: the ledger key's base64 XDR.
   *
   * Base64 rather than hex because it is the same string as `keyXdr` and the
   * same one the RPC accepts, so the id can be pasted straight back into a
   * `getLedgerEntries` call to re-read exactly this entry.
   */
  id: string;
  /** The DataKey symbol name, or `(contract instance)` for the instance entry. */
  label: string;
  durability: StorageDurability;
  /** False for a key that was asked for and does not exist on the ledger. */
  present: boolean;
  lastModifiedLedgerSeq: number | null;
  liveUntilLedgerSeq: number | null;
  remainingLedgers: number | null;
  ttlTier: TtlTier;
  /** The decoded value; `null` for an absent entry. */
  value: unknown;
  /** The value as a renderable tree; `null` for an absent entry. */
  json: JsonNode | null;
  /** The same value as copyable JSON; `null` for an absent entry. */
  jsonText: string | null;
  /** The ledger key as base64 XDR, for "copy raw XDR". */
  keyXdr: string;
  /** The stored value as base64 XDR, for "copy raw XDR". */
  valueXdr: string;
  /** Why an entry that exists could not be decoded, or `null` when it could. */
  decodeError: string | null;
}

/**
 * Read a field that this SDK build exposes as a plain property or, in other
 * builds, as a getter — the same tolerance `chain.ts` applies to `getLedgerEntries`
 * responses, kept here so the explorer works against either.
 */
function field<T>(source: unknown, name: string): T | undefined {
  if (source === null || typeof source !== "object") return undefined;
  const candidate = source as Record<string, unknown>;
  const value = candidate[name];
  if (typeof value === "function") {
    try {
      return (value as () => T).call(source) as T;
    } catch {
      return undefined;
    }
  }
  return value as T | undefined;
}

function typeOf(value: unknown): string | null {
  const type = field<unknown>(value, "type");
  if (typeof type === "string") return type;
  if (type && typeof type === "object" && typeof (type as { name?: unknown }).name === "string") {
    return (type as { name: string }).name;
  }
  return null;
}

/**
 * The name an operator recognises an entry by.
 *
 * The guard's own keys are `Vec[Symbol("Name")]`, so a single-element vector
 * renders as the bare variant name. Anything else renders as its JSON, because
 * a key this console does not recognise is exactly the one worth seeing whole.
 */
export function storageKeyLabel(keyScVal: unknown): string {
  const type = typeOf(keyScVal);
  if (type === "scvLedgerKeyContractInstance") return "(contract instance)";
  let native: unknown;
  try {
    native = scValToNative(keyScVal as xdr.ScVal);
  } catch {
    return "(undecodable key)";
  }
  if (Array.isArray(native) && native.length === 1 && typeof native[0] === "string") {
    return native[0];
  }
  return formatAsJson(native).replace(/\s+/g, " ");
}

/**
 * Decode one entry of a contract's storage into the explorer's view model.
 *
 * `currentLedger` is the ledger the read was made against, and it is what makes
 * a TTL a countdown rather than a number. Passing `null` yields `tier:
 * "unknown"` — see `classifyTtl`.
 *
 * An entry that exists but does not decode keeps its identity, TTL and raw XDR,
 * and reports `decodeError`; the explorer renders it as a failed row rather
 * than dropping it, so an entry the console cannot read is still visible.
 */
export function decodeStorageEntry(
  raw: RawLedgerEntry,
  currentLedger: number | null,
): StorageEntryView {
  const keyXdr = safeXdr(raw.key);
  const contractData = field<{ key?: xdr.ScVal; val?: xdr.ScVal }>(raw.val, "contractData");
  const durabilityName = field<{ name?: string }>(field(contractData, "durability"), "name")?.name;
  // The key ScVal is read from the *ledger key* rather than from the entry data,
  // because the key is what identifies the entry: an entry whose data arm is
  // something other than `contractData` (a TTL sibling, say) still has a name.
  const keyArm = field<{ key?: xdr.ScVal }>(raw.key, "contractData");
  const keyScVal = field<xdr.ScVal>(keyArm, "key") ?? field<xdr.ScVal>(contractData, "key");
  const isInstance = typeOf(keyScVal) === "scvLedgerKeyContractInstance";
  const durability: StorageDurability = isInstance
    ? "instance"
    : (durabilityName ?? field<{ name?: string }>(field(keyArm, "durability"), "name")?.name) ===
        "temporary"
      ? "temporary"
      : "persistent";
  const liveUntil = raw.liveUntilLedgerSeq ?? null;
  const { tier, remainingLedgers } = classifyTtl(liveUntil, currentLedger);

  const base: StorageEntryView = {
    id: keyXdr,
    label: keyScVal === undefined ? "(unknown key)" : storageKeyLabel(keyScVal),
    durability,
    present: true,
    lastModifiedLedgerSeq: raw.lastModifiedLedgerSeq ?? null,
    liveUntilLedgerSeq: liveUntil,
    remainingLedgers,
    ttlTier: tier,
    value: null,
    json: null,
    jsonText: null,
    keyXdr,
    valueXdr: "",
    decodeError: null,
  };

  const scval = field<xdr.ScVal>(contractData, "val");
  if (scval === undefined) {
    return { ...base, decodeError: "this entry holds no contract-data value" };
  }

  let value: unknown;
  try {
    value = decodeScVal(scval);
  } catch (error) {
    return {
      ...base,
      valueXdr: safeXdr(scval),
      decodeError: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    ...base,
    value,
    json: jsonTree(value),
    jsonText: formatAsJson(value),
    valueXdr: safeXdr(scval),
  };
}

/**
 * The contract-instance entry, decoded into something an operator can read.
 *
 * `scValToNative` returns the raw XDR object for `scvContractInstance`, which
 * renders as `[object Object]`; this is the one shape the explorer decodes by
 * hand — the executable it runs and its instance storage, both as plain values.
 */
function decodeScVal(scval: xdr.ScVal): unknown {
  if (typeOf(scval) === "scvContractInstance") {
    const instance = field<{ executable?: unknown; storage?: unknown }>(scval, "instance");
    const executable = field<{ type?: string; wasmHash?: unknown }>(instance, "executable");
    const storage = field<unknown[]>(instance, "storage") ?? [];
    return {
      executable: {
        kind: field<string>(executable, "type") ?? "unknown",
        wasmHash: hashToHex(field(executable, "wasmHash")),
      },
      storage: storage.map((entry) => {
        const key = field<xdr.ScVal>(entry, "key");
        const val = field<xdr.ScVal>(entry, "val");
        return {
          key: key === undefined ? null : scValToNative(key),
          value: val === undefined ? null : scValToNative(val),
        };
      }),
    };
  }
  return scValToNative(scval);
}

/** Base64 XDR for a value, or an empty string when it is not XDR at all. */
function safeXdr(value: unknown): string {
  try {
    const toXdr = (value as { toXDR?: (format: string) => string } | null)?.toXDR;
    if (typeof toXdr !== "function") return "";
    return toXdr.call(value, "base64");
  } catch {
    return "";
  }
}

/**
 * The view for a key the ledger does not hold.
 *
 * `getLedgerEntries` omits missing keys rather than returning a null arm, so an
 * absent key would otherwise be invisible — and "the guard stores no policy
 * right now" is a fact an operator needs, not a gap in a list.
 */
export function absentStorageEntry(keyXdr: string, label: string): StorageEntryView {
  return {
    id: keyXdr,
    label,
    durability: "persistent",
    present: false,
    lastModifiedLedgerSeq: null,
    liveUntilLedgerSeq: null,
    remainingLedgers: null,
    ttlTier: "unknown",
    value: null,
    json: null,
    jsonText: null,
    keyXdr,
    valueXdr: "",
    decodeError: null,
  };
}

// ---------------------------------------------------------------------------
// Drawer state (issue #150)
// ---------------------------------------------------------------------------

/**
 * The storage explorer's state, as a pure reducer.
 *
 * The drawer's whole behaviour is open/close, the entries the last read
 * produced, which one is selected and the filter typed over them. Keeping that
 * here — rather than as four `useState` calls in the component — is what makes
 * "a read that failed does not leave the previous entries on screen" a claim
 * the unit tests can make, rather than a comment.
 */
export interface ExplorerState {
  open: boolean;
  loading: boolean;
  /** A failed read, or `null`. Never a substitute for entries. */
  error: string | null;
  entries: StorageEntryView[];
  /** The entry id whose value is expanded, or `null` for none. */
  selected: string | null;
  /** Case-insensitive substring filter over the entry labels. */
  query: string;
  /** Storage classes to show; empty means "all". */
  durabilityFilter: StorageDurability[];
}

export const INITIAL_EXPLORER_STATE: ExplorerState = {
  open: false,
  loading: false,
  error: null,
  entries: [],
  selected: null,
  query: "",
  durabilityFilter: [],
};

export type ExplorerAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "toggle" }
  | { type: "loading" }
  | { type: "loaded"; entries: StorageEntryView[] }
  | { type: "failed"; error: string }
  | { type: "select"; id: string | null }
  | { type: "query"; value: string }
  | { type: "toggleDurability"; durability: StorageDurability };

export function explorerReducer(state: ExplorerState, action: ExplorerAction): ExplorerState {
  switch (action.type) {
    case "open":
      return { ...state, open: true };
    case "close":
      // Closing drops the read's error and the selection but keeps the entries,
      // so reopening shows the previous map immediately while the fresh read is
      // in flight rather than an empty drawer.
      return { ...state, open: false, error: null, selected: null };
    case "toggle":
      return explorerReducer(state, { type: state.open ? "close" : "open" });
    case "loading":
      return { ...state, loading: true, error: null };
    case "loaded":
      // A successful read replaces the entries wholesale, and clears the
      // selection rather than leaving an id that may no longer exist.
      return { ...state, loading: false, error: null, entries: action.entries, selected: null };
    case "failed":
      // A failed read clears the entries: a storage map that did not succeed
      // must not be readable as if it were the contract's current state.
      return { ...state, loading: false, error: action.error, entries: [], selected: null };
    case "select":
      return { ...state, selected: state.selected === action.id ? null : action.id };
    case "query":
      return { ...state, query: action.value };
    case "toggleDurability": {
      const active = state.durabilityFilter.includes(action.durability);
      return {
        ...state,
        durabilityFilter: active
          ? state.durabilityFilter.filter((item) => item !== action.durability)
          : [...state.durabilityFilter, action.durability],
      };
    }
  }
}

/**
 * The entries the drawer lists, in a stable order: instance first, then
 * persistent, then temporary, each group alphabetical by label.
 *
 * Sorting by durability rather than by ledger key order is deliberate — the
 * operator is looking for "where does the policy live", and the guard's own
 * entry is always the one to read first.
 */
export function visibleEntries(state: ExplorerState): StorageEntryView[] {
  const query = state.query.trim().toLowerCase();
  const order: Record<StorageDurability, number> = { instance: 0, persistent: 1, temporary: 2 };
  return state.entries
    .filter(
      (entry) =>
        state.durabilityFilter.length === 0 || state.durabilityFilter.includes(entry.durability),
    )
    .filter((entry) => query === "" || entry.label.toLowerCase().includes(query))
    .sort((a, b) => {
      const byDurability = order[a.durability] - order[b.durability];
      if (byDurability !== 0) return byDurability;
      return a.label.localeCompare(b.label);
    });
}

/** One-line summary for the drawer's header, in words rather than a bare count. */
export function summarizeEntries(entries: readonly StorageEntryView[]): string {
  const present = entries.filter((entry) => entry.present).length;
  const expiring = entries.filter(
    (entry) => entry.ttlTier === "critical" || entry.ttlTier === "expired",
  ).length;
  const parts = [
    `${present} of ${entries.length} entr${entries.length === 1 ? "y" : "ies"} present`,
  ];
  if (expiring > 0) parts.push(`${expiring} at or past its expiration warning`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Browser-local operator data controls (issue #332)
// ---------------------------------------------------------------------------

export type OperatorStorageCategory = "history" | "address-book" | "layouts" | "guard-registry";

export interface OperatorStorageCategoryInfo {
  id: OperatorStorageCategory;
  name: string;
  description: string;
  itemCount: number;
}

export const LAYOUT_STORAGE_KEYS: readonly string[] = [
  LAYOUT_STORAGE_KEY,
  THEME_STORAGE_KEY,
  DENSITY_STORAGE_KEY,
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  PRIVACY_MASK_STORAGE_KEY,
  IDLE_TIMEOUT_STORAGE_KEY,
  ALERT_SETTINGS_STORAGE_KEY,
  SETUP_STORAGE_KEY,
  PREFERRED_WALLET_STORAGE_KEY,
];

function getAllStorageKeys(storage: StorageLike): string[] {
  if (typeof (storage as any).length === "number" && typeof (storage as any).key === "function") {
    const keys: string[] = [];
    for (let i = 0; i < (storage as any).length; i++) {
      const k = (storage as any).key(i);
      if (k) keys.push(k);
    }
    return keys;
  }
  if ((storage as any).data instanceof Map) {
    return Array.from(((storage as any).data as Map<string, string>).keys());
  }
  return Object.keys(storage);
}

export function getOperatorStorageCategories(
  storage?: StorageLike | null,
): OperatorStorageCategoryInfo[] {
  const store =
    storage === undefined ? (typeof window !== "undefined" ? window.localStorage : null) : storage;

  let historyCount = 0;
  if (store) {
    try {
      historyCount = loadTxHistory(store).length;
    } catch {
      historyCount = 0;
    }
  }

  let addressBookCount = 0;
  if (store) {
    try {
      const raw = store.getItem(ADDRESS_BOOK_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) addressBookCount = parsed.length;
        else if (parsed && Array.isArray((parsed as any).contacts))
          addressBookCount = (parsed as any).contacts.length;
      }
    } catch {
      addressBookCount = 0;
    }
  }

  let layoutsCount = 0;
  if (store) {
    for (const key of LAYOUT_STORAGE_KEYS) {
      if (store.getItem(key) !== null) {
        layoutsCount += 1;
      }
    }
  }

  let guardRegistryCount = 0;
  if (store) {
    try {
      const keys = getAllStorageKeys(store);
      for (const key of keys) {
        if (
          key.startsWith(INSTANCE_STORAGE_PREFIX) ||
          key === LEGACY_INSTANCE_STORAGE_KEY ||
          key.startsWith(SCOPED_STORAGE_PREFIX)
        ) {
          const raw = store.getItem(key);
          if (raw) {
            try {
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed)) guardRegistryCount += parsed.length;
              else guardRegistryCount += 1;
            } catch {
              guardRegistryCount += 1;
            }
          }
        }
      }
    } catch {
      guardRegistryCount = 0;
    }
  }

  return [
    {
      id: "history",
      name: "Transaction History",
      description: "Transaction hashes, operations, outcomes, and fees recorded by this browser.",
      itemCount: historyCount,
    },
    {
      id: "address-book",
      name: "Address Book",
      description: "Contact nicknames and public Stellar addresses saved locally.",
      itemCount: addressBookCount,
    },
    {
      id: "layouts",
      name: "Layouts & UI Preferences",
      description: "Dashboard panel layout order, theme, density, and display preferences.",
      itemCount: layoutsCount,
    },
    {
      id: "guard-registry",
      name: "Guard Registry",
      description: "Saved public guard addresses, nicknames, and per-guard operational drafts.",
      itemCount: guardRegistryCount,
    },
  ];
}

export function clearOperatorStorageCategory(
  category: OperatorStorageCategory,
  storage?: StorageLike | null,
): void {
  const store =
    storage === undefined ? (typeof window !== "undefined" ? window.localStorage : null) : storage;
  if (!store) return;

  const removeKey = (key: string) => {
    if (typeof store.removeItem === "function") {
      store.removeItem(key);
    } else {
      store.setItem(key, "");
      if ((store as any).data instanceof Map) {
        ((store as any).data as Map<string, string>).delete(key);
      }
    }
  };

  switch (category) {
    case "history":
      clearTxHistory(store);
      break;

    case "address-book":
      removeKey(ADDRESS_BOOK_STORAGE_KEY);
      break;

    case "layouts":
      for (const key of LAYOUT_STORAGE_KEYS) {
        removeKey(key);
      }
      break;

    case "guard-registry": {
      const keys = getAllStorageKeys(store);
      for (const key of keys) {
        if (
          key.startsWith(INSTANCE_STORAGE_PREFIX) ||
          key === LEGACY_INSTANCE_STORAGE_KEY ||
          key.startsWith(SCOPED_STORAGE_PREFIX)
        ) {
          removeKey(key);
        }
      }
      break;
    }
  }
}
