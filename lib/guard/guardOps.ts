/**
 * The guard operations an operator actually performs, in the operator's terms.
 *
 * Every write goes through `invokeWithWallet` or `submitOperation`, so every
 * write is signed by the operator's own wallet and every write is preceded by an
 * enforced simulation that can refuse it. Nothing here can broadcast without a
 * signature.
 */

import { Account, Address, Operation, TransactionBuilder, rpc, xdr } from "@stellar/stellar-sdk";
import { sha256Hex } from "./scval.ts";
import type { GuardStatus, PolicyConfig } from "stellar-agent-guard-sdk";
import { NETWORK, PHASE1_ARTIFACT } from "./network.ts";
import { buildPolicyConfig, type PolicyDraft } from "./policyForm.ts";
import {
  fetchContractWasm,
  predictContractId,
  readPolicy,
  readStatus,
  readWindow,
  stringifyError,
  verifyWasmIdentity,
  type ReadResult,
  type WasmIdentity,
  type WindowState,
} from "./chain.ts";
import {
  INCLUSION_FEE,
  assembleFromSimulation,
  buildInitialEnvelope,
  describeRejectedResult,
  diagnosticEventsOf,
  invokeWithWallet,
  type InvokeResult,
  type WalletSigner,
} from "./submit.ts";
import { addressToScVal, hexToBytes } from "./scval.ts";
import { announce } from "./useAnnounce.ts";
import { recordTx } from "./txHistory.ts";

// ── Artifact identity ──────────────────────────────────────────────────────

export interface ArtifactCheck {
  /** The hash this build is willing to deploy. */
  pinnedHash: string;
  pinnedBytes: number;
  /** What Phase 1's instance actually runs, read live from the chain. */
  live: WasmIdentity;
  /** True only when the live bytes hash to the pinned hash. */
  ok: boolean;
  detail: string;
}

/**
 * Re-derive the Phase 1 artifact's identity from the chain, right now.
 *
 * This is the gate on deployment: if the bytes Phase 1's instance runs do not
 * hash to the pin this build carries, the dashboard refuses to deploy anything.
 * A "real deploy" that quietly shipped different bytecode than the one that was
 * proven would be worse than no deploy at all.
 */
export async function checkArtifact(server: rpc.Server): Promise<ArtifactCheck> {
  const live = await verifyWasmIdentity(server, PHASE1_ARTIFACT.guard);
  const hashMatch = live.fetchedSha256 === PHASE1_ARTIFACT.wasmHash;
  const sizeMatch = live.bytes === PHASE1_ARTIFACT.wasmBytes;
  const ok = hashMatch && sizeMatch && live.match;
  return {
    pinnedHash: PHASE1_ARTIFACT.wasmHash,
    pinnedBytes: PHASE1_ARTIFACT.wasmBytes,
    live,
    ok,
    detail: ok
      ? `Phase 1's instance runs ${live.fetchedSha256.slice(0, 16)}… (${live.bytes} bytes), matching the pinned artifact`
      : [
          "the artifact on chain does not match the pinned artifact — refusing to deploy",
          `  ledger reports ${live.reportedWasmHash ?? "(none)"}`,
          `  fetched bytes hash to ${live.fetchedSha256} (${live.bytes} bytes)`,
          `  this build pins  ${PHASE1_ARTIFACT.wasmHash} (${PHASE1_ARTIFACT.wasmBytes} bytes)`,
        ].join("\n"),
  };
}

/**
 * Is the pinned bytecode already a live `ContractCode` entry?
 *
 * Soroban keys stored code by its hash, so an instance can be created by
 * referencing a hash that is already uploaded — normally making a deploy a single
 * transaction. But that entry has a TTL, so assuming it is still live would turn
 * an expired entry into a confusing host error in the middle of signing.
 */
