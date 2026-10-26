/**
 * Moving a policy from one guard to another.
 *
 * Upgrading usually means a new contract address and the same thirty rules
 * re-entered by hand — the point at which an operator's careful allowlist turns
 * into a typo'd one. The read side is already here: `readPolicy` returns a
 * deployed guard's `PolicyConfig`, and `policyForm.ts` converts that shape to
 * and from the operator's form. What was missing is the step between them: say
 * what the source actually holds, prove the target can accept it, and hand over
 * an installable draft instead of a shrug.
 *
 * Nothing here writes to a chain. A migration is *prepared* — the payload the
 * target's `set_policy` would receive — and the operator still signs it in the
 * same way they sign any other policy change.
 */

import type { PolicyConfig, ProtocolRule } from "stellar-agent-guard-sdk";
import { buildPolicyConfig, draftFromConfig, type PolicyDraft } from "./policyForm.ts";

/** One field of the target contract's `PolicyConfig`, as the form needs it. */
export interface TargetField {
  name: string;
  /** A field the contract's struct has no default for: migration must supply it. */
  required: boolean;
  /** What it means, in the operator's words, for the review step. */
  label: string;
}

/**
 * The schema this build writes. Field names are exactly the contract's
 * `PolicyConfig` fields (see `PolicyConfig` in the SDK), so a source that
 * disagrees with this list is a source from a different contract version —
 * which is the thing an operator needs told before, not after, a migration.
 */
export const TARGET_POLICY_FIELDS: readonly TargetField[] = [
  { name: "per_tx_cap", required: true, label: "per-transaction cap" },
  { name: "window_secs", required: true, label: "rolling-window length" },
  { name: "window_cap", required: true, label: "rolling-window cap" },
  { name: "assets", required: true, label: "asset allowlist" },
  { name: "protocols", required: true, label: "protocol allowlist" },
  { name: "recipients", required: true, label: "recipient allowlist" },
  { name: "allow_any_recipient", required: true, label: "allow-any-recipient flag" },
  { name: "active_from", required: true, label: "active-from timestamp" },
  { name: "active_until", required: true, label: "active-until timestamp" },
  { name: "paused", required: true, label: "paused flag" },
  { name: "dms_grace_secs", required: true, label: "dead-man grace" },
];

/**
 * Key spellings folded onto the contract's field names.
 *
 * A policy that left this dashboard as JSON, or was hand-copied out of an
 * explorer, arrives in camelCase or with a word swapped. Folding those is not
 * the same as claiming an old contract used them: anything that does not fold
 * onto a target field is reported as unknown rather than quietly dropped.
 */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  // Keys are the punctuation-free, lowercased spelling `foldKey` produces.
  pertxcap: "per_tx_cap",
  pertxlimit: "per_tx_cap",
  windowsecs: "window_secs",
  windowlengthsecs: "window_secs",
  windowcap: "window_cap",
  windowlimit: "window_cap",
  allowanyrecipient: "allow_any_recipient",
  anyrecipient: "allow_any_recipient",
  activefrom: "active_from",
  activeuntil: "active_until",
  dmgracesecs: "dms_grace_secs",
  dmsgracesecs: "dms_grace_secs",
  dmsgrace: "dms_grace_secs",
  recipientallowlist: "recipients",
  protocolallowlist: "protocols",
  assetallowlist: "assets",
};

function foldKey(key: string): string {
  const cleaned = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return KEY_ALIASES[cleaned] ?? key.toLowerCase();
}

/**
 * Conversion status for a single policy field during migration.
 *
 * - "copied": field was present in source with correct type, copied as-is
 * - "transformed": field was present but required type conversion (e.g., string -> bigint)
 * - "defaulted": field was missing in source, default value (0/false/empty) will be used
 * - "unsupported": field exists in source but has no target counterpart, will be dropped
 * - "unchanged": field was present and matches exactly (same value, same type)
 * - "type-error": field was present but had wrong type, migration blocked
 * - "missing-required": required field missing from source, migration blocked
 */
export type FieldConversionStatus =
  | "copied"
  | "transformed"
  | "defaulted"
  | "unsupported"
  | "unchanged"
  | "type-error"
  | "missing-required";

/** Detailed conversion result for a single field. */
export interface FieldConversion {
  /** Target field name (e.g., "per_tx_cap"). */
  targetField: string;
  /** Human-readable label for the operator. */
  label: string;
  /** Source field name that mapped to this target (may differ due to folding). */
  sourceField: string | null;
  /** Raw source value before any conversion. */
  sourceValue: unknown;
  /** Converted value that will be installed (null if blocked). */
  convertedValue: unknown;
  /** Conversion status. */
  status: FieldConversionStatus;
  /** Human-readable explanation of the conversion. */
  detail: string;
  /** Whether this field is required by the target schema. */
  required: boolean;
}

