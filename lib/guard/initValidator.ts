/**
 * Pre-flight validation of the parameters an operator is about to initialize a
 * guard with.
 *
 * A guard deployed with a flawed configuration is worse than one not deployed
 * at all: an admin and agent sharing one key defeats the separation the whole
 * product is built on, a zero dead-man grace means the switch can never trip,
 * and a rolling-window cap below the per-transaction cap silently disables the
 * window. None of those are caught by the contract at `initialize` time — they
 * only surface as a guard that behaves wrongly in production. This module turns
 * each into an explicit check the operator sees *before* the wallet is prompted.
 *
 * It is deliberately framework-free and DOM-free: the rules are the thing worth
 * testing, and the panel is a thin view over them.
 */

import { Address } from "@stellar/stellar-sdk";

/** The operator-facing inputs, as raw strings so a half-filled box is representable. */
export interface InitParameters {
  /** The connected admin account (`G…`). */
  adminAddress: string;
  /** The agent's account address (`G…`), checked for separation of duties. */
  agentAddress: string;
  /** Dead-man-switch grace, in seconds. */
  dmsDurationSecs: string;
  /** Per-transaction spend cap, in whole units (a decimal string, never a float). */
  perTxCap: string;
  /** Rolling-window spend cap, in whole units. */
  windowCap: string;
}

/** A dead-man grace shorter than this can be out-raced by the very delay it guards against. */
export const MIN_DMS_SECONDS = 300n;
const MAX_I128 = (1n << 127n) - 1n;
const MAX_U64 = (1n << 64n) - 1n;

export type CheckId =
  "separation-of-duties" | "dms-duration" | "window-covers-per-tx" | "spend-caps-positive";

export interface InitCheck {
  id: CheckId;
  /** Short, human label shown in the checklist. */
  label: string;
  /** True when the configuration passes this rule. */
  passed: boolean;
  /** A failing check blocks deployment; there are no non-fatal init checks. */
  fatal: boolean;
  /** Why it passed or failed, in the operator's terms. */
  detail: string;
}

export interface InitValidation {
  checks: InitCheck[];
  /** The fatal failures — the ones that must be resolved before deploying. */
  blockers: InitCheck[];
  /** False while any fatal check is failing, so the deploy button stays disabled. */
  canDeploy: boolean;
}

function isStellarAddress(value: string): boolean {
  try {
    Address.fromString(value.trim());
    return true;
  } catch {
    return false;
  }
}

