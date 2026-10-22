"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useFormValidation } from "../lib/guard/useFormValidation.ts";
import type { PolicyDraft } from "../lib/guard/policyForm.ts";
import {
  EMPTY_DRAFT,
  buildPolicyConfig,
  describeDraft,
  draftFromConfig,
  policyDraftsEqual,
  validatePolicyDraftFields,
} from "../lib/guard/policyForm.ts";
import { useUnsavedChangesWarning } from "../lib/guard/useUnsavedChangesWarning.ts";
import {
  POLICY_PRESETS,
  SECURITY_PROFILES,
  draftFromPreset,
  policyPresetById,
  type PolicyPreset,
  type SecurityProfile,
} from "../lib/guard/presets.ts";
import { installPolicy, revokePolicy } from "../lib/guard/guardOps.ts";
import { historyShortcut, useHistoryState } from "../lib/guard/useHistoryState.ts";
import { usePwaActivity } from "../lib/guard/usePwaActivity.ts";
import { computePolicyDiff, type PolicyDiff } from "../lib/guard/policyDiff.ts";
import { PolicyDiffModal } from "./PolicyDiffModal.tsx";
import type { InvokeResult } from "../lib/guard/submit.ts";
import {
  policyConfirmed,
  policyFailed,
  writeFailureReason,
  type PolicyOperation,
} from "../lib/guard/announceCopy.ts";
import { announce } from "../lib/guard/useAnnounce.ts";
import { noteVerifiedOutcome } from "../lib/guard/statusTransitions.ts";
import { refusedEventsFromDiagnostics } from "../lib/guard/telemetry.ts";
import { NO_POLICY_CONSEQUENCE, policyStateFrom } from "../lib/guard/policyState.ts";
import {
  exportAssetCapsCsv,
  exportAssetCapsJson,
  mergeAssetCapOverrides,
  parseAssetCapsCsv,
  parseAssetCapsJson,
  type AssetCapChange,
} from "../lib/guard/assetCapsCsv.ts";
import { useGuard } from "./GuardProvider.tsx";
import { ErrorBlock, ScopeNotice, WarningBanner, short, starLink } from "./bits.tsx";
import { ProtocolFunctionSelector } from "./ProtocolFunctionSelector.tsx";
import { CsvImportExport } from "./CsvImportExport.tsx";
import { PolicySimulationView } from "./PolicySimulationView.tsx";
import { fetchTokenMetadata } from "../lib/guard/tokenMetadata.ts";
import { writeControlState } from "../lib/guard/observerMode.ts";
import {
  bindToScope,
  guardScope,
  runScopedWrite,
  sameGuardScope,
  valueInScope,
  type GuardScope,
  type ScopeBound,
} from "../lib/guard/guardScoped.ts";
import { useToast } from "../lib/guard/useToast.ts";
import { exportPolicyDraft, importPolicyFromJson } from "../lib/guard/policySchema.ts";

/**
 * The no-code configurator.
 *
 * The form is validated locally before a wallet is ever prompted, and the policy
 * is encoded by the SDK's `policyToScVal` rather than by a hand-rolled encoder —
 * the host converts the map into a typed struct by walking entries in a required
 * order, so a second encoder would be a second place to get the field order wrong.
 */
type PolicyOutcome =
  { kind: "invalid"; issues: string[] } | { kind: "invoked"; result: InvokeResult };

/**
 * What an operator approved: the draft as it stood, and the diff they were shown
 * (none for an export, which writes nothing). It is bound to the guard it was
 * produced for, so it can only ever be spent on that guard.
 */
type PolicyApproval = ScopeBound<{ draft: PolicyDraft; diff: PolicyDiff | null }>;

/** Speak a policy write's outcome, with the reason when it did not land. */
function speakPolicy(operation: PolicyOperation, reason: string, guard?: string): void {
  const spoken = policyFailed(operation, reason, guard);
  announce(spoken.message, spoken.priority);
}

/**
 * The announcement for a finished policy write.
 *
 * A draft that never passed local validation is not a failed write — nothing was
 * signed and nothing can have changed — so it is announced as what it is, the
 * issues, instead of as a chain error the operator would read as a failed
 * transaction. `exportOnly` is likewise not a failure but not a change either:
 * the XDR is in the operator's hands and the account's policy is exactly as it
 * was, so that is what is said.
 */
