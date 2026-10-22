"use client";

/**
 * The transaction history table: search, date range, pagination, CSV export.
 *
 * The list is loaded from the store after mount (not during render), so server
 * and client markup agree on the first paint and localStorage is only read in
 * the browser. The table shows only outcomes this console actually broadcast —
 * a refused call was never a transaction and is deliberately absent.
 */

import { useEffect, useMemo, useState } from "react";
import {
  TX_HISTORY_LIMIT,
  TX_HISTORY_MAX_AGE_DAYS,
  clearTxHistory,
  filterTxHistory,
  loadTxHistory,
  paginateTxHistory,
  subscribeTxHistory,
  txHistorySaveWarning,
  txHistoryMatchesNetwork,
  txHistoryToCsv,
  txVerificationStatus,
  type TxVerificationStatus,
  type TxHistoryEntry,
} from "../lib/guard/txHistory.ts";
import { NETWORK } from "../lib/guard/network.ts";
import { useAnnounce } from "../lib/guard/useAnnounce.ts";
import { useGuard } from "./GuardProvider.tsx";
import { starLink, TxHashCell } from "./bits.tsx";

const PAGE_SIZE = 10;

interface Verification {
  status: TxVerificationStatus | "checking" | "unavailable";
  verifiedAt: string | null;
  detail?: string;
}

