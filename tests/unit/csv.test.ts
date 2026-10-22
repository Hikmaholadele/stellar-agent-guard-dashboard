import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAddressList, exportRFC4180, neutralizeFormulaCell } from "../../lib/guard/csv.ts";

const VALID_G = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const VALID_C = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

test("parses simple G-addresses", () => {
  const results = parseAddressList(VALID_G);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.address, VALID_G);
  assert.equal(results[0]?.error, undefined);
});

test("parses simple C-contract addresses", () => {
  const results = parseAddressList(VALID_C);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.address, VALID_C);
  assert.equal(results[0]?.error, undefined);
});

test("parses address,symbol,description CSV format", () => {
  const csv = `${VALID_G},XLM,Stellar Lumens`;
  const results = parseAddressList(csv);
  assert.equal(results[0]?.address, VALID_G);
  assert.equal(results[0]?.symbol, "XLM");
  assert.equal(results[0]?.description, "Stellar Lumens");
});

test("deduplicates addresses with error feedback", () => {
  const results = parseAddressList(`${VALID_G}\n${VALID_G}`);
  assert.equal(results.length, 2);
  assert.match(results[1]?.error ?? "", /duplicate/);
});

test("reports row-by-row errors for invalid addresses", () => {
  const results = parseAddressList(`INVALID\n${VALID_G}`);
  assert.match(results[0]?.error ?? "", /Row 1: invalid/);
  assert.equal(results[1]?.error, undefined);
});

test("exports to RFC 4180 format with CRLF", () => {
  assert.equal(exportRFC4180(["A", "B"]), '"A"\r\n"B"');
});

test("neutralizeFormulaCell escapes formula-leading cells", () => {
  assert.equal(neutralizeFormulaCell("hello"), "hello");
  assert.equal(neutralizeFormulaCell("=sum(A1)"), "'" + "=sum(A1)");
  assert.equal(neutralizeFormulaCell("+5"), "'" + "+5");
  assert.equal(neutralizeFormulaCell("-3"), "'" + "-3");
  assert.equal(neutralizeFormulaCell("@cell"), "'" + "@cell");
  assert.equal(neutralizeFormulaCell("  =  "), "'" + "  =  ");
  assert.equal(neutralizeFormulaCell(""), "");
});
