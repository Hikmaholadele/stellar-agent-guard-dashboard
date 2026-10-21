import { withBackoff, RetryableError } from "./retry.ts";
/**
 * The write path: a contract call authorized by the operator's own wallet.
 *
 * This is the one piece of the pipeline the SDK deliberately does not cover. The
 * SDK's `invoke()` answers "can this *agent key* make this call, and is the guard
 * happy with it", and it takes `Keypair`s because in an agent runtime the key is
 * in the process. The dashboard must never hold a key — the admin signs in the
 * operator's browser — so this module implements the same
 * simulate → sign → enforce → submit sequence with a wallet standing in for the
 * keypair, and it hands the guard's own decision vocabulary back untouched.
 *
 * Nothing here is broadcast until the enforced simulation passes, so a refused
 * call costs nothing and leaves no trace on the ledger.
 */

import {
  Account,
  Address,
  Operation,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { NETWORK } from "./network.ts";
import { POLLING } from "./polling.ts";
import { guardStorageLedgerKeys, ledgerKeyId } from "./scval.ts";
import { stringifyError } from "./chain.ts";
import { announce } from "./useAnnounce.ts";
import { recordTx } from "./txHistory.ts";
import { hardwareGuide } from "./hardwareGuide.ts";

/** Inclusion fee floor, in stroops, for a single-operation transaction. */
// `FeePreset` is imported as a type on purpose: `scripts/prove-phase3.ts` runs
// this module under Node's native type stripping, which rejects a value import
// of something that only exists in the type space.
import { calculateFeeHeadroom, type FeePreset } from "./feeEstimator.ts";

export const INCLUSION_FEE = "100";

/**
 * The seam that keeps this module free of any wallet dependency: the browser
 * supplies a Freighter-backed implementation, tests supply a keypair-backed one.
 */
export interface WalletSigner {
  /** The G… address the wallet will sign as. */
  address: string;
  /** Sign a transaction envelope, returning the signed XDR. */
  signTransaction(transactionXdr: string): Promise<string>;
  /** Sign a Soroban authorization entry, returning the signed entry's XDR. */
  signAuthEntry(entryXdr: string): Promise<string>;
}

export type InvokeResult =
  | {
      kind: "submitted";
      hash: string;
      status: string;
      ledger: number | null;
      /** Total fee paid, in stroops (inclusion fee + resource fee). */
      feeStroops?: string;
      /**
       * The transaction's events as the RPC reports them. Kept opaque on purpose:
       * settled guard events are read through the telemetry feed, which decodes
       * them with the SDK's vocabulary, rather than re-parsed here.
       */
      events: unknown;
    }
  | {
      /**
       * The enforced simulation refused the call. Nothing was broadcast, so there
       * is no transaction hash — that is the whole point of enforcing pre-flight.
       */
      kind: "refused";
      stage: "discovery" | "enforcement" | "submission";
      detail: string;
      diagnosticEvents: unknown[];
    }
  | {
      /** Broadcast and rejected by the network after inclusion. */
      kind: "failed";
      hash: string;
      detail: string;
      /** Total fee paid, in stroops (inclusion fee + resource fee). */
      feeStroops?: string;
      diagnosticEvents: unknown[];
    }
  | {
      /** An unsigned transaction XDR was successfully exported for external tools. */
      kind: "exported";
      xdr: string;
      detail?: string;
    };

export interface InvokeRequest {
  server: rpc.Server;
  contract: string;
  fn: string;
  args: xdr.ScVal[];
  signer: WalletSigner;
  passphrase?: string;
  exportOnly?: boolean;
  /**
   * A smart account whose own storage must be merged into the footprint. Only
   * needed when the call is authorized *by* the guard (its `__check_auth` reads
   * policy/window/freeze state); an admin call passes `null`, because there the
   * authorizer is a plain account and the contract declares its own writes.
   */
  guardForFootprint?: string | null;
  pollAttempts?: number;
  pollIntervalMs?: number;
  feePreset?: FeePreset;
  maxFeeCap?: bigint;
  minTimeOffset?: number;
  maxTimeOffset?: number;
}

/**
 * Build the initial (footprint-declaring) envelope for a probe or enforce pass.
 *
 * The guard's own storage keys are set as the initial read-write footprint; RPC
 * preflight then prices the call and, for the enforce pass, runs the real
 * `__check_auth` against live ledger state.
 */
export function buildInitialEnvelope(params: {
  source: Account;
  operation: xdr.Operation;
  passphrase: string;
  guard: string | null;
}): Transaction {
  return new TransactionBuilder(params.source, {
    fee: INCLUSION_FEE,
    networkPassphrase: params.passphrase,
    ...(params.guard
      ? {
          sorobanData: new SorobanDataBuilder()
            .setReadWrite(guardStorageLedgerKeys(params.guard))
            .build(),
        }
      : {}),
  })
    .addOperation(params.operation)
    .setTimebounds(
      createTransactionEnvelope(Math.floor(Date.now() / 1000)).minTime,
      createTransactionEnvelope(Math.floor(Date.now() / 1000)).maxTime,
    )
    .build();
}

export interface AssembleResult {
  transaction: Transaction;
  resourceFee: bigint;
  footprintKeys: number;
}

/**
 * Fold a successful simulation's resources into a submittable transaction.
 *
 * RPC preflight prices what the *called* contract touches. A custom account's
 * `__check_auth` additionally reads and writes the account's own policy, window
 * and freeze state, so those keys must be in the declared footprint and the
 * declared resource fee must cover them, or core rejects the transaction with
 * `insufficient_refundable_fee`. Keys are merged, never dropped.
 */
export function assembleFromSimulation(params: {
  simulation: rpc.Api.SimulateTransactionSuccessResponse;
  source: Account;
  operation: xdr.Operation;
  passphrase: string;
  guard: string | null;
  feePreset?: FeePreset;
  maxFeeCap?: bigint;
  minTimeOffset?: number;
  maxTimeOffset?: number;
}): AssembleResult {
  const { simulation, source, operation, passphrase, guard } = params;
  const data =
    simulation.transactionData instanceof SorobanDataBuilder
      ? simulation.transactionData
      : new SorobanDataBuilder(simulation.transactionData);
  let footprintKeys = 0;

  if (guard) {
    const merged = [...data.getReadWrite()];
    // De-duplicate against BOTH lists: a key in read_only and read_write at once
    // is an invalid footprint, and preflight commonly places the guard's storage
    // keys in read_only, so merging blindly would duplicate every one of them.
    const seen = new Set([
      ...data.getReadOnly().map((key) => ledgerKeyId(key)),
      ...merged.map((key) => ledgerKeyId(key)),
    ]);
    for (const key of guardStorageLedgerKeys(guard)) {
      const id = ledgerKeyId(key);
      if (!seen.has(id)) {
        seen.add(id);
        merged.push(key);
      }
    }
    data.setReadWrite(merged);
    footprintKeys = merged.length;
  }

  const minResourceFee = BigInt(simulation.minResourceFee);
  const builtData = data.build();
  const cpuInstrs = builtData.resources.instructions;
  const diskReadBytes = builtData.resources.diskReadBytes;
  const writeBytes = builtData.resources.writeBytes;
  // Apply fee headroom (15% CPU buffer + configurable fee preset)
  const { cpu: paddedCpu, fee: paddedFee } = calculateFeeHeadroom(
    cpuInstrs,
    minResourceFee,
    params.feePreset ?? "Standard",
    params.maxFeeCap,
  );
  data.setResources(paddedCpu, diskReadBytes, writeBytes);
  data.setResourceFee(paddedFee);

  const transaction = new TransactionBuilder(source, {
    fee: INCLUSION_FEE,
    networkPassphrase: passphrase,
    sorobanData: data.build(),
  })
    .addOperation(operation)
    .setTimebounds(
      createTransactionEnvelope(
        Math.floor(Date.now() / 1000),
        params.minTimeOffset,
        params.maxTimeOffset,
      ).minTime,
      createTransactionEnvelope(
        Math.floor(Date.now() / 1000),
        params.minTimeOffset,
        params.maxTimeOffset,
      ).maxTime,
    )
    .build();

  return { transaction, resourceFee: minResourceFee, footprintKeys };
}

/**
 * Name why a transaction that *was* included failed.
 *
 * "it failed" is not a diagnosis: a rejected transaction's `resultXdr` names the
 * arm that rejected it, and the contract's own typed errors surface through it.
 * A guard trap is a real, informative outcome and must not be flattened into a
 * generic failure.
 */
export function describeRejectedResult(result: unknown): string {
  if (result === null || typeof result !== "object") {
    return "no result data returned by the network";
  }
  const candidate = result as {
    resultXdr?: unknown;
    ledger?: number;
    diagnosticEventsXdr?: unknown[];
  };
  const parts: string[] = [];
  if (candidate.ledger !== undefined) parts.push(`ledger ${candidate.ledger}`);

  const outcome = transactionOutcome(candidate.resultXdr);
  if (outcome !== null) parts.push(`result ${outcome}`);

  // The most useful line, when it is there: the host's own reason. A bare
  // `trapped` says nothing, while the diagnostic beside it names the exact
  // authorization the host rejected — which is the difference between a bug
  // report and a diagnosis.
  const hostReason = hostErrorFromDiagnostics(candidate.diagnosticEventsXdr ?? []);
  if (hostReason !== null) parts.push(hostReason);

  return parts.length > 0 ? parts.join(", ") : "no result data returned by the network";
}

/**
 * The rejected arm of a transaction result, as text.
 *
 * Two shapes are handled because this SDK build hands `resultXdr` back already
 * decoded as a plain object rather than as the base64 the API documents, and
 * assuming the wrong one silently degrades the description to nothing.
 */
function transactionOutcome(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      const decoded = xdr.TransactionResult.fromXDR(value, "base64");
      const outcome = (decoded as unknown as { result?: unknown }).result;
      return outcome ? boundedJson(outcome) : null;
    } catch {
      return "result present but undecodable";
    }
  }
  if (typeof value === "object") {
    const outcome = (value as { result?: unknown }).result;
    if (outcome !== undefined) return boundedJson(outcome);
  }
  return null;
}

