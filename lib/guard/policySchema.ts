/**
 * Versioned JSON export/import for a complete guard policy configuration,
 * so operators can reproduce a deployment across staging, testnet, and
 * production instead of re-typing every field by hand.
 *
 * Amounts are encoded as decimal strings, never a JS `number` -- narrowing
 * an `i128` cap to a `number` would lose precision on exactly the values a
 * spend cap exists to compare. This matches the convention already used by
 * `per_asset_caps` / `max_cap_stroops` in assetCapsCsv.ts.
 *
 * NAMING NOTE (flagged for maintainer review): the on-disk field is named
 * `denied_recipients` to match this feature's issue text verbatim, but it
 * actually holds the *allowlist* of recipients enforced by the contract
 * (`PolicyConfig.recipients`, paired with `allow_any_recipient`) -- there is
 * no denylist concept anywhere in the policy model. The field name is kept
 * literal to the issue on purpose; renaming it to something accurate (e.g.
 * `allowed_recipients`) is a one-line follow-up once a maintainer confirms
 * it, since changing an on-disk schema key is a breaking change for anyone
 * who already exported a policy under the current name.
 */

import { z } from "zod";
import { Address } from "@stellar/stellar-sdk";
import type { PolicyConfig } from "stellar-agent-guard-sdk";
import {
  buildPolicyConfig,
  draftFromConfig,
  type FieldIssue,
  type PolicyDraft,
} from "./policyForm.ts";
import { validateAssetCapOverrides, type AssetCapOverride } from "./assetCapsCsv.ts";

export const POLICY_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// On-disk shape (version 1)
// ---------------------------------------------------------------------------

export interface PolicyExportV1 {
  version: 1;
  max_amount_per_tx: string;
  window_cap: string;
  window_seconds: string;
  dead_man_switch_seconds: string;
  allowed_protocols: Array<{ contract: string; functions: string[] | null }>;
  /** See NAMING NOTE above: this is the recipient allowlist, not a denylist. */
  denied_recipients: string[];
  per_asset_caps: Array<{
    asset_contract_address: string;
    max_cap_stroops: string;
    symbol: string;
  }>;
  assets: string[];
  allow_any_recipient: boolean;
  active_from: string;
  active_until: string;
  paused: boolean;
}

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

function isValidAddress(value: string): boolean {
  try {
    Address.fromString(value);
    return true;
  } catch {
    return false;
  }
}

function addressField(label: string) {
  return z.string().refine(isValidAddress, { message: `${label} is not a valid Stellar address` });
}

/** A cap/duration field: digits only, blank means "off" (0). Rejects negative values by construction. */
function nonNegativeAmountField(label: string) {
  return z.string().refine((value) => /^\d*$/.test(value), {
    message: `${label} must be a non-negative whole number of units (digits only), blank to disable; maximum i128 value`,
  });
}

const protocolRuleSchema = z.object({
  contract: addressField("allowed_protocols contract"),
  functions: z
    .array(z.string().min(1, "allowed_protocols function name cannot be blank"))
    .nullable(),
});

const assetCapEntrySchema = z.object({
  asset_contract_address: addressField("per_asset_caps asset_contract_address"),
  max_cap_stroops: z
    .string()
    .refine(
      (value) =>
        /^\d+$/.test(value) &&
        BigInt(value) > 0n &&
        BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER),
      {
        message:
          "per_asset_caps max_cap_stroops must be a positive whole number not exceeding i128 max",
      },
    ),
  symbol: z.string().min(1, "per_asset_caps symbol is required"),
});

const amountFieldSchema = z.string().refine((value) => /^\d*$/.test(value), {
  message:
    "amount must be a non-negative whole number of units (digits only), blank to disable; maximum i128 value",
});

export const policyExportSchemaV1 = z.object({
  version: z.number().refine((value) => value === POLICY_SCHEMA_VERSION, {
    message: `Unknown schema version; this build only supports version ${POLICY_SCHEMA_VERSION}`,
  }),
  max_amount_per_tx: amountFieldSchema,
  window_cap: amountFieldSchema,
  window_seconds: amountFieldSchema,
  dead_man_switch_seconds: amountFieldSchema,
  allowed_protocols: z.array(protocolRuleSchema),
  denied_recipients: z.array(addressField("denied_recipients")),
  per_asset_caps: z.array(assetCapEntrySchema),
  assets: z.array(addressField("assets")),
  allow_any_recipient: z.boolean(),
  active_from: amountFieldSchema,
  active_until: amountFieldSchema,
  paused: z.boolean(),
});

// ---------------------------------------------------------------------------
// Path formatting -- turns zod's issue.path into "per_asset_caps[0].symbol"
// rather than a bare array, so an operator can find the exact broken field.
// ---------------------------------------------------------------------------

