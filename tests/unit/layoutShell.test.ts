import assert from "node:assert/strict";
import { test, before, afterEach, describe } from "node:test";
import { installDom, loadReact } from "./domHarness.ts";
import { LayoutShell } from "../../components/LayoutShell.tsx";
import { privacyStore } from "../../lib/guard/privacyStore.ts";

describe("LayoutShell", () => {
  let dom: ReturnType<typeof installDom>;
  let React: Awaited<ReturnType<typeof loadReact>>["react"];
  let createRoot: Awaited<ReturnType<typeof loadReact>>["createRoot"];
  let act: Awaited<ReturnType<typeof loadReact>>["act"];
  let root: ReturnType<typeof createRoot> | null = null;

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
    localStorage.clear();
    privacyStore.resetForTesting();
  });

  test("renders desktop layout by default (width >= 768px)", async () => {
    // Mock window.innerWidth to be desktop size
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 1024,
    });

    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    await act(() => {
      root!.render(
        React.createElement(
          LayoutShell,
          null,
          React.createElement("div", { "data-testid": "content" }, "test content"),
        ),
      );
    });

    // Check that desktop elements are present
    assert.dom(document.body).containsText("Stellar Agent Guard");
    assert.dom(document.body).containsText("operator console");
    assert.dom(document.body).containsText("Soroban testnet");
    assert.dom(document.body).doesNotContainText("☰"); // Hamburger menu should not be visible on desktop
    assert.dom(document.body).containsText("test content");

    // Check that sidebar is present
    assert.ok(document.querySelector(".sidebar-container"));
    assert.ok(document.querySelector(".main-content"));

    // Check that mobile elements are not present
    assert.notOk(document.querySelector(".mobile-header"));
    assert.notOk(document.querySelector(".mobile-backdrop"));
    assert.notOk(document.querySelector(".mobile-drawer"));
  });

  test("renders mobile layout when width < 768px", async () => {
    // Mock window.innerWidth to be mobile size
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 480,
    });

    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    await act(() => {
      root!.render(
        React.createElement(
          LayoutShell,
          null,
          React.createElement("div", { "data-testid": "content" }, "test content"),
        ),
      );
    });

    // Check that mobile elements are present
    assert.dom(document.body).containsText("Stellar Agent Guard");
    assert.dom(document.body).containsText("operator console");
    assert.dom(document.body).containsText("☰"); // Hamburger menu should be visible on mobile
    assert.dom(document.body).containsText("test content");

    // Check that mobile header is present
    assert.ok(document.querySelector(".mobile-header"));

    // Check that desktop header is not present
    assert.notOk(document.querySelector("header.top"));

    // Initially drawer should be closed
    assert.notOk(document.querySelector(".mobile-drawer"));
    assert.notOk(document.querySelector(".mobile-backdrop"));
  });

  test("sidebar collapse state persists in localStorage", async () => {
    // Mock window.innerWidth to be desktop size
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 1024,
    });

    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    await act(() => {
      root!.render(
        React.createElement(
          LayoutShell,
          null,
          React.createElement("div", { "data-testid": "content" }, "test content"),
        ),
      );
    });

    // Initially sidebar should be expanded (collapsed = false)
    let sidebar = document.querySelector(".sidebar-container");
    assert.ok(sidebar);
    assert.strictEqual(sidebar?.classList.contains("collapsed"), false);

    // Click the sidebar toggle button to collapse it
    const toggleButton = document.querySelector(".sidebar-toggle") as HTMLButtonElement | null;
    assert.ok(toggleButton, "Sidebar toggle button should exist");
    toggleButton?.click();

    // Wait for state update
    await act(() => {
      return new Promise((resolve) => setTimeout(resolve, 10));
    });

    // Sidebar should now be collapsed
    sidebar = document.querySelector(".sidebar-container");
    assert.ok(sidebar);
    assert.strictEqual(sidebar?.classList.contains("collapsed"), true);

    // Check that localStorage was updated
    assert.strictEqual(localStorage.getItem("sidebar-collapsed"), "true");

    // Reload the component - sidebar should remain collapsed
    act(() => {
      root!.unmount();
      root = null;
    });

    div.innerHTML = "";
    root = createRoot(div);

    await act(() => {
      root!.render(
        React.createElement(
          LayoutShell,
          null,
          React.createElement("div", { "data-testid": "content" }, "test content"),
        ),
      );
    });

    // Sidebar should still be collapsed from localStorage
    sidebar = document.querySelector(".sidebar-container");
    assert.ok(sidebar);
    assert.strictEqual(sidebar?.classList.contains("collapsed"), true);
  });

  test("mobile drawer opens and closes correctly", async () => {
    // Mock window.innerWidth to be mobile size
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 480,
    });

    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    await act(() => {
      root!.render(
        React.createElement(
          LayoutShell,
          null,
          React.createElement("div", { "data-testid": "content" }, "test content"),
        ),
      );
    });

    // Initially drawer should be closed
    assert.notOk(document.querySelector(".mobile-drawer"));
    assert.notOk(document.querySelector(".mobile-backdrop"));

    // Click the hamburger button to open drawer
    const hamburgerButton = document.querySelector(
      '.mobile-header button[aria-label="Open navigation menu"]',
    ) as HTMLButtonElement | null;
    assert.ok(hamburgerButton, "Hamburger button should exist");
    hamburgerButton?.click();

    // Wait for state update
    await act(() => {
      return new Promise((resolve) => setTimeout(resolve, 10));
    });

    // Drawer should now be open
    assert.ok(document.querySelector(".mobile-drawer"));
    assert.ok(document.querySelector(".mobile-backdrop"));
    assert.ok(document.querySelector('[aria-modal="true"]'));

    // Click the close button in drawer
    const closeButton = document.querySelector(
      '.mobile-drawer-header button[aria-label="Close navigation menu"]',
    ) as HTMLButtonElement | null;
    assert.ok(closeButton, "Close button should exist");
    closeButton?.click();

    // Wait for state update
    await act(() => {
      return new Promise((resolve) => setTimeout(resolve, 10));
    });

    // Drawer should now be closed
    assert.notOk(document.querySelector(".mobile-drawer"));
    assert.notOk(document.querySelector(".mobile-backdrop"));

    // Click on backdrop to close drawer (alternative method)
    hamburgerButton?.click();
    await act(() => {
      return new Promise((resolve) => setTimeout(resolve, 10));
    });

    const backdrop = document.querySelector<HTMLElement>(".mobile-backdrop");
    assert.ok(backdrop, "Backdrop should exist when drawer is open");
    backdrop?.click();

    await act(() => {
      return new Promise((resolve) => setTimeout(resolve, 10));
    });

    assert.notOk(document.querySelector(".mobile-drawer"));
    assert.notOk(document.querySelector(".mobile-backdrop"));
  });

  test("escape key closes mobile drawer", async () => {
    // Mock window.innerWidth to be mobile size
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 480,
    });

    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    await act(() => {
      root!.render(
        React.createElement(
          LayoutShell,
          null,
          React.createElement("div", { "data-testid": "content" }, "test content"),
        ),
      );
    });

    // Open the drawer
    const hamburgerButton = document.querySelector(
      '.mobile-header button[aria-label="Open navigation menu"]',
    ) as HTMLButtonElement | null;
    hamburgerButton?.click();

    await act(() => {
      return new Promise((resolve) => setTimeout(resolve, 10));
    });

    // Drawer should be open
    assert.ok(document.querySelector(".mobile-drawer"));

    // Press Escape key
    const escapeKey = new KeyboardEvent("keydown", { key: "Escape" });
    window.dispatchEvent(escapeKey);

    // Wait for state update
    await act(() => {
      return new Promise((resolve) => setTimeout(resolve, 10));
    });

    // Drawer should be closed
    assert.notOk(document.querySelector(".mobile-drawer"));
    assert.notOk(document.querySelector(".mobile-backdrop"));
  });

  test("drawer closes when resizing from mobile to desktop", async () => {
    // Start with mobile size
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 480,
    });

    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    await act(() => {
      root!.render(
        React.createElement(
          LayoutShell,
          null,
          React.createElement("div", { "data-testid": "content" }, "test content"),
        ),
      );
    });

    // Open the drawer
    const hamburgerButton = document.querySelector(
      '.mobile-header button[aria-label="Open navigation menu"]',
    ) as HTMLButtonElement | null;
    hamburgerButton?.click();

    await act(() => {
      return new Promise((resolve) => setTimeout(resolve, 10));
    });

    // Drawer should be open
    assert.ok(document.querySelector(".mobile-drawer"));

    // Resize to desktop width
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 1024,
    });
    window.dispatchEvent(new window.Event("resize"));

    // Wait for state update
    await act(() => {
      return new Promise((resolve) => setTimeout(resolve, 10));
    });

    // Drawer should be closed when resized to desktop
    assert.notOk(document.querySelector(".mobile-drawer"));
    assert.notOk(document.querySelector(".mobile-backdrop"));
  });

  test("privacy toggle renders with accessible aria attributes and toggles on click", async () => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 1024,
    });

    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    await act(() => {
      root!.render(
        React.createElement(
          LayoutShell,
          null,
          React.createElement("div", { "data-testid": "content" }, "test content"),
        ),
      );
    });

    const privacyBtn = document.querySelector<HTMLButtonElement>("button.privacy-toggle");
    assert.ok(privacyBtn, "Privacy toggle button should be rendered in layout shell");
    assert.equal(privacyBtn.getAttribute("aria-pressed"), "false");
    assert.equal(privacyBtn.getAttribute("aria-label"), "Enable privacy mask");
    assert.equal(privacyStore.get(), false);

    // Click toggle to enable
    await act(async () => {
      privacyBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    assert.equal(privacyStore.get(), true);
    assert.equal(privacyBtn.getAttribute("aria-pressed"), "true");
    assert.equal(privacyBtn.getAttribute("aria-label"), "Disable privacy mask");

    // Click toggle again to disable
    await act(async () => {
      privacyBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    assert.equal(privacyStore.get(), false);
    assert.equal(privacyBtn.getAttribute("aria-pressed"), "false");
  });

  test("privacy preference does not persist to localStorage unless explicitly chosen", async () => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 1024,
    });

    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    await act(() => {
      root!.render(
        React.createElement(
          LayoutShell,
          null,
          React.createElement("div", { "data-testid": "content" }, "test content"),
        ),
      );
    });

    const privacyBtn = document.querySelector<HTMLButtonElement>("button.privacy-toggle");
    assert.ok(privacyBtn);

    // Toggling without explicit persist
    await act(async () => {
      privacyBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    assert.equal(privacyStore.get(), true);
    assert.equal(privacyStore.isPersisted(), false);
    assert.equal(
      localStorage.getItem("privacy-mask"),
      null,
      "should NOT write to localStorage by default",
    );

    // Setting explicit persist
    await act(async () => {
      privacyStore.setPersist(true);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assert.equal(
      localStorage.getItem("privacy-mask"),
      "true",
      "should write to localStorage when persist is true",
    );
  });

  test("route changes preserve in-memory privacy mask state", async () => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 1024,
    });

    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    await act(() => {
      root!.render(
        React.createElement(
          LayoutShell,
          null,
          React.createElement("div", { "data-testid": "page-1" }, "page 1"),
        ),
      );
    });

    const privacyBtn = document.querySelector<HTMLButtonElement>("button.privacy-toggle");
    assert.ok(privacyBtn);

    // Turn on privacy
    await act(async () => {
      privacyBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assert.equal(privacyStore.get(), true);

    // Simulate route transition (new children rendered in shell)
    await act(async () => {
      root!.render(
        React.createElement(
          LayoutShell,
          null,
          React.createElement("div", { "data-testid": "page-2" }, "page 2"),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    // Mask state remains active after route change
    assert.equal(
      privacyStore.get(),
      true,
      "privacy mask remains active across simulated route change",
    );
    const updatedBtn = document.querySelector<HTMLButtonElement>("button.privacy-toggle");
    assert.equal(updatedBtn?.getAttribute("aria-pressed"), "true");
  });
});
