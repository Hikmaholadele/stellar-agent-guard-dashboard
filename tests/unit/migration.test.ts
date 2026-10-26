import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  TARGET_POLICY_FIELDS,
  buildMigrationPreview,
  canSubmitMigrationPreview,
  describeMigrationScope,
  migrationPreviewValidity,
  planMigration,
  sourceRows,
  validateSourcePolicy,
  type FieldConversionStatus,
  type MigrationNetwork,
  type MigrationScope,
} from "../../lib/guard/migration.ts";

const TOKEN = "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB";
const RECIPIENT = "GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH";
const OTHER_TOKEN = "CBLQLJAG72M4XQRJMQHSKYIFVHQD7LNTNOQH2GRMCMBWMSLBSLTGTJC7";

/** A policy in exactly the shape this build reads off a deployed guard. */
function source(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    per_tx_cap: 1000n,
    window_secs: 60n,
    window_cap: 150n,
    assets: [TOKEN],
    protocols: [{ contract: TOKEN, fns: ["swap"] }],
    recipients: [RECIPIENT],
    allow_any_recipient: false,
    active_from: 0n,
    active_until: 0n,
    paused: false,
    dms_grace_secs: 3600n,
    ...overrides,
  };
}

/** The same policy as a JSON export: camelCase, and bigints as decimal strings. */
function exported(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    perTxCap: "1000",
    windowSecs: "60",
    windowCap: "150",
    assets: [TOKEN],
    protocols: [{ contract: TOKEN, fns: ["swap"] }],
    recipients: [RECIPIENT],
    allowAnyRecipient: false,
    activeFrom: "0",
    activeUntil: "0",
    paused: false,
    dmsGraceSecs: "3600",
    ...overrides,
  };
}

function without(name: string): Record<string, unknown> {
  const copy = source();
  delete copy[name];
  return copy;
}

test("the target schema is the contract's own field list", () => {
  assert.deepEqual(
    TARGET_POLICY_FIELDS.map((field) => field.name),
    [
      "per_tx_cap",
      "window_secs",
      "window_cap",
      "assets",
      "protocols",
      "recipients",
      "allow_any_recipient",
      "active_from",
      "active_until",
      "paused",
      "dms_grace_secs",
    ],
  );
  assert.equal(
    new Set(TARGET_POLICY_FIELDS.map((field) => field.name)).size,
    TARGET_POLICY_FIELDS.length,
  );
  // Nothing may be optional: a defaulted field is a silent policy change.
  assert.ok(TARGET_POLICY_FIELDS.every((field) => field.required));
});

test("a policy read from a current guard needs no translation", () => {
  const report = validateSourcePolicy(source());
  assert.equal(report.ok, true);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.unrecognised, []);
  assert.deepEqual(report.renamed, []);
  assert.deepEqual(report.typeIssues, []);
  assert.deepEqual(report.notes, []);
  assert.ok(report.fieldConversions);
  assert.equal(report.fieldConversions.length, 11);
  for (const conv of report.fieldConversions) {
    assert.equal(conv.status, "copied");
  }
});

test("a camelCase export is folded onto the schema and says so", () => {
  const report = validateSourcePolicy(exported());
  assert.equal(report.ok, true, report.typeIssues.join("; "));
  assert.deepEqual(report.renamed, [
    { from: "perTxCap", to: "per_tx_cap" },
    { from: "windowSecs", to: "window_secs" },
    { from: "windowCap", to: "window_cap" },
    { from: "allowAnyRecipient", to: "allow_any_recipient" },
    { from: "activeFrom", to: "active_from" },
    { from: "activeUntil", to: "active_until" },
    { from: "dmsGraceSecs", to: "dms_grace_secs" },
  ]);
});

test("an alternative spelling folds too, so an explorer dump is portable", () => {
  const report = validateSourcePolicy(
    source({ per_tx_limit: 500n, windowlengthsecs: 30n, recipientallowlist: [RECIPIENT] }),
  );
  assert.ok(
    report.renamed.some((entry) => entry.from === "per_tx_limit" && entry.to === "per_tx_cap"),
  );
  assert.ok(
    report.renamed.some((entry) => entry.from === "windowlengthsecs" && entry.to === "window_secs"),
  );
  assert.ok(
    report.renamed.some(
      (entry) => entry.from === "recipientallowlist" && entry.to === "recipients",
    ),
  );
});

