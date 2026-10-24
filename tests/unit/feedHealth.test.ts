/**
 * Poll health (issue #311).
 *
 * Every case here pins one of the distinctions the issue asks for: an empty
 * result is not a failure, a failure is not an absence of traffic, and a feed
 * that stopped answering is not merely quiet. The clock is a parameter
 * (`nowMs`), so none of this needs a timer, a sleep, or an RPC.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  OVERDUE_INTERVALS,
  POLL_OFF,
  POLL_OFF_TEXT,
  pollHealth,
  type PollHealthInput,
} from "../../lib/guard/feedHealth.ts";

/** A fixed clock: the whole point of the parameter is that these stay exact. */
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const INTERVAL = 5_000;

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function health(overrides: Partial<PollHealthInput> = {}) {
  return pollHealth({
    watching: true,
    polling: false,
    lastSuccessAt: iso(-2_000),
    lastAttemptAt: iso(-2_000),
    lastFailureAt: null,
    error: null,
    eventsInLastRound: 3,
    nowMs: NOW,
    intervalMs: INTERVAL,
    ...overrides,
  });
}

describe("an empty result stays distinct from a failed or overdue poll", () => {
  test("a quiet guard is healthy, and its emptiness is explained as traffic — not as a fault", () => {
    const quiet = health({ eventsInLastRound: 0 });
    assert.equal(quiet.phase, "healthy");
    assert.equal(quiet.tone, "ok");
    assert.equal(quiet.emptyIsFault, false, "an empty round from a live feed implies no problem");
    assert.match(quiet.text, /returned no events/);
    assert.match(quiet.text, /normal for a quiet guard/);
  });

  test("a failed round reads differently from that same empty table", () => {
    const failed = health({
      eventsInLastRound: 0,
      lastSuccessAt: iso(-60_000),
      lastFailureAt: iso(-5_000),
      lastAttemptAt: iso(-5_000),
      error: "getEvents timed out",
    });
    assert.equal(failed.phase, "failing");
    assert.equal(failed.tone, "danger");
    assert.equal(failed.emptyIsFault, true);
    assert.match(failed.text, /last poll failed/);
    assert.equal(failed.error, "getEvents timed out", "the error is passed through for display");
    assert.notEqual(
      failed.text,
      health({ eventsInLastRound: 0 }).text,
      "the two emptinesses must never be described with one sentence",
    );
  });

  test("a feed that stopped answering is overdue, which is also not the quiet case", () => {
    const stale = health({ lastSuccessAt: iso(-(OVERDUE_INTERVALS * INTERVAL + 10_000)) });
    assert.equal(stale.phase, "overdue");
    assert.equal(stale.tone, "warn");
    assert.equal(stale.emptyIsFault, true);
    assert.match(stale.text, /No poll has landed/);
    assert.match(stale.text, /not updating/);
  });

  test("the header never reports `ok` for a failing or overdue feed", () => {
    assert.notEqual(health({ error: "boom", lastFailureAt: iso(-1_000) }).tone, "ok");
    assert.notEqual(health({ lastSuccessAt: iso(-9 * INTERVAL) }).tone, "ok");
  });
});

describe("recovery after a polling failure", () => {
  test("one successful round clears the failure even when it delivers no events", () => {
    const recovered = health({
      eventsInLastRound: 0,
      // The failure happened, then a later round returned an empty page.
      lastFailureAt: iso(-30_000),
      lastSuccessAt: iso(-4_000),
      error: "getEvents timed out",
    });
    assert.equal(recovered.phase, "healthy");
    assert.equal(recovered.tone, "ok");
    assert.equal(recovered.emptyIsFault, false);
    assert.equal(
      recovered.error,
      "getEvents timed out",
      "the last error is still carried, so the operator can see what broke",
    );
  });

  test("a failure at the same instant as the success still counts as a failure", () => {
    // `>=` is deliberate: when both stamps land together the safe reading is the
    // pessimistic one — a round that both returned and errored delivered nothing.
    const tied = health({ lastSuccessAt: iso(-5_000), lastFailureAt: iso(-5_000), error: "500" });
    assert.equal(tied.phase, "failing");
  });

  test("an older failure does not outrank a newer success", () => {
    const after = health({ lastSuccessAt: iso(-3_000), lastFailureAt: iso(-90_000) });
    assert.equal(after.phase, "healthy");
  });
});

