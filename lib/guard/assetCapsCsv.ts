import { Address } from "@stellar/stellar-sdk";

export interface AssetCapOverride {
  assetContractAddress: string;
  maxCapStroops: string;
  symbol: string;
}

export type AssetCapChange = "added" | "updated";

export interface AssetCapImport {
  rows: AssetCapOverride[];
  changes: Record<string, AssetCapChange>;
}

const HEADERS = ["asset_contract_address", "max_cap_stroops", "symbol"] as const;
const MAX_STROOP_CAP = (1n << 127n) - 1n;

export function parseAssetCapsCsv(source: string): AssetCapOverride[] {
  const records = parseCsvRecords(source);
  if (records.length === 0) throw new Error("The file is empty");

  const header = records.shift();
  if (
    !header ||
    header.length !== HEADERS.length ||
    header.some((value, index) => value !== HEADERS[index])
  ) {
    throw new Error(`Expected header: ${HEADERS.join(",")}`);
  }
  return validateRows(records, "CSV");
}

export function parseAssetCapsJson(source: string): AssetCapOverride[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("The JSON file is not valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("JSON must contain an array of asset overrides");
  const records = parsed.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`JSON row ${index + 1} must be an object`);
    }
    const value = row as Record<string, unknown>;
    return [value.asset_contract_address, value.max_cap_stroops, value.symbol].map((field) =>
      typeof field === "string" ? field : String(field ?? ""),
    );
  });
  return validateRows(records, "JSON");
}

export function exportAssetCapsCsv(rows: AssetCapOverride[]): string {
  return (
    [
      HEADERS.join(","),
      ...rows.map((row) =>
        [row.assetContractAddress, row.maxCapStroops, row.symbol].map(csvCell).join(","),
      ),
    ].join("\n") + "\n"
  );
}

export function exportAssetCapsJson(rows: AssetCapOverride[]): string {
  return `${JSON.stringify(
    rows.map((row) => ({
      asset_contract_address: row.assetContractAddress,
      max_cap_stroops: row.maxCapStroops,
      symbol: row.symbol,
    })),
    null,
    2,
  )}\n`;
}

export function mergeAssetCapOverrides(
  current: AssetCapOverride[],
  imported: AssetCapOverride[],
): AssetCapImport {
  const rows = [...current];
  const changes: Record<string, AssetCapChange> = {};
  for (const row of imported) {
    const existingIndex = rows.findIndex(
      (candidate) => candidate.assetContractAddress === row.assetContractAddress,
    );
    if (existingIndex < 0) {
      rows.push(row);
      changes[row.assetContractAddress] = "added";
    } else {
      if (JSON.stringify(rows[existingIndex]) !== JSON.stringify(row))
        changes[row.assetContractAddress] = "updated";
      rows[existingIndex] = row;
    }
  }
  return { rows, changes };
}

export function validateAssetCapOverrides(rows: AssetCapOverride[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    if (!row.assetContractAddress || !isAddress(row.assetContractAddress)) {
      errors.push(
        `Asset override ${index + 1}: asset_contract_address is not a valid Stellar contract address`,
      );
    }
    if (!row.maxCapStroops || !/^\d+$/.test(row.maxCapStroops)) {
      errors.push(`Asset override ${index + 1}: max_cap_stroops must be a positive integer`);
    } else if (BigInt(row.maxCapStroops) <= 0n) {
      errors.push(`Asset override ${index + 1}: max_cap_stroops must be a positive integer`);
    } else if (BigInt(row.maxCapStroops) > MAX_STROOP_CAP) {
      errors.push(`Asset override ${index + 1}: max_cap_stroops exceeds the supported i128 range`);
    }
    if (!row.symbol.trim()) errors.push(`Asset override ${index + 1}: symbol is required`);
    if (seen.has(row.assetContractAddress))
      errors.push(`Asset override ${index + 1}: duplicate asset contract address`);
    seen.add(row.assetContractAddress);
  });
  return errors;
}

function validateRows(records: string[][], source: string): AssetCapOverride[] {
  const seen = new Set<string>();
  return records.map((record, index) => {
    if (record.length !== HEADERS.length)
      throw new Error(`${source} row ${index + 2} must have three columns`);
    const [assetContractAddress, maxCapStroops, symbol] = record.map((value) => value.trim());
    if (!assetContractAddress || !isAddress(assetContractAddress)) {
      throw new Error(
        `${source} row ${index + 2}: asset_contract_address is not a valid Stellar contract address`,
      );
    }
    if (!maxCapStroops || !/^\d+$/.test(maxCapStroops) || BigInt(maxCapStroops) <= 0n) {
      throw new Error(`${source} row ${index + 2}: max_cap_stroops must be a positive integer`);
    }
    if (BigInt(maxCapStroops) > MAX_STROOP_CAP) {
      throw new Error(
        `${source} row ${index + 2}: max_cap_stroops exceeds the supported i128 range`,
      );
    }
    if (!symbol) throw new Error(`${source} row ${index + 2}: symbol is required`);
    if (seen.has(assetContractAddress))
      throw new Error(`${source} row ${index + 2}: duplicate asset contract address`);
    seen.add(assetContractAddress);
    return { assetContractAddress, maxCapStroops, symbol };
  });
}

function isAddress(value: string): boolean {
  try {
    if (!value.startsWith("C")) return false;
    Address.fromString(value);
    return true;
  } catch {
    return false;
  }
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function parseCsvRecords(source: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      record.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      record.push(cell);
      if (record.some((value) => value !== "")) records.push(record);
      record = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  if (cell || record.length > 0) {
    record.push(cell);
    if (record.some((value) => value !== "")) records.push(record);
  }
  return records;
}
