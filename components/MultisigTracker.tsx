"use client";

/**
 * The multisig pending-approval tracker (#147).
 *
 * An enterprise account configured with Stellar's native multi-sig holds admin
 * transactions in a pending state until the required co-signers have signed the
 * envelope. This panel takes one pasted envelope XDR, reads the account's
 * signer weights and thresholds from Horizon, and shows exactly where the
 * approval stands: collected weight against the requirement, per-signer status,
 * and a one-click copy of the hash and envelope for the remaining co-signers.
 *
 * The panel is a thin view over `multisig.ts` (the arithmetic) and
 * `multisigRead.ts` (the reads): a failed Horizon read renders an error block,
 * never a zero, and a malformed envelope is reported as malformed rather than
 * silently treated as unsigned.
 */

import { useCallback, useState } from "react";
import { TransactionBuilder } from "@stellar/stellar-sdk";
import { NETWORK } from "../lib/guard/network.ts";
import { toHex } from "../lib/guard/scval.ts";
import {
  THRESHOLD_LABELS,
  approvalPercent,
  approvalSummary,
  evaluateApprovalState,
  pendingSigners,
  remainingWeightSummary,
  signerRuleChanges,
  type EnvelopeSignature,
  type MultisigApprovalState,
} from "../lib/guard/multisig.ts";
import {
  createHorizonServer,
  matchEnvelopeSignatures,
  readAccountSigners,
  readEnvelopeSignatures,
  unmatchedSignatures,
} from "../lib/guard/multisigRead.ts";
import { useGuard } from "./GuardProvider.tsx";
import { ErrorBlock } from "./bits.tsx";
import { announce } from "../lib/guard/useAnnounce.ts";

interface TrackerReport {
  /** The envelope's hash, as the network would compute it. */
  hash: string | null;
  envelopeXdr: string;
  sourceAccount: string;
  envelopeSignatures: EnvelopeSignature[];
  state: MultisigApprovalState;
  /** Signatures on the envelope that no current account signer claims. */
  unmatched: string[];
  /** Timestamp of the latest live Horizon signer and threshold read. */
  signerReadAt: string | null;
  signerReadError: string | null;
  signerRuleChanges: string[];
}

function makeIncompleteState(reason: string): MultisigApprovalState {
  return evaluateApprovalState({
    signers: [],
    thresholds: null,
    signatures: [],
    incompleteReasons: [reason],
  });
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      document.body.removeChild(area);
      return true;
    } catch {
      return false;
    }
  }
}

