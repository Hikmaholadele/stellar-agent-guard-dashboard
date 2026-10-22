import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { xdr } from "@stellar/stellar-sdk";
import { decodeStorageFootprint } from "../../lib/guard/storage.ts";
import {
  classifyStorageError,
  decodeVersionedRecord,
  encodeVersionedRecord,
  writeStoredValue,
} from "../../lib/guard/versionedStorage.ts";
import {
  MOCK_GUARD,
  i128,
  persistentDataEntry,
  structScVal,
  u64,
  windowScVal,
} from "../mocks/sorobanFixtures.ts";

/** Wrap a contract-data fixture in a full `LedgerEntry`, as `getLedgerEntries` returns it. */
function asLedgerEntry(data: xdr.LedgerEntryData): string {
  return new xdr.LedgerEntry({
    lastModifiedLedgerSeq: 42,
    data,
    ext: xdr.LedgerEntryExt.v0(),
  }).toXdr("base64");
}

/** A TTL entry as the ledger stores it for a persistent contract key. */
function ttlEntry(liveUntilLedgerSeq: number): string {
  return new xdr.LedgerEntry({
    lastModifiedLedgerSeq: 42,
    data: xdr.LedgerEntryData.ttl(
      new xdr.TtlEntry({ keyHash: new Uint8Array(32).fill(7), liveUntilLedgerSeq }),
    ),
    ext: xdr.LedgerEntryExt.v0(),
  }).toXdr("base64");
}

describe("decodeStorageFootprint", () => {
  test("decodes DataKey::Policy into its typed struct", () => {
    const policy = structScVal({
      per_tx_cap: i128(1_000n),
      window_secs: u64(86_400n),
      window_cap: i128(5_000n),
      allow_any_recipient: xdr.ScVal.scvBool(false),
    });
    const xdrBase64 = asLedgerEntry(persistentDataEntry(MOCK_GUARD, "Policy", policy).data);

    const decoded = decodeStorageFootprint<{ per_tx_cap: bigint; window_cap: bigint }>(
      xdrBase64,
      "Policy",
    );

    const value = decoded.value as { per_tx_cap: bigint; window_cap: bigint };
    assert.equal(decoded.decoded, true);
    assert.equal(decoded.dataKey, "Policy");
    assert.equal(value.per_tx_cap, 1_000n);
    assert.equal(value.window_cap, 5_000n);
  });

  test("decodes DataKey::Window with its total and entries", () => {
    const window = windowScVal({
      total: 30n,
      entries: [
        { ts: 100n, amount: 10n },
        { ts: 200n, amount: 20n },
      ],
    });
    const xdrBase64 = asLedgerEntry(persistentDataEntry(MOCK_GUARD, "Window", window).data);

    const decoded = decodeStorageFootprint<{
      total: bigint;
      entries: Array<{ ts: bigint; amount: bigint }>;
    }>(xdrBase64, "Window");

    const value = decoded.value as {
      total: bigint;
      entries: Array<{ ts: bigint; amount: bigint }>;
    };
    assert.equal(decoded.decoded, true);
    assert.equal(value.total, 30n);
    assert.deepEqual(value.entries, [
      { amount: 10n, ts: 100n },
      { amount: 20n, ts: 200n },
    ]);
  });

  test("decodes DataKey::DeadManSwitch and DataKey::Paused scalars", () => {
    const heartbeat = asLedgerEntry(
      persistentDataEntry(MOCK_GUARD, "DeadManSwitch", u64(1_789_481_700n)).data,
    );
    const paused = asLedgerEntry(
      persistentDataEntry(MOCK_GUARD, "Paused", xdr.ScVal.scvBool(true)).data,
    );

    assert.equal(decodeStorageFootprint<bigint>(heartbeat, "DeadManSwitch").value, 1_789_481_700n);
    assert.equal(decodeStorageFootprint<boolean>(paused, "Paused").value, true);
  });

  test("accepts a bare LedgerEntryData without the wrapping entry", () => {
    const data = persistentDataEntry(MOCK_GUARD, "Paused", xdr.ScVal.scvBool(false)).data;
    const decoded = decodeStorageFootprint<boolean>(data.toXdr("base64"), "Paused");
    assert.equal(decoded.decoded, true);
    assert.equal(decoded.value, false);
  });

  test("reports remaining ledger lifetime from a TTL entry", () => {
    const decoded = decodeStorageFootprint(ttlEntry(1_234_567), "Policy");
    assert.equal(decoded.decoded, true);
    assert.equal(decoded.ttl, 1_234_567);
    assert.equal(decoded.value, undefined);
  });

  test("returns Uninitialized for an empty footprint", () => {
    assert.equal(decodeStorageFootprint("", "Policy").value, "Uninitialized");
    assert.equal(decodeStorageFootprint("", "Policy").decoded, false);
  });

  test("returns Uninitialized for invalid XDR instead of throwing", () => {
    const decoded = decodeStorageFootprint("invalid_xdr", "Window");
    assert.equal(decoded.decoded, false);
    assert.equal(decoded.value, "Uninitialized");
  });

  test("returns Uninitialized for a non-contract-data entry", () => {
    const codeEntry = new xdr.LedgerEntry({
      lastModifiedLedgerSeq: 1,
      data: xdr.LedgerEntryData.contractCode(
        new xdr.ContractCodeEntry({
          ext: xdr.ContractCodeEntryExt.v0(),
          hash: new Uint8Array(32).fill(1),
          code: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
        }),
      ),
      ext: xdr.LedgerEntryExt.v0(),
    }).toXdr("base64");

    assert.equal(decodeStorageFootprint(codeEntry, "Policy").value, "Uninitialized");
  });
});

