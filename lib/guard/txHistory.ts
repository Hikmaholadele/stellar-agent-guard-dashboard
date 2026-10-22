/**
 * The transaction history the console keeps of its own writes.
 *
 * Every admin transaction this dashboard broadcasts — policy installs,
 * freezes, unfreezes, deploys — is recorded here with the facts the
 * submission path actually knew: the hash the network accepted, the
 * operation, the outcome, and the fee the envelope paid. It is a local
 * record of *this console's own* writes, capped and stored in
 * `localStorage`; nothing is fetched and nothing is claimed about
 * transactions this console did not make.
 *
 * The storage seam mirrors `instance.ts`: reads and writes are best-effort
 * (private-mode failures and corrupt payloads degrade to an empty history,
 * never to a crash), and tests inject their own storage.
 */

import {
  classifyStorageError,
  storageErrorMessage,
  writeStoredValue,
  type StorageOutcome,
} from "./versionedStorage.ts";
import { NETWORK } from "./network.ts";

export type TxHistoryTerminalOutcome =
  "confirmed" | "failed" | "cancelled" | "pre-submit-failure" | "submitted";

export type TxHistoryStatus = TxHistoryTerminalOutcome;

export interface TxHistoryEntry {
  /** The hash the network accepted. Identity for de-duplication (null for cancelled/pre-submit failure). */
  hash: string | null;
  /** Stable local identity for rows without a hash or for React keys. */
  id?: string;
  /** The contract function or host operation that was submitted. */
  operation: string;
  status: TxHistoryStatus;
  /** Total fee paid, in stroops (inclusion + resource), as a decimal string. */
  feeStroops: string | null;
  /** Network identity captured when this console recorded the write. */
  networkName: string | null;
  networkPassphrase: string | null;
  /** ISO 8601 timestamp of when this console recorded the outcome. */
  recordedAt: string;
  /** Actionable error or cancellation detail. */
  detail?: string | null;
}

export type TxVerificationStatus = "pending" | "not-found" | "confirmed" | "failed";

/** Map the live RPC response to a presentation state without changing history. */
export function txVerificationStatus(status: string): TxVerificationStatus | null {
  switch (status) {
    case "PENDING":
      return "pending";
    case "NOT_FOUND":
      return "not-found";
    case "SUCCESS":
      return "confirmed";
    case "FAILED":
      return "failed";
    default:
      return null;
  }
}

/** A history row can be checked only against the exact passphrase it records. */
export function txHistoryMatchesNetwork(entry: TxHistoryEntry, networkPassphrase: string): boolean {
  return entry.networkPassphrase === networkPassphrase;
}

/** Maximum entries kept — the oldest beyond this are dropped. */
export const TX_HISTORY_LIMIT = 200;

/** Maximum age for local transaction history records (in days). Records older than this are pruned. */
export const TX_HISTORY_MAX_AGE_DAYS = 30;
export const TX_HISTORY_MAX_AGE_MS = TX_HISTORY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

export interface PruneOptions {
  maxCount?: number;
  maxAgeMs?: number;
  now?: number;
}

/** Evict records past the documented retention boundaries (max age and max count) deterministically. */
export function pruneTxHistory(
  entries: TxHistoryEntry[],
  options?: PruneOptions,
): TxHistoryEntry[] {
  const maxCount = options?.maxCount ?? TX_HISTORY_LIMIT;
  const maxAgeMs = options?.maxAgeMs ?? TX_HISTORY_MAX_AGE_MS;
  const now = options?.now ?? Date.now();
  const cutoffIso = new Date(now - maxAgeMs).toISOString();

  return entries.filter((entry) => entry.recordedAt >= cutoffIso).slice(0, maxCount);
}

export const TX_HISTORY_STORAGE_KEY = "stellar-agent-guard-dashboard.txHistory.v1";

let lastSaveOutcome: StorageOutcome<void> = { ok: true, value: undefined };
let memoryHistory: TxHistoryEntry[] = [];
const failedStores = new WeakSet<object>();

