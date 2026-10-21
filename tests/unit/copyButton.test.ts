import assert from "node:assert/strict";
import { before, mock, test } from "node:test";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import { CopyButton, COPIED_FEEDBACK_MS } from "../../components/CopyButton.tsx";
import {
  announce,
  clearAnnouncements,
  pendingAnnouncements,
  shiftAnnouncement,
  subscribeAnnouncements,
} from "../../lib/guard/useAnnounce.ts";
import { copyToClipboard, type ClipboardWriter } from "../../lib/guard/clipboard.ts";

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

// The 56-character C… contract address and the 64-hex transaction hash used in
// the arg-exactness assertions below. The address is a real-format strkey
// fixture (same alphabet and length as the Phase 2 guard the README cites).
const GUARD_ADDRESS = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
const TX_HASH = "bcd8eac52d6efb50eb2c8d7d9650493da9be7fe73b0be18a450282fa24006579";

/** A ClipboardWriter mock that records the exact argument of each writeText. */
function capturingWriter(): { writer: ClipboardWriter; texts: string[] } {
  const texts: string[] = [];
  return {
    texts,
    writer: {
      writeText: async (text: string) => {
        texts.push(text);
      },
    },
  };
}

/**
 * Point `navigator.clipboard` at the given writer for the duration of `run`.
 *
 * jsdom ships no clipboard implementation, so defining it here is exactly the
 * stand-in the browser's own API occupies: the component code under test is
 * unchanged, and the mock captures (or rejects) like the real write would.
 */
async function withClipboard(
  writer: ClipboardWriter | null,
  run: () => Promise<void>,
): Promise<void> {
  const holder = globalThis as { navigator: Navigator };
  const original =
    Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard") ??
    Object.getOwnPropertyDescriptor(holder.navigator, "clipboard");
  Object.defineProperty(holder.navigator, "clipboard", {
    value: writer,
    configurable: true,
  });
  try {
    await run();
  } finally {
    if (original) {
      Object.defineProperty(holder.navigator, "clipboard", original);
    } else {
      delete (holder.navigator as { clipboard?: unknown }).clipboard;
    }
  }
}

/** Mount one CopyButton and return the helpers the assertions below need. */
async function mountCopyButton(value: string, label: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: ReturnType<typeof createRoot> | undefined;
  await act(async () => {
    root = createRoot(container);
    root.render(react.createElement(CopyButton, { value, label }));
  });
  const button = container.querySelector<HTMLButtonElement>("button.copy-btn");
  assert.ok(button, "the copy control must render as a real <button>");
  return {
    container,
    button,
    unmount: async () => {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
    },
  };
}

test("arg-exactness: the FULL address reaches writeText — equality + 56-length twin assert", async () => {
  clearAnnouncements();
  const { texts, writer } = capturingWriter();
  await withClipboard(writer, async () => {
    const mounted = await mountCopyButton(GUARD_ADDRESS, "guard address");
    try {
      await act(async () => {
        mounted.button.click();
        await sleep(0);
      });

      // Twin assertion, because the bug class this test pins is a *truncated*
      // string being copied — a prefix would satisfy an equality check against
      // itself, but not the length half. Quote both halves on failure.
      assert.equal(texts.length, 1, "writeText must be called exactly once");
      assert.equal(
        texts[0],
        GUARD_ADDRESS,
        `the clipboard must receive the full address, got ${JSON.stringify(texts[0])}`,
      );
      assert.equal(
        texts[0]?.length,
        56,
        "a guard address is 56 characters — a shorter copy is the bug",
      );
      // Context-in-label: the accessible name says WHAT is copied, not just "Copy".
      assert.equal(mounted.button.getAttribute("aria-label"), "Copy guard address");
      // Success parity: the user-action result is announced through the shared channel.
      assert.equal(
        pendingAnnouncements().filter((entry) => entry.message === "Copied").length,
        1,
        "a successful copy announces 'Copied' once",
      );
    } finally {
      await mounted.unmount();
    }
  });
});

