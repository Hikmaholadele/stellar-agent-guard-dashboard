import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Contract, rpc, xdr } from "@stellar/stellar-sdk";
import {
  FEED_GAP_LIMIT,
  GuardFeed,
  compareEventCursor,
  describeFeedGap,
  detectFeedGaps,
  type FeedGap,
} from "../../lib/guard/telemetry.ts";
import { MultiGuardFeed, feedGapNotices } from "../../lib/guard/feedSubscriptions.ts";

/**
 * Telemetry gap detection (#308).
 *
 * The rules under test: the RPC's own retention window and cursor decide whether
 * the feed may have missed events; an empty page proves nothing either way; the
 * held cursor never moves backwards; received events are never dropped for a
 * warning; and a hole in history, unlike a bad cursor, does not heal by itself.
 */

const GUARD = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";

/** A stellar-rpc style event id: a 19-digit TOID, a dash and a 10-digit index. */
const cursorAt = (ledger: number, index = 0) =>
  `${String(ledger).padStart(19, "0")}-${String(index).padStart(10, "0")}`;

interface ScriptedPage {
  /** Ledgers of the committed events on this page. */
  events?: number[];
  latestLedger: number;
  /** `undefined` leaves the field out, as a host that does not report retention would. */
  oldestLedger?: number | null;
  cursor: string;
}

/** A stub RPC serving one scripted page per `getEvents` call. */
function scriptedServer(pages: ScriptedPage[]) {
  const requests: Array<{ cursor?: string; startLedger?: number; limit?: number }> = [];
  let call = 0;
  const server = {
    getLatestLedger: async () => ({ sequence: 100 }),
    getEvents: async (request: { cursor?: string; startLedger?: number; limit?: number }) => {
      requests.push({
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        ...(request.startLedger === undefined ? {} : { startLedger: request.startLedger }),
        ...(request.limit === undefined ? {} : { limit: request.limit }),
      });
      const page = pages[Math.min(call, pages.length - 1)]!;
      call += 1;
      const events = (page.events ?? []).map(
        (ledger) =>
          ({
            id: cursorAt(ledger),
            type: "contract",
            ledger,
            ledgerClosedAt: "2026-09-25T00:00:00Z",
            transactionIndex: 1,
            operationIndex: 0,
            inSuccessfulContractCall: true,
            txHash: `tx-${ledger}`,
            contractId: new Contract(GUARD),
            topic: [xdr.ScVal.scvSymbol("event_heartbeat")],
            value: xdr.ScVal.scvMap([
              new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol("at"),
                val: xdr.ScVal.scvU64(BigInt(ledger)),
              }),
            ]),
          }) as rpc.Api.EventResponse,
      );
      return {
        events,
        cursor: page.cursor,
        latestLedger: page.latestLedger,
        ...(page.oldestLedger === undefined ? {} : { oldestLedger: page.oldestLedger }),
      };
    },
  } as unknown as rpc.Server;
  return { server, requests };
}

describe("compareEventCursor", () => {
  it("compares numerically, so a longer id is not mistaken for a smaller one", () => {
    assert.equal(compareEventCursor("9-1", "10-1"), -1);
    assert.equal(compareEventCursor("10-1", "9-1"), 1);
    // As strings "9-1" > "10-1"; numerically it is the other way round.
    assert.ok("9-1" > "10-1");
  });

  it("orders by position, then by event index within it", () => {
    assert.equal(compareEventCursor(cursorAt(5, 1), cursorAt(5, 2)), -1);
    assert.equal(compareEventCursor(cursorAt(5, 2), cursorAt(5, 2)), 0);
    assert.equal(compareEventCursor(cursorAt(6, 0), cursorAt(5, 9)), 1);
  });

  it("will not order a cursor it does not recognise", () => {
    for (const odd of ["", "abc", "123", "1-2-3", "-1-2", "1.5-2", "0x1-2"]) {
      assert.equal(compareEventCursor(odd, cursorAt(5)), null, odd);
      assert.equal(compareEventCursor(cursorAt(5), odd), null, odd);
    }
  });
});

