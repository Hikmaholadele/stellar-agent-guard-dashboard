import assert from "node:assert/strict";
import { afterEach, before, test } from "node:test";
import { installDom, loadReact, type Act } from "./domHarness.ts";
import { GuardContext, type GuardContextValue } from "../../components/GuardProvider.tsx";
import { TxHistoryTable } from "../../components/TxHistoryTable.tsx";
import {
  TX_HISTORY_LIMIT,
  TX_HISTORY_MAX_AGE_DAYS,
  TX_HISTORY_MAX_AGE_MS,
  TX_HISTORY_STORAGE_KEY,
  clearTxHistory,
  filterTxHistory,
  loadTxHistory,
  paginateTxHistory,
  pruneTxHistory,
  recordTx,
  subscribeTxHistory,
  txHistorySaveOutcome,
  txHistoryMatchesNetwork,
  txHistoryToCsv,
  txVerificationStatus,
  type StorageLike,
  type TxHistoryEntry,
} from "../../lib/guard/txHistory.ts";
import { NETWORK } from "../../lib/guard/network.ts";

let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: Act;
let root: ReturnType<typeof createRoot> | null = null;

before(async () => {
  installDom();
  const loaded = await loadReact();
  React = loaded.react;
  createRoot = loaded.createRoot;
  act = loaded.act;
});

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.innerHTML = "";
  localStorage.removeItem(TX_HISTORY_STORAGE_KEY);
});

function fakeStorage(): StorageLike {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

/**
 * A timestamp inside the retention window. A fixed calendar date here is a
 * time bomb: once it is older than TX_HISTORY_MAX_AGE_DAYS, loadTxHistory
 * prunes the fixture and every test that reads it back fails.
 */
function recentIso(minutesAgo = 60): string {
  return new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
}

function entry(overrides: Partial<TxHistoryEntry> = {}): TxHistoryEntry {
  return {
    hash: `hash-${Math.random().toString(16).slice(2)}`,
    operation: "set_policy",
    status: "confirmed",
    feeStroops: "210",
    networkName: NETWORK.name,
    networkPassphrase: NETWORK.passphrase,
    recordedAt: recentIso(),
    ...overrides,
  };
}

test("a recorded transaction is persisted and reloaded newest first", () => {
  const storage = fakeStorage();
  recordTx({ hash: "h1", operation: "freeze", status: "confirmed", feeStroops: "100" }, storage);
  recordTx({ hash: "h2", operation: "set_policy", status: "failed", feeStroops: null }, storage);

  const loaded = loadTxHistory(storage);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0]?.hash, "h2");
  assert.equal(loaded[1]?.hash, "h1");
  assert.equal(loaded[0]?.status, "failed");
  assert.equal(loaded[0]?.networkName, NETWORK.name);
  assert.equal(loaded[0]?.networkPassphrase, NETWORK.passphrase);
  // feeStroops null survives the round trip as null, not as a missing field.
  assert.equal(loaded[0]?.feeStroops, null);
});

test("recording notifies subscribers so open tables can refresh", () => {
  const storage = fakeStorage();
  let notified = 0;
  const unsubscribe = subscribeTxHistory(() => {
    notified += 1;
  });
  try {
    recordTx({ hash: "h1", operation: "freeze", status: "confirmed", feeStroops: null }, storage);
    assert.equal(notified, 1);
  } finally {
    unsubscribe();
  }
  recordTx({ hash: "h2", operation: "freeze", status: "confirmed", feeStroops: null }, storage);
  assert.equal(notified, 1, "an unsubscribed listener must not be called");
});

test("the history is capped at 200 entries, dropping the oldest", () => {
  const storage = fakeStorage();
  for (let index = 0; index < TX_HISTORY_LIMIT + 5; index += 1) {
    recordTx(
      { hash: `h${index}`, operation: "freeze", status: "confirmed", feeStroops: "100" },
      storage,
    );
  }
  const loaded = loadTxHistory(storage);
  assert.equal(loaded.length, TX_HISTORY_LIMIT);
  // Newest first: the very last record is on top, the very first was dropped.
  assert.equal(loaded[0]?.hash, `h${TX_HISTORY_LIMIT + 4}`);
  assert.equal(
    loaded.some((item) => item.hash === "h0"),
    false,
  );
});