/** The subset of `Storage` the store needs, so tests can inject a fake. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

function defaultStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // Storage access itself can throw (private mode, disabled cookies).
    return null;
  }
}

const VALID_STATUSES = new Set<string>([
  "confirmed",
  "failed",
  "cancelled",
  "pre-submit-failure",
  "submitted",
]);

function isEntry(value: unknown): value is TxHistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<TxHistoryEntry>;
  return (
    (entry.hash === null || typeof entry.hash === "string" || entry.hash === undefined) &&
    typeof entry.operation === "string" &&
    typeof entry.status === "string" &&
    VALID_STATUSES.has(entry.status) &&
    typeof entry.recordedAt === "string" &&
    (entry.networkName === undefined ||
      entry.networkName === null ||
      typeof entry.networkName === "string") &&
    (entry.networkPassphrase === undefined ||
      entry.networkPassphrase === null ||
      typeof entry.networkPassphrase === "string") &&
    (entry.feeStroops === null ||
      entry.feeStroops === undefined ||
      typeof entry.feeStroops === "string") &&
    (entry.detail === undefined || entry.detail === null || typeof entry.detail === "string")
  );
}

/**
 * The stored history, newest first, migrated and retention-pruned. A corrupted
 * payload yields an empty history rather than a broken dashboard.
 */
