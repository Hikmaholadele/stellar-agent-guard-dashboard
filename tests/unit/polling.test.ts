import test from "node:test";
import assert from "node:assert/strict";
import { POLLING, jitteredInterval, startRefreshTimer } from "../../lib/guard/polling.ts";
import { installDom, loadReact } from "./domHarness.ts";
import { TimeAgo } from "../../components/bits.tsx";

installDom();

test("POLLING config", async (t) => {
  await t.test("defaults preserve the pre-centralization values exactly", () => {
    // Behavior-preservation proof: each entry is the value that used to sit
    // inline at its call site (GuardProvider snapshot/feed/demo, FleetTable,
    // submit.ts's inclusion poll).
    assert.equal(POLLING.snapshotMs, 15_000);
    assert.equal(POLLING.feedMs, 5_000);
    assert.equal(POLLING.fleetMs, 5_000);
    assert.equal(POLLING.demoEventMs, 4_000);
    assert.equal(POLLING.txInclusionMs, 2_000);
    assert.equal(POLLING.txInclusionAttempts, 30);
  });

  await t.test("every configured interval is a positive integer", () => {
    for (const value of Object.values(POLLING)) {
      assert.ok(Number.isInteger(value), `expected integer, got ${value}`);
      assert.ok(value > 0, `expected positive value, got ${value}`);
    }
  });
});

test("jitteredInterval", async (t) => {
  await t.test("keeps the result within [0.8·I, I) across many draws", () => {
    let rngCalls = 0;
    const rng = () => {
      rngCalls += 1;
      // Sweep the unit interval deterministically instead of trusting chance.
      return (rngCalls % 101) / 100.999;
    };
    for (let i = 0; i < 500; i++) {
      const jittered = jitteredInterval(10_000, "full", rng);
      assert.ok(jittered >= 8_000, `below floor: ${jittered}`);
      assert.ok(jittered < 10_000, `at or above ceiling: ${jittered}`);
      assert.ok(Number.isInteger(jittered), `non-integer: ${jittered}`);
    }
  });

  await t.test("pinning the rng produces the expected delay", () => {
    // rng() === 0 → factor 0.8 (floor); rng() === 0.5 → factor 0.9.
    assert.equal(
      jitteredInterval(10_000, "full", () => 0),
      8_000,
    );
    assert.equal(
      jitteredInterval(10_000, "full", () => 0.5),
      9_000,
    );
    assert.equal(
      jitteredInterval(5_000, "full", () => 0.25),
      4_250,
    );
  });

  await t.test("spreads consecutive pollers across the jitter band", () => {
    let n = 0;
    const rng = () => {
      n += 1;
      return (n * 0.13) % 1;
    };
    const delays = new Set<number>();
    for (let i = 0; i < 20; i++) delays.add(jitteredInterval(10_000, "full", rng));
    // A spread of distinct cadences is the whole point: uniform timers all
    // collapse to one value.
    assert.ok(delays.size > 5, `expected spread, got ${delays.size} distinct values`);
  });

  await t.test("'none' mode returns the interval unchanged (deterministic)", () => {
    assert.equal(jitteredInterval(10_000, "none"), 10_000);
    assert.equal(jitteredInterval(5_000, "none"), 5_000);
    assert.equal(
      jitteredInterval(10_000, "none", () => 0.99),
      10_000,
    );
  });

  await t.test("defaults to full jitter with the platform rng", () => {
    const value = jitteredInterval(10_000);
    assert.ok(value >= 8_000 && value < 10_000);
  });
});

test("the relative freshness clock advances and stops on unmount", async (t) => {
  const { react, createRoot, act } = await loadReact();
  const origin = Date.parse("2026-10-24T12:00:00Z");
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: origin });
  const clearIntervalOriginal = globalThis.clearInterval;
  const clearIntervalSpy = t.mock.method(
    globalThis,
    "clearInterval",
    (id: ReturnType<typeof setInterval>) => clearIntervalOriginal(id),
  );
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(react.createElement(TimeAgo, { iso: new Date(origin).toISOString() })),
    );
    assert.equal(container.querySelector("time")?.textContent, "just now");

    await act(async () => t.mock.timers.tick(15_000));
    assert.equal(container.querySelector("time")?.textContent, "15s");
    await act(async () => t.mock.timers.tick(45_000));
    assert.equal(container.querySelector("time")?.textContent, "1m");

    await act(async () => root.unmount());
    assert.equal(clearIntervalSpy.mock.callCount(), 1, "unmount must clear the freshness interval");
    await act(async () => t.mock.timers.tick(10_000));
    assert.equal(container.querySelector("time"), null, "unmounted clock must stay removed");
  } finally {
    container.remove();
    t.mock.timers.reset();
  }
});

test("a failed snapshot poll recovers on the next tick and cleanup stops polling", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"], now: 0 });
  let attempts = 0;
  let visibleState = "fresh";
  const stop = startRefreshTimer(() => {
    attempts += 1;
    try {
      if (attempts === 1) throw new Error("RPC unavailable");
      visibleState = "fresh again";
    } catch {
      visibleState = "read failed";
    }
  }, POLLING.snapshotMs);
  try {
    t.mock.timers.tick(POLLING.snapshotMs);
    assert.equal(visibleState, "read failed");
    t.mock.timers.tick(POLLING.snapshotMs);
    assert.equal(visibleState, "fresh again");
    assert.equal(attempts, 2);
    stop();
    t.mock.timers.tick(POLLING.snapshotMs * 2);
    assert.equal(attempts, 2, "no refresh is allowed after cleanup");
  } finally {
    stop();
    t.mock.timers.reset();
  }
});
