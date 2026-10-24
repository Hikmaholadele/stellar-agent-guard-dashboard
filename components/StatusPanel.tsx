"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { deadManRemaining, describePolicy, isDeadManFrozen } from "stellar-agent-guard-sdk";
import { useGuard } from "./GuardProvider.tsx";
import {
  ErrorBlock,
  Read,
  ReadSkeleton,
  ReadWithRetry,
  Skeleton,
  Stat,
  TimeAgo,
  WarningBanner,
  short,
} from "./bits.tsx";
import { INITIAL_GRID_LABELS, skeletonSpecFor } from "../lib/guard/statusReadState.ts";
import { CopyButton } from "./CopyButton.tsx";
import { StorageExplorerButton } from "./StorageExplorer.tsx";
import { WebhookAlertBridge } from "./WebhookAlertBridge.tsx";
import { WebhookSettingsButton } from "./WebhookSettings.tsx";
import { PHASE1_ARTIFACT, NETWORK } from "../lib/guard/network.ts";
import { buildReadDiagnostic } from "../lib/rpc/timeouts.ts";
import { configureHref } from "../lib/guard/deeplink.ts";
import { NO_POLICY_CONSEQUENCE, policyStateFrom } from "../lib/guard/policyState.ts";
import { compilePrintReport } from "../lib/guard/printReport.ts";
import {
  SCENARIO_LABELS,
  describeSimulation,
  simulatedAlert,
  simulatedStatus,
  tickScenario,
  type SimulationScenario,
  type SimulationState,
} from "../lib/guard/dmsSimulator.ts";
import {
  evaluateDmsAlert,
  formatDmsDuration,
  projectDmsAlert,
  type DmsAlert,
} from "../lib/guard/dmsAlert.ts";
import { resolveReferenceTime, type LedgerClockReading } from "../lib/guard/ledgerTime.ts";
import { calculateVelocity } from "../lib/guard/velocity.ts";
import { useStatusTransitionAnnouncer } from "../lib/guard/statusTransitions.ts";
import { usePrivacy } from "../lib/guard/privacyStore.ts";

/**
 * The banner's own clock tick.
 *
 * Scoped to the banner (mounted only while a countdown is running) so a
 * once-a-second update cannot re-render the whole state panel. Every render
 * reads the clock inside this hook, never during someone else's render.
 */
function useNowSecs(): number {
  const [nowSecs, setNowSecs] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = window.setInterval(() => setNowSecs(Math.floor(Date.now() / 1000)), 1_000);
    return () => window.clearInterval(id);
  }, []);
  return nowSecs;
}

/**
 * The proactive dead-man-switch deadline banner, shown above the on-chain
 * state panel while the switch is counting down to its threshold.
 *
 * Escalates with the remaining grace — yellow warning, red pulsing critical,
 * dark red once tripped — and always states the full ledger-derived timeline:
 * remaining time, time since the last heartbeat, and the estimated calendar
 * moment of expiration. Every number comes from the snapshot's ledger clock,
 * never the browser's, because that is the clock the contract judges.
 *
 * Between polls the countdown advances against a resolved reference time
 * (issue #388): a fresh ledger reading keeps the countdown chain-derived and
 * exact, while a stale reading freezes at the last chain value and is marked
 * with its age instead of asserting an expiry the chain has not confirmed.
 */
