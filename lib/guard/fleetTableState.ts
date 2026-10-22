/**
 * Fleet table state machine (upstream issue #32).
 *
 * The fleet table's body must never be a bare "0 rows" box: three different
 * situations look identical inside an empty `<tbody>` but demand different
 * copy and different recovery paths. Classifying them is pure logic, so it
 * lives here with the rest of the tested surface.
 *
 *   - `loading`   — first fetch still in flight; render the pending skeleton.
 *   - `registry-empty` — no guards saved at all; the fix is adding one, so the
 *     empty state points at the Configure page (recovery link).
 *   - `filter-empty`   — guards exist but the search/filters exclude every
 *     row; the fix is clearing the filters, so the empty state carries a
 *     clear button (the incident-class rule: a filter that hides everything
 *     must always offer a way back).
 *   - `rows`      — at least one row to render.
 *
 * `registryEmpty` (not just `rows.length === 0`) decides between the two
 * empties because the recovery paths differ.
 */
import {
  SORT_KEYS,
  defaultSortDirection,
  filterFleet,
  sortFleet,
  type DerivedStatus,
  type FleetRow,
  type SortDirection,
  type SortKey,
} from "./fleet.ts";
import type { StorageLike } from "./instance.ts";

export type FleetTableState =
  { kind: "loading" } | { kind: "registry-empty" } | { kind: "filter-empty" } | { kind: "rows" };

export function fleetTableState(input: {
  loading: boolean;
  registryCount: number;
  filteredCount: number;
}): FleetTableState {
  if (input.loading && input.registryCount === 0) return { kind: "loading" };
  if (input.registryCount === 0) return { kind: "registry-empty" };
  if (input.filteredCount === 0) return { kind: "filter-empty" };
  return { kind: "rows" };
}

/** Copy for each non-rows state, single-sourced so tests can pin it. */
export function fleetEmptyCopy(state: FleetTableState): { title: string; hint: string } | null {
  switch (state.kind) {
    case "loading":
      return {
        title: "Loading fleet data…",
        hint: "Reading each registered guard from the chain.",
      };
    case "registry-empty":
      return {
        title: "No guards in your registry yet",
        hint: "Add one from the Configure page to see it here.",
      };
    case "filter-empty":
      return {
        title: "No guards match the current search or filters",
        hint: "Clear the search or set the filters back to All.",
      };
    default:
      return null;
  }
}

// ── The operator's view of the table ───────────────────────────────────────
//
// Search, filters and sort are *view* choices: how the operator wants to look at
// the fleet. They are remembered across visits so a long fleet does not have to
// be re-sorted every time, but they are deliberately a separate record from the
// guard registry. Nothing the chain said (a status, a spend figure, a
// countdown) is ever written here, and the registry key is never touched: the
// next poll decides what each row is, and a remembered "Frozen" filter simply
// selects whichever rows read as frozen *now*.

/** Storage key for the remembered view. Versioned so a shape change cannot be misread. */
export const FLEET_VIEW_STORAGE_KEY = "stellar-agent-guard-dashboard.fleet-view.v1";

/** Cap on remembered search text, so a pasted blob cannot bloat storage. */
export const FLEET_SEARCH_MAX_LENGTH = 200;

export interface FleetViewState {
  search: string;
  network: string | null;
  status: DerivedStatus | null;
  /** `null` is the default order: the registry's own. */
  sortKey: SortKey | null;
  sortDirection: SortDirection;
}

export const DEFAULT_FLEET_VIEW: FleetViewState = {
  search: "",
  network: null,
  status: null,
  sortKey: null,
  sortDirection: "asc",
};

/** Every status a row can have, including the unread one. Used to validate stored input. */
export const FLEET_STATUSES: readonly DerivedStatus[] = ["Active", "Frozen", "Expired", "Unknown"];

/** True when the view would show every row in registry order. */
export function isDefaultFleetView(view: FleetViewState): boolean {
  return (
    view.search === "" && view.network === null && view.status === null && view.sortKey === null
  );
}

/** True when search or a filter (not just the sort) is narrowing the rows. */
export function hasActiveFleetFilter(view: FleetViewState): boolean {
  return view.search.trim() !== "" || view.network !== null || view.status !== null;
}

/**
 * Turn untrusted input (storage, a pasted link) into a valid view.
 *
 * Every field is checked on its own and falls back to its default when it is
 * not recognised, so one bad field does not discard the rest and a hand-edited
 * value can never put the table into a state the UI cannot render. `networks`
 * lists the networks this build can show; a remembered network outside it is
 * dropped, because filtering to it would hide every row.
 */