/**
 * The host's own `error` diagnostic, rendered as a sentence.
 *
 * A host error arrives as a structure like `{"error":{"auth":"invalid_action"}}`
 * next to a human-readable string. The string says what happened; the structure
 * says which part of the host rejected it, and both are worth surfacing — the
 * pair is the difference between "Unauthorized function call" and knowing it was
 * the auth layer.
 */
function hostErrorFromDiagnostics(events: readonly unknown[]): string | null {
  for (const event of events) {
    const text = safeJson(event);
    if (!text.includes('"error"')) continue;

    const messages = [...text.matchAll(/"string":"([^"]{3,200})"/g)]
      .map((match) => match[1])
      .filter((m): m is string => m !== undefined);
    const kinds: string[] = [];
    for (const block of text.matchAll(/"error":\{([^}]{1,200})\}/g)) {
      for (const pair of (block[1] ?? "").matchAll(/"([a-z_]+)":"([a-z_]+)"/g)) {
        if (pair[1] && pair[2]) {
          kinds.push(`${pair[1]}/${pair[2]}`);
        }
      }
    }

    const detail = [...new Set(kinds)];
    if (messages.length > 0) {
      return `host: ${messages.join(" / ")}${detail.length > 0 ? ` (${detail.join(", ")})` : ""}`;
    }
    if (detail.length > 0) return `host error: ${detail.join(", ")}`;
  }
  return null;
}

