/**
 * Ledger-time references for policy countdowns (issue #388).
 *
 * The property under test: the chain's clock judges deadlines, and the browser
 * clock is only ever a measure of how *old* a chain reading is. A skewed
 * device clock must not be able to make a policy window or dead-man threshold
 * look closer to expiry than the chain considers it to be — and when the
 * console cannot prove freshness, the countdown must say so instead of
 * asserting an exact expiry.
 *
 * Three clocks move through these tests independently:
 *
 *   - `ledgerNowSecs` — `status().now`, the chain's own clock at read time;
 *   - `readAtSecs`    — when this console performed the read (browser clock);
 *   - `browserNowSecs` — the browser clock "today", which may be skewed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { GuardStatus, PolicyConfig } from "stellar-agent-guard-sdk";
import { LEDGER_CLOCK_MAX_AGE_SECS, resolveReferenceTime } from "../../lib/guard/ledgerTime.ts";
import { evaluateDmsAlert, projectDmsAlert } from "../../lib/guard/dmsAlert.ts";

const LEDGER_NOW = 1_700_000_000; // chain clock at read time
const READ_SEC = 1_700_000_000; // browser clock when the read happened (no skew)

/** A `status()` read with controllable ledger-clock fields. */
function status(overrides: Partial<GuardStatus> = {}): GuardStatus {
  return {
    has_policy: true,
    admin_frozen: false,
    heartbeat_expired: false,
    last_heartbeat: 1_000_000n,
    now: 1_000_000n,
    ...overrides,
  };
}

/** A `policy()` read whose only meaningful field here is the DMS grace. */
function policy(dmsGraceSecs: bigint): PolicyConfig {
  return {
    per_tx_cap: 1_000n,
    window_secs: 3_600n,
    window_cap: 10_000n,
    assets: [],
    protocols: [],
    recipients: [],
    allow_any_recipient: false,
    active_from: 0n,
    active_until: 0n,
    paused: false,
    dms_grace_secs: dmsGraceSecs,
  };
}

/** A status/policy pair with exactly `remainingSecs` of grace left on chain. */
function countdown(remainingSecs: number, graceSecs: number) {
  const heartbeat = 1_000_000n;
  const grace = BigInt(graceSecs);
  return {
    st: status({ last_heartbeat: heartbeat, now: heartbeat + grace - BigInt(remainingSecs) }),
    pol: policy(grace),
  };
}

// ── resolveReferenceTime ────────────────────────────────────────────────────

test("a fresh ledger reading is the reference, not the browser clock", () => {
  const ref = resolveReferenceTime(
    { ledgerNowSecs: LEDGER_NOW, readAtSecs: READ_SEC },
    READ_SEC + 5,
  );
  assert.equal(ref.source, "ledger");
  assert.equal(ref.unixSecs, LEDGER_NOW, "the reference value is the chain's, in full");
  assert.equal(ref.ageSecs, 5);
  assert.equal(ref.authoritative, true);
});

test("browser clock skew behind the read cannot manufacture staleness", () => {
  const ref = resolveReferenceTime(
    { ledgerNowSecs: LEDGER_NOW, readAtSecs: READ_SEC },
    READ_SEC - 3_600, // device an hour behind: age would be negative
  );
  assert.equal(ref.ageSecs, 0, "age clamps at zero — 'from the future' is not 'from the future'");
  assert.equal(ref.authoritative, true, "a lagging device must not discredit a fresh chain read");
  assert.equal(ref.unixSecs, LEDGER_NOW);
});

test("browser clock skew ahead only ages the reading — it never moves the chain value", () => {
  const ref = resolveReferenceTime(
    { ledgerNowSecs: LEDGER_NOW, readAtSecs: READ_SEC },
    READ_SEC + 3_600, // device an hour ahead
  );
  assert.equal(ref.unixSecs, LEDGER_NOW, "the countdown's anchor stays chain-derived");
  assert.equal(ref.ageSecs, 3_600);
  assert.equal(
    ref.authoritative,
    false,
    "an hour-old reading is stale however it got that way — flagged, not trusted",
  );
});

test("a delayed ledger update is marked non-authoritative, not replaced by the browser", () => {
  const ref = resolveReferenceTime(
    { ledgerNowSecs: LEDGER_NOW, readAtSecs: READ_SEC },
    READ_SEC + LEDGER_CLOCK_MAX_AGE_SECS + 1,
  );
  assert.equal(ref.source, "ledger", "chain state stays authoritative even when stale");
  assert.equal(ref.authoritative, false);
  assert.equal(ref.ageSecs, LEDGER_CLOCK_MAX_AGE_SECS + 1);
});

test("recovery: a fresh reading arrives and the reference is authoritative again", () => {
  const stale = resolveReferenceTime(
    { ledgerNowSecs: LEDGER_NOW, readAtSecs: READ_SEC },
    READ_SEC + 600,
  );
  assert.equal(stale.authoritative, false);

  // The next poll lands with a new ledger clock and a new read time.
  const recovered = resolveReferenceTime(
    { ledgerNowSecs: LEDGER_NOW + 600, readAtSecs: READ_SEC + 600 },
    READ_SEC + 601,
  );
  assert.equal(recovered.authoritative, true);
  assert.equal(recovered.source, "ledger");
  assert.equal(recovered.ageSecs, 1);
  assert.equal(recovered.unixSecs, LEDGER_NOW + 600, "the new chain time becomes the reference");
});

