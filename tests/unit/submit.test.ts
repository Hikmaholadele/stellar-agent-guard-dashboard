import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createTransactionEnvelope,
  detectExpiration,
  evaluateSignedEnvelopePreflight,
  preflightSignedEnvelope,
  assembleFromSimulation,
  diagnosticEventsOf,
  describeRejectedResult,
  invokeWithWallet,
  type WalletSigner,
} from "../../lib/guard/submit.ts";
import { WalletUserRejectedError } from "../../lib/guard/walletConnector.ts";
import {
  loadTxHistory,
  clearTxHistory,
  TX_HISTORY_STORAGE_KEY,
} from "../../lib/guard/txHistory.ts";
import {
  Account,
  Address,
  Contract,
  Keypair,
  Operation,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
  rpc,
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

describe("signed envelope preflight", () => {
  it("recognizes a current sequence and active time bounds", () => {
    const result = evaluateSignedEnvelopePreflight({
      sequence: "6",
      accountSequence: "5",
      timeBounds: { minTime: "900", maxTime: "1100" },
      ledgerCloseTime: "1000",
      checkedAt: "2026-10-21T12:00:00.000Z",
    });
    assert.equal(result.sequence.status, "current");
    assert.equal(result.expiration.status, "active");
    assert.equal(result.checkedAt, "2026-10-21T12:00:00.000Z");
  });

  it("identifies stale sequences, expired envelopes, and envelopes not yet valid", () => {
    const stale = evaluateSignedEnvelopePreflight({
      sequence: "5",
      accountSequence: "5",
      timeBounds: { minTime: "900", maxTime: "1100" },
      ledgerCloseTime: "1000",
    });
    assert.equal(stale.sequence.status, "stale");

    const expired = evaluateSignedEnvelopePreflight({
      sequence: "6",
      accountSequence: "5",
      timeBounds: { minTime: "900", maxTime: "1000" },
      ledgerCloseTime: "1000",
    });
    assert.equal(expired.expiration.status, "expired");

    const notYetValid = evaluateSignedEnvelopePreflight({
      sequence: "6",
      accountSequence: "5",
      timeBounds: { minTime: "1001", maxTime: "1100" },
      ledgerCloseTime: "1000",
    });
    assert.equal(notYetValid.expiration.status, "not_yet_valid");
  });

  it("marks unavailable account or ledger reads as unknown", () => {
    const result = evaluateSignedEnvelopePreflight({
      sequence: "6",
      timeBounds: { minTime: "900", maxTime: "1100" },
    });
    assert.equal(result.sequence.status, "unknown");
    assert.equal(result.expiration.status, "unknown");
  });

  it("uses fresh chain reads and leaves the imported envelope unchanged", async () => {
    const transaction = new TransactionBuilder(new Account(SIGNER_ADDRESS, "5"), {
      fee: "100",
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(Operation.accountMerge({ destination: SIGNER_ADDRESS }))
      .setTimebounds(900, 1100)
      .build();
    const importedXdr = transaction.toXDR();
    const server = {
      getAccount: async (source: string) => {
        assert.equal(source, SIGNER_ADDRESS);
        return new Account(SIGNER_ADDRESS, "5");
      },
      getLatestLedger: async () => ({ closeTime: "1000" }),
    } as unknown as rpc.Server;

    const result = await preflightSignedEnvelope(server, transaction);
    assert.equal(result.sequence.status, "current");
    assert.equal(result.expiration.status, "active");
    assert.equal(transaction.toXDR(), importedXdr);
  });

  it("keeps each failed RPC observation unknown instead of guessing", async () => {
    const transaction = new TransactionBuilder(new Account(SIGNER_ADDRESS, "5"), {
      fee: "100",
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(Operation.accountMerge({ destination: SIGNER_ADDRESS }))
      .setTimeout(30)
      .build();
    const server = {
      getAccount: async () => {
        throw new Error("account read failed");
      },
      getLatestLedger: async () => ({ closeTime: "1000" }),
    } as unknown as rpc.Server;

    const result = await preflightSignedEnvelope(server, transaction);
    assert.equal(result.sequence.status, "unknown");
    assert.equal(result.expiration.status, "active");

    const failedLedgerServer = {
      getAccount: async () => new Account(SIGNER_ADDRESS, "5"),
      getLatestLedger: async () => {
        throw new Error("ledger read failed");
      },
    } as unknown as rpc.Server;
    const ledgerFailure = await preflightSignedEnvelope(failedLedgerServer, transaction);
    assert.equal(ledgerFailure.sequence.status, "current");
    assert.equal(ledgerFailure.expiration.status, "unknown");
  });
});

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

/**
 * Wallet-bound write boundaries (#340) and disconnect recovery (#341).
 *
 * These run the real `invokeWithWallet` pipeline against a fake RPC, so the
 * assertions are about what the write path actually does: a wallet account that
 * moved mid-flight stops the write before the envelope is signed, a vanished
 * provider becomes a phase-specific recoverable result, and nothing is ever
 * broadcast or resubmitted automatically.
 */
function makeWalletBoundaryServer(sendCalls: string[]): rpc.Server {
  const successfulSimulation = () => {
    const data = new SorobanDataBuilder()
      .setReadWrite([])
      .setResourceFee(BigInt(500))
      .setResources(1_000_000, 0, 0)
      .build();
    return {
      transactionData: new SorobanDataBuilder(data),
      minResourceFee: "500",
      result: { auth: [], retval: xdr.ScVal.scvVoid() },
      events: [],
      latestLedger: 200,
      cost: { cpuInsns: "0", memBytes: "0" },
      stateChanges: [],
    };
  };
  return {
    getAccount: async (address: string) => new Account(address, "1"),
    simulateTransaction: async () => successfulSimulation(),
    sendTransaction: async () => {
      sendCalls.push("sent");
      return { status: "PENDING", hash: "ab".repeat(32), latestLedger: 200 };
    },
    getTransaction: async () => ({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      ledger: 201,
      hash: "ab".repeat(32),
    }),
  } as unknown as rpc.Server;
}

function makeKeypairSigner(options: {
  liveAddress: () => string | null;
  keypair?: ReturnType<typeof Keypair.random>;
  onSignTransaction?: () => void;
}): WalletSigner {
  const keypair = options.keypair ?? Keypair.random();
  return {
    address: keypair.publicKey(),
    currentAddress: async () => options.liveAddress(),
    async signTransaction(transactionXdr: string): Promise<string> {
      options.onSignTransaction?.();
      const transaction = TransactionBuilder.fromXDR(transactionXdr, PASSPHRASE) as Transaction;
      transaction.sign(keypair);
      return transaction.toXDR();
    },
    async signAuthEntry(): Promise<string> {
      throw new Error("this call needs no authorization entries");
    },
  };
}

const WRITE_REQUEST = {
  contract: GUARD_CONTRACT,
  fn: "freeze",
  args: [] as xdr.ScVal[],
  passphrase: PASSPHRASE,
  pollAttempts: 1,
  pollIntervalMs: 1,
};

describe("wallet-bound write boundaries", () => {
  it("refuses to sign the envelope after the wallet account changed", async () => {
    const keypair = Keypair.random();
    const sendCalls: string[] = [];
    let signed = 0;
    const result = await invokeWithWallet({
      ...WRITE_REQUEST,
      server: makeWalletBoundaryServer(sendCalls),
      signer: makeKeypairSigner({
        keypair,
        liveAddress: () => "GD5S5O2MZ6FSMFH6QILG37KSQNRVR3RPSWBTTV4JOUJ7J6TWLLL5LAVS",
        onSignTransaction: () => {
          signed += 1;
        },
      }),
    });

    assert.equal(result.kind, "refused");
    if (result.kind !== "refused") return;
    assert.equal(result.stage, "wallet");
    assert.equal(result.writeInterruption?.kind, "account-changed");
    assert.equal(result.writeInterruption?.phase, "envelope");
    assert.equal(signed, 0, "the envelope must never be signed for a different account");
    assert.deepEqual(sendCalls, [], "nothing may be broadcast");
    assert.match(result.detail, /fresh review/i);
  });

  it("reports a disconnect during signing as recoverable and phase-specific", async () => {
    const sendCalls: string[] = [];
    const result = await invokeWithWallet({
      ...WRITE_REQUEST,
      server: makeWalletBoundaryServer(sendCalls),
      signer: makeKeypairSigner({ liveAddress: () => null }),
    });

    assert.equal(result.kind, "refused");
    if (result.kind !== "refused") return;
    assert.equal(result.stage, "wallet");
    assert.equal(result.writeInterruption?.kind, "wallet-disconnected");
    assert.equal(result.writeInterruption?.phase, "envelope");
    assert.match(result.detail, /signature may have been produced/i);
    assert.deepEqual(sendCalls, []);
  });

  it("stops before broadcast when the provider disappears at submission", async () => {
    const keypair = Keypair.random();
    const sendCalls: string[] = [];
    let reads = 0;
    const result = await invokeWithWallet({
      ...WRITE_REQUEST,
      server: makeWalletBoundaryServer(sendCalls),
      signer: makeKeypairSigner({
        keypair,
        liveAddress: () => {
          reads += 1;
          return reads === 1 ? keypair.publicKey() : null;
        },
      }),
    });

    assert.equal(result.kind, "refused");
    if (result.kind !== "refused") return;
    assert.equal(result.writeInterruption?.phase, "submission");
    if (result.writeInterruption?.kind !== "wallet-disconnected") {
      assert.fail("expected a wallet disconnect at submission");
    }
    assert.match(result.detail, /may be on chain/i);
    assert.deepEqual(sendCalls, [], "no retry is attempted after a disconnect");
  });

  it("submits unchanged when the wallet stays on the reviewed account", async () => {
    const keypair = Keypair.random();
    const sendCalls: string[] = [];
    const result = await invokeWithWallet({
      ...WRITE_REQUEST,
      server: makeWalletBoundaryServer(sendCalls),
      signer: makeKeypairSigner({ keypair, liveAddress: () => keypair.publicKey() }),
    });

    assert.equal(result.kind, "submitted");
    assert.deepEqual(sendCalls, ["sent"]);
  });
});
