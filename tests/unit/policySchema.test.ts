import assert from "node:assert/strict";
import { test } from "node:test";
import type { PolicyConfig } from "stellar-agent-guard-sdk";
import {
  POLICY_SCHEMA_VERSION,
  exportPolicyDraft,
  exportPolicyToJson,
  importPolicyFromJson,
  policyToExport,
} from "../../lib/guard/policySchema.ts";
import { EMPTY_DRAFT, type PolicyDraft } from "../../lib/guard/policyForm.ts";
import type { AssetCapOverride } from "../../lib/guard/assetCapsCsv.ts";

const ASSET = "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB";
const RECIPIENT = "GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH";
const PROTOCOL = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";

const assetCaps: AssetCapOverride[] = [
  { assetContractAddress: ASSET, maxCapStroops: "1000000", symbol: "USDC" },
];

const fullConfig: PolicyConfig = {
  per_tx_cap: 1000n,
  window_cap: 5000n,
  window_secs: 86400n,
  assets: [ASSET],
  protocols: [{ contract: PROTOCOL, fns: ["swap", "deposit"] }],
  recipients: [RECIPIENT],
  allow_any_recipient: false,
  active_from: 1000n,
  active_until: 2000n,
  paused: false,
  dms_grace_secs: 3600n,
};

const filledDraft: PolicyDraft = {
  ...EMPTY_DRAFT,
  perTxCap: "1000",
  windowCap: "5000",
  windowSecs: "86400",
  assets: ASSET,
  assetCaps,
  recipients: RECIPIENT,
  allowAnyRecipient: false,
  protocols: `${PROTOCOL}:swap,deposit`,
  dmsGraceSecs: "3600",
};

test("policyToExport / importPolicyFromJson round-trips a full config", () => {
  const json = exportPolicyToJson(fullConfig, assetCaps);
  const result = importPolicyFromJson(json);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.draft.perTxCap, "1000");
  assert.equal(result.draft.windowCap, "5000");
  assert.equal(result.draft.windowSecs, "86400");
  assert.equal(result.draft.assets, ASSET);
  assert.equal(result.draft.recipients, RECIPIENT);
  assert.equal(result.draft.allowAnyRecipient, false);
  assert.equal(result.draft.protocols, `${PROTOCOL}:swap,deposit`);
  assert.equal(result.draft.dmsGraceSecs, "3600");
  assert.deepEqual(result.draft.assetCaps, assetCaps);
});

test("exported JSON carries the versioned schema and issue-specified field names", () => {
  const parsed = policyToExport(fullConfig, assetCaps);
  assert.equal(parsed.version, POLICY_SCHEMA_VERSION);
  assert.equal(parsed.max_amount_per_tx, "1000");
  assert.equal(parsed.window_cap, "5000");
  assert.equal(parsed.window_seconds, "86400");
  assert.equal(parsed.dead_man_switch_seconds, "3600");
  assert.deepEqual(parsed.allowed_protocols, [
    { contract: PROTOCOL, functions: ["swap", "deposit"] },
  ]);
  assert.deepEqual(parsed.denied_recipients, [RECIPIENT]);
  assert.deepEqual(parsed.per_asset_caps, [
    { asset_contract_address: ASSET, max_cap_stroops: "1000000", symbol: "USDC" },
  ]);
});

test("a zero-valued config round-trips through blank strings, matching the draft convention", () => {
  const zeroConfig: PolicyConfig = {
    per_tx_cap: 0n,
    window_cap: 0n,
    window_secs: 0n,
    assets: [],
    protocols: [],
    recipients: [],
    allow_any_recipient: true,
    active_from: 0n,
    active_until: 0n,
    paused: false,
    dms_grace_secs: 0n,
  };
  const json = exportPolicyToJson(zeroConfig, []);
  const result = importPolicyFromJson(json);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.draft.perTxCap, "");
  assert.equal(result.draft.windowCap, "");
  assert.equal(result.draft.dmsGraceSecs, "");
});

