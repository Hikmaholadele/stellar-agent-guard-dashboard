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

import { NETWORK } from "./network.ts";

export interface TxHistoryEntry {
  /** The hash the network accepted. Identity for de-duplication. */
  hash: string;
  /** The contract function or host operation that was submitted. */
  operation: string;
  status: "confirmed" | "failed";
  /** Total fee paid, in stroops (inclusion + resource), as a decimal string. */
  feeStroops: string | null;
  /** Network identity captured when this console recorded the write. */
  networkName: string | null;
  networkPassphrase: string | null;
  /** ISO 8601 timestamp of when this console recorded the outcome. */
  recordedAt: string;
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

export const TX_HISTORY_STORAGE_KEY = "stellar-agent-guard-dashboard.txHistory.v1";

/** The subset of `Storage` the store needs, so tests can inject a fake. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
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

function isEntry(value: unknown): value is TxHistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<TxHistoryEntry>;
  return (
    typeof entry.hash === "string" &&
    typeof entry.operation === "string" &&
    (entry.status === "confirmed" || entry.status === "failed") &&
    typeof entry.recordedAt === "string" &&
    (entry.networkName === undefined ||
      entry.networkName === null ||
      typeof entry.networkName === "string") &&
    (entry.networkPassphrase === undefined ||
      entry.networkPassphrase === null ||
      typeof entry.networkPassphrase === "string") &&
    (entry.feeStroops === null ||
      entry.feeStroops === undefined ||
      typeof entry.feeStroops === "string")
  );
}

/**
 * The stored history, newest first, validated and capped. A corrupted
 * payload yields an empty history rather than a broken dashboard.
 */
export function loadTxHistory(storage: StorageLike | null = defaultStorage()): TxHistoryEntry[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(TX_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isEntry)
      .map((entry) => ({
        ...entry,
        feeStroops: entry.feeStroops ?? null,
        networkName: entry.networkName ?? null,
        networkPassphrase: entry.networkPassphrase ?? null,
      }))
      .slice(0, TX_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

const listeners = new Set<() => void>();

/** Watch for records written anywhere (another panel, another page tab). */
export function subscribeTxHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/**
 * Record a submitted transaction, newest first.
 *
 * Re-recording the same hash replaces the earlier entry (a transaction has
 * one identity; a later, better-informed outcome wins) and moves it to the
 * front. The list is capped at `TX_HISTORY_LIMIT`.
 */
export function recordTx(
  entry: Pick<TxHistoryEntry, "hash" | "operation" | "status" | "feeStroops"> &
    Partial<Pick<TxHistoryEntry, "recordedAt" | "networkName" | "networkPassphrase">>,
  storage: StorageLike | null = defaultStorage(),
): TxHistoryEntry[] {
  const recorded: TxHistoryEntry = {
    hash: entry.hash,
    operation: entry.operation,
    status: entry.status,
    feeStroops: entry.feeStroops ?? null,
    networkName: entry.networkName ?? NETWORK.name,
    networkPassphrase: entry.networkPassphrase ?? NETWORK.passphrase,
    recordedAt: entry.recordedAt ?? new Date().toISOString(),
  };
  const current = loadTxHistory(storage);
  const next = [recorded, ...current.filter((existing) => existing.hash !== recorded.hash)].slice(
    0,
    TX_HISTORY_LIMIT,
  );
  if (storage) {
    try {
      storage.setItem(TX_HISTORY_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // A private-mode write failure must not interrupt the submission path.
    }
  }
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
        `${entry.operation} ${entry.hash} ${entry.status} ${entry.networkName ?? ""} ${entry.networkPassphrase ?? ""}`.toLowerCase();
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
        entry.hash,
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
