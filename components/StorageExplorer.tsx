"use client";

/**
 * The contract storage explorer (issue #150).
 *
 * Everything else in the console reads a value through a contract *function*;
 * this reads the contract's ledger entries directly, so an operator can see the
 * state the guard actually keeps — including the parts no read function exposes
 * (the contract instance, temporary storage) and the parts a failed read would
 * otherwise hide.
 *
 * The rules it follows are the console's own:
 *
 *   - A failed read renders as a failure and clears the map. It is never a
 *     leftover list of entries that now read as the contract's current state.
 *   - An entry the console cannot decode still gets a row, with its identity,
 *     TTL and raw XDR, and says so — a partly readable map is reported, not
 *     truncated to the readable half.
 *   - TTL is a countdown against the ledger the read was made at, and reads
 *     "unknown" rather than a number when that ledger is unavailable.
 *   - Every value is copyable twice: raw base64 XDR, for pasting into a
 *     decoder, and formatted JSON, for pasting into an issue.
 *
 * The read, the decoding and the drawer's state machine live in
 * `lib/guard/chain.ts` and `lib/guard/storage.ts`; this file is the view.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Dispatch } from "react";
import { useGuard } from "./GuardProvider.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { ErrorBlock, Skeleton } from "./bits.tsx";
import { readContractStorage } from "../lib/guard/chain.ts";
import {
  INITIAL_EXPLORER_STATE,
  clearOperatorStorageCategory,
  explorerReducer,
  getOperatorStorageCategories,
  summarizeEntries,
  visibleEntries,
  type ExplorerAction,
  type ExplorerState,
  type JsonNode,
  type OperatorStorageCategoryInfo,
  type StorageDurability,
  type StorageEntryView,
} from "../lib/guard/storage.ts";
import { announce } from "../lib/guard/useAnnounce.ts";
import { STORAGE_INVENTORY } from "../lib/guard/storageInventory.ts";

/** The badge class for a TTL tier — the tokens the rest of the interface uses. */
const TIER_CLASS: Record<StorageEntryView["ttlTier"], string> = {
  ok: "pill ok",
  warn: "pill warn",
  critical: "pill danger",
  expired: "pill danger",
  unknown: "pill",
};

/** The tier in words, so the badge is never the only statement of urgency. */
const TIER_WORD: Record<StorageEntryView["ttlTier"], string> = {
  ok: "healthy",
  warn: "expiring soon",
  critical: "expires very soon",
  expired: "expired",
  unknown: "TTL unknown",
};

const DURABILITY_LABEL: Record<StorageDurability, string> = {
  instance: "Instance",
  persistent: "Persistent",
  temporary: "Temporary",
};

const DURABILITIES: StorageDurability[] = ["instance", "persistent", "temporary"];

