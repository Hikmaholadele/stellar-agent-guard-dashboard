/**
 * The no-code policy form: a plain, validatable model in the operator's terms,
 * converted into the exact `PolicyConfig` the contract expects.
 *
 * Encoding is delegated to the SDK's `policyToScVal`, which builds the sorted
 * `ScVal::Map` field by field. That matters more than it looks: the host converts
 * a map into a typed struct by walking entries in order and rejects an unsorted
 * one, so a hand-rolled encoder here would be a second place to get field order
 * wrong. Caps stay `bigint` end to end, because narrowing an `i128` to a JS
 * `number` would lose precision on exactly the values a spend cap exists to
 * compare.
 */

import { policyToScVal } from "stellar-agent-guard-sdk";
import type { PolicyConfig } from "stellar-agent-guard-sdk";
import { Address, xdr } from "@stellar/stellar-sdk";
import { validateAssetCapOverrides, type AssetCapOverride } from "./assetCapsCsv.ts";

/** What the operator types, before validation. Strings, so a half-filled box is representable. */
export interface PolicyDraft {
  perTxCap: string;
  windowCap: string;
  windowSecs: string;
  /** One address per line. */
  assets: string;
  /** Client-side per-asset cap overrides, retained for bulk editing and export. */
  assetCaps: AssetCapOverride[];
  /** One address per line. */
  recipients: string;
  allowAnyRecipient: boolean;
  /** One `C…` per line, optionally `C…:fnA,fnB` for a per-function allowlist. */
  protocols: string;
  activeFrom: string;
  activeUntil: string;
  paused: boolean;
  dmsGraceSecs: string;
}

export const EMPTY_DRAFT: PolicyDraft = {
  perTxCap: "",
  windowCap: "",
  windowSecs: "86400",
  assets: "",
  assetCaps: [],
  recipients: "",
  allowAnyRecipient: false,
  protocols: "",
  activeFrom: "",
  activeUntil: "",
  paused: false,
  dmsGraceSecs: "",
};

const MAX_POLICY_CAP = (1n << 127n) - 1n;
const MAX_POLICY_SECONDS = (1n << 64n) - 1n;

export interface FieldIssue {
  field: keyof PolicyDraft;
  message: string;
}

export type ValidationResult =
  { ok: true; config: PolicyConfig; scval: xdr.ScVal } | { ok: false; issues: FieldIssue[] };

function parseCap(
  value: string,
  field: keyof PolicyDraft,
  label: string,
  issues: FieldIssue[],
): bigint {
  const trimmed = value.trim();
  if (trimmed === "") return 0n;
  if (!/^\d+$/.test(trimmed)) {
    issues.push({
      field,
      message: `${label} must be a whole number of units, or blank to disable`,
    });
    return 0n;
  }
  try {
    const parsed = BigInt(trimmed);
    const maximum =
      field === "perTxCap" || field === "windowCap" ? MAX_POLICY_CAP : MAX_POLICY_SECONDS;
    if (parsed > maximum) {
      issues.push({
        field,
        message: `${label} exceeds the maximum supported value of ${maximum}`,
      });
      return 0n;
    }
    return parsed;
  } catch {
    issues.push({ field, message: `${label} is not a valid integer` });
    return 0n;
  }
}

function parseAddresses(
  value: string,
  field: keyof PolicyDraft,
  label: string,
  issues: FieldIssue[],
): string[] {
  const out: string[] = [];
  for (const line of value.split(/[\n,]/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      Address.fromString(trimmed);
      out.push(trimmed);
    } catch {
      issues.push({ field, message: `${label}: "${trimmed}" is not a valid Stellar address` });
    }
  }
  return out;
}

/**
 * Turn a draft into the SDK's `PolicyConfig` and its `ScVal` encoding.
 *
 * Validation is deliberately strict and local: the contract has a
 * `validate_config` of its own and will panic with `InvalidConfig` (#4), but an
 * operator should be told which field is wrong in the form, before a wallet
 * prompt, rather than reading a host error afterwards.
 */