test("a field this build has no place for is reported, not quietly dropped", () => {
  const report = validateSourcePolicy(source({ legacy_daily_limit: 9n, oldAgentKey: "G.." }));
  assert.deepEqual(report.unrecognised, ["legacy_daily_limit", "oldAgentKey"]);
  assert.equal(report.ok, true, "an extra field does not block the move, it just does not survive");

  const plan = planMigration(source({ legacy_daily_limit: 9n }));
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual(plan.dropped, ["legacy_daily_limit (no field on this build's policy)"]);
  assert.match(plan.summary, /1 source field\(s\) not carried/);
});

test("a missing target field stops the plan and names the field", () => {
  for (const name of ["per_tx_cap", "assets", "paused"]) {
    const report = validateSourcePolicy(without(name));
    assert.equal(report.ok, false, `${name} has no default`);
    assert.deepEqual(report.missing, [name]);

    const plan = planMigration(without(name));
    assert.equal(plan.ok, false);
    if (plan.ok) return;
    assert.match(plan.message, new RegExp(`missing ${name}`));
  }
});

test("a policy object that is not there at all reads as unreadable, not empty", () => {
  for (const bad of [null, undefined, "policy", 7, []]) {
    const report = validateSourcePolicy(bad);
    assert.equal(report.ok, false);
    assert.equal(report.missing.length, TARGET_POLICY_FIELDS.length);
    assert.match(report.notes.join(" "), /unreadable, not empty/);
  }
});

test("a present field of the wrong shape is a type issue, not a default", () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["per_tx_cap", "1,000", /per_tx_cap: expected a whole number/],
    ["window_secs", null, /window_secs: expected a whole number/],
    ["assets", TOKEN, /assets: expected a list of addresses/],
    ["protocols", "swap", /protocols: expected a list/],
    ["paused", "not-a-bool", /paused: expected true or false/],
    ["allow_any_recipient", 1, /allow_any_recipient: expected true or false/],
  ];
  for (const [name, value, pattern] of cases) {
    const report = validateSourcePolicy(source({ [name]: value }));
    assert.equal(report.ok, false, `${name} = ${String(value)} must not migrate`);
    assert.match(report.typeIssues.join("; "), pattern);
  }

  // Test that arrays with non-string elements are accepted but filtered (transformed)
  const recipientsReport = validateSourcePolicy(source({ recipients: [1, 2] }));
  assert.equal(recipientsReport.ok, true, "array with non-strings should be accepted and filtered");
  const recipientsConv = recipientsReport.fieldConversions.find(
    (c) => c.targetField === "recipients",
  );
  assert.ok(recipientsConv);
  assert.equal(recipientsConv.status, "transformed");
  assert.deepEqual(recipientsConv.convertedValue, []);
});

test("a protocol rule without its function list is flagged", () => {
  const loose = validateSourcePolicy(source({ protocols: [{ contract: TOKEN }] }));
  assert.equal(loose.ok, false);
  assert.match(loose.typeIssues.join("; "), /at least one entry is not a \{ contract, fns \} rule/);

  // `fns: null` means "every function", which is a real rule and must pass.
  assert.equal(
    validateSourcePolicy(source({ protocols: [{ contract: TOKEN, fns: null }] })).ok,
    true,
  );
});

test("numeric strings migrate into exact bigints", () => {
  const plan = planMigration(exported());
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.source.per_tx_cap, 1000n);
  assert.equal(plan.source.window_secs, 60n);
  assert.equal(plan.source.dms_grace_secs, 3600n);

  const huge = "170141183460469231731687303715884105727"; // i128::MAX
  const big = planMigration(exported({ perTxCap: huge }));
  assert.equal(big.ok, true);
  if (!big.ok) return;
  assert.equal(big.source.per_tx_cap, 170141183460469231731687303715884105727n);
  assert.equal(big.draft.perTxCap, huge, "a cap must not pass through a float");
});

test("two spellings of one field keep the first and say which", () => {
  const plan = planMigration({ ...exported(), per_tx_cap: 4242n });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.match(
    plan.report.notes.join(" "),
    /Both "perTxCap" and "per_tx_cap" map to per_tx_cap; the first one is used/,
  );
  assert.equal(plan.source.per_tx_cap, 1000n, "documented precedence beats a silent guess");
});

test("the widest recipient rule moves across with a warning", () => {
  const report = validateSourcePolicy(source({ allow_any_recipient: true }));
  assert.equal(report.ok, true);
  assert.match(report.notes.join(" "), /allows any recipient/);
});

