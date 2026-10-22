/**
 * Wallet binding and interruption rules for the write path (issues #340, #341).
 *
 * A browser wallet is not a stable signer. The operator can switch accounts in
 * the extension between the simulation this console reviewed and the signature
 * that would authorize it, and the provider itself can disappear mid-flight.
 * Both must stop the write rather than produce a transaction nobody reviewed.
 *
 * The rules here are deliberately pure and dependency-free so they are
 * exercised in `node --test` without an extension, a chain, or a React tree:
 *
 *   - A review is bound to the address that ran the simulation. At every write
 *     boundary the live address is re-read and must still match; never silently
 *     switch the transaction source.
 *   - A disconnect is a *recoverable* outcome, not a generic failure. The phase
 *     it happened in decides what the operator may safely assume (nothing was
 *     signed, a signature may exist, or the transaction may already be on
 *     chain) and therefore the next action.
 *   - Recovery is never automatic. `recoveryGuidance` returns data only — no
 *     retry, no stored envelope — so reconnecting cannot resubmit a write.
 */

/** Where in the write a wallet problem was detected. */
export type WritePhase = "discovery" | "authorization" | "envelope" | "submission";

export type WriteInterruption =
  | {
      kind: "wallet-disconnected";
      phase: WritePhase;
    }
  | {
      kind: "account-changed";
      phase: WritePhase;
      /** The address the simulation and review were built for. */
      expected: string;
      /** The address the wallet is on now. */
      actual: string;
    };

