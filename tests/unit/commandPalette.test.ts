import assert from "node:assert/strict";
import { test, before, afterEach } from "node:test";
import { installDom, loadReact, Act as _act, sleep } from "./domHarness.ts";
import { fuzzyMatch } from "../../lib/guard/commands.ts";
import { CommandPaletteInner } from "../../components/CommandPalette.tsx";
import { clearAnnouncements, pendingAnnouncements } from "../../lib/guard/useAnnounce.ts";

let dom: ReturnType<typeof installDom>;
let React: Awaited<ReturnType<typeof loadReact>>["react"];
let createRoot: Awaited<ReturnType<typeof loadReact>>["createRoot"];
let act: _act;
let root: ReturnType<typeof createRoot> | null = null;

let selectGuardCalledWith = "";

before(async () => {
  dom = installDom();
  const reactDeps = await loadReact();
  React = reactDeps.react;
  createRoot = reactDeps.createRoot;
  act = reactDeps.act;
});

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  document.body.innerHTML = "";
  selectGuardCalledWith = "";
});

test("fuzzyMatch works correctly", () => {
  assert.equal(fuzzyMatch("nav", "Go to Navigation"), true);
  assert.equal(fuzzyMatch("cmd", "Command"), true);
  assert.equal(fuzzyMatch("xyz", "Command"), false);
});

test("opens on Cmd+K, filters commands, and dispatches action on Enter", async () => {
  const div = document.createElement("div");
  document.body.appendChild(div);
  root = createRoot(div);

  const mockRouter = { push: () => {} };
  const mockInstances = [{ guard: "GABC...", label: "My Guard" }];

  await act(() => {
    root!.render(
      React.createElement(CommandPaletteInner, {
        router: mockRouter,
        guard: "GBM...",
        instances: mockInstances,
        selectGuard: (a: string) => {
          selectGuardCalledWith = a;
        },
      }),
    );
  });

  await act(() => {
    const event = new window.KeyboardEvent("keydown", { key: "k", metaKey: true });
    document.dispatchEvent(event);
  });

  const input = div.querySelector('input[role="combobox"]') as HTMLInputElement;
  assert.ok(input);
  assert.equal(input.getAttribute("aria-label"), "Search commands");
  assert.equal(input.getAttribute("aria-haspopup"), "listbox");

  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(() => {
    nativeInputValueSetter?.call(input, "Switch to My");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });

  await act(() => {
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  const activeId = input.getAttribute("aria-activedescendant");
  assert.ok(activeId);
  assert.equal(document.getElementById(activeId)?.getAttribute("role"), "option");
  assert.equal(document.getElementById(activeId)?.getAttribute("aria-selected"), "true");

  await act(() => {
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });

  assert.equal(selectGuardCalledWith, "GABC...");
  assert.equal(div.querySelector('[role="combobox"]'), null, "selection closes the palette");
});

test("empty results are announced and arrow keys and Escape remain safe", async () => {
  clearAnnouncements();
  const div = document.createElement("div");
  document.body.appendChild(div);
  root = createRoot(div);

  await act(() => {
    root!.render(
      React.createElement(CommandPaletteInner, {
        router: { push: () => {} },
        guard: null,
        instances: [],
        selectGuard: () => {},
      }),
    );
  });
  await act(() => {
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
  });

  const input = div.querySelector('input[role="combobox"]') as HTMLInputElement;
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(() => {
    nativeInputValueSetter?.call(input, "no-such-command");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });

  assert.equal(
    div.querySelector('[role="listbox"]')?.getAttribute("aria-label"),
    "Command results",
  );
  assert.ok(div.querySelector('[role="listbox"]')?.textContent?.includes("No commands found"));
  assert.equal(input.hasAttribute("aria-activedescendant"), false);
  await act(async () => {
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    await sleep(350);
  });
  assert.ok(pendingAnnouncements().some((item) => item.message === "No commands found"));

  await act(() => {
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  assert.equal(div.querySelector('[role="combobox"]'), null, "Escape closes the palette");
});
