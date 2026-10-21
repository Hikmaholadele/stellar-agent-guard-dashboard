/**
 * Soroban RPC fixtures for the wallet network-mismatch E2E scenario.
 *
 * Everything the console reads is served from here, XDR-encoded exactly as
 * Soroban RPC serves it, so the browser under test talks to a shape-identical
 * chain: a funded operator account, the pinned Phase 1 artifact's instance and
 * code entries, and a plain (unfrozen, policy-less) `status()`.
 *
 * The fixtures are intentionally built through the project's own SDK rather
 * than by hand-writing XDR, and `tests/unit/rpcFixtures.test.ts` runs them
 * through the SDK's own parsers inside `rpc.Server`, so a fixture that drifted
 * from the real response shapes fails a local test instead of the browser
 * scenario.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Address, Keypair, xdr } from "@stellar/stellar-sdk";
import { PHASE1_ARTIFACT } from "../../lib/guard/network.ts";
import { hexToBytes } from "../../lib/guard/scval.ts";
/** The fake operator account the fixtures present as connected. */
export const OPERATOR_ADDRESS = "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57";

/** The guard instance the fixtures present as selected. */
export const GUARD = PHASE1_ARTIFACT.guard;

/** One fixed ledger for every fixture response, so reads look consistent. */
export const MOCK_LEDGER = 5_500_000;

/** The wasm length the fixture's code entry carries (the pinned artifact's). */
export const WASM_BYTES = PHASE1_ARTIFACT.wasmBytes;

/**
 * The pinned artifact's real bytecode, fetched live from testnet when this file
 * was written and committed as a fixture.
 *
 * The code entry is immutable on-chain data — nothing can change those bytes at
 * that hash — so a committed copy is a faithful replica of testnet state, not a
 * simulation of it. Serving the real bytes is what lets the console's artifact
 * identity check (fetch, hash locally, compare to the pin) behave exactly as it
 * does against the real network. The unit suite re-verifies the hash on every
 * run, so a corrupted or stale fixture fails loudly.
 */
const PINNED_WASM: Uint8Array = new Uint8Array(
  readFileSync(fileURLToPath(new URL("../fixtures/pinnedGuard.wasm", import.meta.url))),
);

/** A `C…` contract address as the `ScAddress` a ledger key carries. */
function contractScAddress(contractId: string): xdr.ScAddress {
  return new Address(contractId).toScAddress();
}

/**
 * The `GuardStatus` the contract reports here: no policy, nothing frozen, the
 * heartbeat clock alive. Enough for the console to render its panels and for
 * nothing in this suite to depend on contract state.
 */
export function guardStatusScVal(): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("has_policy"), val: xdr.ScVal.scvBool(false) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("admin_frozen"), val: xdr.ScVal.scvBool(false) }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("heartbeat_expired"),
      val: xdr.ScVal.scvBool(false),
    }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("last_heartbeat"), val: xdr.ScVal.scvU64(0n) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("now"), val: xdr.ScVal.scvU64(60_000_000n) }),
  ]);
}

/** A funded account entry for the operator's address. */
export function accountEntryData(address: string = OPERATOR_ADDRESS): xdr.LedgerEntryData {
  return xdr.LedgerEntryData.account(
    new xdr.AccountEntry({
      accountId: Keypair.fromPublicKey(address).xdrAccountId(),
      balance: 100_000_000_000n,
      seqNum: 100n,
      numSubEntries: 0,
      inflationDest: null,
      flags: 0,
      homeDomain: "",
      thresholds: new xdr.Thresholds(new Uint8Array([1, 1, 1, 1])),
      signers: [],
      ext: xdr.AccountEntryExt.v0(),
    }),
  );
}

/** The contract-instance entry, carrying the pinned artifact's wasm hash. */
export function contractInstanceEntryData(): xdr.LedgerEntryData {
  return xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      contract: contractScAddress(GUARD),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.fromName("persistent"),
      val: xdr.ScVal.scvContractInstance(
        new xdr.ScContractInstance({
          executable: xdr.ContractExecutable.contractExecutableWasm(
            new xdr.Hash(hexToBytes(PHASE1_ARTIFACT.wasmHash)),
          ),
          storage: [],
        }),
      ),
      ext: xdr.ExtensionPoint.v0(),
    }),
  );
}

/** The pinned artifact's bytecode, as a `ContractCode` ledger entry. */
export function contractCodeEntryData(): xdr.LedgerEntryData {
  return xdr.LedgerEntryData.contractCode(
    new xdr.ContractCodeEntry({
      hash: new xdr.Hash(hexToBytes(PHASE1_ARTIFACT.wasmHash)),
      code: PINNED_WASM,
      ext: xdr.ExtensionPoint.v0(),
    }),
  );
}

/** The ledger key the console's account read asks for. */
export function accountLedgerKey(address: string = OPERATOR_ADDRESS): xdr.LedgerKey {
  return xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrAccountId() }),
  );
}

/** The ledger key for the guard's contract-instance entry. */
export function contractInstanceLedgerKey(): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contractScAddress(GUARD),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.fromName("persistent"),
    }),
  );
}

