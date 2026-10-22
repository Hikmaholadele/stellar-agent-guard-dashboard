/**
 * Dashboard layout preferences, persisted in `localStorage` (#149, #378).
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
 *
 * Named layouts (#378): operators can save a small number of named panel
 * arrangements and switch between them. Layouts are local presentation
 * preferences only; they never affect guard or chain state.
 */

import {
  decodeVersionedRecord,
  encodeVersionedRecord,
  writeStoredValue,
  type StorageOutcome,
} from "./versionedStorage.ts";

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
export const LAYOUT_SCHEMA = "stellar-agent-guard/dashboard-layout";
export const LAYOUT_VERSION = 1;

/** Maximum number of named layouts an operator can save. */
export const MAX_NAMED_LAYOUTS = 10;

/** Maximum length of a layout name. */
export const MAX_LAYOUT_NAME_LENGTH = 50;

/** Storage key for named layouts. */
export const NAMED_LAYOUTS_STORAGE_KEY = "stellar-agent-guard-dashboard.namedLayouts.v1";

/** A named layout: a name and the panel arrangement. */
export interface NamedLayout {
  name: string;
  layout: DashboardLayout;
}

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
    const decoded = decodeVersionedRecord({
      raw,
      schema: LAYOUT_SCHEMA,
      version: LAYOUT_VERSION,
      migrations: {
        0: (value) => {
          if (
            !Array.isArray(value) ||
            value.length === 0 ||
            !value.every(
              (entry) =>
                typeof entry === "object" &&
                entry !== null &&
                typeof (entry as { id?: unknown }).id === "string" &&
                typeof (entry as { collapsed?: unknown }).collapsed === "boolean",
            )
          ) {
            throw new Error("Invalid legacy layout");
          }
          return normalizeLayout(value);
        },
      },
      validate: (value): value is DashboardLayout =>
        typeof value === "object" &&
        value !== null &&
        Array.isArray((value as DashboardLayout).order) &&
        (value as DashboardLayout).order.every(isPlacement),
    });
    if (!decoded.ok) return defaultLayout();
    if (decoded.needsMigration) {
      writeStoredValue(
        storage,
        LAYOUT_STORAGE_KEY,
        encodeVersionedRecord(LAYOUT_SCHEMA, LAYOUT_VERSION, decoded.value),
      );
    }
    return normalizeLayout(decoded.value.order);
  } catch {
    return defaultLayout();
  }
}

/** Persist the layout. A private-mode write failure is not worth surfacing. */
export function saveLayout(
  layout: DashboardLayout,
  storage: StorageLike | null = defaultStorage(),
): StorageOutcome<void> {
  return writeStoredValue(
    storage,
    LAYOUT_STORAGE_KEY,
    encodeVersionedRecord(LAYOUT_SCHEMA, LAYOUT_VERSION, normalizeLayout(layout.order)),
  );
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

// ── Named layouts (#378) ──────────────────────────────────────────────────────

function normalizeLayoutName(name: string): string {
  return name.trim().slice(0, MAX_LAYOUT_NAME_LENGTH);
}

function isValidLayoutName(name: string): boolean {
  const normalized = normalizeLayoutName(name);
  return normalized.length > 0;
}

function loadNamedLayoutsRaw(storage: StorageLike | null): NamedLayout[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(NAMED_LAYOUTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: NamedLayout[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) continue;
      const candidate = entry as Partial<NamedLayout>;
      if (
        typeof candidate.name !== "string" ||
        !isValidLayoutName(candidate.name) ||
        typeof candidate.layout !== "object" ||
        candidate.layout === null
      )
        continue;
      const normalizedLayout = normalizeLayout(candidate.layout.order);
      out.push({ name: normalizeLayoutName(candidate.name), layout: normalizedLayout });
    }
    return out.slice(0, MAX_NAMED_LAYOUTS);
  } catch {
    return [];
  }
}

function saveNamedLayoutsRaw(layouts: NamedLayout[], storage: StorageLike | null): void {
  if (!storage) return;
  try {
    storage.setItem(NAMED_LAYOUTS_STORAGE_KEY, JSON.stringify(layouts));
  } catch {
    // Private mode or quota: the layouts stay in memory for this session.
  }
}