describe("versioned browser storage", () => {
  const decode = (raw: string) =>
    decodeVersionedRecord({
      raw,
      schema: "test/record",
      version: 2,
      migrations: {
        0: (value) => ({ count: (value as { count: number }).count }),
        1: (value) => ({ ...(value as object), ready: true }),
      },
      validate: (value): value is { count: number; ready: boolean } =>
        typeof value === "object" &&
        value !== null &&
        typeof (value as { count?: unknown }).count === "number" &&
        typeof (value as { ready?: unknown }).ready === "boolean",
    });

  test("migrates an older record deterministically", () => {
    const result = decode(JSON.stringify({ count: 4 }));
    assert.deepEqual(result, { ok: true, value: { count: 4, ready: true }, needsMigration: true });
  });

  test("accepts current records and leaves unknown future versions exportable", () => {
    const current = encodeVersionedRecord("test/record", 2, { count: 8, ready: true });
    assert.deepEqual(decode(current), {
      ok: true,
      value: { count: 8, ready: true },
      needsMigration: false,
    });
    const future = encodeVersionedRecord("test/record", 3, { count: 9, ready: true });
    assert.deepEqual(decode(future), {
      ok: false,
      error: "future-version",
      recoveryExport: future,
    });
  });

  test("preserves malformed records and reports failed migrations", () => {
    const malformed = "{partially written";
    assert.deepEqual(decode(malformed), { ok: false, error: "parse", recoveryExport: malformed });
    const failed = decodeVersionedRecord({
      raw: JSON.stringify({ count: 1 }),
      schema: "test/record",
      version: 2,
      migrations: {
        0: () => {
          throw new Error("migration failed");
        },
      },
      validate: (_value): _value is { count: number; ready: boolean } => true,
    });
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.equal(failed.error, "migration");
  });

  test("classifies storage quota and permission failures", () => {
    assert.equal(classifyStorageError({ name: "QuotaExceededError" }), "quota");
    assert.equal(classifyStorageError({ name: "SecurityError" }), "permission");
    assert.equal(writeStoredValue(null, "key", "value").ok, false);
    const denied = writeStoredValue(
      {
        getItem: () => null,
        setItem: () => {
          throw { name: "QuotaExceededError" };
        },
      },
      "key",
      "value",
    );
    assert.deepEqual(denied, { ok: false, error: "quota" });
  });
});