/** Remaining lifetime as an operator reads it: `4,120 ledgers (~5h 43m)`. */
export function formatRemainingLedgers(ledgers: number): string {
  const minutes = Math.round((ledgers * 5) / 60);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${minutes}h ${minutes % 60}m` : `${minutes}m`;
}

function ttlSummary(entry: StorageEntryView): string {
  if (entry.ttlTier === "unknown" || entry.remainingLedgers === null) {
    return entry.present ? "no TTL reported by the ledger" : "not initialized";
  }
  const remaining =
    entry.ttlTier === "expired"
      ? `expired ${entry.remainingLedgers === 0 ? "" : `${Math.abs(entry.remainingLedgers)} `}ledgers ago`
      : `${entry.remainingLedgers.toLocaleString()} ledgers (~${formatRemainingLedgers(entry.remainingLedgers)})`;
  return `expires at ledger ${entry.liveUntilLedgerSeq?.toLocaleString()} — ${remaining}`;
}

/**
 * One JSON node, rendered.
 *
 * Recursion rather than a pre-flattened string: the tree is what the issue asks
 * for, and it is also what keeps a deeply nested value from becoming one
 * unreadable line. `storage.ts` truncates past `MAX_JSON_DEPTH`, so this walk
 * terminates on any input.
 */
function JsonValue({ node, depth = 0 }: { node: JsonNode; depth?: number }) {
  switch (node.kind) {
    case "array":
      return (
        <>
          [
          {node.items.map((item, index) => (
            <span key={index}>
              {index > 0 ? ", " : ""}
              <JsonValue node={item} depth={depth + 1} />
            </span>
          ))}
          ]
        </>
      );
    case "map":
      return (
        <>
          {"{"}
          {node.entries.map((entry, index) => (
            <span key={entry.key + index}>
              {index > 0 ? ", " : ""}
              <span className="json-key">{entry.key}</span>
              {": "}
              <JsonValue node={entry.value} depth={depth + 1} />
            </span>
          ))}
          {"}"}
        </>
      );
    case "string":
      return <span className="json-string">&quot;{node.text}&quot;</span>;
    case "number":
      return <span className="json-number">{node.text}</span>;
    case "boolean":
      return <span className="json-boolean">{node.text}</span>;
    case "bytes":
      return (
        <span className="json-bytes" title={`${node.bytes} bytes, hex`}>
          {node.text}
        </span>
      );
    case "null":
      return <span className="json-null">{node.text}</span>;
    case "undefined":
      return <span className="json-null">{node.text}</span>;
    case "truncated":
      return <span className="json-null">{node.text}</span>;
  }
}

/** One entry row: identity, storage class, TTL badge, and the expanded value. */
function EntryRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: StorageEntryView;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="storage-entry" data-durability={entry.durability} data-present={entry.present}>
      <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
        <button
          type="button"
          className="secondary storage-entry-toggle"
          onClick={onToggle}
          aria-expanded={expanded}
        >
          {expanded ? "▾" : "▸"} <span className="mono">{entry.label}</span>
        </button>
        <div className="row" style={{ gap: 6 }}>
          <span className="pill">{DURABILITY_LABEL[entry.durability]}</span>
          <span className={TIER_CLASS[entry.ttlTier]}>{TIER_WORD[entry.ttlTier]}</span>
        </div>
      </div>

      <div className="tiny muted" style={{ marginTop: 4 }}>
        {ttlSummary(entry)}
      </div>

      {expanded && (
        <div style={{ marginTop: 8 }}>
          {entry.decodeError !== null && (
            <ErrorBlock title="This entry could not be decoded" detail={entry.decodeError} />
          )}
          {!entry.present && (
            <p className="tiny">
              <strong>Not initialized.</strong> The ledger holds no value under this key, so there
              is nothing to decode.
            </p>
          )}
          {entry.present && entry.json !== null && entry.decodeError === null && (
            <>
              <pre className="mono json-tree" data-testid={`storage-json-${entry.id}`}>
                <JsonValue node={entry.json} />
              </pre>
              <div className="row" style={{ gap: 6, marginTop: 6 }}>
                <CopyButton value={entry.jsonText ?? ""} label={`${entry.label} value as JSON`} />
                <CopyButton value={entry.valueXdr} label={`${entry.label} value as base64 XDR`} />
                <CopyButton value={entry.keyXdr} label={`${entry.label} key as base64 XDR`} />
              </div>
            </>
          )}
          {entry.present && entry.decodeError !== null && (
            <div className="row" style={{ gap: 6 }}>
              <CopyButton value={entry.valueXdr} label={`${entry.label} value as base64 XDR`} />
            </div>
          )}
          <div className="tiny muted mono" style={{ marginTop: 6, wordBreak: "break-all" }}>
            key {entry.keyXdr || "(not XDR)"}
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * The explorer: a trigger in the console that opens a drawer, and the drawer.
 *
 * `StorageExplorer` is exported separately from the trigger so the drawer's own
 * behaviour can be mounted — and tested — without the button.
 */
export function StorageExplorer({
  open,
  state,
  dispatch,
}: {
  open: boolean;
  state: ExplorerState;
  dispatch: Dispatch<ExplorerAction>;
}) {
  const { server, guard } = useGuard();
  const dialogRef = useRef<HTMLDivElement>(null);
  const entries = useMemo(() => visibleEntries(state), [state]);
  const load = useCallback(async () => {
    dispatch({ type: "loading" });
    const result = await readContractStorage(server, guard);
    if (result.ok) {
      dispatch({ type: "loaded", entries: result.value });
      return;
    }
    dispatch({ type: "failed", error: result.error });
  }, [dispatch, server, guard]);

  // Read on open, once per open. Re-reading on every render would put a
  // `getLedgerEntries` behind the whole console's render cadence.
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      openedFor.current = null;
      return;
    }
    // Identity is the guard, so switching guards while the drawer is open
    // re-reads rather than showing the previous contract's storage.
    if (openedFor.current === guard) return;
    openedFor.current = guard;
    void load();
  }, [open, guard, load]);

  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") dispatch({ type: "close" });
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, dispatch]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={() => dispatch({ type: "close" })}>
      <div
        className="modal storage-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="storage-explorer-title"
        ref={dialogRef}
        tabIndex={-1}
        data-testid="storage-explorer"
        onClick={(event) => event.stopPropagation()}
      >
        <strong id="storage-explorer-title">Contract storage</strong>
        <p className="tiny muted">
          Every ledger entry the guard keeps, read with{" "}
          <span className="mono">getLedgerEntries</span> and decoded from its XDR. Values are what
          the contract stores, not what a read function reports.
        </p>

        <div className="row" style={{ marginTop: 10, gap: 6 }}>
          <input
            value={state.query}
            onChange={(event) => dispatch({ type: "query", value: event.target.value })}
            placeholder="Filter entries…"
            aria-label="Filter storage entries"
          />
          {DURABILITIES.map((durability) => (
            <button
              key={durability}
              type="button"
              className={state.durabilityFilter.includes(durability) ? undefined : "secondary"}
              aria-pressed={state.durabilityFilter.includes(durability)}
              onClick={() => dispatch({ type: "toggleDurability", durability })}
            >
              {DURABILITY_LABEL[durability]}
            </button>
          ))}
          <button type="button" className="secondary" onClick={() => void load()}>
            Refresh
          </button>
          <button type="button" className="secondary" onClick={() => dispatch({ type: "close" })}>
            Close
          </button>
        </div>

        <div aria-live="polite" className="tiny muted" style={{ marginTop: 8 }}>
          {state.loading && <Skeleton lines={1} />}
          {!state.loading && state.error === null && <span>{summarizeEntries(state.entries)}</span>}
        </div>

        {state.error !== null && (
          <ErrorBlock
            title="Contract storage could not be read"
            detail={`${state.error} — no entries are shown, because a storage map that did not load is not the contract's current state.`}
          />
        )}

        {!state.loading && state.error === null && entries.length === 0 && (
          <p className="tiny">
            {state.entries.length === 0
              ? "The contract reports no storage entries."
              : "No entry matches this filter."}
          </p>
        )}

        <ul className="storage-entries" data-testid="storage-entries">
          {entries.map((entry) => (
            <EntryRow
              key={entry.id}
              entry={entry}
              expanded={state.selected === entry.id}
              onToggle={() => dispatch({ type: "select", id: entry.id })}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * The console's entry point for the explorer.
 *
 * The trigger announces the drawer it opens, so the control's effect is stated
 * rather than left to the click to imply.
 */
export function StorageExplorerButton() {
  const [state, dispatch] = useReducer(explorerReducer, INITIAL_EXPLORER_STATE);
  const [inventoryOpen, setInventoryOpen] = useState(false);
  const [categories, setCategories] = useState<OperatorStorageCategoryInfo[]>(() =>
    typeof window !== "undefined" ? getOperatorStorageCategories() : [],
  );
  const [confirmCategory, setConfirmCategory] = useState<OperatorStorageCategoryInfo | null>(null);

  return (
    <>
      <button
        type="button"
        className="secondary no-print"
        onClick={() => {
          const nextOpen = !state.open;
          dispatch({ type: "toggle" });
          announce(
            nextOpen ? "Contract storage explorer opened" : "Contract storage explorer closed",
          );
        }}
        aria-expanded={state.open}
        data-testid="storage-explorer-toggle"
      >
        Inspect contract storage
      </button>
      <button
        type="button"
        className="secondary no-print"
        onClick={() => {
          setInventoryOpen((open) => {
            const next = !open;
            if (next) setCategories(getOperatorStorageCategories());
            return next;
          });
        }}
        aria-expanded={inventoryOpen}
        aria-controls="browser-storage-inventory"
        data-testid="storage-inventory-toggle"
      >
        Browser data inventory
      </button>
      {inventoryOpen && (
        <section
          id="browser-storage-inventory"
          aria-label="Browser storage inventory"
          style={{ marginTop: 12 }}
        >
          <p className="tiny muted">
            Local browser records only. They are convenience inputs and never replace live chain
            reads; secret keys are not stored. Clearing local data removes browser-stored records
            only and does not change the chain.
          </p>

          <div style={{ marginBottom: 16 }}>
            <h4 style={{ margin: "12px 0 6px 0" }}>Operator Data Categories</h4>
            <div className="scrolly">
              <table className="events" data-testid="storage-categories-table">
                <thead>
                  <tr>
                    <th>Category</th>
                    <th>Description</th>
                    <th>Count</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {categories.map((cat) => (
                    <tr key={cat.id}>
                      <td>
                        <strong>{cat.name}</strong>
                      </td>
                      <td className="tiny">{cat.description}</td>
                      <td>
                        <span className="pill">
                          {cat.itemCount} item{cat.itemCount === 1 ? "" : "s"}
                        </span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="secondary danger"
                          onClick={() => setConfirmCategory(cat)}
                          data-testid={`clear-category-${cat.id}`}
                        >
                          Clear
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {confirmCategory && (
              <div
                role="alert"
                className="notice danger"
                style={{
                  marginTop: 12,
                  padding: 12,
                  border: "1px solid var(--border-danger, #e53e3e)",
                }}
                data-testid="clear-category-confirm"
              >
                <p style={{ margin: 0 }}>
                  <strong>Clear {confirmCategory.name}?</strong>
                </p>
                <p className="tiny" style={{ margin: "6px 0 10px 0" }}>
                  Clearing local records removes {confirmCategory.name.toLowerCase()} stored in this
                  browser only. It does not change the chain or affect any on-chain accounts,
                  contracts, or transactions.
                </p>
                <div className="row" style={{ gap: 8 }}>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      clearOperatorStorageCategory(confirmCategory.id);
                      announce(
                        `Cleared ${confirmCategory.name} from browser storage. On-chain state is unchanged.`,
                      );
                      setConfirmCategory(null);
                      setCategories(getOperatorStorageCategories());
                    }}
                    data-testid={`confirm-clear-${confirmCategory.id}`}
                  >
                    Confirm Clear
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setConfirmCategory(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          <h4 style={{ margin: "16px 0 6px 0" }}>Persisted Helper Keys</h4>
          <div className="scrolly">
            <table className="events">
              <thead>
                <tr>
                  <th>Storage key</th>
                  <th>Purpose</th>
                  <th>Data category</th>
                  <th>Public metadata</th>
                </tr>
              </thead>
              <tbody>
                {STORAGE_INVENTORY.map((entry) => (
                  <tr key={`${entry.area}:${entry.key}`}>
                    <td className="mono tiny">
                      {entry.key} ({entry.area})
                    </td>
                    <td className="tiny">{entry.purpose}</td>
                    <td className="tiny">{entry.category}</td>
                    <td className="tiny">{entry.containsPublicMetadata ? "Yes" : "No"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <StorageExplorer open={state.open} state={state} dispatch={dispatch} />
    </>
  );
}
