import assert from "node:assert/strict";
import { test } from "node:test";
import type { GuardStatus, PolicyConfig } from "stellar-agent-guard-sdk";
import {
  DMS_CRITICAL_FRACTION,
  DMS_WARNING_FRACTION,
  DMS_WARNING_SECONDS,
  evaluateDmsAlert,
  formatDmsDuration,
  projectDmsAlert,
} from "../../lib/guard/dmsAlert.ts";
import { LEDGER_CLOCK_MAX_AGE_SECS, resolveReferenceTime } from "../../lib/guard/ledgerTime.ts";

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

/**
 * A status/policy pair positioned so exactly `remainingSecs` of grace are left
 * on the ledger clock, given a grace window of `graceSecs`.
 */
function countdown(
  remainingSecs: number,
  graceSecs: number,
): {
  st: GuardStatus;
  pol: PolicyConfig;
} {
  const heartbeat = 1_000_000n;
  const grace = BigInt(graceSecs);
  return {
    st: status({ last_heartbeat: heartbeat, now: heartbeat + grace - BigInt(remainingSecs) }),
    pol: policy(grace),
  };
}

// ── Threshold escalation ────────────────────────────────────────────────────

test("no alert while the switch is comfortably inside its grace window", () => {
  const { st, pol } = countdown(30_000, 100_000); // 30% remaining, > 1h left
  const alert = evaluateDmsAlert(st, pol);
  assert.equal(alert.level, "none");
  assert.equal(alert.remainingSecs, 30_000);
});

test("warning escalates strictly below 25% of grace remaining", () => {
  const boundary = countdown(25_000, 100_000); // exactly 25% → still quiet
  assert.equal(evaluateDmsAlert(boundary.st, boundary.pol).level, "none");

  const below = countdown(24_999, 100_000); // 24.999% → yellow
  const alert = evaluateDmsAlert(below.st, below.pol);
  assert.equal(alert.level, "warning");
  assert.equal(alert.remainingSecs, 24_999);
  assert.equal(alert.fractionRemaining, 24_999 / 100_000);
});

test("critical escalates strictly below 10% of grace remaining", () => {
  const tenPercent = countdown(10_000, 100_000); // exactly 10% → warning, not critical
  assert.equal(evaluateDmsAlert(tenPercent.st, tenPercent.pol).level, "warning");

  const below = countdown(9_999, 100_000); // below 10% → red
  assert.equal(evaluateDmsAlert(below.st, below.pol).level, "critical");
});

test("warning also escalates inside the final hour regardless of percentage", () => {
  const boundary = countdown(3_600, 7_200); // exactly 1h left (50%) → still quiet
  assert.equal(evaluateDmsAlert(boundary.st, boundary.pol).level, "none");

  const inside = countdown(3_599, 7_200); // under 1h, half the grace left → yellow
  assert.equal(evaluateDmsAlert(inside.st, inside.pol).level, "warning");
});

test("acceptance trigger: an alert fires under 1 hour or 20% remaining", () => {
  // Under 1 hour on a long window: fires (here as critical, since the
  // absolute hour is also under 10% of a day).
  const finalHour = countdown(3_599, 86_400);
  assert.notEqual(evaluateDmsAlert(finalHour.st, finalHour.pol).level, "none");

  // Under 20% on a window with hours to spare: fires as a warning.
  const twentyPercent = countdown(19_999, 100_000);
  assert.equal(evaluateDmsAlert(twentyPercent.st, twentyPercent.pol).level, "warning");

  // Over an hour and over 25%: nothing to warn about.
  const calm = countdown(30_000, 100_000);
  assert.equal(evaluateDmsAlert(calm.st, calm.pol).level, "none");
});

test("expired once the deadline is reached or passed", () => {
  const atDeadline = countdown(0, 100_000);
  assert.equal(evaluateDmsAlert(atDeadline.st, atDeadline.pol).level, "expired");

  const pastDeadline = countdown(-42, 100_000);
  const alert = evaluateDmsAlert(pastDeadline.st, pastDeadline.pol);
  assert.equal(alert.level, "expired");
  assert.equal(alert.remainingSecs, -42);

  // `heartbeat_expired` from `status()` is the chain's own verdict and wins —
  // even when the policy read needed to reconstruct the countdown failed.
  const chainSaysExpired = evaluateDmsAlert(
    status({ heartbeat_expired: true, last_heartbeat: 7n }),
    null,
  );
  assert.equal(chainSaysExpired.level, "expired");
  assert.equal(chainSaysExpired.remainingSecs, null);
});

test("no alert when the switch is disabled, unreadable, or never armed", () => {
  // No policy read at all (failed read or default-deny): no countdown to run.
  assert.equal(evaluateDmsAlert(status({ now: 1_050_000n }), null).level, "none");
  // Grace of 0 disables the switch on chain.
  assert.equal(evaluateDmsAlert(status({ now: 1_050_000n }), policy(0n)).level, "none");
  // The agent has never sent a heartbeat, so nothing is being measured against.
  const never = countdown(50_000, 100_000);
  assert.equal(evaluateDmsAlert(status({ last_heartbeat: 0n }), never.pol).level, "none");
  // No status read: nothing may be claimed.
  assert.equal(evaluateDmsAlert(null, never.pol).level, "none");
});

