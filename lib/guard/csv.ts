export interface ParsedAddress {
  address: string;
  symbol?: string;
  description?: string;
  error?: string;
  row: number;
}

function isValidGAddress(addr: string): boolean {
  return addr.startsWith("G") && addr.length === 56 && /^[A-Z2-7]+$/.test(addr);
}

function isValidCAddress(addr: string): boolean {
  return addr.startsWith("C") && addr.length === 56 && /^[A-Z2-7]+$/.test(addr);
}

export function parseAddressList(csv: string): ParsedAddress[] {
  const lines = csv.split(/\r?\n/);
  const results: ParsedAddress[] = [];
  const seen = new Set<string>();

  lines.forEach((line, index) => {
    const row = index + 1;
    const trimmed = line.trim();
    if (!trimmed) return;

    // Support both simple address lines and "address,symbol,description" CSV format
    const parts = trimmed.split(",").map((p) => p.trim().replace(/^"|"$/g, ""));
    const address = parts[0] ?? "";
    const symbol = parts[1];
    const description = parts[2];

    if (!isValidGAddress(address) && !isValidCAddress(address)) {
      results.push({
        address,
        ...(symbol !== undefined && { symbol }),
        ...(description !== undefined && { description }),
        row,
        error: `Row ${row}: invalid Stellar address "${address}"`,
      });
      return;
    }

    if (seen.has(address)) {
      results.push({
        address,
        ...(symbol !== undefined && { symbol }),
        ...(description !== undefined && { description }),
        row,
        error: `Row ${row}: duplicate address "${address}"`,
      });
      return;
    }

    seen.add(address);
    results.push({
      address,
      ...(symbol !== undefined && { symbol }),
      ...(description !== undefined && { description }),
      row,
    });
  });

  return results;
}

export function exportRFC4180(addresses: string[]): string {
  return addresses.map((a) => `"${a}"`).join("\r\n");
}

/** Neutralize formula-leading cells for CSV safety. */
export function neutralizeFormulaCell(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length > 0) {
    const first = trimmed[0];
    if (first === "=" || first === "+" || first === "-" || first === "@") {
      return "'" + value;
    }
  }
  return value;
}
