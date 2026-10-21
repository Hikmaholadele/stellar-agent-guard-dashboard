"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GuardStatus } from "stellar-agent-guard-sdk";
import type { rpc } from "@stellar/stellar-sdk";
import type { InvokeResult } from "../lib/guard/submit.ts";
import {
  freezeGuard,
  simulateFreeze,
  unfreezeGuard,
  type FreezeSimulationResult,
} from "../lib/guard/guardOps.ts";
import { readNativeXlmBalance } from "../lib/guard/chain.ts";
import type { ReadResult } from "../lib/guard/chain.ts";
import {
  FREEZE_CHALLENGE_SUFFIX_LENGTH,
  FREEZE_CHALLENGE_THRESHOLD_XLM,
  freezeChallengeMatches,
  requiresFreezeChallenge,
} from "../lib/guard/freezeChallenge.ts";
import { formatStroops, formatStroopsWithUnit } from "../lib/guard/formatters.ts";
import { refusedEventsFromDiagnostics } from "../lib/guard/telemetry.ts";
import { useGuard } from "./GuardProvider.tsx";
import { WRITE_DISABLED_HINT, writeControlState } from "../lib/guard/observerMode.ts";
import { evaluateOffline, useOnlineStatus } from "../lib/guard/online.ts";
import { ErrorBlock, starLink } from "./bits.tsx";
import {
  freezeConfirmed,
  freezeFailed,
  writeFailureReason,
  type FreezeAction,
} from "../lib/guard/announceCopy.ts";
import { useModalFocus } from "../lib/guard/useModalFocus.ts";
import { noteVerifiedOutcome } from "../lib/guard/statusTransitions.ts";
import { announce } from "../lib/guard/useAnnounce.ts";
import { usePwaActivity } from "../lib/guard/usePwaActivity.ts";
import { CopyButton } from "./CopyButton.tsx";
import { useDemoMode } from "../lib/guard/useDemoMode.ts";

/**
 * The emergency panic button.
 *
 * The whole point of this panel is that "the UI said it worked" is not the
 * evidence. After a freeze it re-reads `status()` from the chain and shows what
 * the contract itself reports, and it refuses to claim success if the flag did
 * not actually change — a write that was signed and included but did not take
 * effect must not be reported as a freeze.
 *
 * That same reasoning decides what is spoken (issue #30). A screen-reader
 * operator cannot see the badge flip or the notice appear, so the verified
 * outcome is announced: the confirmation, or the failure *with its reason*,
 * which is the part that says whether the account is frozen right now. The write
 * path already announces the transaction itself; this is the announcement about
 * the effect. It leaves through the shell's live region by way of `announce()`,
 * so it survives the dialog being torn down by the very interaction that
 * produced it.
 */

type Phase = "idle" | "confirming" | "signing" | "verifying" | "done";

/**
 * The live XLM balance the freeze-challenge threshold is compared against
 * (issue #15). Three states, deliberately no fourth: `unread` covers both
 * "not read yet" and demo mode (which makes no RPC call at all), and `error`
 * keeps the failure's detail so the dialog can say *why* the typed
 * confirmation is showing. Both non-`ok` states fail safe to the challenge.
 */
type BalanceState =
  { status: "unread" } | { status: "ok"; stroops: bigint } | { status: "error"; detail: string };

interface Report {
  action: "freeze" | "unfreeze";
  result: InvokeResult;
  /** `status()` re-read from the chain after the write. */
  adminFrozenAfter: boolean | null;
  /** True only when the re-read confirms the intended effect. */
  confirmed: boolean;
  note: string;
}

/**
/**
 * The announcement for a write that has finished.
 *
 * The reason carried by a failure is whichever one explains it best: what the
 * enforced simulation refused and why, what the network rejected, or — for a
 * write that was included but changed nothing — the note saying the re-read
 * disagreed. "Freeze failed" on its own would leave a screen-reader operator
 * with less than the sighted operator can read, at the exact moment when the
 * only question is whether the account is frozen.
 */
function speakFreezeOutcome(
  action: FreezeAction,
  confirmed: boolean,
  note: string,
  result?: InvokeResult,
  guard?: string,
): void {
  const spoken = confirmed
    ? freezeConfirmed(action, guard)
    : freezeFailed(action, result ? writeFailureReason(result, note) : note, guard);
  announce(spoken.message, spoken.priority);
}

