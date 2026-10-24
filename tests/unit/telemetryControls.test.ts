import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Contract, rpc, xdr } from "@stellar/stellar-sdk";
import type { GuardEvent } from "stellar-agent-guard-sdk";
import {
  GuardFeed,
  STREAM_BUFFER_LIMIT,
  clearStreamRows,
  emptyStreamBuffer,
  ingestEvents,
  pauseStream,
  resumeStream,
  type StreamBuffer,
  type TelemetryEvent,
} from "../../lib/guard/telemetry.ts";
import { withIdentity } from "../mocks/eventFixtures.ts";

const GUARD = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";

/** A distinct committed event per ledger number. */
function ev(ledger: number, overrides: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return withIdentity({
    kind: "heartbeat",
    topic: "event_heartbeat",
    source: "ledger",
    contractId: GUARD,
    ledger,
    ledgerClosedAt: null,
    transactionHash: `tx-${ledger}`,
    decision: null,
    data: { at: BigInt(ledger) },
    ...overrides,
  });
}

const ledgers = (events: readonly TelemetryEvent[]) => events.map((event) => event.ledger);

function apply(buffer: StreamBuffer, batches: TelemetryEvent[][], limit?: number): StreamBuffer {
  return batches.reduce(
    (current, batch) => ingestEvents(current, batch, limit === undefined ? {} : { limit }),
    buffer,
  );
}

describe("live ingest", () => {
  test("new batches go on top, newest first", () => {
    const buffer = apply(emptyStreamBuffer(), [[ev(1)], [ev(2), ev(3)]]);
    assert.deepEqual(ledgers(buffer.rows), [2, 3, 1]);
    assert.equal(buffer.pending.length, 0);
  });

  test("a re-delivered event is not shown twice", () => {
    const buffer = apply(emptyStreamBuffer(), [
      [ev(1), ev(2)],
      [ev(2), ev(1), ev(3)],
    ]);
    assert.deepEqual(ledgers(buffer.rows), [3, 1, 2]);
  });

  test("an all-duplicate batch returns the same buffer (no re-render)", () => {
    const buffer = apply(emptyStreamBuffer(), [[ev(1)]]);
    assert.equal(ingestEvents(buffer, [ev(1)]), buffer);
  });

  test("the display is bounded to the buffer limit, keeping the newest", () => {
    const buffer = apply(emptyStreamBuffer(), [[ev(1)], [ev(2)], [ev(3)], [ev(4)]], 3);
    assert.deepEqual(ledgers(buffer.rows), [4, 3, 2]);
  });

  test("dedupe can be disabled for sources whose events repeat fields", () => {
    const refusal = ev(0, { ledger: null, transactionHash: null, source: "diagnostic", data: {} });
    let buffer = ingestEvents(emptyStreamBuffer(), [refusal], { dedupe: false });
    buffer = ingestEvents(buffer, [refusal], { dedupe: false });
    assert.equal(buffer.rows.length, 2);
  });

  test("the SDK's event id covers bigint data (a heartbeat's `at`) without throwing", () => {
    // The identity is now the SDK's `guardEventId`, which renders decoded data
    // canonically — bigints included — instead of this console's own key.
    const max = ev(5, {
      source: "diagnostic",
      transactionHash: null,
      data: { at: 18_446_744_073_709_551_615n },
    });
    const small = ev(5, { source: "diagnostic", transactionHash: null, data: { at: 1n } });
    assert.ok(
      typeof max.id === "string" && max.id.length > 0,
      "a diagnostic id is derived from the event's content",
    );
    assert.notEqual(max.id, small.id, "different decoded data is a different event");
    assert.equal(
      max.id,
      ev(5, {
        source: "diagnostic",
        transactionHash: null,
        data: { at: 18_446_744_073_709_551_615n },
      }).id,
    );
  });
});

