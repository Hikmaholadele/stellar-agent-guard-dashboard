"use client";

/**
 * The post-deploy checklist, composed on the Configure screen next to the
 * deploy/initialize/policy controls it tracks.
 *
 * Placement argument: every step's inline action lives here (deploy, install a
 * policy) or on the same page, and the live reads the steps derive from are the
 * chain — so keeping the wizard beside the controls that change them means a
 * completed step is one glance from the control that completed it. The Console
 * overview keeps its own `StatusPanel`, which carries the default-deny warning
 * independently of whether this wizard is dismissed.
 *
 * The one rule the component enforces on itself: step 4 is green only after the
 * operator's own live re-read confirms a policy. There is no local write that
 * marks it complete (mirroring `PanicPanel`'s mandatory on-chain re-read), so a
 * stale background snapshot can never turn it green on its own.
 *
 * The re-reads are *read-only* and are labelled as such (issue #394): an RPC
 * read can fail long after its write succeeded, and the recovery for that is
 * to re-read — never to replay `initialize` or the policy submission. Each
 * retry re-invokes exactly the failed read (`isInitialized`, or the
 * `status()`+`policy()` pair), keeps the step pending or in error until a fresh
 * chain result satisfies it, and is bound to the guard it started under so a
 * late answer for a guard the operator has left is discarded.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { isInitialized, readPolicy, readStatus, type ReadResult } from "../lib/guard/chain.ts";
import { deriveSetupSteps, readSetupState, writeSetupState } from "../lib/guard/setupChecklist.ts";
import { isDemoMode } from "../lib/guard/demoFixtures.ts";
import { useGuard } from "./GuardProvider.tsx";
import { ErrorBlock, short } from "./bits.tsx";

const MARKER: Record<string, string> = { done: "✓", pending: "○", error: "!" };
const STATE_TEXT: Record<string, string> = { done: "Done", pending: "Pending", error: "Error" };

export function SetupWizard() {
  const { server, guard, snapshot } = useGuard();
  const demo = isDemoMode();

  // The (two-key) stored state is keyed by guard and *derived* on a guard change
  // rather than re-hydrated in an effect, so switching guards cannot render one
  // frame of the previous guard's dismissal. The write path keeps the key pair
  // in sync.
  const [stored, setStored] = useState(() => ({ guard, value: readSetupState(guard) }));
  const persisted = stored.guard === guard ? stored.value : readSetupState(guard);
  const dismissed = persisted.dismissed;
  const deployedMarker = persisted.deployedMarker;

  const [initializedState, setInitializedState] = useState<{
    guard: string;
    value: ReadResult<boolean>;
  }>({ guard, value: { ok: false, error: "reading initialize state…" } });
  // Derived across a guard change rather than re-hydrated in an effect, so a
  // late answer for the previous guard can never render as this guard's state.
  // Memoised so the transient mismatch object cannot churn the memo below.
  const initializedRead = useMemo<ReadResult<boolean>>(
    () =>
      initializedState.guard === guard
        ? initializedState.value
        : { ok: false, error: "reading initialize state…" },
    [initializedState, guard],
  );
  // `initialize` is not exposed by `status()`, so it is read from the contract's
  // own storage. Demo mode makes no RPC call, so it reports that honestly rather
  // than inventing an answer.
  const initialized = useMemo<ReadResult<boolean>>(
    () =>
      demo
        ? {
            ok: false,
            error: "Demo mode shows static fixture data, so initialize state is not read.",
          }
        : initializedRead,
    [demo, initializedRead],
  );

  // The one read this component performs on its own, in its console shape.
  // Shared by the mount effect and the read-only retry button, so the retry
  // re-runs exactly the read that failed — nothing else.
  const fetchInitialized = useCallback(
    async (target: string): Promise<ReadResult<boolean>> => {
      try {
        return { ok: true, value: await isInitialized(server, target) };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    [server],
  );
  const [rereadingInitialized, setRereadingInitialized] = useState(false);
  const rereadInitialized = useCallback(async () => {
    if (demo) return; // demo mode never touches RPC, so there is nothing to re-read
    const target = guard;
    setRereadingInitialized(true);
    try {
      const value = await fetchInitialized(target);
      setInitializedState({ guard: target, value });
    } finally {
      setRereadingInitialized(false);
    }
  }, [demo, guard, fetchInitialized]);

  // Held in component state (keyed by guard), never persisted: the verify step
  // derives from a live read the operator asked for, and a reload re-asks.
  const [verification, setVerification] = useState<{
    guard: string;
    value: ReadResult<{ hasPolicy: boolean }> | null;
  }>({ guard, value: null });
  const verified = verification.guard === guard ? verification.value : null;
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    if (demo) return;
    let cancelled = false;
    void fetchInitialized(guard).then((value) => {
      if (!cancelled) setInitializedState({ guard, value });
    });
    return () => {
      cancelled = true;
    };
  }, [guard, demo, fetchInitialized]);

  const steps = useMemo(
    () =>
      deriveSetupSteps({
        deployedMarker,
        initialized,
        status: snapshot?.status ?? { ok: false, error: "Reading the chain…" },
        policy: snapshot?.policy ?? { ok: false, error: "Reading the chain…" },
        verified,
      }),
    [deployedMarker, initialized, snapshot, verified],
  );

  const verify = useCallback(async () => {
    setVerifying(true);
    try {
      // A live re-read, not the polled snapshot: the point of the step is that
      // the operator asked the chain right now. It reads `status()` and
      // `policy()` and nothing else — a failed verification is retried by
      // re-reading, never by repeating the writes that got the account here.
      const [status, policy] = await Promise.all([
        readStatus(server, guard),
        readPolicy(server, guard),
      ]);
      if (!status.ok) setVerification({ guard, value: { ok: false, error: status.error } });
      else if (!policy.ok) setVerification({ guard, value: { ok: false, error: policy.error } });
      else
        setVerification({
          guard,
          value: { ok: true, value: { hasPolicy: status.value.has_policy } },
        });
    } finally {
      setVerifying(false);
    }
  }, [server, guard]);

  const persist = useCallback(
    (patch: Parameters<typeof writeSetupState>[1]) => {
      setStored({ guard, value: writeSetupState(guard, patch) });
    },
    [guard],
  );

  const dismiss = useCallback(() => persist({ dismissed: true }), [persist]);
  const restore = useCallback(() => persist({ dismissed: false }), [persist]);

  if (dismissed) {
    // Dismissed hides the *checklist*, not the truth: `StatusPanel` derives its
    // default-deny warning from `status()`, so a missing policy stays visible.
    return (
      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <p className="tiny muted" style={{ margin: 0 }}>
            Post-deploy checklist hidden.
          </p>
          <button className="secondary" onClick={restore}>
            Show setup checklist
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Post-deploy checklist</h2>
        <button className="secondary" onClick={dismiss}>
          Dismiss
        </button>
      </div>

      <p className="tiny muted" style={{ marginTop: 8 }}>
        Every step below is derived from a live read of the chain — nothing here is remembered
        except that you dismissed it and the address predicted at deploy time. A step cannot stay
        green after the chain says otherwise.
      </p>

      <ol className="setup-steps" data-testid="setup-steps" aria-label="Post-deploy setup steps">
        {steps.map((step) => (
          <li key={step.id} data-step={step.id} data-state={step.state} className="setup-step">
            <span className={`setup-status ${step.state}`}>
              <span aria-hidden="true">{MARKER[step.state]}</span> {STATE_TEXT[step.state]}
            </span>
            {" — "}
            <span className="setup-label">{step.label}</span>
            <span className="setup-detail tiny muted">{step.detail}</span>
            <span className="row" style={{ marginTop: 4 }}>
              {step.id === "deployed" && <Link href="#deploy">Deploy a guard</Link>}
              {step.id === "initialized" && (
                <>
                  <Link href="#deploy">Initialize in the deploy panel</Link>
                  {!demo && (
                    <button
                      className="secondary"
                      onClick={() => void rereadInitialized()}
                      disabled={rereadingInitialized}
                    >
                      {rereadingInitialized
                        ? "Re-reading… (read-only)"
                        : "Re-read initialize state (read-only)"}
                    </button>
                  )}
                </>
              )}
              {step.id === "policy" && <Link href="#policy">Install a policy</Link>}
              {step.id === "verified" && (
                <button className="secondary" onClick={() => void verify()} disabled={verifying}>
                  {verifying ? "Re-reading… (read-only)" : "Re-verify status & policy (read-only)"}
                </button>
              )}
            </span>
          </li>
        ))}
      </ol>

      {initialized.ok && !initialized.value && (
        <p className="tiny muted">
          Reading <span className="mono">initialize</span> from the contract&apos;s own storage is
          the only way to know it has run — <span className="mono">status()</span> does not expose
          it.
        </p>
      )}

      {verified && !verified.ok && (
        <ErrorBlock
          title="The verification read failed"
          detail={`${verified.error} — step 4 stays pending; the read-only retry below re-reads the chain (it never repeats initialize or the policy submission), and only a confirmed read turns this green.`}
        />
      )}

      <p className="tiny muted" style={{ marginTop: 8 }}>
        Completion &amp; next steps: see the{" "}
        <a
          href="https://github.com/aigbagbobila/stellar-agent-guard-sdk"
          target="_blank"
          rel="noreferrer"
        >
          agent documentation
        </a>{" "}
        for wiring the SDK and running the agent against this guard. Wizard state for this guard (
        <span className="mono">{short(guard, 8, 6)}</span>) is stored with exactly two fields:
        dismissed + deploy marker.
      </p>
    </div>
  );
}