describe("detectFeedGaps", () => {
  const page = (
    overrides: Partial<{ cursor: string; latestLedger: number; oldestLedger: number | null }> = {},
  ) => ({
    cursor: cursorAt(200),
    latestLedger: 200,
    oldestLedger: 100,
    ...overrides,
  });

  it("finds nothing when the retention window still covers what is owed", () => {
    assert.deepEqual(
      detectFeedGaps({ expectedFrom: 100, heldCursor: null, page: page({ oldestLedger: 100 }) }),
      [],
    );
    assert.deepEqual(
      detectFeedGaps({ expectedFrom: 150, heldCursor: null, page: page({ oldestLedger: 100 }) }),
      [],
    );
  });

  it("finds a provable hole when the window moved past the next ledger owed", () => {
    const gaps = detectFeedGaps({
      expectedFrom: 106,
      heldCursor: null,
      page: page({ oldestLedger: 160 }),
    });
    assert.deepEqual(gaps, [
      { reason: "history_pruned", fromLedger: 106, toLedger: 159, detectedAtLedger: 200 },
    ]);
  });

  it("reports a hole of a single ledger", () => {
    const [gap] = detectFeedGaps({
      expectedFrom: 100,
      heldCursor: null,
      page: page({ oldestLedger: 101 }),
    });
    assert.equal(gap!.fromLedger, 100);
    assert.equal(gap!.toLedger, 100);
  });

  it("does not guess when there is no baseline or the RPC omits the retention window", () => {
    assert.deepEqual(
      detectFeedGaps({ expectedFrom: null, heldCursor: null, page: page({ oldestLedger: 900 }) }),
      [],
    );
    assert.deepEqual(
      detectFeedGaps({ expectedFrom: 100, heldCursor: null, page: page({ oldestLedger: null }) }),
      [],
    );
  });

  it("finds a cursor that went backwards, with an explicitly unknown range", () => {
    const gaps = detectFeedGaps({
      expectedFrom: null,
      heldCursor: cursorAt(105),
      page: page({ cursor: cursorAt(100) }),
    });
    assert.deepEqual(gaps, [
      { reason: "cursor_regressed", fromLedger: null, toLedger: null, detectedAtLedger: 200 },
    ]);
  });

  it("accepts an unchanged or advancing cursor and an unrecognised one it cannot judge", () => {
    for (const cursor of [cursorAt(105), cursorAt(106), "opaque-cursor"]) {
      assert.deepEqual(
        detectFeedGaps({ expectedFrom: null, heldCursor: cursorAt(105), page: page({ cursor }) }),
        [],
        cursor,
      );
    }
    assert.deepEqual(
      detectFeedGaps({ expectedFrom: null, heldCursor: null, page: page({ cursor: cursorAt(1) }) }),
      [],
    );
  });

  it("reports both signals when a response shows both", () => {
    const gaps = detectFeedGaps({
      expectedFrom: 106,
      heldCursor: cursorAt(300),
      page: page({ cursor: cursorAt(100), oldestLedger: 160 }),
    });
    assert.deepEqual(
      gaps.map((gap) => gap.reason),
      ["history_pruned", "cursor_regressed"],
    );
  });
});

