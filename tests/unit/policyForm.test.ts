import assert from "node:assert/strict";
import { test } from "node:test";
import { scValToNative } from "@stellar/stellar-sdk";
import type { PolicyConfig } from "stellar-agent-guard-sdk";
import {
  EMPTY_DRAFT,
  buildPolicyConfig,
  describeDraft,
  draftFromConfig,
  type PolicyDraft,
} from "../../lib/guard/policyForm.ts";

const TOKEN = "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB";
const RECIPIENT = "GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH";

function draft(overrides: Partial<PolicyDraft> = {}): PolicyDraft {
  return {
    ...EMPTY_DRAFT,
    perTxCap: "1000",
    windowCap: "150",
    windowSecs: "60",
    assets: TOKEN,
    recipients: RECIPIENT,
    ...overrides,
  };
}

test("a valid draft encodes to the struct the contract decodes", () => {
  const built = buildPolicyConfig(draft());
  assert.equal(built.ok, true);
  if (!built.ok) return;

  // Round-tripping through the SDK's own decoder is the real check: `decodePolicy`
  // is the strict inverse of the encoder and rejects anything a `#[contracttype]`
  // struct would not decode, so if it reads back the policy we described, the
  // encoding is the one the contract expects.
  const decoded = scValToNative(built.scval) as unknown as PolicyConfig;
  assert.equal(decoded.per_tx_cap, 1000n);
  assert.equal(decoded.window_cap, 150n);
  assert.equal(decoded.window_secs, 60n);
  assert.deepEqual(decoded.assets, [TOKEN]);
  assert.deepEqual(decoded.recipients, [RECIPIENT]);
  assert.equal(decoded.allow_any_recipient, false);
  assert.equal(decoded.paused, false);
  assert.deepEqual(decoded.protocols, []);
});

test("caps larger than Number can represent survive encoding exactly", () => {
  // An i128 cap above 2^53 is precisely the value a spend guard exists to
  // compare, so narrowing it to a JS number here would be a real defect.
  const huge = "170141183460469231731687303715884105727"; // i128::MAX
  const built = buildPolicyConfig(draft({ perTxCap: huge }));
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const decoded = scValToNative(built.scval) as unknown as PolicyConfig;
  assert.equal(decoded.per_tx_cap, 170141183460469231731687303715884105727n);
});

test("blank cap fields mean disabled, not zero-valued", () => {
  const built = buildPolicyConfig(draft({ perTxCap: "", windowCap: "", windowSecs: "" }));
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.config.per_tx_cap, 0n);
  assert.equal(built.config.window_cap, 0n);
  assert.equal(built.config.window_secs, 0n);
});

test("a non-numeric cap is refused with the field named", () => {
  const built = buildPolicyConfig(draft({ perTxCap: "1,000" }));
  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.ok(built.issues.some((issue) => issue.field === "perTxCap"));
});

test("caps and time bounds stay inside their XDR integer ranges", () => {
  const cap = buildPolicyConfig(draft({ perTxCap: "170141183460469231731687303715884105728" }));
  assert.equal(cap.ok, false);
  if (cap.ok) return;
  assert.ok(
    cap.issues.some(
      (issue) => issue.field === "perTxCap" && /maximum supported/.test(issue.message),
    ),
  );

  const time = buildPolicyConfig(draft({ activeUntil: "18446744073709551616" }));
  assert.equal(time.ok, false);
  if (time.ok) return;
  assert.ok(
    time.issues.some(
      (issue) => issue.field === "activeUntil" && /maximum supported/.test(issue.message),
    ),
  );
});

test("a malformed address is refused rather than passed through", () => {
  const built = buildPolicyConfig(draft({ recipients: "not-an-address" }));
  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.ok(built.issues.some((issue) => issue.field === "recipients"));
});

test("a rolling cap with no window length is caught before signing", () => {
  const built = buildPolicyConfig(draft({ windowCap: "150", windowSecs: "" }));
  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.ok(built.issues.some((issue) => issue.field === "windowSecs"));
});

test("an active window that ends before it starts is caught", () => {
  const built = buildPolicyConfig(draft({ activeFrom: "2000", activeUntil: "1000" }));
  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.ok(built.issues.some((issue) => issue.field === "activeUntil"));
});

test("an allowlist with no recipients is flagged as a lockout, not accepted quietly", () => {
  // With the allowlist on and nothing on it, every transfer is refused. That is
  // a foot-gun worth naming rather than a valid configuration to install.
  const built = buildPolicyConfig(draft({ recipients: "", allowAnyRecipient: false }));
  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.ok(built.issues.some((issue) => issue.field === "recipients"));
});

test("allowing any recipient removes the lockout warning", () => {
  const built = buildPolicyConfig(draft({ recipients: "", allowAnyRecipient: true }));
  assert.equal(built.ok, true);
});

test("protocols parse both the any-function and per-function forms", () => {
  const built = buildPolicyConfig(draft({ protocols: `${TOKEN}\n${RECIPIENT}:swap,deposit` }));
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.deepEqual(built.config.protocols, [
    { contract: TOKEN, fns: null },
    { contract: RECIPIENT, fns: ["swap", "deposit"] },
  ]);
});

test("a round trip through the form preserves the policy", () => {
  const built = buildPolicyConfig(draft({ protocols: `${TOKEN}:swap`, dmsGraceSecs: "3600" }));
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const again = buildPolicyConfig(draftFromConfig(built.config));
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.deepEqual(again.config, built.config);
});

test("zero renders as blank and rounds back to zero", () => {
  const built = buildPolicyConfig(draft({ perTxCap: "1000", dmsGraceSecs: "" }));
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const draftAgain = draftFromConfig(built.config);
  assert.equal(draftAgain.perTxCap, "1000");
  assert.equal(draftAgain.dmsGraceSecs, "");
});

test("the summary names the caps, allowlist and dead-man state", () => {
  const summary = describeDraft(draft({ dmsGraceSecs: "3600" }));
  assert.match(summary, /per-transaction cap 1000/);
  assert.match(summary, /rolling cap 150 per 60s/);
  assert.match(summary, /1 allowlisted recipient/);
  assert.match(summary, /dead-man grace 3600s/);
});

test("the summary says plainly when a policy is not valid yet", () => {
  assert.equal(describeDraft({ ...EMPTY_DRAFT, perTxCap: "abc" }), "Policy is not valid yet");
});
