/**
 * Deploy salts, and the address each one produces.
 *
 * A guard's contract address is `sha256(HashIdPreimage::ContractId)` over the
 * deployer and the salt, so the salt is the only lever an operator has over
 * where a deployment lands. Some teams want a memorable address, others want a
 * salt they can re-derive from a name; both are legitimate and both need the
 * same thing — the address shown before anything is signed, never afterwards.
 *
 * Address derivation is delegated to `predictContractId` in `chain.ts`, which is
 * the same function the deploy flow uses to confirm what it created. Duplicating
 * the preimage encoding here would mean two definitions of "the address this
 * deploy will produce", and those are exactly the kind of definitions that drift.
 */

import { toHex } from "./scval.ts";
import { StrKey } from "@stellar/stellar-sdk";
import { predictContractId } from "./chain.ts";
import { SALT_BYTES } from "./network.ts";
import { hexToBytes } from "./scval.ts";

export type SaltEncoding = "hex" | "utf8";

export interface RandomFiller {
  (target: Uint8Array): Uint8Array;
}

function defaultRandomFiller(): RandomFiller {
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    return (target) => globalThis.crypto.getRandomValues(target);
  }
  throw new Error(
    "no source of randomness available: neither crypto.getRandomValues nor an injected one",
  );
}

/** A fresh 32-byte salt, the shape the contract expects. */
export function randomSalt(fill?: RandomFiller): Uint8Array {
  const bytes = new Uint8Array(SALT_BYTES);
  const filler = fill ?? defaultRandomFiller();
  filler(bytes);
  if (bytes.every((byte) => byte === 0)) {
    throw new Error("the random source returned an all-zero salt");
  }
  return bytes;
}

export type SaltParse =
  | { ok: true; bytes: Uint8Array; encoding: SaltEncoding; paddedBytes: number }
  | { ok: false; message: string };

/**
 * Turn what the operator typed into exactly `SALT_BYTES`.
 *
 * Hex input must decode to 32 bytes and nothing else — a short hex string is a
 * typo, not a hint. UTF-8 input is the "my salt is a name" case, so it is
 * accepted up to 32 bytes and right-padded, with the padding reported rather
 * than hidden: a preview that silently re-padded would show one address and
 * deploy from another.
 */
export function parseSalt(raw: string, encoding: SaltEncoding): SaltParse {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, message: "Enter a salt, or generate a random one." };

  if (encoding === "hex") {
    const clean = trimmed.replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]+$/.test(clean)) {
      return {
        ok: false,
        message: "Hex salt: use 0-9 and a-f only (optionally prefixed with 0x).",
      };
    }
    if (clean.length !== SALT_BYTES * 2) {
      return {
        ok: false,
        message: `Hex salt must be exactly ${SALT_BYTES} bytes — ${SALT_BYTES * 2} characters, got ${clean.length}.`,
      };
    }
    try {
      return { ok: true, bytes: hexToBytes(clean), encoding, paddedBytes: 0 };
    } catch {
      return { ok: false, message: "That hex string could not be decoded." };
    }
  }

  const encoded = new TextEncoder().encode(trimmed);
  if (encoded.length > SALT_BYTES) {
    return {
      ok: false,
      message: `Text salt is ${encoded.length} bytes; the maximum is ${SALT_BYTES}. Shorten it or use hex.`,
    };
  }
  const bytes = new Uint8Array(SALT_BYTES);
  bytes.set(encoded);
  return { ok: true, bytes, encoding, paddedBytes: SALT_BYTES - encoded.length };
}

/** The salt as lowercase hex, for display and for the address preview key. */
export function formatSalt(bytes: Uint8Array): string {
  return toHex(bytes);
}

/**
 * Every input that determines the predicted address.
 *
 * The address is `sha256(network id ‖ deployer ‖ salt)`, so these four values
 * are the whole derivation. Keeping them together lets the UI state what the
 * prediction is bound to and detect an obsolete preview instead of showing an
 * address for the salt the operator just replaced.
 */
export interface DeployPredictionInputs {
  deployerPublicKey: string;
  /** The exact 32-byte salt, lowercase hex. */
  saltHex: string;
  networkName: string;
  networkPassphrase: string;
}

/** A stable key for "was this prediction computed from these inputs?". */
export function deployPredictionKey(inputs: DeployPredictionInputs): string {
  return [
    inputs.deployerPublicKey,
    inputs.saltHex,
    inputs.networkName,
    inputs.networkPassphrase,
  ].join("\u0000");
}

/**
 * Which inputs changed between two predictions. Empty means the prediction is
 * still current; otherwise the caller marks it obsolete and recomputes.
 */