test("re-recording a hash replaces the entry instead of duplicating it", () => {
  const storage = fakeStorage();
  recordTx({ hash: "same", operation: "freeze", status: "failed", feeStroops: "100" }, storage);
  recordTx({ hash: "same", operation: "freeze", status: "confirmed", feeStroops: "100" }, storage);

  const loaded = loadTxHistory(storage);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.status, "confirmed");
});

test("a corrupt or non-array storage payload yields an empty history", () => {
  const storage = fakeStorage();
  storage.setItem(TX_HISTORY_STORAGE_KEY, "{not json");
  assert.deepEqual(loadTxHistory(storage), []);
  storage.setItem(TX_HISTORY_STORAGE_KEY, JSON.stringify({ not: "an array" }));
  assert.deepEqual(loadTxHistory(storage), []);
  // Malformed entries are dropped rather than rendered half-formed.
  storage.setItem(
    TX_HISTORY_STORAGE_KEY,
    JSON.stringify([entry(), { hash: "broken", status: "weird" }]),
  );
  assert.equal(loadTxHistory(storage).length, 1);
});

test("a quota failure is reported without interrupting the in-memory history result", () => {
  const storage: StorageLike = {
    getItem: () => null,
    setItem: () => {
      throw Object.assign(new Error("full"), { name: "QuotaExceededError" });
    },
  };
  const result = recordTx(
    { hash: "still-recorded", operation: "freeze", status: "confirmed", feeStroops: null },
    storage,
  );
  assert.equal(result[0]?.hash, "still-recorded");
  assert.deepEqual(txHistorySaveOutcome(), { ok: false, error: "quota" });
});

test("legacy history rows load with unknown network provenance", () => {
  const storage = fakeStorage();
  storage.setItem(
    TX_HISTORY_STORAGE_KEY,
    JSON.stringify([
      {
        hash: "legacy",
        operation: "freeze",
        status: "confirmed",
        feeStroops: null,
        recordedAt: recentIso(),
      },
    ]),
  );
  const [loaded] = loadTxHistory(storage);
  assert.equal(loaded?.networkName, null);
  assert.equal(loaded?.networkPassphrase, null);
});

test("verification distinguishes pending, missing, failed, and confirmed RPC results", () => {
  assert.equal(txVerificationStatus("PENDING"), "pending");
  assert.equal(txVerificationStatus("NOT_FOUND"), "not-found");
  assert.equal(txVerificationStatus("FAILED"), "failed");
  assert.equal(txVerificationStatus("SUCCESS"), "confirmed");
  assert.equal(txVerificationStatus("UNEXPECTED"), null);
});

test("verification is limited to the row's recorded network passphrase", () => {
  const local = entry();
  assert.equal(txHistoryMatchesNetwork(local, NETWORK.passphrase), true);
  assert.equal(txHistoryMatchesNetwork(local, "another network"), false);
  assert.equal(
    txHistoryMatchesNetwork(entry({ networkPassphrase: null }), NETWORK.passphrase),
    false,
  );
});

test("the table verifies against its selected network without rewriting local history", async () => {
  const original = entry({ hash: "verify-this", status: "failed" });
  localStorage.setItem(TX_HISTORY_STORAGE_KEY, JSON.stringify([original]));
  let requestedHash = "";
  const server = {
    getTransaction: async (hash: string) => {
      requestedHash = hash;
      return { status: "SUCCESS", ledger: 42 };
    },
  };
  const div = document.createElement("div");
  document.body.appendChild(div);
  root = createRoot(div);
  await act(async () => {
    root!.render(
      React.createElement(
        GuardContext.Provider,
        { value: { server } as unknown as GuardContextValue },
        React.createElement(TxHistoryTable),
      ),
    );
  });

  const verifyButton = div.querySelector(
    'button[aria-label^="Verify transaction"]',
  ) as HTMLButtonElement;
  assert.ok(verifyButton);
  await act(async () => verifyButton.click());
  assert.equal(requestedHash, original.hash);
  assert.ok(div.textContent?.includes("Chain: Confirmed on chain"));
  assert.ok(div.textContent?.includes(NETWORK.rpcUrl));
  assert.ok(div.textContent?.includes("Checked "));
  assert.equal(loadTxHistory()[0]?.status, "failed", "the submitted outcome remains local truth");
  assert.equal("verifiedAt" in (loadTxHistory()[0] ?? {}), false);
});