function DmsAlertBanner({
  alert,
  reading,
}: {
  alert: DmsAlert;
  /** The ledger clock at read time; null when no status read succeeded. */
  reading: LedgerClockReading | null;
}) {
  const nowSecs = useNowSecs();
  const reference = useMemo(() => resolveReferenceTime(reading, nowSecs), [reading, nowSecs]);
  const projected = projectDmsAlert(alert, reference);
  // A chain reading that outlived the freshness bound is a stale read (#389):
  // the projection already freezes its numbers at the last chain value and
  // refuses to state an exact expiry; this flag adds the explicit "stale read"
  // note so the operator knows to refresh rather than read the figures as a
  // fresh deadline.
  const stale = reference.source === "ledger" && !reference.authoritative;

  const details: string[] = [];
  if (projected.remainingSecs !== null && alert.totalSecs !== null) {
    const pct = Math.max(0, Math.round((projected.fractionRemaining ?? 0) * 100));
    details.push(
      projected.level === "expired"
        ? `deadline missed by ${formatDmsDuration(-projected.remainingSecs)}`
        : `${formatDmsDuration(projected.remainingSecs)} of grace left (${pct}%)`,
    );
  }
  if (alert.elapsedSecs !== null) {
    details.push(`last heartbeat ${formatDmsDuration(Math.max(0, alert.elapsedSecs))} ago`);
  }
  // The reference's age and source are always stated: an operator must be able
  // to see whether the countdown in front of them is chain-verified or an
  // estimate over an old read (issue #388).
  if (projected.exact) {
    details.push(
      `chain time read ${formatDmsDuration(projected.ageSecs ?? 0)} ago — expiry is chain-verified`,
    );
  } else if (projected.source === "ledger") {
    details.push(
      `estimate: chain time is ${formatDmsDuration(projected.ageSecs ?? 0)} old — the deadline may already have passed`,
    );
  } else {
    details.push("no chain time available — countdown runs on the browser clock, not the ledger");
  }
  if (alert.expiresAtMs !== null) {
    const prefix = !projected.exact
      ? "last chain-derived deadline ≈"
      : projected.level === "expired"
        ? "deadline was ≈"
        : "expires ≈";
    details.push(`${prefix} ${new Date(alert.expiresAtMs).toLocaleString()}`);
  }

  const title =
    projected.level === "expired"
      ? "Dead-man switch expired — the agent missed its heartbeat; agent activity is blocked until the heartbeat resumes"
      : projected.level === "critical"
        ? "Dead-man switch critical — heartbeat deadline imminent"
        : "Dead-man switch warning — heartbeat deadline approaching";

  return (
    <div className={`dms-banner no-print ${projected.level}`} role="alert">
      <strong>{title}</strong>
      {details.length > 0 && <span className="detail">{details.join(" · ")}</span>}
      {stale && (
        <span className="detail" data-testid="dms-stale-note">
          stale read — these figures are from the last successful ledger read, not a new one; they
          are not a fresh deadline. Refresh to re-read the chain.
        </span>
      )}
    </div>
  );
}

/**
 * Copyable failure context (issue #347).
 *
 * A bare RPC error is hard to report and easy to over-share, so each failed read
 * contributes a four-line diagnostic — operation, endpoint origin, network and
 * correlation time — with signed payloads and credentials already removed by
 * the chain layer. It is a report about a failure, never a stand-in for a value.
 */