describe("in-progress state", () => {
  test("a round in flight before the first success says so, in words that differ from idle", () => {
    const inFlight = health({ lastSuccessAt: null, lastAttemptAt: iso(-1_000), polling: true });
    assert.equal(inFlight.phase, "pending");
    assert.equal(inFlight.tone, "warn");
    assert.equal(inFlight.polling, true, "the in-flight flag is carried through independently");
    assert.match(inFlight.text, /Waiting for the first poll/);

    const idle = health({ lastSuccessAt: null, lastAttemptAt: null, polling: false });
    assert.equal(idle.phase, "pending");
    assert.equal(idle.tone, "muted");
    assert.match(idle.text, /no poll has completed yet/);
    assert.notEqual(idle.text, inFlight.text);
  });

  test("overdue still mentions an in-flight round, because 'behind' and 'stopped' differ", () => {
    const running = health({ lastSuccessAt: iso(-10 * INTERVAL), polling: true });
    assert.equal(running.phase, "overdue");
    assert.match(running.text, /currently in flight/);
    assert.doesNotMatch(running.text, /not updating/);
  });
});

describe("the two stamps are never collapsed", () => {
  test("an attempt stamp alone never satisfies the last-success clause", () => {
    // Regression this module exists for: before #311 one field (`lastPolledAt`)
    // was written on both paths, so "last poll 5s ago" was true of a feed whose
    // every poll had failed since the first.
    const attemptedOnly = health({
      lastSuccessAt: null,
      lastAttemptAt: iso(-2_000),
      polling: true,
    });
    assert.equal(attemptedOnly.phase, "pending");
    assert.notEqual(attemptedOnly.phase, "healthy");
    assert.equal(attemptedOnly.lastSuccessAt, null);
  });

  test("POLL_OFF is what the evaluator says about a feed with no state at all", () => {
    const cold = health({
      watching: false,
      polling: false,
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastFailureAt: null,
      error: null,
      eventsInLastRound: 0,
    });
    assert.equal(cold.phase, POLL_OFF.phase);
    assert.equal(cold.text, POLL_OFF.text);
    assert.equal(cold.tone, POLL_OFF.tone);
    assert.equal(POLL_OFF.text, POLL_OFF_TEXT);
  });

  test("a stopped feed is stopped, even while remembering a failure", () => {
    // Precedence: `off` outranks everything, because "not watching" explains the
    // silence better than the last error the feed happened to hit.
    const stopped = health({
      watching: false,
      lastFailureAt: iso(-1_000),
      error: "getEvents timed out",
      lastSuccessAt: null,
    });
    assert.equal(stopped.phase, "off");
    assert.equal(stopped.tone, "muted");
    assert.equal(stopped.emptyIsFault, false);
    assert.equal(stopped.text, POLL_OFF_TEXT);
    assert.equal(stopped.error, "getEvents timed out", "the remembered error is not hidden");
  });
});

describe("the overdue window", () => {
  test("defaults to the poll interval times the overdue factor", () => {
    const fresh = health({ lastSuccessAt: iso(-OVERDUE_INTERVALS * INTERVAL) });
    assert.equal(fresh.overdueAfterMs, OVERDUE_INTERVALS * INTERVAL);
    assert.equal(fresh.phase, "healthy", "exactly the window is still inside it");

    const late = health({ lastSuccessAt: iso(-OVERDUE_INTERVALS * INTERVAL - 1) });
    assert.equal(late.phase, "overdue", "one ms past the window is overdue");
  });

  test("an explicit window wins, and a zero interval cannot divide the feed into NaN", () => {
    assert.equal(health({ intervalMs: 0 }).overdueAfterMs, OVERDUE_INTERVALS);
    const narrow = health({ lastSuccessAt: iso(-3_000), overdueAfterMs: 1_000 });
    assert.equal(narrow.overdueAfterMs, 1_000);
    assert.equal(narrow.phase, "overdue");
  });
});

describe("unreadable state", () => {
  test("a malformed timestamp degrades to pending instead of throwing or claiming health", () => {
    const junk = health({ lastSuccessAt: "not-a-time" });
    assert.equal(junk.phase, "pending");
    assert.equal(junk.tone, "muted");
  });

  test("every phase produces prose a screen reader can read aloud", () => {
    const cases = [
      health({ watching: false }),
      health({ lastSuccessAt: null }),
      health({ eventsInLastRound: 0 }),
      health({ lastFailureAt: iso(-1_000), error: "boom" }),
      health({ lastSuccessAt: iso(-99 * INTERVAL) }),
    ];
    for (const one of cases) {
      assert.match(one.text, /[a-z]/, `${one.phase} has a sentence`);
      assert.match(one.text, /\.$/, `${one.phase} ends in a full stop`);
      assert.doesNotMatch(one.text, /NaN|undefined|null/, `${one.phase} has no leaked value`);
      assert.doesNotMatch(
        one.text,
        /just now ago/,
        `${one.phase} is grammatical when the round is seconds old`,
      );
    }
  });
});