/**
 * The chain operations this panel drives.
 *
 * Injected rather than imported straight into the handler so the a11y
 * behaviour can be asserted without a wallet or a network: the ordering that
 * matters (announce the result, then let the dialog close and restore focus)
 * is a property of the panel, not of the chain, and it is testable only if the
 * chain behind it can be replaced. Defaults are the real operations, so the
 * console's own pages — and the end-to-end specs that drive them — run the
 * production path unchanged. Same seam discipline as the perf harness's
 * `__guardFeedInject` and `pollFleet`'s `_readSnapshot`.
 */
export interface PanicPanelOps {
  freeze: typeof freezeGuard;
  unfreeze: typeof unfreezeGuard;
  readStatus: (
    server: rpc.Server,
    guard: string,
    source?: string,
  ) => Promise<ReadResult<GuardStatus>>;
}

const DEFAULT_OPS: PanicPanelOps = {
  freeze: freezeGuard,
  unfreeze: unfreezeGuard,
  // Dynamic, as before: `chain.ts` is not needed until a write is verified, and
  // keeping it out of the panel's first-paint graph is the point of the import.
  readStatus: async (server, guard, source) =>
    (await import("../lib/guard/chain.ts")).readStatus(server, guard, source),
};

/**

 * Render a freeze dry run.
 *
 * The banner is not decoration: a simulation output looks similar enough to a
 * real write's receipt that without an explicit "not broadcast" marker an
 * operator could believe the account was frozen when it was not. The report
 * states the execution result, the authorizations the call would need, and its
 * priced resource cost — and says plainly that recording-mode simulation does
 * not enforce auth, so a passing dry run is not a promise the real call passes.
 */
function DryRunReport({
  simulation,
  onDismiss,
}: {
  simulation: FreezeSimulationResult;
  onDismiss: () => void;
}) {
  return (
    <div className="dry-run">
      <div className="dry-run-banner" role="status">
        DRY RUN - NOT BROADCAST
      </div>

      {simulation.kind === "refused" ? (
        <p className="tiny">
          The simulation refused the call, so a real freeze would fail in pre-flight too. Nothing
          was broadcast. The detail names the stage:{" "}
          <span className="mono">{simulation.detail}</span>
        </p>
      ) : (
        <>
          <p className="tiny">
            <span className="pill ok">simulated</span> <code>{simulation.fn}()</code> would execute.
            The account is unchanged — no transaction was built, signed or sent.
          </p>

          <p className="tiny" style={{ marginBottom: 2 }}>
            <strong>Required authorization signatures</strong>
          </p>
          {simulation.authorizations.length === 0 ? (
            <p className="tiny muted">
              No separate authorization entries. The wallet&apos;s transaction-envelope signature
              (not requested in a dry run) would be the only signature needed.
            </p>
          ) : (
            <ul className="tiny" style={{ margin: "0 0 6px 16px", padding: 0 }}>
              {simulation.authorizations.map((entry, index) => (
                <li key={`${entry.kind}-${entry.address ?? "none"}-${index}`}>
                  {entry.kind === "source_account"
                    ? "Source account — covered by the envelope signature"
                    : entry.kind === "address"
                      ? `${entry.address ?? "unknown address"} must sign an authorization entry`
                      : "An authorization this dashboard cannot satisfy"}
                </li>
              ))}
            </ul>
          )}
          <p className="tiny muted">
            {simulation.separateSignaturesRequired === 0
              ? "0 separate auth-entry signatures required."
              : `${simulation.separateSignaturesRequired} separate auth-entry signature(s) required.`}{" "}
            None are requested by a dry run.
          </p>

          <p className="tiny" style={{ marginBottom: 2 }}>
            <strong>Resource fees</strong>
          </p>
          <table className="events">
            <tbody>
              <tr>
                <td>Resource fee (CPU, ledger I/O, events)</td>
                <td className="mono">{simulation.resourceFeeStroops} stroops</td>
              </tr>
              <tr>
                <td>Inclusion fee floor</td>
                <td className="mono">{simulation.inclusionFeeStroops} stroops</td>
              </tr>
              <tr>
                <td>Total fee if submitted</td>
                <td className="mono">{simulation.totalFeeStroops} stroops</td>
              </tr>
              <tr>
                <td>Footprint ledger keys</td>
                <td className="mono">{simulation.footprintEntries}</td>
              </tr>
              <tr>
                <td>Simulated against ledger</td>
                <td className="mono">{simulation.latestLedger ?? "—"}</td>
              </tr>
            </tbody>
          </table>

          <p className="tiny muted" style={{ marginTop: 8 }}>
            Recording-mode simulation does not enforce authorization, so a passing dry run checks
            connectivity, permissions and resource pricing — it is not a guarantee the enforced
            submission will pass later.
          </p>
        </>
      )}

      <div className="row" style={{ marginTop: 10 }}>
        <button className="secondary" onClick={onDismiss}>
          Dismiss dry run
        </button>
      </div>
    </div>
  );
}