describe("GuardFeed keeps a known-good position and reports what it cannot prove", () => {
  it("reports a hole when the retention window moves past ledgers it had not read, and keeps the events it did receive", async () => {
    const { server } = scriptedServer([
      { events: [101, 102], latestLedger: 105, oldestLedger: 100, cursor: cursorAt(102) },
      { events: [165], latestLedger: 170, oldestLedger: 160, cursor: cursorAt(165) },
    ]);
    const feed = new GuardFeed(server, GUARD);
    feed.resetFrom(100);

    const first = await feed.pollOnce();
    assert.deepEqual(first.gaps, { lost: [], unsettled: null });
    assert.deepEqual(
      first.events.map((event) => event.ledger),
      [101, 102],
    );

    const second = await feed.pollOnce();
    assert.deepEqual(
      second.events.map((event) => event.ledger),
      [165],
      "the events that did arrive are delivered",
    );
    assert.deepEqual(second.gaps?.lost, [
      { reason: "history_pruned", fromLedger: 106, toLedger: 159, detectedAtLedger: 170 },
    ]);
    assert.equal(
      feed.position().cursor,
      cursorAt(165),
      "the feed carries on from the new position",
    );
  });

  it("treats an empty page inside the retention window as silence, not as a gap", async () => {
    const { server } = scriptedServer([
      { events: [], latestLedger: 150, oldestLedger: 100, cursor: cursorAt(150) },
      { events: [], latestLedger: 160, oldestLedger: 100, cursor: cursorAt(160) },
    ]);
    const feed = new GuardFeed(server, GUARD);
    feed.resetFrom(100);
    await feed.pollOnce();
    const second = await feed.pollOnce();
    assert.deepEqual(second.gaps, { lost: [], unsettled: null });
    assert.deepEqual(second.events, []);
  });

  it("does not take an empty page as proof of completeness: an empty page past the window is still a hole", async () => {
    const { server } = scriptedServer([
      { events: [], latestLedger: 150, oldestLedger: 100, cursor: cursorAt(150) },
      { events: [], latestLedger: 900, oldestLedger: 800, cursor: cursorAt(900) },
    ]);
    const feed = new GuardFeed(server, GUARD);
    feed.resetFrom(100);
    await feed.pollOnce();
    const second = await feed.pollOnce();
    assert.deepEqual(second.events, []);
    assert.deepEqual(second.gaps?.lost, [
      { reason: "history_pruned", fromLedger: 151, toLedger: 799, detectedAtLedger: 900 },
    ]);
  });

  it("makes no claim about a feed that started at the head, with nothing owed before it", async () => {
    const { server } = scriptedServer([
      { events: [], latestLedger: 100, oldestLedger: 90, cursor: cursorAt(100) },
    ]);
    const feed = new GuardFeed(server, GUARD);
    const page = await feed.pollOnce();
    assert.deepEqual(page.gaps, { lost: [], unsettled: null });
  });

  it("keeps the last known-good cursor when the RPC hands back an earlier one, and recovers on the next clean poll", async () => {
    const { server, requests } = scriptedServer([
      { events: [105], latestLedger: 110, oldestLedger: 100, cursor: cursorAt(105) },
      { events: [106], latestLedger: 111, oldestLedger: 100, cursor: cursorAt(90) },
      { events: [107], latestLedger: 112, oldestLedger: 100, cursor: cursorAt(107) },
    ]);
    const feed = new GuardFeed(server, GUARD);
    feed.resetFrom(100);

    await feed.pollOnce();
    assert.equal(feed.position().cursor, cursorAt(105));

    const regressed = await feed.pollOnce();
    assert.equal(feed.position().cursor, cursorAt(105), "the held cursor does not move backwards");
    assert.equal(regressed.gaps?.unsettled?.reason, "cursor_regressed");
    assert.equal(
      regressed.gaps?.unsettled?.fromLedger,
      null,
      "the range is stated as unknown, not invented",
    );
    assert.deepEqual(
      regressed.events.map((event) => event.ledger),
      [106],
      "its events are not discarded",
    );

    const recovered = await feed.pollOnce();
    assert.equal(recovered.gaps?.unsettled, null, "the warning clears on a later consistent poll");
    assert.equal(feed.position().cursor, cursorAt(107));
    assert.deepEqual(
      recovered.events.map((event) => event.ledger),
      [107],
    );
    assert.deepEqual(recovered.gaps?.lost, [], "an unsettled cursor never becomes a recorded loss");

    assert.equal(requests[1]!.cursor, cursorAt(105));
    assert.equal(
      requests[2]!.cursor,
      cursorAt(105),
      "the poll after a regression resumes from the good cursor",
    );
  });

  it("keeps a recorded hole after the feed recovers, because the events are gone for good", async () => {
    const { server } = scriptedServer([
      { events: [], latestLedger: 150, oldestLedger: 100, cursor: cursorAt(150) },
      { events: [], latestLedger: 300, oldestLedger: 250, cursor: cursorAt(300) },
      { events: [301], latestLedger: 305, oldestLedger: 250, cursor: cursorAt(301) },
    ]);
    const feed = new GuardFeed(server, GUARD);
    feed.resetFrom(100);
    await feed.pollOnce();
    await feed.pollOnce();
    const recovered = await feed.pollOnce();
    assert.equal(recovered.gaps?.lost.length, 1);
    assert.equal(recovered.gaps?.unsettled, null);
    assert.deepEqual(
      recovered.events.map((event) => event.ledger),
      [301],
    );
  });

  it("keeps the boundary armed after a full page, as the SDK does", async () => {
    const { server } = scriptedServer([
      { events: [101, 102], latestLedger: 200, oldestLedger: 100, cursor: cursorAt(102) },
      { events: [], latestLedger: 210, oldestLedger: 150, cursor: cursorAt(210) },
    ]);
    const feed = new GuardFeed(server, GUARD);
    feed.resetFrom(100);
    await feed.pollOnce(2); // full: confirms only through ledger 102, not through 200
    const second = await feed.pollOnce(2);
    assert.deepEqual(second.gaps?.lost, [
      { reason: "history_pruned", fromLedger: 103, toLedger: 149, detectedAtLedger: 210 },
    ]);
  });

  it("forgets earlier notices when it is pointed at a new starting ledger", async () => {
    const { server } = scriptedServer([
      { events: [], latestLedger: 150, oldestLedger: 100, cursor: cursorAt(150) },
      { events: [], latestLedger: 300, oldestLedger: 250, cursor: cursorAt(300) },
    ]);
    const feed = new GuardFeed(server, GUARD);
    feed.resetFrom(100);
    await feed.pollOnce();
    await feed.pollOnce();
    assert.equal(feed.gapState().lost.length, 1);
    feed.resetFrom(250);
    assert.deepEqual(feed.gapState(), { lost: [], unsettled: null });
  });

  it("makes no detection when the RPC does not report its retention window", async () => {
    const { server } = scriptedServer([
      { events: [], latestLedger: 150, cursor: cursorAt(150) },
      { events: [], latestLedger: 900, cursor: cursorAt(900) },
    ]);
    const feed = new GuardFeed(server, GUARD);
    feed.resetFrom(100);
    await feed.pollOnce();
    assert.deepEqual((await feed.pollOnce()).gaps, { lost: [], unsettled: null });
  });

  it("bounds how many lost ranges it remembers", async () => {
    const pages: ScriptedPage[] = [
      { events: [], latestLedger: 10, oldestLedger: 1, cursor: cursorAt(10) },
    ];
    for (let i = 0; i < FEED_GAP_LIMIT + 5; i += 1) {
      const latest = 1000 + i * 100;
      pages.push({
        events: [],
        latestLedger: latest,
        oldestLedger: latest - 10,
        cursor: cursorAt(latest),
      });
    }
    const { server } = scriptedServer(pages);
    const feed = new GuardFeed(server, GUARD);
    feed.resetFrom(1);
    for (let i = 0; i < pages.length; i += 1) await feed.pollOnce();
    assert.equal(feed.gapState().lost.length, FEED_GAP_LIMIT);
  });
});