export interface CompatibilityReport {
  /** A migration can be prepared: every target field is present and typed. */
  ok: boolean;
  /** Target fields the source does not carry: they must be re-entered. */
  missing: string[];
  /** Source fields with no target counterpart: they will not survive the move. */
  unrecognised: string[];
  /** Fields that arrived under a folded name, so the operator sees the mapping. */
  renamed: Array<{ from: string; to: string }>;
  /** Present but the wrong shape (a cap that is a string, an allowlist that is not a list). */
  typeIssues: string[];
  notes: string[];
  /** Field-by-field conversion details for the review step. */
  fieldConversions: FieldConversion[];
}

/**
 * Compare a source policy against this build's schema.
 *
 * The report is deliberately triple-columned — missing, folded, unrecognised —
 * because "the migration failed" and "the migration dropped three rules" are
 * different mistakes, and only the first one announces itself.
 */
export function validateSourcePolicy(source: unknown): CompatibilityReport {
  const missing: string[] = [];
  const unrecognised: string[] = [];
  const renamed: Array<{ from: string; to: string }> = [];
  const typeIssues: string[] = [];
  const notes: string[] = [];
  const fieldConversions: FieldConversion[] = [];

  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    const conversions: FieldConversion[] = TARGET_POLICY_FIELDS.map((field) => ({
      targetField: field.name,
      label: field.label,
      sourceField: null,
      sourceValue: undefined,
      convertedValue: null,
      status: "missing-required" as FieldConversionStatus,
      detail: "Required field missing: source is not a readable policy object",
      required: field.required,
    }));
    return {
      ok: false,
      missing: TARGET_POLICY_FIELDS.map((field) => field.name),
      unrecognised: [],
      renamed: [],
      typeIssues: [],
      notes: ["The source returned no policy object: it is unreadable, not empty."],
      fieldConversions: conversions,
    };
  }

  const raw = source as Record<string, unknown>;
  const mapped = new Map<string, { value: unknown; from: string }>();
  for (const [key, value] of Object.entries(raw)) {
    const target = foldKey(key);
    if (!TARGET_POLICY_FIELDS.some((field) => field.name === target)) {
      unrecognised.push(key);
      continue;
    }
    if (target !== key.toLowerCase()) renamed.push({ from: key, to: target });
    const already = mapped.get(target);
    if (already) {
      notes.push(`Both "${already.from}" and "${key}" map to ${target}; the first one is used.`);
      continue;
    }
    mapped.set(target, { value, from: key });
  }

  for (const field of TARGET_POLICY_FIELDS) {
    const entry = mapped.get(field.name);
    if (!entry) {
      missing.push(field.name);
      fieldConversions.push({
        targetField: field.name,
        label: field.label,
        sourceField: null,
        sourceValue: undefined,
        convertedValue: null,
        status: "missing-required",
        detail: `Required field missing from source; will default to ${field.required ? "zero/false/empty (blocking migration)" : "zero/false/empty"}`,
        required: field.required,
      });
      continue;
    }

    const typeIssue = checkType(field.name, entry.value);
    if (typeIssue) {
      typeIssues.push(typeIssue);
      fieldConversions.push({
        targetField: field.name,
        label: field.label,
        sourceField: entry.from,
        sourceValue: entry.value,
        convertedValue: null,
        status: "type-error",
        detail: typeIssue,
        required: field.required,
      });
      continue;
    }

    // Determine the converted value
    let convertedValue: unknown;
    const isCapField = new Set([
      "per_tx_cap",
      "window_secs",
      "window_cap",
      "active_from",
      "active_until",
      "dms_grace_secs",
    ]).has(field.name);

    if (isCapField) {
      const value = entry.value;
      if (typeof value === "bigint") convertedValue = value;
      else if (typeof value === "number") convertedValue = BigInt(Math.trunc(value));
      else if (typeof value === "string" && /^\d+$/.test(value.trim()))
        convertedValue = BigInt(value.trim());
      else convertedValue = 0n;
    } else if (field.name === "assets" || field.name === "recipients") {
      const value = entry.value;
      convertedValue = Array.isArray(value)
        ? value.filter((v): v is string => typeof v === "string")
        : [];
    } else if (field.name === "protocols") {
      const value = entry.value;
      convertedValue = Array.isArray(value)
        ? value
            .filter(
              (rule): rule is { contract: string; fns: string[] | null } =>
                typeof rule === "object" &&
                rule !== null &&
                typeof (rule as any).contract === "string",
            )
            .map((rule) => ({
              contract: rule.contract,
              fns: Array.isArray(rule.fns)
                ? rule.fns.filter((fn): fn is string => typeof fn === "string")
                : null,
            }))
        : [];
    } else {
      // boolean fields: accept both boolean and string "true"/"false"
      if (typeof entry.value === "string") {
        convertedValue = entry.value === "true";
      } else {
        convertedValue = entry.value === true;
      }
    }

    // Determine if the value was transformed (only if conversion actually changes the value)
    const wasTransformed =
      (typeof entry.value === "string" && isCapField) ||
      (typeof entry.value === "number" && isCapField) ||
      (Array.isArray(entry.value) &&
        (field.name === "assets" || field.name === "recipients") &&
        !entry.value.every((item) => typeof item === "string")) ||
      (Array.isArray(entry.value) &&
        field.name === "protocols" &&
        !entry.value.every(
          (rule) =>
            typeof rule === "object" && rule !== null && typeof (rule as any).contract === "string",
        )) ||
      (typeof entry.value === "string" &&
        (field.name === "paused" || field.name === "allow_any_recipient"));

    fieldConversions.push({
      targetField: field.name,
      label: field.label,
      sourceField: entry.from,
      sourceValue: entry.value,
      convertedValue,
      status: wasTransformed ? "transformed" : "copied",
      detail: wasTransformed
        ? `Converted from ${typeof entry.value} (${JSON.stringify(entry.value).slice(0, 50)}) to ${typeof convertedValue}`
        : "Copied as-is",
      required: field.required,
    });
  }

  const protocols = mapped.get("protocols")?.value;
  if (Array.isArray(protocols) && protocols.some((rule) => !isProtocolRule(rule))) {
    typeIssues.push("protocols: at least one entry is not a { contract, fns } rule");
  }
  if (mapped.get("allow_any_recipient")?.value === true) {
    notes.push(
      "The source allows any recipient; that is the widest recipient rule the contract supports, and it moves across as-is.",
    );
  }

  // Add unrecognised fields as unsupported conversions
  for (const unrecKey of unrecognised) {
    fieldConversions.push({
      targetField: unrecKey,
      label: unrecKey,
      sourceField: unrecKey,
      sourceValue: raw[unrecKey],
      convertedValue: null,
      status: "unsupported",
      detail: "No matching field in this build's policy schema; will be dropped",
      required: false,
    });
  }

  return {
    ok: missing.length === 0 && typeIssues.length === 0,
    missing,
    unrecognised,
    renamed,
    typeIssues,
    notes,
    fieldConversions,
  };
}