/** The ledger key for the pinned artifact's code entry. */
export function contractCodeLedgerKey(): xdr.LedgerKey {
  return xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: new xdr.Hash(hexToBytes(PHASE1_ARTIFACT.wasmHash)) }),
  );
}

/** An empty `SorobanTransactionData`, as a read-only simulation reports. */
export function emptySorobanData(): string {
  return new xdr.SorobanTransactionData({
    resources: new xdr.SorobanResources({
      footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
      instructions: 0,
      diskReadBytes: 0,
      writeBytes: 0,
    }),
    resourceFee: 0n,
    ext: xdr.ExtensionPoint.v0(),
  }).toXDR("base64");
}

/**
 * The invoked function name of a base64 transaction envelope, or null.
 *
 * The console's read-only probes are `invokeContractFunction` transactions, so
 * the fixture can tell `status()` from `policy()` by walking the decoded
 * envelope rather than scraping bytes.
 */
export function functionNameOf(transactionXdr: string | undefined): string | null {
  if (!transactionXdr) return null;
  try {
    const envelope = xdr.TransactionEnvelope.fromXDR(transactionXdr, "base64");
    if (envelope.type !== "envelopeTypeTx") return null;
    const [operation] = envelope.v1.tx.operations;
    if (!operation) return null;
    const body = operation.body;
    if (body.type !== "invokeHostFunction") return null;
    const hostFunction = body.invokeHostFunctionOp.hostFunction;
    if (hostFunction.type !== "hostFunctionTypeInvokeContract") return null;
    return hostFunction.invokeContract.functionName.toString();
  } catch {
    return null;
  }
}

interface JsonRpcRequest {
  method?: string;
  params?: {
    keys?: string[];
    transaction?: string;
    [key: string]: unknown;
  };
}

/** A JSON-RPC response body, as the transport hands it to the SDK. */
export interface RpcResponse {
  status: number;
  contentType: string;
  body: string;
}

function json(payload: unknown): RpcResponse {
  return { status: 200, contentType: "application/json", body: JSON.stringify(payload) };
}

function result(payload: unknown): RpcResponse {
  return json({ jsonrpc: "2.0", id: 1, result: payload });
}

function error(code: number, message: string): RpcResponse {
  return json({ jsonrpc: "2.0", id: 1, error: { code, message } });
}

/**
 * Answer one Soroban RPC POST.
 *
 * This is the single place that knows what the console asks for and what the
 * fixtures reply, so both the browser route handler and the Node-side fixture
 * test exercise the identical logic.
 */
export function handleRpcRequest(requestBody: unknown): RpcResponse {
  const request = (requestBody ?? {}) as JsonRpcRequest;

  switch (request.method) {
    case "getLedgerEntries": {
      const wanted = request.params?.keys ?? [];
      const entries = [];
      for (const key of wanted) {
        if (key === accountLedgerKey().toXDR("base64")) {
          entries.push({
            key,
            xdr: accountEntryData().toXDR("base64"),
            lastModifiedLedgerSeq: MOCK_LEDGER - 10,
          });
        } else if (key === contractInstanceLedgerKey().toXDR("base64")) {
          entries.push({
            key,
            xdr: contractInstanceEntryData().toXDR("base64"),
            lastModifiedLedgerSeq: MOCK_LEDGER - 10,
          });
        } else if (key === contractCodeLedgerKey().toXDR("base64")) {
          entries.push({
            key,
            xdr: contractCodeEntryData().toXDR("base64"),
            lastModifiedLedgerSeq: MOCK_LEDGER - 10,
          });
        }
        // Unknown keys are simply absent, exactly as the real RPC behaves.
      }
      return result({ latestLedger: MOCK_LEDGER, entries });
    }
    case "simulateTransaction": {
      // Read-only probes the console makes return the fixture `status()`, except
      // the `policy()` probe, which returns the contract's null: there is no
      // policy on this fixture guard.
      const invokedFn = functionNameOf(request.params?.transaction);
      const retval = invokedFn === "policy" ? xdr.ScVal.scvVoid() : guardStatusScVal();
      return result({
        id: "0".repeat(64),
        latestLedger: MOCK_LEDGER,
        transactionData: emptySorobanData(),
        minResourceFee: "0",
        results: [{ xdr: retval.toXDR("base64"), auth: [] }],
        events: [],
        cpuInstructions: { maxInstructions: "0", cpuInsnsConsumed: "0" },
        memoryBytes: { maxBytes: "0", memBytesConsumed: "0" },
        restored: false,
      });
    }
    case "getEvents": {
      return result({ latestLedger: MOCK_LEDGER, events: [] });
    }
    case "getHealth": {
      return result({ status: "healthy", latestLedger: MOCK_LEDGER });
    }
    case "getNetwork": {
      return result({
        friendbotUrl: "",
        passphrase: "Test SDF Network ; September 2015",
        latestLedger: MOCK_LEDGER,
      });
    }
    case "getLatestLedger": {
      return result({
        id: "0".repeat(64),
        sequence: MOCK_LEDGER,
        protocolVersion: 22,
        closeTime: Math.floor(Date.now() / 1000),
      });
    }
    default:
      return error(-32601, `fixture has no handler for ${request.method ?? "(unknown)"}`);
  }
}