test("exportPolicyDraft rejects an invalid draft before producing a file", () => {
  const invalidDraft: PolicyDraft = { ...EMPTY_DRAFT, perTxCap: "not-a-number" };
  const result = exportPolicyDraft(invalidDraft);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.some((issue) => issue.field === "perTxCap"));
});

test("exportPolicyDraft surfaces invalid asset-cap overrides, which buildPolicyConfig alone does not check", () => {
  const draftWithBadAssetCap: PolicyDraft = {
    ...EMPTY_DRAFT,
    assetCaps: [{ assetContractAddress: "not-an-address", maxCapStroops: "10", symbol: "X" }],
  };
  const result = exportPolicyDraft(draftWithBadAssetCap);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.some((issue) => issue.field === "assetCaps"));
});

test("exportPolicyDraft produces a timestamped .guard-policy.json filename", () => {
  const result = exportPolicyDraft(filledDraft);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.filename, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.guard-policy\.json$/);
});

test("importPolicyFromJson rejects malformed JSON", () => {
  const result = importPolicyFromJson("{not valid json");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0]!.message, /not valid JSON/);
});

test("importPolicyFromJson rejects an unknown schema version with a precise path", () => {
  const json = exportPolicyToJson(fullConfig, assetCaps).replace('"version": 1', '"version": 2');
  const result = importPolicyFromJson(json);
  assert.equal(result.ok, false);
  if (result.ok) return;
  const versionIssue = result.issues.find((issue) => issue.path === "version");
  assert.ok(versionIssue, 'expected a validation issue at path "version"');
  assert.match(versionIssue!.message, /Unknown schema version/);
});

test("importPolicyFromJson rejects an invalid Stellar address with a precise field path", () => {
  const parsed = JSON.parse(exportPolicyToJson(fullConfig, assetCaps));
  parsed.assets = ["not-a-valid-address"];
  const result = importPolicyFromJson(JSON.stringify(parsed));
  assert.equal(result.ok, false);
  if (result.ok) return;
  const assetIssue = result.issues.find((issue) => issue.path === "assets[0]");
  assert.ok(assetIssue, 'expected a validation issue at path "assets[0]"');
  assert.match(assetIssue!.message, /valid Stellar address/);
});

test("importPolicyFromJson rejects a negative amount with a precise field path", () => {
  const parsed = JSON.parse(exportPolicyToJson(fullConfig, assetCaps));
  parsed.max_amount_per_tx = "-500";
  const result = importPolicyFromJson(JSON.stringify(parsed));
  assert.equal(result.ok, false);
  if (result.ok) return;
  const capIssue = result.issues.find((issue) => issue.path === "max_amount_per_tx");
  assert.ok(capIssue, 'expected a validation issue at path "max_amount_per_tx"');
  assert.match(capIssue!.message, /non-negative/);
});

test("importPolicyFromJson rejects a non-positive per-asset cap with a precise field path", () => {
  const parsed = JSON.parse(exportPolicyToJson(fullConfig, assetCaps));
  parsed.per_asset_caps[0].max_cap_stroops = "0";
  const result = importPolicyFromJson(JSON.stringify(parsed));
  assert.equal(result.ok, false);
  if (result.ok) return;
  const capIssue = result.issues.find(
    (issue) => issue.path === "per_asset_caps[0].max_cap_stroops",
  );
  assert.ok(capIssue, 'expected a validation issue at path "per_asset_caps[0].max_cap_stroops"');
});

test("importPolicyFromJson rejects a malformed protocol entry (invalid contract address)", () => {
  const parsed = JSON.parse(exportPolicyToJson(fullConfig, assetCaps));
  parsed.allowed_protocols = [{ contract: "not-an-address", functions: null }];
  const result = importPolicyFromJson(JSON.stringify(parsed));
  assert.equal(result.ok, false);
  if (result.ok) return;
  const protocolIssue = result.issues.find(
    (issue) => issue.path === "allowed_protocols[0].contract",
  );
  assert.ok(protocolIssue, 'expected a validation issue at path "allowed_protocols[0].contract"');
});

