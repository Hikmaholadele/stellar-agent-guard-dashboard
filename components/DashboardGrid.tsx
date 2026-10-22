"use client";

/**
 * The dashboard's widget grid (#149, #378, #379).
 *
 * Wraps the console's panels in a layout the operator controls: drag a panel
 * by its handle to reorder it, use the Move up/Move down buttons for the same
 * thing by keyboard, collapse a panel to a title bar when it is not wanted on
 * screen, and reset to the default arrangement. Preferences persist in
 * `localStorage` across sessions via `layoutStore.ts`.
 *
 * Drag-and-drop is native HTML5 drag events over the same
 * `reorderAvailablePanels` helper the buttons use, so the two input paths share
 * one state transition — the drag handle is a real button carrying
 * `aria-grabbed` semantics, and no reordering is reachable *only* by pointer.
 *
 * Named layouts (#378): operators can save a small number of named panel
 * arrangements and switch between them. Layouts are local presentation
 * preferences only; they never affect guard or chain state.
 *
 * Reset preview (#379): shows which panels will move, be restored, or change
 * collapse state before resetting a customized dashboard layout, with a cancel
 * path that leaves the current arrangement intact.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  loadLayout,
  reorderAvailablePanels,
  resetLayout,
  saveLayout,
  setCollapsed,
  // Named layouts (#378)
  loadNamedLayouts,
  saveNamedLayout,
  renameNamedLayout,
  deleteNamedLayout,
  MAX_NAMED_LAYOUTS,
  MAX_LAYOUT_NAME_LENGTH,
  type DashboardLayout,
  type NamedLayout,
  type PanelId,
} from "../lib/guard/layoutStore.ts";
import { storageErrorMessage } from "../lib/guard/versionedStorage.ts";
import { useAnnounce } from "../lib/guard/useAnnounce.ts";
import { useModalFocus } from "../lib/guard/useModalFocus.ts";

export interface GridPanel {
  id: PanelId;
  title: string;
  /** The panel's own content. Rendered inside its card. */
  content: ReactNode;
}

const PANEL_TITLE_ID = (id: PanelId): string => `panel-title-${id}`;

/** What a reset will change, relative to the arrangement on screen (#379). */
export interface ResetPreview {
  /** Panels whose position in the default arrangement differs. */
  moved: PanelId[];
  /** Default panels the current arrangement is missing. */
  restored: PanelId[];
  /** Current panels the default arrangement does not contain. */
  hidden: PanelId[];
  /** Panels whose collapsed state the reset flips. */
  collapsed: PanelId[];
}

/**
 * Compare the current arrangement with the one a reset would restore.
 *
 * Positions are compared among the panels both arrangements share, so a stale
 * entry the grid does not render is reported as hidden/harmless rather than
 * making every panel look moved. Pure so the preview is unit-testable without
 * a DOM.
 */
export function describeResetPreview(
  current: DashboardLayout,
  target: DashboardLayout,
): ResetPreview {
  const currentIds = current.order.map((placement) => placement.id);
  const targetIds = target.order.map((placement) => placement.id);
  const shared = targetIds.filter((id) => currentIds.includes(id));
  const currentShared = currentIds.filter((id) => targetIds.includes(id));

  const moved = shared.filter((id, index) => currentShared[index] !== id);
  const restored = targetIds.filter((id) => !currentIds.includes(id));
  const hidden = currentIds.filter((id) => !targetIds.includes(id));

  const currentCollapsed = new Map(
    current.order.map((placement) => [placement.id, placement.collapsed]),
  );
  const collapsed = shared.filter(
    (id) => currentCollapsed.get(id) !== target.order.find((entry) => entry.id === id)?.collapsed,
  );

  return { moved, restored, hidden, collapsed };
}

function hasResetChanges(preview: ResetPreview): boolean {
  return (
    preview.moved.length > 0 ||
    preview.restored.length > 0 ||
    preview.hidden.length > 0 ||
    preview.collapsed.length > 0
  );
}