// ── Ledger clock synchronization ────────────────────────────────────────────

test("the countdown reads the ledger clock, never the browser clock", () => {
  // 1970-era ledger timestamps: if any of this were computed against
  // Date.now() (the test runs in 2026), the switch would read as long tripped.
  const st = status({ last_heartbeat: 1_000_000n, now: 1_025_000n });
  const alert = evaluateDmsAlert(st, policy(100_000n));

  assert.equal(alert.level, "none");
  assert.equal(alert.remainingSecs, 75_000); // 1_000_000 + 100_000 − 1_025_000
  assert.equal(alert.elapsedSecs, 25_000); // now − last_heartbeat
  assert.equal(alert.totalSecs, 100_000);
  assert.equal(alert.expiresAtMs, 1_100_000_000); // (heartbeat + grace) × 1000
  assert.equal(new Date(alert.expiresAtMs).getUTCFullYear(), 1970);
});

test("each ledger step moves the countdown by exactly the same seconds", () => {
  const heartbeat = 1_000_000n;
  const pol = policy(100_000n);

  const before = evaluateDmsAlert(status({ last_heartbeat: heartbeat, now: 1_025_000n }), pol);
  const after = evaluateDmsAlert(status({ last_heartbeat: heartbeat, now: 1_035_000n }), pol);

  assert.equal(before.remainingSecs! - after.remainingSecs!, 10_000);
  assert.equal(after.elapsedSecs! - before.elapsedSecs!, 10_000);
  // The estimated expiration is a property of the heartbeat, not of the read.
  assert.equal(before.expiresAtMs, after.expiresAtMs);
});

test("a ledger clock already past the deadline reads as tripped", () => {
  const heartbeat = 1_000_000n;
  const alert = evaluateDmsAlert(
    status({ last_heartbeat: heartbeat, now: heartbeat + 100_000n + 5n }),
    policy(100_000n),
  );
  assert.equal(alert.level, "expired");
  assert.equal(alert.remainingSecs, -5);
});

// ── Display formatting ──────────────────────────────────────────────────────

test("formatDmsDuration renders the two largest units, largest first", () => {
  assert.equal(formatDmsDuration(0), "0s");
  assert.equal(formatDmsDuration(47), "47s");
  assert.equal(formatDmsDuration(724), "12m 4s");
  assert.equal(formatDmsDuration(8_100), "2h 15m");
  assert.equal(formatDmsDuration(97_200), "1d 3h");
  assert.equal(formatDmsDuration(-5), "0s"); // a duration never shows a minus
});

test("escalation constants match the alerting spec", () => {
  assert.equal(DMS_WARNING_FRACTION, 0.25);
  assert.equal(DMS_CRITICAL_FRACTION, 0.1);
  assert.equal(DMS_WARNING_SECONDS, 3_600);
});

// ── Chain-time boundaries under a fake, skewed local clock (issue #389) ─────
//
// The countdown is safety-relevant, so these tests pin the boundary itself
// with explicit ledger timestamps and fake local clocks: the switch must not
// jump to expired early, must not keep presenting a stale figure as current,
// and a local clock disagreeing with the chain by a generation must change
// nothing.

test("the deadline crosses exactly once: before, at, and after, under any local clock", (t) => {
  const heartbeat = 1_000_000n;
  const grace = 100_000n;
  const deadline = heartbeat + grace; // 1_100_000 ledger seconds
  const boundaryCases = [
    {
      name: "immediately before the boundary",
      now: deadline - 1n,
      level: "critical",
      remaining: 1,
    },
    { name: "exactly at the boundary", now: deadline, level: "expired", remaining: 0 },
    { name: "immediately after the boundary", now: deadline + 1n, level: "expired", remaining: -1 },
  ] as const;

  // The same three ledger timestamps, judged with the local clock skewed a
  // whole generation in either direction. Nothing may differ between runs.
  const localClocks = [Date.UTC(1990, 0, 1), Date.UTC(2026, 9, 20), Date.UTC(2050, 0, 1)];
  for (const localNow of localClocks) {
    t.mock.timers.enable({ apis: ["Date"], now: localNow });
    try {
      const localLabel = new Date(localNow).toISOString();
      for (const boundary of boundaryCases) {
        const alert = evaluateDmsAlert(
          status({ last_heartbeat: heartbeat, now: boundary.now }),
          policy(grace),
        );
        assert.equal(
          alert.level,
          boundary.level,
          `${boundary.name} must read ${boundary.level} with the local clock at ${localLabel}`,
        );
        assert.equal(alert.remainingSecs, boundary.remaining);
      }
    } finally {
      t.mock.timers.reset();
    }
  }
});