describe("pause queue", () => {
  test("while paused the rows are frozen and new events queue as pending", () => {
    const live = apply(emptyStreamBuffer(), [[ev(1)], [ev(2)]]);
    const paused = apply(pauseStream(live), [[ev(3)], [ev(4), ev(5)]]);
    assert.equal(paused.paused, true);
    assert.deepEqual(paused.rows, live.rows, "visible rows do not move");
    assert.equal(paused.pending.length, 3, "the badge count");
    assert.deepEqual(ledgers(paused.pending), [4, 5, 3]);
  });

  test("duplicates are rejected while paused too: against the rows and within the queue", () => {
    const live = apply(emptyStreamBuffer(), [[ev(1), ev(2)]]);
    const paused = apply(pauseStream(live), [
      [ev(2), ev(3)],
      [ev(3), ev(1), ev(4)],
    ]);
    assert.deepEqual(ledgers(paused.pending), [4, 3]);
  });

  test("pause and resume are idempotent", () => {
    const buffer = apply(emptyStreamBuffer(), [[ev(1)]]);
    assert.equal(resumeStream(buffer), buffer);
    const paused = pauseStream(buffer);
    assert.equal(pauseStream(paused), paused);
  });

  test("a long pause keeps the newest queued events and counts what fell off", () => {
    const paused = apply(
      pauseStream(emptyStreamBuffer()),
      [[ev(1)], [ev(2)], [ev(3)], [ev(4)], [ev(5)]],
      3,
    );
    assert.deepEqual(ledgers(paused.pending), [5, 4, 3]);
    assert.equal(paused.dropped, 2);
    assert.equal(resumeStream(paused, 3).dropped, 0);
  });
});

describe("resume reconciliation", () => {
  test("appends the queue on top, in arrival order, and goes live", () => {
    const live = apply(emptyStreamBuffer(), [[ev(1)], [ev(2)]]);
    const resumed = resumeStream(apply(pauseStream(live), [[ev(3)], [ev(4)]]));
    assert.equal(resumed.paused, false);
    assert.equal(resumed.pending.length, 0);
    assert.deepEqual(ledgers(resumed.rows), [4, 3, 2, 1]);
  });

  test("pausing anywhere yields exactly the rows an unpaused stream would have", () => {
    // Deterministic pseudo-random batches with overlapping re-deliveries, the
    // shape a cursor-polled feed plus re-pushed diagnostics produces.
    let seed = 42;
    const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31);
    const batches: TelemetryEvent[][] = [];
    let ledger = 1;
    for (let i = 0; i < 40; i++) {
      const batch: TelemetryEvent[] = [];
      for (let n = next() % 4; n > 0; n--) batch.push(ev(ledger++));
      if (ledger > 3 && next() % 3 === 0) batch.push(ev(1 + (next() % (ledger - 1)))); // a repeat
      batches.push(batch);
    }
    const limit = 25;
    const unpaused = apply(emptyStreamBuffer(), batches, limit);

    for (let pauseAt = 0; pauseAt <= batches.length; pauseAt += 3) {
      for (let resumeAt = pauseAt; resumeAt <= batches.length; resumeAt += 5) {
        let buffer = emptyStreamBuffer();
        batches.forEach((batch, index) => {
          if (index === pauseAt) buffer = pauseStream(buffer);
          if (index === resumeAt) buffer = resumeStream(buffer, limit);
          buffer = ingestEvents(buffer, batch, limit === undefined ? {} : { limit });
        });
        buffer = resumeStream(buffer, limit);
        assert.deepEqual(
          ledgers(buffer.rows),
          ledgers(unpaused.rows),
          `pause@${pauseAt} resume@${resumeAt}`,
        );
        assert.equal(
          new Set(buffer.rows.map((event) => event.id)).size,
          buffer.rows.length,
          "no duplicate rows",
        );
      }
    }
  });
});

describe("clear buffer", () => {
  test("empties the rows but keeps what has been seen, so nothing re-appears", () => {
    const cleared = clearStreamRows(apply(emptyStreamBuffer(), [[ev(1), ev(2)]]));
    assert.equal(cleared.rows.length, 0);
    const after = ingestEvents(cleared, [ev(2), ev(3)]);
    assert.deepEqual(ledgers(after.rows), [3]);
  });

  test("keeps the paused state and any queued events", () => {
    const paused = apply(pauseStream(apply(emptyStreamBuffer(), [[ev(1)]])), [[ev(2)]]);
    const cleared = clearStreamRows(paused);
    assert.equal(cleared.paused, true);
    assert.deepEqual(ledgers(cleared.pending), [2]);
    assert.deepEqual(ledgers(resumeStream(cleared).rows), [2]);
  });

  test("the default limit is the feed's 250-row buffer", () => {
    assert.equal(STREAM_BUFFER_LIMIT, 250);
  });
});

