import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MIN_DMS_SECONDS,
  validateInitParameters,
  validateInitFormFields,
  type InitParameters,
} from "../../lib/guard/initValidator.ts";

const ADMIN = "GDQAPKMAI3WA6H4TDLAWUM6BCQOB22SCQIQWQMLWAHTDRWOVYCXRCVTK";
const AGENT = "GBUQNML5TT5ZNFKXVLSGDWSYS3IWLTDKNS3RR5RQDR3VBQZ7ACLULG2F";

function params(overrides: Partial<InitParameters> = {}): InitParameters {
  return {
    adminAddress: ADMIN,
    agentAddress: AGENT,
    dmsDurationSecs: "3600",
    perTxCap: "1000",
    windowCap: "5000",
    ...overrides,
  };
}

function check(validation: ReturnType<typeof validateInitParameters>, id: string) {
  const found = validation.checks.find((entry) => entry.id === id);
  assert.ok(found, `expected a check named ${id}`);
  return found;
}

test("a well-formed configuration passes every check and allows deploy", () => {
  const result = validateInitParameters(params());
  assert.equal(result.canDeploy, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.checks.length, 4);
  assert.ok(result.checks.every((entry) => entry.passed));
});

test("admin equal to agent is a fatal separation-of-duties blocker", () => {
  const result = validateInitParameters(params({ agentAddress: ADMIN }));
  const separation = check(result, "separation-of-duties");
  assert.equal(separation.passed, false);
  assert.equal(separation.fatal, true);
  assert.equal(result.canDeploy, false);
  assert.match(separation.detail, /same account/i);
});

test("a blank or invalid agent address blocks separation of duties", () => {
  const blank = validateInitParameters(params({ agentAddress: "" }));
  assert.equal(check(blank, "separation-of-duties").passed, false);

  const malformed = validateInitParameters(params({ agentAddress: "not-an-address" }));
  assert.equal(check(malformed, "separation-of-duties").passed, false);
  assert.match(check(malformed, "separation-of-duties").detail, /valid Stellar/i);
});

test("the dead-man grace must meet the 300-second minimum", () => {
  assert.equal(MIN_DMS_SECONDS, 300n);

  const zero = validateInitParameters(params({ dmsDurationSecs: "0" }));
  assert.equal(check(zero, "dms-duration").passed, false);
  assert.match(check(zero, "dms-duration").detail, /300s minimum/);

  const justBelow = validateInitParameters(params({ dmsDurationSecs: "299" }));
  assert.equal(check(justBelow, "dms-duration").passed, false);

  const exactlyMin = validateInitParameters(params({ dmsDurationSecs: "300" }));
  assert.equal(check(exactlyMin, "dms-duration").passed, true);
  assert.equal(exactlyMin.canDeploy, true);
});

test("a window cap below the per-transaction cap is a blocker", () => {
  const result = validateInitParameters(params({ perTxCap: "5000", windowCap: "1000" }));
  const window = check(result, "window-covers-per-tx");
  assert.equal(window.passed, false);
  assert.match(window.detail, /below the per-transaction cap/);
  assert.equal(result.canDeploy, false);
});

test("a window cap equal to the per-transaction cap is allowed", () => {
  const result = validateInitParameters(params({ perTxCap: "1000", windowCap: "1000" }));
  assert.equal(check(result, "window-covers-per-tx").passed, true);
  assert.equal(result.canDeploy, true);
});

test("zero or blank spend caps block deployment", () => {
  const zero = validateInitParameters(params({ perTxCap: "0" }));
  assert.equal(check(zero, "spend-caps-positive").passed, false);
  assert.match(check(zero, "spend-caps-positive").detail, /default-deny/);

  const blank = validateInitParameters(params({ windowCap: "" }));
  assert.equal(check(blank, "spend-caps-positive").passed, false);
  // A blank cap is also "missing", so the window-covers rule reports it too.
  assert.equal(check(blank, "window-covers-per-tx").passed, false);
});

test("non-numeric input is reported, not thrown", () => {
  const result = validateInitParameters(params({ dmsDurationSecs: "abc", perTxCap: "1.5" }));
  assert.equal(check(result, "dms-duration").passed, false);
  assert.equal(check(result, "spend-caps-positive").passed, false);
  assert.equal(result.canDeploy, false);
});

test("every failing rule is reported together so the operator fixes them in one pass", () => {
  const result = validateInitParameters(
    params({
      adminAddress: ADMIN,
      agentAddress: ADMIN,
      dmsDurationSecs: "10",
      perTxCap: "5000",
      windowCap: "0",
    }),
  );
  // Separation, DMS, window-covers and positive-caps all fail.
  assert.equal(result.blockers.length, 4);
  assert.equal(result.canDeploy, false);
});

test("huge caps are compared exactly with no float precision loss", () => {
  const perTx = "999999999999999999999999999999";
  const result = validateInitParameters(params({ perTxCap: perTx, windowCap: perTx }));
  assert.equal(check(result, "window-covers-per-tx").passed, true);
  assert.equal(check(result, "spend-caps-positive").passed, true);
  assert.equal(result.canDeploy, true);
});

test("initialization rejects out-of-range caps and reports input-specific errors", () => {
  const tooLarge = "170141183460469231731687303715884105728";
  const paramsWithLargeCaps = params({ perTxCap: tooLarge, windowCap: tooLarge });
  assert.equal(validateInitParameters(paramsWithLargeCaps).canDeploy, false);
  assert.match(
    validateInitFormFields({ ...paramsWithLargeCaps, agentPubkey: "not-hex" }).perTxCap ?? "",
    /no greater than/,
  );
  assert.match(
    validateInitFormFields({ ...paramsWithLargeCaps, agentPubkey: "not-hex" }).agentPubkey ?? "",
    /64 hexadecimal characters/,
  );
});