export function deployPredictionChanges(
  previous: DeployPredictionInputs,
  current: DeployPredictionInputs,
): Array<"deployer" | "salt" | "network"> {
  const changes: Array<"deployer" | "salt" | "network"> = [];
  if (previous.deployerPublicKey !== current.deployerPublicKey) changes.push("deployer");
  if (previous.saltHex !== current.saltHex) changes.push("salt");
  if (
    previous.networkName !== current.networkName ||
    previous.networkPassphrase !== current.networkPassphrase
  ) {
    changes.push("network");
  }
  return changes;
}

/**
 * The one-paragraph explanation shown beside the prediction.
 *
 * It states the derivation and its limits in the same breath: a prediction is
 * deterministic, but it is not a reservation and says nothing about whether the
 * address is unique or still free. Only the chain read can report a collision.
 */
export function describeDeployPrediction(inputs: DeployPredictionInputs): string {
  return (
    `Derived from sha256(network id + deployer ${inputs.deployerPublicKey} + salt ${inputs.saltHex}) ` +
    `on ${inputs.networkName}. The same deployer, salt and network always produce the same address; ` +
    "changing either the deployer or the salt changes it. This is a prediction, not a reservation: " +
    "it does not claim the address is unique or unused — only a chain read can report a collision."
  );
}

/** Why these inputs cannot produce a prediction, or null when they can. */
export function deployPredictionProblem(inputs: DeployPredictionInputs): string | null {
  if (!StrKey.isValidEd25519PublicKey(inputs.deployerPublicKey.trim())) {
    return "The deployer is not a valid Stellar account address, so no address can be derived.";
  }
  if (!/^[0-9a-f]{64}$/i.test(inputs.saltHex.trim())) {
    return `The salt must be exactly ${SALT_BYTES} bytes (${SALT_BYTES * 2} hex characters).`;
  }
  if (inputs.networkName.trim() === "" || inputs.networkPassphrase.trim() === "") {
    return "The network name and passphrase are part of the derivation and must be set.";
  }
  return null;
}

export type AddressPreview = { ok: true; address: string } | { ok: false; message: string };

/**
 * The contract address this deployer + salt pair will produce.
 *
 * `predict` is injectable so a vanity search can pin the network once instead of
 * re-hashing the passphrase per candidate, and so tests can drive the shape
 * without a chain.
 */
export async function predictSaltAddress(params: {
  deployerPublicKey: string;
  salt: Uint8Array;
  passphrase?: string;
  predict?: (params: {
    deployerPublicKey: string;
    salt: Uint8Array;
    passphrase?: string;
  }) => Promise<string>;
}): Promise<AddressPreview> {
  const predict = params.predict ?? predictContractId;
  try {
    return { ok: true, address: await predict(params) };
  } catch (caught) {
    return {
      ok: false,
      message: caught instanceof Error ? caught.message : String(caught),
    };
  }
}

/**
 * A predictor that computes the network id once and reuses it.
 *
 * A vanity search tries thousands of salts against the same deployer and the
 * same network, and the passphrase hash is identical every time; re-deriving it
 * per candidate costs more than the hash of the preimage itself.
 */
export function createSaltAddressPredictor(params: {
  deployerPublicKey: string;
  passphrase?: string;
  predict?: (params: {
    deployerPublicKey: string;
    salt: Uint8Array;
    passphrase?: string;
  }) => Promise<string>;
}): (salt: Uint8Array) => Promise<string> {
  const predict = params.predict ?? predictContractId;
  return (salt) =>
    predict({
      deployerPublicKey: params.deployerPublicKey,
      salt,
      ...(params.passphrase !== undefined ? { passphrase: params.passphrase } : {}),
    });
}

export type VanityPosition = "prefix" | "suffix";

export interface VanityRequest {
  /** The `C…` text wanted, without needing to include the leading `C`. */
  pattern: string;
  position: VanityPosition;
  saltAddress: (salt: Uint8Array) => Promise<string>;
  /** Checked between candidates so a stopped search stops promptly. */
  signal?: { aborted: boolean };
  fill?: RandomFiller;
  onProgress?: (progress: VanityProgress) => void;
  /** A ceiling, so a pattern nobody can hit does not spin the tab forever. */
  maxAttempts?: number;
}

export interface VanityProgress {
  attempts: number;
  closest: string;
  elapsedMs: number;
}

export type VanityOutcome =
  | { status: "found"; salt: Uint8Array; address: string; attempts: number }
  | { status: "stopped"; attempts: number; reason: "aborted" | "exhausted" }
  | { status: "invalid"; message: string };

const STRKEY_BODY = /^[A-Z2-7]+$/;

/** Past this length the search is hopeless in a browser tab, so it is refused. */
const MAX_PATTERN_LENGTH = 12;