/** Only the last four characters of an address ever appear in UI copy. */
export function shortAddress(address: string): string {
  return address.length <= 8 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export const PHASE_LABEL: Readonly<Record<WritePhase, string>> = {
  discovery: "simulation",
  authorization: "authorization signing",
  envelope: "transaction signing",
  submission: "submission",
};

export class WriteInterruptionError extends Error {
  readonly interruption: WriteInterruption;

  constructor(interruption: WriteInterruption) {
    super(describeInterruption(interruption));
    this.name = "WriteInterruptionError";
    this.interruption = interruption;
  }
}

export interface RecoveryGuidance {
  interruption: WriteInterruption;
  /** One sentence naming what happened. */
  headline: string;
  /** What the operator may safely assume about signatures and broadcast. */
  detail: string;
  /** The next safe action. */
  nextStep: string;
  /** True when the write may already be on chain and must be looked up first. */
  writeMayHaveLanded: boolean;
  /** Always false: recovery is a fresh review, never an automatic retry. */
  autoResubmit: false;
  /** Always false: an envelope is never stored for a later retry. */
  persistEnvelope: false;
}

/**
 * Re-read the wallet's active address at a write boundary.
 *
 * `readAddress` is the signer's live reader. When a signer has none (the
 * headless keypair signers used by scripts and tests) there is nothing that can
 * move underneath the review, so the check is a no-op rather than a failure.
 * A reader that throws or returns null means the provider is gone, which is a
 * disconnect — not a reason to carry on signing.
 */
export async function revalidateWallet(params: {
  boundAddress: string;
  phase: WritePhase;
  readAddress?: (() => Promise<string | null>) | undefined;
}): Promise<void> {
  const readAddress = params.readAddress;
  if (!readAddress) return;

  let actual: string | null;
  try {
    actual = await readAddress();
  } catch {
    throw new WriteInterruptionError({ kind: "wallet-disconnected", phase: params.phase });
  }
  if (!actual) {
    throw new WriteInterruptionError({ kind: "wallet-disconnected", phase: params.phase });
  }
  if (actual !== params.boundAddress) {
    throw new WriteInterruptionError({
      kind: "account-changed",
      phase: params.phase,
      expected: params.boundAddress,
      actual,
    });
  }
}

/** The interruption an error represents at `phase`, or null when it is unrelated. */
export function asWriteInterruption(error: unknown, phase: WritePhase): WriteInterruption | null {
  if (error instanceof WriteInterruptionError) return error.interruption;
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  // Wording the providers actually use when the extension/page is gone. A
  // declined signature is deliberately absent: a rejection is the operator's
  // decision and keeps its own error, while a vanished provider is recoverable.
  if (
    /not (be )?(found|installed|available)|no provider|disconnected|connect(ion)? (was )?(closed|lost)|extension (is )?(gone|unavailable)|locked|no wallet/.test(
      message,
    )
  ) {
    return { kind: "wallet-disconnected", phase };
  }
  return null;
}

/** Turn a thrown signer failure into a recoverable interruption, or rethrow. */
export function interruptionFromSignerFailure(
  error: unknown,
  phase: WritePhase,
): WriteInterruptionError | null {
  const interruption = asWriteInterruption(error, phase);
  return interruption ? new WriteInterruptionError(interruption) : null;
}

export function describeInterruption(interruption: WriteInterruption): string {
  if (interruption.kind === "wallet-disconnected") {
    return `the wallet disconnected during ${PHASE_LABEL[interruption.phase]}`;
  }
  return (
    `the wallet account changed from ${shortAddress(interruption.expected)} to ` +
    `${shortAddress(interruption.actual)} during ${PHASE_LABEL[interruption.phase]}`
  );
}

/**
 * The phase-specific, safe-to-show recovery copy.
 *
 * Only the phase, the interruption kind and shortened public addresses appear
 * here: no signed XDR, no transaction payload, nothing the operator did not
 * already have on screen.
 */
export function recoveryGuidance(interruption: WriteInterruption): RecoveryGuidance {
  const base = { interruption, autoResubmit: false, persistEnvelope: false } as const;
  const phase = interruption.phase;

  if (interruption.kind === "account-changed") {
    const from = shortAddress(interruption.expected);
    const to = shortAddress(interruption.actual);
    if (phase === "submission") {
      return {
        ...base,
        headline: `The wallet account changed from ${from} to ${to} as the write was submitted.`,
        detail:
          "The transaction was already handed to the network, so it may be on chain — but it was produced for the account above, and this console cannot confirm what happened to it from here.",
        nextStep: `Look the transaction up in Transaction history (or on chain) before doing anything else. ${to} is not the account the review was for.`,
        writeMayHaveLanded: true,
      };
    }
    return {
      ...base,
      headline: `The wallet account changed from ${from} to ${to} during ${PHASE_LABEL[phase]}.`,
      detail:
        phase === "envelope"
          ? "The review was cancelled, so nothing was broadcast. A signature for the original account may still exist inside the wallet, but this console never received one."
          : "The review was cancelled, so nothing was signed or broadcast from the new account.",
      nextStep: `Switch the wallet back to ${from} and run a fresh review — the simulation and the signature must be for the same administrator.`,
      writeMayHaveLanded: false,
    };
  }

  const copy: Record<WritePhase, { detail: string; nextStep: string }> = {
    discovery: {
      detail: "The simulation stopped early, so nothing was signed and nothing was sent.",
      nextStep: "Reconnect the wallet, then start a new review.",
    },
    authorization: {
      detail:
        "The authorization entry was not fully signed, so no transaction was assembled and nothing was broadcast.",
      nextStep: "Reconnect the wallet and review the call again.",
    },
    envelope: {
      detail:
        "A signature may have been produced in the wallet, but this console did not receive a signed envelope, so nothing was broadcast.",
      nextStep:
        "Reconnect the wallet and start a fresh review. Check Transaction history for the original submission before retrying, in case it landed.",
    },
    submission: {
      detail:
        "The transaction had already been handed to the network when the provider went away. It may be on chain, and this console cannot confirm it from here.",
      nextStep:
        "Check Transaction history (or the chain) for the submission before retrying — recovery never resubmits automatically.",
    },
  };

  return {
    ...base,
    headline: `The wallet disconnected during ${PHASE_LABEL[phase]}.`,
    detail: copy[phase].detail,
    nextStep: copy[phase].nextStep,
    writeMayHaveLanded: phase === "submission",
  };
}

/** True when a write result carries a recoverable wallet interruption. */
export function isRecoverableInterruption(result: {
  kind: string;
  writeInterruption?: WriteInterruption;
}): boolean {
  return result.kind !== "submitted" && result.writeInterruption !== undefined;
}

// ── The one-way notice the UI reads ────────────────────────────────────────

export interface WriteInterruptionState {
  interruption: WriteInterruption;
  recordedAt: string;
}

let interruptionState: WriteInterruptionState | null = null;
const listeners = new Set<() => void>();

export function getWriteInterruption(): WriteInterruptionState | null {
  return interruptionState;
}

export function subscribeWriteInterruption(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Publish an interruption for the panels to explain.
 *
 * This is the only "record" of an interrupted write: the signed envelope is not
 * kept, and no callback here can resubmit anything. The state lives in memory
 * and dies with the tab, which is the same lifetime as the review itself.
 */
export function recordWriteInterruption(interruption: WriteInterruption): WriteInterruptionState {
  interruptionState = { interruption, recordedAt: new Date().toISOString() };
  for (const listener of listeners) listener();
  return interruptionState;
}

export function clearWriteInterruption(): void {
  if (interruptionState === null) return;
  interruptionState = null;
  for (const listener of listeners) listener();
}