export function DashboardGrid({ panels }: { panels: GridPanel[] }) {
  const [layout, setLayout] = useState<DashboardLayout | null>(null);
  const [dragging, setDragging] = useState<PanelId | null>(null);
  const [saveWarning, setSaveWarning] = useState<string | null>(null);
  // Named layouts (#378). Initialised empty, never from storage during render:
  // the server has no localStorage, so reading it in the initialiser would
  // make the first client render disagree with the server markup.
  const [namedLayouts, setNamedLayouts] = useState<NamedLayout[]>([]);
  const [activeLayoutName, setActiveLayoutName] = useState<string | null>(null);
  // Reset preview (#379)
  const [resetPreview, setResetPreview] = useState<DashboardLayout | null>(null);
  const announce = useAnnounce();

  // Load the persisted layout and named layouts after mount (never during
  // render), so server and client markup agree on the first paint — the
  // console's hydration rule. The setState is deferred to a
  // macrotask-flavoured callback via a queued microtask-free approach: the lint
  // rule forbids synchronous setState in an effect body, and the subscription
  // seam below is the idiomatic "react to an external system" shape.
  // `loadLayout` reads localStorage, an external system, and this effect is its
  // subscription point.
  useEffect(() => {
    let cancelled = false;
    const read = () => {
      if (cancelled) return;
      setLayout(loadLayout());
      setNamedLayouts(loadNamedLayouts());
    };
    // `requestAnimationFrame` defers past the effect body; jsdom's
    // `pretendToBeVisual` provides it in tests too.
    const frame = requestAnimationFrame(read);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, []);

  const persist = (next: DashboardLayout) => {
    setLayout(next);
    const result = saveLayout(next);
    setSaveWarning(result.ok ? null : storageErrorMessage(result.error));
  };

  const exportLayout = () => {
    if (layout === null) return;
    const blob = new Blob([JSON.stringify(layout, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "dashboard-layout-backup.json";
    link.click();
    URL.revokeObjectURL(url);
  };

  const byId = useMemo(() => new Map(panels.map((panel) => [panel.id, panel])), [panels]);
  const availableIds = panels.map((panel) => panel.id);

  if (layout === null) {
    // First paint: the default order, no interaction, so hydration matches.
    return (
      <div>
        {panels.map((panel) => (
          <section key={panel.id} className="panel" aria-labelledby={PANEL_TITLE_ID(panel.id)}>
            <h2 style={{ margin: 0 }} id={PANEL_TITLE_ID(panel.id)}>
              {panel.title}
            </h2>
            {panel.content}
          </section>
        ))}
      </div>
    );
  }

  const move = (id: PanelId, direction: "up" | "down") => {
    const visible = layout.order.filter((placement) => byId.has(placement.id));
    const index = visible.findIndex((placement) => placement.id === id);
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= visible.length) return;
    const next = reorderAvailablePanels(layout, id, target, availableIds);
    if (next === layout) return;
    persist(next);
    const panel = byId.get(id);
    announce(`${panel?.title ?? id} moved to position ${target + 1} of ${visible.length}`);
  };

  const dropOn = (targetId: PanelId) => {
    if (dragging === null || dragging === targetId) return;
    const visible = layout.order.filter((placement) => byId.has(placement.id));
    const toIndex = visible.findIndex((placement) => placement.id === targetId);
    const next = reorderAvailablePanels(layout, dragging, toIndex, availableIds);
    if (next !== layout) {
      persist(next);
      announce(
        `${byId.get(dragging)?.title ?? dragging} moved to position ${toIndex + 1} of ${visible.length}`,
      );
    }
    setDragging(null);
  };

  // ── Named layouts (#378) ────────────────────────────────────────────────

  const handleSaveLayout = (name: string) => {
    const result = saveNamedLayout(name, layout);
    if (!result.ok) {
      announce(`Failed to save layout: ${result.error}`);
      return;
    }
    setNamedLayouts(loadNamedLayouts());
    setActiveLayoutName(result.layout.name);
    announce(`Layout "${result.layout.name}" saved`);
  };

  const handleUpdateLayout = () => {
    if (activeLayoutName === null) return;
    const result = saveNamedLayout(activeLayoutName, layout);
    if (!result.ok) {
      announce(`Failed to update layout: ${result.error}`);
      return;
    }
    setNamedLayouts(loadNamedLayouts());
    announce(`Layout "${result.layout.name}" updated`);
  };

  const handleLoadNamedLayout = (namedLayout: NamedLayout) => {
    persist(namedLayout.layout);
    setActiveLayoutName(namedLayout.name);
    announce(`Layout "${namedLayout.name}" loaded`);
  };

  const handleRenameLayout = (newName: string) => {
    if (activeLayoutName === null) return;
    const result = renameNamedLayout(activeLayoutName, newName);
    if (!result.ok) {
      announce(`Failed to rename layout: ${result.error}`);
      return;
    }
    setNamedLayouts(loadNamedLayouts());
    setActiveLayoutName(result.layout.name);
    announce(`Layout renamed to "${result.layout.name}"`);
  };

  const handleDeleteLayout = () => {
    if (activeLayoutName === null) return;
    const name = activeLayoutName;
    if (!deleteNamedLayout(name)) return;
    setNamedLayouts(loadNamedLayouts());
    setActiveLayoutName(null);
    announce(`Layout "${name}" deleted`);
  };

  const handleSelectLayout = (name: string) => {
    if (name === "") {
      // Selecting "Default" is a reset; preview it like the Reset button does.
      handleResetPreview();
      return;
    }
    const namedLayout = namedLayouts.find((entry) => entry.name === name);
    if (namedLayout) handleLoadNamedLayout(namedLayout);
  };

  // ── Reset preview (#379) ────────────────────────────────────────────────

  const handleResetPreview = () => {
    setResetPreview(resetLayout());
  };

  const handleConfirmReset = () => {
    if (resetPreview === null) return;
    persist(resetPreview);
    setActiveLayoutName(null);
    setResetPreview(null);
    announce("Layout reset to default");
  };

  const handleCancelReset = () => {
    setResetPreview(null);
  };

  const preview = resetPreview === null ? null : describeResetPreview(layout, resetPreview);

  return (
    <div>
      {saveWarning !== null && (
        <div role="alert" className="tiny" data-testid="layout-save-warning">
          {saveWarning}
          <button type="button" className="secondary" onClick={exportLayout}>
            Download layout backup
          </button>
        </div>
      )}
      {layout.order
        .filter((placement) => byId.has(placement.id))
        .map((placement, index, visible) => {
          const panel = byId.get(placement.id)!;
          return (
            <section
              key={placement.id}
              className="panel"
              aria-labelledby={PANEL_TITLE_ID(placement.id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => dropOn(placement.id)}
            >
              <div
                className="row"
                style={{
                  justifyContent: "space-between",
                  marginBottom: placement.collapsed ? 0 : 8,
                }}
              >
                <div className="row" style={{ gap: 6 }}>
                  <button
                    type="button"
                    className="secondary"
                    style={{ cursor: "grab", padding: "4px 8px" }}
                    draggable
                    onDragStart={() => setDragging(placement.id)}
                    onDragEnd={() => setDragging(null)}
                    aria-label={`Drag handle: ${panel.title}. Position ${index + 1} of ${layout.order.length}`}
                    aria-grabbed={dragging === placement.id}
                    title="Drag to reorder"
                  >
                    ⠿
                  </button>
                  <h2 style={{ margin: 0 }} id={PANEL_TITLE_ID(placement.id)}>
                    {panel.title}
                  </h2>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => move(placement.id, "up")}
                    disabled={index === 0}
                    aria-label={`Move ${panel.title} earlier`}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => move(placement.id, "down")}
                    disabled={index === visible.length - 1}
                    aria-label={`Move ${panel.title} later`}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      const collapsed = !placement.collapsed;
                      persist(setCollapsed(layout, placement.id, collapsed));
                      announce(`${panel.title} ${collapsed ? "collapsed" : "expanded"}`);
                    }}
                    aria-expanded={!placement.collapsed}
                    aria-controls={`panel-body-${placement.id}`}
                  >
                    {placement.collapsed ? "Expand" : "Collapse"}
                  </button>
                </div>
              </div>
              {placement.collapsed ? null : (
                <div id={`panel-body-${placement.id}`}>{panel.content}</div>
              )}
            </section>
          );
        })}
      <LayoutToolbar
        namedLayouts={namedLayouts}
        activeLayoutName={activeLayoutName}
        onSelectLayout={handleSelectLayout}
        onSaveLayout={handleSaveLayout}
        onUpdateLayout={handleUpdateLayout}
        onRenameLayout={handleRenameLayout}
        onDeleteLayout={handleDeleteLayout}
        onResetPreview={handleResetPreview}
      />
      {preview !== null && (
        <ResetPreviewDialog
          preview={preview}
          onCancel={handleCancelReset}
          onConfirm={handleConfirmReset}
        />
      )}
    </div>
  );
}