test("the table disables live verification for a mismatched recorded network", async () => {
  localStorage.setItem(
    TX_HISTORY_STORAGE_KEY,
    JSON.stringify([entry({ hash: "other-network", networkPassphrase: "another network" })]),
  );
  let rpcCalls = 0;
  const server = {
    getTransaction: async () => {
      rpcCalls += 1;
      return { status: "SUCCESS" };
    },
  };
  const div = document.createElement("div");
  document.body.appendChild(div);
  root = createRoot(div);
  await act(async () => {
    root!.render(
      React.createElement(
        GuardContext.Provider,
        { value: { server } as unknown as GuardContextValue },
        React.createElement(TxHistoryTable),
      ),
    );
  });
  assert.ok(div.textContent?.includes("Unavailable"));
  assert.equal(div.querySelector('button[aria-label^="Verify transaction"]'), null);
  assert.equal(rpcCalls, 0);
});

test("search matches operation, hash and status, case-insensitively", () => {
  const entries = [
    entry({ hash: "AAA111", operation: "freeze", status: "confirmed" }),
    entry({ hash: "BBB222", operation: "set_policy", status: "failed" }),
    entry({ hash: "CCC333", operation: "unfreeze", status: "confirmed" }),
  ];
  assert.equal(filterTxHistory(entries, { query: "FREEZE" }).length, 2);
  assert.equal(filterTxHistory(entries, { query: "bbb" }).length, 1);
  assert.equal(filterTxHistory(entries, { query: "failed" }).length, 1);
  assert.equal(filterTxHistory(entries, { query: "nothing here" }).length, 0);
});

test("date range filtering is inclusive on both ends", () => {
  const entries = [
    entry({ hash: "old", recordedAt: "2026-09-20T23:59:59.000Z" }),
    entry({ hash: "start", recordedAt: "2026-09-21T00:00:00.000Z" }),
    entry({ hash: "mid", recordedAt: "2026-09-22T12:00:00.000Z" }),
    entry({ hash: "end", recordedAt: "2026-09-23T23:59:59.000Z" }),
    entry({ hash: "future", recordedAt: "2026-09-24T00:00:00.000Z" }),
  ];
  const inRange = filterTxHistory(entries, { from: "2026-09-21", to: "2026-09-23" });
  assert.deepEqual(
    inRange.map((item) => item.hash),
    ["start", "mid", "end"],
  );
  // An open-ended range filters only on the closed side.
  assert.equal(filterTxHistory(entries, { from: "2026-09-23" }).length, 2);
  assert.equal(filterTxHistory(entries, { to: "2026-09-21" }).length, 2);
});

test("query and date filters combine, and no filters leaves the list untouched", () => {
  const entries = [
    entry({ hash: "keep", operation: "freeze", recordedAt: "2026-09-22T10:00:00.000Z" }),
    entry({ hash: "wrong-day", operation: "freeze", recordedAt: "2026-09-10T10:00:00.000Z" }),
    entry({ hash: "wrong-op", operation: "revoke_policy", recordedAt: "2026-09-22T10:00:00.000Z" }),
  ];
  const filtered = filterTxHistory(entries, { query: "freeze", from: "2026-09-21" });
  assert.deepEqual(
    filtered.map((item) => item.hash),
    ["keep"],
  );
  assert.equal(filterTxHistory(entries, {}), entries);
  assert.equal(filterTxHistory(entries, { query: "  ", from: "", to: "" }), entries);
});

test("pagination slices pages and clamps out-of-range page numbers", () => {
  const entries = Array.from({ length: 25 }, (_, index) => entry({ hash: `h${index}` }));

  const first = paginateTxHistory(entries, 1, 10);
  assert.equal(first.rows.length, 10);
  assert.equal(first.pages, 3);
  assert.equal(first.total, 25);
  assert.equal(first.rows[0]?.hash, "h0");

  const last = paginateTxHistory(entries, 3, 10);
  assert.equal(last.rows.length, 5);
  assert.equal(last.rows[4]?.hash, "h24");

  // Below one and past the end both clamp instead of returning nothing.
  assert.equal(paginateTxHistory(entries, 0, 10).page, 1);
  assert.equal(paginateTxHistory(entries, 99, 10).page, 3);
  assert.equal(paginateTxHistory(entries, Number.NaN, 10).page, 1);
});