test("a migration goes through the same validator as a hand-typed policy", () => {
  // A rolling cap with no window can never apply; migrating one would install a
  // rule that looks enforced and is not.
  const windowless = planMigration(source({ window_secs: 0n }));
  assert.equal(windowless.ok, false);
  if (windowless.ok) return;
  assert.match(windowless.message, /fails this build's validation/);
  assert.match(
    windowless.message,
    /windowSecs: A rolling-window cap needs a non-zero window length/,
  );

  const expired = planMigration(source({ active_from: 500n, active_until: 400n }));
  assert.equal(expired.ok, false);
  if (expired.ok) return;
  assert.match(expired.message, /Active until must be later than active from/);

  const noRecipients = planMigration(source({ recipients: [] }));
  assert.equal(noRecipients.ok, false);
  if (noRecipients.ok) return;
  assert.match(noRecipients.message, /recipients:/);
});

test("a clean plan hands over an installable draft and an honest summary", () => {
  const plan = planMigration(source());
  assert.equal(plan.ok, true);
  if (!plan.ok) return;

  assert.deepEqual(plan.draft, {
    perTxCap: "1000",
    windowCap: "150",
    windowSecs: "60",
    assets: TOKEN,
    assetCaps: [],
    recipients: RECIPIENT,
    allowAnyRecipient: false,
    protocols: `${TOKEN}:swap`,
    activeFrom: "",
    activeUntil: "",
    paused: false,
    dmsGraceSecs: "3600",
  });
  assert.deepEqual(plan.dropped, []);
  assert.deepEqual(plan.carried, [
    "per-transaction cap 1000",
    "rolling cap 150 per 60s",
    "1 asset(s)",
    "1 recipient(s)",
    "1 protocol rule(s)",
    "dead-man grace 3600s",
  ]);
  assert.equal(
    plan.summary,
    "per-tx 1000 · window 150/60s · 1 asset(s) · 1 recipient(s) · 1 protocol rule(s) · dead-man 3600s · active on install",
  );
});

test("disabled rules migrate as blank, not as zero", () => {
  const plan = planMigration(
    source({
      per_tx_cap: 0n,
      window_cap: 0n,
      window_secs: 0n,
      dms_grace_secs: 0n,
      assets: [],
      allow_any_recipient: true,
      recipients: [],
      protocols: [],
    }),
  );
  assert.equal(plan.ok, true, plan.ok ? "" : plan.message);
  if (!plan.ok) return;
  assert.equal(plan.draft.perTxCap, "");
  assert.equal(plan.draft.windowSecs, "");
  assert.deepEqual(plan.carried, ["any recipient allowed"]);
  assert.match(plan.summary, /no per-tx cap/);
  assert.match(plan.summary, /dead-man off/);
  assert.match(plan.summary, /active on install/);
});

test("a paused guard stays paused after the move", () => {
  const plan = planMigration(source({ paused: true }));
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.draft.paused, true);
  assert.ok(plan.carried.includes("installed in the paused state"));
  assert.match(plan.summary, /PAUSED on install/);
});

test("the review rows describe the policy the target will get", () => {
  const plan = planMigration(
    source({
      protocols: [
        { contract: TOKEN, fns: null },
        { contract: OTHER_TOKEN, fns: ["borrow", "repay"] },
      ],
    }),
  );
  assert.equal(plan.ok, true);
  if (!plan.ok) return;

  const rows = new Map(sourceRows(plan.source).map((row) => [row.label, row.value]));
  assert.equal(rows.get("Per-transaction cap"), "1000");
  assert.equal(rows.get("Rolling window"), "150 every 60s");
  assert.equal(rows.get("Assets"), TOKEN);
  assert.equal(rows.get("Recipients"), RECIPIENT);
  assert.equal(rows.get("Protocols"), `${TOKEN}, ${OTHER_TOKEN}:borrow,repay`);
  assert.equal(rows.get("Active window"), "always", "a zero from and until means no time limit");
  assert.equal(rows.get("Paused"), "no");
  assert.equal(rows.get("Dead-man grace"), "3600s");
});

// ── Issue #363: a preview is bound to its destination and network ───────────

const TESTNET: MigrationNetwork = {
  name: "testnet",
  passphrase: "Test SDF Network ; September 2015",
};
const TARGET_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const TARGET_B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function scope(destination: string, network: MigrationNetwork = TESTNET): MigrationScope {
  return { destination, network };
}

function previewFor(destination: string, readAt = "2026-10-21T10:00:00.000Z") {
  const plan = planMigration(source());
  assert.equal(plan.ok, true);
  return buildMigrationPreview({ plan, destination, network: TESTNET, readAt });
}