export function TxHistoryTable() {
  const announce = useAnnounce();
  const { server } = useGuard();
  const [entries, setEntries] = useState<TxHistoryEntry[]>([]);
  const [verifications, setVerifications] = useState<Record<string, Verification>>({});
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [saveWarning, setSaveWarning] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  // Read the store only in the browser, and follow later records (another
  // panel submitting, another tab) through the store's subscription.
  useEffect(() => {
    const sync = () => {
      setEntries(loadTxHistory());
      setSaveWarning(txHistorySaveWarning());
    };
    sync();
    return subscribeTxHistory(sync);
  }, []);

  const filtered = useMemo(
    () => filterTxHistory(entries, { query, from, to }),
    [entries, query, from, to],
  );
  const paged = paginateTxHistory(filtered, page, PAGE_SIZE);

  async function verifyEntry(entry: TxHistoryEntry) {
    if (!entry.hash || !txHistoryMatchesNetwork(entry, NETWORK.passphrase)) return;
    const hash = entry.hash;
    setVerifications((current) => ({
      ...current,
      [hash]: { status: "checking", verifiedAt: null },
    }));
    try {
      const result = await server.getTransaction(hash);
      const status = txVerificationStatus(String(result.status));
      const nextStatus = status ?? "unavailable";
      setVerifications((current) => ({
        ...current,
        [hash]: {
          status: nextStatus,
          verifiedAt: new Date().toISOString(),
          ...(status === null
            ? { detail: `Unrecognized RPC status: ${String(result.status)}` }
            : {}),
        },
      }));
      announce(
        `Transaction ${hash.slice(0, 8)} verification: ${verificationLabel(nextStatus)} on ${entry.networkName}`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setVerifications((current) => ({
        ...current,
        [hash]: {
          status: "unavailable",
          verifiedAt: new Date().toISOString(),
          detail,
        },
      }));
      announce(`Transaction ${hash.slice(0, 8)} verification unavailable: ${detail}`);
    }
  }

  function exportCsv() {
    const csv = txHistoryToCsv(filtered);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `guard-tx-history-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    announce(`Exported ${filtered.length} transaction${filtered.length === 1 ? "" : "s"} as CSV`);
  }

  function downloadHistoryBackup() {
    const csv = txHistoryToCsv(entries);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `guard-tx-history-backup-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Transaction history</h2>
        <span className="tiny muted">
          {entries.length} of {TX_HISTORY_LIMIT} entries kept in this browser (max{" "}
          {TX_HISTORY_MAX_AGE_DAYS} days retention)
        </span>
      </div>

      <p className="tiny muted" style={{ marginTop: 8 }}>
        Every admin transaction signed from this console — policy changes, freezes, unfreezes,
        deployments — recorded with the hash the network accepted. Refused calls never became
        transactions, and cancellations are tracked without a transaction hash.
      </p>

      {saveWarning !== null && (
        <div role="alert" className="tiny" data-testid="history-save-warning">
          {saveWarning}
          <button type="button" className="secondary" onClick={downloadHistoryBackup}>
            Download history backup
          </button>
        </div>
      )}

      {confirmClear && (
        <div
          role="alert"
          className="notice danger"
          style={{ marginTop: 12 }}
          data-testid="clear-history-confirm"
        >
          <p style={{ margin: 0 }}>
            <strong>Clear browser-local transaction history?</strong>
          </p>
          <p className="tiny" style={{ margin: "4px 0 8px 0" }}>
            Clearing local records removes transaction history stored in this browser only. On-chain
            transactions and ledger state are completely unchanged.
          </p>
          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              className="danger"
              onClick={() => {
                clearTxHistory();
                setConfirmClear(false);
                announce("Local transaction history cleared. On-chain transactions are unchanged.");
              }}
              data-testid="confirm-clear-history-button"
            >
              Confirm Clear
            </button>
            <button type="button" className="secondary" onClick={() => setConfirmClear(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="split" style={{ marginTop: 12 }}>
        <label className="field" style={{ marginBottom: 0 }}>
          <span className="lbl">Search (operation, hash or status)</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="freeze, set_policy, …"
          />
        </label>
        <div className="row">
          <label className="field" style={{ marginBottom: 0, flex: 1 }}>
            <span className="lbl">From</span>
            <input
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              aria-label="History from date"
            />
          </label>
          <label className="field" style={{ marginBottom: 0, flex: 1 }}>
            <span className="lbl">To</span>
            <input
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              aria-label="History to date"
            />
          </label>
          <button
            className="secondary"
            onClick={exportCsv}
            disabled={filtered.length === 0}
            style={{ alignSelf: "flex-end" }}
          >
            Export CSV
          </button>
          <button
            type="button"
            className="secondary danger"
            onClick={() => setConfirmClear(true)}
            disabled={entries.length === 0}
            style={{ alignSelf: "flex-end" }}
            data-testid="clear-history-button"
          >
            Clear local history
          </button>
        </div>
      </div>

      {entries.length === 0 ? (
        <p className="tiny muted" style={{ marginTop: 14 }}>
          No transactions have been submitted from this console yet. History appears here after the
          first signed write lands on chain.
        </p>
      ) : filtered.length === 0 ? (
        <p className="tiny muted" style={{ marginTop: 14 }}>
          No transactions match the current search and date range.
        </p>
      ) : (
        <>
          <div className="scrolly table-stack" style={{ marginTop: 14 }}>
            <table className="events stack">
              <thead>
                <tr>
                  <th scope="col">Timestamp</th>
                  <th scope="col">Operation</th>
                  <th scope="col">Status</th>
                  <th scope="col">Network</th>
                  <th scope="col">Tx Hash</th>
                  <th scope="col">Gas Fee</th>
                  <th scope="col">Chain verification</th>
                </tr>
              </thead>
              <tbody>
                {paged.rows.map((entry) => {
                  const hash = entry.hash;
                  const verification = hash ? verifications[hash] : undefined;
                  return (
                    <tr key={hash ?? entry.id ?? entry.recordedAt}>
                      <td className="mono tiny" data-label="Timestamp" title={entry.recordedAt}>
                        {formatTimestamp(entry.recordedAt)}
                      </td>
                      <td className="mono tiny" data-label="Operation">
                        {entry.operation}
                      </td>
                      <td data-label="Status">
                        {entry.status === "confirmed" ? (
                          <span className="pill ok">Confirmed</span>
                        ) : entry.status === "submitted" ? (
                          <span className="pill info">Submitted</span>
                        ) : entry.status === "cancelled" ? (
                          <span className="pill warn">Cancelled</span>
                        ) : entry.status === "pre-submit-failure" ? (
                          <span className="pill danger">Pre-submit failure</span>
                        ) : (
                          <span className="pill danger">Failed</span>
                        )}
                      </td>
                      <td
                        className="tiny"
                        data-label="Network"
                        title={entry.networkPassphrase ?? "Network not recorded"}
                      >
                        <div>{entry.networkName ?? "Unknown network"}</div>
                        <div className="muted">{entry.networkPassphrase ?? "Legacy history"}</div>
                      </td>
                      <td data-label="Tx Hash">
                        {hash ? (
                          <TxHashCell hash={hash} />
                        ) : (
                          <span
                            className="muted tiny mono"
                            title={entry.detail ?? "Transaction not broadcast"}
                          >
                            — (not broadcast)
                          </span>
                        )}
                      </td>
                      <td className="mono tiny" data-label="Gas Fee">
                        {entry.feeStroops !== null ? `${entry.feeStroops} stroops` : "—"}
                      </td>
                      <td className="tiny" data-label="Chain verification">
                        {!hash ||
                        entry.status === "cancelled" ||
                        entry.status === "pre-submit-failure" ? (
                          <span
                            className="muted"
                            title="Transaction was not broadcast to the network"
                          >
                            Not broadcast
                          </span>
                        ) : txHistoryMatchesNetwork(entry, NETWORK.passphrase) ? (
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => void verifyEntry(entry)}
                            disabled={verification?.status === "checking"}
                            aria-label={`Verify transaction ${hash} on ${entry.networkName ?? "recorded network"}`}
                          >
                            {verification?.status === "checking" ? "Checking…" : "Verify"}
                          </button>
                        ) : (
                          <span title="Verification is limited to the exact recorded network passphrase">
                            Unavailable
                          </span>
                        )}
                        {verification && (
                          <div style={{ marginTop: 4 }}>
                            <div>Chain: {verificationLabel(verification.status)}</div>
                            {verification.detail && (
                              <div className="muted">{verification.detail}</div>
                            )}
                            {verification.verifiedAt && (
                              <div className="muted">
                                Checked {formatTimestamp(verification.verifiedAt)} via{" "}
                                {NETWORK.rpcUrl}
                              </div>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="row" style={{ marginTop: 10, justifyContent: "space-between" }}>
            <span className="tiny muted">
              Showing {paged.rows.length} of {paged.total} matching · page {paged.page} of{" "}
              {paged.pages}
            </span>
            <div className="row">
              <button
                className="secondary"
                onClick={() => setPage(paged.page - 1)}
                disabled={paged.page <= 1}
                aria-label="Previous page"
              >
                Prev
              </button>
              <button
                className="secondary"
                onClick={() => setPage(paged.page + 1)}
                disabled={paged.page >= paged.pages}
                aria-label="Next page"
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Stored timestamps are ISO UTC — show the UTC wall clock so dates sort as written. */
function formatTimestamp(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

function verificationLabel(status: Verification["status"]): string {
  switch (status) {
    case "checking":
      return "Pending verification";
    case "not-found":
      return "Not found";
    case "pending":
      return "Pending on network";
    case "confirmed":
      return "Confirmed on chain";
    case "failed":
      return "Failed on chain";
    case "unavailable":
      return "Unavailable";
  }
}
