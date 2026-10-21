import assert from "node:assert/strict";
import { before, test } from "node:test";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import { AriaAnnouncer } from "../../components/AriaAnnouncer.tsx";
import {
  ANNOUNCE_QUEUE_CAP,
  DUPLICATE_WINDOW_MS,
  announce,
  clearAnnouncements,
  pendingAnnouncements,
  shiftAnnouncement,
} from "../../lib/guard/useAnnounce.ts";

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

interface Mounted {
  container: HTMLElement;
  polite: HTMLElement;
  assertive: HTMLElement;
  unmount: () => Promise<void>;
}

async function mountAnnouncer(): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: ReturnType<typeof createRoot> | undefined;
  await act(async () => {
    root = createRoot(container);
    root.render(react.createElement(AriaAnnouncer));
  });
  const polite = container.querySelector<HTMLElement>('[aria-live="polite"]');
  const assertive = container.querySelector<HTMLElement>('[aria-live="assertive"]');
  assert.ok(polite, "a polite live region must be rendered");
  assert.ok(assertive, "an assertive live region must be rendered");
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

/** Let the component's speak/shift timers run inside act so state flushes. */
async function settle(ms: number): Promise<void> {
  await act(async () => {
    await sleep(ms);
  });
}

/**
 * Poll until a condition holds, sleeping inside act each round so queue
 * updates from the announcer's shift timer keep flowing. Draining is timer-
 * driven, so fixed sleeps would only encode the machine's speed.
 */
async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!condition()) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${label}`);
    }
    await act(async () => {
      await sleep(50);
    });
  }
}

test("the announcer renders two static, hidden live regions", async () => {
  clearAnnouncements();
  const mounted = await mountAnnouncer();
  try {
    assert.equal(mounted.polite.getAttribute("aria-atomic"), "true");
    assert.equal(mounted.assertive.getAttribute("aria-atomic"), "true");
    assert.match(mounted.polite.className, /visually-hidden/);
    assert.match(mounted.assertive.className, /visually-hidden/);
    // The regions are empty until something is announced.
    assert.equal(mounted.polite.textContent, "");
    assert.equal(mounted.assertive.textContent, "");
  } finally {
    await mounted.unmount();
  }
});

test("a polite milestone is spoken into the polite region", async () => {
  clearAnnouncements();
  const mounted = await mountAnnouncer();
  try {
    // Announcing touches React state (the queue subscription), so it runs
    // inside act like any other state update in a test.
    await act(async () => {
      assert.equal(announce("Transaction simulation started"), true);
    });
    await settle(150);
    assert.equal(mounted.polite.textContent, "Transaction simulation started");
    assert.equal(mounted.assertive.textContent, "");
    // Once spoken, the message leaves the queue.
    await settle(450);
    assert.equal(pendingAnnouncements().length, 0);
  } finally {
    await mounted.unmount();
  }
});

test("critical alerts are spoken into the assertive region", async () => {
  clearAnnouncements();
  const mounted = await mountAnnouncer();
  try {
    await act(async () => {
      announce("Admin freeze activated", "assertive");
    });
    await settle(150);
    assert.equal(mounted.assertive.textContent, "Admin freeze activated");
    assert.equal(mounted.polite.textContent, "");
  } finally {
    await mounted.unmount();
  }
});

test("an assertive transaction outcome is still spoken after its dialog closes", async () => {
  clearAnnouncements();
  const mounted = await mountAnnouncer();
  const dialogContainer = document.createElement("div");
  document.body.appendChild(dialogContainer);
  const dialogRoot = createRoot(dialogContainer);
  await act(async () => {
    dialogRoot.render(react.createElement("div", { role: "dialog" }, "Submitting transaction"));
    announce("Policy install failed for guard GABC: RPC rejected the write", "assertive");
    dialogRoot.unmount();
  });
  try {
    assert.equal(dialogContainer.querySelector('[role="dialog"]'), null);
    await settle(150);
    assert.equal(
      mounted.assertive.textContent,
      "Policy install failed for guard GABC: RPC rejected the write",
    );
  } finally {
    dialogContainer.remove();
    await mounted.unmount();
  }
});

test("rapid distinct messages queue and drain one at a time, in order", async () => {
  clearAnnouncements();
  const mounted = await mountAnnouncer();
  try {
    await act(async () => {
      assert.equal(announce("first message"), true);
      assert.equal(announce("second message"), true);
      assert.equal(announce("third message"), true);
    });
    assert.equal(pendingAnnouncements().length, 3, "all three are queued");

    // Each message must be spoken, in order, and the queue must drain fully.
    await waitFor(
      () => mounted.polite.textContent === "first message",
      "the first message to be spoken",
    );
    await waitFor(
      () => mounted.polite.textContent === "second message",
      "the second message to be spoken",
    );
    await waitFor(
      () => mounted.polite.textContent === "third message",
      "the third message to be spoken",
    );
    await waitFor(() => pendingAnnouncements().length === 0, "the queue to drain");
    assert.equal(mounted.polite.textContent, "third message");
  } finally {
    await mounted.unmount();
  }
});

test("redundant repeats from rapid state updates are suppressed", () => {
  clearAnnouncements();
  const start = Date.now();

  assert.equal(announce("Transaction submitted to network", "polite", start), true);
  // Still queued: an identical message is not news, it is spam.
  assert.equal(announce("Transaction submitted to network", "polite", start + 10), false);
  assert.equal(pendingAnnouncements().length, 1);

  // Spoken and shifted, but still inside the duplicate window.
  shiftAnnouncement();
  assert.equal(
    announce("Transaction submitted to network", "polite", start + DUPLICATE_WINDOW_MS - 1),
    false,
    "a repeat immediately after speaking is still redundant",
  );

  // Past the window it is legitimately new information again.
  assert.equal(
    announce("Transaction submitted to network", "polite", start + DUPLICATE_WINDOW_MS),
    true,
  );

  // Priority matters: the same words as an assertive alert are a different message.
  assert.equal(
    announce("Transaction submitted to network", "assertive", start + DUPLICATE_WINDOW_MS + 1),
    true,
  );
});

test("the queue is bounded so a flood cannot grow without limit", () => {
  clearAnnouncements();
  const start = Date.now();
  for (let index = 0; index < ANNOUNCE_QUEUE_CAP + 10; index += 1) {
    announce(`message ${index}`, "polite", start + index);
  }
  assert.equal(pendingAnnouncements().length, ANNOUNCE_QUEUE_CAP);
  // The newest messages survive; the oldest were dropped.
  const pending = pendingAnnouncements();
  assert.equal(pending[pending.length - 1]?.message, `message ${ANNOUNCE_QUEUE_CAP + 9}`);
  assert.equal(
    pending.some((item) => item.message === "message 0"),
    false,
  );
  clearAnnouncements();
});

test("announcements made before the mount are not lost", async () => {
  clearAnnouncements();
  // No listener exists yet, so this touches no React state outside act.
  announce("queued before the announcer existed");
  const mounted = await mountAnnouncer();
  try {
    await settle(150);
    assert.equal(mounted.polite.textContent, "queued before the announcer existed");
  } finally {
    await mounted.unmount();
  }
});