test("a preview records the destination, network and read time it was built for", () => {
  const preview = previewFor(TARGET_A);
  assert.equal(preview.destination, TARGET_A);
  assert.deepEqual(preview.network, TESTNET);
  assert.equal(preview.readAt, "2026-10-21T10:00:00.000Z");
  assert.equal(describeMigrationScope(preview), `${TARGET_A} on testnet`);
  assert.deepEqual(migrationPreviewValidity(preview, scope(TARGET_A)), { ok: true });
  assert.deepEqual(canSubmitMigrationPreview(preview, scope(TARGET_A)), { ok: true });
});

test("a mid-flow guard switch invalidates the preview and blocks submission", () => {
  const preview = previewFor(TARGET_A);
  assert.equal(canSubmitMigrationPreview(preview, scope(TARGET_A)).ok, true);

  // The active guard moves to TARGET_B after the source was read. The same
  // preview must not authorize a write against the new destination.
  const switched = canSubmitMigrationPreview(preview, scope(TARGET_B));
  assert.equal(switched.ok, false);
  if (switched.ok) return;
  assert.match(switched.reason, /destination changed/i);
  assert.match(switched.reason, /re-read/i);
  assert.equal(migrationPreviewValidity(preview, scope(TARGET_B)).ok, false);

  // Submitting requires a fresh live read + review for TARGET_B, which produces
  // a new preview. Only then is the gate open again.
  const fresh = previewFor(TARGET_B, "2026-10-21T10:01:00.000Z");
  assert.deepEqual(canSubmitMigrationPreview(fresh, scope(TARGET_B)), { ok: true });
  assert.equal(canSubmitMigrationPreview(fresh, scope(TARGET_A)).ok, false);
});

test("a network change invalidates the preview even when the address is unchanged", () => {
  const preview = previewFor(TARGET_A);

  const renamed = canSubmitMigrationPreview(preview, {
    destination: TARGET_A,
    network: { ...TESTNET, name: "futurenet" },
  });
  assert.equal(renamed.ok, false);
  if (!renamed.ok) assert.match(renamed.reason, /network changed/i);

  const rephrased = canSubmitMigrationPreview(preview, {
    destination: TARGET_A,
    network: { ...TESTNET, passphrase: "Public Global Stellar Network ; September 2015" },
  });
  assert.equal(rephrased.ok, false);
  if (!rephrased.ok) assert.match(rephrased.reason, /passphrase changed/i);
});

test("a preview of a non-portable plan can never be submitted", () => {
  const plan = planMigration(source({ per_tx_cap: "one thousand" }));
  assert.equal(plan.ok, false);
  const preview = buildMigrationPreview({
    plan,
    destination: TARGET_A,
    network: TESTNET,
  });
  const gate = canSubmitMigrationPreview(preview, scope(TARGET_A));
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.match(gate.reason, /not a directly portable policy/i);
});

test("an empty destination is reported as an invalid binding, not as a match", () => {
  const preview = buildMigrationPreview({
    plan: planMigration(source()),
    destination: "",
    network: TESTNET,
  });
  const gate = canSubmitMigrationPreview(preview, { destination: "", network: TESTNET });
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.match(gate.reason, /no destination address/i);
});

test("an empty allowlist is shown as a denial, not as a blank", () => {
  const rows = sourceRows({
    per_tx_cap: 0n,
    window_secs: 0n,
    window_cap: 0n,
    assets: [],
    protocols: [],
    recipients: [],
    allow_any_recipient: false,
    active_from: 100n,
    active_until: 200n,
    paused: true,
    dms_grace_secs: 0n,
  });
  const byLabel = new Map(rows.map((row) => [row.label, row.value]));
  assert.equal(byLabel.get("Assets"), "none — every asset is denied");
  assert.equal(byLabel.get("Recipients"), "none — every recipient is denied");
  assert.equal(byLabel.get("Protocols"), "none");
  assert.equal(byLabel.get("Active window"), "100 → 200");
  assert.equal(byLabel.get("Paused"), "yes");
  assert.equal(byLabel.get("Dead-man grace"), "off");
});