describe("MultiGuardFeed carries each guard's gaps", () => {
  const A = "CAAA";
  const B = "CBBB";
  const lost: FeedGap = {
    reason: "history_pruned",
    fromLedger: 10,
    toLedger: 20,
    detectedAtLedger: 30,
  };

  function runner(
    guard: string,
    outcomes: Array<{ gaps?: { lost: FeedGap[]; unsettled: FeedGap | null } } | Error>,
  ) {
    let call = 0;
    return {
      guard,
      async pollOnce() {
        const outcome = outcomes[Math.min(call, outcomes.length - 1)]!;
        call += 1;
        if (outcome instanceof Error) throw outcome;
        return { events: [], cursor: "c", latestLedger: 30, ...outcome };
      },
    };
  }

  it("reports only the guards that have something to warn about", async () => {
    const feed = new MultiGuardFeed({
      createFeed: (guard) =>
        runner(guard, guard === A ? [{ gaps: { lost: [lost], unsettled: null } }] : [{}]),
    });
    feed.sync([
      { guard: A, label: "Treasury" },
      { guard: B, label: "Payroll" },
    ]);
    const result = await feed.pollAll();
    assert.deepEqual(feedGapNotices(result.watch), [
      { guard: A, label: "Treasury", lost: [lost], unsettled: null },
    ]);
  });

  it("keeps a known gap on screen when a later poll fails", async () => {
    const feed = new MultiGuardFeed({
      createFeed: (guard) =>
        runner(guard, [{ gaps: { lost: [lost], unsettled: null } }, new Error("rpc down")]),
    });
    feed.sync([{ guard: A, label: "Treasury" }]);
    await feed.pollAll();
    const failed = await feed.pollAll();
    assert.equal(failed.watch[0]!.ok, false);
    assert.equal(
      feedGapNotices(failed.watch).length,
      1,
      "a transport error does not make the gap disappear",
    );
  });

  it("drops a guard's gaps when the guard is removed", async () => {
    const feed = new MultiGuardFeed({
      createFeed: (guard) => runner(guard, [{ gaps: { lost: [lost], unsettled: null } }]),
    });
    feed.sync([{ guard: A, label: "Treasury" }]);
    await feed.pollAll();
    feed.sync([]);
    feed.sync([{ guard: A, label: "Treasury" }]);
    const result = await feed.pollAll();
    assert.equal(feedGapNotices(result.watch).length, 1, "a fresh runner reports afresh");
    feed.stopAll();
    assert.deepEqual((await feed.pollAll()).watch, []);
  });

  it("shows an unsettled position and clears it when the next poll is clean", async () => {
    const unsettled: FeedGap = {
      reason: "cursor_regressed",
      fromLedger: null,
      toLedger: null,
      detectedAtLedger: 30,
    };
    const feed = new MultiGuardFeed({
      createFeed: (guard) =>
        runner(guard, [{ gaps: { lost: [], unsettled } }, { gaps: { lost: [], unsettled: null } }]),
    });
    feed.sync([{ guard: A, label: "Treasury" }]);
    assert.equal(feedGapNotices((await feed.pollAll()).watch)[0]!.unsettled, unsettled);
    assert.deepEqual(feedGapNotices((await feed.pollAll()).watch), []);
  });
});