export function PanicPanel({ ops }: { ops?: Partial<PanicPanelOps> }) {
  const { signer, guard, server, refresh, snapshot, pushEvents, wallet, notifyTabs } = useGuard();
  const { freeze, unfreeze, readStatus: readStatusAfter } = { ...DEFAULT_OPS, ...ops };
  const [phase, setPhase] = useState<Phase>("idle");
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  // The dry-run result is kept separate from `report` so a simulation can never
  // be mistaken for a freeze that happened. `simulating` disables the button
  // while the read-only call is in flight.
  const [simulation, setSimulation] = useState<FreezeSimulationResult | null>(null);
  const [simulating, setSimulating] = useState(false);
  // Freeze-challenge state (issue #15): the live balance that decides the
  // confirmation's shape, and the operator's typed answer.
  const [balance, setBalance] = useState<BalanceState>({ status: "unread" });
  const [challengeInput, setChallengeInput] = useState("");
  // A freeze that is signing or awaiting the post-write read is a pending
  // write: an update must not replace the app underneath it (#398).
  usePwaActivity(phase === "signing" || phase === "verifying", "write");
  const demoMode = useDemoMode();
  // An emergency write is still a write: when the live status read it depends
  // on failed, or the browser is offline, the control says why instead of
  // offering an action that cannot be prepared safely (issue #348).
  const online = useOnlineStatus();
  const offlineView = evaluateOffline({
    online,
    liveReadFailed: snapshot !== null && !snapshot.status.ok,
  });
  const preflightUnavailable = offlineView.writesDisabled ? offlineView.detail : null;

  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Newest balance read wins: every (re)read bumps this token, and a reply
  // that arrives after a newer read — or after unmount — is dropped instead
  // of overwriting fresher state with a stale number.
  const balanceToken = useRef(0);
  const confirming = phase === "confirming";

  /**
   * Read the guard's live XLM balance — the threshold input for the freeze
   * challenge. Called on mount and again each time the confirm dialog opens,
   * because the decision must use a *current* number: an account that was
   * small when the page loaded and large by the time the operator freezes it
   * has to be challenged. Demo mode makes no RPC call at all, so the balance
   * stays `unread` there — which shows the challenge, the fail-safe side.
   */
  const loadBalance = useCallback(() => {
    if (demoMode) return;
    const token = ++balanceToken.current;
    const settle = (state: BalanceState): void => {
      if (token !== balanceToken.current) return;
      setBalance(state);
    };
    void readNativeXlmBalance(server, guard)
      .then((result) => {
        settle(
          result.ok
            ? { status: "ok", stroops: result.value }
            : { status: "error", detail: result.error },
        );
      })
      .catch((caught) => {
        settle({
          status: "error",
          detail: caught instanceof Error ? caught.message : String(caught),
        });
      });
  }, [server, guard, demoMode]);

  useEffect(() => {
    loadBalance();
    return () => {
      // Invalidate the in-flight read on unmount or context change, so its
      // reply can neither update a dead dialog nor cross a guard switch.
      balanceToken.current += 1;
    };
  }, [loadBalance]);

  // ── Freeze-challenge decision (issue #15) ──────────────────────────────
  // `null` for every non-`ok` balance (unread/error), which
  // `requiresFreezeChallenge` maps to "challenge shown": when the stakes are
  // unknown the friction goes up, never down.
  const challengeRequired = requiresFreezeChallenge(
    balance.status === "ok" ? balance.stroops : null,
  );
  const challengeSatisfied = !challengeRequired || freezeChallengeMatches(challengeInput, guard);
  const challengeError =
    challengeRequired && challengeInput.trim() !== "" && !challengeSatisfied
      ? `That is not the last ${FREEZE_CHALLENGE_SUFFIX_LENGTH} characters — type them exactly as shown.`
      : null;

  // Focus management for the confirmation dialog: move focus in on open, keep
  // Tab cycling inside it, close on Escape, and restore focus to the trigger
  // whenever the dialog goes away. Without this a modal is either a keyboard
  // trap (focus escapes into the page behind it) or a dead end (focus lands
  // nowhere on dismissal) — both fail WCAG 2.1 AA keyboard requirements.
  useModalFocus({
    open: confirming,
    containerRef: dialogRef,
    returnFocusRef: triggerRef,
    onDismiss: () => {
      setPhase("idle");
      setAcknowledged(false);
    },
  });

  const alreadyFrozen = snapshot?.status.ok ? snapshot.status.value.admin_frozen : null;
  // The panic button is the write an operator reaches for under pressure, so an
  // inert one has to say why in the same words as every other control (#101).
  const freezeControl = writeControlState(wallet, {
    extraDisabled: alreadyFrozen === true,
    preflightUnavailable,
    label: "freeze this account",
  });
  const unfreezeControl = writeControlState(wallet, {
    extraDisabled: alreadyFrozen === false,
    preflightUnavailable,
    label: "unfreeze this account",
  });

  /**
   * Dry-run the freeze: simulate the call and show what it would cost and
   * require. This path deliberately never signs and never broadcasts, so it is
   * safe to run on a live account (and the assertion is pinned by a unit test).
   */
  async function runSimulation() {
    setSimulating(true);
    setSimulation(null);
    setError(null);
    try {
      const result = await simulateFreeze({ server, signer: signer(), guard });
      setSimulation(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSimulating(false);
    }
  }

  async function run(action: FreezeAction, exportOnly = false) {
    setError(null);
    setReport(null);
    setPhase("signing");
    try {
      const walletSigner = signer();
      const result =
        action === "freeze"
          ? await freeze({ server, signer: walletSigner, guard, exportOnly })
          : await unfreeze({ server, signer: walletSigner, guard, exportOnly });

      // Surface any refused-decision diagnostics the write produced, so a refusal
      // appears in the feed rather than only in this panel.
      if (result.kind === "refused") {
        pushEvents(refusedEventsFromDiagnostics(result.diagnosticEvents, guard));
      }

      if (result.kind === "exported") {
        setReport({
          action,
          result,
          adminFrozenAfter: null,
          confirmed: false,
          note: "Transaction XDR exported for offline signing",
        });
        setPhase("done");
        return;
      }

      // Re-read the contract's own view. This is the step that makes the claim
      // real: the UI is not the source of truth, `status()` is.
      setPhase("verifying");
      const after = await readStatusAfter(server, guard, wallet?.address);
      const adminFrozenAfter = after.ok ? after.value.admin_frozen : null;
      const expected = action === "freeze";
      const confirmed = adminFrozenAfter !== null && adminFrozenAfter === expected;
      const note = !after.ok
        ? `the write returned, but status() could not be re-read to confirm its effect: ${after.error}`
        : confirmed
          ? `status().admin_frozen now reads ${adminFrozenAfter}, which is the ${action} taking effect`
          : `status().admin_frozen reads ${adminFrozenAfter} — the intended effect is NOT visible on chain`;

      setReport({ action, result, adminFrozenAfter, confirmed, note });

      // Announced before the phase change that closes the dialog, so the message
      // is already in the shell's queue when the dialog is torn down and focus
      // moves back to the trigger. A write that was included but did not take
      // effect is announced as the failure it is, with the reason.
      speakFreezeOutcome(action, confirmed, note, result, guard);
      if (confirmed) {
        // The effect is now on chain and has been announced. Recorded so the
        // next poll does not repeat the same fact back at the operator — and
        // recorded *only* when confirmed, so a freeze that lands anyway after a
        // failed write is still announced when the poll finds it.
        noteVerifiedOutcome({ adminFrozen: expected });
      }

      setPhase("done");
      // Only a broadcast write can have moved the chain. Tell the other tabs so
      // they re-read instead of showing the pre-freeze world for up to a poll
      // interval — the one delay that matters when the agent is misbehaving.
      if (result.kind === "submitted") notifyTabs("FREEZE_STATE_CHANGED", { payload: { action } });
      await refresh();
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : String(caught);
      setError(detail);
      // The dialog is about to reopen in its idle state, so the failure has to be
      // spoken now: nothing else on screen will change once focus is restored.
      speakFreezeOutcome(action, false, detail, undefined, guard);
      setPhase("idle");
      setAcknowledged(false);
    }
  }

  return (
    <div className="panel">
      <h2>Emergency</h2>

      <p className="tiny muted">
        Freezing sets the account&apos;s admin freeze, after which <code>__check_auth</code> refuses
        every call the account would make — the agent stops being able to move anything. The freeze
        is reversible: <code>unfreeze()</code> clears it and restarts the heartbeat clock, so it is
        also the way back from a dead-man-switch freeze.
      </p>

      {alreadyFrozen !== null && (
        <p className="tiny">
          Chain currently reports:{" "}
          {alreadyFrozen ? (
            <span className="pill danger">FROZEN</span>
          ) : (
            <span className="pill ok">clear</span>
          )}
        </p>
      )}

      {!wallet && (
        <p className="tiny muted" data-testid="observer-notice">
          {WRITE_DISABLED_HINT}: freeze, unfreeze and heartbeat are all signed writes.
        </p>
      )}

      {phase !== "confirming" && (
        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="danger"
            ref={triggerRef}
            disabled={freezeControl.disabled}
            title={freezeControl.title}
            onClick={() => {
              setAcknowledged(false);
              setChallengeInput("");
              setPhase("confirming");
              setReport(null);
              // Re-read the balance at the decision point, not just at mount:
              // the threshold must be judged against the account's exposure
              // *now*, and a read still in flight keeps the challenge on.
              loadBalance();
            }}
          >
            Freeze this account
          </button>
          <button
            className="secondary"
            disabled={unfreezeControl.disabled}
            title={unfreezeControl.title}
            onClick={() => void run("unfreeze")}
          >
            Unfreeze
          </button>
          <button
            className="secondary"
            disabled={unfreezeControl.disabled}
            title={unfreezeControl.title}
            onClick={() => void run("unfreeze", true)}
          >
            Export Unfreeze XDR
          </button>
          <button
            className="secondary"
            disabled={!wallet || simulating}
            onClick={() => void runSimulation()}
            title="Simulate freeze() read-only: no wallet prompt, no broadcast (docs/glossary.md — Pre-flight Simulation)"
          >
            {simulating ? "Simulating…" : "Simulate freeze (dry run)"}
          </button>
        </div>
      )}

      {phase === "confirming" && (
        <div className="modal-backdrop">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="freeze-confirm-title"
            ref={dialogRef}
            tabIndex={-1}
          >
            <strong id="freeze-confirm-title">
              Confirm the freeze — this stops the agent immediately
            </strong>
            <p className="tiny">
              The agent will not be able to make any call that requires its authorization until the
              account is unfrozen. This will prompt your wallet to sign an <code>unfreeze</code>
              -able <code>freeze()</code> call on{" "}
              <span className="mono">{guard.slice(0, 10)}…</span>.
            </p>
            <div className="checkline">
              <input
                id="ack-freeze"
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <label htmlFor="ack-freeze">
                I understand this halts the agent&apos;s spending, and that undoing it needs a
                second signed <code>unfreeze()</code>.
              </label>
            </div>
            {challengeRequired && (
              <div data-testid="freeze-challenge-block">
                <p className="tiny" id="freeze-challenge-why">
                  {balance.status === "ok" ? (
                    <>
                      This guard holds <strong>{formatStroopsWithUnit(balance.stroops)}</strong> —
                      at or above the{" "}
                      {formatStroops(BigInt(FREEZE_CHALLENGE_THRESHOLD_XLM), { decimals: 0 })} XLM
                      large-exposure threshold.{" "}
                    </>
                  ) : balance.status === "error" ? (
                    <>
                      The balance could not be read ({balance.detail}), so this freeze keeps the
                      typed confirmation — when the stakes are unknown the friction goes up, never
                      down.{" "}
                    </>
                  ) : (
                    <>
                      Reading this guard&apos;s live XLM balance; until the read settles, the typed
                      confirmation stays on.{" "}
                    </>
                  )}
                  Typing the last {FREEZE_CHALLENGE_SUFFIX_LENGTH} characters of the guard address
                  below prevents an accidental freeze — deliberate friction against a mis-click, not
                  protection against anyone who can already see this page.
                </p>
                <p className="tiny mono" style={{ margin: "0 0 6px" }}>
                  {guard}
                </p>
                <label className="tiny" htmlFor="freeze-challenge">
                  Last {FREEZE_CHALLENGE_SUFFIX_LENGTH} characters of the guard address
                </label>
                <input
                  id="freeze-challenge"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={challengeInput}
                  onChange={(event) => setChallengeInput(event.target.value)}
                  aria-invalid={challengeError === null ? undefined : true}
                  aria-describedby={`freeze-challenge-why${
                    challengeError === null ? "" : " freeze-challenge-error"
                  }`}
                />
                {challengeError !== null && (
                  <p
                    className="error tiny"
                    id="freeze-challenge-error"
                    role="alert"
                    style={{ marginTop: 6, marginBottom: 0 }}
                  >
                    {challengeError}
                  </p>
                )}
              </div>
            )}
            <div className="row">
              <button
                className="danger"
                disabled={!acknowledged || !challengeSatisfied}
                onClick={() => void run("freeze")}
              >
                Sign freeze
              </button>
              <button
                className="secondary"
                disabled={!acknowledged || !challengeSatisfied}
                onClick={() => void run("freeze", true)}
              >
                Export XDR
              </button>
              <button className="secondary" onClick={() => setPhase("idle")}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {(phase === "signing" || phase === "verifying") && (
        <div className="notice info">
          <strong>{phase === "signing" ? "Waiting for the wallet…" : "Verifying on chain…"}</strong>
          <span className="tiny">
            {phase === "signing"
              ? "Two signatures may be requested: one for the authorization entry, one for the transaction envelope."
              : "Re-reading status() to confirm the account's own view changed."}
          </span>
        </div>
      )}

      {error && <ErrorBlock title="The freeze could not be completed" detail={error} />}

      {simulation && <DryRunReport simulation={simulation} onDismiss={() => setSimulation(null)} />}

      {report?.result.kind === "exported" && (
        <div
          className="modal-backdrop"
          onClick={() => {
            setReport(null);
            setPhase("idle");
          }}
        >
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
              <button
                className="secondary"
                onClick={() => {
                  setReport(null);
                  setPhase("idle");
                }}
              >
                Close
              </button>
            </div>
            <p className="tiny" style={{ marginBottom: "16px" }}>
              This unsigned transaction envelope is ready for external multi-sig signing.
            </p>
            <textarea
              readOnly
              value={report.result.kind === "exported" ? report.result.xdr : ""}
              style={{
                width: "100%",
                height: "120px",
                marginBottom: "16px",
                fontSize: "12px",
                fontFamily: "monospace",
              }}
            />
            <div className="row">
              <button
                onClick={() =>
                  navigator.clipboard.writeText(
                    report.result.kind === "exported" ? report.result.xdr : "",
                  )
                }
              >
                Copy to Clipboard
              </button>
              <button
                onClick={() => {
                  const blob = new Blob(
                    [report.result.kind === "exported" ? report.result.xdr : ""],
                    { type: "text/plain" },
                  );
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `unsigned-${report.action}-${Date.now()}.tx`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                Download .tx
              </button>
            </div>
          </div>
        </div>
      )}

      {report && report.result.kind !== "exported" && (
        <div className={report.confirmed ? "notice info" : "error"}>
          <strong>
            {report.confirmed
              ? `${report.action === "freeze" ? "Freeze" : "Unfreeze"} confirmed on chain`
              : `${report.action === "freeze" ? "Freeze" : "Unfreeze"} NOT confirmed`}
          </strong>
          <span className="tiny">{report.note}</span>

          {report.result.kind === "submitted" && (
            <p className="tiny" style={{ marginTop: 6 }}>
              transaction {starLink(report.result.hash)} · included in ledger{" "}
              {report.result.ledger ?? "—"}{" "}
              <CopyButton value={report.result.hash} label="freeze transaction hash" />
            </p>
          )}
          {report.result.kind === "refused" && (
            <p className="tiny" style={{ marginTop: 6 }}>
              Nothing was broadcast. Refused during {report.result.stage}:{" "}
              <span className="mono">{report.result.detail}</span>
            </p>
          )}
          {report.result.kind === "failed" && (
            <p className="tiny" style={{ marginTop: 6 }}>
              Transaction {starLink(report.result.hash)} was included and rejected:{" "}
              <span className="mono">{report.result.detail}</span>
            </p>
          )}

          {report.result.kind !== "submitted" && (
            <p className="tiny muted" style={{ marginTop: 6 }}>
              A refused call has no transaction hash by construction — it was never broadcast. That
              is the pre-flight path working, not a missing receipt.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
