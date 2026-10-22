import assert from "node:assert/strict";
import { test, before, afterEach, describe } from "node:test";
import { installDom, loadReact } from "../unit/domHarness.ts";
import { PanicPanel } from "../../components/PanicPanel.tsx";
import { GuardContext, type GuardContextValue } from "../../components/GuardProvider.tsx";
import type { InvokeResult } from "../../lib/guard/submit.ts";
import { acquireGuardWriteLock } from "../../lib/guard/tabSync.ts";

describe("PanicPanel", () => {
  let dom: ReturnType<typeof installDom>;
  let React: Awaited<ReturnType<typeof loadReact>>["react"];
  let createRoot: Awaited<ReturnType<typeof loadReact>>["createRoot"];
  let act: Awaited<ReturnType<typeof loadReact>>["act"];
  let root: ReturnType<typeof createRoot> | null = null;

  // Mock localStorage for density store
  const localStorageMock = (() => {
    let store: Record<string, string> = {};
    return {
      getItem: (key: string): string | null => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        store = {};
      },
    };
  })();

  before(async () => {
    dom = installDom();
    // Mock localStorage
    Object.defineProperty(window, "localStorage", { value: localStorageMock, writable: true });
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
    localStorageMock.clear();
  });

  function createMockGuardContextValue(overrides: Partial<any> = {}): any {
    const defaults: any = {
      server: {} as any,
      wallet: { address: "GBTEST...", networkPassphrase: "Testnet", network: "Testnet" },
      walletError: null,
      connecting: false,
      connect: async () => {},
      disconnect: () => {},
      signer: () => ({
        sign: async () => ({}),
      }),
      instances: [],
      guard: "test_guard",
      selectGuard: () => {},
      addInstance: () => {},
      snapshot: {
        fetchedAt: Date.now(),
        status: {
          ok: true,
          value: {
            admin_frozen: false,
            heartbeat_expired: false,
            has_policy: true,
            last_heartbeat: 1000n,
            now: 2000n,
          },
        },
      },
      snapshotError: null,
      refreshing: false,
      refresh: async () => {},
      events: [],
      feed: {
        watching: false,
        latestLedger: null,
        error: null,
        lastPolledAt: null,
      },
      startWatching: () => {},
      stopWatching: () => {},
      clearEvents: () => {},
      pushEvents: () => {},
      notifyTabs: () => {},
      session: {
        state: "idle" as const,
        timeoutMs: 0,
        setTimeoutMs: () => {},
        stayConnected: () => {},
      },
    };
    return { ...defaults, ...overrides };
  }

  test("renders in idle state with connected wallet", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    const mockValue = createMockGuardContextValue();

    await act(() => {
      root!.render(
        React.createElement(
          GuardContext.Provider,
          { value: mockValue },
          React.createElement(PanicPanel),
        ),
      );
    });

    // Check that it renders correctly
    assert.dom(document.body).containsText("Emergency");
    assert.dom(document.body).containsText("Freeze this account");
    assert.dom(document.body).containsText("Unfreeze");
    assert.dom(document.body).containsText("Export Unfreeze XDR");
    // Should not show confirmation dialog initially
    assert.dom(document.body).doesNotContainText("Confirm the freeze");
  });

  test("disables freeze and shows the pending operation from another tab", async () => {
    const lease = acquireGuardWriteLock({
      guard: "test_guard",
      action: "freeze",
      network: "Testnet",
    });
    assert.ok(lease);
    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    await act(async () => {
      root!.render(
        React.createElement(
          GuardContext.Provider,
          { value: createMockGuardContextValue() },
          React.createElement(PanicPanel),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const freezeButton = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Freeze pending"),
    );
    assert.ok(freezeButton);
    assert.equal(freezeButton.disabled, true);
    assert.ok(document.body.textContent?.includes("in another dashboard tab."));
    lease.release();
  });

  test("shows confirmation dialog when freeze button clicked", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    const mockValue = createMockGuardContextValue({
      notifyTabs: () => {}, // Mock notifyTabs
      pushEvents: () => {}, // Mock pushEvents
    });

    await act(() => {
      root!.render(
        React.createElement(
          GuardContext.Provider,
          { value: mockValue },
          React.createElement(PanicPanel),
        ),
      );
    });

    // Click the freeze button to trigger confirmation
    const freezeButton = document.querySelector(
      'button:has-text("Freeze this account")',
    ) as HTMLButtonElement | null;
    assert.ok(freezeButton, "Freeze button should exist");
    freezeButton?.click();

    // Wait for state update
    await act(() => {
      return new Promise((resolve) => setTimeout(resolve, 50));
    });

    // Check that confirmation dialog is shown
    assert.dom(document.body).containsText("Confirm the freeze");
    assert.dom(document.body).containsText("I understand this halts the agent's spending");
    assert.dom(document.body).containsText("Sign freeze");
    assert.dom(document.body).containsText("Export XDR");
    assert.dom(document.body).containsText("Cancel");
  });

  test("disables freeze button when already frozen", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    const mockValue = createMockGuardContextValue({
      snapshot: {
        fetchedAt: Date.now(),
        status: {
          ok: true,
          value: {
            admin_frozen: true, // Already frozen
            heartbeat_expired: false,
            has_policy: true,
            last_heartbeat: 1000n,
          },
          now: 2000n,
        },
      },
    });

    await act(() => {
      root!.render(
        React.createElement(
          GuardContext.Provider,
          { value: mockValue },
          React.createElement(PanicPanel),
        ),
      );
    });

    // Check that freeze button is disabled
    const freezeButton = document.querySelector(
      'button:has-text("Freeze this account")',
    ) as HTMLButtonElement | null;
    assert.ok(freezeButton, "Freeze button should exist");
    assert.strictEqual(
      freezeButton?.disabled,
      true,
      "Freeze button should be disabled when already frozen",
    );
  });

  test("disables unfreeze button when not frozen", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    const mockValue = createMockGuardContextValue({
      snapshot: {
        fetchedAt: Date.now(),
        status: {
          ok: true,
          value: {
            admin_frozen: false, // Not frozen
            heartbeat_expired: false,
            has_policy: true,
            last_heartbeat: 1000n,
          },
          now: 2000n,
        },
      },
    });

    await act(() => {
      root!.render(
        React.createElement(
          GuardContext.Provider,
          { value: mockValue },
          React.createElement(PanicPanel),
        ),
      );
    });

    // Check that unfreeze button is disabled
    const unfreezeButton = document.querySelector(
      'button:has-text("Unfreeze")',
    ) as HTMLButtonElement | null;
    assert.ok(unfreezeButton, "Unfreeze button should exist");
    assert.strictEqual(
      unfreezeButton?.disabled,
      true,
      "Unfreeze button should be disabled when not frozen",
    );
  });

  test("shows connected wallet requirement", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    const mockValue = createMockGuardContextValue({
      wallet: null, // No wallet connected
    });

    await act(() => {
      root!.render(
        React.createElement(
          GuardContext.Provider,
          { value: mockValue },
          React.createElement(PanicPanel),
        ),
      );
    });

    // Check that it shows wallet connection message
    assert.dom(document.body).containsText("Connect the admin wallet to freeze or unfreeze.");
  });

  test("handles exported transaction state", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    const mockValue = createMockGuardContextValue({
      notifyTabs: () => {},
      pushEvents: () => {},
    });

    await act(() => {
      root!.render(
        React.createElement(
          GuardContext.Provider,
          { value: mockValue },
          React.createElement(PanicPanel),
        ),
      );
    });

    // Trigger freeze confirmation and then check for export option
    const freezeButton = document.querySelector(
      'button:has-text("Freeze this account")',
    ) as HTMLButtonElement | null;
    assert.ok(freezeButton, "Freeze button should exist");
    freezeButton?.click();

    // Wait for state update
    await act(() => {
      return new Promise((resolve) => setTimeout(resolve, 50));
    });

    // Check export button exists in confirmation dialog
    const exportButton = document.querySelector(
      'button:has-text("Export XDR")',
    ) as HTMLButtonElement | null;
    assert.ok(exportButton, "Export XDR button should exist in confirmation dialog");
  });
});