/** Load all saved named layouts. */
export function loadNamedLayouts(storage: StorageLike | null = defaultStorage()): NamedLayout[] {
  return loadNamedLayoutsRaw(storage);
}

/** Save a named layout, enforcing the cap and name length. */
export function saveNamedLayout(
  name: string,
  layout: DashboardLayout,
  storage: StorageLike | null = defaultStorage(),
): { ok: true; layout: NamedLayout } | { ok: false; error: string } {
  const trimmedName = name.trim();
  if (trimmedName.length === 0) {
    return { ok: false, error: "Layout name cannot be empty." };
  }
  if (trimmedName.length > MAX_LAYOUT_NAME_LENGTH) {
    return { ok: false, error: `Layout name cannot exceed ${MAX_LAYOUT_NAME_LENGTH} characters.` };
  }
  const normalizedName = normalizeLayoutName(name);
  if (!isValidLayoutName(normalizedName)) {
    return { ok: false, error: "Layout name cannot be empty." };
  }
  const layouts = loadNamedLayoutsRaw(storage);
  if (layouts.length >= MAX_NAMED_LAYOUTS) {
    return { ok: false, error: `Maximum of ${MAX_NAMED_LAYOUTS} named layouts reached.` };
  }
  const normalizedLayout = normalizeLayout(layout.order);
  const existingIndex = layouts.findIndex(
    (l) => l.name.toLowerCase() === normalizedName.toLowerCase(),
  );
  // Preserve original casing when updating an existing layout
  const nameToUse = existingIndex >= 0 ? layouts[existingIndex]!.name : normalizedName;
  const namedLayout: NamedLayout = { name: nameToUse, layout: normalizedLayout };
  if (existingIndex >= 0) {
    layouts[existingIndex] = namedLayout;
  } else {
    layouts.push(namedLayout);
  }
  saveNamedLayoutsRaw(layouts, storage);
  return { ok: true, layout: namedLayout };
}

/** Rename a saved named layout. */
export function renameNamedLayout(
  oldName: string,
  newName: string,
  storage: StorageLike | null = defaultStorage(),
): { ok: true; layout: NamedLayout } | { ok: false; error: string } {
  const normalizedOld = normalizeLayoutName(oldName);
  const normalizedNew = normalizeLayoutName(newName);
  if (!isValidLayoutName(normalizedOld) || !isValidLayoutName(normalizedNew)) {
    return { ok: false, error: "Layout name cannot be empty." };
  }
  if (normalizedNew.length > MAX_LAYOUT_NAME_LENGTH) {
    return { ok: false, error: `Layout name cannot exceed ${MAX_LAYOUT_NAME_LENGTH} characters.` };
  }
  const layouts = loadNamedLayoutsRaw(storage);
  const index = layouts.findIndex((l) => l.name.toLowerCase() === normalizedOld.toLowerCase());
  if (index === -1) {
    return { ok: false, error: "Layout not found." };
  }
  if (layouts.some((l, i) => i !== index && l.name.toLowerCase() === normalizedNew.toLowerCase())) {
    return { ok: false, error: "A layout with that name already exists." };
  }
  layouts[index] = { ...layouts[index]!, name: normalizedNew };
  saveNamedLayoutsRaw(layouts, storage);
  return { ok: true, layout: layouts[index]! };
}

/** Delete a saved named layout. */
export function deleteNamedLayout(
  name: string,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  const normalized = normalizeLayoutName(name);
  const layouts = loadNamedLayoutsRaw(storage);
  const index = layouts.findIndex((l) => l.name.toLowerCase() === normalized.toLowerCase());
  if (index === -1) return false;
  layouts.splice(index, 1);
  saveNamedLayoutsRaw(layouts, storage);
  return true;
}

/** Get a specific named layout by name. */
export function getNamedLayout(
  name: string,
  storage: StorageLike | null = defaultStorage(),
): NamedLayout | null {
  const normalized = normalizeLayoutName(name);
  const layouts = loadNamedLayoutsRaw(storage);
  return layouts.find((l) => l.name.toLowerCase() === normalized.toLowerCase()) ?? null;
}
