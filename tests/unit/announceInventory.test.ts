/**
 * The inventory of what the console speaks about operator actions (issue #30).
 *
 * An announcement is only useful if it is the *right* one, and it is only
 * maintainable if there is a list to check. This file is that list, asserted
 * rather than described:
 *
 *   1. Every message a screen reader hears about an operation outcome is built
 *      in one module, so a translation pass has one file to walk and a reviewer
 *      can see the whole vocabulary in one screen.
 *   2. Every template is wired to a real call site. A template nobody calls is
 *      either a bug or dead weight, and both should fail here.
 *   3. A failure never speaks without its reason.
 *   4. There is exactly one place in the codebase that writes into a live
 *      region imperatively. Everything else announces through the queue, which
 *      is what supplies the deduplication, the ordering and the cap.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  freezeConfirmed,
  freezeFailed,
  freezeSubmitted,
  policyConfirmed,
  policyFailed,
  streamPaused,
  streamResumed,
  writeFailureReason,
  type FreezeAction,
  type PolicyOperation,
} from "../../lib/guard/announceCopy.ts";
import { transitionCopy, type StatusTransition } from "../../lib/guard/statusTransitions.ts";
import { blockedBatchMessage } from "../../lib/guard/blockedEvents.ts";

/** Every source file the inventory is asserted against. */
function sourcesIn(...dirs: string[]): { path: string; text: string }[] {
  const found: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      found.push({ path: path.replace(/\\/g, "/"), text: readFileSync(path, "utf8") });
    }
  };
  for (const dir of dirs) walk(dir);
  return found;
}

const SOURCES = sourcesIn("components", "lib/guard", "app");

/** The text of every source except the one that defines the template. */
function callSites(definedIn: string): string {
  return SOURCES.filter((file) => file.path !== definedIn)
    .map((file) => file.text)
    .join("\n");
}

const ANNOUNCE_COPY = "lib/guard/announceCopy.ts";
const FREEZE_ACTIONS: FreezeAction[] = ["freeze", "unfreeze"];
const POLICY_OPERATIONS: PolicyOperation[] = ["set_policy", "revoke_policy"];

test("every operation outcome has a template, and each is wired to a call site", () => {
  // The rows issue #30 asks for. A template that is not in this table is not an
  // inventory; a row here with no call site is dead code that pretends to be a
  // feature.
  const templates: { what: string; used: boolean }[] = [
    { what: "freeze confirmed", used: callSites(ANNOUNCE_COPY).includes("freezeConfirmed(") },
    {
      what: "freeze failed with its reason",
      used: callSites(ANNOUNCE_COPY).includes("freezeFailed("),
    },
    { what: "unfreeze confirmed", used: callSites(ANNOUNCE_COPY).includes("freezeConfirmed(") },
    {
      what: "policy install confirmed",
      used: callSites(ANNOUNCE_COPY).includes("policyConfirmed("),
    },
    {
      what: "policy install failed with its reason",
      used: callSites(ANNOUNCE_COPY).includes("policyFailed("),
    },
    { what: "feed paused", used: callSites(ANNOUNCE_COPY).includes("streamPaused(") },
    {
      what: "feed resumed, with what was queued",
      used: callSites(ANNOUNCE_COPY).includes("streamResumed("),
    },
    {
      what: "a broadcast freeze nobody verified",
      used: callSites(ANNOUNCE_COPY).includes("freezeSubmitted("),
    },
    {
      what: "the reason a write failed",
      used: callSites(ANNOUNCE_COPY).includes("writeFailureReason("),
    },
    {
      what: "an on-chain state transition",
      used: callSites("lib/guard/statusTransitions.ts").includes("useStatusTransitionAnnouncer("),
    },
    {
      what: "a batch of blocked decisions",
      used: callSites("lib/guard/blockedEvents.ts").includes("blockedBatchMessage("),
    },
  ];
  for (const row of templates) {
    assert.equal(row.used, true, `"${row.what}" has no call site: the template is dead code`);
  }
  assert.ok(templates.length >= 6, "the inventory covers at least the six rows the issue lists");
});