/** Reject an impossible pattern before burning attempts on it. */
export function validateVanityPattern(pattern: string, position: VanityPosition): string | null {
  const upper = pattern.trim().toUpperCase();
  if (upper === "") return "Enter the text the address should contain.";
  if (upper.length > MAX_PATTERN_LENGTH) {
    return `A ${upper.length}-character ${position} is out of reach: addresses are base32, so each character is 1 chance in 32 and this search stops at ${MAX_PATTERN_LENGTH}.`;
  }
  if (!STRKEY_BODY.test(upper)) {
    return "Stellar addresses are base32: uppercase A-Z and the digits 2-7 only (no 0, 1, 8 or 9).";
  }
  return null;
}

/**
 * Search random salts until the derived address carries the wanted text.
 *
 * The search is honest about its odds: it reports attempts, and it stops at
 * `maxAttempts` rather than pretending a 10-character prefix will arrive. Every
 * candidate is checked by deriving its address, so what is reported is what a
 * deploy would produce — there is no second, cheaper model of the rule here.
 */
export async function searchVanitySalt(request: VanityRequest): Promise<VanityOutcome> {
  const pattern = request.pattern.trim().toUpperCase();
  const invalid = validateVanityPattern(pattern, request.position);
  if (invalid) return { status: "invalid", message: invalid };

  const filler = request.fill ?? defaultRandomFiller();
  const started = Date.now();
  const max = request.maxAttempts ?? 50_000;
  let closest = "";
  let bestAffinity = -1;

  for (let attempt = 1; attempt <= max; attempt += 1) {
    if (request.signal?.aborted) {
      return { status: "stopped", attempts: attempt - 1, reason: "aborted" };
    }
    const salt = new Uint8Array(SALT_BYTES);
    filler(salt);
    const address = await request.saltAddress(salt);
    const matched =
      request.position === "prefix" ? address.startsWith(pattern) : address.endsWith(pattern);
    if (matched) {
      request.onProgress?.({
        attempts: attempt,
        closest: address,
        elapsedMs: Date.now() - started,
      });
      return { status: "found", salt, address, attempts: attempt };
    }
    const affinity = affinityOf(address, pattern, request.position);
    if (affinity > bestAffinity) {
      bestAffinity = affinity;
      closest = address;
    }
    if (attempt % 64 === 0) {
      request.onProgress?.({ attempts: attempt, closest, elapsedMs: Date.now() - started });
    }
  }
  return { status: "stopped", attempts: max, reason: "exhausted" };
}

/** How many leading (or trailing) characters of the pattern this address already has. */
function affinityOf(address: string, pattern: string, position: VanityPosition): number {
  let count = 0;
  while (count < pattern.length) {
    const wanted = pattern[count];
    const got =
      position === "prefix" ? address[count] : address[address.length - pattern.length + count];
    if (wanted === undefined || got !== wanted) break;
    count += 1;
  }
  return count;
}

/** How many candidates a pattern of this length plausibly needs. */
export function expectedAttemptsFor(patternLength: number): number {
  // Stellar strkeys are base32, so each fixed character is one factor of 32.
  return 32 ** patternLength;
}

export function formatExpectedAttempts(patternLength: number): string {
  const expected = expectedAttemptsFor(patternLength);
  if (expected >= 1_000_000) return `about ${Math.round(expected / 1_000_000)}M tries`;
  if (expected >= 1_000) return `about ${Math.round(expected / 1_000)}k tries`;
  return `about ${expected} tries`;
}

/** The slice of an `rpc.Server` this probe needs, so tests can fake it. */
export interface InstanceReader {
  getContractInstance(contractId: string): Promise<unknown>;
}

/**
 * Has something already been deployed at this address?
 *
 * A salt can only collide with a contract that exists, and the address is
 * deterministic — so an operator who reuses a salt from a previous deployment
 * gets an error at signing time. Asking the chain before they sign turns that
 * into a warning while they are still choosing.
 */
export async function contractAlreadyDeployed(
  server: InstanceReader,
  address: string,
): Promise<{ exists: boolean; detail: string | null }> {
  const trimmed = address.trim();
  if (!isContractAddress(trimmed)) {
    return { exists: false, detail: `${trimmed} is not a contract address yet` };
  }
  try {
    await server.getContractInstance(trimmed);
    return { exists: true, detail: "a contract already lives at this address" };
  } catch {
    // Soroban RPC answers 404 for an unknown contract; either way the address is free.
    return { exists: false, detail: null };
  }
}

/** A `C…` contract address, decoded and length-checked. */
export function isContractAddress(value: string): boolean {
  try {
    return StrKey.isValidContract(value.trim());
  } catch {
    return false;
  }
}
