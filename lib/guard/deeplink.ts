/**
 * Carrying "which guard am I looking at" across the console → configure hop.
 *
 * Both pages mount their own `GuardProvider`, so a plain `/configure` link lands
 * the operator on a freshly-mounted provider that falls back to the first known
 * instance — silently showing them a *different account's* state. The guard
 * address therefore rides in the query string, and the provider on the other
 * side adopts it.
 *
 * The network needs no threading: `NETWORK` is a build-time constant (one
 * passphrase, one RPC endpoint) and the connected wallet is checked against it
 * on every connect, so there is no second network for a link to disagree with.
 *
 * Validation is strict: a link with a malformed, ambiguous, or conflicting
 * `guard` parameter is rejected with a clear outcome — never silently adopted.
 */

import { looksLikeContractAddress } from "./instance.ts";

/** The query parameter that carries the guard address. */
export const GUARD_QUERY_PARAM = "guard";

/** The link the default-deny banner's call to action points at. */
export function configureHref(guard: string): string {
  return `/configure?${GUARD_QUERY_PARAM}=${encodeURIComponent(guard)}`;
}

/**
 * Validation result for a guard parameter from a deep link.
 *
 * A deep link can be:
 * - `valid`: the guard address is well-formed and unambiguous
 * - `malformed`: the parameter is present but not a valid contract address
 * - `ambiguous`: multiple `guard` parameters with different values
 * - `conflicting`: a `guard` parameter that differs from the current selection
 * - `absent`: no `guard` parameter present
 */
export type GuardParamValidation =
  | { status: "valid"; guard: string }
  | { status: "malformed"; raw: string; reason: string }
  | { status: "ambiguous"; values: string[] }
  | { status: "conflicting"; requested: string; current: string }
  | { status: "absent" };

/**
 * Validate the `guard` query parameter from a search string.
 *
 * Unlike `guardFromSearch`, this function distinguishes *why* a parameter
 * was rejected so the UI can surface a clear message instead of silently
 * dropping it.
 */
export function validateGuardParam(search: string, currentGuard?: string): GuardParamValidation {
  const params = new URLSearchParams(search);
  const allGuards = params
    .getAll(GUARD_QUERY_PARAM)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);

  if (allGuards.length === 0) return { status: "absent" };
  if (allGuards.length > 1) {
    const unique = [...new Set(allGuards)];
    if (unique.length > 1) return { status: "ambiguous", values: unique };
  }

  const requested = allGuards[0];
  if (!requested) return { status: "absent" };
  if (!looksLikeContractAddress(requested)) {
    return {
      status: "malformed",
      raw: requested,
      reason:
        requested.length < 56
          ? "contract address too short"
          : requested.length > 56
            ? "contract address too long"
            : !requested.startsWith("C")
              ? "contract address must start with 'C'"
              : "invalid base32 encoding",
    };
  }

  if (currentGuard && requested !== currentGuard) {
    return { status: "conflicting", requested, current: currentGuard };
  }

  return { status: "valid", guard: requested };
}

/** A guard address carried by a URL, or `null` when there is not a usable one. */
export function guardFromSearch(search: string): string | null {
  const validation = validateGuardParam(search);
  return validation.status === "valid" ? validation.guard : null;
}

export interface GuardDeepLink {
  /** The guard to select. */
  guard: string;
  /**
   * True when the address is not in the instance registry, so the provider has
   * to add it — otherwise the selector would hold a value no option matches and
   * the page would render a guard the operator cannot see the name of.
   */
  addToRegistry: boolean;
}

/**
 * Which guard a page load should select, and whether the registry needs to grow.
 *
 * `null` means "leave the selection alone": no `?guard=` was present, it was not
 * a contract address, or it is already the current selection.
 */
export function resolveGuardFromSearch(params: {
  search: string;
  registry: readonly { guard: string }[];
  current: string;
}): GuardDeepLink | null {
  // Validation here deliberately ignores the current selection: a link that
  // names a different guard is the whole point of the hop (the configure page
  // mounts its own provider, which falls back to the first known instance).
  // A *conflict* would reject exactly the links this function exists to adopt.
  // Callers that need a reason for a rejected parameter can use
  // `validateGuardParam` directly.
  const validation = validateGuardParam(params.search);
  if (validation.status !== "valid") return null;
  if (validation.guard === params.current) return null;
  return {
    guard: validation.guard,
    addToRegistry: !params.registry.some((instance) => instance.guard === validation.guard),
  };
}