function boundedJson(value: unknown, limit = 240): string {
  const text = safeJson(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return String(value);
  }
}

/**
 * Diagnostic events attached to a failed simulation, in whatever shape carries
 * them. The RPC puts them either beside the error or inside it, and the host's
 * own `fn_call`/`error`/`log` entries are what make a trap diagnosable.
 */
export function diagnosticEventsOf(response: unknown): unknown[] {
  if (!response || typeof response !== "object") return [];
  const candidate = response as {
    diagnosticEventsXdr?: unknown;
    events?: unknown;
    error?: { data?: { events?: unknown } };
  };
  for (const value of [
    candidate.diagnosticEventsXdr,
    candidate.events,
    candidate.error?.data?.events,
  ]) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

/**
 * Walk the ledger until a submitted transaction is included, or give up.
 *
 * A `NOT_FOUND` immediately after `sendTransaction` is normal — the transaction
 * is in flight — so this polls rather than treating the first miss as failure.
 */
async function pollForInclusion(
  server: rpc.Server,
  hash: string,
  attempts: number,
  intervalMs: number,
): Promise<
  | { ok: true; status: string; ledger: number | null; events: unknown }
  | { ok: false; detail: string; diagnosticEvents: unknown[] }
> {
  try {
    return await withBackoff(
      async () => {
        const result = (await server.getTransaction(hash).catch(() => null)) as
          (rpc.Api.GetTransactionResponse & { diagnosticEventsXdr?: unknown[] }) | null;
        if (!result || result.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
          throw new RetryableError("NOT_FOUND");
        }
        if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
          return {
            ok: true,
            status: result.status,
            ledger: (result as { ledger?: number }).ledger ?? null,
            events: (result as { events?: unknown }).events ?? null,
          };
        }
        if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
          const diagnostics = result.diagnosticEventsXdr ?? [];
          return {
            ok: false,
            detail: `transaction ${hash} was included and rejected by the network`,
            diagnosticEvents: diagnostics,
          };
        }
        throw new RetryableError("TRY_AGAIN_LATER");
      },
      { baseDelayMs: intervalMs, maxRetries: attempts },
    );
  } catch (e) {
    return {
      ok: false,
      detail: `transaction timed out after ${attempts} attempts`,
      diagnosticEvents: [],
    };
  }
}

