import assert from "node:assert/strict";
import { afterEach, before, test } from "node:test";
import { UnsavedChangesGuardView } from "../../components/UnsavedChangesProvider.tsx";
import { EMPTY_DRAFT, policyDraftsEqual } from "../../lib/guard/policyForm.ts";
import { useUnsavedChangesWarning } from "../../lib/guard/useUnsavedChangesWarning.ts";
import { installDom, loadReact, type Act } from "./domHarness.ts";

let React: Awaited<ReturnType<typeof loadReact>>["react"];
let createRoot: Awaited<ReturnType<typeof loadReact>>["createRoot"];
let act: Act;
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

before(async () => {
  installDom();
  const loaded = await loadReact();
  React = loaded.react;
  createRoot = loaded.createRoot;
  act = loaded.act;
});

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
});

function DirtyForm({ dirty }: { dirty: boolean }) {
  useUnsavedChangesWarning(dirty);
  return null;
}

async function mountGuard(router: { push(href: string): void }, dirty: boolean) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      React.createElement(
        UnsavedChangesGuardView,
        { router },
        React.createElement(DirtyForm, { key: "form", dirty }),
        React.createElement("a", { key: "link", href: "/fleet" }, "Fleet"),
      ),
    );
  });
}

test("policy draft dirtiness compares all current values with the baseline", () => {
  const baseline = { ...EMPTY_DRAFT };
  assert.equal(policyDraftsEqual(baseline, { ...EMPTY_DRAFT }), true);
  assert.equal(policyDraftsEqual(baseline, { ...EMPTY_DRAFT, perTxCap: "25" }), false);
  assert.equal(
    policyDraftsEqual(baseline, {
      ...EMPTY_DRAFT,
      assetCaps: [{ assetContractAddress: "C", maxCapStroops: "1", symbol: "A" }],
    }),
    false,
  );
});

test("dirty navigation can be canceled or explicitly discarded", async () => {
  const pushed: string[] = [];
  const router = { push: (href: string) => pushed.push(href) };
  await mountGuard(router, true);

  const link = container!.querySelector("a[href='/fleet']");
  assert.ok(link);

  // jsdom's Event, not Node's: the global Event is Node's and jsdom refuses it.
  const beforeUnload = new window.Event("beforeunload", { cancelable: true });
  window.dispatchEvent(beforeUnload);
  assert.equal(beforeUnload.defaultPrevented, true);

  const navigate = () =>
    link.dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
    );
  await act(async () => {
    assert.equal(navigate(), false);
  });
  assert.match(container!.textContent ?? "", /You have unsaved policy changes/);
  assert.equal(pushed.length, 0);

  const continueButton = Array.from(container!.querySelectorAll("button")).find(
    (button) => button.textContent === "Continue editing",
  );
  assert.ok(continueButton);
  await act(async () => continueButton.click());
  assert.equal(container!.querySelector('[role="dialog"]'), null);
  assert.equal(pushed.length, 0);

  await act(async () => {
    assert.equal(navigate(), false);
  });
  const discardButton = Array.from(container!.querySelectorAll("button")).find(
    (button) => button.textContent === "Discard changes",
  );
  assert.ok(discardButton);
  await act(async () => discardButton.click());
  assert.deepEqual(pushed, ["/fleet"]);
});

test("a clean form leaves navigation and beforeunload alone", async () => {
  const pushed: string[] = [];
  const router = { push: (href: string) => pushed.push(href) };
  await mountGuard(router, false);

  const beforeUnload = new window.Event("beforeunload", { cancelable: true });
  window.dispatchEvent(beforeUnload);
  assert.equal(beforeUnload.defaultPrevented, false);

  const link = container!.querySelector("a[href='/fleet']");
  assert.ok(link);

  // jsdom performs no navigation. Cancelling after the guard had its chance
  // keeps this assertion about the guard rather than about jsdom's URL.
  const cancelNavigation = (event: Event) => event.preventDefault();
  document.addEventListener("click", cancelNavigation);
  try {
    await act(async () => {
      link.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
      );
    });
  } finally {
    document.removeEventListener("click", cancelNavigation);
  }

  assert.equal(container!.querySelector('[role="dialog"]'), null);
  assert.equal(pushed.length, 0);
});
