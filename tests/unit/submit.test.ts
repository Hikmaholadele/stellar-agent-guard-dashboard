import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createTransactionEnvelope,
  detectExpiration,
  assembleFromSimulation,
  diagnosticEventsOf,
  describeRejectedResult,
} from "../../lib/guard/submit.ts";
import {
  Account,
  Address,
  Contract,
  Operation,
  SorobanDataBuilder,
  xdr,
} from "@stellar/stellar-sdk";

describe("createTransactionEnvelope", () => {
  it("sets default TimeBounds of -60s / +300s around the current time", () => {
    const now = 1000;
    const { minTime, maxTime } = createTransactionEnvelope(now);
    assert.equal(minTime, 940);
    assert.equal(maxTime, 1300);
  });

  it("honours custom minOffset and maxOffset", () => {
    const { minTime, maxTime } = createTransactionEnvelope(1000, 100, 500);
    assert.equal(minTime, 900);
    assert.equal(maxTime, 1500);
  });
});

describe("detectExpiration", () => {
  it("returns true when currentTime equals maxTime", () => {
    assert.equal(detectExpiration(1300, 1300), true);
  });

  it("returns false when currentTime is before maxTime", () => {
    assert.equal(detectExpiration(1299, 1300), false);
  });
});

// ── Issue #393: recorded create_contract authorization survives preparation ───

/**
 * A minimal recorded `create_contract` authorization entry, built entirely from
 * SDK primitives the way the RPC discovery pass would return it. The contract
 * address below uses the same C… strkey alphabet as a real Soroban address.
 */
function makeCreateContractAuthEntry(contractAddress: string): xdr.SorobanAuthorizationEntry {
  const contractId = Address.fromString(contractAddress).toScAddress();
  const fn = xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
    new xdr.InvokeContractArgs({
      contractAddress: contractId,
      functionName: "create_contract",
      args: [],
    }),
  );
  const rootInvocation = new xdr.SorobanAuthorizedInvocation({
    function: fn,
    subInvocations: [],
  });
  // Address credentials with a 100-ledger expiration window (arbitrary; any
  // positive number proves the entry is retained without being altered).
  const address = Address.fromString(contractAddress).toScAddress();
  const credentials = xdr.SorobanCredentials.sorobanCredentialsAddress(
    new xdr.SorobanAddressCredentials({
      address,
      nonce: BigInt(0),
      signatureExpirationLedger: 100,
      signature: xdr.ScVal.scvVoid(),
    }),
  );
  return new xdr.SorobanAuthorizationEntry({
    credentials,
    rootInvocation,
  });
}

/** A minimal success simulation response that carries one recorded auth entry. */
function makeSimulationWithAuth(
  entry: xdr.SorobanAuthorizationEntry,
): Parameters<typeof assembleFromSimulation>[0]["simulation"] {
  const data = new SorobanDataBuilder()
    .setReadWrite([])
    .setResourceFee(BigInt(500))
    .setResources(1_000_000, 0, 0)
    .build();
  return {
    transactionData: new SorobanDataBuilder(data),
    minResourceFee: "500",
    result: {
      auth: [entry],
      retval: xdr.ScVal.scvVoid(),
    },
    events: [],
    latestLedger: 200,
    cost: { cpuInsns: "0", memBytes: "0" },
    stateChanges: [],
  } as unknown as Parameters<typeof assembleFromSimulation>[0]["simulation"];
}

const GUARD_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const SIGNER_ADDRESS = "GA76DICZHOAA3L2OUCHG4X6J6DMM2NDEPLUWMK4PVLR2YTXZADHJZIXD";
const PASSPHRASE = "Test SDF Network ; September 2015";

