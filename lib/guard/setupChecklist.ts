/**
 * The post-deploy checklist, derived from the chain rather than remembered.
 *
 * The wizard's whole design constraint is that a step's state is a *function of
 * live reads* — `deployedMarker`, `isInitialized()`, `status()` and `policy()` —
 * so there is no stored "step 3 complete" boolean that can outlive the truth it
 * claims. A wizard that lies about having completed is worse than no wizard,
 * because it turns "I think this is configured" into an operator's false
 * confidence.
 *
 * The one thing that *is* stored is the operator's own interface state, and it is
 * deliberately exactly two keys:
 *
 *   - `dismissed` — hide the checklist (see the non-concealment invariant: the
 *     `StatusPanel`'s default-deny warning is derived from `status()`, so
 *     dismissing this wizard cannot hide it);
 *   - `deployedMarker` — the address predicted at deploy time, which is the only
 *     fact about a deploy the chain cannot re-derive for a browser that has not
 *     adopted the instance yet.
 *
 * `SETUP_STORED_KEYS` is asserted in tests against the raw persisted JSON, so a
 * future edit that starts persisting a completion bit fails the audit rather
 * than shipping.
 */

import type { GuardStatus, PolicyConfig } from "stellar-agent-guard-sdk";
import type { ReadResult } from "./chain.ts";

export type SetupStepId = "deployed" | "initialized" | "policy" | "verified";
export type SetupStepState = "done" | "pending" | "error";

export interface SetupStep {
  id: SetupStepId;
  /** Short name, rendered as the step's heading. */
  label: string;
  state: SetupStepState;
  /** The live fact that produced this state, shown next to it. */
  detail: string;
}

/** The step labels, in order. */
export const SETUP_STEPS: ReadonlyArray<{ id: SetupStepId; label: string }> = [
  { id: "deployed", label: "Deployed" },
  { id: "initialized", label: "Initialized (admin + agent keys)" },
  { id: "policy", label: "Policy installed" },
  { id: "verified", label: "Verified (status + policy re-read)" },
];

export interface SetupInputs {
  /** Address predicted at deploy time, or null when nothing was deployed here. */
  deployedMarker: string | null;
  /** Live `isInitialized` read (contract storage says `initialize` has run). */
  initialized: ReadResult<boolean>;
  /** Live `status()` read. */
  status: ReadResult<GuardStatus>;
  /** Live `policy()` read. */
  policy: ReadResult<PolicyConfig | null>;
  /**
   * Result of the last explicit live re-read for the verify step. `null` before
   * the operator has asked for one — and null is *pending*, never done, because
   * an unverified step cannot be green.
   */
  verified: ReadResult<{ hasPolicy: boolean }> | null;
}

/**
 * Derive the four steps from live truth. Pure: same inputs, same steps, and no
 * storage is read or written. The derived-state proof is exactly this: changing
 * a live read changes the steps, with nothing written locally.
 */
export function deriveSetupSteps(inputs: SetupInputs): SetupStep[] {
  return [
    deriveDeployed(inputs.deployedMarker),
    deriveInitialized(inputs.initialized),
    derivePolicy(inputs.status, inputs.policy),
    deriveVerified(inputs.verified),
  ];
}

function deriveDeployed(marker: string | null): SetupStep {
  return {
    id: "deployed",
    label: SETUP_STEPS[0]!.label,
    state: marker ? "done" : "pending",
    detail: marker
      ? `Contract address predicted at deploy time: ${marker}`
      : "No deploy recorded in this browser. Deploy a guard on the Configure screen to begin.",
  };
}

function deriveInitialized(initialized: ReadResult<boolean>): SetupStep {
  if (!initialized.ok) {
    return {
      id: "initialized",
      label: SETUP_STEPS[1]!.label,
      state: "error",
      detail: `initialize state could not be read: ${initialized.error}`,
    };
  }
  return {
    id: "initialized",
    label: SETUP_STEPS[1]!.label,
    state: initialized.value ? "done" : "pending",
    detail: initialized.value
      ? "Admin and agent keys are registered on the account"
      : "initialize(admin, agent) has not run — the account cannot authorize the agent yet",
  };
}

function derivePolicy(
  status: ReadResult<GuardStatus>,
  policy: ReadResult<PolicyConfig | null>,
): SetupStep {
  if (status.ok) {
    const hasPolicy = status.value.has_policy;
    return {
      id: "policy",
      label: SETUP_STEPS[2]!.label,
      state: hasPolicy ? "done" : "pending",
      detail: hasPolicy
        ? "status() reports a policy in force"
        : "status() reports no policy — the account is in default-deny and refuses every call",
    };
  }
  if (policy.ok) {
    const hasPolicy = policy.value !== null;
    return {
      id: "policy",
      label: SETUP_STEPS[2]!.label,
      state: hasPolicy ? "done" : "pending",
      detail: hasPolicy
        ? "policy() returned a policy, though status() could not be read"
        : "policy() returned none — the account is in default-deny",
    };
  }
  return {
    id: "policy",
    label: SETUP_STEPS[2]!.label,
    state: "error",
    detail: `status() and policy() could not be read: ${status.error}`,
  };
}