export function loadTxHistory(
  storage?: StorageLike | null,
  options?: PruneOptions,
): TxHistoryEntry[] {
  const store = storage === undefined ? defaultStorage() : storage;
  if (!store) return [...memoryHistory];
  if (failedStores.has(store)) return [...memoryHistory];
  try {
    const raw = store.getItem(TX_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const migrated = parsed.filter(isEntry).map((entry) => ({
      ...entry,
      hash: entry.hash ?? null,
      id: entry.id ?? (entry.hash ? entry.hash : `local-${entry.recordedAt}-${entry.operation}`),
      feeStroops: entry.feeStroops ?? null,
      networkName: entry.networkName ?? null,
      networkPassphrase: entry.networkPassphrase ?? null,
      detail: entry.detail ?? null,
    }));
    const pruned = pruneTxHistory(migrated, options);
    memoryHistory = pruned;
    return pruned;
  } catch {
    return [];
  }
}

/** Clear all local transaction records from browser storage. Does not affect on-chain state. */
export function clearTxHistory(storage: StorageLike | null = defaultStorage()): void {
  memoryHistory = [];
  lastSaveOutcome = { ok: true, value: undefined };
  if (storage) {
    failedStores.delete(storage);
    try {
      if (typeof storage.removeItem === "function") {
        storage.removeItem(TX_HISTORY_STORAGE_KEY);
      } else {
        storage.setItem(TX_HISTORY_STORAGE_KEY, JSON.stringify([]));
      }
    } catch (e) {
      lastSaveOutcome = { ok: false, error: classifyStorageError(e) };
    }
  }
  notify();
}

const listeners = new Set<() => void>();

/** Watch for records written anywhere (another panel, another page tab). */
export function subscribeTxHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Persistence result for the latest history write, for a concise UI warning. */
export function txHistorySaveOutcome(): StorageOutcome<void> {
  return lastSaveOutcome;
}

export function txHistorySaveWarning(): string | null {
  return lastSaveOutcome.ok ? null : storageErrorMessage(lastSaveOutcome.error);
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/**
 * Record a submitted or terminal transaction outcome, newest first.
 *
 * Never assigns a transaction hash for requests cancelled before submission.
 * Re-recording the same hash or id replaces the earlier entry and moves it to
 * the front. The list is bounded by count and retention age.
 */
export function recordTx(
  entry: {
    hash: string | null;
    operation: string;
    status: TxHistoryStatus;
    feeStroops?: string | null;
    recordedAt?: string;
    networkName?: string | null;
    networkPassphrase?: string | null;
    detail?: string | null;
    id?: string;
  },
  storage: StorageLike | null = defaultStorage(),
  options?: PruneOptions,
): TxHistoryEntry[] {
  const recordedAt = entry.recordedAt ?? new Date().toISOString();
  const id =
    entry.id ??
    (entry.hash
      ? entry.hash
      : `local-${recordedAt}-${entry.operation}-${Math.random().toString(36).slice(2)}`);
  const recorded: TxHistoryEntry = {
    hash: entry.hash ?? null,
    id,
    operation: entry.operation,
    status: entry.status,
    feeStroops: entry.feeStroops ?? null,
    networkName: entry.networkName ?? NETWORK.name,
    networkPassphrase: entry.networkPassphrase ?? NETWORK.passphrase,
    recordedAt,
    detail: entry.detail ?? null,
  };
  const current = loadTxHistory(storage, options);
  const next = pruneTxHistory(
    [
      recorded,
      ...current.filter((existing) => {
        if (recorded.hash && existing.hash) {
          return existing.hash !== recorded.hash;
        }
        if (recorded.id && existing.id) {
          return existing.id !== recorded.id;
        }
        return true;
      }),
    ],
    options,
  );
  memoryHistory = next;
  lastSaveOutcome = writeStoredValue(storage, TX_HISTORY_STORAGE_KEY, JSON.stringify(next));
  if (storage && !lastSaveOutcome.ok) failedStores.add(storage);
  else if (storage) failedStores.delete(storage);
  notify();
  return next;
}

export interface TxHistoryFilter {
  /** Case-insensitive text matched against operation, hash and status. */
  query?: string;
  /** Inclusive lower bound on the recorded date, as `YYYY-MM-DD` (UTC). */
  from?: string;
  /** Inclusive upper bound on the recorded date, as `YYYY-MM-DD` (UTC). */
  to?: string;
}

/** Apply the text search and date range. Empty bounds mean unset. */
export function filterTxHistory(
  entries: TxHistoryEntry[],
  filter: TxHistoryFilter,
): TxHistoryEntry[] {
  const query = (filter.query ?? "").trim().toLowerCase();
  const from = (filter.from ?? "").trim();
  const to = (filter.to ?? "").trim();
  if (query.length === 0 && from.length === 0 && to.length === 0) return entries;
  return entries.filter((entry) => {
    if (query.length > 0) {
      const haystack =
        `${entry.operation} ${entry.hash ?? ""} ${entry.status} ${entry.networkName ?? ""} ${entry.networkPassphrase ?? ""} ${entry.detail ?? ""}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    const day = entry.recordedAt.slice(0, 10);
    if (from.length > 0 && day < from) return false;
    if (to.length > 0 && day > to) return false;
    return true;
  });
}

export interface TxHistoryPage {
  rows: TxHistoryEntry[];
  /** The page actually shown — clamped into range when the list shrank. */
  page: number;
  pages: number;
  total: number;
}

/** Slice one page out of the list, clamping out-of-range page numbers. */
export function paginateTxHistory(
  entries: TxHistoryEntry[],
  page: number,
  pageSize: number,
): TxHistoryPage {
  const total = entries.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const clamped = Math.min(Math.max(1, Math.trunc(page) || 1), pages);
  const start = (clamped - 1) * pageSize;
  return { rows: entries.slice(start, start + pageSize), page: clamped, pages, total };
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** The filtered history as CSV: a fixed header plus one quoted row per entry. */
export function txHistoryToCsv(entries: TxHistoryEntry[]): string {
  const lines = ["timestamp,operation,status,tx_hash,fee_stroops,network_name,network_passphrase"];
  for (const entry of entries) {
    lines.push(
      [
        entry.recordedAt,
        entry.operation,
        entry.status,
        entry.hash ?? "",
        entry.feeStroops ?? "",
        entry.networkName ?? "",
        entry.networkPassphrase ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}
