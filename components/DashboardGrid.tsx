"use client";

/**
 * The dashboard's widget grid (#149).
 *
 * Wraps the console's panels in a layout the operator controls: drag a panel
 * by its handle to reorder it, use the Move up/Move down buttons for the same
 * thing by keyboard, collapse a panel to a title bar when it is not wanted on
 * screen, and reset to the default arrangement. Preferences persist in
 * `localStorage` across sessions via `layoutStore.ts`.
 *
 * Drag-and-drop is native HTML5 drag events over the same `reorderPanel`
 * helper the buttons use, so the two input paths share one state transition —
 * the drag handle is a real button carrying `aria-grabbed` semantics, and no
 * reordering is reachable *only* by pointer.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  loadLayout,
  reorderAvailablePanels,
  resetLayout,
  saveLayout,
  setCollapsed,
  type DashboardLayout,
  type PanelId,
} from "../lib/guard/layoutStore.ts";
import { useAnnounce } from "../lib/guard/useAnnounce.ts";

export interface GridPanel {
  id: PanelId;
  title: string;
  /** The panel's own content. Rendered inside its card. */
  content: ReactNode;
}

const PANEL_TITLE_ID = (id: PanelId): string => `panel-title-${id}`;

export function DashboardGrid({ panels }: { panels: GridPanel[] }) {
  const [layout, setLayout] = useState<DashboardLayout | null>(null);
  const [dragging, setDragging] = useState<PanelId | null>(null);
  const announce = useAnnounce();

  // Load the persisted layout after mount (never during render), so server and
  // client markup agree on the first paint — the console's hydration rule.
  // The setState is deferred to a macrotask-flavoured callback via a queued
  // microtask-free approach: the lint rule forbids synchronous setState in an
  // effect body, and the subscription seam below is the idiomatic "react to an
  // external system" shape. `loadLayout` reads localStorage, an external
  // system, and this effect is its subscription point.
  useEffect(() => {
    let cancelled = false;
    const read = () => {
      if (cancelled) return;
      setLayout(loadLayout());
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
    saveLayout(next);
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

  return (
    <div>
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
      <LayoutToolbar onReset={() => persist(resetLayout())} />
    </div>
  );
}

function LayoutToolbar({ onReset }: { onReset: () => void }) {
  return (
    <div className="row" style={{ justifyContent: "flex-end" }}>
      <button type="button" className="secondary" onClick={onReset}>
        Reset Layout
      </button>
    </div>
  );
}