test("clock skew cannot green-wash a tripped switch nor cry-wolf a healthy one", (t) => {
  // Skew backwards a year: the local clock claims the deadline is far away.
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(1999, 0, 1) });
  try {
    const tripped = evaluateDmsAlert(
      status({ last_heartbeat: 1_000_000n, now: 1_100_001n }),
      policy(100_000n),
    );
    assert.equal(tripped.level, "expired", "the chain's own clock judges the switch");
    assert.equal(tripped.remainingSecs, -1);
  } finally {
    t.mock.timers.reset();
  }

  // Skew forward to 2050: the local clock insists years have passed; the
  // ledger still reports a healthy countdown and that is what shows.
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2050, 0, 1) });
  try {
    const healthy = evaluateDmsAlert(
      status({ last_heartbeat: 1_000_000n, now: 1_025_000n }),
      policy(100_000n),
    );
    assert.equal(healthy.level, "none");
    assert.equal(healthy.remainingSecs, 75_000);
  } finally {
    t.mock.timers.reset();
  }
});

test("the uncertainty line is drawn at the staleness threshold", () => {
  const readAt = 1_700_000_000;
  const ledgerNow = 1_700_000_123;
  const reading = { ledgerNowSecs: ledgerNow, readAtSecs: readAt };
  const at = (ageSecs: number) => resolveReferenceTime(reading, readAt + ageSecs);
  assert.equal(at(0).authoritative, true, "a just-fetched read is current");
  assert.equal(
    at(LEDGER_CLOCK_MAX_AGE_SECS).authoritative,
    true,
    "a reading exactly at the freshness bound still counts",
  );
  assert.equal(
    at(LEDGER_CLOCK_MAX_AGE_SECS + 1).authoritative,
    false,
    "one second past the bound the countdown is already uncertain",
  );
  assert.equal(at(10 * 60).authoritative, false, "a long-untouched read is stale");

  // The uncertainty survives into the projection: a stale read's countdown is
  // frozen at the last chain value and never stated as exact.
  const alert = evaluateDmsAlert(
    status({ last_heartbeat: 1_000_000n, now: 1_025_000n }),
    policy(100_000n),
  );
  const projected = projectDmsAlert(alert, at(10 * 60));
  assert.equal(projected.exact, false);
  assert.equal(
    projected.remainingSecs,
    alert.remainingSecs,
    "a stale read's figure is kept as read, not re-derived",
  );
});

test("skew and garbage make a read uncertain, never fresh by accident", () => {
  const readAt = 1_700_000_000;
  const reading = { ledgerNowSecs: 1_700_000_123, readAtSecs: readAt };
  // A local clock that jumped backwards ages the read *less*, never more:
  // skew can hide staleness at worst, it cannot invent freshness elsewhere.
  const behind = resolveReferenceTime(reading, readAt - 120);
  assert.equal(behind.ageSecs, 0, "age clamps at zero");
  assert.equal(behind.authoritative, true);
  // An unparseable fetch timestamp is uncertainty, not a free pass.
  const garbage = resolveReferenceTime(
    { ledgerNowSecs: 1_700_000_123, readAtSecs: Number.NaN },
    readAt,
  );
  assert.equal(Number.isNaN(garbage.ageSecs), true);
  assert.equal(garbage.authoritative, false, "a garbage read timestamp can never come back fresh");
});

test("a failed ledger read is an uncertainty state, and the next good read recovers it", () => {
  // What the banner is handed while the status read is failing: inert by
  // construction — no level, no deadline, no invented numbers.
  const inert = evaluateDmsAlert(null, policy(100_000n));
  assert.equal(inert.level, "none");
  assert.equal(inert.remainingSecs, null);
  assert.equal(inert.totalSecs, null);
  assert.equal(inert.fractionRemaining, null);
  assert.equal(inert.elapsedSecs, null);
  assert.equal(inert.expiresAtMs, null);

  // Recovery: the next successful ledger-time update produces the countdown
  // again — from the chain's clock, crossing the boundary exactly once.
  const deadline = 1_100_000n;
  const recovered = evaluateDmsAlert(
    status({ last_heartbeat: 1_000_000n, now: deadline - 1n }),
    policy(100_000n),
  );
  assert.equal(recovered.level, "critical");
  assert.equal(recovered.remainingSecs, 1);
  const crossed = evaluateDmsAlert(
    status({ last_heartbeat: 1_000_000n, now: deadline }),
    policy(100_000n),
  );
  assert.equal(crossed.level, "expired");
  assert.equal(crossed.remainingSecs, 0);
});

test("a failed policy read removes the countdown numbers without inventing a deadline", () => {
  // The status read is healthy, the policy read (which carries the grace) is
  // not: elapsed time is a fact the status alone supports, the deadline is not.
  const alert = evaluateDmsAlert(status({ last_heartbeat: 1_000_000n, now: 1_025_000n }), null);
  assert.equal(alert.level, "none");
  assert.equal(alert.elapsedSecs, 25_000);
  assert.equal(alert.remainingSecs, null, "no grace read, no remaining time");
  assert.equal(alert.totalSecs, null);
  assert.equal(alert.expiresAtMs, null, "no invented deadline");
});
