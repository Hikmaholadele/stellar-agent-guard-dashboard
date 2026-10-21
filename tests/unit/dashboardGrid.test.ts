import assert from "node:assert/strict";
import { test, before, afterEach } from "node:test";
import { installDom, loadReact, type Act } from "./domHarness.ts";
import { DashboardGrid, type GridPanel } from "../../components/DashboardGrid.tsx";
import { clearAnnouncements, pendingAnnouncements } from "../../lib/guard/useAnnounce.ts";
import {
  DEFAULT_LAYOUT,
  LAYOUT_STORAGE_KEY,
  defaultLayout,
  loadLayout,
  movePanel,
  reorderAvailablePanels,
  normalizeLayout,
  reorderPanel,
  resetLayout,
  saveLayout,
  setCollapsed,
  type DashboardLayout,
  type PanelId,
  type StorageLike,
} from "../../lib/guard/layoutStore.ts";

let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: Act;
let root: ReturnType<typeof createRoot> | null = null;

before(async () => {
  installDom();
  const loaded = await loadReact();
  React = loaded.react;
  createRoot = loaded.createRoot;
  act = loaded.act;
});

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.innerHTML = "";
  localStorage.clear();
});

function fakeStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

function ids(layout: DashboardLayout): PanelId[] {
  return layout.order.map((placement) => placement.id);
}

function placement(layout: DashboardLayout, id: PanelId) {
  return layout.order.find((entry) => entry.id === id)!;
}

test("the default layout lists every known panel, expanded", () => {
  const layout = defaultLayout();
  assert.deepEqual(ids(layout), [...DEFAULT_LAYOUT]);
  assert.ok(layout.order.every((entry) => entry.collapsed === false));
});

test("a saved layout round-trips through storage", () => {
  const storage = fakeStorage();
  const layout = setCollapsed(defaultLayout(), "panic", true);
  saveLayout(layout, storage);
  const loaded = loadLayout(storage);
  assert.equal(placement(loaded, "panic").collapsed, true);
  assert.deepEqual(ids(loaded), ids(layout));
});

test("loadLayout reads from the versioned storage key", () => {
  const storage = fakeStorage();
  storage.data.set(LAYOUT_STORAGE_KEY, JSON.stringify([{ id: "telemetry", collapsed: false }]));
  const loaded = loadLayout(storage);
  assert.equal(loaded.order[0]?.id, "telemetry");
});

test("a corrupted or non-array payload degrades to the default layout", () => {
  const storage = fakeStorage();
  storage.data.set(LAYOUT_STORAGE_KEY, "{not json");
  assert.deepEqual(ids(loadLayout(storage)), [...DEFAULT_LAYOUT]);
  storage.data.set(LAYOUT_STORAGE_KEY, JSON.stringify({ not: "an array" }));
  assert.deepEqual(ids(loadLayout(storage)), [...DEFAULT_LAYOUT]);
});

test("an unknown panel id in storage is dropped, not rendered", () => {
  const stored = [
    { id: "telemetry", collapsed: false },
    { id: "status", collapsed: false },
  ];
  const layout = normalizeLayout(stored);
  assert.equal(ids(layout).includes("telemetry" as PanelId), true);
  assert.equal(ids(layout).includes("nuclear_launch" as PanelId), false);
});

test("a panel missing from stored order is appended so an upgrade never hides it", () => {
  // A stored layout from before the multisig panel existed.
  const stored = [
    { id: "status", collapsed: false },
    { id: "panic", collapsed: true },
  ];
  const layout = normalizeLayout(stored);
  assert.equal(ids(layout).includes("multisig"), true);
  // The stored collapse state is preserved for panels it knows.
  assert.equal(placement(layout, "panic").collapsed, true);
});

test("duplicate stored entries collapse to the first occurrence", () => {
  const stored = [
    { id: "status", collapsed: false },
    { id: "status", collapsed: true },
  ];
  const layout = normalizeLayout(stored);
  assert.equal(layout.order.filter((entry) => entry.id === "status").length, 1);
  assert.equal(placement(layout, "status").collapsed, false, "first occurrence wins");
});

test("reorderPanel moves a panel to a zero-based index, shifting the rest", () => {
  const layout = reorderPanel(defaultLayout(), "telemetry", 0);
  assert.equal(ids(layout)[0], "telemetry");
  assert.equal(ids(layout).length, DEFAULT_LAYOUT.length, "no panel lost");
  // Every panel still present exactly once.
  assert.equal(new Set(ids(layout)).size, layout.order.length);
});

test("reorderPanel clamps out-of-range indices and no-ops when already there", () => {
  // Below zero clamps to the front: "status" is already first, so unchanged.
  assert.deepEqual(ids(reorderPanel(defaultLayout(), "status", -5)), [...DEFAULT_LAYOUT]);
  // Past the end clamps to the back: "status" moves last.
  assert.deepEqual(ids(reorderPanel(defaultLayout(), "status", 99)), [
    "txhistory",
    "panic",
    "telemetry",
    "multisig",
    "xdr",
    "status",
  ]);
  // Already at the target index: no-op.
  assert.deepEqual(ids(reorderPanel(defaultLayout(), "status", 0)), [...DEFAULT_LAYOUT]);
});