export interface PolicyImportIssue {
  path: string;
  message: string;
}

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === "number") return `${acc}[${segment}]`;
    // JSON has no symbol keys, so this branch is unreachable in practice;
    // handled defensively since zod's issue.path type is PropertyKey[].
    const rendered = typeof segment === "symbol" ? segment.toString() : segment;
    return acc === "" ? String(rendered) : `${acc}.${rendered}`;
  }, "");
}

// ---------------------------------------------------------------------------
// Export: PolicyConfig + asset caps -> PolicyExportV1 -> JSON text
// ---------------------------------------------------------------------------

function renderAmount(value: bigint): string {
  return value === 0n ? "" : value.toString();
}

export function policyToExport(
  config: PolicyConfig,
  assetCaps: AssetCapOverride[],
): PolicyExportV1 {
  return {
    version: POLICY_SCHEMA_VERSION,
    max_amount_per_tx: renderAmount(config.per_tx_cap),
    window_cap: renderAmount(config.window_cap),
    window_seconds: renderAmount(config.window_secs),
    dead_man_switch_seconds: renderAmount(config.dms_grace_secs),
    allowed_protocols: config.protocols.map((rule) => ({
      contract: rule.contract,
      functions: rule.fns,
    })),
    denied_recipients: config.recipients,
    per_asset_caps: assetCaps.map((row) => ({
      asset_contract_address: row.assetContractAddress,
      max_cap_stroops: row.maxCapStroops,
      symbol: row.symbol,
    })),
    assets: config.assets,
    allow_any_recipient: config.allow_any_recipient,
    active_from: renderAmount(config.active_from),
    active_until: renderAmount(config.active_until),
    paused: config.paused,
  };
}

/** Serialized file text, matching the trailing-newline convention used by exportAssetCapsJson. */
export function exportPolicyToJson(config: PolicyConfig, assetCaps: AssetCapOverride[]): string {
  return `${JSON.stringify(policyToExport(config, assetCaps), null, 2)}\n`;
}

/** `YYYY-MM-DDTHH-mm-ss-sssZ.guard-policy.json`, filesystem-safe on every OS. */
export function policyExportFilename(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `${stamp}.guard-policy.json`;
}

export type PolicyExportOutcome =
  { ok: true; json: string; filename: string } | { ok: false; issues: FieldIssue[] };

/**
 * The single call the UI needs: validates the draft (including asset-cap
 * overrides, which `buildPolicyConfig` does not check on its own) and, if
 * valid, produces the file text and a timestamped filename.
 */
export function exportPolicyDraft(draft: PolicyDraft): PolicyExportOutcome {
  const assetCapIssues: FieldIssue[] = validateAssetCapOverrides(draft.assetCaps).map(
    (message) => ({
      field: "assetCaps",
      message,
    }),
  );
  const built = buildPolicyConfig(draft);

  if (!built.ok || assetCapIssues.length > 0) {
    const baseIssues = built.ok ? [] : built.issues;
    return { ok: false, issues: [...baseIssues, ...assetCapIssues] };
  }

  return {
    ok: true,
    json: exportPolicyToJson(built.config, draft.assetCaps),
    filename: policyExportFilename(),
  };
}

// ---------------------------------------------------------------------------
// Import: JSON text -> PolicyExportV1 (validated) -> PolicyDraft
// ---------------------------------------------------------------------------

function parseAmount(value: string): bigint {
  return value === "" ? 0n : BigInt(value);
}

export type PolicyImportResult =
  { ok: true; draft: PolicyDraft } | { ok: false; issues: PolicyImportIssue[] };

export function importPolicyFromJson(source: string): PolicyImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { ok: false, issues: [{ path: "", message: "The JSON file is not valid JSON" }] };
  }

  const result = policyExportSchemaV1.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((issue) => ({
        path: formatPath(issue.path),
        message: issue.message,
      })),
    };
  }

  const data = result.data;
  const config: PolicyConfig = {
    per_tx_cap: parseAmount(data.max_amount_per_tx),
    window_cap: parseAmount(data.window_cap),
    window_secs: parseAmount(data.window_seconds),
    dms_grace_secs: parseAmount(data.dead_man_switch_seconds),
    assets: data.assets,
    protocols: data.allowed_protocols.map((rule) => ({
      contract: rule.contract,
      fns: rule.functions,
    })),
    recipients: data.denied_recipients,
    allow_any_recipient: data.allow_any_recipient,
    active_from: parseAmount(data.active_from),
    active_until: parseAmount(data.active_until),
    paused: data.paused,
  };

  const draft = draftFromConfig(config);
  draft.assetCaps = data.per_asset_caps.map((row) => ({
    assetContractAddress: row.asset_contract_address,
    maxCapStroops: row.max_cap_stroops,
    symbol: row.symbol,
  }));

  return { ok: true, draft };
}