/**
 * Run a wallet-authorized contract call, submitting only on a passing enforced
 * simulation.
 */
async function runInvocation(request: InvokeRequest): Promise<InvokeResult> {
  const passphrase = request.passphrase ?? NETWORK.passphrase;
  const { server, signer } = request;

  let account: Account;
  try {
    account = await server.getAccount(signer.address);
  } catch (error) {
    return {
      kind: "refused",
      stage: "discovery",
      detail:
        `could not load account ${signer.address} from the network ` +
        `(is the wallet on the right network, and is the account funded?): ${stringifyError(error)}`,
      diagnosticEvents: [],
    };
  }

  // One sequence number, shared by every pass: building the second transaction on
  // a re-read sequence would advance it by two and the network would reject the
  // submission with `tx_bad_seq`.
  const sequence = account.sequenceNumber();
  const freshAccount = () => new Account(signer.address, sequence);

  // "Please approve…" is one milestone per submission, not one per signature:
  // Freighter can prompt twice (auth entry, then envelope), and a screen
  // reader hearing the same instruction twice would be exactly the spam the
  // announcer exists to prevent.
  let walletPrompted = false;
  const promptWallet = (): void => {
    if (walletPrompted) return;
    walletPrompted = true;
    announce("Please approve transaction in Freighter");
  };

  const plainOperation = Operation.invokeContractFunction({
    contract: request.contract,
    function: request.fn,
    args: request.args,
  });

  // ── Step 1: discover the authorizations this call requires ──────────────
  const probe = buildInitialEnvelope({
    source: freshAccount(),
    operation: plainOperation,
    passphrase,
    guard: request.guardForFootprint ?? null,
  });
  announce("Transaction simulation started");
  const discovery = await server.simulateTransaction(probe);
  if (rpc.Api.isSimulationError(discovery)) {
    // Recording mode: this pass records what the call *needs*, so a failure here
    // is a plain error (a trap, a missing trustline) and not a guard decision.
    return {
      kind: "refused",
      stage: "discovery",
      detail: stringifyError((discovery as rpc.Api.SimulateTransactionErrorResponse).error),
      diagnosticEvents: diagnosticEventsOf(discovery),
    };
  }
  const requiredAuth: xdr.SorobanAuthorizationEntry[] =
    (discovery as rpc.Api.SimulateTransactionSuccessResponse).result?.auth ?? [];

  // ── Step 2: sign each authorization the host asked for ──────────────────
  const signed: xdr.SorobanAuthorizationEntry[] = [];
  for (const entry of requiredAuth) {
    const credentials = entry.credentials;
    if (credentials.type === "sorobanCredentialsSourceAccount") {
      // Nothing to sign: the transaction source's authorization rides on the
      // envelope signature. The entry is still kept — an operation with an empty
      // auth list is treated as a recording-mode request, so the guard would
      // never run and core would reject the submission.
      signed.push(entry);
      continue;
    }
    if (
      credentials.type !== "sorobanCredentialsAddress" &&
      credentials.type !== "sorobanCredentialsAddressV2"
    ) {
      return {
        kind: "refused",
        stage: "discovery",
        detail:
          `this call requires an authorization this dashboard cannot satisfy ` +
          `(${credentials.type}); delegated credentials are outside v1 scope`,
        diagnosticEvents: [],
      };
    }
    const address = addressOfCredentials(credentials);
    if (address === null) {
      return {
        kind: "refused",
        stage: "discovery",
        detail: `the host returned an address credential with no address payload`,
        diagnosticEvents: [],
      };
    }
    if (address !== signer.address) {
      return {
        kind: "refused",
        stage: "discovery",
        detail:
          `this call must be authorized by ${address}, but the connected wallet is ` +
          `${signer.address}. Connect the account that holds the admin role for this guard.`,
        diagnosticEvents: [],
      };
    }
    // The wallet produces the signature over the exact preimage the host will
    // re-derive, including the credential kind and the entry's expiration ledger.
    promptWallet();
    const signedEntryXdr = await signer.signAuthEntry(entry.toXDR("base64"));
    signed.push(xdr.SorobanAuthorizationEntry.fromXDR(signedEntryXdr, "base64"));
  }

  // ── Step 3: enforced simulation — the pass that can actually refuse ─────
  const authorizedOperation = Operation.invokeContractFunction({
    contract: request.contract,
    function: request.fn,
    args: request.args,
    auth: signed,
  });
  const enforcing = buildInitialEnvelope({
    source: freshAccount(),
    operation: authorizedOperation,
    passphrase,
    guard: request.guardForFootprint ?? null,
  });
  const enforced = await withBackoff(
    async () => {
      const sim = await server.simulateTransaction(enforcing);
      if ((sim && (sim as any).status === "ERROR") || (sim as any).error) {
        const errStr =
          typeof (sim as any).error === "string"
            ? (sim as any).error
            : JSON.stringify((sim as any).error);
        if (errStr && (errStr.includes("TRY_AGAIN_LATER") || errStr.includes("TIMEOUT"))) {
          throw new RetryableError(errStr);
        }
      }
      return sim;
    },
    { baseDelayMs: 500, maxRetries: 3 },
  );
  if (rpc.Api.isSimulationError(enforced)) {
    return {
      kind: "refused",
      stage: "enforcement",
      detail: stringifyError((enforced as rpc.Api.SimulateTransactionErrorResponse).error),
      diagnosticEvents: diagnosticEventsOf(enforced),
    };
  }

  // ── Step 4: assemble, sign the envelope, broadcast ──────────────────────
  const assembled = assembleFromSimulation({
    simulation: enforced as rpc.Api.SimulateTransactionSuccessResponse,
    source: freshAccount(),
    operation: authorizedOperation,
    passphrase,
    guard: request.guardForFootprint ?? null,
    ...(request.feePreset !== undefined && { feePreset: request.feePreset }),
    ...(request.maxFeeCap !== undefined && { maxFeeCap: request.maxFeeCap }),
    ...(request.minTimeOffset !== undefined && { minTimeOffset: request.minTimeOffset }),
    ...(request.maxTimeOffset !== undefined && { maxTimeOffset: request.maxTimeOffset }),
  });

  if (request.exportOnly) {
    return {
      kind: "exported",
      xdr: assembled.transaction.toXDR(),
    };
  }

  const maxTimeStr = assembled.transaction.timeBounds?.maxTime;
  const maxTime = maxTimeStr ? Number(maxTimeStr) : 0;
  if (maxTime > 0 && detectExpiration(Math.floor(Date.now() / 1000), maxTime)) {
    return {
      kind: "failed",
      hash: Buffer.from(assembled.transaction.hash()).toString("hex"),
      detail: "Transaction expired during wallet signature delay. Please retry.",
      diagnosticEvents: [],
    };
  }

  promptWallet();
  const signedEnvelope = await signer.signTransaction(assembled.transaction.toXDR());

  if (maxTime > 0 && detectExpiration(Math.floor(Date.now() / 1000), maxTime)) {
    return {
      kind: "failed",
      hash: Buffer.from(assembled.transaction.hash()).toString("hex"),
      detail: "Transaction expired after wallet signature delay. Please retry.",
      diagnosticEvents: [],
    };
  }
  const transaction = TransactionBuilder.fromXDR(signedEnvelope, passphrase) as Transaction;
  // The envelope's fee field carries inclusion fee + resource fee — exactly
  // what the network will charge for this transaction.
  const feeStroops = transaction.fee;

  let sent: rpc.Api.SendTransactionResponse;
  try {
    sent = await server.sendTransaction(transaction);
  } catch (error) {
    return {
      kind: "refused",
      stage: "submission",
      detail: `the network refused the transaction: ${stringifyError(error)}`,
      diagnosticEvents: [],
    };
  }
  if (sent.status === "ERROR") {
    return {
      kind: "refused",
      stage: "submission",
      detail: `the network rejected the transaction at submission: ${stringifyError(
        sent.errorResult ?? sent,
      )}`,
      diagnosticEvents: diagnosticEventsOf(sent),
    };
  }
  if (sent.status === "DUPLICATE") {
    // The identical transaction already landed; reporting it as a failure would
    // be wrong, but it also did not just happen, so say so rather than pretend.
    return {
      kind: "submitted",
      hash: sent.hash,
      status: sent.status,
      ledger: sent.latestLedger ?? null,
      feeStroops,
      events: null,
    };
  }

  announce("Transaction submitted to network");

  const included = await pollForInclusion(
    server,
    sent.hash,
    request.pollAttempts ?? POLLING.txInclusionAttempts,
    request.pollIntervalMs ?? POLLING.txInclusionMs,
  );
  if (!included.ok) {
    return {
      kind: "failed",
      hash: sent.hash,
      detail: included.detail,
      feeStroops,
      diagnosticEvents: included.diagnosticEvents,
    };
  }
  return {
    kind: "submitted",
    hash: sent.hash,
    status: included.status,
    ledger: included.ledger,
    feeStroops,
    events: included.events,
  };
}

