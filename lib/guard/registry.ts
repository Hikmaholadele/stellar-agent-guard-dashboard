/**
 * Adding a guard by address, with a live check before it is remembered.
 *
 * A `C…` string is not a guard. Typing an address into the selector and having
 * it stick would let the console claim it is watching an account that does not
 * exist, does not run the guard artifact, or is on a network this build cannot
 * read. The add flow therefore does two things in order, and persists nothing
 * until both pass:
 *
 *   1. Validate the StrKey (a Soroban `C…` contract address).
 *   2. Read the contract's own `status()` — the same read the panels use — and
 *      refuse the add when it traps or the transport fails.
 *
 * An operator-supplied label is additionally screened against the label policy
 * (`inputSanitizer.ts`) before either step, so a deceptive name is refused
 * without touching the network at all.
 *
 * It signs nothing: the add flow never touches a wallet, so there is no
 * `sendTransaction` on this path at all. That is asserted by call-count in
 * `registryLive.test.ts`, not merely intended.
 *
 * The registry itself (the saved list, its network namespacing and the one-time
 * v1 migration) lives in `instance.ts`; this module is the verified front door.
 */

import { StrKey, type rpc } from "@stellar/stellar-sdk";
import { readStatus } from "./chain.ts";
import { validateLabel } from "./inputSanitizer.ts";
import type { RegistryChangeNotice } from "./tabSync.ts";
import {
  defaultGuardLabel,
  looksLikeContractAddress,
  rememberInstance,
  type GuardInstance,
  type StorageLike,
} from "./instance.ts";

/** Why an add was refused: a bad string, or a valid one that did not answer live. */
export type AddGuardKind = "invalid" | "unreachable";

export type LiveCheck = { ok: true } | { ok: false; error: string };

/**
 * A well-formed Soroban contract address: the fast `C…` shape check plus the
 * SDK's StrKey checksum. A string that only matches the regex (a typo'd
 * checksum) is rejected here, before any RPC call, so the operator gets an
 * "invalid" answer instantly rather than an "unreachable" one.
 */
export function isValidGuardAddress(value: string): boolean {
  const candidate = value.trim();
  if (!looksLikeContractAddress(candidate)) return false;
  try {
    return StrKey.isValidContract(candidate);
  } catch {
    return false;
  }
}

/**
 * Confirm an address is a live guard before it is offered.
 *
 * A non-`C…` string is rejected without any RPC call. A valid contract address is
 * read with `status()`; a trap (the contract exists but is not a guard, or has no
 * `status` entrypoint) and a transport failure are both refusals — the console
 * must not remember an address it could not confirm.
 */
export async function verifyGuardIsLive(server: rpc.Server, address: string): Promise<LiveCheck> {
  const candidate = address.trim();
  if (!isValidGuardAddress(candidate)) {
    return {
      ok: false,
      error: "That is not a valid Soroban contract address (a C… StrKey).",
    };
  }
  const result = await readStatus(server, candidate);
  if (!result.ok) {
    return { ok: false, error: `the guard did not answer status(): ${result.error}` };
  }
  const value = result.value as { has_policy?: unknown } | null | undefined;
  if (!value || typeof value.has_policy !== "boolean") {
    return {
      ok: false,
      error: "the contract answered status() but not in the guard's shape (no has_policy flag).",
    };
  }
  return { ok: true };
}

export interface AddGuardParams {
  server: rpc.Server;
  address: string;
  label?: string;
  /** Defaults to this build's network; see `instance.ts`. */
  network?: string;
  /** Injected storage for tests; defaults to `localStorage`. */
  storage?: StorageLike | null;
}

export type AddGuardResult =
  { ok: true; instance: GuardInstance } | { ok: false; kind: AddGuardKind; error: string };

/**
 * Validate and live-verify an address, then save it under the active network.
 *
 * Nothing is written on a failed check: the caller gets an inline error and the
 * saved list is untouched. No signature is requested at any point.
 */
export async function addGuard(params: AddGuardParams): Promise<AddGuardResult> {
  const address = params.address.trim();
  // The label is screened before any RPC call: a name carrying invisible or
  // control characters (issue #384) is refused with the same field-level
  // message the address book shows, and nothing is read or remembered.
  if (params.label !== undefined) {
    const labelCheck = validateLabel(params.label);
    if (!labelCheck.ok) return { ok: false, kind: "invalid", error: labelCheck.error };
  }
  const label = (params.label ?? "").trim() || defaultGuardLabel(address);
  const check = await verifyGuardIsLive(params.server, address);
  if (!check.ok) {
    return {
      ok: false,
      kind: isValidGuardAddress(address) ? "unreachable" : "invalid",
      error: check.error,
    };
  }
  const instances = rememberInstance(address, label, {
    ...(params.network === undefined ? {} : { network: params.network }),
    ...(params.storage === undefined ? {} : { storage: params.storage }),
  });
  const instance = instances.find((candidate) => candidate.guard === address);
  if (!instance) {
    return {
      ok: false,
      kind: "unreachable",
      error: "the guard passed its live check but could not be saved.",
    };
  }
  return { ok: true, instance };
}

// ── Following another tab's registry change ────────────────────────────────

/**
 * The instance list to hold after another tab changed the saved registry.
 *
 * `saved` is the registry as just re-read from storage — the authority. `current`
 * is what this tab was showing. The only thing kept from `current` is the active
 * guard when it is not in `saved` and was not the one just removed: a guard
 * adopted from a link lives only in this tab's list, and dropping it would leave
 * the selector without an option for the guard on screen.
 */
export function registryAfterChange(params: {
  saved: readonly GuardInstance[];
  current: readonly GuardInstance[];
  activeGuard: string;
  notice: Pick<RegistryChangeNotice, "kind" | "guard">;
}): GuardInstance[] {
  const { saved, current, activeGuard, notice } = params;
  const removedActive = notice.kind === "remove" && notice.guard === activeGuard;
  const active = current.find((instance) => instance.guard === activeGuard);
  if (active && !removedActive && !saved.some((instance) => instance.guard === activeGuard)) {
    return [...saved, active];
  }
  return [...saved];
}

/**
 * The guard to move to when another tab deleted the one this tab is showing, or
 * `null` when no move is needed (a different guard changed, the guard is still
 * saved — a build-seeded guard cannot be deleted — or the change was not a
 * removal). The choice matches a local delete: the first remaining guard.
 */
export function fallbackAfterRemoval(params: {
  saved: readonly GuardInstance[];
  activeGuard: string;
  notice: Pick<RegistryChangeNotice, "kind" | "guard">;
  defaultGuard: string;
}): string | null {
  const { saved, activeGuard, notice, defaultGuard } = params;
  if (notice.kind !== "remove" || notice.guard !== activeGuard) return null;
  if (saved.some((instance) => instance.guard === activeGuard)) return null;
  return saved[0]?.guard ?? defaultGuard;
}