describe("describeFeedGap", () => {
  it("names the ledger range and an approximate span for a hole it can bound", () => {
    const text = describeFeedGap({
      reason: "history_pruned",
      fromLedger: 106,
      toLedger: 165,
      detectedAtLedger: 170,
    });
    assert.match(text.headline, /missed and cannot be recovered/);
    assert.match(text.range, /Ledgers 106–165/);
    assert.match(text.range, /about 5 minutes/);
  });

  it("scales the span to hours and days, and to seconds for a single ledger", () => {
    const span = (count: number) =>
      describeFeedGap({
        reason: "history_pruned",
        fromLedger: 1,
        toLedger: count,
        detectedAtLedger: count,
      }).range;
    assert.match(span(1), /about 5 seconds/);
    assert.match(span(720), /about 1 hours|about 60 minutes/);
    assert.match(span(5000), /about 7 hours/);
    assert.match(span(100_000), /about 6 days/);
  });

  it("says the range is unknown when it is, rather than inventing one", () => {
    const text = describeFeedGap({
      reason: "cursor_regressed",
      fromLedger: null,
      toLedger: null,
      detectedAtLedger: 9,
    });
    assert.match(text.range, /range is unknown/);
    assert.doesNotMatch(text.range, /Ledgers \d/);
  });
});