/**
 * Run a wallet-authorized contract call, announcing its milestones and
 * recording its outcome.
 *
 * The mid-flight milestones (simulation started, Freighter approval,
 * broadcast) are announced inside `runInvocation`, at the moment they actually
 * happen. The terminal outcome — confirmed, failed or refused — is handled
 * once, here, so every return path, including each kind of refusal, gets the
 * same announcement and the same history entry without that logic being
 * repeated at every `return`. Refused calls are announced but deliberately
 * not recorded: a refusal never had a transaction to record.
 */
export async function invokeWithWallet(request: InvokeRequest): Promise<InvokeResult> {
  const result = await runInvocation(request);
  if (result.kind === "exported") {
    announce("Transaction XDR exported for offline signing");
  } else if (result.kind === "refused") {
    announce("Transaction refused — nothing was broadcast");
  } else if (result.kind === "failed") {
    recordTx({
      hash: result.hash,
      operation: request.fn,
      status: "failed",
      feeStroops: result.feeStroops ?? null,
    });
    announce("Transaction failed on chain");
  } else if (result.kind === "submitted") {
    recordTx({
      hash: result.hash,
      operation: request.fn,
      status: "confirmed",
      feeStroops: result.feeStroops ?? null,
    });
    announce(
      result.ledger !== null && result.status === rpc.Api.GetTransactionStatus.SUCCESS
        ? `Transaction confirmed on ledger ${result.ledger}`
        : "Transaction confirmed on the network",
    );
    // Only the transaction is announced here, never what the operator meant by
    // it. A freeze's *effect* is claimed by whoever can verify it: the panic
    // panel, which re-reads `status()` and announces "Account frozen" or the
    // reason it did not take, and the fleet table, which has no re-read and so
    // announces the submission itself. One announcement per write, from the
    // place that has the evidence for it.
  }
  return result;
}