function LayoutToolbar({
  namedLayouts,
  activeLayoutName,
  onSelectLayout,
  onSaveLayout,
  onUpdateLayout,
  onRenameLayout,
  onDeleteLayout,
  onResetPreview,
}: {
  namedLayouts: NamedLayout[];
  activeLayoutName: string | null;
  onSelectLayout: (name: string) => void;
  onSaveLayout: (name: string) => void;
  onUpdateLayout: () => void;
  onRenameLayout: (name: string) => void;
  onDeleteLayout: () => void;
  onResetPreview: () => void;
}) {
  const [dialog, setDialog] = useState<"save" | "rename" | null>(null);
  const canSaveNew = namedLayouts.length < MAX_NAMED_LAYOUTS;

  return (
    <div
      className="row"
      style={{ justifyContent: "flex-end", gap: 8, flexWrap: "wrap", marginTop: 16 }}
      data-testid="layout-toolbar"
    >
      {namedLayouts.length > 0 && (
        <div className="row" style={{ gap: 6, alignItems: "center" }}>
          <label style={{ fontSize: 12, color: "var(--muted)" }} htmlFor="layout-select">
            Layout:
          </label>
          <select
            id="layout-select"
            value={activeLayoutName ?? ""}
            onChange={(event) => onSelectLayout(event.target.value)}
            style={{ minWidth: 180, padding: "4px 8px" }}
          >
            <option value="">— Default —</option>
            {namedLayouts.map((namedLayout) => (
              <option key={namedLayout.name} value={namedLayout.name}>
                {namedLayout.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <button
        type="button"
        className="secondary"
        onClick={() => setDialog("save")}
        disabled={!canSaveNew}
        title={
          canSaveNew
            ? undefined
            : `Maximum of ${MAX_NAMED_LAYOUTS} named layouts reached; delete one to save another`
        }
      >
        Save Layout
      </button>

      {activeLayoutName !== null && (
        <>
          <button type="button" className="secondary" onClick={onUpdateLayout}>
            Update Layout
          </button>
          <button type="button" className="secondary" onClick={() => setDialog("rename")}>
            Rename Layout
          </button>
          <button type="button" className="secondary" onClick={onDeleteLayout}>
            Delete Layout
          </button>
        </>
      )}

      <button type="button" className="secondary" onClick={onResetPreview}>
        Reset Layout
      </button>

      {dialog === "save" && (
        <NameLayoutDialog
          title="Save Layout"
          description={`Enter a name for this panel arrangement. Maximum ${MAX_LAYOUT_NAME_LENGTH} characters.`}
          confirmLabel="Save"
          initialName=""
          onCancel={() => setDialog(null)}
          onConfirm={(name) => {
            setDialog(null);
            onSaveLayout(name);
          }}
        />
      )}

      {dialog === "rename" && activeLayoutName !== null && (
        <NameLayoutDialog
          title="Rename Layout"
          description={`Enter a new name for “${activeLayoutName}”. Maximum ${MAX_LAYOUT_NAME_LENGTH} characters.`}
          confirmLabel="Rename"
          initialName={activeLayoutName}
          onCancel={() => setDialog(null)}
          onConfirm={(name) => {
            setDialog(null);
            onRenameLayout(name);
          }}
        />
      )}
    </div>
  );
}

/**
 * The shared modal frame: focus moves in on open, Tab is trapped, Escape
 * dismisses, and focus returns to the trigger on close (see
 * `useModalFocus.ts`). The dialog is rendered in place rather than through a
 * portal so its markup stays inside the grid's DOM subtree for tests.
 */
function ModalDialog({
  role = "dialog",
  titleId,
  onClose,
  children,
}: {
  role?: "dialog" | "alertdialog";
  titleId: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Capture the trigger before the focus trap moves focus into the dialog.
  // Declared first so it runs before `useModalFocus`'s effect.
  useEffect(() => {
    returnFocusRef.current = (document.activeElement as HTMLElement | null) ?? null;
  }, []);

  useModalFocus({
    open: true,
    containerRef,
    returnFocusRef,
    onDismiss: onClose,
  });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={containerRef}
        className="modal"
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function NameLayoutDialog({
  title,
  description,
  confirmLabel,
  initialName,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  initialName: string;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  const [name, setName] = useState(initialName);
  const titleId = "layout-name-dialog-title";
  const valid = name.trim().length > 0;

  return (
    <ModalDialog titleId={titleId} onClose={onCancel}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) onConfirm(name.trim());
        }}
      >
        <strong id={titleId}>{title}</strong>
        <p className="tiny muted">{description}</p>
        <label className="field" style={{ marginTop: 12 }}>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="My Layout"
            maxLength={MAX_LAYOUT_NAME_LENGTH}
            aria-label="Layout name"
            autoFocus
          />
        </label>
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" disabled={!valid}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}

function ResetPreviewDialog({
  preview,
  onCancel,
  onConfirm,
}: {
  preview: ResetPreview;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = "reset-preview-title";
  const changed = hasResetChanges(preview);

  const sections: { label: string; ids: PanelId[] }[] = [
    { label: "Panels moved:", ids: preview.moved },
    { label: "Panels restored:", ids: preview.restored },
    { label: "Panels hidden (not in the default layout):", ids: preview.hidden },
    { label: "Panels whose collapsed state changes:", ids: preview.collapsed },
  ];

  return (
    <ModalDialog role="alertdialog" titleId={titleId} onClose={onCancel}>
      <strong id={titleId}>Reset Layout Preview</strong>
      <p className="tiny muted">
        This will restore the default panel arrangement. The following changes will occur:
      </p>
      {changed ? (
        sections
          .filter((section) => section.ids.length > 0)
          .map((section) => (
            <div key={section.label} style={{ marginTop: 8 }}>
              <strong className="tiny">{section.label}</strong>
              <ul className="tiny" style={{ margin: "4px 0 0 18px" }}>
                {section.ids.map((id) => (
                  <li key={id}>{id}</li>
                ))}
              </ul>
            </div>
          ))
      ) : (
        <p className="tiny muted" style={{ marginTop: 8 }}>
          The layout is already at the default arrangement.
        </p>
      )}
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="danger" onClick={onConfirm} disabled={!changed}>
          Confirm Reset
        </button>
      </div>
    </ModalDialog>
  );
}
