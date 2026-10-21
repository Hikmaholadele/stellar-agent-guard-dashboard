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
  filterTxHistory,
  loadTxHistory,
  paginateTxHistory,
  subscribeTxHistory,
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

  // Read the store only in the browser, and follow later records (another
  // panel submitting, another tab) through the store's subscription.
  useEffect(() => {
    const sync = () => setEntries(loadTxHistory());
    sync();
    return subscribeTxHistory(sync);
  }, []);

  const filtered = useMemo(
    () => filterTxHistory(entries, { query, from, to }),
    [entries, query, from, to],
  );
  const paged = paginateTxHistory(filtered, page, PAGE_SIZE);

  async function verifyEntry(entry: TxHistoryEntry) {
    if (!txHistoryMatchesNetwork(entry, NETWORK.passphrase)) return;
    setVerifications((current) => ({
      ...current,
      [entry.hash]: { status: "checking", verifiedAt: null },
    }));
    try {
      const result = await server.getTransaction(entry.hash);
      const status = txVerificationStatus(String(result.status));
      const nextStatus = status ?? "unavailable";
      setVerifications((current) => ({
        ...current,
        [entry.hash]: {
          status: nextStatus,
          verifiedAt: new Date().toISOString(),
          ...(status === null
            ? { detail: `Unrecognized RPC status: ${String(result.status)}` }
            : {}),
        },
      }));
      announce(
        `Transaction ${entry.hash.slice(0, 8)} verification: ${verificationLabel(nextStatus)} on ${entry.networkName}`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setVerifications((current) => ({
        ...current,
        [entry.hash]: {
          status: "unavailable",
          verifiedAt: new Date().toISOString(),
          detail,
        },
      }));
      announce(`Transaction ${entry.hash.slice(0, 8)} verification unavailable: ${detail}`);
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

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Transaction history</h2>
        <span className="tiny muted">
          {entries.length} of {TX_HISTORY_LIMIT} entries kept in this browser
        </span>
      </div>

      <p className="tiny muted" style={{ marginTop: 8 }}>
        Every admin transaction signed from this console — policy changes, freezes, unfreezes,
        deployments — recorded with the hash the network accepted. Refused calls never became
        transactions, so they have no place here.
      </p>

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
          <div className="scrolly" style={{ marginTop: 14 }}>
            <table className="events">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Operation</th>
                  <th>Status</th>
                  <th>Network</th>
                  <th>Tx Hash</th>
                  <th>Gas Fee</th>
                  <th>Chain verification</th>
                </tr>
              </thead>
              <tbody>
                {paged.rows.map((entry) => (
                  <tr key={entry.hash}>
                    <td className="mono tiny" title={entry.recordedAt}>
                      {formatTimestamp(entry.recordedAt)}
                    </td>
                    <td className="mono tiny">{entry.operation}</td>
                    <td>
                      {entry.status === "confirmed" ? (
                        <span className="pill ok">Confirmed</span>
                      ) : (
                        <span className="pill danger">Failed</span>
                      )}
                    </td>
                    <td className="tiny" title={entry.networkPassphrase ?? "Network not recorded"}>
                      <div>{entry.networkName ?? "Unknown network"}</div>
                      <div className="muted">{entry.networkPassphrase ?? "Legacy history"}</div>
                    </td>
                    <td>
                      <TxHashCell hash={entry.hash} />
                    </td>
                    <td className="mono tiny">
                      {entry.feeStroops !== null ? `${entry.feeStroops} stroops` : "—"}
                    </td>
                    <td className="tiny">
                      {txHistoryMatchesNetwork(entry, NETWORK.passphrase) ? (
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => void verifyEntry(entry)}
                          disabled={verifications[entry.hash]?.status === "checking"}
                          aria-label={`Verify transaction ${entry.hash} on ${entry.networkName ?? "recorded network"}`}
                        >
                          {verifications[entry.hash]?.status === "checking"
                            ? "Checking…"
                            : "Verify"}
                        </button>
                      ) : (
                        <span title="Verification is limited to the exact recorded network passphrase">
                          Unavailable
                        </span>
                      )}
                      {verifications[entry.hash] && (
                        <div style={{ marginTop: 4 }}>
                          <div>Chain: {verificationLabel(verifications[entry.hash]!.status)}</div>
                          {verifications[entry.hash]!.detail && (
                            <div className="muted">{verifications[entry.hash]!.detail}</div>
                          )}
                          {verifications[entry.hash]!.verifiedAt && (
                            <div className="muted">
                              Checked {formatTimestamp(verifications[entry.hash]!.verifiedAt!)} via{" "}
                              {NETWORK.rpcUrl}
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
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