export function MultisigTracker() {
  const { guard } = useGuard();
  const [xdr, setXdr] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<TrackerReport | null>(null);
  const [copied, setCopied] = useState<"hash" | "xdr" | null>(null);

  async function evaluateEnvelope(params: {
    hash: string | null;
    envelopeXdr: string;
    sourceAccount: string;
    envelopeSignatures: EnvelopeSignature[];
  }): Promise<TrackerReport> {
    const account = await readAccountSigners(createHorizonServer(), params.sourceAccount);
    if (!account.ok) {
      const signerReadError = `Could not read current signers and thresholds: ${account.error}`;
      return {
        ...params,
        state: makeIncompleteState(signerReadError),
        unmatched: [],
        signerReadAt: null,
        signerReadError,
        signerRuleChanges: [],
      };
    }

    const matched = matchEnvelopeSignatures(params.envelopeSignatures, account.value.signers);
    const state = evaluateApprovalState({
      signers: account.value.signers,
      thresholds: account.value.thresholds,
      signatures: matched.signatures,
      signatureDataComplete: matched.ambiguousHints.length === 0,
      incompleteReasons: account.value.incompleteReasons,
    });
    return {
      ...params,
      state,
      unmatched: unmatchedSignatures(params.envelopeSignatures, account.value.signers),
      signerReadAt: account.value.observedAt,
      signerReadError: null,
      signerRuleChanges: [],
    };
  }

  const analyse = useCallback(async () => {
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const trimmed = xdr.trim();
      if (trimmed.length === 0) {
        setError("Paste the pending transaction envelope XDR to track.");
        return;
      }

      // The account whose signers and thresholds decide the envelope's fate:
      // the guarded smart account is a contract, so its multisig configuration
      // lives on the *source account* the envelope is signed against — the
      // enterprise account configured for co-signing.
      const envelope = TransactionBuilder.fromXDR(trimmed, NETWORK.passphrase);
      const hash = toHex(envelope.hash());
      const sourceAccount = (envelope as unknown as { source: string }).source;

      const signatures = readEnvelopeSignatures(trimmed);
      if (!signatures.ok) {
        setError(`Could not decode signatures from the envelope: ${signatures.error}`);
        return;
      }
      const nextReport = await evaluateEnvelope({
        hash,
        envelopeXdr: trimmed,
        sourceAccount,
        envelopeSignatures: signatures.value,
      });
      setReport(nextReport);
      announce(
        nextReport.state.ready
          ? "Multisig envelope has enough signatures to submit"
          : `Multisig approval status: ${nextReport.state.evaluationStatus}. ${approvalSummary(nextReport.state)}`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [xdr]);

  const refreshSignerRules = async () => {
    if (!report) return;
    setBusy(true);
    setError(null);
    try {
      const refreshed = await evaluateEnvelope(report);
      if (report.signerReadAt !== null && refreshed.signerReadAt !== null) {
        refreshed.signerRuleChanges = signerRuleChanges(report.state, refreshed.state);
      }
      setReport(refreshed);
      announce(`Signer and threshold rules refreshed. ${approvalSummary(refreshed.state)}`);
    } finally {
      setBusy(false);
    }
  };

  const doCopy = async (kind: "hash" | "xdr") => {
    if (!report) return;
    const text = kind === "hash" ? (report.hash ?? "") : report.envelopeXdr;
    const ok = await copyText(text);
    setCopied(ok ? kind : null);
    if (ok) {
      announce(kind === "hash" ? "Transaction hash copied" : "Envelope XDR copied");
      window.setTimeout(() => setCopied(null), 1500);
    }
  };

  return (
    <div className="panel">
      <h2>Multisig approvals</h2>
      <p className="tiny muted">
        Accounts configured with Stellar multi-signature thresholds hold an admin transaction in
        pending state until the required co-signers sign the envelope. Paste the pending envelope
        XDR to see the collected signature weight against the threshold and who is still to sign.
      </p>

      <label className="field">
        <span className="lbl">Pending transaction envelope (base64 XDR)</span>
        <textarea
          value={xdr}
          onChange={(event) => setXdr(event.target.value)}
          placeholder="AAAAAgAAAAD…"
          style={{ height: 80 }}
          aria-label="Pending transaction envelope XDR"
        />
      </label>

      <div className="row">
        <button onClick={() => void analyse()} disabled={busy || xdr.trim().length === 0}>
          {busy ? "Reading account…" : "Check approvals"}
        </button>
        <button
          className="secondary"
          onClick={() => void refreshSignerRules()}
          disabled={busy || !report}
        >
          {busy && report ? "Refreshing rules…" : "Refresh signer rules"}
        </button>
      </div>

      {error && <ErrorBlock title="The envelope could not be tracked" detail={error} />}

      {report && (
        <>
          <div className="notice info" style={{ marginTop: 10 }}>
            <strong>
              {report.state.evaluationStatus === "supported"
                ? report.state.ready
                  ? "Threshold met"
                  : "Pending co-signatures"
                : report.state.evaluationStatus === "unsupported"
                  ? "Unsupported signer configuration"
                  : "Incomplete signer data"}
            </strong>
            <span className="tiny">{approvalSummary(report.state)}</span>
            {report.state.evaluationStatus === "supported" && (
              <div
                role="progressbar"
                aria-valuenow={approvalPercent(report.state)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Collected signature weight"
                style={{
                  marginTop: 8,
                  height: 8,
                  borderRadius: 999,
                  background: "var(--panel-2)",
                  border: "1px solid var(--line)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${approvalPercent(report.state)}%`,
                    height: "100%",
                    background: report.state.ready ? "var(--ok)" : "var(--accent)",
                  }}
                />
              </div>
            )}
          </div>

          <div className="notice" style={{ marginTop: 10 }}>
            <strong>Data sources</strong>
            <span className="tiny">
              Envelope signatures: parsed locally from the pasted XDR (
              {report.envelopeSignatures.length} signature(s)); not a chain read.
            </span>
            <span className="tiny">
              Current signer weights and thresholds:{" "}
              {report.signerReadAt
                ? `Horizon read at ${new Date(report.signerReadAt).toLocaleString()}.`
                : "unavailable."}
            </span>
            {report.signerReadError && <span className="tiny">{report.signerReadError}</span>}
            {report.state.evaluationReasons.map((reason) => (
              <span className="tiny" key={reason}>
                {reason}
              </span>
            ))}
          </div>

          {report.signerRuleChanges.length > 0 && (
            <div className="notice" role="status" style={{ marginTop: 10 }}>
              <strong>Signer rules changed since the previous live read</strong>
              {report.signerRuleChanges.map((change) => (
                <span className="tiny" key={change}>
                  {change}
                </span>
              ))}
              <span className="tiny muted">
                Approval was recalculated using the latest signer weights and thresholds.
              </span>
            </div>
          )}

          {report.hash && (
            <div className="row" style={{ marginTop: 10 }}>
              <span className="mono tiny" title={report.hash}>
                hash {report.hash.slice(0, 12)}…{report.hash.slice(-6)}
              </span>
              <button className="secondary" onClick={() => void doCopy("hash")}>
                {copied === "hash" ? "Copied" : "Copy hash"}
              </button>
              <button className="secondary" onClick={() => void doCopy("xdr")}>
                {copied === "xdr" ? "Copied" : "Copy envelope XDR"}
              </button>
            </div>
          )}

          <div className="notice" style={{ marginTop: 10 }}>
            <strong>Remaining signer weight</strong>
            <span className="tiny">{remainingWeightSummary(report.state)}</span>
            <ul className="tiny" style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {report.state.thresholds.map((threshold) => (
                <li key={threshold.level}>
                  {THRESHOLD_LABELS[threshold.level]} ({threshold.requiredWeight}):{" "}
                  {report.state.evaluationStatus !== "supported" ||
                  threshold.requiredWeight === null
                    ? "not evaluated"
                    : threshold.remainingWeight === null
                      ? "unknown"
                      : threshold.remainingWeight === 0
                        ? "met"
                        : `${threshold.remainingWeight} more weight required`}{" "}
                  <span className="muted">
                    (collected {threshold.collectedWeight}; required{" "}
                    {threshold.requiredWeight ?? "unknown"})
                  </span>
                </li>
              ))}
            </ul>
            {report.state.evaluationStatus === "supported" &&
              report.state.coverage === "unknown" && (
                <span className="tiny muted">
                  This account has signers whose signatures cannot be identified from an envelope
                  (hash, pre-auth, signed-payload or ambiguous-hint signers). Their signatures still
                  count on the network, so the remaining weight is a lower bound, not an exact
                  figure. Re-check after those co-signers report back.
                </span>
              )}
          </div>

          {report.state.duplicateSignatures.length > 0 && (
            <div className="notice" style={{ marginTop: 10 }}>
              <strong>
                {report.state.duplicateSignatures.length} signer(s) signed the envelope more than
                once
              </strong>
              <span className="tiny">
                Repeated signatures are counted once, exactly as the network counts them, so they do
                not inflate the collected weight.
              </span>
            </div>
          )}

          <p className="tiny muted" style={{ marginTop: 8 }}>
            {report.state.evaluationStatus === "supported"
              ? "Pass the hash and envelope to the remaining co-signers — each reviews and signs the same envelope, and only then can it be submitted."
              : "The dashboard cannot determine whether the current signature set meets account rules. Inspect the account configuration and rely on the network response for final validation."}
          </p>

          {report.unmatched.length > 0 && (
            <div className="notice">
              <strong>
                {report.unmatched.length} signature(s) match no current account signer
              </strong>
              <span className="tiny">
                These signature hints do not match a listed Ed25519 signer. They may belong to an
                unsupported signer kind or a removed signer; only the network can determine whether
                the envelope is valid.
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
