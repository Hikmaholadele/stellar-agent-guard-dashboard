/**
 * Reading the account facts the multisig tracker needs, off Horizon.
 *
 * The tracker's arithmetic lives in `multisig.ts` as pure functions; this
 * module is the seam that fetches what those functions consume — the account's
 * signer list (weights) and its threshold settings — from the Horizon account
 * endpoint, plus the signature list actually on a pending envelope.
 *
 * Like every read in this dashboard, a failed fetch is an error, never a
 * default: a tracker that rendered "0 of 0" because Horizon was unreachable
 * would look identical to a genuinely threshold-less account. `ReadResult`
 * keeps the failure visible.
 *
 * The Horizon server is constructed lazily from the deployment's network
 * constant, exactly as `chain.ts` constructs the Soroban RPC server. No
 * `Buffer` and no `node:crypto`: this runs in the browser, so hex encoding and
 * strkey decoding go through the same helpers the rest of `lib/guard` uses.
 */

import { Horizon, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import { NETWORK } from "./network.ts";
import type {
  EnvelopeSignature,
  MultisigSigner,
  MultisigThresholds,
  SignerKind,
} from "./multisig.ts";

export type HorizonReadResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function createHorizonServer(horizonUrl?: string): Horizon.Server {
  return new Horizon.Server(horizonUrl ?? defaultHorizonUrl());
}

/**
 * The Horizon base URL for the dashboard's pinned network.
 *
 * The network constant names the passphrase; the Horizon host is derived from
 * the same testnet deployment rather than configurable, so the tracker cannot
 * be pointed at an account from a different network by accident.
 */
export function defaultHorizonUrl(): string {
  // The deployment is pinned to testnet; keep the derivation in one place so a
  // pubnet deployment changes it exactly once.
  return "https://horizon-testnet.stellar.org";
}

interface HorizonSignerRecord {
  key?: unknown;
  weight?: unknown;
  /** Horizon's signer type: `ed25519_public_key`, `sha256_hash`, … */
  type?: string;
}

/**
 * Map Horizon's signer `type` onto the tracker's signer kinds.
 *
 * An unrecognised (or absent) type is `unknown`, which the evaluator treats as
 * unattributable — the conservative choice: claiming an exact remaining weight
 * is worse than saying it cannot be known.
 */
export function signerKind(type: string | undefined): SignerKind {
  switch (type) {
    case undefined:
    case "ed25519_public_key":
      return "ed25519";
    case "sha256_hash":
      return "hash";
    case "preauth_tx":
      return "preauth";
    case "ed25519_signed_payload":
      return "signed_payload";
    default:
      return "unknown";
  }
}

interface HorizonAccountRecord {
  signers?: unknown;
  thresholds?: unknown;
}

export interface MultisigAccountSnapshot {
  signers: MultisigSigner[];
  thresholds: MultisigThresholds | null;
  observedAt: string;
  incompleteReasons: string[];
}

/** Labels are derived deterministically so tests and UI agree on them. */
export function defaultSignerLabel(index: number): string {
  return `Signer ${index + 1}`;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Read the guarded account's signers and thresholds from Horizon.
 *
 * Signers carrying weight 0 are kept (a disabled signer is real account state
 * worth showing) and order follows Horizon's response, master key first.
 */
export async function readAccountSigners(
  server: Horizon.Server,
  accountId: string,
  now: () => Date = () => new Date(),
): Promise<HorizonReadResult<MultisigAccountSnapshot>> {
  try {
    const record = (await server.accounts().accountId(accountId).call()) as HorizonAccountRecord;
    const incompleteReasons: string[] = [];
    const signers: MultisigSigner[] = [];
    if (!Array.isArray(record.signers)) {
      incompleteReasons.push("Horizon did not return a complete signer list.");
    } else {
      record.signers.forEach((value, index) => {
        if (typeof value !== "object" || value === null) {
          incompleteReasons.push(
            `Horizon returned an invalid signer record at position ${index + 1}.`,
          );
          return;
        }
        const signer = value as HorizonSignerRecord;
        if (
          typeof signer.key !== "string" ||
          !Number.isInteger(signer.weight) ||
          (signer.weight as number) < 0 ||
          (signer.weight as number) > 255
        ) {
          incompleteReasons.push(
            `Horizon returned incomplete signer data at position ${index + 1}.`,
          );
          return;
        }
        const kind = signerKind(typeof signer.type === "string" ? signer.type : undefined);
        if (kind === "ed25519" && signerHint(signer.key) === null) {
          incompleteReasons.push(
            `Horizon returned an invalid Ed25519 signer key at position ${index + 1}.`,
          );
          return;
        }
        signers.push({
          key: signer.key,
          weight: signer.weight as number,
          label: defaultSignerLabel(index),
          kind,
        });
      });
    }

    const rawThresholds = record.thresholds as Partial<MultisigThresholds> | undefined;
    const thresholdValues = rawThresholds
      ? [rawThresholds.low_threshold, rawThresholds.med_threshold, rawThresholds.high_threshold]
      : [];
    const thresholds =
      thresholdValues.length === 3 &&
      thresholdValues.every(
        (value) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 255,
      )
        ? {
            low_threshold: rawThresholds!.low_threshold as number,
            med_threshold: rawThresholds!.med_threshold as number,
            high_threshold: rawThresholds!.high_threshold as number,
          }
        : null;
    if (thresholds === null) {
      incompleteReasons.push("Horizon did not return all valid account thresholds.");
    }

    return {
      ok: true,
      value: { signers, thresholds, observedAt: now().toISOString(), incompleteReasons },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Extract the signatures present on a transaction envelope.
 *
 * The envelope is decoded locally — no network call — because the signatures
 * to count are the ones already on the envelope, not whatever the network has
 * seen. A decorated signature carries only a 4-byte *hint* of its signer (the
 * last 4 bytes of the Ed25519 public key), which is enough to match the
 * signature to an account signer but not enough to reconstruct the `G…` key;
 * the returned records therefore carry `hint:<hex>` identities and the caller
 * matches them against `signerHint()` for each account signer.
 */
export function readEnvelopeSignatures(
  envelopeXdr: string,
  passphrase: string = NETWORK.passphrase,
): HorizonReadResult<EnvelopeSignature[]> {
  try {
    const envelope = TransactionBuilder.fromXDR(envelopeXdr.trim(), passphrase);
    const signatures: EnvelopeSignature[] = [];
    for (const decorated of envelope.signatures) {
      // `hint` is the SDK's `SignatureHint` wrapper; `.value` is the raw 4 bytes.
      const hint = (decorated.hint as unknown as { value: Uint8Array }).value;
      signatures.push({ signer: `hint:${toHex(hint)}` });
    }
    return { ok: true, value: signatures };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The 4-byte signature hint of an account signer, for envelope matching. */
export function signerHint(signerKey: string): string | null {
  try {
    return toHex(StrKey.decodeEd25519PublicKey(signerKey).slice(-4));
  } catch {
    // Not a `G…` account key (a contract, a hash signer, or a typo): it cannot
    // match an Ed25519 signature hint.
    return null;
  }
}

/**
 * Match envelope signatures to account signers by 4-byte hint.
 *
 * A hint is only 4 bytes, so distinct signers can share one. When a hint maps
 * to more than one signer the match is reported as ambiguous rather than
 * arbitrarily picking the first: the caller must downgrade the remaining-weight
 * answer to "unknown" instead of attributing weight to the wrong key.
 */
export function matchEnvelopeSignatures(
  signatures: readonly EnvelopeSignature[],
  signers: readonly MultisigSigner[],
): { signatures: EnvelopeSignature[]; ambiguousHints: string[] } {
  const byHint = new Map<string, string[]>();
  for (const signer of signers) {
    const hint = signerHint(signer.key);
    if (hint === null) continue;
    const key = `hint:${hint}`;
    byHint.set(key, [...(byHint.get(key) ?? []), signer.key]);
  }

  const ambiguousHints = [...byHint.entries()]
    .filter(([, keys]) => keys.length > 1)
    .map(([hint]) => hint);

  return {
    signatures: signatures.map((signature) => ({
      signer: byHint.get(signature.signer)?.[0] ?? signature.signer,
    })),
    ambiguousHints,
  };
}

/**
 * Signatures on the envelope that no current account signer claims.
 *
 * Horizon hints can collide (4 bytes of a 32-byte key) across enormous signer
 * sets, so a match here is the tracker's reading of the facts rather than a
 * cryptographic identification — the network itself does the exact check at
 * submission, and this list only informs the display.
 */
export function unmatchedSignatures(
  signatures: readonly EnvelopeSignature[],
  signers: readonly MultisigSigner[],
): string[] {
  const known = new Set(
    signers
      .map((signer) => signerHint(signer.key))
      .filter((hint): hint is string => hint !== null)
      .map((hint) => `hint:${hint}`),
  );
  return signatures.map((signature) => signature.signer).filter((signer) => !known.has(signer));
}
