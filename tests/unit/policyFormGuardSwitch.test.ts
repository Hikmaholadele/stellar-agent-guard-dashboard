import assert from "node:assert/strict";
import { test, before, afterEach } from "node:test";
import type { ContextType, ReactElement } from "react";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import { PolicyForm } from "../../components/PolicyForm.tsx";
import { GuardContext, GuardEventsContext } from "../../components/GuardProvider.tsx";
import type { GuardSnapshot } from "../../lib/guard/guardOps.ts";

installDom();

/**
 * Switching the active guard while a policy edit is under way (#304).
 *
 * The form's draft, the diff the operator is asked to confirm and the outcome of
 * a write were all held in component state that did not know which guard they
 * were for. These tests drive the real form through a guard switch and check
 * the two things that matter: nothing made for one guard is applied to, shown
 * against or confirmable on another, and in the case that would have written to
 * the wrong account no signer is asked and no RPC call is made.
 */

const GUARD_A = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";
const GUARD_B = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
const ADMIN = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWH";

let react: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: Act;

before(async () => {
  const loaded = await loadReact();
  react = loaded.react;
  createRoot = loaded.createRoot;
  act = loaded.act;
});

afterEach(() => {
  document.body.innerHTML = "";
});

function policyFor(perTxCap: bigint) {
  return {
    per_tx_cap: perTxCap,
    window_cap: 5_000_000n,
    window_secs: 86_400n,
    assets: [],
    recipients: [],
    protocols: [],
    paused: false,
    active_from: 0n,
    active_until: 0n,
    allow_any_recipient: true,
    dms_grace_secs: 0n,
  };
}

function snapshotFor(guard: string, perTxCap: bigint): GuardSnapshot {
  return {
    guard,
    fetchedAt: "2026-09-25T10:00:00.000Z",
    status: {
      ok: true,
      value: {
        has_policy: true,
        admin_frozen: false,
        heartbeat_expired: false,
        last_heartbeat: 1_700_000_000n,
        now: 1_700_000_060n,
      },
    },
    policy: { ok: true, value: policyFor(perTxCap) },
    window: { ok: true, value: null },
    identity: {
      ok: true,
      value: { reportedWasmHash: "abc123", fetchedSha256: "abc123", bytes: 39673, match: true },
    },
  };
}

/** What the form must never reach for: a signer, or any call on the RPC server. */
function spies() {
  const signerCalls: string[] = [];
  const serverTouches: string[] = [];
  const server = new Proxy(
    {},
    {
      get: (_target, property) => {
        serverTouches.push(String(property));
        return () => Promise.reject(new Error("no network in tests"));
      },
    },
  );
  return { signerCalls, serverTouches, server };
}

type GuardContextValue = NonNullable<ContextType<typeof GuardContext>>;

function contextFor(guard: string, perTxCap: bigint, s: ReturnType<typeof spies>) {
  return {
    snapshot: snapshotFor(guard, perTxCap),
    snapshotError: null,
    guard,
    server: s.server,
    wallet: { address: ADMIN, networkPassphrase: "p", network: "testnet" },
    signer: () => {
      s.signerCalls.push(guard);
      throw new Error("a signer must not be requested in these tests");
    },
    refreshing: false,
    refresh: async () => {},
    pushEvents: () => {},
    notifyTabs: () => {},
  };
}

async function renderForm(initial: ReturnType<typeof contextFor>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async (value: ReturnType<typeof contextFor>) => {
    await act(async () => {
      root.render(
        react.createElement(
          GuardEventsContext.Provider,
          { value: [] },
          react.createElement(
            GuardContext.Provider,
            { value: value as unknown as GuardContextValue },
            react.createElement(PolicyForm) as ReactElement,
          ),
        ),
      );
    });
    await act(async () => {
      await sleep(10);
    });
  };
  await render(initial);
  return {
    container,
    rerender: render,
    unmount: async () => {
      await act(async () => root.unmount());
    },
  };
}

function capInput(container: HTMLElement): HTMLInputElement {
  const label = Array.from(container.querySelectorAll("label.field")).find((candidate) =>
    candidate.textContent?.includes("Per-transaction cap"),
  );
  const input = label?.querySelector("input");
  assert.ok(input, "the per-transaction cap input must render");
  return input;
}

async function typeInto(input: HTMLInputElement, text: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, text);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await sleep(0);
  });
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  assert.ok(found, `expected a button labelled "${text}"`);
  return found;
}

const staleNotice = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-testid=other-guard-draft]");
const diffDialog = () => document.querySelector('[aria-label="Policy changes"]');

