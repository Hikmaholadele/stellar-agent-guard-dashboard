import assert from "node:assert/strict";
import { test } from "node:test";
import {
  exportAssetCapsCsv,
  exportAssetCapsJson,
  mergeAssetCapOverrides,
  parseAssetCapsCsv,
  parseAssetCapsJson,
  validateAssetCapOverrides,
  type AssetCapOverride,
} from "../../lib/guard/assetCapsCsv.ts";

const ASSET = "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB";
const ASSET_TWO = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";

const rows: AssetCapOverride[] = [
  { assetContractAddress: ASSET, maxCapStroops: "1000000", symbol: "USDC" },
  { assetContractAddress: ASSET_TWO, maxCapStroops: "42", symbol: "EUR" },
];

test("CSV parsing validates addresses and positive stroop caps", () => {
  const source = exportAssetCapsCsv(rows);
  assert.deepEqual(parseAssetCapsCsv(source), rows);
  assert.throws(() => parseAssetCapsCsv(source.replace("42,EUR", "0,EUR")), /positive integer/);
  assert.throws(() => parseAssetCapsCsv(source.replace(ASSET, "not-an-address")), /valid Stellar/);
});

test("CSV parsing rejects malformed rows, duplicate addresses, and bad headers", () => {
  assert.throws(() => parseAssetCapsCsv("wrong,header,symbol\n"), /Expected header/);
  assert.throws(
    () => parseAssetCapsCsv(`${exportAssetCapsCsv(rows)}${ASSET},7,USD\n`),
    /duplicate/,
  );
  assert.throws(
    () => parseAssetCapsCsv(`${exportAssetCapsCsv(rows)}${ASSET},7\n`),
    /three columns/,
  );
});

test("JSON round trips through the same validated row model", () => {
  assert.deepEqual(parseAssetCapsJson(exportAssetCapsJson(rows)), rows);
  assert.throws(() => parseAssetCapsJson('{"not":"an array"}'), /array/);
});

test("asset-cap overrides reject values outside the XDR i128 range", () => {
  const invalid = [{ ...rows[0]!, maxCapStroops: "170141183460469231731687303715884105728" }];
  assert.match(validateAssetCapOverrides(invalid)[0] ?? "", /supported i128 range/);
  assert.throws(() => parseAssetCapsCsv(exportAssetCapsCsv(invalid)), /supported i128 range/);
});

test("import merging marks additions and updates without dropping existing rows", () => {
  const result = mergeAssetCapOverrides(rows, [
    { ...rows[0]!, maxCapStroops: "2000000" },
    { assetContractAddress: ASSET_TWO, maxCapStroops: "42", symbol: "EUR" },
  ]);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0]?.maxCapStroops, "2000000");
  assert.equal(result.changes[ASSET], "updated");
  assert.equal(result.changes[ASSET_TWO], undefined);
});
