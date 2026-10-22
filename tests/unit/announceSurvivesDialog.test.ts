/**
 * The announcement outlives the dialog that caused it (issue #30).
 *
 * A confirmation dialog is torn down by the very interaction it exists to
 * collect — the operator confirms, and the thing they were reading disappears.
 * An announcement written into that dialog's own subtree is therefore an
 * announcement the operator never hears: the node is gone before the screen
 * reader gets to it, and what they are left with is focus jumping back to a
 * button with no context.
 *
 * So this asserts the ordering and the outliving separately, in the same shape
 * the app renders them: the announcer is a sibling of the panel, the freeze is
 * verified against an injected `status()` read, and afterwards the live region
 * is *the same node* it was before, carrying the message, while focus has
 * already returned to the trigger.
 */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import { AriaAnnouncer } from "../../components/AriaAnnouncer.tsx";
import { PanicPanel, type PanicPanelOps } from "../../components/PanicPanel.tsx";
import { GuardContext } from "../../components/GuardProvider.tsx";
import { clearAnnouncements, pendingAnnouncements } from "../../lib/guard/useAnnounce.ts";
import type { InvokeResult } from "../../lib/guard/submit.ts";

installDom();

let react: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: Act;

before(async () => {
  const loaded = await loadReact();
  react = loaded.react;
  createRoot = loaded.createRoot;
  act = loaded.act;
});

const TEST_GUARD_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const SUBMITTED: InvokeResult = {
  kind: "submitted",
  hash: "0f1e2d".padEnd(64, "0"),
  status: "SUCCESS",
  ledger: 5_000_123,
  events: [],
};

const REFUSED: InvokeResult = {
  kind: "refused",
  stage: "enforcement",
  detail: "per_tx_cap_exceeded",
  diagnosticEvents: [],
};

// `any`, as in the a11y audit: the context value is a partial stand-in for a
// provider with a live RPC behind it, and typing every field here would only
// restate `GuardContextValue` while pinning this test to fields it never uses.
function guardContext(overrides: Record<string, unknown> = {}): any {
  return {
    server: new Proxy(
      {},
      { get: () => () => Promise.reject(new Error("no network in unit tests")) },
    ),
    wallet: {
      address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWH",
      networkPassphrase: "Test SDF Network ; September 2015",
      network: "Testnet",
    },
    walletError: null,
    connecting: false,
    connect: async () => {},
    disconnect: () => {},
    signer: () => ({}),
    instances: [],
    guard: TEST_GUARD_ID,
    selectGuard: () => {},
    addInstance: () => {},
    snapshot: null,
    snapshotError: null,
    refreshing: false,
    refresh: async () => {},
    feed: { watching: false, latestLedger: null, error: null, lastPolledAt: null },
    startWatching: () => {},
    stopWatching: () => {},
    clearEvents: () => {},
    pushEvents: () => {},
    notifyTabs: () => {},
    ...overrides,
  };
}

interface Mounted {
  container: HTMLElement;
  polite: HTMLElement;
  assertive: HTMLElement;
  unmount: () => Promise<void>;
}

/**
 * The app's own arrangement: the announcer is a sibling of the panel, both
 * inside one root, exactly as `app/layout.tsx` mounts them.
 */
async function mount(
  ops: Partial<PanicPanelOps>,
  context: Record<string, unknown> = {},
): Promise<Mounted> {
  clearAnnouncements();
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: ReturnType<typeof createRoot> | undefined;
  await act(async () => {
    root = createRoot(container);
    root.render(
      react.createElement(
        GuardContext.Provider,
        { value: guardContext(context) },
        react.createElement(AriaAnnouncer),
        react.createElement(PanicPanel, { ops }),
      ),
    );
  });
  const polite = container.querySelector<HTMLElement>('[aria-live="polite"]');
  const assertive = container.querySelector<HTMLElement>('[aria-live="assertive"]');
  assert.ok(polite, "the shell's polite region must be rendered");
  assert.ok(assertive, "the shell's assertive region must be rendered");
  return {
    container,
    polite,
    assertive,
    unmount: async () => {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
    },
  };
}