function speakPolicyOutcome(
  operation: PolicyOperation,
  outcome: PolicyOutcome,
  exportOnly: boolean,
  guard?: string,
): void {
  if (outcome.kind === "invalid") {
    speakPolicy(
      operation,
      `the policy was not valid, so nothing was sent: ${outcome.issues.join("; ")}`,
      guard,
    );
    return;
  }
  if (outcome.result.kind === "submitted") {
    const spoken = policyConfirmed(operation, guard);
    announce(spoken.message, spoken.priority);
    // The write landed, so the next poll should not repeat it. Recorded here
    // because this is the only place that knows what the operator just did;
    // a policy that appears or vanishes from anywhere else is still announced.
    noteVerifiedOutcome({ hasPolicy: operation === "set_policy" });
    return;
  }
  speakPolicy(
    operation,
    writeFailureReason(
      outcome.result,
      exportOnly
        ? "the transaction was only exported, so nothing was submitted"
        : "the write did not complete",
    ),
    guard,
  );
}

export function PolicyForm() {
  const { signer, guard, server, refresh, snapshot, pushEvents, wallet, notifyTabs } = useGuard();
  // `null` means "not edited yet", which is what lets the form seed itself from
  // the installed policy without an effect: the seed is derived during render and
  // the operator's first keystroke takes over from it.
  const {
    state: draft,
    push: pushDraft,
    edit: editDraftRaw,
    undo,
    redo,
    canUndo,
    canRedo,
  } = useHistoryState<PolicyDraft | null>(null);
  const [busy, setBusy] = useState(false);
  // Unsaved work a service-worker update must not discard (#398): an edited
  // policy draft, and the write itself while the wallet is approving it.
  usePwaActivity(draft !== null, "draft");
  usePwaActivity(busy, "write");
  const [outcome, setOutcome] = useState<PolicyOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The approval behind the open diff dialog, bound to the guard it was computed
  // for. A stale one is unreachable (see `approval` below), and is cleared outright
  // when the active guard changes.
  const [pendingApproval, setPendingApproval] = useState<PolicyApproval | null>(null);
  const [assetCapChanges, setAssetCapChanges] = useState<Record<string, AssetCapChange>>({});
  // A preset is applied in two steps: choosing one stages it here, and the
  // confirmation dialog applies it. The draft is never replaced by a stray
  // change event on the select.
  const [pendingPreset, setPendingPreset] = useState<PolicyPreset | null>(null);
  // ── Which guard everything on this form belongs to ──────────────────────
  // The active guard is shared application context: the operator, another tab or
  // a link can change it while a draft, an approval or a write is still live.
  // The scope is read through a ref wherever it must reflect "now" — inside an
  // async write — and through render values everywhere else.
  const activeScope = guardScope(guard);
  const guardRef = useRef(guard);
  useEffect(() => {
    guardRef.current = guard;
  }, [guard]);
  const nowScope = () => guardScope(guardRef.current);
  // The guard (and network) the unsaved draft was started for.
  const [draftScope, setDraftScope] = useState<GuardScope | null>(null);
  // An unsaved draft that belongs to a different guard than the one now selected.
  // It is held, not applied and not dropped: the operator discards it explicitly
  // or switches back to it.
  const draftForOtherGuard =
    draft !== null && draftScope !== null && !sameGuardScope(draftScope, activeScope);
  const [seenScope, setSeenScope] = useState<GuardScope>(activeScope);
  if (!sameGuardScope(seenScope, activeScope)) {
    // The guard changed. Everything that was produced for the previous one — the
    // open approval, its outcome and error, a staged preset — is invalidated
    // here, during the render that first sees the new guard, so none of it is ever
    // shown (or confirmable) against the new one, even if the operator switches back.
    setSeenScope(activeScope);
    setPendingApproval(null);
    setOutcome(null);
    setError(null);
    setPendingPreset(null);
    setAssetCapChanges({});
  }
  const approval = valueInScope(pendingApproval, activeScope);

  /** Replace the draft. Refused while the draft belongs to another guard. */
  function setDraft(next: PolicyDraft | null) {
    if (draftForOtherGuard) return;
    pushDraft(next);
    setDraftScope(next === null ? null : activeScope);
  }

  /** Coalesced text edit. Refused while the draft belongs to another guard. */
  function editDraft(next: PolicyDraft) {
    if (draftForOtherGuard) return;
    editDraftRaw(next);
    setDraftScope(activeScope);
  }

  /** The explicit discard: the only way an edit for another guard is dropped. */
  function discardOtherGuardDraft() {
    pushDraft(null);
    setDraftScope(null);
    setAssetCapChanges({});
  }

  const csvInput = useRef<HTMLInputElement>(null);
  const jsonInput = useRef<HTMLInputElement>(null);
  const policyJsonInput = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const presetSelect = useRef<HTMLSelectElement>(null);
  const presetDialog = useRef<HTMLDivElement>(null);

  const confirmingPreset = pendingPreset !== null;

  // Same focus discipline as the freeze dialog: move focus into the modal, keep
  // Tab inside it, close on Escape, and return focus to the select afterwards.
  useEffect(() => {
    if (!confirmingPreset) return;
    const dialog = presetDialog.current;
    if (!dialog) return;

    const focusables = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      );

    dialog.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setPendingPreset(null);
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      const inside = active !== null && dialog.contains(active);
      if (event.shiftKey && (active === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberate late ref read, see PanicPanel
      presetSelect.current?.focus();
    };
  }, [confirmingPreset]);

  function applyPreset(preset: PolicyPreset) {
    setDraft(draftFromPreset(preset));
    setAssetCapChanges({});
    setOutcome(null);
    setError(null);
    setPendingPreset(null);
  }

  // Editing starts from the policy that is actually installed, not from an empty
  // form that looks like a reset. With nothing installed yet, it starts empty.
  const installedDraft =
    snapshot?.policy.ok && snapshot.policy.value !== null
      ? draftFromConfig(snapshot.policy.value)
      : EMPTY_DRAFT;
  // A draft for another guard is never shown as this guard's form: the form falls
  // back to what is actually installed here.
  const effective = draft !== null && !draftForOtherGuard ? draft : installedDraft;

  const validation = buildPolicyConfig(effective);
  const issues = validation.ok ? [] : validation.issues;
  const fieldErrors = useFormValidation(effective, validatePolicyDraftFields);
  // A draft that has been typed back to exactly what is installed loses
  // nothing on navigation, so it is not unsaved work. Held drafts for another
  // guard always are: they are not shown here and would not be re-created.
  const isDirty = draft !== null && !policyDraftsEqual(draft, installedDraft);
  useUnsavedChangesWarning(isDirty);

  // Nothing installed is default-deny, not a blank slate: the form is where that
  // state gets named before the operator is asked to fill anything in.
  const policyState = policyStateFrom(snapshot?.status);

  // Every write here is inert for the same reason, in the same words as every
  // other write control in the console (issue #101).
  const installControl = writeControlState(wallet, {
    busy,
    extraDisabled: issues.length > 0 || draftForOtherGuard,
    label: "install the policy",
  });
  const exportControl = writeControlState(wallet, {
    busy,
    extraDisabled: issues.length > 0 || draftForOtherGuard,
    label: "export the policy",
  });
  const revokeControl = writeControlState(wallet, { busy, label: "revoke the policy" });
  // Revoking a policy that is not installed spends a signature and changes
  // nothing, so the button is inert in exactly the state the banner warns about.
  // The observer and in-flight reasons still win — "connect a wallet" is the
  // more actionable sentence, and it is the one that stays true.
  const nothingInstalled = policyState === "default-deny";
  const revokeDisabled = revokeControl.disabled || nothingInstalled;
  const revokeTitle =
    !revokeControl.disabled && nothingInstalled
      ? "No policy is installed, so there is nothing to revoke."
      : revokeControl.title;

  // Text edits are coalesced into one history step (see useHistoryState); every
  // other change (toggles, row removal, clear, import) is a step of its own.
  function set<K extends keyof PolicyDraft>(
    key: K,
    value: PolicyDraft[K],
    mode: "commit" | "text" = "commit",
  ) {
    const next = { ...effective, [key]: value };
    if (mode === "text") editDraft(next);
    else setDraft(next);
  }

  function updateAssetCaps(next: PolicyDraft["assetCaps"], mode: "commit" | "text" = "commit") {
    set("assetCaps", next, mode);
  }

  async function importAssetCaps(file: File, format: "csv" | "json") {
    try {
      const imported =
        format === "csv"
          ? parseAssetCapsCsv(await file.text())
          : parseAssetCapsJson(await file.text());
      const merged = mergeAssetCapOverrides(effective.assetCaps, imported);
      updateAssetCaps(merged.rows);
      setAssetCapChanges((current) => ({ ...current, ...merged.changes }));
      setError(null);
    } catch (caught) {
      setError(
        `Asset-cap import failed: ${caught instanceof Error ? caught.message : String(caught)}`,
      );
    }
  }

  function downloadAssetCaps(filename: string, content: string) {
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function exportPolicyJson() {
    const result = exportPolicyDraft(effective);
    if (!result.ok) {
      setError(`Policy export failed: ${result.issues.map((issue) => issue.message).join("; ")}`);
      return;
    }
    downloadAssetCaps(result.filename, result.json);
    toast.success("Policy exported", result.filename);
  }

  async function importPolicyJson(file: File) {
    try {
      const source = await file.text();
      const result = importPolicyFromJson(source);
      if (!result.ok) {
        const detail = result.issues
          .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
          .join("; ");
        setError(`Policy import failed: ${detail}`);
        toast.error("Policy import failed", { message: detail });
        return;
      }
      setDraft(result.draft);
      setAssetCapChanges({});
      setError(null);
      toast.success("Policy imported", "Loaded into the form below -- review before signing.");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(`Policy import failed: ${message}`);
      toast.error("Policy import failed", { message });
    }
  }

  /**
   * A signed `set_policy` is what the guard enforces from then on, so an install
   * stops here to show the operator the diff first. Exporting XDR writes nothing
   * and needs no confirmation.
   */
  async function submit(exportOnly = false) {
    if (draftForOtherGuard) return;
    if (!exportOnly) {
      if (!validation.ok) return;
      const installed =
        snapshot?.policy.ok && snapshot.policy.value !== null ? snapshot.policy.value : null;
      // The approval carries the draft it was shown for and the guard it is for.
      setPendingApproval(
        bindToScope(activeScope, {
          draft: effective,
          diff: computePolicyDiff(installed, validation.config),
        }),
      );
      return;
    }
    await runInstall(true, bindToScope(activeScope, { draft: effective, diff: null }));
  }

  /**
   * Spend an approval. The write is built for the guard the approval was made for,
   * never for whichever guard is selected by the time this runs, and it does not
   * start at all if that guard is no longer the active one.
   */
  async function runInstall(exportOnly: boolean, approved: PolicyApproval | null) {
    setPendingApproval(null);
    if (!approved) return;
    setBusy(true);
    setError(null);
    setOutcome(null);
    const approvedGuard = approved.scope.guard;
    try {
      const run = await runScopedWrite({
        approval: approved.scope,
        activeScope: nowScope,
        write: (target) =>
          installPolicy({
            server,
            signer: signer(),
            guard: target,
            draft: approved.value.draft,
            exportOnly,
          }),
      });
      if (run.kind === "stale") {
        // The guard changed before anything was built: no transaction exists.
        const reason = "the active guard changed, so nothing was signed or submitted";
        setError(`The policy was not written: ${reason}. Review it again for this guard.`);
        speakPolicy("set_policy", reason, approvedGuard);
        return;
      }
      const result = run.result;
      if (run.stillActive) setOutcome(result);
      if (result.kind === "invoked" && result.result.kind === "refused") {
        pushEvents(refusedEventsFromDiagnostics(result.result.diagnosticEvents, approvedGuard));
      }
      // Announce only a write that reached the chain; a refused call changed
      // nothing, so there is nothing for the other tabs to re-read. The event
      // names the guard that was written, not the one now on screen.
      if (result.kind === "invoked" && result.result.kind === "submitted") {
        notifyTabs("POLICY_UPDATED", {
          guard: approvedGuard,
          payload: { operation: "set_policy" },
        });
      }
      speakPolicyOutcome("set_policy", result, exportOnly, approvedGuard);
      if (!exportOnly && run.stillActive) {
        await refresh();
      }
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : String(caught);
      // A failure belongs to the guard that was written; show it only there.
      if (sameGuardScope(approved.scope, nowScope())) setError(detail);
      speakPolicy("set_policy", detail, approvedGuard);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(exportOnly = false) {
    // A revoke is a single click on the guard in front of the operator, so the
    // approval is that guard, taken now.
    const approved = activeScope;
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const run = await runScopedWrite({
        approval: approved,
        activeScope: nowScope,
        write: (target) => revokePolicy({ server, signer: signer(), guard: target, exportOnly }),
      });
      if (run.kind === "stale") {
        const reason = "the active guard changed, so nothing was signed or submitted";
        setError(`The policy was not revoked: ${reason}.`);
        speakPolicy("revoke_policy", reason, approved.guard);
        return;
      }
      const result = run.result;
      if (run.stillActive) setOutcome({ kind: "invoked", result });
      if (result.kind === "submitted") {
        notifyTabs("POLICY_UPDATED", {
          guard: approved.guard,
          payload: { operation: "revoke_policy" },
        });
      }
      speakPolicyOutcome("revoke_policy", { kind: "invoked", result }, exportOnly, approved.guard);
      if (!exportOnly && run.stillActive) {
        await refresh();
      }
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : String(caught);
      if (sameGuardScope(approved, nowScope())) setError(detail);
      speakPolicy("revoke_policy", detail, approved.guard);
    } finally {
      setBusy(false);
    }
  }

  function undoEdit() {
    if (busy || !canUndo || draftForOtherGuard) return;
    undo();
    setAssetCapChanges({});
  }

  function redoEdit() {
    if (busy || !canRedo || draftForOtherGuard) return;
    redo();
    setAssetCapChanges({});
  }

  // Attached to the form container, so the shortcuts only act while focus is inside
  // it. preventDefault also stops the browser's own per-field undo fighting ours.
  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const action = historyShortcut(event);
    if (!action) return;
    event.preventDefault();
    if (action === "undo") undoEdit();
    else redoEdit();
  }

  function validationAttributes(field: keyof PolicyDraft) {
    const error = fieldErrors[field];
    return {
      "aria-invalid": error ? true : undefined,
      "aria-describedby": error ? `policy-error-${field}` : undefined,
    };
  }

  function fieldError(field: keyof PolicyDraft) {
    const error = fieldErrors[field];
    return error ? (
      <span className="field-error tiny" id={`policy-error-${field}`} role="status">
        {error}
      </span>
    ) : null;
  }

  return (
    <div className="panel" id="policy" onKeyDown={onKeyDown}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>Guardrail policy</h2>
        <div className="row">
          <button
            className="secondary"
            type="button"
            onClick={undoEdit}
            disabled={busy || !canUndo || draftForOtherGuard}
            title="Undo (Ctrl+Z / Cmd+Z)"
            aria-label="Undo"
          >
            Undo
          </button>
          <button
            className="secondary"
            type="button"
            onClick={redoEdit}
            disabled={busy || !canRedo || draftForOtherGuard}
            title="Redo (Ctrl+Shift+Z / Cmd+Shift+Z / Ctrl+Y)"
            aria-label="Redo"
          >
            Redo
          </button>
        </div>
      </div>
      <ScopeNotice />

      {draftForOtherGuard && draftScope && (
        <div className="notice danger" role="alert" data-testid="other-guard-draft">
          <strong>Unsaved edits belong to a different guard</strong>
          <span className="tiny">
            These edits were started for{" "}
            <span className="mono">{short(draftScope.guard, 8, 6)}</span> ({draftScope.network}).
            They have not been applied to the guard now selected (
            <span className="mono">{short(guard, 8, 6)}</span>) and cannot be installed on it. The
            form below shows what is installed on the selected guard. Switch back to continue
            editing, or discard the edits.
          </span>
          <div className="row" style={{ marginTop: 6 }}>
            <button className="secondary" onClick={discardOtherGuardDraft}>
              Discard unsaved edits
            </button>
          </div>
        </div>
      )}

      {policyState === "default-deny" && (
        <WarningBanner
          title="Nothing is installed on this account yet"
          action={
            <a className="cta" href="#install-policy">
              Install the policy below
            </a>
          }
        >
          <span className="tiny">
            {NO_POLICY_CONSEQUENCE} The form below starts from a blank draft because there is
            nothing to edit; installing it is what brings this account out of default-deny, and
            revoking is the action that puts it back.
          </span>
        </WarningBanner>
      )}

      <fieldset
        disabled={draftForOtherGuard}
        style={{ border: 0, padding: 0, margin: 0, minInlineSize: 0 }}
      >
        <CsvImportExport />
        <PolicySimulationView policy={validation.ok ? validation.config : null} />
        <p className="tiny muted">
          Installing a policy resets the rolling window and restarts the dead-man-switch clock, so a
          freshly installed policy always starts with full grace.
        </p>

        <div className="row" style={{ marginBottom: 14 }}>
          <button
            className="secondary"
            type="button"
            onClick={() => policyJsonInput.current?.click()}
            disabled={busy}
          >
            Import Policy JSON
          </button>
          <button className="secondary" type="button" onClick={exportPolicyJson} disabled={busy}>
            Export Policy JSON
          </button>
          <input
            ref={policyJsonInput}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void importPolicyJson(file);
            }}
          />
        </div>

        <div className="preset-picker">
          <label className="field" style={{ maxWidth: 420 }}>
            <span className="lbl">Policy presets</span>
            <select
              ref={presetSelect}
              value=""
              disabled={busy}
              aria-label="Apply a policy preset"
              onChange={(event) => {
                const preset = policyPresetById(event.target.value);
                if (preset) setPendingPreset(preset);
              }}
            >
              <option value="">Choose a vetted starting point…</option>
              {POLICY_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name} — {SECURITY_PROFILES[preset.securityProfile].label}
                </option>
              ))}
            </select>
            <span className="hint">
              Fills every field from a vetted archetype. You will be asked to confirm before your
              current draft is replaced.
            </span>
          </label>
          <div className="preset-legend">
            {POLICY_PRESETS.map((preset) => (
              <div key={preset.id} className="tiny">
                <SecurityProfileBadge profile={preset.securityProfile} />{" "}
                <strong>{preset.name}</strong>
                <span className="muted"> — {preset.explanation}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="split" style={{ marginTop: 14 }}>
          <div>
            <label className="field">
              <span className="lbl">Per-transaction cap (blank = off)</span>
              <input
                {...validationAttributes("perTxCap")}
                value={effective.perTxCap}
                inputMode="numeric"
                onChange={(event) => set("perTxCap", event.target.value, "text")}
                placeholder="1000"
              />
              {fieldError("perTxCap")}
              <span className="hint">Largest single SAC transfer the account will authorize.</span>
            </label>

            <label className="field">
              <span className="lbl">Rolling-window cap (blank = off)</span>
              <input
                {...validationAttributes("windowCap")}
                value={effective.windowCap}
                inputMode="numeric"
                onChange={(event) => set("windowCap", event.target.value, "text")}
                placeholder="150"
              />
              {fieldError("windowCap")}
              <span className="hint">
                Total spend allowed inside a genuinely rolling window — not a fixed bucket that
                resets.
              </span>
            </label>

            <label className="field">
              <span className="lbl">Rolling-window length (seconds)</span>
              <input
                {...validationAttributes("windowSecs")}
                value={effective.windowSecs}
                inputMode="numeric"
                onChange={(event) => set("windowSecs", event.target.value, "text")}
                placeholder="86400"
              />
              {fieldError("windowSecs")}
              <span className="hint">How far back the rolling sum looks.</span>
            </label>

            <label className="field">
              <span className="lbl">Dead-man grace (seconds, blank = off)</span>
              <input
                {...validationAttributes("dmsGraceSecs")}
                value={effective.dmsGraceSecs}
                inputMode="numeric"
                onChange={(event) => set("dmsGraceSecs", event.target.value, "text")}
                placeholder="skip"
              />
              {fieldError("dmsGraceSecs")}
              <span className="hint">
                Freeze the account automatically if the agent has not heartbeated within this many
                seconds.
              </span>
            </label>

            <span className="lbl">Active from / until (unix seconds, blank = unrestricted)</span>
            <div className="row form-inline-row" style={{ marginBottom: 12 }}>
              <input
                {...validationAttributes("activeFrom")}
                value={effective.activeFrom}
                inputMode="numeric"
                onChange={(event) => set("activeFrom", event.target.value, "text")}
                placeholder="from"
                aria-label="Active from"
              />
              <input
                {...validationAttributes("activeUntil")}
                value={effective.activeUntil}
                inputMode="numeric"
                onChange={(event) => set("activeUntil", event.target.value, "text")}
                placeholder="until"
                aria-label="Active until"
              />
            </div>
            {fieldError("activeFrom")}
            {fieldError("activeUntil")}
          </div>

          <div>
            <label className="field">
              <span className="lbl">Assets — SAC token contracts (one per line)</span>
              <textarea
                {...validationAttributes("assets")}
                rows={3}
                value={effective.assets}
                onChange={(event) => set("assets", event.target.value, "text")}
                placeholder="CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB"
              />
              {fieldError("assets")}
              <span className="hint">
                Transfers of these tokens get full recipient and amount enforcement.
              </span>
            </label>

            <div className="field">
              <span className="lbl">Per-asset cap overrides</span>
              <span className="hint">
                Bulk-edit asset contract addresses and positive stroop caps. Imported rows are
                merged by contract address.
              </span>
              <div className="row" style={{ margin: "8px 0" }}>
                <button
                  className="secondary"
                  type="button"
                  onClick={() => csvInput.current?.click()}
                  disabled={busy}
                >
                  Import CSV
                </button>
                <button
                  className="secondary"
                  type="button"
                  onClick={() => jsonInput.current?.click()}
                  disabled={busy}
                >
                  Import JSON
                </button>
                <button
                  className="secondary"
                  type="button"
                  onClick={() =>
                    downloadAssetCaps(
                      "asset-cap-overrides.csv",
                      exportAssetCapsCsv(effective.assetCaps),
                    )
                  }
                  disabled={busy || effective.assetCaps.length === 0}
                >
                  Export CSV
                </button>
                <button
                  className="secondary"
                  type="button"
                  onClick={() =>
                    downloadAssetCaps(
                      "asset-cap-overrides.json",
                      exportAssetCapsJson(effective.assetCaps),
                    )
                  }
                  disabled={busy || effective.assetCaps.length === 0}
                >
                  Export JSON
                </button>
                <input
                  ref={csvInput}
                  type="file"
                  accept=".csv,text/csv"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void importAssetCaps(file, "csv");
                  }}
                />
                <input
                  ref={jsonInput}
                  type="file"
                  accept=".json,application/json"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void importAssetCaps(file, "json");
                  }}
                />
              </div>
              {effective.assetCaps.length > 0 && (
                <table className="asset-caps">
                  <thead>
                    <tr>
                      <th>Asset contract</th>
                      <th>Max cap (stroops)</th>
                      <th>Symbol</th>
                      <th aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {effective.assetCaps.map((row, index) => (
                      <tr key={row.assetContractAddress}>
                        <td>
                          <input
                            {...validationAttributes("assetCaps")}
                            aria-label={`Asset contract ${index + 1}`}
                            value={row.assetContractAddress}
                            onChange={(event) => {
                              const next = [...effective.assetCaps];
                              next[index] = { ...row, assetContractAddress: event.target.value };
                              updateAssetCaps(next, "text");
                            }}
                          />
                          {assetCapChanges[row.assetContractAddress] && (
                            <span className="pill ok asset-cap-badge">
                              {assetCapChanges[row.assetContractAddress]}
                            </span>
                          )}
                        </td>
                        <td>
                          <input
                            {...validationAttributes("assetCaps")}
                            aria-label={`Maximum cap ${index + 1}`}
                            inputMode="numeric"
                            value={row.maxCapStroops}
                            onChange={(event) => {
                              const next = [...effective.assetCaps];
                              next[index] = { ...row, maxCapStroops: event.target.value };
                              updateAssetCaps(next, "text");
                            }}
                          />
                        </td>
                        <td>
                          <input
                            {...validationAttributes("assetCaps")}
                            aria-label={`Symbol ${index + 1}`}
                            value={row.symbol}
                            onChange={(event) => {
                              const next = [...effective.assetCaps];
                              next[index] = { ...row, symbol: event.target.value };
                              updateAssetCaps(next, "text");
                            }}
                          />
                        </td>
                        <td>
                          <button
                            className="secondary"
                            type="button"
                            aria-label={`Remove ${row.symbol || "asset override"}`}
                            onClick={() =>
                              updateAssetCaps(
                                effective.assetCaps.filter((_, itemIndex) => itemIndex !== index),
                              )
                            }
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {fieldError("assetCaps")}
            </div>

            <label className="field">
              <span className="lbl">Recipients (one per line)</span>
              <textarea
                {...validationAttributes("recipients")}
                rows={3}
                value={effective.recipients}
                onChange={(event) => set("recipients", event.target.value, "text")}
                placeholder="GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH"
              />
              {fieldError("recipients")}
            </label>

            <div className="checkline">
              <input
                id="allow-any"
                type="checkbox"
                checked={effective.allowAnyRecipient}
                onChange={(event) => set("allowAnyRecipient", event.target.checked)}
              />
              <label htmlFor="allow-any">
                Allow any recipient (the caps still apply)
                <span className="hint">
                  With this off, a transfer to an address that is not listed is refused.
                </span>
              </label>
            </div>

            <label className="field">
              <span className="lbl">Protocols — allowlisted contracts (one per line)</span>
              <textarea
                {...validationAttributes("protocols")}
                rows={3}
                value={effective.protocols}
                onChange={(event) => set("protocols", event.target.value, "text")}
                placeholder="C…  or  C…:swap,deposit   (no colon = any function)"
              />
              {fieldError("protocols")}
              <span className="hint">
                Calls to contracts outside this list are refused. Window and pause state still apply
                to these calls; per-call amount and recipient limits do not.
              </span>
            </label>

            {/* The picker reads each contract's spec from chain, so a typo'd
              symbol is caught before the policy is installed rather than as a
              runtime authorization refusal. The textarea stays authoritative:
              the picker only edits the lines it is given. */}
            <ProtocolFunctionSelector draft={effective} set={set} />

            <div className="checkline">
              <input
                id="paused"
                type="checkbox"
                checked={effective.paused}
                onChange={(event) => set("paused", event.target.checked)}
              />
              <label htmlFor="paused">
                Start paused
                <span className="hint">
                  Installs the policy but refuses every call until resumed.
                </span>
              </label>
            </div>
          </div>
        </div>
      </fieldset>

      <h3>Review</h3>
      <p className="tiny mono">{describeDraft(effective)}</p>

      {issues.length > 0 && (
        <div className="error">
          <span className="t">This policy is not valid yet</span>
          <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
            {issues.map((issue) => (
              <li key={`${issue.field}-${issue.message}`} className="tiny">
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="form-actions row" style={{ marginTop: 14 }}>
        <button
          disabled={installControl.disabled}
          title={installControl.title}
          onClick={() => void submit()}
        >
          {busy ? "Working…" : "Sign and install policy"}
        </button>
        <button
          className="secondary"
          disabled={exportControl.disabled}
          title={exportControl.title}
          onClick={() => void submit(true)}
        >
          Export XDR
        </button>
        <button
          className="secondary"
          disabled={revokeDisabled}
          title={revokeTitle}
          onClick={() => void revoke()}
        >
          Revoke policy (default deny)
        </button>
        <button
          className="secondary"
          onClick={() => {
            setDraft(EMPTY_DRAFT);
            setAssetCapChanges({});
          }}
          disabled={busy || draftForOtherGuard}
        >
          Clear form
        </button>
        <button
          className="secondary"
          onClick={() => {
            setDraft(null);
            setAssetCapChanges({});
          }}
          disabled={busy || draft === null || draftForOtherGuard}
          title="Discard edits and load the policy currently installed on chain"
        >
          Load installed
        </button>
      </div>

      {pendingPreset && (
        <div className="modal-backdrop">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="preset-confirm-title"
            ref={presetDialog}
            tabIndex={-1}
          >
            <strong id="preset-confirm-title">Replace current draft?</strong>
            <p className="tiny">
              Applying the {pendingPreset.name} preset overwrites every field in the form — caps,
              allowlists, active window, pause state and dead-man grace.
            </p>
            <p className="tiny">
              <SecurityProfileBadge profile={pendingPreset.securityProfile} />{" "}
              {SECURITY_PROFILES[pendingPreset.securityProfile].description}
            </p>
            <p className="tiny mono">{describeDraft(draftFromPreset(pendingPreset))}</p>
            <p className="tiny muted">
              The placeholder asset, recipient and protocol addresses in this preset must be
              replaced with your own before installing.
            </p>
            <div className="row">
              <button onClick={() => applyPreset(pendingPreset)}>Replace draft</button>
              <button className="secondary" onClick={() => setPendingPreset(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {error && <ErrorBlock title="The policy write did not complete" detail={error} />}

      {outcome?.kind === "invoked" && (
        <OutcomeBlock result={outcome.result} verb="set_policy" onClose={() => setOutcome(null)} />
      )}
      {outcome?.kind === "invalid" && (
        <ErrorBlock
          title="The policy was rejected before signing"
          detail={outcome.issues.join("; ")}
        />
      )}

      {approval && approval.diff && pendingApproval && (
        <PolicyDiffModal
          diff={approval.diff}
          onConfirm={() => void runInstall(false, pendingApproval)}
          onCancel={() => setPendingApproval(null)}
        />
      )}
    </div>
  );
}

/**
 * The security-profile badge: a colour-coded pill an operator can read at a
 * glance. The full description lives on `title` so the trade-off is available
 * without cluttering the row.
 */
function SecurityProfileBadge({ profile }: { profile: SecurityProfile }) {
  const meta = SECURITY_PROFILES[profile];
  return (
    <span className={`pill ${meta.pillClass}`} title={meta.description}>
      {meta.label}
    </span>
  );
}

export function OutcomeBlock({
  result,
  verb,
  onClose,
}: {
  result: InvokeResult;
  verb: string;
  onClose?: () => void;
}) {
  if (result.kind === "exported") {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "16px",
            }}
          >
            <h2 style={{ margin: 0 }}>Exported Transaction XDR</h2>
            {onClose && (
              <button className="secondary" onClick={onClose}>
                Close
              </button>
            )}
          </div>
          <p className="tiny" style={{ marginBottom: "16px" }}>
            This unsigned transaction envelope is ready for external multi-sig signing.
          </p>
          <textarea
            readOnly
            value={result.xdr}
            style={{
              width: "100%",
              height: "120px",
              marginBottom: "16px",
              fontSize: "12px",
              fontFamily: "monospace",
            }}
          />
          <div className="row">
            <button onClick={() => navigator.clipboard.writeText(result.xdr)}>
              Copy to Clipboard
            </button>
            <button
              onClick={() => {
                const blob = new Blob([result.xdr], { type: "text/plain" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `unsigned-${verb}-${Date.now()}.tx`;
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              Download .tx
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (result.kind === "submitted") {
    return (
      <div className="notice info">
        <strong>
          {verb} landed on chain — {starLink(result.hash)}
        </strong>
        <span className="tiny">
          Ledger {result.ledger ?? "—"}. The panel above re-reads the contract to show the policy
          that is actually installed; this receipt proves the write, not that it did what you
          expected.
        </span>
      </div>
    );
  }
  if (result.kind === "refused") {
    return (
      <div className="error">
        <span className="t">
          Refused during {result.stage} — nothing was broadcast, so this cost nothing
        </span>
        <span className="mono tiny">{result.detail}</span>
      </div>
    );
  }
  if (result.kind === "cancelled") {
    return (
      <div className="warn notice" data-testid="policy-form-cancelled">
        <span className="t">Transaction signing cancelled — nothing was broadcast</span>
        <span className="mono tiny">{result.detail}</span>
      </div>
    );
  }
  return (
    <div className="error">
      <span className="t">Broadcast but rejected on chain — {starLink(result.hash)}</span>
      <span className="mono tiny">{result.detail}</span>
    </div>
  );
}