function checkType(name: string, value: unknown): string | null {
  const capFields = new Set([
    "per_tx_cap",
    "window_secs",
    "window_cap",
    "active_from",
    "active_until",
    "dms_grace_secs",
  ]);
  const listFields = new Set(["assets", "recipients"]);
  if (capFields.has(name)) {
    if (typeof value === "bigint" || typeof value === "number") return null;
    if (typeof value === "string" && /^\d+$/.test(value.trim())) return null;
    return `${name}: expected a whole number of units, got ${describe(value)}`;
  }
  if (listFields.has(name)) {
    if (Array.isArray(value)) return null;
    return `${name}: expected a list of addresses, got ${describe(value)}`;
  }
  if (name === "protocols") {
    if (Array.isArray(value)) return null;
    return `protocols: expected a list of protocol rules, got ${describe(value)}`;
  }
  if (name === "paused" || name === "allow_any_recipient") {
    if (typeof value === "boolean") return null;
    if (typeof value === "string" && (value === "true" || value === "false")) return null;
    return `${name}: expected true or false, got ${describe(value)}`;
  }
  return null;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  return `a ${typeof value}`;
}

function isProtocolRule(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const rule = value as { contract?: unknown; fns?: unknown };
  return typeof rule.contract === "string" && (rule.fns === null || Array.isArray(rule.fns));
}