/**
 * The address payload of an address credential.
 *
 * Which field holds it follows the credential kind: legacy `sorobanCredentialsAddress`
 * nests it on `address`, while CAP-71 `sorobanCredentialsAddressV2` uses
 * `addressV2` (and additionally binds the account address into the signed
 * payload). Reading the wrong one yields no address, which would misreport a
 * satisfiable call as unsatisfiable.
 */
function addressCredentialsOf(
  credentials: xdr.SorobanCredentials,
): xdr.SorobanAddressCredentials | null {
  if (credentials.type === "sorobanCredentialsAddress") return credentials.address;
  if (credentials.type === "sorobanCredentialsAddressV2") return credentials.addressV2;
  return null;
}

/** The `G…`/`C…` address inside an address credential. */
function addressOfCredentials(credentials: xdr.SorobanCredentials): string | null {
  const addressCredentials = addressCredentialsOf(credentials);
  if (!addressCredentials) return null;
  try {
    return Address.fromScAddress(addressCredentials.address).toString();
  } catch {
    return null;
  }
}

export function createTransactionEnvelope(
  currentTime: number,
  minOffset: number = 60,
  maxOffset: number = 300,
) {
  const minTime = currentTime - minOffset;
  const maxTime = currentTime + maxOffset;
  return { minTime, maxTime };
}

export function detectExpiration(currentTime: number, maxTime: number) {
  return currentTime >= maxTime;
}
