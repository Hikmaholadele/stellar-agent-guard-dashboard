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
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { NETWORK } from "./network.ts";
import { POLLING } from "./polling.ts";
import { guardStorageLedgerKeys, ledgerKeyId } from "./scval.ts";
import { stringifyError } from "./chain.ts";
import { announce } from "./useAnnounce.ts";
import { recordTx } from "./txHistory.ts";
import { hardwareGuide } from "./hardwareGuide.ts";
import {
  PHASE_LABEL,
  interruptionFromSignerFailure,
  recordWriteInterruption,
  recoveryGuidance,
  revalidateWallet,
  type WriteInterruption,
  type WritePhase,
} from "./writeReview.ts";

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
  /**
   * Read the wallet's *live* address, or null when the provider is gone.
   *
   * Optional because headless keypair signers used by scripts and tests cannot
   * change account underneath a review. Browser signers implement it, and every
   * write boundary re-reads it so a review can only ever be signed by the
   * account it was built for (issue #340).
   */
  currentAddress?: () => Promise<string | null>;
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
      stage: "discovery" | "enforcement" | "submission" | "wallet";
      detail: string;
      diagnosticEvents: unknown[];
      /**
       * Set when the write stopped because the wallet disconnected or its
       * account changed mid-flight (issues #340, #341). A distinct, recoverable
       * outcome: the enclosing review must be repeated, never resumed.
       */
      writeInterruption?: WriteInterruption;
    }
  | {
      /** User explicitly rejected or cancelled the wallet signing prompt. */
      kind: "cancelled";
      detail: string;
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
 * The refusable result for a wallet interruption.
 *
 * Publishes the phase-specific guidance once, for the wallet panel, and returns
 * the same copy in `detail` so every existing caller can render it without
 * knowing about interruptions. Nothing is recorded as a transaction: an
 * interrupted write has no hash this console can claim.
 */
function interruptedResult(interruption: WriteInterruption): InvokeResult {
  const guidance = recoveryGuidance(interruption);
  recordWriteInterruption(interruption);
  return {
    kind: "refused",
    stage: "wallet",
    detail: `${guidance.headline} ${guidance.detail} ${guidance.nextStep}`,
    diagnosticEvents: [],
    writeInterruption: interruption,
  };
}

/**
 * Re-check the wallet binding at a write boundary, returning a result instead
 * of throwing when the wallet moved. `null` means the write may continue.
 */
async function boundary(signer: WalletSigner, phase: WritePhase): Promise<InvokeResult | null> {
  try {
    await revalidateWallet({
      boundAddress: signer.address,
      phase,
      readAddress: signer.currentAddress,
    });
    return null;
  } catch (error) {
    const interruption = interruptionFromSignerFailure(error, phase);
    if (!interruption) throw error;
    announce(`Wallet interrupted during ${PHASE_LABEL[phase]} — nothing was resubmitted`);
    return interruptedResult(interruption.interruption);
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
    // Before asking for it, the live account is re-read: a wallet that switched
    // administrators since the simulation must not sign this review (issue #340).
    const beforeAuth = await boundary(signer, "authorization");
    if (beforeAuth) return beforeAuth;
    promptWallet();
    let signedEntryXdr: string;
    try {
      signedEntryXdr = await signer.signAuthEntry(entry.toXDR("base64"));
    } catch (error) {
      const interruption = interruptionFromSignerFailure(error, "authorization");
      if (!interruption) throw error;
      announce("Wallet interrupted during authorization signing — nothing was resubmitted");
      return interruptedResult(interruption.interruption);
    }
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

  // The last chance to notice a wallet that moved between the authorization
  // signatures and the envelope signature: the envelope is what commits the
  // source account, so signing it for a different administrator is precisely
  // the silent source switch this check exists to prevent.
  const beforeEnvelope = await boundary(signer, "envelope");
  if (beforeEnvelope) return beforeEnvelope;
  promptWallet();
  let signedEnvelope: string;
  try {
    signedEnvelope = await signer.signTransaction(assembled.transaction.toXDR());
  } catch (error) {
    const interruption = interruptionFromSignerFailure(error, "envelope");
    if (!interruption) throw error;
    announce("Wallet interrupted during transaction signing — nothing was resubmitted");
    return interruptedResult(interruption.interruption);
  }

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

  // Broadcast is the last boundary: a provider that vanished here may have
  // been the only witness to a submission, so the outcome is reported as
  // "verify before retrying" rather than as a failure (issue #341).
  const beforeSend = await boundary(signer, "submission");
  if (beforeSend) return beforeSend;

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

  announce(`Transaction ${request.fn} submitted to network for guard ${request.contract}`);

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
  const context = `for guard ${request.contract}`;
  if (result.kind === "exported") {
    announce(`Transaction XDR exported for offline signing ${context}`);
  } else if (result.kind === "refused" && result.writeInterruption) {
    // The provider went away or the account changed mid-write. The guidance is
    // phase-specific and already on screen; the announcement says which phase,
    // and deliberately does not claim the write failed — at submission time it
    // may have landed.
    const guidance = recoveryGuidance(result.writeInterruption);
    announce(`${guidance.headline} ${guidance.nextStep}`, "assertive");
  } else if (result.kind === "refused") {
    announce(`Transaction refused — nothing was broadcast ${context}`, "assertive");
  } else if (result.kind === "failed") {
    recordTx({
      hash: result.hash,
      operation: request.fn,
      status: "failed",
      feeStroops: result.feeStroops ?? null,
      networkName: NETWORK.name,
      networkPassphrase: request.passphrase ?? NETWORK.passphrase,
    });
    announce(`Transaction failed on chain ${context}`, "assertive");
  } else if (result.kind === "submitted") {
    recordTx({
      hash: result.hash,
      operation: request.fn,
      status: "confirmed",
      feeStroops: result.feeStroops ?? null,
      networkName: NETWORK.name,
      networkPassphrase: request.passphrase ?? NETWORK.passphrase,
    });
    announce(
      result.ledger !== null && result.status === rpc.Api.GetTransactionStatus.SUCCESS
        ? `Transaction confirmed on ledger ${result.ledger} ${context}`
        : `Transaction confirmed on the network ${context}`,
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

export function isWalletCancellation(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "object" && (error as any).name === "WalletUserRejectedError") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  const normalised = message.toLowerCase();
  return /reject|denied|declin|cancel|abort|user.*(close|dismiss)/.test(normalised);
}

export function actionableCancellationMessage(error: unknown): string {
  if (error && typeof error === "object" && (error as any).name === "WalletUserRejectedError") {
    return (error as Error).message;
  }
  return "Transaction signing was declined in your wallet. Nothing was sent to the network. You can retry when ready.";
}

export interface DecodedOperationSummary {
  type: string;
  summary: string;
  supported: boolean;
  contract?: string;
  functionName?: string;
  args?: unknown[];
  unsupportedReason?: string;
}

export interface EnvelopeInspectionResult {
  valid: boolean;
  canSubmit: boolean;
  networkMatch: boolean;
  networkPassphrase: string;
  detectedNetwork?: string;
  sourceAccount?: string;
  sequenceNumber?: string;
  feeStroops?: string;
  timeBounds?: {
    minTime?: string;
    maxTime?: string;
    expired: boolean;
  };
  hasSignatures: boolean;
  signaturesCount: number;
  operations: DecodedOperationSummary[];
  verifiedFields: string[];
  unsupportedFields: string[];
  blockReasons: string[];
}

function getSignatureParts(s: any): { hint: Uint8Array; signature: Uint8Array } {
  const h = s.hint?.value || s.hint;
  const sig = s.signature?.value || s.signature;
  return {
    hint: h instanceof Uint8Array ? h : new Uint8Array(h),
    signature: sig instanceof Uint8Array ? sig : new Uint8Array(sig),
  };
}

function uint8ArraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const KNOWN_NETWORKS: readonly { name: string; passphrase: string }[] = [
  { name: "Public", passphrase: Networks.PUBLIC },
  { name: "Testnet", passphrase: Networks.TESTNET },
  { name: "Futurenet", passphrase: Networks.FUTURENET },
  { name: "Standalone", passphrase: "Standalone Network ; February 2017" },
];

export function verifyEnvelopeNetworkPassphrase(
  tx: Transaction,
  expectedPassphrase: string,
): { matches: boolean; detectedNetwork?: string; hasMatchingSigner: boolean } {
  if (!tx.signatures || tx.signatures.length === 0) {
    return { matches: false, hasMatchingSigner: false };
  }

  try {
    const sourceKp = Keypair.fromPublicKey(tx.source);
    const sourceHint = new Uint8Array(sourceKp.rawPublicKey().slice(-4));
    const matchingSig = tx.signatures.find((s: any) => {
      const parts = getSignatureParts(s);
      return uint8ArraysEqual(parts.hint, sourceHint);
    });

    if (matchingSig) {
      const { signature } = getSignatureParts(matchingSig);
      if (sourceKp.verify(tx.hash(), Buffer.from(signature))) {
        return { matches: true, hasMatchingSigner: true };
      }
      for (const net of KNOWN_NETWORKS) {
        if (net.passphrase === expectedPassphrase) continue;
        try {
          const altTx = TransactionBuilder.fromXDR(tx.toXDR(), net.passphrase) as Transaction;
          if (sourceKp.verify(altTx.hash(), Buffer.from(signature))) {
            return { matches: false, detectedNetwork: net.passphrase, hasMatchingSigner: true };
          }
        } catch {
          // Ignore
        }
      }
      return { matches: false, hasMatchingSigner: true };
    }
  } catch {
    // Non-G or unparseable source
  }

  return { matches: false, hasMatchingSigner: false };
}

export function summarizeOperation(op: any): DecodedOperationSummary {
  if (op.type === "invokeHostFunction") {
    const func = op.func;
    if (func && (func.type === "hostFunctionTypeInvokeContract" || func.invokeContract)) {
      const invoke = func.invokeContract || (func.value as any);
      if (invoke && invoke.contractAddress && invoke.functionName) {
        try {
          const contract = Address.fromScAddress(invoke.contractAddress).toString();
          const fnName = invoke.functionName.bytes
            ? Buffer.from(invoke.functionName.bytes).toString("utf8")
            : invoke.functionName.toString();
          const rawArgs = invoke.args ?? [];
          const args = rawArgs.map((arg: xdr.ScVal) => {
            try {
              return scValToNative(arg);
            } catch {
              return arg.toXDR("base64");
            }
          });
          return {
            type: op.type,
            summary: `Invoke ${fnName} on ${contract}`,
            supported: true,
            contract,
            functionName: fnName,
            args,
          };
        } catch (e) {
          return {
            type: op.type,
            summary: "InvokeContract with unparseable fields",
            supported: false,
            unsupportedReason: e instanceof Error ? e.message : String(e),
          };
        }
      }
    }
    return {
      type: op.type,
      summary: `Unsupported host function: ${func?.type ?? "unknown"}`,
      supported: false,
      unsupportedReason: `Host function type '${func?.type ?? "unknown"}' is not supported for manual review`,
    };
  }

  if (op.type === "payment") {
    return {
      type: op.type,
      summary: `Payment ${op.amount} to ${op.destination}`,
      supported: true,
    };
  }

  if (op.type === "changeTrust") {
    return {
      type: op.type,
      summary: "Change trust for asset",
      supported: true,
    };
  }

  return {
    type: op.type,
    summary: `Unsupported operation: ${op.type}`,
    supported: false,
    unsupportedReason: `Operation type '${op.type}' is not supported for safe broadcast review`,
  };
}

export function inspectSignedEnvelope(
  xdrString: string,
  expectedPassphrase: string = NETWORK.passphrase,
  currentTimeSec: number = Math.floor(Date.now() / 1000),
): EnvelopeInspectionResult {
  const cleanXdr = (xdrString ?? "").trim();
  const baseResult: EnvelopeInspectionResult = {
    valid: false,
    canSubmit: false,
    networkMatch: false,
    networkPassphrase: expectedPassphrase,
    hasSignatures: false,
    signaturesCount: 0,
    operations: [],
    verifiedFields: [],
    unsupportedFields: [],
    blockReasons: [],
  };

  if (!cleanXdr) {
    baseResult.blockReasons.push("XDR string is empty");
    return baseResult;
  }

  let tx: Transaction;
  try {
    const parsed = TransactionBuilder.fromXDR(cleanXdr, expectedPassphrase);
    if (!("operations" in parsed)) {
      baseResult.blockReasons.push("FeeBump transactions are outside v1 envelope review scope");
      return baseResult;
    }
    tx = parsed as Transaction;
  } catch (error) {
    baseResult.blockReasons.push(`Malformed envelope XDR: ${stringifyError(error)}`);
    return baseResult;
  }

  baseResult.valid = true;
  baseResult.sourceAccount = tx.source;
  baseResult.sequenceNumber = tx.sequence;
  baseResult.feeStroops = tx.fee;

  baseResult.verifiedFields.push(`Source account: ${tx.source}`);
  baseResult.verifiedFields.push(`Sequence: ${tx.sequence}`);
  baseResult.verifiedFields.push(`Fee: ${tx.fee} stroops`);

  const signaturesCount = tx.signatures?.length ?? 0;
  baseResult.signaturesCount = signaturesCount;
  baseResult.hasSignatures = signaturesCount > 0;
  if (!baseResult.hasSignatures) {
    baseResult.blockReasons.push("Envelope has no signatures");
  } else {
    baseResult.verifiedFields.push(`Signatures: ${signaturesCount} signature(s) present`);
  }

  const netCheck = verifyEnvelopeNetworkPassphrase(tx, expectedPassphrase);
  baseResult.networkMatch = netCheck.matches;
  if (netCheck.detectedNetwork) {
    baseResult.detectedNetwork = netCheck.detectedNetwork;
    baseResult.blockReasons.push(
      `Network mismatch: envelope signed for '${netCheck.detectedNetwork}', but dashboard is on '${expectedPassphrase}'`,
    );
  } else if (baseResult.hasSignatures && !netCheck.matches) {
    baseResult.blockReasons.push(
      `Network mismatch: signatures do not verify against active network '${expectedPassphrase}'`,
    );
  } else if (netCheck.matches) {
    baseResult.verifiedFields.push(`Network binding verified: ${expectedPassphrase}`);
  }

  const maxTimeStr = tx.timeBounds?.maxTime;
  const maxTime = maxTimeStr ? Number(maxTimeStr) : 0;
  const isExpired = maxTime > 0 && currentTimeSec >= maxTime;
  baseResult.timeBounds = {
    ...(tx.timeBounds?.minTime !== undefined ? { minTime: tx.timeBounds.minTime } : {}),
    ...(maxTimeStr !== undefined ? { maxTime: maxTimeStr } : {}),
    expired: isExpired,
  };

  if (isExpired) {
    baseResult.blockReasons.push(
      `Transaction expired at timestamp ${maxTime} (current: ${currentTimeSec})`,
    );
  } else if (maxTime > 0) {
    baseResult.verifiedFields.push(`Expiration verified: valid until ${maxTime}`);
  }

  for (const op of tx.operations) {
    const summary = summarizeOperation(op);
    baseResult.operations.push(summary);
    if (!summary.supported) {
      baseResult.unsupportedFields.push(summary.unsupportedReason ?? summary.type);
      baseResult.blockReasons.push(`Contains unsupported operation: ${summary.type}`);
    } else {
      baseResult.verifiedFields.push(`Operation: ${summary.summary}`);
    }
  }

  baseResult.canSubmit =
    baseResult.valid &&
    baseResult.networkMatch &&
    !isExpired &&
    baseResult.hasSignatures &&
    baseResult.unsupportedFields.length === 0 &&
    baseResult.blockReasons.length === 0;

  return baseResult;
}

export interface SignedEnvelopePreflight {
  checkedAt: string;
  sequence: {
    status: "current" | "stale" | "ahead" | "unknown";
    detail: string;
  };
  expiration: {
    status: "active" | "expired" | "not_yet_valid" | "not_bounded" | "unknown";
    detail: string;
  };
}

/** Compare an imported envelope with fresh chain observations without changing it. */
export function evaluateSignedEnvelopePreflight(params: {
  sequence: string;
  timeBounds?: { minTime: string; maxTime: string };
  accountSequence?: string;
  ledgerCloseTime?: string | number;
  checkedAt?: string;
}): SignedEnvelopePreflight {
  const sequence = (() => {
    if (params.accountSequence === undefined) {
      return { status: "unknown" as const, detail: "Account sequence could not be read." };
    }
    const expected = BigInt(params.accountSequence) + 1n;
    const envelopeSequence = BigInt(params.sequence);
    if (envelopeSequence === expected) {
      return { status: "current" as const, detail: `Sequence ${params.sequence} is next.` };
    }
    return envelopeSequence < expected
      ? {
          status: "stale" as const,
          detail: `Envelope sequence ${params.sequence} is behind the next account sequence ${expected}.`,
        }
      : {
          status: "ahead" as const,
          detail: `Envelope sequence ${params.sequence} is ahead of the next account sequence ${expected}.`,
        };
  })();

  const expiration = (() => {
    if (!params.timeBounds || params.timeBounds.maxTime === "0") {
      return { status: "not_bounded" as const, detail: "Envelope has no maximum time bound." };
    }
    if (params.ledgerCloseTime === undefined) {
      return { status: "unknown" as const, detail: "Latest ledger close time could not be read." };
    }
    const ledgerCloseTime = Number(params.ledgerCloseTime);
    const minTime = Number(params.timeBounds.minTime);
    const maxTime = Number(params.timeBounds.maxTime);
    if (!Number.isFinite(ledgerCloseTime) || !Number.isFinite(maxTime)) {
      return {
        status: "unknown" as const,
        detail: "Envelope or ledger time bounds are unavailable.",
      };
    }
    if (ledgerCloseTime >= maxTime) {
      return {
        status: "expired" as const,
        detail: "Latest ledger close time is at or past the envelope expiration.",
      };
    }
    if (minTime > 0 && ledgerCloseTime < minTime) {
      return {
        status: "not_yet_valid" as const,
        detail: "Latest ledger close time is before the envelope start time.",
      };
    }
    return {
      status: "active" as const,
      detail: "Envelope time bounds include the latest ledger close time.",
    };
  })();

  return {
    checkedAt: params.checkedAt ?? new Date().toISOString(),
    sequence,
    expiration,
  };
}

/** Read the account sequence and latest ledger time used by the advisory preflight. */
export async function preflightSignedEnvelope(
  server: rpc.Server,
  envelope: Transaction | FeeBumpTransaction,
): Promise<SignedEnvelopePreflight> {
  const transaction = envelope instanceof FeeBumpTransaction ? envelope.innerTransaction : envelope;
  const [accountResult, ledgerResult] = await Promise.allSettled([
    server.getAccount(transaction.source),
    server.getLatestLedger(),
  ]);
  return evaluateSignedEnvelopePreflight({
    sequence: transaction.sequence,
    ...(transaction.timeBounds === undefined ? {} : { timeBounds: transaction.timeBounds }),
    ...(accountResult.status === "fulfilled"
      ? { accountSequence: accountResult.value.sequenceNumber() }
      : {}),
    ...(ledgerResult.status === "fulfilled"
      ? { ledgerCloseTime: ledgerResult.value.closeTime }
      : {}),
  });
}