test("an edit started on one guard is held, not applied, when another guard is selected", async () => {
  const s = spies();
  const form = await renderForm(contextFor(GUARD_A, 1_000_000n, s));
  try {
    await typeInto(capInput(form.container), "42");
    assert.equal(capInput(form.container).value, "42");
    assert.equal(
      staleNotice(form.container),
      null,
      "nothing is wrong while the guard is unchanged",
    );

    await form.rerender(contextFor(GUARD_B, 2_000_000n, s));

    const notice = staleNotice(form.container);
    assert.ok(notice, "the operator is told the edits belong to another guard");
    assert.equal(notice.getAttribute("role"), "alert");
    assert.match(notice.textContent ?? "", /different guard/i);
    assert.notEqual(capInput(form.container).value, "42", "A's edit is not shown as B's form");
    assert.equal(capInput(form.container).value, "2000000", "B's form shows what B has installed");
  } finally {
    await form.unmount();
  }
});

test("while the edits belong to another guard, nothing can be installed, exported or edited", async () => {
  const s = spies();
  const form = await renderForm(contextFor(GUARD_A, 1_000_000n, s));
  try {
    await typeInto(capInput(form.container), "42");
    await form.rerender(contextFor(GUARD_B, 2_000_000n, s));

    assert.equal(button(form.container, "Sign and install policy").disabled, true);
    assert.equal(button(form.container, "Export XDR").disabled, true);
    assert.equal(button(form.container, "Clear form").disabled, true);
    assert.equal(button(form.container, "Undo").disabled, true);

    const fieldset = capInput(form.container).closest("fieldset");
    assert.equal(
      fieldset?.disabled,
      true,
      "the fields are inert, so no edit can overwrite the held draft",
    );

    await act(async () => {
      button(form.container, "Sign and install policy").click();
    });
    assert.deepEqual(s.signerCalls, [], "no signer was requested");
    assert.deepEqual(s.serverTouches, [], "no RPC call was made");
  } finally {
    await form.unmount();
  }
});

test("switching back to the original guard returns the held edits untouched", async () => {
  const s = spies();
  const form = await renderForm(contextFor(GUARD_A, 1_000_000n, s));
  try {
    await typeInto(capInput(form.container), "42");
    await form.rerender(contextFor(GUARD_B, 2_000_000n, s));
    await form.rerender(contextFor(GUARD_A, 1_000_000n, s));

    assert.equal(staleNotice(form.container), null);
    assert.equal(capInput(form.container).value, "42", "the edit was held, not lost");
    assert.equal(button(form.container, "Sign and install policy").disabled, false);
  } finally {
    await form.unmount();
  }
});

test("edits for another guard are discarded only when the operator says so", async () => {
  const s = spies();
  const form = await renderForm(contextFor(GUARD_A, 1_000_000n, s));
  try {
    await typeInto(capInput(form.container), "42");
    await form.rerender(contextFor(GUARD_B, 2_000_000n, s));
    assert.ok(staleNotice(form.container));

    await act(async () => {
      button(form.container, "Discard unsaved edits").click();
    });

    assert.equal(staleNotice(form.container), null);
    assert.equal(capInput(form.container).value, "2000000");
    assert.equal(capInput(form.container).closest("fieldset")?.disabled, false);

    await form.rerender(contextFor(GUARD_A, 1_000_000n, s));
    assert.equal(
      capInput(form.container).value,
      "1000000",
      "the discarded edit does not come back",
    );
  } finally {
    await form.unmount();
  }
});

test("a diff awaiting confirmation is cancelled by a guard switch and cannot be confirmed on the new guard", async () => {
  const s = spies();
  const form = await renderForm(contextFor(GUARD_A, 1_000_000n, s));
  try {
    await typeInto(capInput(form.container), "500000");
    await act(async () => {
      button(form.container, "Sign and install policy").click();
    });
    assert.ok(diffDialog(), "the operator is asked to confirm the change to guard A");

    await form.rerender(contextFor(GUARD_B, 2_000_000n, s));
    assert.equal(diffDialog(), null, "the confirmation for A is gone once B is selected");

    // Even coming back to A, the old approval is not revived.
    await form.rerender(contextFor(GUARD_A, 1_000_000n, s));
    assert.equal(diffDialog(), null, "an approval does not survive leaving the guard it was for");

    assert.deepEqual(s.signerCalls, [], "no signer was requested for any guard");
    assert.deepEqual(s.serverTouches, [], "no transaction was built or simulated");
  } finally {
    await form.unmount();
  }
});