test("with no chain reading at all the reference falls back to the browser clock, never authoritatively", () => {
  const ref = resolveReferenceTime(null, 1_700_000_123);
  assert.equal(ref.source, "browser");
  assert.equal(ref.unixSecs, 1_700_000_123);
  assert.equal(ref.ageSecs, null);
  assert.equal(ref.authoritative, false);
});

// ── projectDmsAlert ─────────────────────────────────────────────────────────

test("a countdown advances against a fresh ledger reference and stays exact", () => {
  const { st, pol } = countdown(100_000, 100_000);
  const alert = evaluateDmsAlert(st, pol);
  assert.equal(alert.remainingSecs, 100_000);

  const projected = projectDmsAlert(alert, {
    unixSecs: LEDGER_NOW,
    source: "ledger",
    ageSecs: 25,
    authoritative: true,
  });
  assert.equal(projected.remainingSecs, 99_975, "elapsed chain time comes off the remaining grace");
  assert.equal(projected.exact, true);
  assert.equal(projected.source, "ledger");
  assert.equal(projected.ageSecs, 25);
  assert.equal(projected.level, "none");
});

test("the projected countdown escalates between polls, not only when the next poll lands", () => {
  const { st, pol } = countdown(5_000, 20_000); // 25% left, > 1h: still calm at read time
  const alert = evaluateDmsAlert(st, pol);
  assert.equal(alert.level, "none");

  const warning = projectDmsAlert(alert, {
    unixSecs: LEDGER_NOW,
    source: "ledger",
    ageSecs: 15,
    authoritative: true,
  });
  assert.equal(warning.remainingSecs, 4_985);
  assert.equal(warning.level, "warning");

  const past = projectDmsAlert(alert, {
    unixSecs: LEDGER_NOW,
    source: "ledger",
    ageSecs: 5_001,
    authoritative: true,
  });
  assert.equal(past.remainingSecs, -1);
  assert.equal(
    past.level,
    "expired",
    "the deadline crossing is reported without waiting for a poll",
  );
});

test("browser clock skew cannot pull an expiry closer: a stale reading freezes the countdown", () => {
  const { st, pol } = countdown(100_000, 100_000);
  const alert = evaluateDmsAlert(st, pol);

  // Device jumps an hour ahead — the read is now aged an hour. A projection
  // on that clock would declare 96_400s of grace gone and the switch expired.
  const projected = projectDmsAlert(alert, {
    unixSecs: LEDGER_NOW,
    source: "ledger",
    ageSecs: 3_600,
    authoritative: false,
  });
  assert.equal(projected.remainingSecs, 100_000, "the chain's number, not the skewed clock's");
  assert.equal(projected.exact, false, "but it is no longer quotable as exact");
  assert.equal(projected.level, "none");
  assert.equal(projected.ageSecs, 3_600, "the age travels with it so the UI can say why");
});

test("a stale read never de-escalates a verdict the chain itself returned", () => {
  const { st, pol } = countdown(100_000, 100_000);
  const alert = evaluateDmsAlert(status({ ...st, heartbeat_expired: true }), pol);
  assert.equal(alert.level, "expired");

  const projected = projectDmsAlert(alert, {
    unixSecs: LEDGER_NOW,
    source: "ledger",
    ageSecs: 600,
    authoritative: false,
  });
  assert.equal(projected.level, "expired", "the chain says fired; a stale read cannot unsay it");
  assert.equal(projected.exact, false);
});

test("the browser-clock fallback keeps the read's numbers and is never exact", () => {
  const { st, pol } = countdown(50_000, 100_000);
  const alert = evaluateDmsAlert(st, pol);

  const projected = projectDmsAlert(alert, {
    unixSecs: 1_700_009_999,
    source: "browser",
    ageSecs: null,
    authoritative: false,
  });
  assert.equal(projected.remainingSecs, 50_000, "no chain reading means no movement, not a guess");
  assert.equal(projected.source, "browser", "the UI must be able to mark the fallback");
  assert.equal(projected.exact, false);
});

test("with no clock running there is nothing to project and nothing exact to claim", () => {
  const st = status({ last_heartbeat: 0n, now: 1_000_000n });
  const alert = evaluateDmsAlert(st, policy(100_000n));
  assert.equal(alert.remainingSecs, null);

  const projected = projectDmsAlert(alert, {
    unixSecs: LEDGER_NOW,
    source: "ledger",
    ageSecs: 0,
    authoritative: true,
  });
  assert.equal(projected.remainingSecs, null);
  assert.equal(projected.fractionRemaining, null);
  assert.equal(projected.exact, false, "a clock that never ran has no exact expiry to offer");
});

test("projection is deterministic in the reference alone — same reference, same countdown", () => {
  const { st, pol } = countdown(100_000, 100_000);
  const alert = evaluateDmsAlert(st, pol);
  const reference = {
    unixSecs: LEDGER_NOW,
    source: "ledger" as const,
    ageSecs: 42,
    authoritative: true,
  };
  assert.deepEqual(projectDmsAlert(alert, reference), projectDmsAlert(alert, reference));
});