test("an empty list paginates to a single empty page", () => {
  const page = paginateTxHistory([], 1, 10);
  assert.deepEqual(page, { rows: [], page: 1, pages: 1, total: 0 });
});

test("CSV export has a fixed header and one quoted row per entry", () => {
  const entries = [
    entry({
      hash: "h1",
      operation: "set_policy",
      feeStroops: "310",
      recordedAt: "2026-09-24T10:00:00.000Z",
    }),
    entry({
      hash: "h2",
      operation: 'odd "operation"',
      status: "failed",
      feeStroops: null,
      recordedAt: "2026-09-24T11:00:00.000Z",
    }),
  ];
  const csv = txHistoryToCsv(entries);
  const lines = csv.trimEnd().split("\n");
  assert.equal(
    lines[0],
    "timestamp,operation,status,tx_hash,fee_stroops,network_name,network_passphrase",
  );
  assert.equal(lines.length, 3);
  assert.equal(
    lines[1],
    `"${entries[0]!.recordedAt}","set_policy","confirmed","h1","310","${NETWORK.name}","${NETWORK.passphrase}"`,
  );
  // Embedded quotes are doubled per RFC 4180, and a null fee exports empty.
  assert.equal(
    lines[2],
    `"2026-09-24T11:00:00.000Z","odd ""operation""","failed","h2","","${NETWORK.name}","${NETWORK.passphrase}"`,
  );
});

test("retention boundary: prunes records older than 30 days deterministically", () => {
  const now = new Date("2026-10-20T12:00:00.000Z").getTime();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  const entries: TxHistoryEntry[] = [
    entry({ hash: "recent", recordedAt: new Date(now - 1000).toISOString() }),
    entry({ hash: "boundary-ok", recordedAt: new Date(now - thirtyDaysMs + 5000).toISOString() }),
    entry({
      hash: "boundary-expired",
      recordedAt: new Date(now - thirtyDaysMs - 5000).toISOString(),
    }),
    entry({ hash: "old", recordedAt: new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString() }),
  ];

  const pruned = pruneTxHistory(entries, { now });
  assert.equal(pruned.length, 2);
  assert.equal(pruned[0]?.hash, "recent");
  assert.equal(pruned[1]?.hash, "boundary-ok");
});

test("clearTxHistory clears local storage and memory and notifies subscribers", () => {
  const storage = fakeStorage();
  recordTx({ hash: "h1", operation: "freeze", status: "confirmed", feeStroops: null }, storage);
  assert.equal(loadTxHistory(storage).length, 1);

  let notified = 0;
  const unsubscribe = subscribeTxHistory(() => {
    notified += 1;
  });

  clearTxHistory(storage);
  unsubscribe();

  assert.equal(loadTxHistory(storage).length, 0);
  assert.equal(notified, 1);
});

test("TxHistoryTable confirmation dialog warns that clearing local data does not change the chain", async () => {
  localStorage.setItem(
    TX_HISTORY_STORAGE_KEY,
    JSON.stringify([entry({ hash: "tx-to-clear", status: "confirmed" })]),
  );

  const server = {
    getTransaction: async () => ({ status: "SUCCESS" }),
  };

  const div = document.createElement("div");
  document.body.appendChild(div);
  root = createRoot(div);
  await act(async () => {
    root!.render(
      React.createElement(
        GuardContext.Provider,
        { value: { server } as unknown as GuardContextValue },
        React.createElement(TxHistoryTable),
      ),
    );
  });

  assert.ok(div.textContent?.includes("tx-to-clear"));

  // Click clear button
  const clearBtn = div.querySelector(
    'button[data-testid="clear-history-button"]',
  ) as HTMLButtonElement;
  assert.ok(clearBtn);
  await act(async () => clearBtn.click());

  // Confirm dialog should appear stating that on-chain records are unchanged
  assert.ok(div.textContent?.includes("Clear browser-local transaction history?"));
  assert.ok(
    div.textContent?.includes("On-chain transactions and ledger state are completely unchanged"),
  );

  // Click confirm
  const confirmBtn = div.querySelector(
    'button[data-testid="confirm-clear-history-button"]',
  ) as HTMLButtonElement;
  assert.ok(confirmBtn);
  await act(async () => confirmBtn.click());

  // History should now be empty in table and in storage
  assert.equal(loadTxHistory().length, 0);
  assert.ok(div.textContent?.includes("No transactions have been submitted from this console yet"));
});
