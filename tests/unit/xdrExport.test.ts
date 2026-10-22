import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { assembleFromSimulation, inspectSignedEnvelope } from "../../lib/guard/submit.ts";

test("assembleFromSimulation correctly builds transaction without prompting for signature", async () => {
  const sourceAccountId = "GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH";
  const source = new Account(sourceAccountId, "12345");
  const contractId = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";
  const operation = Operation.invokeContractFunction({
    contract: contractId,
    function: "set_policy",
    args: [],
  });

  const { SorobanDataBuilder } = await import("@stellar/stellar-sdk");
  const simulationResult: any = {
    transactionData: new SorobanDataBuilder().build(),
    minResourceFee: "100",
  };

  const passphrase = "Test SDF Network ; September 2015";
  const assembled = assembleFromSimulation({
    simulation: simulationResult,
    source,
    operation,
    passphrase,
    guard: null,
  });

  assert.ok(assembled.transaction, "Assembly should return a transaction object");
  // Total fee = 100 (base INCLUSION_FEE) + 115 (minResourceFee 100 padded +15% Standard headroom)
  assert.equal(
    assembled.transaction.fee,
    "215",
    "Total fee should be 100 base + 115 padded resource fee (Standard +15%)",
  );

  const xdr = assembled.transaction.toXDR();
  assert.ok(typeof xdr === "string", "Exported XDR should be a string");
  assert.ok(xdr.length > 0, "Exported XDR should not be empty");

  // Verify the base64 XDR can be properly deserialized into the expected transaction
  const deserializedTx = TransactionBuilder.fromXDR(
    xdr,
    passphrase,
  ) as import("@stellar/stellar-sdk").Transaction;
  assert.equal(deserializedTx.source, sourceAccountId, "Source account should match");
  assert.equal(deserializedTx.sequence, "12346", "Sequence number should be incremented");
  assert.equal(deserializedTx.operations.length, 1, "Should contain exactly one operation");

  const op = deserializedTx.operations[0] as any;
  assert.equal(op.type, "invokeHostFunction", "Operation should be an invokeHostFunction");
});

describe("inspectSignedEnvelope — pre-broadcast review and safety checks (#326)", () => {
  const contractId = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";
  const passphrase = Networks.TESTNET;

  test("valid envelope: decodes network binding, source, operation, and allows submission", () => {
    const kp = Keypair.random();
    const acc = new Account(kp.publicKey(), "1000");
    const tx = new TransactionBuilder(acc, { fee: "150", networkPassphrase: passphrase })
      .addOperation(
        Operation.invokeContractFunction({
          contract: contractId,
          function: "set_policy",
          args: [xdr.ScVal.scvU32(50)],
        }),
      )
      .setTimeout(300)
      .build();
    tx.sign(kp);

    const result = inspectSignedEnvelope(tx.toXDR(), passphrase);
    assert.equal(result.valid, true);
    assert.equal(result.canSubmit, true);
    assert.equal(result.networkMatch, true);
    assert.equal(result.sourceAccount, kp.publicKey());
    assert.equal(result.sequenceNumber, "1001");
    assert.equal(result.feeStroops, "150");
    assert.equal(result.hasSignatures, true);
    assert.equal(result.signaturesCount, 1);
    assert.equal(result.operations.length, 1);
    assert.equal(result.operations[0]?.supported, true);
    assert.equal(result.operations[0]?.functionName, "set_policy");
    assert.equal(result.operations[0]?.contract, contractId);
    assert.ok(result.verifiedFields.length >= 4);
    assert.equal(result.unsupportedFields.length, 0);
    assert.equal(result.blockReasons.length, 0);
  });

  test("wrong-network envelope: stops submission and identifies network mismatch", () => {
    const kp = Keypair.random();
    const acc = new Account(kp.publicKey(), "2000");
    // Signed for Public network
    const tx = new TransactionBuilder(acc, { fee: "100", networkPassphrase: Networks.PUBLIC })
      .addOperation(
        Operation.invokeContractFunction({
          contract: contractId,
          function: "freeze",
          args: [],
        }),
      )
      .setTimeout(300)
      .build();
    tx.sign(kp);

    // Tested against Testnet
    const result = inspectSignedEnvelope(tx.toXDR(), Networks.TESTNET);
    assert.equal(result.valid, true);
    assert.equal(result.canSubmit, false);
    assert.equal(result.networkMatch, false);
    assert.equal(result.detectedNetwork, Networks.PUBLIC);
    assert.ok(result.blockReasons.some((r) => r.includes("Network mismatch")));
  });

  test("expired envelope: detects expiration and blocks broadcast", () => {
    const kp = Keypair.random();
    const acc = new Account(kp.publicKey(), "3000");
    const currentTime = 10_000;
    const tx = new TransactionBuilder(acc, { fee: "100", networkPassphrase: passphrase })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: "10",
        }),
      )
      .setTimeout(100) // expires in 100 seconds from now
      .build();
    tx.sign(kp);

    // Simulate inspection occurring well after maxTime
    const farFuture = Math.floor(Date.now() / 1000) + 10_000;
    const result = inspectSignedEnvelope(tx.toXDR(), passphrase, farFuture);
    assert.equal(result.valid, true);
    assert.equal(result.canSubmit, false);
    assert.equal(result.timeBounds?.expired, true);
    assert.ok(result.blockReasons.some((r) => r.includes("expired")));
  });

  test("malformed envelope: detects invalid XDR and blocks broadcast", () => {
    const result = inspectSignedEnvelope("not-valid-xdr-content!@#$", passphrase);
    assert.equal(result.valid, false);
    assert.equal(result.canSubmit, false);
    assert.ok(result.blockReasons.some((r) => r.includes("Malformed envelope")));
  });

  test("unsupported-operation envelope: distinguishes unsupported fields and blocks broadcast", () => {
    const kp = Keypair.random();
    const acc = new Account(kp.publicKey(), "4000");
    const tx = new TransactionBuilder(acc, { fee: "100", networkPassphrase: passphrase })
      .addOperation(Operation.inflation())
      .setTimeout(300)
      .build();
    tx.sign(kp);

    const result = inspectSignedEnvelope(tx.toXDR(), passphrase);
    assert.equal(result.valid, true);
    assert.equal(result.canSubmit, false);
    assert.equal(result.operations.length, 1);
    assert.equal(result.operations[0]?.supported, false);
    assert.ok(result.unsupportedFields.length > 0);
    assert.ok(result.blockReasons.some((r) => r.includes("unsupported operation")));
  });
});