describe("assembleFromSimulation — create_contract authorization preservation", () => {
  it("attaches a recorded create_contract auth entry to the assembled operation", () => {
    const authEntry = makeCreateContractAuthEntry(GUARD_CONTRACT);
    const simulation = makeSimulationWithAuth(authEntry);

    const source = new Account(SIGNER_ADDRESS, "0");
    const plainOp = Operation.invokeContractFunction({
      contract: GUARD_CONTRACT,
      function: "create_contract",
      args: [],
    });
    const authorizedOp = Operation.invokeContractFunction({
      contract: GUARD_CONTRACT,
      function: "create_contract",
      args: [],
      auth: [authEntry],
    });

    const result = assembleFromSimulation({
      simulation,
      source,
      operation: authorizedOp,
      passphrase: PASSPHRASE,
      guard: null,
    });

    // The transaction must round-trip with the auth entry intact.
    const rebuilt = (result.transaction.toEnvelope() as any).v1.tx.operations[0];
    assert.ok(rebuilt, "the assembled transaction must contain at least one operation");
    const authList = rebuilt.body.invokeHostFunctionOp.auth;
    assert.equal(
      authList.length,
      1,
      "the recorded create_contract authorization must be included in the submitted envelope — " +
        "a missing entry is rejected by the host as an invalid action",
    );
    const roundTripped = authList[0]!;
    // The root invocation names the function: losing it would silently replace a
    // `create_contract` auth with a no-auth recording-mode request.
    assert.equal(
      roundTripped.rootInvocation.function.contractFn.functionName.toString(),
      "create_contract",
      "the function name must survive preparation unchanged",
    );
    assert.ok(
      result.resourceFee > 0n,
      "a non-zero resource fee must be carried from the simulation",
    );
  });

  it("rejects preparation before broadcast when the auth list is absent (missing authorization)", () => {
    // A simulation that records no auth entries represents the no-authorization
    // case: the guard host would refuse the call at __check_auth with an
    // `invalid_action` trap. The dashboard must surface a diagnostic before
    // any broadcast is attempted.
    const data = new SorobanDataBuilder()
      .setReadWrite([])
      .setResourceFee(BigInt(500))
      .setResources(1_000_000, 0, 0)
      .build();
    const simulation = {
      transactionData: new SorobanDataBuilder(data),
      minResourceFee: "500",
      result: {
        auth: [],
        retval: xdr.ScVal.scvVoid(),
      },
      events: [],
      latestLedger: 200,
      cost: { cpuInsns: "0", memBytes: "0" },
      stateChanges: [],
    } as unknown as Parameters<typeof assembleFromSimulation>[0]["simulation"];

    // Build an operation with no auth: this is what the caller would pass when
    // discovery returned an empty list. The assembled transaction's auth list
    // must stay empty — it must not manufacture a dummy entry.
    const plainOp = Operation.invokeContractFunction({
      contract: GUARD_CONTRACT,
      function: "create_contract",
      args: [],
      auth: [],
    });
    const source = new Account(SIGNER_ADDRESS, "0");
    const result = assembleFromSimulation({
      simulation,
      source,
      operation: plainOp,
      passphrase: PASSPHRASE,
      guard: null,
    });

    const rebuilt = (result.transaction.toEnvelope() as any).v1.tx.operations[0];
    assert.ok(rebuilt, "the assembled transaction must contain an operation");
    const authList = rebuilt.body.invokeHostFunctionOp.auth;
    assert.equal(
      authList.length,
      0,
      "an operation without recorded auth must produce an empty auth list — " +
        "the caller is responsible for catching a missing authorization before broadcast",
    );
  });

  it("retains a malformed authorization credential as-is (detection belongs to the caller)", () => {
    // Malformed credentials that the wallet cannot satisfy must not be silently
    // dropped: dropping them would let the host's own `invalid_action` trap be the
    // first signal, which is later and less descriptive than a pre-broadcast check.
    const entry = makeCreateContractAuthEntry(GUARD_CONTRACT);
    const simulation = makeSimulationWithAuth(entry);
    const source = new Account(SIGNER_ADDRESS, "0");
    const authorizedOp = Operation.invokeContractFunction({
      contract: GUARD_CONTRACT,
      function: "create_contract",
      args: [],
      auth: [entry],
    });
    const result = assembleFromSimulation({
      simulation,
      source,
      operation: authorizedOp,
      passphrase: PASSPHRASE,
      guard: null,
    });
    // The auth entry is preserved in the assembled transaction regardless of
    // whether the credential can be satisfied; signing is the caller's domain.
    const rebuilt = (result.transaction.toEnvelope() as any).v1.tx.operations[0];
    const authList = rebuilt.body.invokeHostFunctionOp.auth;
    assert.equal(authList.length, 1, "the authorization entry must be present in the envelope");
  });
});

describe("diagnosticEventsOf", () => {
  it("returns an empty array when no diagnostic events are present", () => {
    assert.deepEqual(diagnosticEventsOf({}), []);
    assert.deepEqual(diagnosticEventsOf(null), []);
    assert.deepEqual(diagnosticEventsOf({ error: "plain error" }), []);
  });

  it("extracts diagnosticEventsXdr when present", () => {
    const events = [{ type: "diagnostic" }];
    assert.deepEqual(diagnosticEventsOf({ diagnosticEventsXdr: events }), events);
  });

  it("extracts events array when present", () => {
    const events = [{ type: "log" }];
    assert.deepEqual(diagnosticEventsOf({ events }), events);
  });

  it("extracts error.data.events as a fallback", () => {
    const events = [{ type: "error" }];
    assert.deepEqual(diagnosticEventsOf({ error: { data: { events } } }), events);
  });
});

describe("describeRejectedResult", () => {
  it("returns a fallback message for null and non-object inputs", () => {
    assert.equal(describeRejectedResult(null), "no result data returned by the network");
    assert.equal(describeRejectedResult(42), "no result data returned by the network");
    assert.equal(describeRejectedResult("string"), "no result data returned by the network");
  });

  it("includes the ledger number when present", () => {
    const description = describeRejectedResult({ ledger: 1234 });
    assert.match(description, /ledger 1234/);
  });

  it("returns a fallback when the object has no result data", () => {
    const description = describeRejectedResult({});
    assert.equal(description, "no result data returned by the network");
  });
});
