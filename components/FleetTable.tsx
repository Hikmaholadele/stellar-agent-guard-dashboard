"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { formatStroopsWithUnit } from "../lib/guard/formatters.ts";
import { POLLING, jitteredInterval } from "../lib/guard/polling.ts";
import {
  pollFleet,
  defaultSortDirection,
  type FleetRow,
  type DerivedStatus,
  type SortKey,
} from "../lib/guard/fleet.ts";
import { loadInstances } from "../lib/guard/instance.ts";
import { freezeGuard } from "../lib/guard/guardOps.ts";
import { freezeFailed, freezeSubmitted, writeFailureReason } from "../lib/guard/announceCopy.ts";
import { announce } from "../lib/guard/useAnnounce.ts";
import { NETWORK } from "../lib/guard/network.ts";
import { useGuard } from "./GuardProvider.tsx";
import {
  DEFAULT_FLEET_VIEW,
  applyFleetView,
  createFleetViewStore,
  fleetTableState,
  fleetEmptyCopy,
  hasActiveFleetFilter,
  isDefaultFleetView,
  type FleetViewState,
} from "../lib/guard/fleetTableState.ts";
import { Skeleton, starLink } from "./bits.tsx";
import { useRouter } from "next/navigation";
import { freighterSigner } from "../lib/guard/wallet.ts";

// One store for the tab: the remembered view (search, filters, sort), never row data.
const fleetViewStore = createFleetViewStore({ networks: [NETWORK.name] });