test("importPolicyFromJson reports multiple validation issues at once, each with its own path", () => {
  const parsed = JSON.parse(exportPolicyToJson(fullConfig, assetCaps));
  parsed.max_amount_per_tx = "-1";
  parsed.denied_recipients = ["not-an-address"];
  const result = importPolicyFromJson(JSON.stringify(parsed));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.length >= 2);
  assert.ok(result.issues.some((issue) => issue.path === "max_amount_per_tx"));
  assert.ok(result.issues.some((issue) => issue.path === "denied_recipients[0]"));
});

test("importPolicyFromJson rejects a fractional amount", () => {
  const parsed = JSON.parse(exportPolicyToJson(fullConfig, assetCaps));
  parsed.max_amount_per_tx = "1.5";
  const result = importPolicyFromJson(JSON.stringify(parsed));
  assert.equal(result.ok, false);
  if (result.ok) return;
  const capIssue = result.issues.find((issue) => issue.path === "max_amount_per_tx");
  assert.ok(capIssue, 'expected a validation issue at path "max_amount_per_tx"');
  assert.match(capIssue!.message, /whole number/);
});

test("importPolicyFromJson rejects an empty amount (blank is allowed)", () => {
  const parsed = JSON.parse(exportPolicyToJson(fullConfig, assetCaps));
  parsed.max_amount_per_tx = "";
  const result = importPolicyFromJson(JSON.stringify(parsed));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.draft.perTxCap, "");
});

test("importPolicyFromJson rejects a negative per-asset cap", () => {
  const parsed = JSON.parse(exportPolicyToJson(fullConfig, assetCaps));
  parsed.per_asset_caps[0].max_cap_stroops = "-10";
  const result = importPolicyFromJson(JSON.stringify(parsed));
  assert.equal(result.ok, false);
  if (result.ok) return;
  const capIssue = result.issues.find(
    (issue) => issue.path === "per_asset_caps[0].max_cap_stroops",
  );
  assert.ok(capIssue, 'expected a validation issue at path "per_asset_caps[0].max_cap_stroops"');
  assert.match(capIssue!.message, /positive/);
});

test("importPolicyFromJson rejects a fractional per-asset cap", () => {
  const parsed = JSON.parse(exportPolicyToJson(fullConfig, assetCaps));
  parsed.per_asset_caps[0].max_cap_stroops = "5.5";
  const result = importPolicyFromJson(JSON.stringify(parsed));
  assert.equal(result.ok, false);
  if (result.ok) return;
  const capIssue = result.issues.find(
    (issue) => issue.path === "per_asset_caps[0].max_cap_stroops",
  );
  assert.ok(capIssue, 'expected a validation issue at path "per_asset_caps[0].max_cap_stroops"');
  assert.match(capIssue!.message, /whole number/);
});

test("importPolicyFromJson rejects a malformed protocol function name", () => {
  const parsed = JSON.parse(exportPolicyToJson(fullConfig, assetCaps));
  parsed.allowed_protocols = [{ contract: PROTOCOL, functions: [""] }];
  const result = importPolicyFromJson(JSON.stringify(parsed));
  assert.equal(result.ok, false);
  if (result.ok) return;
  const protocolIssue = result.issues.find(
    (issue) => issue.path === "allowed_protocols[0].functions[0]",
  );
  assert.ok(
    protocolIssue,
    'expected a validation issue at path "allowed_protocols[0].functions[0]"',
  );
});

test("importPolicyFromJson accepts a valid large positive whole number", () => {
  const parsed = JSON.parse(exportPolicyToJson(fullConfig, assetCaps));
  parsed.max_amount_per_tx = "999999999999";
  const result = importPolicyFromJson(JSON.stringify(parsed));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.draft.perTxCap, "999999999999");
});