test("every message in the inventory is built in a copy module, not in a component", () => {
  // The strings themselves must not appear as literals in a component: a
  // hand-typed "Account frozen" in a handler is a string no inventory can see.
  // Comments are stripped first, so the reasoning *about* a message can name it
  // while the code that speaks it cannot. Only whole-line and block comments are
  // removed, which is the conservative direction: a stray trailing comment
  // containing a quoted message would fail the scan rather than hide a literal.
  const stripComments = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");

  const components = SOURCES.filter((file) => file.path.startsWith("components/"));
  const literals: string[] = [
    "Account frozen",
    "Account unfrozen",
    "Freeze failed",
    "Unfreeze failed",
    "Policy install failed",
    "new blocked event",
    "dead-man switch has fired",
  ];
  for (const file of components) {
    const code = stripComments(file.text);
    for (const literal of literals) {
      assert.equal(
        code.includes(`"${literal}`) ||
          code.includes(`'${literal}`) ||
          code.includes(`\`${literal}`),
        false,
        `${file.path} builds the message "${literal}" itself; it belongs in a copy module`,
      );
    }
  }
});

test("a freeze speaks the operator's words, and only once the chain agrees", () => {
  assert.deepEqual(freezeConfirmed("freeze"), { message: "Account frozen", priority: "polite" });
  assert.deepEqual(freezeConfirmed("unfreeze"), {
    message: "Account unfrozen",
    priority: "polite",
  });
  // The one assertive freeze is the one with no chain re-read behind it.
  assert.deepEqual(freezeSubmitted(), {
    message: "Admin freeze activated",
    priority: "assertive",
  });
  // Nothing in the low-level write path claims a freeze any more: the effect is
  // claimed by whoever verified it, so a freeze is never announced twice.
  const submit = SOURCES.find((file) => file.path === "lib/guard/submit.ts")?.text ?? "";
  assert.equal(
    /fn === "freeze"/.test(submit) && /announce\(/.test(submit.split('fn === "freeze"')[1] ?? ""),
    false,
    "submit.ts must not announce a freeze it never verified",
  );
});

test("action outcomes identify the guard without changing their urgency", () => {
  const guard = "C123456789";
  assert.deepEqual(freezeConfirmed("freeze", guard), {
    message: `Account frozen for guard ${guard}`,
    priority: "polite",
  });
  assert.deepEqual(freezeFailed("freeze", "RPC rejected the write", guard), {
    message: `Freeze failed: RPC rejected the write for guard ${guard}`,
    priority: "assertive",
  });
  assert.deepEqual(policyFailed("set_policy", "simulation refused", guard), {
    message: `Policy install failed: simulation refused for guard ${guard}`,
    priority: "assertive",
  });
});

test("a failure always carries its reason, assertively", () => {
  for (const action of FREEZE_ACTIONS) {
    const spoken = freezeFailed(
      action,
      "status().admin_frozen reads false — the effect is not on chain",
    );
    assert.equal(spoken.priority, "assertive", "a failure interrupts: it is not news for later");
    assert.match(
      spoken.message,
      new RegExp(`^${action === "freeze" ? "Freeze" : "Unfreeze"} failed: `),
    );
    assert.ok(
      spoken.message.length > "Freeze failed: ".length,
      "a failure with nothing after it tells the operator strictly less than the screen does",
    );
  }
  for (const operation of POLICY_OPERATIONS) {
    const spoken = policyFailed(operation, "refused during simulation: per_tx_cap_exceeded");
    assert.equal(spoken.priority, "assertive");
    assert.match(
      spoken.message,
      new RegExp(`^${operation === "set_policy" ? "Policy install" : "Policy revoke"} failed: `),
    );
  }
  assert.deepEqual(policyConfirmed("set_policy"), {
    message: "Policy installed on chain",
    priority: "polite",
  });
  assert.deepEqual(policyConfirmed("revoke_policy"), {
    message: "Policy revoked; the account is back to default deny",
    priority: "polite",
  });
});

test("the same write failure is worded the same way everywhere", () => {
  const refused = {
    kind: "refused",
    stage: "simulation",
    detail: "per_tx_cap_exceeded",
  } as never;
  const failed = { kind: "failed", detail: "tx_too_early", hash: "abc" } as never;
  const exported = { kind: "exported", xdr: "AAAA" } as never;

  assert.equal(
    writeFailureReason(refused, "unused"),
    "refused during simulation: per_tx_cap_exceeded",
  );
  assert.equal(
    writeFailureReason(failed, "unused"),
    "the network rejected the transaction: tx_too_early",
  );
  assert.match(writeFailureReason(exported, "unused"), /offline signing/);
  // A write that was included but changed nothing is the case the result type
  // cannot speak for, so the caller's own explanation is used.
  assert.equal(
    writeFailureReason({ kind: "submitted" } as never, "status() disagreed with the write"),
    "status() disagreed with the write",
  );
});

test("pausing and resuming the feed are announced once, with the queue depth", () => {
  assert.deepEqual(streamPaused(), {
    message: "Stream paused; the table is frozen while polling continues",
    priority: "polite",
  });
  assert.deepEqual(streamResumed(0), {
    message: "Stream resumed; no events were queued",
    priority: "polite",
  });
  assert.deepEqual(streamResumed(1), {
    message: "Stream resumed with 1 queued event",
    priority: "polite",
  });
  assert.deepEqual(streamResumed(7), {
    message: "Stream resumed with 7 queued events",
    priority: "polite",
  });
  // The number the operator heard must be the number that was queued, so it is
  // read before the buffer is drained. `onResume` in TelemetryFeed does that,
  // and the paused notice is not a live region for exactly this reason.
  const feed = SOURCES.find((file) => file.path === "components/TelemetryFeed.tsx")?.text ?? "";
  assert.equal(
    /aria-live/.test(feed),
    false,
    "the feed must not keep its own live region: the queue is the only channel",
  );
});

test("a blocked batch is announced as a count, assertively, and is greppable", () => {
  assert.equal(blockedBatchMessage(1), "1 new blocked event");
  assert.equal(blockedBatchMessage(10), "10 new blocked events");
  // The badge's visible text and the spoken text are the same string, so the
  // operator can check one against the other.
  const badge =
    SOURCES.find((file) => file.path === "components/BlockedEventBadge.tsx")?.text ?? "";
  assert.match(badge, /blockedBatchMessage\(pending\)/);
});

test("an on-chain transition is attributable and declares its urgency", () => {
  for (const transition of [
    "frozen",
    "unfrozen",
    "dead-man-fired",
    "dead-man-cleared",
    "policy-installed",
    "policy-removed",
  ] as StatusTransition[]) {
    const spoken = transitionCopy(transition);
    assert.match(spoken.message, /^On-chain state: /, `${transition} must say where it came from`);
  }
});

test("there is exactly one imperative live-region writer, and it is the announcer", () => {
  // React re-rendering a `role="status"` element is fine and is how most of the
  // panels report validation. What is not fine is a second, hand-rolled channel
  // that writes text into a live region behind the queue's back: it would
  // bypass the deduplication, the ordering and the cap, and it is the failure
  // mode this inventory exists to prevent.
  const writers = SOURCES.filter((file) => /\.textContent\s*=|\.innerHTML\s*=/.test(file.text)).map(
    (file) => file.path,
  );
  assert.deepEqual(
    writers,
    ["components/AriaAnnouncer.tsx"],
    "only the shell's announcer may write into a live region; everything else calls announce()",
  );
});

test("every announcement leaves through the queue, not through a component-local region", () => {
  // Every entry here was checked to hold a live region whose text React re-renders
  // from component state — a chart readout, a toast viewport, an on-page value.
  // That is the correct pattern for state the page already displays, and it is not
  // what this rule is about. `role="status"` elements are exempt for the same
  // reason. What the rule is about is a component that speaks about an operator
  // action: it must call announce(), so the queue gives it deduplication, ordering
  // and the cap. A new entry is a judgement to make deliberately, not a list to
  // widen when it goes red.
  const liveRegions = SOURCES.filter((file) => /aria-live=/.test(file.text)).map(
    (file) => file.path,
  );
  assert.deepEqual(liveRegions.sort(), [
    "components/AriaAnnouncer.tsx",
    "components/HardwareWalletGuide.tsx",
    "components/StatusPanel.tsx",
    "components/StorageExplorer.tsx",
    "components/TelemetryChart.tsx",
    "components/ToastContainer.tsx",
  ]);
});

test("the announcer is mounted in the page shell, not inside a dialog", () => {
  // An announcement that lives inside the element being torn down is an
  // announcement the operator never hears. The one rule that makes "outlives the
  // dialog" true is that the region is a sibling of every panel, mounted once at
  // the root, and this asserts that structurally.
  const layout = readFileSync("app/layout.tsx", "utf8");
  assert.match(layout, /<AriaAnnouncer\s*\/>/, "the root layout must mount the announcer");
  assert.equal(
    /PanicPanel|PolicyForm|TelemetryFeed|Dialog|Modal/.test(layout),
    false,
    "the announcer must not be mounted inside anything that opens or closes",
  );
  // It is mounted in the layout, i.e. outside the routes, so navigating between
  // pages does not replace it either.
  const component = readFileSync("components/AriaAnnouncer.tsx", "utf8");
  assert.match(component, /aria-live="polite"/);
  assert.match(component, /aria-live="assertive"/);
  assert.match(component, /aria-atomic="true"/, "each region must be read as one message");
  assert.match(
    component,
    /visually-hidden/,
    "the regions are for screen readers, not for the page",
  );
});