function ReadDiagnostics({ entries }: { entries: Array<{ label: string; text: string }> }) {
  if (entries.length === 0) return null;
  return (
    <section className="no-print" aria-label="Read diagnostics" style={{ marginTop: 16 }}>
      <h3 style={{ marginTop: 0 }}>
        Diagnostics for the failed {entries.length === 1 ? "read" : "reads"}
      </h3>
      <p className="tiny muted">
        Safe to paste into a report: the operation, endpoint origin, network and correlation time.
        Signed XDR, authorization payloads and key material are removed.
      </p>
      {entries.map((entry) => (
        <div key={entry.label} style={{ marginTop: 8 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="tiny">{entry.label}</span>
            <CopyButton value={entry.text} label={`${entry.label} diagnostics`} />
          </div>
          <pre className="mono tiny" style={{ whiteSpace: "pre-wrap", margin: 0 }}>
            {entry.text}
          </pre>
        </div>
      ))}
    </section>
  );
}

/**
 * The guard's live state, every field read from the chain on each refresh.
 *
 * The two freezes are shown separately rather than as one "frozen" light,
 * because they have different causes and the same single reversal is worth
 * knowing about: an admin freeze is something the operator just did, while a
 * dead-man-switch freeze is the account having gone quiet. `unfreeze()` clears
 * both, which is why it sits next to the panic button.
 *
 * The no-policy state gets a banner of its own, for the opposite reason: it is
 * the one state that is safe and useless at the same time, and a quiet
 * `has_policy: false` line is what a fresh deploy (or a just-revoked policy)
 * looks like when the operator needs to know that nothing can move.
 *
 * Incident Simulation Mode (rehearsal) overlays synthetic dead-man states on
 * this panel for training. The overlay is render-only: it wraps the same read
 * results in a `simulatedStatus` projection and stamps a striped watermark
 * across the panel, so no write path can be reached while it is active.
 */
export function StatusPanel() {
  const { snapshot, snapshotError, refreshing, refresh, guard, wallet, retryRead, retryingField } =
    useGuard();

  useStatusTransitionAnnouncer(snapshot);

  const printReport = snapshot
    ? compilePrintReport(snapshot, NETWORK.name, wallet?.address || "Disconnected")
    : null;
  // Derived from this render's read, never from an event: a revoke done here, in
  // another tab, or by the agent's own tooling shows up on the next poll. An
  // unreadable `status()` yields `unknown`, which claims nothing.
  const policyState = policyStateFrom(snapshot?.status);

  // Proactive deadline alert: evaluated only from a successful status read (a
  // failed read must never fabricate a countdown), with a failed policy read
  // degrading to "no countdown numbers" rather than a guessed one.
  const dmsAlert =
    snapshot && snapshot.status.ok
      ? evaluateDmsAlert(snapshot.status.value, snapshot.policy.ok ? snapshot.policy.value : null)
      : null;

  // The ledger clock at the moment of the read (`status().now`) paired with
  // when the read happened: the anchor the banner's countdown is judged
  // against (issue #388). Chain state stays authoritative; the browser clock
  // only measures how old the reading is.
  const ledgerReading = useMemo<LedgerClockReading | null>(
    () =>
      snapshot && snapshot.status.ok
        ? {
            ledgerNowSecs: Number(snapshot.status.value.now),
            readAtSecs: Math.floor(Date.parse(snapshot.fetchedAt) / 1000),
          }
        : null,
    [snapshot],
  );

  // The panel is `aria-busy` exactly while the first read is in flight (no
  // snapshot yet, no failure yet). A background refresh is NOT busy: the values
  // on screen are the previous successful read (stale-while-revalidate), so
  // re-announcing "busy" on every poll would only be noise.
  const initialLoadPending = snapshot === null && snapshotError === null;

  // Watermark only: the panel gains the striped training tint while a rehearsal
  // is running. Read from the store as a snapshot, never as a ref.
  const rehearsalActive = useRehearsalActive();
  const { masked } = usePrivacy();

  // Safe failure context (issue #347). The chain layer attaches a diagnostic to
  // each failed read; a refresh that never produced a snapshot contributes one
  // built from the configured endpoint. Nothing here carries chain values, so a
  // diagnostic can never be mistaken for state.
  const readDiagnostics: Array<{ label: string; text: string }> = [];
  if (snapshot) {
    const results = [
      ["status()", snapshot.status],
      ["policy()", snapshot.policy],
      ["window", snapshot.window],
      ["wasm identity", snapshot.identity],
    ] as const;
    for (const [label, result] of results) {
      if (!result.ok && result.diagnostic) readDiagnostics.push({ label, text: result.diagnostic });
    }
  } else if (snapshotError) {
    readDiagnostics.push({
      label: "guard snapshot",
      text: buildReadDiagnostic({
        operation: "readSnapshot",
        endpoint: NETWORK.rpcUrl,
        network: NETWORK.name,
      }).text,
    });
  }

  return (
    <>
      {dmsAlert && dmsAlert.level !== "none" && (
        <DmsAlertBanner alert={dmsAlert} reading={ledgerReading} />
      )}
      <div
        className={`panel${rehearsalActive ? " sim-active" : ""}`}
        aria-busy={initialLoadPending}
      >
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>On-chain state</h2>

          <div className="row">
            {snapshot && (
              <span className="tiny muted">
                read <TimeAgo iso={snapshot.fetchedAt} />
              </span>
            )}
            <StorageExplorerButton />
            <WebhookSettingsButton />
            <WebhookAlertBridge />
            <button className="secondary no-print" onClick={() => window.print()}>
              Print Compliance Report
            </button>
            <button
              className="secondary no-print"
              onClick={() => void refresh()}
              disabled={refreshing}
            >
              {refreshing ? "Reading…" : "Refresh"}
            </button>
          </div>
        </div>

        <p className="tiny muted" style={{ marginTop: 10 }}>
          <span className="mono" aria-label={masked ? "Masked guard address" : undefined}>
            {masked ? "••••••••••••••••" : guard}
          </span>{" "}
          <CopyButton value={guard} label="guard address" />
        </p>

        <RehearsalModeToggle />

        {snapshotError && (
          <ErrorBlock
            title="The guard's state could not be read"
            detail={`${snapshotError} — no values are shown, because a failed read is not an empty policy.`}
          />
        )}

        {!snapshot && !snapshotError && (
          /* First-paint skeleton, before the first snapshot lands. The grid is
             shaped like the resolved one — same labels, same value/note slots
             (via skeletonSpecFor) — so the panel's height does not collapse
             and jump when the reads resolve. The placeholders carry no values:
             pending text is skeleton geometry, never a number (no fake zeros). */
          <div className="grid" style={{ marginTop: 12 }}>
            {INITIAL_GRID_LABELS.map((label) => (
              <div className="stat" key={label} aria-hidden="true">
                <div className="k">{label}</div>
                <div className="v">
                  <Skeleton lines={skeletonSpecFor(label).lines} />
                </div>
              </div>
            ))}
          </div>
        )}

        {policyState === "default-deny" && (
          <WarningBanner
            title="No policy installed — this account is in default-deny"
            action={
              <Link className="cta" href={configureHref(guard)}>
                Configure a policy for this account
              </Link>
            }
          >
            <span className="tiny">{NO_POLICY_CONSEQUENCE}</span>
          </WarningBanner>
        )}

        {snapshot && (
          <>
            <SimulatedDmsStats
              snapshot={snapshot}
              policyState={policyState}
              retryRead={retryRead}
              retryingField={retryingField}
            />

            <h3>Rolling window</h3>
            {retryingField === "window" && <ReadSkeleton label="window" />}
            <ReadWithRetry
              result={snapshot.window}
              label="Window"
              onRetry={() => void retryRead("window")}
              retrying={retryingField === "window"}
              render={(window) => {
                const policy = snapshot.policy.ok ? snapshot.policy.value : null;
                if (!window || !policy) {
                  return (
                    <p className="tiny muted">
                      No spend recorded yet in this policy&apos;s window.
                    </p>
                  );
                }
                const cap = policy.window_cap;
                const pct = cap > 0n ? Number((window.total * 100n) / cap) : null;

                const now = snapshot.status.ok ? snapshot.status.value.now : null;
                let velocityStats = null;
                if (now !== null) {
                  const remaining =
                    cap > 0n ? (cap > window.total ? cap - window.total : 0n) : null;
                  const metrics = calculateVelocity(window.entries, now, remaining);
                  const exhaust = metrics.exhaustionMinutes;

                  // orange/red if exhaustion < 30 minutes
                  const isCritical = exhaust !== null && exhaust < 30;
                  const velocityTone = isCritical ? "danger" : "ok";

                  velocityStats = (
                    <>
                      <h4 style={{ marginTop: 20 }}>Spending Velocity</h4>
                      <div className="grid">
                        <Stat
                          label="1m Velocity"
                          value={masked ? "••••••" : metrics.spend1m.toString()}
                        />
                        <Stat
                          label="15m Velocity"
                          value={masked ? "••••••" : metrics.spend15m.toString()}
                          tone={isCritical ? "danger" : undefined}
                          note={
                            exhaust !== null
                              ? `Cap exhaustion in ~${Math.round(exhaust)}m`
                              : undefined
                          }
                        />
                        <Stat
                          label="1h Velocity"
                          value={masked ? "••••••" : metrics.spend1h.toString()}
                        />
                      </div>
                      {cap > 0n && (
                        <div style={{ marginTop: 12 }}>
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              fontSize: "0.8em",
                              marginBottom: 4,
                            }}
                          >
                            <span>Window Utilization</span>
                            <span style={{ color: isCritical ? "var(--danger)" : undefined }}>
                              {pct}%
                            </span>
                          </div>
                          <div
                            style={{
                              width: "100%",
                              backgroundColor: "#222",
                              height: 12,
                              borderRadius: 6,
                              overflow: "hidden",
                            }}
                          >
                            <div
                              style={{
                                width: `${Math.min(pct || 0, 100)}%`,
                                backgroundColor: isCritical
                                  ? "var(--danger)"
                                  : pct && pct > 80
                                    ? "var(--warn)"
                                    : "var(--ok)",
                                height: "100%",
                                transition: "width 0.3s ease",
                              }}
                            />
                          </div>
                        </div>
                      )}
                    </>
                  );
                }

                return (
                  <>
                    <div className="grid">
                      <Stat
                        label="Spent in window"
                        value={masked ? "••••••" : window.total.toString()}
                        note={pct === null ? "no window cap set" : `${pct}% of the ${cap} cap`}
                      />
                      <Stat
                        label="Window length"
                        value={`${policy.window_secs}s`}
                        note={`${window.entries.length} entry(ies) on the ledger`}
                      />
                    </div>
                    {velocityStats}
                  </>
                );
              }}
            />

            <h3>Policy in force</h3>
            {retryingField === "policy" && <ReadSkeleton label="policy" />}
            <ReadWithRetry
              result={snapshot.policy}
              label="policy()"
              onRetry={() => void retryRead("policy")}
              retrying={retryingField === "policy"}
              render={(policy) =>
                policy === null ? (
                  // Not muted: this is the state of the account, not a footnote
                  // under it. The consequence is spelled out in the banner above.
                  <p className="tiny">
                    <strong>No policy is stored on this account</strong> — nothing has been
                    installed, or it was revoked. The account is in default-deny until a policy is
                    installed.
                  </p>
                ) : (
                  <>
                    <p className="tiny mono">{describePolicy(policy)}</p>
                    <div className="grid">
                      <Stat
                        label="Per-transaction cap"
                        value={
                          masked
                            ? "••••••"
                            : policy.per_tx_cap === 0n
                              ? "off"
                              : policy.per_tx_cap.toString()
                        }
                      />
                      <Stat
                        label="Rolling cap"
                        value={
                          masked
                            ? "••••••"
                            : policy.window_cap === 0n
                              ? "off"
                              : `${policy.window_cap} / ${policy.window_secs}s`
                        }
                      />
                      <Stat
                        label="Assets"
                        value={policy.assets.length}
                        note="SAC tokens whose transfers are fully enforced"
                      />
                      <Stat
                        label="Recipients"
                        value={policy.allow_any_recipient ? "any" : policy.recipients.length}
                        note={
                          policy.allow_any_recipient
                            ? "allowlist bypassed"
                            : "allowlisted destinations"
                        }
                      />
                      <Stat
                        label="Protocols"
                        value={policy.protocols.length}
                        note="allowlisted non-asset contracts"
                      />
                      <Stat
                        label="Account"
                        value={policy.paused ? "PAUSED" : "active"}
                        tone={policy.paused ? "warn" : undefined}
                        note={
                          policy.active_from === 0n && policy.active_until === 0n
                            ? "no active window"
                            : `active ${policy.active_from}–${policy.active_until}`
                        }
                      />
                    </div>
                  </>
                )
              }
            />

            <h3>Artifact identity</h3>
            {retryingField === "identity" && <ReadSkeleton label="identity" />}
            <ReadWithRetry
              result={snapshot.identity}
              label="wasm identity"
              onRetry={() => void retryRead("identity")}
              retrying={retryingField === "identity"}
              render={(identity) => (
                <>
                  <div className="grid">
                    <Stat
                      label="Ledger reports"
                      value={
                        <>
                          <span className="mono tiny no-print">
                            {short(identity.reportedWasmHash ?? "-", 10, 6)}
                          </span>
                          <span className="mono tiny print-only">
                            {identity.reportedWasmHash ?? "-"}
                          </span>
                        </>
                      }
                    />
                    <Stat
                      label="Fetched bytes hash to"
                      value={
                        <>
                          <span className="mono tiny no-print">
                            {short(identity.fetchedSha256, 10, 6)}
                          </span>
                          <span className="mono tiny print-only">{identity.fetchedSha256}</span>
                        </>
                      }
                    />
                    <Stat label="Bytecode size" value={identity.bytes} note="bytes" />
                    <Stat
                      label="Pinned Phase 1 artifact"
                      tone={identity.reportedWasmHash === PHASE1_ARTIFACT.wasmHash ? "ok" : "warn"}
                      value={
                        identity.reportedWasmHash === PHASE1_ARTIFACT.wasmHash
                          ? "match"
                          : "different artifact"
                      }
                      note={
                        identity.reportedWasmHash === PHASE1_ARTIFACT.wasmHash
                          ? "byte-for-byte the artifact Phase 1 proved"
                          : "this instance is not the artifact Phase 1 proved"
                      }
                    />
                  </div>
                </>
              )}
            />
          </>
        )}

        <ReadDiagnostics entries={readDiagnostics} />

        {printReport && (
          <div className="print-only print-report">
            <h2>Compliance Audit Report</h2>
            <p>
              <strong>Timestamp:</strong> {printReport.timestamp}
            </p>
            <p>
              <strong>Network:</strong> {printReport.network}
            </p>
            <p>
              <strong>Contract ID:</strong> <span className="mono">{printReport.contractId}</span>
            </p>
            <p>
              <strong>Bytecode Hash:</strong>{" "}
              <span className="mono">{printReport.bytecodeHash}</span>
            </p>
            <p>
              <strong>Admin Key:</strong> <span className="mono">{printReport.adminKey}</span>
            </p>
            <p>
              <strong>DMS Status:</strong> {printReport.dmsStatus}
            </p>
            <p>
              <strong>Policy Rules:</strong> {printReport.policyRules}
            </p>
            <div>
              <strong>Allowlists:</strong>
              <ul>
                <li>Assets: {printReport.allowlists.assets.join(", ") || "None"}</li>
                <li>Recipients: {printReport.allowlists.recipients.join(", ") || "None"}</li>
                <li>Protocols: {printReport.allowlists.protocols.join(", ") || "None"}</li>
              </ul>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Rehearsal state lives in a module-scoped store rather than in StatusPanel's
 * own `useState`: the watermark must wrap the whole panel (so the toggle is
 * inside it) while the state belongs to the rehearsal, not to one render tree
 * position. `useSyncExternalStore` keeps the subscription explicit, and the
 * clock tick lives *in* the store — so every component renders purely from a
 * snapshot and no render ever reads a ref or the wall clock.
 */

interface RehearsalStore {
  active: boolean;
  scenario: SimulationScenario | null;
  startedAt: number | null;
  /** The store's own clock: when the tick loop last advanced, 0 when idle. */
  now: number;
}

const IDLE_REHEARSAL: RehearsalStore = { active: false, scenario: null, startedAt: null, now: 0 };

let rehearsal: RehearsalStore = IDLE_REHEARSAL;
const rehearsalListeners = new Set<() => void>();

function setRehearsal(next: RehearsalStore) {
  rehearsal = next;
  for (const listener of rehearsalListeners) listener();
}

export function startRehearsal(scenario: SimulationScenario, startedAt: number) {
  setRehearsal({ active: true, scenario, startedAt, now: startedAt });
}

export function stopRehearsal() {
  setRehearsal(IDLE_REHEARSAL);
}

/** Advance the store's clock; called from the tick interval, never render. */
function advanceRehearsal(now: number) {
  if (!rehearsal.active) return;
  setRehearsal({ ...rehearsal, now });
}

/** Test seam: read the store without a component. */
export function rehearsalState(): RehearsalStore {
  return rehearsal;
}

function subscribeRehearsal(onStoreChange: () => void): () => void {
  rehearsalListeners.add(onStoreChange);
  return () => rehearsalListeners.delete(onStoreChange);
}

function useRehearsalActive(): boolean {
  return useSyncExternalStore(
    subscribeRehearsal,
    () => rehearsal.active,
    () => false,
  );
}

/** The rehearsal store snapshot; the server snapshot is the stable idle value. */
function useRehearsalStore(): RehearsalStore {
  return useSyncExternalStore(
    subscribeRehearsal,
    () => rehearsal,
    () => IDLE_REHEARSAL,
  );
}

/**
 * The rehearsal toggle, shown only where a rehearsal makes sense.
 *
 * The issue scopes this to development/staging environments; production
 * deployments (where the button would train people against real money) never
 * render it. `NODE_ENV` is inlined by the Next.js build, so the toggle
 * disappears entirely from production bundles.
 */
function RehearsalModeToggle() {
  const store = useRehearsalStore();
  const isProd = process.env.NODE_ENV === "production";

  // The simulation's heartbeat: while a run is active, the store's clock
  // advances once per second, which re-renders exactly the components reading
  // the store. `Date.now()` only ever runs inside this interval callback, so
  // no render is impure.
  useEffect(() => {
    if (!store.active) return;
    const interval = window.setInterval(() => advanceRehearsal(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [store.active]);

  if (isProd) return null;

  function start(scenario: SimulationScenario) {
    startRehearsal(scenario, Date.now());
  }

  return (
    <div
      className="sim-controls no-print"
      role="group"
      aria-label="Incident simulation (rehearsal) controls"
    >
      <span className="tiny muted">Rehearsal mode:</span>
      {store.active ? (
        <button className="secondary" type="button" onClick={() => stopRehearsal()}>
          Stop simulation
        </button>
      ) : (
        <>
          <button
            className="secondary"
            type="button"
            onClick={() => start("expiring")}
            title={SCENARIO_LABELS.expiring}
          >
            Simulate DMS expiring
          </button>
          <button
            className="secondary"
            type="button"
            onClick={() => start("tripped")}
            title={SCENARIO_LABELS.tripped}
          >
            Simulate DMS tripped
          </button>
        </>
      )}
    </div>
  );
}

/**
 * The on-chain state grid, real or rehearsed.
 *
 * When a rehearsal is running, the store's clock advances once per second (see
 * the tick loop in `RehearsalModeToggle`) and this component renders the
 * synthetic projection from that snapshot; every other Stat on the panel keeps
 * rendering the real reads. The banner, the alert line, and the watermark make
 * it impossible to mistake the two.
 */
function SimulatedDmsStats({
  snapshot,
  policyState,
  retryRead,
  retryingField,
}: {
  snapshot: NonNullable<ReturnType<typeof useGuard>["snapshot"]>;
  policyState: ReturnType<typeof policyStateFrom>;
  retryRead: ReturnType<typeof useGuard>["retryRead"];
  retryingField: ReturnType<typeof useGuard>["retryingField"];
}) {
  const store = useRehearsalStore();
  const real = (
    <RealDmsStats
      snapshot={snapshot}
      policyState={policyState}
      retryRead={retryRead}
      retryingField={retryingField}
    />
  );

  const status = snapshot.status.ok ? snapshot.status.value : null;

  // A rehearsal projects a real read; with no successful status read there is
  // nothing to project, so the real grid (which renders the read's own error)
  // stays put.
  if (!status || !store.active || store.scenario === null || store.startedAt === null) {
    return real;
  }

  const state: SimulationState = tickScenario(store.scenario, store.startedAt, store.now);
  const simulated = simulatedStatus(status, state);
  const alert = simulatedAlert(state);

  return (
    <>
      <div className="sim-banner" role="status">
        <strong>TRAINING / SIMULATION MODE</strong>
        <span className="tiny">
          {describeSimulation(state)} — values below are synthetic; the chain is untouched.
        </span>
      </div>

      <div className="grid" style={{ marginTop: 12 }}>
        <Stat
          label="Admin freeze"
          tone={simulated.admin_frozen ? "danger" : "ok"}
          value={simulated.admin_frozen ? "FROZEN" : "clear"}
          note="Set by the panic button; cleared by unfreeze()"
        />
        <Stat
          label="Dead-man switch"
          tone={state.phase === "fired" ? "danger" : state.phase === "expired" ? "warn" : "ok"}
          value={
            state.phase === "fired"
              ? "FIRED"
              : state.phase === "expired"
                ? "expired"
                : "within grace"
          }
          note={
            <span className="sim-countdown">
              <span
                className="sim-bar"
                role="progressbar"
                aria-valuenow={Math.round(state.percentElapsed)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Simulated grace consumed"
                style={{ ["--sim-pct" as string]: `${state.percentElapsed}%` }}
              />
              <span className="tiny">
                {state.remaining > 0
                  ? `SIMULATED: ${Math.ceil(state.remaining)}s of grace left`
                  : state.phase === "expired"
                    ? "SIMULATED: grace elapsed; account refuses calls"
                    : "SIMULATED: FIRED"}
              </span>
            </span>
          }
        />
        <Stat
          label="Policy installed"
          tone={policyState === "default-deny" ? "warn" : undefined}
          value={simulated.has_policy ? "yes" : "no — default deny"}
          note="With no policy the account refuses every call"
        />
        <Stat
          label="Last heartbeat"
          value={
            simulated.last_heartbeat === 0n
              ? "never"
              : `${Number(simulated.last_heartbeat)} (simulated ledger time)`
          }
          note={`agent silent ${Math.round(state.elapsed)}s in this scenario`}
        />
      </div>

      <div
        className={`sim-alert ${alert.severity === "danger" ? "sim-alert-danger" : "sim-alert-warn"}`}
        aria-live="polite"
      >
        <span className="tiny mono">{alert.message}</span>
      </div>

      <button
        className="secondary no-print"
        type="button"
        onClick={() => stopRehearsal()}
        style={{ marginTop: 8 }}
      >
        End simulation — return to live state
      </button>
    </>
  );
}

/** The untouched, real DMS stats — exactly what the panel shows when idle. */
function RealDmsStats({
  snapshot,
  policyState,
  retryRead,
  retryingField,
}: {
  snapshot: NonNullable<ReturnType<typeof useGuard>["snapshot"]>;
  policyState: ReturnType<typeof policyStateFrom>;
  retryRead: ReturnType<typeof useGuard>["retryRead"];
  retryingField: ReturnType<typeof useGuard>["retryingField"];
}) {
  return (
    <div className="grid" style={{ marginTop: 12 }}>
      <Stat
        label="Admin freeze"
        tone={
          snapshot.status.ok ? (snapshot.status.value.admin_frozen ? "danger" : "ok") : undefined
        }
        value={
          <ReadWithRetry
            result={snapshot.status}
            label="status()"
            onRetry={() => void retryRead("status")}
            retrying={retryingField === "status"}
            render={(status) => (status.admin_frozen ? "FROZEN" : "clear")}
          />
        }
        note="Set by the panic button; cleared by unfreeze()"
      />
      <Stat
        label="Dead-man switch"
        tone={
          snapshot.status.ok
            ? snapshot.status.value.heartbeat_expired
              ? "danger"
              : "ok"
            : undefined
        }
        value={
          <Read
            result={snapshot.status}
            label="status()"
            render={(status) =>
              isDeadManFrozen(status)
                ? "FIRED"
                : status.heartbeat_expired
                  ? "expired"
                  : "within grace"
            }
          />
        }
        note={
          <Read
            result={snapshot.status}
            label="status()"
            render={(status) => {
              const policy = snapshot.policy.ok ? snapshot.policy.value : null;
              const remaining = deadManRemaining(status, policy);
              if (remaining === null) return "switch disabled (grace 0)";
              if (remaining < 0n) return "grace elapsed; account refuses calls";
              return `${remaining}s of grace left`;
            }}
          />
        }
      />
      <Stat
        label="Policy installed"
        tone={policyState === "default-deny" ? "warn" : undefined}
        value={
          <Read
            result={snapshot.status}
            label="status()"
            render={(s) => (s.has_policy ? "yes" : "no — default deny")}
          />
        }
        note="With no policy the account refuses every call"
      />
      <Stat
        label="Last heartbeat"
        value={
          <Read
            result={snapshot.status}
            label="status()"
            render={(status) =>
              status.last_heartbeat === 0n
                ? "never"
                : `${Number(status.last_heartbeat)} (ledger time)`
            }
          />
        }
        note="Written by the agent's own heartbeat(), not by this console"
      />
    </div>
  );
}
