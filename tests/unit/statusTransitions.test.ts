/**
 * Poll transitions: what the chain did while nobody was looking.
 *
 * The property under test is restraint. A poll runs on a timer, forever, and
 * every announcement it makes costs the operator whatever they were reading —
 * so the announcer has to say nothing at all in the common case (a poll that
 * re-reads the same state) and everything at once in the rare one (a flag the
 * operator acts on flipped while the tab was in the background).
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { GuardSnapshot } from "../../lib/guard/guardOps.ts";
import {
  CORROBORATION_WINDOW_MS,
  createStatusAnnouncer,
  flagsFromSnapshot,
  noteVerifiedOutcome,
  resetVerifiedOutcome,
  transitionCopy,
  transitionsBetween,
  type AnnounceSink,
  type StatusFlags,
  type StatusTransition,
} from "../../lib/guard/statusTransitions.ts";

const GUARD_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const GUARD_B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

interface Flags {
  adminFrozen: boolean;
  heartbeatExpired: boolean;
  hasPolicy: boolean;
}

const CLEAR: Flags = { adminFrozen: false, heartbeatExpired: false, hasPolicy: true };

function snapshot(flags: Partial<Flags>, guard = GUARD_A): GuardSnapshot {
  const status = { ...CLEAR, ...flags };
  return {
    guard,
    status: {
      ok: true,
      value: {
        admin_frozen: status.adminFrozen,
        heartbeat_expired: status.heartbeatExpired,
        has_policy: status.hasPolicy,
      },
    },
  } as unknown as GuardSnapshot;
}

function failedSnapshot(guard = GUARD_A): GuardSnapshot {
  return { guard, status: { ok: false, error: "network unreachable" } } as unknown as GuardSnapshot;
}

interface Harness {
  announcer: ReturnType<typeof createStatusAnnouncer>;
  spoken: { message: string; priority: string }[];
  now: () => number;
  at: (ms: number) => void;
  travel: (ms: number) => void;
}

function harness(start = 0): Harness {
  const spoken: { message: string; priority: string }[] = [];
  let clock = start;
  const emit: AnnounceSink = (message, priority) => {
    spoken.push({ message, priority: priority ?? "polite" });
  };
  return {
    announcer: createStatusAnnouncer({ emit, now: () => clock }),
    spoken,
    now: () => clock,
    at(ms) {
      clock = ms;
    },
    travel(ms) {
      clock += ms;
    },
  };
}

beforeEach(() => {
  resetVerifiedOutcome();
});

test("a failed read is not a state, and not a change either", () => {
  assert.deepEqual(flagsFromSnapshot(failedSnapshot()), {
    adminFrozen: null,
    heartbeatExpired: null,
    hasPolicy: null,
  });
  assert.deepEqual(flagsFromSnapshot(null), {
    adminFrozen: null,
    heartbeatExpired: null,
    hasPolicy: null,
  });
  // A transition into or out of "unknown" would be invented, not observed.
  const unknown: StatusFlags = { adminFrozen: null, heartbeatExpired: null, hasPolicy: null };
  assert.deepEqual(transitionsBetween(unknown, { ...CLEAR }), []);
  assert.deepEqual(transitionsBetween(CLEAR, unknown), []);
});

test("the first poll is a baseline, not news", () => {
  const h = harness();
  // The account is already frozen and the operator has just opened the page:
  // they can read that on the panel, and hearing it too would be noise about a
  // state they are looking at.
  assert.deepEqual(h.announcer.observe(snapshot({ adminFrozen: true })), []);
  assert.deepEqual(h.spoken, []);
});

test("a poll that re-reads the same state announces nothing, however often it runs", () => {
  const h = harness();
  h.announcer.observe(snapshot({}));
  for (let poll = 0; poll < 50; poll += 1) {
    assert.deepEqual(h.announcer.observe(snapshot({})), [], `poll ${poll} found no change`);
    h.travel(15_000);
  }
  assert.deepEqual(
    h.spoken,
    [],
    "a timer that repeats itself is the firehose this rule exists to prevent",
  );
});

test("a freeze nobody performed is announced", () => {
  const h = harness();
  h.announcer.observe(snapshot({}));
  h.travel(15_000);
  // Another tab, a script, or an operator with a different wallet: the console
  // did not do this and knows nothing about it but the flag.
  assert.deepEqual(h.announcer.observe(snapshot({ adminFrozen: true })), ["frozen"]);
  assert.deepEqual(h.spoken, [
    { message: `On-chain state: the account is frozen for guard ${GUARD_A}`, priority: "polite" },
  ]);
});

test("the poll does not repeat a freeze the console already announced and verified", () => {
  const h = harness();
  h.announcer.observe(snapshot({}));
  // The panic button re-read `status()` after the write, announced "Account
  // frozen", and recorded the outcome. The next poll sees the same fact arrive
  // by a slower route.
  noteVerifiedOutcome({ adminFrozen: true }, h.now());
  h.travel(2_000);
  assert.deepEqual(h.announcer.observe(snapshot({ adminFrozen: true })), []);
  assert.deepEqual(h.spoken, [], "one fact, one utterance");
});

test("a reversal is announced even inside the corroboration window", () => {
  const h = harness();
  h.announcer.observe(snapshot({}));
  noteVerifiedOutcome({ adminFrozen: true }, h.now());
  h.travel(1_000);
  h.announcer.observe(snapshot({ adminFrozen: true }));
  assert.deepEqual(h.spoken, [], "the console's own write is not repeated");

  // Something cleared the flag a second later. That is the opposite of what the
  // operator's write was supposed to produce, and it is the case the whole
  // transition announcer exists for.
  h.travel(1_000);
  assert.deepEqual(h.announcer.observe(snapshot({ adminFrozen: false })), ["unfrozen"]);
  assert.deepEqual(h.spoken.at(-1), {
    message: `On-chain state: the account is no longer frozen for guard ${GUARD_A}`,
    priority: "polite",
  });
});

test("a transition long after the write is announced again", () => {
  const h = harness();
  h.announcer.observe(snapshot({}));
  noteVerifiedOutcome({ adminFrozen: false }, h.now());
  h.travel(CORROBORATION_WINDOW_MS + 1_000);
  h.announcer.observe(snapshot({ adminFrozen: true }));
  assert.deepEqual(h.spoken.length, 1, "minutes later, a freeze is news again");
});

test("an unfreeze also stops the dead-man switch, and both are the operator's own doing", () => {
  const h = harness();
  h.announcer.observe(snapshot({ heartbeatExpired: true }));
  // `unfreeze()` clears the flag and restarts the heartbeat clock, so the switch
  // stopping is a consequence of the write the console just verified.
  noteVerifiedOutcome({ adminFrozen: false }, h.now());
  h.travel(1_000);
  assert.deepEqual(
    h.announcer.observe(snapshot({ heartbeatExpired: false })),
    [],
    "the operator already heard the outcome of their own unfreeze",
  );
  assert.deepEqual(h.spoken, []);
});

test("the dead-man switch firing is always announced, assertively", () => {
  const h = harness();
  h.announcer.observe(snapshot({}));
  h.travel(30_000);
  assert.deepEqual(h.announcer.observe(snapshot({ heartbeatExpired: true })), ["dead-man-fired"]);
  assert.equal(h.spoken[0]?.priority, "assertive");
  assert.match(h.spoken[0]?.message ?? "", /dead-man switch has fired/);
  assert.match(h.spoken[0]?.message ?? "", /refusing calls/);
});

test("a policy disappearing interrupts, because the account just went to default deny", () => {
  const h = harness();
  h.announcer.observe(snapshot({ hasPolicy: true }));
  h.travel(15_000);
  assert.deepEqual(h.announcer.observe(snapshot({ hasPolicy: false })), ["policy-removed"]);
  assert.equal(h.spoken[0]?.priority, "assertive");
  assert.match(h.spoken[0]?.message ?? "", /default deny/);
});

test("an outage does not become a transition when the read comes back", () => {
  const h = harness();
  h.announcer.observe(snapshot({}));
  assert.deepEqual(h.announcer.observe(failedSnapshot()), []);
  assert.deepEqual(h.announcer.observe(null), []);
  // The account was frozen and unfrozen entirely inside the outage. The console
  // cannot know that, so it announces the state it can see, once.
  assert.deepEqual(h.announcer.observe(snapshot({ adminFrozen: false })), []);
  assert.deepEqual(h.spoken, []);
  h.travel(1_000);
  assert.deepEqual(h.announcer.observe(snapshot({ adminFrozen: true })), ["frozen"]);
});

test("switching guards re-establishes the baseline instead of reporting a change", () => {
  const h = harness();
  h.announcer.observe(snapshot({}));
  h.travel(1_000);
  // A different account, frozen, selected from the address book. Comparing it
  // against the previous guard's flags would announce a freeze that never
  // happened on either account.
  assert.deepEqual(h.announcer.observe(snapshot({ adminFrozen: true }, GUARD_B)), []);
  assert.deepEqual(h.spoken, []);
  h.travel(1_000);
  assert.deepEqual(h.announcer.observe(snapshot({ adminFrozen: false }, GUARD_B)), ["unfrozen"]);
});

test("every flip in a single poll is announced, most urgent first", () => {
  const h = harness();
  h.announcer.observe(snapshot({ hasPolicy: true }));
  h.travel(15_000);
  // One poll, three flips: the dead-man switch fired, the policy went with it,
  // and an admin freeze landed on top.
  const transitions: StatusTransition[] = h.announcer.observe(
    snapshot({ adminFrozen: true, heartbeatExpired: true, hasPolicy: false }),
  );
  assert.deepEqual(transitions, ["frozen", "dead-man-fired", "policy-removed"]);
  assert.deepEqual(
    h.spoken.map((item) => item.priority),
    ["polite", "assertive", "assertive"],
  );
});

test("a transition announcement names the guard whose chain state changed", () => {
  const h = harness();
  h.announcer.observe(snapshot({ adminFrozen: false }, GUARD_B));
  h.announcer.observe(snapshot({ adminFrozen: true }, GUARD_B));
  assert.match(h.spoken[0]?.message ?? "", new RegExp(GUARD_B));
});

test("each transition has copy, and every message names the state it is about", () => {
  const all: StatusTransition[] = [
    "frozen",
    "unfrozen",
    "dead-man-fired",
    "dead-man-cleared",
    "policy-installed",
    "policy-removed",
  ];
  for (const transition of all) {
    const spoken = transitionCopy(transition);
    assert.match(spoken.message, /^On-chain state: /, `${transition} must be attributable`);
    assert.ok(
      spoken.priority === "polite" || spoken.priority === "assertive",
      `${transition} must declare a priority`,
    );
  }
  // Incidents interrupt; the operator's own writes do not.
  assert.equal(transitionCopy("dead-man-fired").priority, "assertive");
  assert.equal(transitionCopy("policy-removed").priority, "assertive");
  assert.equal(transitionCopy("frozen").priority, "polite");
  assert.equal(transitionCopy("unfrozen").priority, "polite");
});