export function buildPolicyConfig(draft: PolicyDraft): ValidationResult {
  const issues: FieldIssue[] = [];

  const perTxCap = parseCap(draft.perTxCap, "perTxCap", "Per-transaction cap", issues);
  const windowCap = parseCap(draft.windowCap, "windowCap", "Rolling-window cap", issues);
  const windowSecs = parseCap(draft.windowSecs, "windowSecs", "Rolling-window length", issues);
  const activeFrom = parseCap(draft.activeFrom, "activeFrom", "Active from", issues);
  const activeUntil = parseCap(draft.activeUntil, "activeUntil", "Active until", issues);
  const dmsGraceSecs = parseCap(draft.dmsGraceSecs, "dmsGraceSecs", "Dead-man grace", issues);

  const assets = parseAddresses(draft.assets, "assets", "Assets", issues);
  const recipients = parseAddresses(draft.recipients, "recipients", "Recipients", issues);
  for (const message of validateAssetCapOverrides(draft.assetCaps)) {
    issues.push({ field: "assetCaps", message });
  }

  const protocols: Array<{ contract: string; fns: string[] | null }> = [];
  for (const line of draft.protocols.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [head, tail] = splitOnce(trimmed, ":");
    try {
      Address.fromString(head);
    } catch {
      issues.push({
        field: "protocols",
        message: `Protocols: "${head}" is not a valid contract address`,
      });
      continue;
    }
    const fns =
      tail && tail.trim() !== ""
        ? tail
            .split(",")
            .map((fn) => fn.trim())
            .filter(Boolean)
        : null;
    protocols.push({ contract: head, fns });
  }

  // Cross-field rules, applied here because they are about the policy the
  // operator is describing, not about any one box.
  if (windowCap > 0n && windowSecs === 0n) {
    issues.push({
      field: "windowSecs",
      message: "A rolling-window cap needs a non-zero window length, or it can never apply",
    });
  }
  if (activeFrom > 0n && activeUntil > 0n && activeUntil <= activeFrom) {
    issues.push({ field: "activeUntil", message: "Active until must be later than active from" });
  }
  if (!draft.allowAnyRecipient && recipients.length === 0 && assets.length > 0) {
    issues.push({
      field: "recipients",
      message:
        "With the recipient allowlist on and no recipients listed, every transfer is refused. " +
        "Add at least one recipient, or allow any recipient.",
    });
  }

  if (issues.length > 0) return { ok: false, issues };

  const config: PolicyConfig = {
    per_tx_cap: perTxCap,
    window_secs: windowSecs,
    window_cap: windowCap,
    assets,
    protocols,
    recipients,
    allow_any_recipient: draft.allowAnyRecipient,
    active_from: activeFrom,
    active_until: activeUntil,
    paused: draft.paused,
    dms_grace_secs: dmsGraceSecs,
  };
  return { ok: true, config, scval: policyToScVal(config) };
}

/** Return the first actionable validation message for each affected field. */
export function validatePolicyDraftFields(draft: PolicyDraft): Record<string, string> {
  const result = buildPolicyConfig(draft);
  if (result.ok) return {};

  const errors: Record<string, string> = {};
  for (const issue of result.issues) errors[issue.field] ??= issue.message;
  return errors;
}

/** Compare complete policy drafts without narrowing their string-backed values. */
export function policyDraftsEqual(left: PolicyDraft, right: PolicyDraft): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function splitOnce(value: string, separator: string): [string, string] {
  const index = value.indexOf(separator);
  if (index < 0) return [value, ""];
  return [value.slice(0, index), value.slice(index + 1)];
}

/** Render an installed `PolicyConfig` back into a draft, so the form can be edited. */
export function draftFromConfig(config: PolicyConfig): PolicyDraft {
  return {
    perTxCap: renderBigint(config.per_tx_cap),
    windowCap: renderBigint(config.window_cap),
    windowSecs: renderBigint(config.window_secs),
    assets: config.assets.join("\n"),
    assetCaps: [],
    recipients: config.recipients.join("\n"),
    allowAnyRecipient: config.allow_any_recipient,
    protocols: config.protocols
      .map((rule) =>
        rule.fns && rule.fns.length > 0 ? `${rule.contract}:${rule.fns.join(",")}` : rule.contract,
      )
      .join("\n"),
    activeFrom: renderBigint(config.active_from),
    activeUntil: renderBigint(config.active_until),
    paused: config.paused,
    dmsGraceSecs: renderBigint(config.dms_grace_secs),
  };
}

/** `0` renders as blank, because in every cap field zero means "disabled". */
function renderBigint(value: bigint): string {
  return value === 0n ? "" : value.toString();
}

/** A one-line human summary of a draft's policy, for the confirmation step. */
export function describeDraft(draft: PolicyDraft): string {
  const built = buildPolicyConfig(draft);
  if (!built.ok) return "Policy is not valid yet";
  const c = built.config;
  const caps = [
    c.per_tx_cap > 0n ? `per-transaction cap ${c.per_tx_cap}` : "no per-transaction cap",
    c.window_cap > 0n ? `rolling cap ${c.window_cap} per ${c.window_secs}s` : "no rolling cap",
  ];
  const recipients = c.allow_any_recipient
    ? "any recipient"
    : `${c.recipients.length} allowlisted recipient(s)`;
  const protocols = c.protocols.length === 0 ? "no protocols" : `${c.protocols.length} protocol(s)`;
  const dms = c.dms_grace_secs > 0n ? `dead-man grace ${c.dms_grace_secs}s` : "dead-man switch off";
  return [
    caps.join(", "),
    recipients,
    protocols,
    c.assets.length === 1 ? "1 asset" : `${c.assets.length} assets`,
    c.paused ? "PAUSED" : "active",
    dms,
  ].join(" · ");
}