/** Confirm a freeze through the dialog, as an operator would. */
async function freezeThroughDialog(container: HTMLElement): Promise<void> {
  const buttonByText = (text: string): HTMLButtonElement => {
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === text,
    );
    assert.ok(button, `expected a button labelled "${text}"`);
    return button;
  };

  const trigger = buttonByText("Freeze this account");
  await act(async () => {
    trigger.click();
  });
  const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
  assert.ok(dialog, "the confirmation must be open before the write");
  assert.equal(document.activeElement, dialog, "opening it moves focus inside");

  const ack = container.querySelector<HTMLInputElement>("#ack-freeze");
  assert.ok(ack, "the confirmation must be acknowledged before it can be signed");
  await act(async () => {
    ack.click();
  });
  // The freeze challenge (issue #15) fails safe to "shown" when the balance
  // cannot be read, which is exactly the case in a unit harness with no
  // network. Type the suffix before signing, as the operator must.
  const challenge = container.querySelector<HTMLInputElement>("#freeze-challenge");
  assert.ok(challenge, "the typed challenge must render when the balance is unread");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(challenge, TEST_GUARD_ID.slice(-6));
    challenge.dispatchEvent(new window.Event("input", { bubbles: true }));
    await sleep(0);
  });
  await act(async () => {
    buttonByText("Sign freeze").click();
    // Let the injected write and the re-read both settle inside act.
    await sleep(30);
  });
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await act(async () => {
      await sleep(50);
    });
  }
}

test("a verified freeze is announced into a region that outlives the dialog", async () => {
  const ops: Partial<PanicPanelOps> = {
    freeze: async () => SUBMITTED,
    readStatus: async () => ({
      ok: true,
      value: { admin_frozen: true, heartbeat_expired: false, has_policy: false } as never,
    }),
  };
  const mounted = await mount(ops);
  try {
    // The region identity is captured before anything happens: outliving the
    // dialog means it is the *same node* afterwards, not a replacement that
    // happens to be blank.
    const regionBefore = mounted.polite;

    await freezeThroughDialog(mounted.container);

    assert.equal(
      mounted.container.querySelector('[role="dialog"]'),
      null,
      "the dialog is gone by the time the write is announced",
    );
    const unfreeze = Array.from(mounted.container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Unfreeze",
    );
    assert.equal(
      document.activeElement,
      unfreeze,
      "focus moves to the available action when the confirmed freeze disables its trigger",
    );
    assert.equal(
      mounted.container.querySelector('[aria-live="polite"]'),
      regionBefore,
      "the live region is the same node: the announcement did not move with the dialog",
    );

    // Announced *and* queued before the teardown: the region is the only thing
    // left on screen, and the message is in it.
    await waitFor(
      () => mounted.polite.textContent === `Account frozen for guard ${TEST_GUARD_ID}`,
      "the verified freeze to be spoken",
    );
    assert.equal(mounted.assertive.textContent, "", "a confirmed freeze is not an interruption");
  } finally {
    await mounted.unmount();
  }
});

test("a freeze the chain disagrees with is announced assertively, with the reason", async () => {
  const ops: Partial<PanicPanelOps> = {
    // Included on the network, and the contract's own view says otherwise: the
    // exact case where reporting success would be a lie.
    freeze: async () => SUBMITTED,
    readStatus: async () => ({
      ok: true,
      value: { admin_frozen: false, heartbeat_expired: false, has_policy: false } as never,
    }),
  };
  const mounted = await mount(ops);
  try {
    await freezeThroughDialog(mounted.container);
    await waitFor(() => mounted.assertive.textContent !== "", "the failed freeze to be spoken");
    const spoken = mounted.assertive.textContent ?? "";
    assert.match(spoken, /^Freeze failed: /, "a failure is announced as a failure");
    assert.match(spoken, /status\(\)/, "and it carries the reason the chain disagreed");
    assert.match(spoken, /NOT visible on chain/);
    assert.notEqual(
      mounted.polite.textContent,
      `Account frozen for guard ${TEST_GUARD_ID}`,
      "a freeze the chain contradicts is never announced as a success",
    );
  } finally {
    await mounted.unmount();
  }
});