describe("field-by-field conversion tracking", () => {
  test("validateSourcePolicy returns fieldConversions for every target field", () => {
    const report = validateSourcePolicy(source());
    assert.ok(report.fieldConversions);
    assert.equal(report.fieldConversions.length, TARGET_POLICY_FIELDS.length);

    for (const conv of report.fieldConversions) {
      assert.ok(conv.targetField);
      assert.ok(conv.label);
      assert.ok(
        [
          "copied",
          "transformed",
          "defaulted",
          "unsupported",
          "unchanged",
          "type-error",
          "missing-required",
        ].includes(conv.status),
      );
      assert.equal(typeof conv.detail, "string");
      assert.equal(typeof conv.required, "boolean");
      assert.ok(
        conv.convertedValue !== undefined ||
          conv.status === "missing-required" ||
          conv.status === "type-error",
      );
    }
  });

  test("exact match fields show as copied", () => {
    const report = validateSourcePolicy(source());
    const perTxCap = report.fieldConversions.find((c) => c.targetField === "per_tx_cap");
    assert.ok(perTxCap);
    assert.equal(perTxCap.status, "copied");
    assert.equal(perTxCap.convertedValue, 1000n);
    assert.equal(perTxCap.sourceValue, 1000n);
  });

  test("camelCase fields show as transformed (string -> bigint)", () => {
    const report = validateSourcePolicy(exported());
    const perTxCap = report.fieldConversions.find((c) => c.targetField === "per_tx_cap");
    assert.ok(perTxCap);
    assert.equal(perTxCap.status, "transformed");
    assert.equal(perTxCap.sourceField, "perTxCap");
    assert.equal(perTxCap.sourceValue, "1000");
    assert.equal(perTxCap.convertedValue, 1000n);
  });

  test("missing required fields show as missing-required", () => {
    const report = validateSourcePolicy(without("per_tx_cap"));
    const perTxCap = report.fieldConversions.find((c) => c.targetField === "per_tx_cap");
    assert.ok(perTxCap);
    assert.equal(perTxCap.status, "missing-required");
    assert.equal(perTxCap.sourceField, null);
    assert.equal(perTxCap.convertedValue, null);
    assert.ok(perTxCap.required);
  });

  test("unrecognised source fields show as unsupported", () => {
    const report = validateSourcePolicy(source({ legacy_daily_limit: 9n }));
    const legacy = report.fieldConversions.find((c) => c.targetField === "legacy_daily_limit");
    assert.ok(legacy);
    assert.equal(legacy.status, "unsupported");
    assert.equal(legacy.sourceField, "legacy_daily_limit");
    assert.equal(legacy.sourceValue, 9n);
    assert.equal(legacy.convertedValue, null);
    assert.equal(legacy.required, false);
  });

  test("type errors show as type-error with detail", () => {
    const report = validateSourcePolicy(source({ per_tx_cap: "1,000" }));
    const perTxCap = report.fieldConversions.find((c) => c.targetField === "per_tx_cap");
    assert.ok(perTxCap);
    assert.equal(perTxCap.status, "type-error");
    assert.ok(perTxCap.detail.includes("expected a whole number"));
    assert.equal(perTxCap.convertedValue, null);
  });

  test("boolean fields are transformed from string to boolean", () => {
    const report = validateSourcePolicy(exported({ paused: "true" }));
    const paused = report.fieldConversions.find((c) => c.targetField === "paused");
    assert.ok(paused);
    assert.equal(paused.status, "transformed");
    assert.equal(paused.sourceValue, "true");
    assert.equal(paused.convertedValue, true);
  });

  test("array fields are transformed (filtered)", () => {
    const report = validateSourcePolicy(source({ assets: [TOKEN, 123, null] }));
    const assets = report.fieldConversions.find((c) => c.targetField === "assets");
    assert.ok(assets);
    assert.equal(assets.status, "transformed");
    // Only valid strings survive
    assert.deepEqual(assets.convertedValue, [TOKEN]);
  });

  test("protocol rules are transformed (filtered)", () => {
    const report = validateSourcePolicy(
      source({ protocols: [{ contract: TOKEN, fns: ["swap"] }, "invalid"] }),
    );
    const protocols = report.fieldConversions.find((c) => c.targetField === "protocols");
    assert.ok(protocols);
    assert.equal(protocols.status, "transformed");
    assert.ok(Array.isArray(protocols.convertedValue));
    assert.equal((protocols.convertedValue as any[]).length, 1);
    assert.equal((protocols.convertedValue as any[])[0].contract, TOKEN);
  });

  test("null/undefined source returns missing-required for all fields", () => {
    for (const bad of [null, undefined, "policy", 7, []]) {
      const report = validateSourcePolicy(bad);
      assert.equal(report.fieldConversions.length, TARGET_POLICY_FIELDS.length);
      for (const conv of report.fieldConversions) {
        assert.equal(conv.status, "missing-required");
        assert.equal(conv.sourceField, null);
        assert.equal(conv.sourceValue, undefined);
        assert.equal(conv.convertedValue, null);
      }
    }
  });

  test("planMigration includes fieldConversions in the report", () => {
    const plan = planMigration(source());
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.ok(plan.report.fieldConversions);
    assert.equal(plan.report.fieldConversions.length, TARGET_POLICY_FIELDS.length);
  });
});