test("arg-exactness: the FULL 64-hex transaction hash reaches writeText", async () => {
  clearAnnouncements();
  const { texts, writer } = capturingWriter();
  await withClipboard(writer, async () => {
    const mounted = await mountCopyButton(TX_HASH, "transaction hash");
    try {
      await act(async () => {
        mounted.button.click();
        await sleep(0);
      });
      assert.equal(texts[0], TX_HASH, "the clipboard must receive the full hash");
      assert.equal(texts[0]?.length, 64, "a transaction hash is 64 hex characters");
      assert.equal(mounted.button.getAttribute("aria-label"), "Copy transaction hash");
    } finally {
      await mounted.unmount();
    }
  });
});

test("success feedback: announce once, ✓ swap, deterministic revert, then re-announce on a second copy", async () => {
  // Fake timers, the repo's established deterministic-clock mechanism
  // (tests/unit/useToast.test.ts drives its auto-dismiss with mock.timers).
  // `Date` is mocked too so the second copy advances past the announcer's
  // duplicate window — time moves between the two user actions, exactly as it
  // would on a real desk.
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  clearAnnouncements();
  // Count *accepted* announcements by the distinct times the channel stamped
  // them: the mounted `<AriaAnnouncer />` drains each message as it is spoken,
  // which these tests simulate with `shiftAnnouncement()` between copies.
  const acceptedCopiedAt = new Set<number>();
  const unsubscribe = subscribeAnnouncements((queue) => {
    for (const entry of queue) {
      if (entry.message === "Copied") acceptedCopiedAt.add(entry.at);
    }
  });
  const { writer } = capturingWriter();
  await withClipboard(writer, async () => {
    const mounted = await mountCopyButton(GUARD_ADDRESS, "guard address");
    try {
      await act(async () => {
        mounted.button.click();
        mock.timers.tick(0);
      });
      assert.equal(mounted.button.textContent, "Copied ✓", "the button swaps to the confirmation");
      assert.equal(
        pendingAnnouncements().filter((entry) => entry.message === "Copied").length,
        1,
        "the first copy announces once",
      );

      // The announcer speaks the message; simulate the drain it performs.
      shiftAnnouncement();
      // The revert is deterministic: exactly at the feedback window it is back.
      await act(async () => {
        mock.timers.tick(COPIED_FEEDBACK_MS);
      });
      assert.equal(mounted.button.textContent, "Copy", "the button reverts after the window");

      // Copies are per-click, never merged: with the queue drained and time
      // advanced past the duplicate window, the second copy announces again.
      await act(async () => {
        mounted.button.click();
        mock.timers.tick(0);
      });
      assert.equal(
        acceptedCopiedAt.size,
        2,
        "each user-initiated copy announces its own result — debounce, not sticky-suppression",
      );
      assert.equal(mounted.button.textContent, "Copied ✓");
    } finally {
      unsubscribe();
      mock.timers.reset();
      await mounted.unmount();
    }
  });
});

test("failure path: rejecting writeText → manual-select hint visible + announce('Copy failed') once", async () => {
  clearAnnouncements();
  // The insecure-context simulation: the write rejects, as it does over plain
  // http or a denied permission. No silent failure is permitted.
  await withClipboard(
    {
      writeText: async () => {
        throw new Error("write permission denied");
      },
    },
    async () => {
      const mounted = await mountCopyButton(GUARD_ADDRESS, "guard address");
      try {
        await act(async () => {
          mounted.button.click();
          await sleep(0);
        });
        // Double assert: the hint is failure-visible in the DOM, and the
        // failure is announced at parity with success.
        const hint = mounted.container.querySelector('[role="alert"]');
        assert.ok(hint, "a failed copy must render the manual-select hint");
        assert.match(hint.textContent ?? "", /select the value manually/);
        assert.equal(
          pendingAnnouncements().filter((entry) => entry.message === "Copy failed").length,
          1,
          "the failure is announced exactly once",
        );
        assert.equal(mounted.button.textContent, "Copy", "no success swap on failure");
      } finally {
        await mounted.unmount();
      }
    },
  );
});