test("a refused freeze is announced with the guard's own reason", async () => {
  const mounted = await mount({ freeze: async () => REFUSED });
  try {
    await freezeThroughDialog(mounted.container);
    await waitFor(() => mounted.assertive.textContent !== "", "the refusal to be spoken");
    const spoken = mounted.assertive.textContent ?? "";
    assert.match(spoken, /^Freeze failed: refused during enforcement: per_tx_cap_exceeded/);
    // The refusal's diagnostics belong in the feed, which is a different
    // channel: the count of blocked decisions, batched.
    assert.equal(mounted.polite.textContent, "");
  } finally {
    await mounted.unmount();
  }
});

test("an unfreeze is announced too, and not as a freeze", async () => {
  const mounted = await mount({
    unfreeze: async () => SUBMITTED,
    readStatus: async () => ({
      ok: true,
      value: { admin_frozen: false, heartbeat_expired: false, has_policy: false } as never,
    }),
  });
  try {
    const unfreeze = Array.from(mounted.container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Unfreeze",
    );
    assert.ok(unfreeze, "the panel offers an unfreeze while the account is frozen");
    await act(async () => {
      unfreeze.click();
      await sleep(30);
    });
    await waitFor(() => mounted.polite.textContent !== "", "the unfreeze to be spoken");
    assert.equal(mounted.polite.textContent, `Account unfrozen for guard ${TEST_GUARD_ID}`);
  } finally {
    await mounted.unmount();
  }
});

test("a wallet failure during signing is announced before the dialog closes", async () => {
  // The dialog goes back to idle and the panel shows the error. Nothing on screen
  // changes after focus is restored, so if the reason is not in the queue the
  // operator is left with a panel and a button and no idea what happened.
  const mounted = await mount({
    freeze: async () => {
      throw new Error("Freighter rejected the request: user declined");
    },
  });
  try {
    await freezeThroughDialog(mounted.container);
    assert.equal(
      mounted.container.querySelector('[role="dialog"]'),
      null,
      "a wallet failure does not leave a modal open",
    );
    await waitFor(() => mounted.assertive.textContent !== "", "the failure to be spoken");
    assert.match(
      mounted.assertive.textContent ?? "",
      /^Freeze failed: Freighter rejected the request: user declined/,
    );
    assert.equal(mounted.polite.textContent, "");
  } finally {
    await mounted.unmount();
  }
});

test("a freeze is spoken once, through the one channel that verified it", async () => {
  // Three layers could each claim a freeze: the low-level write path (which
  // never re-reads the contract), the panel (which does), and the poll
  // (which sees the flag later). Only the middle one is evidence, so the
  // operator should hear one thing — and the other two claimings should not
  // appear at all.
  const mounted = await mount({
    freeze: async () => SUBMITTED,
    readStatus: async () => ({
      ok: true,
      value: { admin_frozen: true, heartbeat_expired: false, has_policy: false } as never,
    }),
  });
  try {
    await freezeThroughDialog(mounted.container);
    await waitFor(() => mounted.polite.textContent !== "", "the freeze to be spoken");

    const heard = new Set<string>();
    for (let sample = 0; sample < 12; sample += 1) {
      const text = mounted.polite.textContent ?? "";
      if (text !== "") heard.add(text);
      await act(async () => {
        await sleep(120);
      });
    }
    assert.deepEqual(
      [...heard],
      [`Account frozen for guard ${TEST_GUARD_ID}`],
      "the only thing spoken about this freeze is the verified outcome",
    );
    assert.equal(
      heard.has("Admin freeze activated"),
      false,
      "the unverified low-level claim is not made for a write the console could verify",
    );
    assert.deepEqual(pendingAnnouncements(), [], "and nothing is left queued behind it");
  } finally {
    await mounted.unmount();
  }
});
