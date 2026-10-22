import assert from "node:assert/strict";
import { test, before, afterEach } from "node:test";
import { installDom, loadReact, type Act } from "./domHarness.ts";
import {
  DashboardGrid,
  describeResetPreview,
  type GridPanel,
} from "../../components/DashboardGrid.tsx";
import { clearAnnouncements, pendingAnnouncements } from "../../lib/guard/useAnnounce.ts";
import {
  DEFAULT_LAYOUT,
  LAYOUT_STORAGE_KEY,
  NAMED_LAYOUTS_STORAGE_KEY,
  MAX_NAMED_LAYOUTS,
  MAX_LAYOUT_NAME_LENGTH,
  defaultLayout,
  loadLayout,
  movePanel,
  reorderAvailablePanels,
  normalizeLayout,
  reorderPanel,
  resetLayout,
  saveLayout,
  setCollapsed,
  // Named layouts (#378)
  loadNamedLayouts,
  saveNamedLayout,
  renameNamedLayout,
  deleteNamedLayout,
  getNamedLayout,
  type DashboardLayout,
  type NamedLayout,
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

test("a quota failure is returned while the layout remains available in memory", () => {
  const storage: StorageLike = {
    getItem: () => null,
    setItem: () => {
      throw Object.assign(new Error("full"), { name: "QuotaExceededError" });
    },
  };
  const result = saveLayout(setCollapsed(defaultLayout(), "panic", true), storage);
  assert.deepEqual(result, { ok: false, error: "quota" });
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

test("a partial legacy layout remains unchanged for recovery", () => {
  const storage = fakeStorage();
  const raw = JSON.stringify([{ id: "status", collapsed: false }, { id: "panic" }]);
  storage.data.set(LAYOUT_STORAGE_KEY, raw);
  loadLayout(storage);
  assert.equal(storage.data.get(LAYOUT_STORAGE_KEY), raw);
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
  assert.deepEqual(saveLayout(defaultLayout(), null), { ok: false, error: "unavailable" });
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
  const stored = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? "{}") as {
    data: { order: { id: PanelId }[] };
  };
  assert.deepEqual(
    stored.data.order.map((placement) => placement.id),
    ["telemetry", "txhistory", "panic", "status", "multisig", "xdr"],
  );

  // Reset is previewed first (#379): the click opens a dialog and leaves the
  // arrangement untouched until the operator confirms.
  const resetButton = [...div.querySelectorAll("button")].find(
    (button) => button.textContent === "Reset Layout",
  );
  assert.ok(resetButton);
  await act(() => resetButton.click());
  assert.ok(div.querySelector('[role="alertdialog"]'), "the preview dialog opens");
  const unchanged = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? "{}") as {
    data: { order: { id: PanelId }[] };
  };
  assert.deepEqual(
    unchanged.data.order.map((placement) => placement.id),
    ["telemetry", "txhistory", "panic", "status", "multisig", "xdr"],
    "opening the preview does not reset anything",
  );

  const confirmReset = [...div.querySelectorAll("button")].find(
    (button) => button.textContent === "Confirm Reset",
  ) as HTMLButtonElement;
  assert.ok(confirmReset);
  await act(() => confirmReset.click());
  const resetOrder = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? "{}") as {
    data: { order: { id: PanelId }[] };
  };
  assert.deepEqual(
    resetOrder.data.order.map((placement) => placement.id),
    [...DEFAULT_LAYOUT],
  );
  assert.equal(div.querySelector('[role="alertdialog"]'), null, "the dialog closes");
});

test("cancelling the reset preview leaves the current arrangement intact", async () => {
  clearAnnouncements();
  localStorage.clear();
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

  const moveDown = div.querySelector(
    'button[aria-label="Move Status panel later"]',
  ) as HTMLButtonElement;
  await act(() => moveDown.click());
  const before = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? "{}") as {
    data: { order: { id: PanelId }[] };
  };

  const resetButton = [...div.querySelectorAll("button")].find(
    (button) => button.textContent === "Reset Layout",
  ) as HTMLButtonElement;
  await act(() => resetButton.click());
  assert.ok(div.querySelector('[role="alertdialog"]'), "the preview opens");
  assert.ok(div.textContent?.includes("Panels moved:"), "the preview names what will move");

  const cancel = [...div.querySelectorAll("button")].find(
    (button) => button.textContent === "Cancel",
  ) as HTMLButtonElement;
  await act(() => cancel.click());
  assert.equal(div.querySelector('[role="alertdialog"]'), null);
  const after = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? "{}") as {
    data: { order: { id: PanelId }[] };
  };
  assert.deepEqual(after, before, "cancelling writes nothing");
  assert.ok(div.querySelector("section:nth-child(1) h2")?.textContent?.includes("Telemetry panel"));
});