test("reordering available panels preserves missing slots and persists through reset", () => {
  const storage = fakeStorage();
  const available: PanelId[] = ["status", "telemetry", "xdr"];
  const moved = reorderAvailablePanels(defaultLayout(), "telemetry", 0, available);
  assert.deepEqual(ids(moved), ["telemetry", "txhistory", "panic", "status", "multisig", "xdr"]);
  saveLayout(moved, storage);
  assert.deepEqual(ids(loadLayout(storage)), ids(moved));
  assert.deepEqual(ids(resetLayout()), [...DEFAULT_LAYOUT]);
  assert.equal(reorderAvailablePanels(moved, "panic", 0, available), moved);
});

test("movePanel steps a panel one slot and refuses to run off the ends", () => {
  const up = movePanel(defaultLayout(), "txhistory", "up");
  assert.deepEqual(ids(up)[0], "txhistory");
  assert.deepEqual(ids(up)[1], "status");

  const down = movePanel(defaultLayout(), "status", "down");
  assert.deepEqual(ids(down)[0], "txhistory");
  assert.deepEqual(ids(down)[1], "status");

  // At the very top, "up" is a no-op; at the very bottom, "down" is.
  assert.deepEqual(ids(movePanel(defaultLayout(), "status", "up")), [...DEFAULT_LAYOUT]);
  assert.deepEqual(ids(movePanel(defaultLayout(), "xdr", "down")), [...DEFAULT_LAYOUT]);
});

test("collapsing preserves position and can be reversed", () => {
  const collapsed = setCollapsed(defaultLayout(), "telemetry", true);
  assert.deepEqual(ids(collapsed), [...DEFAULT_LAYOUT]);
  assert.equal(placement(collapsed, "telemetry").collapsed, true);
  const expanded = setCollapsed(collapsed, "telemetry", false);
  assert.equal(placement(expanded, "telemetry").collapsed, false);
});

test("resetLayout restores the default arrangement regardless of current state", () => {
  const shuffled = setCollapsed(reorderPanel(defaultLayout(), "xdr", 0), "status", true);
  assert.notDeepEqual(ids(shuffled), [...DEFAULT_LAYOUT]);
  assert.deepEqual(ids(resetLayout()), [...DEFAULT_LAYOUT]);
  assert.ok(resetLayout().order.every((entry) => entry.collapsed === false));
});

test("loadLayout with no storage returns the default (server render, private mode)", () => {
  assert.deepEqual(ids(loadLayout(null)), [...DEFAULT_LAYOUT]);
  assert.deepEqual(saveLayout(defaultLayout(), null), undefined);
});

test("keyboard move controls use rendered-panel boundaries and reset persisted order", async () => {
  clearAnnouncements();
  const div = document.createElement("div");
  document.body.appendChild(div);
  root = createRoot(div);
  const panels: GridPanel[] = [
    { id: "status", title: "Status panel", content: React.createElement("p", null, "status") },
    {
      id: "telemetry",
      title: "Telemetry panel",
      content: React.createElement("p", null, "telemetry"),
    },
  ];
  await act(() => {
    root!.render(React.createElement(DashboardGrid, { panels }));
  });
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });

  const statusMoveUp = div.querySelector(
    'button[aria-label="Move Status panel earlier"]',
  ) as HTMLButtonElement;
  const telemetryMoveDown = div.querySelector(
    'button[aria-label="Move Telemetry panel later"]',
  ) as HTMLButtonElement;
  assert.equal(statusMoveUp.disabled, true);
  assert.equal(telemetryMoveDown.disabled, true);

  const statusMoveDown = div.querySelector(
    'button[aria-label="Move Status panel later"]',
  ) as HTMLButtonElement;
  await act(() => statusMoveDown.click());
  assert.ok(div.querySelector("section:nth-child(1) h2")?.textContent?.includes("Telemetry panel"));
  assert.ok(
    pendingAnnouncements().some((item) => item.message === "Status panel moved to position 2 of 2"),
  );
  const stored = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? "[]") as { id: PanelId }[];
  assert.deepEqual(
    stored.map((placement) => placement.id),
    ["telemetry", "txhistory", "panic", "status", "multisig", "xdr"],
  );

  const resetButton = [...div.querySelectorAll("button")].find(
    (button) => button.textContent === "Reset Layout",
  );
  assert.ok(resetButton);
  await act(() => resetButton.click());
  const resetOrder = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? "[]") as {
    id: PanelId;
  }[];
  assert.deepEqual(
    resetOrder.map((placement) => placement.id),
    [...DEFAULT_LAYOUT],
  );
});