/** Normalise a source object into the shape `draftFromConfig` consumes. */
function toPolicyConfig(source: Record<string, unknown>): PolicyConfig {
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    const target = foldKey(key);
    if (mapped[target] !== undefined) continue;
    mapped[target] = target === "protocols" ? normaliseProtocols(value) : value;
  }
  const cap = (name: string): bigint => {
    const value = mapped[name];
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(Math.trunc(value));
    if (typeof value === "string" && /^\d+$/.test(value.trim())) return BigInt(value.trim());
    return 0n;
  };
  return {
    per_tx_cap: cap("per_tx_cap"),
    window_secs: cap("window_secs"),
    window_cap: cap("window_cap"),
    assets: toStringList(mapped.assets),
    protocols: Array.isArray(mapped.protocols) ? (mapped.protocols as ProtocolRule[]) : [],
    recipients: toStringList(mapped.recipients),
    allow_any_recipient: mapped.allow_any_recipient === true,
    active_from: cap("active_from"),
    active_until: cap("active_until"),
    paused: mapped.paused === true,
    dms_grace_secs: cap("dms_grace_secs"),
  };
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function normaliseProtocols(value: unknown): ProtocolRule[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((rule): rule is ProtocolRule => isProtocolRule(rule))
    .map((rule) => ({
      contract: rule.contract,
      fns: Array.isArray(rule.fns)
        ? rule.fns.filter((fn): fn is string => typeof fn === "string")
        : null,
    }));
}

export type MigrationPlan =
  | {
      ok: true;
      source: PolicyConfig;
      draft: PolicyDraft;
      report: CompatibilityReport;
      /** The exact description `installPolicy` will put on chain. */
      summary: string;
      /** What the move changes, in the operator's terms. */
      carried: string[];
      dropped: string[];
    }
  | { ok: false; report: CompatibilityReport; message: string };

/** The network a migration preview was built for. */
export interface MigrationNetwork {
  name: string;
  passphrase: string;
}

/** The destination identity a preview is bound to. */
export interface MigrationScope {
  destination: string;
  network: MigrationNetwork;
}

/**
 * A source read together with the destination it was reviewed for.
 *
 * The source policy and the destination account are two different chain facts.
 * Reading the source once and then switching the active guard would otherwise
 * leave a plan that looks reviewed but was never reviewed *for that guard*.
 * Binding the read to this scope is what makes that stale plan detectable
 * instead of merely old.
 */
export interface MigrationPreview {
  destination: string;
  network: MigrationNetwork;
  /** When the source and destination reads that produced this plan completed. */
  readAt: string;
  plan: MigrationPlan;
}

/** Build the record the review step displays and the submit guard checks. */
export function buildMigrationPreview(params: {
  plan: MigrationPlan;
  destination: string;
  network: MigrationNetwork;
  readAt?: string;
}): MigrationPreview {
  return {
    plan: params.plan,
    destination: params.destination.trim(),
    network: { ...params.network },
    readAt: params.readAt ?? new Date().toISOString(),
  };
}

export type PreviewValidity = { ok: true } | { ok: false; reason: string };

/**
 * Is this preview still about the destination the operator is looking at?
 *
 * Deliberately strict: a different network *name* or passphrase is just as much
 * a different target as a different address. A preview that survived either
 * change would carry a policy read from one account into another.
 */
export function migrationPreviewValidity(
  preview: MigrationPreview,
  current: MigrationScope,
): PreviewValidity {
  const destination = current.destination.trim();
  if (preview.destination === "") {
    return {
      ok: false,
      reason: "The preview has no destination address.",
    };
  }
  if (destination === "") {
    return {
      ok: false,
      reason: `The destination is now empty; the preview was built for ${preview.destination}. Re-read the source and destination before applying.`,
    };
  }
  if (destination !== preview.destination) {
    return {
      ok: false,
      reason: `The destination changed from ${preview.destination} to ${destination}. Re-read the source and destination before applying.`,
    };
  }
  if (current.network.name !== preview.network.name) {
    return {
      ok: false,
      reason: `The network changed from ${preview.network.name} to ${current.network.name}. Re-read the source and destination before applying.`,
    };
  }
  if (current.network.passphrase !== preview.network.passphrase) {
    return {
      ok: false,
      reason:
        "The network passphrase changed. A policy read for one network cannot authorize a write on another; re-read before applying.",
    };
  }
  return { ok: true };
}

/**
 * The single submit gate: a portable plan, read for this exact destination and
 * network. The UI calls this both to enable the button and again immediately
 * before invoking the wallet, so a switch in another tab cannot slip through.
 */
export function canSubmitMigrationPreview(
  preview: MigrationPreview,
  current: MigrationScope,
): PreviewValidity {
  const scope = migrationPreviewValidity(preview, current);
  if (!scope.ok) return scope;
  if (!preview.plan.ok) {
    return {
      ok: false,
      reason: "The preview is not a directly portable policy.",
    };
  }
  return { ok: true };
}

/** A readable statement of what the preview is bound to, for the review step. */
export function describeMigrationScope(preview: MigrationPreview): string {
  return `${preview.destination} on ${preview.network.name}`;
}