// ── Reset preview (#379) ────────────────────────────────────────────────

test("reset preview names moved, restored, hidden, and collapse changes", () => {
  const current = setCollapsed(reorderPanel(defaultLayout(), "xdr", 0), "panic", true);
  const preview = describeResetPreview(current, resetLayout());
  assert.ok(preview.moved.includes("xdr"));
  assert.deepEqual(preview.restored, []);
  assert.deepEqual(preview.hidden, []);
  assert.deepEqual(preview.collapsed, ["panic"]);
});

test("reset preview ignores stale entries the grid does not render", () => {
  // A layout missing panels is impossible after normalizeLayout, but the
  // comparison itself must not invent moves for ids only one side knows.
  const current: DashboardLayout = { order: [{ id: "telemetry", collapsed: false }] };
  const target: DashboardLayout = {
    order: [
      { id: "status", collapsed: false },
      { id: "telemetry", collapsed: false },
    ],
  };
  const preview = describeResetPreview(current, target);
  assert.deepEqual(preview.restored, ["status"]);
  assert.deepEqual(preview.moved, []);
  assert.deepEqual(preview.hidden, []);
});

// ── Named layouts (#378) ────────────────────────────────────────────────

test("saveNamedLayout persists a named layout and enforces the cap", () => {
  const storage = fakeStorage();
  const layout = defaultLayout();
  const result = saveNamedLayout("My Layout", layout, storage);
  assert.equal(result.ok, true);
  assert.equal(result.layout.name, "My Layout");
  assert.deepEqual(ids(result.layout.layout), [...DEFAULT_LAYOUT]);

  const loaded = loadNamedLayouts(storage);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.name, "My Layout");
});

test("saveNamedLayout rejects empty names", () => {
  const storage = fakeStorage();
  const result = saveNamedLayout("   ", defaultLayout(), storage);
  assert.equal(result.ok, false);
  assert.equal(result.error, "Layout name cannot be empty.");
});

test("saveNamedLayout enforces maximum name length", () => {
  const storage = fakeStorage();
  const longName = "a".repeat(MAX_LAYOUT_NAME_LENGTH + 1);
  const result = saveNamedLayout(longName, defaultLayout(), storage);
  assert.equal(result.ok, false);
  assert.match(result.error, /cannot exceed/);
});

test("saveNamedLayout enforces maximum number of layouts", () => {
  const storage = fakeStorage();
  for (let i = 0; i < MAX_NAMED_LAYOUTS; i++) {
    const result = saveNamedLayout(`Layout ${i}`, defaultLayout(), storage);
    assert.equal(result.ok, true);
  }
  const result = saveNamedLayout("One Too Many", defaultLayout(), storage);
  assert.equal(result.ok, false);
  assert.match(result.error, /Maximum of/);
});

test("saveNamedLayout updates existing layout with same name (case-insensitive)", () => {
  const storage = fakeStorage();
  const layout1 = setCollapsed(defaultLayout(), "panic", true);
  saveNamedLayout("My Layout", layout1, storage);
  const layout2 = setCollapsed(defaultLayout(), "telemetry", true);
  const result = saveNamedLayout("my layout", layout2, storage); // different case
  assert.equal(result.ok, true);
  const loaded = loadNamedLayouts(storage);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.name, "My Layout"); // Original casing preserved
  assert.equal(placement(loaded[0]!.layout, "telemetry").collapsed, true);
});

test("renameNamedLayout renames a saved layout", () => {
  const storage = fakeStorage();
  saveNamedLayout("Old Name", defaultLayout(), storage);
  const result = renameNamedLayout("Old Name", "New Name", storage);
  assert.equal(result.ok, true);
  assert.equal(result.layout.name, "New Name");
  const loaded = loadNamedLayouts(storage);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.name, "New Name");
});

test("renameNamedLayout rejects duplicate names", () => {
  const storage = fakeStorage();
  saveNamedLayout("Layout A", defaultLayout(), storage);
  saveNamedLayout("Layout B", defaultLayout(), storage);
  const result = renameNamedLayout("Layout A", "Layout B", storage);
  assert.equal(result.ok, false);
  assert.match(result.error, /already exists/);
});

test("deleteNamedLayout removes a saved layout", () => {
  const storage = fakeStorage();
  saveNamedLayout("To Delete", defaultLayout(), storage);
  assert.equal(deleteNamedLayout("To Delete", storage), true);
  assert.equal(loadNamedLayouts(storage).length, 0);
  // Deleting non-existent returns false
  assert.equal(deleteNamedLayout("Not There", storage), false);
});