test("focus retention + repeat flow: the button keeps focus, and copying again needs no re-tab", async () => {
  clearAnnouncements();
  let copies = 0;
  await withClipboard(
    {
      writeText: async () => {
        copies += 1;
      },
    },
    async () => {
      const mounted = await mountCopyButton(GUARD_ADDRESS, "guard address");
      try {
        // Click path: focus must not be stolen by the copy.
        mounted.button.focus();
        await act(async () => {
          mounted.button.click();
          await sleep(0);
        });
        assert.equal(
          document.activeElement,
          mounted.button,
          "the button stays the active element after a copy",
        );

        // Flow continuity: a keyboard operator presses the still-focused
        // button again and the write happens again — no re-tabbing, no
        // focus lost to the confirmation state.
        await act(async () => {
          mounted.button.click();
          await sleep(0);
        });
        assert.equal(copies, 2, "the operator can re-copy without re-tabbing");
        assert.equal(document.activeElement, mounted.button);
        // The copy control is a real button — keyboard-operable by default.
        assert.equal(mounted.button.tagName, "BUTTON");
      } finally {
        await mounted.unmount();
      }
    },
  );
});

test("the pure core: arg capture, rejection shape, and the missing-clipboard failure", async () => {
  // Capturing writer — the arg passes through untouched.
  const { texts, writer } = capturingWriter();
  await copyToClipboard(GUARD_ADDRESS, writer);
  assert.equal(texts[0], GUARD_ADDRESS);
  assert.equal(texts[0]?.length, 56);

  // A rejecting writer degrades to { ok: false } rather than throwing.
  const rejected = await copyToClipboard("x", {
    writeText: async () => {
      throw new Error("not allowed");
    },
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.match(rejected.error, /not allowed/);

  // No clipboard at all (the real insecure-context case) is the same failure shape.
  await withClipboard(null, async () => {
    const unavailable = await copyToClipboard("y");
    assert.equal(unavailable.ok, false);
    if (!unavailable.ok)
      assert.match(unavailable.error, /not secure or has denied clipboard access/);
    // The channel helper stays importable and callable for component parity.
    assert.equal(typeof announce, "function");
  });
});

test("security: CopyButton redacts secret-like values and credentials before clipboard write", async () => {
  const SECRET_SEED = "SDBQH7YJ7J4WQ7YJ7J4WQ7YJ7J4WQ7YJ7J4WQ7YJ7J4WQ7YJ7J4WQAA";
  const BASIC_AUTH_URL = "https://admin:supersecretpassword@rpc.testnet.stellar.org";
  const TOKEN_URL = "https://horizon.stellar.org?apiKey=super_secret_token_12345&foo=bar";
  const BEARER_TEXT = "Error during submission: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";

  const { texts, writer } = capturingWriter();

  await withClipboard(writer, async () => {
    // 1. Secret seed is redacted
    const mounted1 = await mountCopyButton(`Failed with key: ${SECRET_SEED}`, "error with secret");
    try {
      await act(async () => {
        mounted1.button.click();
        await sleep(0);
      });
      assert.ok(!texts[0]?.includes(SECRET_SEED), "secret seed must be absent from clipboard");
      assert.ok(texts[0]?.includes("[REDACTED]"), "secret seed must be replaced with [REDACTED]");
    } finally {
      await mounted1.unmount();
    }

    // 2. URL password is redacted
    const mounted2 = await mountCopyButton(BASIC_AUTH_URL, "url with auth");
    try {
      await act(async () => {
        mounted2.button.click();
        await sleep(0);
      });
      assert.ok(!texts[1]?.includes("supersecretpassword"), "URL password must be absent");
      assert.ok(texts[1]?.includes(":[REDACTED]@"), "URL password replaced with [REDACTED]");
    } finally {
      await mounted2.unmount();
    }

    // 3. Query token is redacted
    const mounted3 = await mountCopyButton(TOKEN_URL, "url with token");
    try {
      await act(async () => {
        mounted3.button.click();
        await sleep(0);
      });
      assert.ok(!texts[2]?.includes("super_secret_token_12345"), "query secret must be absent");
      assert.ok(texts[2]?.includes("apiKey=[REDACTED]"), "query param replaced with [REDACTED]");
    } finally {
      await mounted3.unmount();
    }

    // 4. Bearer token is redacted
    const mounted4 = await mountCopyButton(BEARER_TEXT, "bearer header");
    try {
      await act(async () => {
        mounted4.button.click();
        await sleep(0);
      });
      assert.ok(
        !texts[3]?.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"),
        "bearer token must be absent",
      );
      assert.ok(texts[3]?.includes("Bearer [REDACTED]"), "bearer replaced with [REDACTED]");
    } finally {
      await mounted4.unmount();
    }
  });
});