export function parseFleetView(raw: unknown, networks: readonly string[] = []): FleetViewState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return DEFAULT_FLEET_VIEW;
  const input = raw as Record<string, unknown>;

  const search =
    typeof input.search === "string" ? input.search.slice(0, FLEET_SEARCH_MAX_LENGTH) : "";
  const network =
    typeof input.network === "string" && networks.includes(input.network) ? input.network : null;
  const status = FLEET_STATUSES.find((candidate) => candidate === input.status) ?? null;
  const sortKey = SORT_KEYS.find((candidate) => candidate === input.sortKey) ?? null;
  const sortDirection: SortDirection =
    input.sortDirection === "asc" || input.sortDirection === "desc"
      ? input.sortDirection
      : sortKey
        ? defaultSortDirection(sortKey)
        : "asc";

  return { search, network, status, sortKey, sortDirection };
}

function defaultStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Read the remembered view; corrupt or missing storage yields the default view. */
export function loadFleetView(options?: {
  storage?: StorageLike | null;
  networks?: readonly string[];
}): FleetViewState {
  const storage = options?.storage === undefined ? defaultStorage() : options.storage;
  if (!storage) return DEFAULT_FLEET_VIEW;
  try {
    const raw = storage.getItem(FLEET_VIEW_STORAGE_KEY);
    if (raw === null || raw === "") return DEFAULT_FLEET_VIEW;
    return parseFleetView(JSON.parse(raw), options?.networks ?? []);
  } catch {
    return DEFAULT_FLEET_VIEW;
  }
}

/**
 * Remember the view. Writes exactly the five view fields — never a row, an
 * address, a status read from the chain or any registry data. Returning to the
 * default view clears the entry instead of storing a no-op. Best-effort: private
 * mode and quota errors leave the view in memory for the session.
 */
export function saveFleetView(
  view: FleetViewState,
  options?: { storage?: StorageLike | null },
): void {
  const storage = options?.storage === undefined ? defaultStorage() : options.storage;
  if (!storage) return;
  try {
    if (isDefaultFleetView(view)) {
      if (typeof storage.removeItem === "function") storage.removeItem(FLEET_VIEW_STORAGE_KEY);
      else storage.setItem(FLEET_VIEW_STORAGE_KEY, "");
      return;
    }
    const record: FleetViewState = {
      search: view.search.slice(0, FLEET_SEARCH_MAX_LENGTH),
      network: view.network,
      status: view.status,
      sortKey: view.sortKey,
      sortDirection: view.sortDirection,
    };
    storage.setItem(FLEET_VIEW_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // The view is a convenience; failing to remember it is not worth an error.
  }
}

/** The subset of `window` the cross-tab sync needs, so tests can fake it. */
export interface FleetViewEventTarget {
  addEventListener(type: "storage", listener: (event: { key: string | null }) => void): void;
  removeEventListener(type: "storage", listener: (event: { key: string | null }) => void): void;
}

/**
 * A `useSyncExternalStore`-shaped holder for the remembered view.
 *
 * The server (and the first hydrating render) always sees the default view; the
 * client then reads storage, so markup never disagrees with what was rendered.
 * `getSnapshot` returns the same object until the view actually changes, which
 * `useSyncExternalStore` requires. A change made in another tab arrives as a
 * `storage` event and is picked up by re-reading, never by trusting the event's
 * payload.
 */
export interface FleetViewStore {
  getSnapshot(): FleetViewState;
  getServerSnapshot(): FleetViewState;
  subscribe(listener: () => void): () => void;
  /** Replace the view and remember it. */
  set(next: FleetViewState): void;
}

export function createFleetViewStore(options?: {
  storage?: StorageLike | null;
  networks?: readonly string[];
  eventTarget?: FleetViewEventTarget | null;
}): FleetViewStore {
  const storage = options?.storage;
  const networks = options?.networks ?? [];
  const eventTarget =
    options?.eventTarget === undefined
      ? typeof window === "undefined"
        ? null
        : (window as unknown as FleetViewEventTarget)
      : options.eventTarget;

  let current: FleetViewState | null = null;
  const listeners = new Set<() => void>();

  const read = (): FleetViewState => {
    current ??= loadFleetView({ ...(storage === undefined ? {} : { storage }), networks });
    return current;
  };
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const onStorage = (event: { key: string | null }): void => {
    if (event.key !== null && event.key !== FLEET_VIEW_STORAGE_KEY) return;
    current = null;
    notify();
  };

  return {
    getSnapshot: read,
    getServerSnapshot: () => DEFAULT_FLEET_VIEW,
    subscribe(listener) {
      if (listeners.size === 0) eventTarget?.addEventListener("storage", onStorage);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) eventTarget?.removeEventListener("storage", onStorage);
      };
    },
    set(next) {
      current = next;
      saveFleetView(next, storage === undefined ? undefined : { storage });
      notify();
    },
  };
}

/**
 * The rows to show: filtered from the rows as they are read right now, then
 * sorted. Filtering looks only at each row's current label, address, network and
 * derived status — an unread guard is `Unknown`, which matches the Unknown
 * filter and never the Active one — and the input order is the registry order
 * the sort falls back on.
 */
export function applyFleetView(rows: FleetRow[], view: FleetViewState): FleetRow[] {
  return sortFleet(
    filterFleet(rows, view.search, view.network, view.status),
    view.sortKey,
    view.sortDirection,
  );
}