test("getNamedLayout retrieves a specific layout by name (case-insensitive)", () => {
  const storage = fakeStorage();
  saveNamedLayout("My Layout", defaultLayout(), storage);
  const layout = getNamedLayout("my layout", storage);
  assert.ok(layout);
  assert.equal(layout?.name, "My Layout");
  assert.equal(getNamedLayout("Not There", storage), null);
});

test("named layouts survive load/save round-trip with collapse state", () => {
  const storage = fakeStorage();
  const layout = setCollapsed(reorderPanel(defaultLayout(), "xdr", 0), "status", true);
  saveNamedLayout("Complex Layout", layout, storage);
  const loaded = loadNamedLayouts(storage);
  assert.equal(loaded.length, 1);
  assert.equal(ids(loaded[0]!.layout)[0], "xdr");
  assert.equal(placement(loaded[0]!.layout, "status").collapsed, true);
});

test("corrupted named layouts storage degrades to empty list", () => {
  const storage = fakeStorage();
  storage.data.set(NAMED_LAYOUTS_STORAGE_KEY, "{not json");
  assert.deepEqual(loadNamedLayouts(storage), []);
  storage.data.set(NAMED_LAYOUTS_STORAGE_KEY, JSON.stringify({ not: "an array" }));
  assert.deepEqual(loadNamedLayouts(storage), []);
});

test("invalid entries in named layouts storage are dropped", () => {
  const storage = fakeStorage();
  storage.data.set(
    NAMED_LAYOUTS_STORAGE_KEY,
    JSON.stringify([
      { name: "Valid", layout: { order: [{ id: "status", collapsed: false }] } },
      { name: "", layout: { order: [{ id: "status", collapsed: false }] } }, // empty name
      { name: "Also Valid", layout: "not an object" }, // bad layout
      { name: "Another Valid", layout: { order: [{ id: "telemetry", collapsed: false }] } }, // valid
      { not: "a layout object" }, // completely wrong shape
    ]),
  );
  const loaded = loadNamedLayouts(storage);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0]?.name, "Valid");
  assert.equal(loaded[1]?.name, "Another Valid");
});

test("the toolbar saves, switches, and renames a named layout", async () => {
  clearAnnouncements();
  localStorage.clear();
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

  // Save the current (default) arrangement under a name.
  const saveButton = [...div.querySelectorAll("button")].find(
    (button) => button.textContent === "Save Layout",
  );
  assert.ok(saveButton);
  await act(() => saveButton.click());
  const input = div.querySelector('input[aria-label="Layout name"]') as HTMLInputElement;
  assert.ok(input, "the save dialog opens");
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  await act(() => {
    setValue?.call(input, "Wall monitor");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  const confirmSave = [...div.querySelectorAll("button")].find(
    (button) => button.textContent === "Save",
  ) as HTMLButtonElement;
  await act(() => confirmSave.click());

  const saved = JSON.parse(
    localStorage.getItem(NAMED_LAYOUTS_STORAGE_KEY) ?? "[]",
  ) as NamedLayout[];
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.name, "Wall monitor");
  assert.ok(div.querySelector("#layout-select"), "the saved layout appears in the dropdown");
  assert.ok(pendingAnnouncements().some((item) => item.message === 'Layout "Wall monitor" saved'));

  // Switching layouts goes through the dropdown and persists the choice.
  const select = div.querySelector("#layout-select") as HTMLSelectElement;
  await act(() => {
    select.value = "Wall monitor";
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  assert.ok(pendingAnnouncements().some((item) => item.message === 'Layout "Wall monitor" loaded'));

  // The active layout can be renamed in place.
  const renameButton = [...div.querySelectorAll("button")].find(
    (button) => button.textContent === "Rename Layout",
  );
  assert.ok(renameButton);
  await act(() => renameButton.click());
  const renameInput = div.querySelector('input[aria-label="Layout name"]') as HTMLInputElement;
  await act(() => {
    setValue?.call(renameInput, "NOC wall");
    renameInput.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  const confirmRename = [...div.querySelectorAll("button")].find(
    (button) => button.textContent === "Rename",
  ) as HTMLButtonElement;
  await act(() => confirmRename.click());
  const renamed = JSON.parse(
    localStorage.getItem(NAMED_LAYOUTS_STORAGE_KEY) ?? "[]",
  ) as NamedLayout[];
  assert.equal(renamed[0]?.name, "NOC wall");

  // The delete action clears the active selection.
  const deleteButton = [...div.querySelectorAll("button")].find(
    (button) => button.textContent === "Delete Layout",
  );
  assert.ok(deleteButton);
  await act(() => deleteButton.click());
  assert.equal(loadNamedLayouts().length, 0);
  assert.equal(div.querySelector("#layout-select"), null);
});