export async function artifactCodePresent(
  server: rpc.Server,
  wasmHash: string,
): Promise<ReadResult<boolean>> {
  try {
    const key = xdr.LedgerKey.contractCode(
      new xdr.LedgerKeyContractCode({ hash: hexToBytes(wasmHash) }),
    );
    const response = await server.getLedgerEntries(key);
    return { ok: true, value: response.entries.length > 0 };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ── Submitting a non-contract-call operation ───────────────────────────────

/**
 * Submit a single prepared operation through the wallet.
 *
 * `invokeWithWallet` is shaped for contract calls, because that is what the
 * dashboard mostly does. Creating a contract and uploading bytecode are host
 * functions with no call phase and no authorizations to walk, so they take this
 * narrower path — still the same simulate → sign → submit discipline.
 */
export async function submitOperation(params: {
  server: rpc.Server;
  signer: WalletSigner;
  operation: xdr.Operation;
  /** Name recorded in the transaction history for this operation. */
  label?: string;
  passphrase?: string;
}): Promise<InvokeResult> {
  const passphrase = params.passphrase ?? NETWORK.passphrase;
  const { server, signer } = params;
  const label = params.label ?? "host_function_operation";

  let account: Account;
  try {
    account = await server.getAccount(signer.address);
  } catch (error) {
    announce("Transaction refused — nothing was broadcast");
    return {
      kind: "refused",
      stage: "discovery",
      detail: `could not load account ${signer.address}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      diagnosticEvents: [],
    };
  }

  // Host-function operations must declare real Soroban resources *and* carry the
  // authorizations the host recorded, so this uses the RPC's own prepare step —
  // the same path the contracts repo's deploy tooling uses. Preparing is not
  // optional dressing: a `create_contract` submitted without its recorded
  // authorization entry is included and then rejected by the host as
  // `Error(Auth, InvalidAction)`, which reads like a permissions surprise and is
  // really just a missing entry.
  //
  // This narrow path is only for operations the source account itself authorizes
  // (deploy, upload). Contract calls the operator makes as *admin* go through
  // `invokeWithWallet`, which walks and wallet-signs address credentials properly.
  const built = new TransactionBuilder(new Account(signer.address, account.sequenceNumber()), {
    fee: "1000000",
    networkPassphrase: passphrase,
  })
    .addOperation(params.operation)
    .setTimeout(60)
    .build();

  announce("Transaction simulation started");

  let prepared;
  try {
    prepared = await server.prepareTransaction(built);
  } catch (error) {
    announce("Transaction refused — nothing was broadcast");
    return {
      kind: "refused",
      stage: "enforcement",
      detail: error instanceof Error ? error.message : String(error),
      diagnosticEvents: [],
    };
  }

  announce("Please approve transaction in Freighter");
  const signedXdr = await signer.signTransaction(prepared.toXDR());
  const transaction = TransactionBuilder.fromXDR(signedXdr, passphrase);

  // The envelope's fee field carries inclusion fee + resource fee — exactly
  // what the network will charge for this transaction.
  const feeStroops = transaction.fee;

  const sent = await server.sendTransaction(transaction);
  if (sent.status === "ERROR") {
    announce("Transaction refused — nothing was broadcast");
    return {
      kind: "refused",
      stage: "submission",
      detail: JSON.stringify(sent.errorResult ?? sent),
      diagnosticEvents: [],
    };
  }

  announce("Transaction submitted to network");

  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const result = await server.getTransaction(sent.hash).catch(() => null);
    if (!result) continue;
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      const ledger = (result as { ledger?: number }).ledger ?? null;
      recordTx({
        hash: sent.hash,
        operation: label,
        status: "confirmed",
        feeStroops,
        networkName: NETWORK.name,
        networkPassphrase: passphrase,
      });
      announce(
        ledger !== null
          ? `Transaction confirmed on ledger ${ledger}`
          : "Transaction confirmed on the network",
      );
      return {
        kind: "submitted",
        hash: sent.hash,
        status: result.status,
        ledger,
        feeStroops,
        events: (result as { events?: unknown }).events ?? null,
      };
    }
    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      recordTx({
        hash: sent.hash,
        operation: label,
        status: "failed",
        feeStroops,
        networkName: NETWORK.name,
        networkPassphrase: passphrase,
      });
      announce("Transaction failed on chain");
      return {
        kind: "failed",
        hash: sent.hash,
        detail: `transaction ${sent.hash} was included and rejected (${describeRejectedResult(
          result,
        )})`,
        feeStroops,
        diagnosticEvents: (result as { diagnosticEventsXdr?: unknown[] }).diagnosticEventsXdr ?? [],
      };
    }
  }
  recordTx({
    hash: sent.hash,
    operation: label,
    status: "failed",
    feeStroops,
    networkName: NETWORK.name,
    networkPassphrase: passphrase,
  });
  announce("Transaction failed on chain");
  return {
    kind: "failed",
    hash: sent.hash,
    detail: `timed out waiting for ${sent.hash}`,
    feeStroops,
    diagnosticEvents: [],
  };
}

// ── Deploy ─────────────────────────────────────────────────────────────────

export interface DeployPlan {
  /** The address the guard will have, computed before anything is signed. */
  predicted: string;
  deployerPublicKey: string;
  salt: Uint8Array;
  artifactOk: boolean;
  artifactDetail: string;
  codePresent: boolean;
}

/** Work out what a deploy would do, without signing anything. */
export async function planDeploy(
  server: rpc.Server,
  deployerPublicKey: string,
  salt: Uint8Array,
): Promise<DeployPlan> {
  const artifact = await checkArtifact(server);
  const present = await artifactCodePresent(server, PHASE1_ARTIFACT.wasmHash);
  return {
    predicted: await predictContractId({ deployerPublicKey, salt }),
    deployerPublicKey,
    salt,
    artifactOk: artifact.ok,
    artifactDetail: artifact.detail,
    codePresent: present.ok ? present.value : false,
  };
}

export interface DeployStep {
  label: string;
  result: InvokeResult;
}

export interface DeployOutcome {
  guard: string;
  steps: DeployStep[];
  /** The deployed instance's identity, re-read from the chain after the create. */
  identity: WasmIdentity | null;
  /**
   * Why the post-deploy read produced no identity, or null when it was never
   * reached, or when it succeeded. Kept separate from `identity` so a transport
   * failure is reported as an unavailable read rather than as a wrong artifact —
   * and so the deployment receipt can record a failed read explicitly.
   */
  readError: string | null;
  /** True only when the created instance runs the pinned artifact. */
  verified: boolean;
}

export class GuardOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardOperationError";
  }
}

/**
 * Deploy a new guard instance of the pinned Phase 1 artifact.
 *
 * Order matters and is enforced: verify the artifact off the chain, make sure its
 * code entry is live (uploading the exact bytes if it is not), create the contract
 * at a predicted address, then read the new instance back and check it runs the
 * pinned hash. The last step is what turns "the wallet approved a deploy" into
 * "an instance of the proven artifact now exists at this address".
 */
export async function deployGuard(params: {
  server: rpc.Server;
  signer: WalletSigner;
  salt: Uint8Array;
  onStep?: (step: DeployStep) => void;
  passphrase?: string;
}): Promise<DeployOutcome> {
  const { server, signer, salt } = params;
  const steps: DeployStep[] = [];
  const record = (label: string, result: InvokeResult): void => {
    const step = { label, result };
    steps.push(step);
    params.onStep?.(step);
  };

  const artifact = await checkArtifact(server);
  if (!artifact.ok) throw new GuardOperationError(artifact.detail);

  const predicted = await predictContractId({
    deployerPublicKey: signer.address,
    salt,
    ...(params.passphrase !== undefined ? { passphrase: params.passphrase } : {}),
  });

  // ── Ensure the exact bytecode is a live code entry ─────────────────────
  const present = await artifactCodePresent(server, PHASE1_ARTIFACT.wasmHash);
  if (!present.ok) throw new GuardOperationError(`could not read the code entry: ${present.error}`);
  if (!present.value) {
    const wasm = await fetchContractWasm(server, PHASE1_ARTIFACT.guard);
    const fetchedHash = await sha256Hex(wasm);
    if (fetchedHash !== PHASE1_ARTIFACT.wasmHash) {
      throw new GuardOperationError(
        `refusing to upload: fetched bytes hash to ${fetchedHash}, not the pinned ${PHASE1_ARTIFACT.wasmHash}`,
      );
    }
    const upload = await submitOperation({
      server,
      signer,
      operation: Operation.uploadContractWasm({ wasm }),
      label: "upload_contract_wasm",
      ...(params.passphrase !== undefined ? { passphrase: params.passphrase } : {}),
    });
    record(`upload_contract_wasm (${PHASE1_ARTIFACT.wasmBytes} bytes)`, upload);
    if (upload.kind !== "submitted") {
      return { guard: predicted, steps, identity: null, readError: null, verified: false };
    }
  }

  const create = await submitOperation({
    server,
    signer,
    operation: Operation.createCustomContract({
      address: Address.fromString(signer.address),
      wasmHash: hexToBytes(PHASE1_ARTIFACT.wasmHash),
      salt,
      constructorArgs: [],
    }),
    label: "create_custom_contract",
    ...(params.passphrase !== undefined ? { passphrase: params.passphrase } : {}),
  });
  record(
    `create_custom_contract (wasm ${PHASE1_ARTIFACT.wasmHash.slice(0, 12)}…) → ${predicted}`,
    create,
  );
  if (create.kind !== "submitted") {
    return { guard: predicted, steps, identity: null, readError: null, verified: false };
  }

  // A read failure after a submitted create is not the same fact as a wrong
  // artifact. Catch it so the operator keeps the transaction references and the
  // receipt can say "unavailable" instead of losing the whole outcome when the
  // RPC hiccups at the last step.
  let identity: WasmIdentity | null = null;
  let readError: string | null = null;
  try {
    identity = await verifyWasmIdentity(server, predicted);
  } catch (error) {
    readError = error instanceof Error ? error.message : String(error);
  }
  return {
    guard: predicted,
    steps,
    identity,
    readError,
    verified:
      identity !== null &&
      identity.fetchedSha256 === PHASE1_ARTIFACT.wasmHash &&
      identity.bytes === PHASE1_ARTIFACT.wasmBytes,
  };
}

// ── Initialize, policy, freeze ─────────────────────────────────────────────

/** Register the admin (the connected wallet) and the agent's raw Ed25519 key. */
export async function initializeGuard(params: {
  server: rpc.Server;
  signer: WalletSigner;
  guard: string;
  agentPubkeyHex: string;
  passphrase?: string;
}): Promise<InvokeResult> {
  const pubkey = hexToBytes(params.agentPubkeyHex.trim());
  if (pubkey.length !== 32) {
    return {
      kind: "refused",
      stage: "discovery",
      detail: `the agent public key must be 32 raw Ed25519 bytes, got ${pubkey.length}`,
      diagnosticEvents: [],
    };
  }
  return invokeWithWallet({
    server: params.server,
    contract: params.guard,
    fn: "initialize",
    args: [addressToScVal(params.signer.address), xdr.ScVal.scvBytes(pubkey)],
    signer: params.signer,
    ...(params.passphrase !== undefined ? { passphrase: params.passphrase } : {}),
  });
}

/** Install a policy, validating the draft in the form first. */
export async function installPolicy(params: {
  server: rpc.Server;
  signer: WalletSigner;
  guard: string;
  draft: PolicyDraft;
  passphrase?: string;
  exportOnly?: boolean;
}): Promise<{ kind: "invalid"; issues: string[] } | { kind: "invoked"; result: InvokeResult }> {
  const built = buildPolicyConfig(params.draft);
  if (!built.ok)
    return { kind: "invalid", issues: built.issues.map((i) => `${i.field}: ${i.message}`) };
  const result = await invokeWithWallet({
    server: params.server,
    contract: params.guard,
    fn: "set_policy",
    args: [built.scval],
    signer: params.signer,
    ...(params.passphrase !== undefined ? { passphrase: params.passphrase } : {}),
    ...(params.exportOnly !== undefined ? { exportOnly: params.exportOnly } : {}),
  });
  return { kind: "invoked", result };
}

/** The panic button: freeze the account. Admin-authorized, reversible by `unfreeze`. */
export function freezeGuard(params: {
  server: rpc.Server;
  signer: WalletSigner;
  guard: string;
  passphrase?: string;
  exportOnly?: boolean;
}): Promise<InvokeResult> {
  return invokeWithWallet({
    server: params.server,
    contract: params.guard,
    fn: "freeze",
    args: [],
    signer: params.signer,
    ...(params.passphrase !== undefined ? { passphrase: params.passphrase } : {}),
    ...(params.exportOnly !== undefined ? { exportOnly: params.exportOnly } : {}),
  });
}

// ── Freeze dry run ─────────────────────────────────────────────────────────

/** One authorization the host recorded for a simulated call. */
export interface SimulatedAuthorization {
  /**
   * `source_account` rides on the transaction envelope's signature; `address`
   * needs its own `signAuthEntry` signature. `unsupported` is a credential kind
   * this dashboard cannot satisfy.
   */
  kind: "source_account" | "address" | "unsupported";
  /** The `G…`/`C…` that must authorize, when the host names one. */
  address: string | null;
}

export interface FreezeSimulation {
  kind: "simulated";
  /** Always true: this came from a read-only simulation, never a broadcast. */
  dryRun: true;
  fn: "freeze";
  /** Authorizations the host requires before the call could be submitted. */
  authorizations: SimulatedAuthorization[];
  /** How many of those need a separate auth-entry signature. */
  separateSignaturesRequired: number;
  /** Resource fee (CPU, ledger I/O, events) the call would cost, in stroops. */
  resourceFeeStroops: string;
  /** Inclusion fee floor applied to the envelope, in stroops. */
  inclusionFeeStroops: string;
  /** Total fee the network would charge, in stroops. */
  totalFeeStroops: string;
  /** Ledger keys in the simulated footprint. */
  footprintEntries: number;
  /** Ledger the simulation ran against, when the RPC reports one. */
  latestLedger: number | null;
}

export interface FreezeSimulationRefused {
  kind: "refused";
  dryRun: true;
  detail: string;
  diagnosticEvents: unknown[];
}

export type FreezeSimulationResult = FreezeSimulation | FreezeSimulationRefused;

/** The `G…`/`C…` inside an address credential, or `null` when unreadable. */
function addressOfCredential(credentials: xdr.SorobanAddressCredentials): string | null {
  try {
    return Address.fromScAddress(credentials.address).toString();
  } catch {
    return null;
  }
}

/** Classify one recorded authorization into the operator's terms. */
export function describeAuthorization(
  entry: xdr.SorobanAuthorizationEntry,
): SimulatedAuthorization {
  const credentials = entry.credentials;
  if (credentials.type === "sorobanCredentialsSourceAccount") {
    return { kind: "source_account", address: null };
  }
  if (credentials.type === "sorobanCredentialsAddress") {
    return { kind: "address", address: addressOfCredential(credentials.address) };
  }
  if (credentials.type === "sorobanCredentialsAddressV2") {
    return { kind: "address", address: addressOfCredential(credentials.addressV2) };
  }
  return { kind: "unsupported", address: null };
}

/**
 * Dry-run the emergency freeze: simulate `freeze()` and report what it would
 * take, without signing or broadcasting anything.
 *
 * This runs exactly one recording-mode `simulateTransaction` and then assembles
 * the priced envelope to read its fees. Recording mode does not enforce auth, so
 * the call is *not* executed — but it does report which authorizations the host
 * wants, what the footprint touches, and what the resources cost, which is what
 * an operator wants to check before committing to a real freeze.
 *
 * The crucial property is what this function does *not* call: no
 * `signAuthEntry`, no `signTransaction`, no `sendTransaction`. A dry run that
 * prompted a wallet would be worse than no dry run at all, so that guarantee is
 * structural here and pinned by `tests/unit/panicSimulation.test.ts`.
 */
export async function simulateFreeze(params: {
  server: rpc.Server;
  signer: WalletSigner;
  guard: string;
  passphrase?: string;
}): Promise<FreezeSimulationResult> {
  const passphrase = params.passphrase ?? NETWORK.passphrase;
  const { server, signer } = params;

  let account: Account;
  try {
    account = await server.getAccount(signer.address);
  } catch (error) {
    return {
      kind: "refused",
      dryRun: true,
      detail: `could not load account ${signer.address} from the network (is the wallet on the right network, and is the account funded?): ${stringifyError(error)}`,
      diagnosticEvents: [],
    };
  }

  const operation = Operation.invokeContractFunction({
    contract: params.guard,
    function: "freeze",
    args: [],
  });
  // The admin is a plain account, not the guard's own `__check_auth` caller, so
  // no guard storage keys are merged into the footprint — RPC preflight prices
  // exactly what `freeze()` touches.
  const envelope = buildInitialEnvelope({
    source: new Account(signer.address, account.sequenceNumber()),
    operation,
    passphrase,
    guard: null,
  });

  let simulation: rpc.Api.SimulateTransactionResponse;
  try {
    simulation = await server.simulateTransaction(envelope);
  } catch (error) {
    return {
      kind: "refused",
      dryRun: true,
      detail: `the dry-run simulation could not be completed: ${stringifyError(error)}`,
      diagnosticEvents: [],
    };
  }

  if (rpc.Api.isSimulationError(simulation)) {
    return {
      kind: "refused",
      dryRun: true,
      detail: stringifyError(simulation.error),
      diagnosticEvents: diagnosticEventsOf(simulation),
    };
  }

  const success = simulation as rpc.Api.SimulateTransactionSuccessResponse;
  const authorizations = (success.result?.auth ?? []).map(describeAuthorization);
  const assembled = assembleFromSimulation({
    simulation: success,
    source: new Account(signer.address, account.sequenceNumber()),
    operation,
    passphrase,
    guard: null,
  });

  return {
    kind: "simulated",
    dryRun: true,
    fn: "freeze",
    authorizations,
    separateSignaturesRequired: authorizations.filter((entry) => entry.kind === "address").length,
    resourceFeeStroops: assembled.resourceFee.toString(),
    inclusionFeeStroops: INCLUSION_FEE,
    totalFeeStroops: assembled.transaction.fee,
    footprintEntries: assembled.footprintKeys,
    latestLedger: success.latestLedger ?? null,
  };
}

/**
 * Reverse a freeze.
 *
 * `unfreeze` clears the admin freeze *and* restarts the heartbeat clock, so it is
 * the reversal path for a dead-man-switch freeze as well — which is why the
 * dashboard offers it beside the panic button rather than behind a separate flow.
 * The agent's own `heartbeat()` is the other way back, and it needs the agent's
 * key inside the smart account, so it belongs to the SDK's runtime, not here.
 */
export function unfreezeGuard(params: {
  server: rpc.Server;
  signer: WalletSigner;
  guard: string;
  passphrase?: string;
  exportOnly?: boolean;
}): Promise<InvokeResult> {
  return invokeWithWallet({
    server: params.server,
    contract: params.guard,
    fn: "unfreeze",
    args: [],
    signer: params.signer,
    ...(params.passphrase !== undefined ? { passphrase: params.passphrase } : {}),
    ...(params.exportOnly !== undefined ? { exportOnly: params.exportOnly } : {}),
  });
}

/** `revoke_policy()` — the account goes back to default-deny. */
export function revokePolicy(params: {
  server: rpc.Server;
  signer: WalletSigner;
  guard: string;
  passphrase?: string;
  exportOnly?: boolean;
}): Promise<InvokeResult> {
  return invokeWithWallet({
    server: params.server,
    contract: params.guard,
    fn: "revoke_policy",
    args: [],
    signer: params.signer,
    ...(params.passphrase !== undefined ? { passphrase: params.passphrase } : {}),
    ...(params.exportOnly !== undefined ? { exportOnly: params.exportOnly } : {}),
  });
}

/** Rotate the registered agent Ed25519 keypair. Admin-authorized. */
export async function rotateAgentKey(params: {
  server: rpc.Server;
  signer: WalletSigner;
  guard: string;
  newAgentPubkeyHex: string;
  passphrase?: string;
}): Promise<InvokeResult> {
  const pubkey = hexToBytes(params.newAgentPubkeyHex.trim());
  if (pubkey.length !== 32) {
    return {
      kind: "refused",
      stage: "discovery",
      detail: `the new agent public key must be 32 raw Ed25519 bytes, got ${pubkey.length}`,
      diagnosticEvents: [],
    };
  }
  return invokeWithWallet({
    server: params.server,
    contract: params.guard,
    fn: "rotate_agent_key",
    args: [xdr.ScVal.scvBytes(pubkey)],
    signer: params.signer,
    ...(params.passphrase !== undefined ? { passphrase: params.passphrase } : {}),
  });
}

// ── State ──────────────────────────────────────────────────────────────────

/**
 * Everything the UI shows about one guard, with each read carrying its own
 * success or failure.
 *
 * There is deliberately no "default to zero on failure" path: a dashboard that
 * renders `0` when the RPC is unreachable is showing mock state that looks
 * exactly like real state, which is the one thing this interface must not do.
 */
export interface GuardSnapshot {
  guard: string;
  fetchedAt: string;
  status: ReadResult<GuardStatus>;
  policy: ReadResult<PolicyConfig | null>;
  window: ReadResult<WindowState | null>;
  identity: ReadResult<WasmIdentity>;
}

/**
 * Stamp a successful read with when it completed.
 *
 * The printed report must be able to say which sections were live reads and when
 * each one returned; one batch timestamp would silently imply that a section
 * which failed and was retried was as fresh as the others. Failures carry no
 * timestamp because nothing was read.
 */
async function stamped<T>(read: Promise<ReadResult<T>>): Promise<ReadResult<T>> {
  const result = await read;
  return result.ok ? { ...result, readAt: new Date().toISOString() } : result;
}

export async function readGuardSnapshot(
  server: rpc.Server,
  guard: string,
  source?: string,
): Promise<GuardSnapshot> {
  const [status, policy, window, identity] = await Promise.all([
    stamped(readStatus(server, guard, source)),
    stamped(readPolicy(server, guard, source)),
    stamped(readWindow(server, guard)),
    stamped(
      verifyWasmIdentity(server, guard)
        .then((value): ReadResult<WasmIdentity> => ({ ok: true, value }))
        .catch((error): ReadResult<WasmIdentity> => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })),
    ),
  ]);
  return { guard, fetchedAt: new Date().toISOString(), status, policy, window, identity };
}