export function FleetTable() {
  const { wallet, server } = useGuard();
  const router = useRouter();

  const [rows, setRows] = useState<FleetRow[]>([]);
  const [loading, setLoading] = useState(true);

  // The operator's view of the table (search, filters, sort). It is remembered
  // across visits but is not registry data: only these choices are stored, never
  // a row or a status read from the chain. The store serves the default view to
  // the server and to hydration, then the remembered one.
  const view = useSyncExternalStore(
    fleetViewStore.subscribe,
    fleetViewStore.getSnapshot,
    fleetViewStore.getServerSnapshot,
  );
  const { search, network: networkFilter, status: statusFilter, sortKey, sortDirection } = view;
  const updateView = (patch: Partial<FleetViewState>) => fleetViewStore.set({ ...view, ...patch });

  useEffect(() => {
    let mounted = true;
    const fetchFleet = async () => {
      const instances = loadInstances();
      const contacts = instances.map((i) => ({
        address: i.guard,
        label: i.label,
        addedAt: "",
      }));
      const result = await pollFleet(server, contacts);
      if (mounted) {
        setRows(result);
        setLoading(false);
      }
    };

    fetchFleet();
    const interval = setInterval(fetchFleet, jitteredInterval(POLLING.fleetMs));
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [server]);

  // Derived from the rows as last read, so a poll that changes a guard's status
  // immediately moves it in or out of the filtered, sorted view.
  const filteredAndSorted = useMemo(() => applyFleetView(rows, view), [rows, view]);

  const tableState = fleetTableState({
    loading,
    registryCount: rows.length,
    filteredCount: filteredAndSorted.length,
  });
  const empty = fleetEmptyCopy(tableState);

  const clearFilters = () => updateView({ search: "", network: null, status: null });
  // Back to registry order with nothing filtered.
  const resetView = () => fleetViewStore.set(DEFAULT_FLEET_VIEW);
  const viewIsDefault = isDefaultFleetView(view);
  const filtering = hasActiveFleetFilter(view);

  const handleFreeze = async (guard: string) => {
    if (!wallet) {
      alert("Please connect your wallet first to freeze a guard.");
      return;
    }
    try {
      const result = await freezeGuard({
        server,
        signer: freighterSigner(wallet.address, NETWORK.passphrase),
        guard,
      });
      // The fleet table has no snapshot to re-read, so it announces what it does
      // have: the submission receipt, and the reason when there wasn't one. This
      // is the only freeze path left without a chain re-read behind its claim —
      // the panic panel announces its verified outcome instead (issue #30), so a
      // freeze is spoken exactly once no matter which page ran it.
      const spoken =
        result.kind === "submitted"
          ? freezeSubmitted(guard)
          : freezeFailed("freeze", writeFailureReason(result, "the write did not complete"), guard);
      announce(spoken.message, spoken.priority);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const spoken = freezeFailed("freeze", detail, guard);
      announce(spoken.message, spoken.priority);
      console.error(err);
    }
  };

  const renderStatus = (status: DerivedStatus) => {
    switch (status) {
      case "Active":
        return <span className="pill ok">Active</span>;
      case "Frozen":
        return <span className="pill danger">Frozen</span>;
      case "Expired":
        return <span className="pill warn">Expired</span>;
      case "Unknown":
        return <span className="pill muted">Unknown</span>;
      default:
        return <span className="pill muted">Unknown</span>;
    }
  };

  const renderError = (error?: string | null) => {
    if (!error) return null;
    return <span className="pill danger tiny">Read error: {error}</span>;
  };

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Fleet Overview</h2>
        <span className="tiny muted">
          {rows.length} guard{rows.length !== 1 ? "s" : ""} in registry
        </span>
      </div>

      <div className="split" style={{ marginTop: 12 }}>
        <label className="field" style={{ marginBottom: 0, flex: 2 }}>
          <span className="lbl">Search</span>
          <input
            type="search"
            value={search}
            onChange={(e) => updateView({ search: e.target.value })}
            placeholder="Search by name or address..."
          />
        </label>

        <div className="row" style={{ flex: 3 }}>
          <label className="field" style={{ marginBottom: 0, flex: 1 }}>
            <span className="lbl">Network</span>
            <select
              value={networkFilter || ""}
              onChange={(e) => updateView({ network: e.target.value || null })}
            >
              <option value="">All Networks</option>
              <option value={NETWORK.name}>{NETWORK.name}</option>
            </select>
          </label>
          <label className="field" style={{ marginBottom: 0, flex: 1 }}>
            <span className="lbl">Status</span>
            <select
              value={statusFilter || ""}
              onChange={(e) => updateView({ status: (e.target.value as DerivedStatus) || null })}
            >
              <option value="">All Statuses</option>
              <option value="Active">Active</option>
              <option value="Frozen">Frozen</option>
              <option value="Expired">Expired</option>
              {/* Unread is its own state, not a flavour of healthy: a guard whose
                  read failed matches this and never "Active". */}
              <option value="Unknown">Unknown (not read)</option>
            </select>
          </label>
          <label className="field" style={{ marginBottom: 0, flex: 1 }}>
            <span className="lbl">Sort</span>
            <select
              value={sortKey || ""}
              onChange={(e) => {
                const key = (e.target.value as SortKey) || null;
                updateView({
                  sortKey: key,
                  sortDirection: key ? defaultSortDirection(key) : "asc",
                });
              }}
            >
              <option value="">Registry order</option>
              <option value="label">Label</option>
              <option value="address">Address</option>
              <option value="status">Status (needs attention first)</option>
              <option value="spend">Spend (High to Low)</option>
              <option value="expiration">Expiration (Soonest)</option>
            </select>
          </label>
        </div>
      </div>

      <div className="row" style={{ marginTop: 8, gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {sortKey && (
          <button
            type="button"
            className="secondary"
            style={{ padding: "4px 8px", fontSize: "0.8em" }}
            onClick={() => updateView({ sortDirection: sortDirection === "asc" ? "desc" : "asc" })}
            aria-label={`Sort direction: ${sortDirection === "asc" ? "ascending" : "descending"}. Activate to reverse.`}
          >
            {sortDirection === "asc" ? "Ascending ↑" : "Descending ↓"}
          </button>
        )}
        {!viewIsDefault && (
          <button
            type="button"
            className="secondary"
            style={{ padding: "4px 8px", fontSize: "0.8em" }}
            onClick={resetView}
          >
            Reset view
          </button>
        )}
        {filtering && tableState.kind === "rows" && (
          <span className="tiny muted" role="status">
            Showing {filteredAndSorted.length} of {rows.length} guard{rows.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      <div className="scrolly table-stack" style={{ marginTop: 14 }}>
        <table className="events stack">
          <thead>
            <tr>
              <th scope="col">Guard</th>
              <th scope="col">Network</th>
              <th scope="col">Status</th>
              <th scope="col">24h Spend</th>
              <th scope="col">DMS Countdown</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {tableState.kind === "loading" &&
              /* The initial fleet poll is a pending read, so it reserves the
                 table's shape with skeleton rows instead of a text line that
                 collapses when the rows land. Not zeros, not an empty state. */
              [0, 1, 2].map((row) => (
                <tr key={row} aria-busy="true" aria-hidden="true">
                  <td>
                    <Skeleton lines={1} />
                  </td>
                  <td>
                    <Skeleton lines={1} />
                  </td>
                  <td>
                    <Skeleton lines={1} />
                  </td>
                  <td>
                    <Skeleton lines={1} />
                  </td>
                  <td>
                    <Skeleton lines={1} />
                  </td>
                  <td>
                    <Skeleton lines={1} />
                  </td>
                </tr>
              ))}
            {tableState.kind === "registry-empty" && (
              <tr>
                <td
                  colSpan={6}
                  className="fleet-empty"
                  style={{ textAlign: "center", padding: "28px 20px" }}
                >
                  <strong>{empty!.title}</strong>
                  <span className="tiny muted">{empty!.hint}</span>
                  <div style={{ marginTop: 10 }}>
                    <Link href="/configure">Open the Configure page</Link>
                  </div>
                </td>
              </tr>
            )}
            {tableState.kind === "filter-empty" && (
              <tr>
                <td
                  colSpan={6}
                  className="fleet-empty"
                  style={{ textAlign: "center", padding: "28px 20px" }}
                >
                  <strong>{empty!.title}</strong>
                  <span className="tiny muted">{empty!.hint}</span>
                  <div style={{ marginTop: 10 }}>
                    <button className="secondary" onClick={clearFilters}>
                      Clear search and filters
                    </button>
                  </div>
                </td>
              </tr>
            )}
            {tableState.kind === "rows" &&
              filteredAndSorted.map((row) => (
                <tr key={row.contact.address}>
                  <td data-label="Guard">
                    <div>
                      <strong>{row.contact.label}</strong>
                    </div>
                    <div className="mono tiny">{starLink(row.contact.address)}</div>
                  </td>
                  <td className="tiny" data-label="Network">
                    {row.network}
                  </td>
                  <td data-label="Status">{renderStatus(row.derivedStatus)}</td>
                  <td className="mono tiny" data-label="24h Spend">
                    {formatStroopsWithUnit(row.spend24h)}
                  </td>
                  <td className="mono tiny" data-label="DMS Countdown">
                    {row.dmsCountdownSecs !== null ? `${row.dmsCountdownSecs}s` : "—"}
                  </td>
                  <td data-label="Actions">
                    <div className="row" style={{ gap: "8px", flexWrap: "wrap" }}>
                      <button
                        className="secondary"
                        style={{ padding: "4px 8px", fontSize: "0.8em" }}
                        onClick={() => router.push(`/?guard=${row.contact.address}`)}
                      >
                        Inspect
                      </button>
                      {row.retry && (
                        <button
                          className="secondary"
                          style={{ padding: "4px 8px", fontSize: "0.8em" }}
                          onClick={() => row.retry!()}
                          disabled={row.derivedStatus !== "Unknown"}
                        >
                          Retry
                        </button>
                      )}
                      {row.error && (
                        <span className="tiny muted" title={row.error}>
                          ⚠
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