/** Parse a whole non-negative number, or `null` when blank / not an integer. */
function parseAmount(value: string, maximum: bigint): bigint | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return null;
  try {
    const parsed = BigInt(trimmed);
    return parsed <= maximum ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Audit a set of init parameters against every guardrail rule.
 *
 * Every rule is evaluated independently and reported, even once one has failed,
 * so the operator fixes the whole checklist in one pass rather than discovering
 * the next blocker after resolving the current one.
 */
export function validateInitParameters(params: InitParameters): InitValidation {
  const checks: InitCheck[] = [];

  const admin = params.adminAddress.trim();
  const agent = params.agentAddress.trim();
  const adminValid = isStellarAddress(admin);
  const agentValid = isStellarAddress(agent);

  checks.push({
    id: "separation-of-duties",
    label: "Admin and agent are different accounts",
    passed: adminValid && agentValid && admin !== agent,
    fatal: true,
    detail: !adminValid
      ? "The admin wallet address is missing or not a valid Stellar account address."
      : agent === ""
        ? "Enter the agent's account address (G…) to verify separation of duties."
        : !agentValid
          ? `The agent address "${agent}" is not a valid Stellar account address.`
          : admin === agent
            ? "The admin and the agent are the same account — anyone who can administer the policy can also spend under it. Use a distinct agent key."
            : "The admin and the agent are distinct accounts.",
  });

  const dms = parseAmount(params.dmsDurationSecs, MAX_U64);
  const dmsPassed = dms !== null && dms >= MIN_DMS_SECONDS;
  checks.push({
    id: "dms-duration",
    label: "Dead-man grace is at least 300 seconds",
    passed: dmsPassed,
    fatal: true,
    detail:
      dms === null
        ? "Enter the dead-man grace in whole seconds (0 disables it)."
        : dms < MIN_DMS_SECONDS
          ? `A ${dms}s grace is shorter than the 300s minimum; the switch could trip during ordinary ledger or RPC delay. Set at least ${MIN_DMS_SECONDS}s.`
          : `Grace of ${dms}s meets the minimum.`,
  });

  const perTxCap = parseAmount(params.perTxCap, MAX_I128);
  const windowCap = parseAmount(params.windowCap, MAX_I128);

  // The window cap must be at least the per-transaction cap: a smaller window
  // than a single allowed transaction means the window can never be filled by a
  // permitted payment, so it does nothing (or blocks everything once the first
  // legitimate spend lands).
  const windowPassed = perTxCap !== null && windowCap !== null && windowCap >= perTxCap;
  checks.push({
    id: "window-covers-per-tx",
    label: "Rolling-window cap is at least the per-transaction cap",
    passed: windowPassed,
    fatal: true,
    detail:
      perTxCap === null || windowCap === null
        ? "Both a per-transaction cap and a rolling-window cap are required."
        : windowCap < perTxCap
          ? `A window cap of ${windowCap} is below the per-transaction cap of ${perTxCap}: one allowed payment would exhaust the window. Raise the window cap to at least the per-transaction cap.`
          : `The window cap (${windowCap}) covers at least one full per-transaction allowance (${perTxCap}).`,
  });

  const capsPositive = perTxCap !== null && perTxCap > 0n && windowCap !== null && windowCap > 0n;
  checks.push({
    id: "spend-caps-positive",
    label: "Initial spend caps are greater than zero",
    passed: capsPositive,
    fatal: true,
    detail: capsPositive
      ? "Both spend caps are positive."
      : "A spend cap of zero leaves the account default-deny — the guard would refuse every payment. Set a positive per-transaction and window cap.",
  });

  const blockers = checks.filter((check) => !check.passed && check.fatal);
  return { checks, blockers, canDeploy: blockers.length === 0 };
}

/** Field-level messages for the initialization inputs, including range errors. */
export function validateInitFormFields(
  params: InitParameters & { agentPubkey: string },
): Record<string, string> {
  const errors: Record<string, string> = {};
  const agent = params.agentAddress.trim();
  if (!isStellarAddress(agent)) {
    errors.agentAddress = "Enter a valid Stellar account address.";
  } else if (agent === params.adminAddress.trim()) {
    errors.agentAddress = "The agent address must differ from the admin wallet.";
  }

  const dms = parseAmount(params.dmsDurationSecs, MAX_U64);
  if (dms === null) {
    errors.dmsDurationSecs = `Enter whole seconds from 300 to ${MAX_U64}.`;
  } else if (dms < MIN_DMS_SECONDS) {
    errors.dmsDurationSecs = `Set the dead-man grace to at least ${MIN_DMS_SECONDS} seconds.`;
  }

  const perTx = parseAmount(params.perTxCap, MAX_I128);
  const window = parseAmount(params.windowCap, MAX_I128);
  if (perTx === null || perTx <= 0n) {
    errors.perTxCap = `Enter a positive whole-number cap no greater than ${MAX_I128}.`;
  }
  if (window === null || window <= 0n) {
    errors.windowCap = `Enter a positive whole-number cap no greater than ${MAX_I128}.`;
  } else if (perTx !== null && window < perTx) {
    errors.windowCap = `The rolling-window cap must be at least the per-transaction cap (${perTx}).`;
  }

  if (!/^[0-9a-fA-F]{64}$/.test(params.agentPubkey.trim())) {
    errors.agentPubkey = "Enter exactly 64 hexadecimal characters (32 bytes).";
  }
  return errors;
}