/**
 * Read a source policy and prepare the target's `set_policy` payload.
 *
 * The draft round-trips through the form's own validator
 * (`buildPolicyConfig`), so a policy that could not be installed had it been
 * typed by hand cannot be installed by migration either. That is the whole
 * guarantee this function offers, and it is why it refuses on an incomplete
 * source instead of filling in blanks: a zeroed cap is a silent policy change.
 */
export function planMigration(source: unknown): MigrationPlan {
  const report = validateSourcePolicy(source);
  if (!report.ok) {
    const parts: string[] = [];
    if (report.missing.length > 0) parts.push(`missing ${report.missing.join(", ")}`);
    if (report.typeIssues.length > 0) parts.push(report.typeIssues.join("; "));
    return {
      ok: false,
      report,
      message: `The source policy is not directly portable: ${parts.join("; ")}.`,
    };
  }

  const config = toPolicyConfig(source as Record<string, unknown>);
  const draft = draftFromConfig(config);
  const built = buildPolicyConfig(draft);
  if (!built.ok) {
    return {
      ok: false,
      report,
      message: `The migrated policy fails this build's validation: ${built.issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ")}.`,
    };
  }

  const carried: string[] = [];
  if (config.per_tx_cap > 0n) carried.push(`per-transaction cap ${config.per_tx_cap}`);
  if (config.window_cap > 0n)
    carried.push(`rolling cap ${config.window_cap} per ${config.window_secs}s`);
  if (config.assets.length > 0) carried.push(`${config.assets.length} asset(s)`);
  if (config.recipients.length > 0) carried.push(`${config.recipients.length} recipient(s)`);
  if (config.protocols.length > 0) carried.push(`${config.protocols.length} protocol rule(s)`);
  if (config.allow_any_recipient) carried.push("any recipient allowed");
  if (config.dms_grace_secs > 0n) carried.push(`dead-man grace ${config.dms_grace_secs}s`);
  if (config.paused) carried.push("installed in the paused state");

  const dropped = report.unrecognised.map((field) => `${field} (no field on this build's policy)`);

  return {
    ok: true,
    source: config,
    draft,
    report,
    summary: describeMigrationSummary(config, dropped),
    carried,
    dropped,
  };
}

function describeMigrationSummary(config: PolicyConfig, dropped: readonly string[]): string {
  const parts = [
    config.per_tx_cap > 0n ? `per-tx ${config.per_tx_cap}` : "no per-tx cap",
    config.window_cap > 0n ? `window ${config.window_cap}/${config.window_secs}s` : "no window cap",
    `${config.assets.length} asset(s)`,
    config.allow_any_recipient ? "any recipient" : `${config.recipients.length} recipient(s)`,
    `${config.protocols.length} protocol rule(s)`,
    config.dms_grace_secs > 0n ? `dead-man ${config.dms_grace_secs}s` : "dead-man off",
    config.paused ? "PAUSED on install" : "active on install",
  ];
  if (dropped.length > 0) parts.push(`${dropped.length} source field(s) not carried`);
  return parts.join(" · ");
}

/** The fields a review step shows, so an operator can eyeball the whole policy. */
export function sourceRows(source: PolicyConfig): Array<{ label: string; value: string }> {
  return [
    { label: "Per-transaction cap", value: configText(source.per_tx_cap) },
    {
      label: "Rolling window",
      value: `${configText(source.window_cap)} every ${configText(source.window_secs)}s`,
    },
    { label: "Assets", value: listOr(source.assets, "none — every asset is denied") },
    {
      label: "Recipients",
      value: source.allow_any_recipient
        ? "any recipient"
        : listOr(source.recipients, "none — every recipient is denied"),
    },
    {
      label: "Protocols",
      value: listOr(
        source.protocols.map((rule) =>
          rule.fns && rule.fns.length > 0
            ? `${rule.contract}:${rule.fns.join(",")}`
            : rule.contract,
        ),
        "none",
      ),
    },
    {
      label: "Active window",
      value:
        source.active_from === 0n && source.active_until === 0n
          ? "always"
          : `${configText(source.active_from)} → ${configText(source.active_until)}`,
    },
    { label: "Paused", value: source.paused ? "yes" : "no" },
    {
      label: "Dead-man grace",
      value: source.dms_grace_secs > 0n ? `${configText(source.dms_grace_secs)}s` : "off",
    },
  ];
}

function configText(value: bigint): string {
  return value === 0n ? "0" : value.toString();
}

function listOr(items: readonly string[], whenEmpty: string): string {
  return items.length === 0 ? whenEmpty : items.join(", ");
}
