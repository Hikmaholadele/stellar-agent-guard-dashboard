/**
 * Dashboard layout preferences, persisted in `localStorage` (#149).
 *
 * Different operators prioritise different panels — a wall monitor wants the
 * telemetry feed first, a responder wants the panic button. This module owns
 * the layout state: which panels exist, the order they render in, and whether
 * each is collapsed or expanded. The store is framework-free TypeScript (the
 * console's established split: pure logic unit-tested under node:test, thin
 * React views over it), and the persistence seam mirrors `txHistory.ts` and
 * `instance.ts`: best-effort writes, validated reads, injectable storage so
 * tests never touch a browser.
 *
 * Layout *shape* is validated on load, so a stored layout from an older build
 * (a panel that no longer exists, a corrupted payload) degrades to the default
 * arrangement instead of silently dropping a panel the operator relies on —
 * and a panel added by a newer build appears even though no stored entry names
 * it.
 */

/** The panels the console's grid can hold. */
export type PanelId = "status" | "txhistory" | "panic" | "telemetry" | "multisig" | "xdr";

export const PANEL_IDS: readonly PanelId[] = [
  "status",
  "txhistory",
  "panic",
  "telemetry",
  "multisig",
  "xdr",
];

/** The default arrangement, newest-relevant-first: state, history, emergency. */
export const DEFAULT_LAYOUT: readonly PanelId[] = [
  "status",
  "txhistory",
  "panic",
  "telemetry",
  "multisig",
  "xdr",
];

export const LAYOUT_STORAGE_KEY = "stellar-agent-guard-dashboard.layout.v1";

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
    return null;
  }
}

/**
 * One panel's placement: where it sits and whether it is expanded.
 *
 * `collapsed` panels keep their place in the order (a hidden panel that lost
 * its spot would be a panel the operator cannot find again).
 */
export interface PanelPlacement {
  id: PanelId;
  collapsed: boolean;
}

export interface DashboardLayout {
  order: PanelPlacement[];
}

function isPanelId(value: unknown): value is PanelId {
  return typeof value === "string" && (PANEL_IDS as readonly string[]).includes(value);
}

function isPlacement(value: unknown): value is PanelPlacement {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<PanelPlacement>;
  return isPanelId(candidate.id) && typeof candidate.collapsed === "boolean";
}

/** The default layout, every panel expanded. */
export function defaultLayout(): DashboardLayout {
  return {
    order: DEFAULT_LAYOUT.map((id) => ({ id, collapsed: false })),
  };
}

/**
 * Validate and reconcile a stored layout against the known panels.
 *
 * Duplicates are dropped (the first occurrence wins), unknown ids are removed,
 * and panels that exist but are missing from the stored order are appended in
 * default order — so an upgraded build never hides a new panel from an
 * operator whose stored layout predates it. Any structural failure yields the
 * default layout.
 */
export function normalizeLayout(value: unknown): DashboardLayout {
  if (!Array.isArray(value)) return defaultLayout();
  const seen = new Set<PanelId>();
  const order: PanelPlacement[] = [];
  for (const entry of value) {
    if (!isPlacement(entry) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    order.push({ id: entry.id, collapsed: entry.collapsed });
  }
  for (const id of DEFAULT_LAYOUT) {
    if (!seen.has(id)) order.push({ id, collapsed: false });
  }
  if (order.length === 0) return defaultLayout();
  return { order };
}

/** The stored layout, or the default when nothing (valid) is stored. */
export function loadLayout(storage: StorageLike | null = defaultStorage()): DashboardLayout {
  if (!storage) return defaultLayout();
  try {
    const raw = storage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return defaultLayout();
    return normalizeLayout(JSON.parse(raw) as unknown);
  } catch {
    return defaultLayout();
  }
}

/** Persist the layout. A private-mode write failure is not worth surfacing. */
export function saveLayout(
  layout: DashboardLayout,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout.order));
  } catch {
    // Private mode or quota: the layout stays in memory for this session.
  }
}

/** Move a panel to a new zero-based index, shifting the others aside. */
export function reorderPanel(
  layout: DashboardLayout,
  id: PanelId,
  toIndex: number,
): DashboardLayout {
  const from = layout.order.findIndex((placement) => placement.id === id);
  if (from === -1) return layout;
  const clamped = Math.min(Math.max(0, Math.trunc(toIndex)), layout.order.length - 1);
  if (clamped === from) return layout;
  const order = [...layout.order];
  const [moved] = order.splice(from, 1);
  order.splice(clamped, 0, moved!);
  return { order };
}

/** Reorder rendered panels while leaving unavailable panel slots untouched. */
export function reorderAvailablePanels(
  layout: DashboardLayout,
  id: PanelId,
  toIndex: number,
  available: readonly PanelId[],
): DashboardLayout {
  const positions = layout.order.flatMap((placement, index) =>
    available.includes(placement.id) ? [index] : [],
  );
  const from = positions.findIndex((position) => layout.order[position]?.id === id);
  if (from === -1) return layout;
  const target = Math.min(Math.max(0, Math.trunc(toIndex)), positions.length - 1);
  if (target === from) return layout;

  const visible = positions.map((position) => layout.order[position]!);
  const [moved] = visible.splice(from, 1);
  visible.splice(target, 0, moved!);
  const order = [...layout.order];
  positions.forEach((position, index) => {
    order[position] = visible[index]!;
  });
  return { order };
}

/** Move a panel one slot earlier (or later when `down`). No-op at the ends. */
export function movePanel(
  layout: DashboardLayout,
  id: PanelId,
  direction: "up" | "down",
): DashboardLayout {
  const index = layout.order.findIndex((placement) => placement.id === id);
  if (index === -1) return layout;
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= layout.order.length) return layout;
  return reorderPanel(layout, id, target);
}

/** Collapse or expand a panel, preserving its position. */
export function setCollapsed(
  layout: DashboardLayout,
  id: PanelId,
  collapsed: boolean,
): DashboardLayout {
  return {
    order: layout.order.map((placement) =>
      placement.id === id ? { ...placement, collapsed } : placement,
    ),
  };
}

/** The exact arrangement the reset button restores. */
export function resetLayout(): DashboardLayout {
  return defaultLayout();
}