describe("with the real poller", () => {
  /**
   * A stub RPC whose getEvents serves one page per call, honouring the cursor.
   * `failOn` is a list of 1-based **attempt** numbers that throw instead of
   * answering — and a thrown attempt consumes no page, which is exactly what an
   * RPC that never replied did.
   */
  function stubServer(pages: Array<Array<{ ledger: number; at: bigint }>>, failOn: number[] = []) {
    const requests: Array<{ cursor?: string; startLedger?: number }> = [];
    let call = 0;
    let attempt = 0;
    const server = {
      getLatestLedger: async () => ({ sequence: 100 }),
      getEvents: async (request: { cursor?: string; startLedger?: number }) => {
        attempt += 1;
        requests.push({
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          ...(request.startLedger === undefined ? {} : { startLedger: request.startLedger }),
        });
        if (failOn.includes(attempt)) throw new Error("rpc unavailable");
        const page = pages[call] ?? [];
        call += 1;
        const events = page.map(
          ({ ledger, at }) =>
            ({
              id: `${String(ledger).padStart(19, "0")}-0000000000`,
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
                new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("at"), val: xdr.ScVal.scvU64(at) }),
              ]),
            }) as rpc.Api.EventResponse,
        );
        return { events, cursor: `cursor-${call}`, latestLedger: 100 + call };
      },
    } as unknown as rpc.Server;
    return { server, requests };
  }

  test("polling continues while paused, the cursor advances, and clear does not reset it", async () => {
    const { server, requests } = stubServer([
      [{ ledger: 101, at: 1n }],
      [{ ledger: 102, at: 2n }],
      [{ ledger: 103, at: 3n }],
      [{ ledger: 104, at: 4n }],
    ]);
    const feed = new GuardFeed(server, GUARD);
    let buffer = emptyStreamBuffer();

    buffer = ingestEvents(buffer, (await feed.pollOnce()).events);
    buffer = pauseStream(buffer);
    buffer = ingestEvents(buffer, (await feed.pollOnce()).events);
    buffer = ingestEvents(buffer, (await feed.pollOnce()).events);
    assert.deepEqual(ledgers(buffer.rows), [101]);
    assert.equal(buffer.pending.length, 2);
    assert.equal(feed.position().cursor, "cursor-3");

    buffer = clearStreamRows(buffer);
    assert.equal(
      feed.position().cursor,
      "cursor-3",
      "clearing the display leaves the cursor alone",
    );

    buffer = resumeStream(buffer);
    buffer = ingestEvents(buffer, (await feed.pollOnce()).events);
    assert.deepEqual(ledgers(buffer.rows), [104, 103, 102]);
    assert.deepEqual(
      requests.map((request) => request.cursor ?? `start:${request.startLedger}`),
      ["start:100", "cursor-1", "cursor-2", "cursor-3"],
      "every poll continued from the previous cursor: nothing re-scanned, nothing skipped",
    );
  });

  test("a poll that fails leaves the cursor exactly where it was and the retry resumes from it (issue #311)", async () => {
    // The health indicators added for #311 are written from the same tick that
    // polls, so the claim under test is that recording a failure cannot move the
    // feed: not forward (which would skip the page the failure lost) and not back
    // to no cursor (which would re-scan the head and re-deliver everything).
    const { server, requests } = stubServer(
      [[{ ledger: 101, at: 1n }], [{ ledger: 102, at: 2n }]],
      [2],
    );
    const feed = new GuardFeed(server, GUARD);

    const first = await feed.pollOnce();
    assert.equal(first.events.length, 1);
    const beforeFailure = feed.position();
    assert.deepEqual(beforeFailure, { cursor: "cursor-1", latestLedger: 101 });

    await assert.rejects(() => feed.pollOnce(), /rpc unavailable/);
    assert.deepEqual(
      feed.position(),
      beforeFailure,
      "a failed round advances nothing and resets nothing",
    );

    const third = await feed.pollOnce();
    assert.deepEqual(
      requests.map((request) => request.cursor ?? `start:${request.startLedger}`),
      ["start:100", "cursor-1", "cursor-1"],
      "the retry asks for the same cursor the failed round had, so no ledger is skipped",
    );
    assert.deepEqual(ledgers(third.events), [102], "and the lost page is delivered on the retry");
    assert.deepEqual(feed.position(), { cursor: "cursor-2", latestLedger: 102 });
  });
});