function deriveVerified(verified: ReadResult<{ hasPolicy: boolean }> | null): SetupStep {
  if (verified === null) {
    return {
      id: "verified",
      label: SETUP_STEPS[3]!.label,
      state: "pending",
      detail:
        "Re-verify to read status() and policy() back from the chain — nothing is assumed until then",
    };
  }
  if (!verified.ok) {
    return {
      id: "verified",
      label: SETUP_STEPS[3]!.label,
      state: "error",
      detail: `The live re-read failed: ${verified.error}. Still pending — the read-only retry re-reads the chain (it never repeats a write); only a confirmed read turns this green.`,
    };
  }
  return {
    id: "verified",
    label: SETUP_STEPS[3]!.label,
    state: verified.value.hasPolicy ? "done" : "pending",
    detail: verified.value.hasPolicy
      ? "status() reports a policy in force, confirmed by a live re-read"
      : "status() still reports no policy — install one and re-verify",
  };
}

/**
 * The default-deny warning, derived from the chain alone.
 *
 * True only when the chain answered *and* reported no policy. An unreadable
 * status is not treated as safe: it is rendered as its own read error elsewhere,
 * so this never silently returns `false` for a failed read dressed up as health.
 */
export function defaultDenyWarning(status: ReadResult<GuardStatus>): boolean {
  return status.ok && !status.value.has_policy;
}

// ── Stored wizard state (exactly two keys) ─────────────────────────────────

export const SETUP_STORAGE_KEY = "stellar-agent-guard-dashboard.setup-wizard.v1";

/**
 * The only keys this feature is allowed to persist. `tests/unit/setupChecklist.test.ts`
 * audits the raw stored JSON against this list.
 */
export const SETUP_STORED_KEYS = ["dismissed", "deployedMarker"] as const;

export type SetupStoredKey = (typeof SETUP_STORED_KEYS)[number];

export interface SetupStoredState {
  dismissed: boolean;
  deployedMarker: string | null;
}

export interface SetupStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): SetupStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Coerce an unknown entry to exactly the two allowed keys. */
function sanitizeEntry(raw: unknown): SetupStoredState {
  const entry = (raw ?? {}) as { dismissed?: unknown; deployedMarker?: unknown };
  const marker =
    typeof entry.deployedMarker === "string" && entry.deployedMarker.length > 0
      ? entry.deployedMarker
      : null;
  return { dismissed: entry.dismissed === true, deployedMarker: marker };
}

function readEnvelope(storage: SetupStorage | null): Record<string, unknown> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(SETUP_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    // A corrupted entry must not stop the checklist from rendering; a wizard
    // that defaults to visible is safer than one that throws.
    return {};
  }
}

/** The stored wizard state for a guard, always shaped as exactly two keys. */
export function readSetupState(
  guard: string,
  storage: SetupStorage | null = defaultStorage(),
): SetupStoredState {
  return sanitizeEntry(readEnvelope(storage)[guard]);
}

/**
 * Merge a patch into a guard's stored state and persist it. Only
 * `SETUP_STORED_KEYS` are ever written, so no completion boolean can sneak in.
 */
export function writeSetupState(
  guard: string,
  patch: Partial<SetupStoredState>,
  storage: SetupStorage | null = defaultStorage(),
): SetupStoredState {
  const current = readSetupState(guard, storage);
  const next = sanitizeEntry({ ...current, ...patch });
  if (!storage) return next;
  try {
    const envelope = readEnvelope(storage);
    envelope[guard] = next;
    storage.setItem(SETUP_STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // Private-mode storage failures are not worth interrupting the operator for.
  }
  return next;
}

/** Hide the checklist for this guard. Does not touch any derived step. */
export function dismissSetupWizard(
  guard: string,
  storage: SetupStorage | null = defaultStorage(),
): SetupStoredState {
  return writeSetupState(guard, { dismissed: true }, storage);
}

/** Show the checklist again. */
export function restoreSetupWizard(
  guard: string,
  storage: SetupStorage | null = defaultStorage(),
): SetupStoredState {
  return writeSetupState(guard, { dismissed: false }, storage);
}

/** Remember the address predicted at deploy time, so step 1 can derive from it. */
export function rememberDeployment(
  guard: string,
  storage: SetupStorage | null = defaultStorage(),
): SetupStoredState {
  return writeSetupState(guard, { deployedMarker: guard }, storage);
}
