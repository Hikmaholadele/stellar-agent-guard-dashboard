"use client";

/**
 * Observer mode: what the console does with no wallet (issue #101).
 *
 * An auditor checking a client's spend caps, a teammate reviewing a policy, a
 * security analyst watching for a block — none of them should have to connect
 * an admin wallet to read the chain, and none of them should be able to sign
 * anything by accident. The distinction is already honoured in the code: every
 * read goes through `readGuardSnapshot(server, guard, source)`, where the
 * source account is only the *payer* of a read-only simulation, and every write
 * funnels through `signer()`, which throws without a wallet.
 *
 * What was missing is that the interface never *said* so. Write buttons went
 * inert with no explanation, which reads to a first-time visitor as "this tool
 * is broken" rather than "you are looking, not operating". So this module owns
 * one vocabulary — `observer`, `WRITE_DISABLED_HINT`, the per-control state —
 * and every write control in the console renders from it, so the wording cannot
 * drift between the policy form, the panic button and the deploy panel.
 *
 * Pure and React-free for the usual reason: the rules are the part worth
 * testing, and a test must be able to assert that a null wallet still produces
 * a readable source account without mounting a component.
 */

import { READ_SOURCE_FALLBACK } from "./network.ts";

/** The badge text an unconnected session is labelled with. */
export const OBSERVER_BADGE_LABEL = "Observer mode";

/**
 * The one explanation every disabled write control gives.
 *
 * Wording fixed by the issue's acceptance criteria; keeping it a constant is
 * what stops three panels from inventing three variants of the same sentence.
 */
export const WRITE_DISABLED_HINT = "Connect admin wallet to perform this action";

export interface ObserverWalletState {
  /** Anything with an address is a connected session; `null` is observation. */
  address?: string | null;
  networkPassphrase?: string | null;
}

/** Is this session read-only because no wallet is connected? */
export function isObserverSession(wallet: ObserverWalletState | null | undefined): boolean {
  return !wallet || typeof wallet.address !== "string" || wallet.address.length === 0;
}

/** The header badge, or null when a wallet is connected and the session is not observing. */
export function observerBadge(wallet: ObserverWalletState | null | undefined): string | null {
  return isObserverSession(wallet) ? OBSERVER_BADGE_LABEL : null;
}

export interface WriteControlState {
  disabled: boolean;
  /** Rendered as `title`; the sentence that explains an inert button. */
  title: string;
  /** null when the control is usable, so a caller can skip rendering a hint. */
  reason: string | null;
}

/**
 * Whether a write control is live, and what to say if it is not.
 *
 * `busy` and `extraDisabled` fold in here rather than at the call site because
 * the tooltip has to be accurate while a transaction is in flight: a control
 * disabled mid-submit that still says "connect a wallet" is a lie, and an
 * operator who believes the lie may disconnect mid-write.
 */
export function writeControlState(
  wallet: ObserverWalletState | null | undefined,
  options: {
    busy?: boolean;
    extraDisabled?: boolean;
    label?: string;
    /**
     * The live read this write depends on could not complete (offline, or the
     * RPC read failed). The sentence is shown as the reason, so the control
     * explains itself rather than merely being inert (issue #348).
     */
    preflightUnavailable?: string | null;
  } = {},
): WriteControlState {
  const label = options.label ?? "this action";
  if (isObserverSession(wallet)) {
    return { disabled: true, title: WRITE_DISABLED_HINT, reason: WRITE_DISABLED_HINT };
  }
  if (options.busy) {
    return { disabled: true, title: `${capitalize(label)} is already in progress.`, reason: null };
  }
  if (options.preflightUnavailable) {
    return {
      disabled: true,
      title: options.preflightUnavailable,
      reason: options.preflightUnavailable,
    };
  }
  if (options.extraDisabled) {
    return { disabled: true, title: "This action is unavailable right now.", reason: null };
  }
  return { disabled: false, title: `Signs and submits in your connected wallet.`, reason: null };
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * The source account a read should be attributed to.
 *
 * This is the line the issue's acceptance criteria turn on: reads must keep
 * working with `wallet === null`. A read-only simulation needs *some* account to
 * supply a sequence number, and the chosen value cannot change the result — so
 * an observer session falls back to a known testnet account, and a connected
 * session keeps reading as itself. Returning `undefined` here would hand the
 * problem to the SDK's error path and make the console look broken.
 */
export function readSourceFor(wallet: ObserverWalletState | null | undefined): string {
  return isObserverSession(wallet) ? READ_SOURCE_FALLBACK : (wallet?.address as string);
}

/** Whether a wallet may sign right now — `false` for an observer, with the reason. */
export function signingAllowed(wallet: ObserverWalletState | null | undefined): {
  allowed: boolean;
  reason: string | null;
} {
  if (isObserverSession(wallet)) {
    return { allowed: false, reason: `${WRITE_DISABLED_HINT.toLowerCase()}.` };
  }
  return { allowed: true, reason: null };
}

/** What an observer can still do, for the panel's own explanation. */
export const OBSERVER_CAPABILITIES: readonly string[] = [
  "Read guard status, policy, window state and WASM identity from the chain",
  "Watch the live telemetry feed and read every event's decision",
  "Review transaction history and export a printable compliance report",
];

/** What an observer cannot do, each naming the missing thing rather than a blame. */
export const OBSERVER_RESTRICTIONS: readonly string[] = [
  "Install, revoke or adjust a policy",
  "Freeze or unfreeze the guarded account",
  "Deploy a guard instance or rotate an agent key",
];

/**
 * The write actions an observer is refused, with the wallet-side reason.
 *
 * Pairing each restriction with the same hint the buttons carry means the
 * header notice and the disabled control can never disagree about why the
 * button is grey.
 */
export function observerRestrictions(
  wallet: ObserverWalletState | null | undefined,
): ReadonlyArray<{ action: string; reason: string }> {
  if (!isObserverSession(wallet)) return [];
  return OBSERVER_RESTRICTIONS.map((action) => ({ action, reason: WRITE_DISABLED_HINT }));
}
