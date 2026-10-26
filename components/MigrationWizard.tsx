"use client";

/**
 * Moving a policy from one guard to another.
 *
 * The operator picks a source instance they already have, this reads its live
 * policy off the chain, and it shows what would be installed on the target
 * before anything is signed. Two things are deliberately not done here: the
 * policy is never filled in from a blank when the source lacks a field, and the
 * migration never writes without the same confirmation path any other policy
 * change takes. A migration that quietly loosened a cap would be worse than the
 * manual re-entry it replaces.
 */

import { useCallback, useState } from "react";
import { installPolicy } from "../lib/guard/guardOps.ts";
import { readPolicy, readStatus } from "../lib/guard/chain.ts";
import { NETWORK } from "../lib/guard/network.ts";
import {
  buildMigrationPreview,
  canSubmitMigrationPreview,
  describeMigrationScope,
  migrationPreviewValidity,
  planMigration,
  sourceRows,
  type CompatibilityReport,
  type FieldConversion,
  type FieldConversionStatus,
  type MigrationPreview,
  type MigrationScope,
} from "../lib/guard/migration.ts";
import { useGuard } from "./GuardProvider.tsx";
import { ErrorBlock, starLink } from "./bits.tsx";

/** Either a live source + destination read, or why there is not one. */
type SourceRead =
  | { kind: "read"; preview: MigrationPreview }
  | { kind: "empty" }
  | { kind: "error"; message: string };

export function MigrationWizard({ target }: { target: string }) {
  const { server, signer, wallet, instances, refresh } = useGuard();
  const [source, setSource] = useState("");
  const [reading, setReading] = useState(false);
  const [read, setRead] = useState<SourceRead | null>(null);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<Awaited<ReturnType<typeof installPolicy>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The source must not be the target: "copy this policy onto itself" reads as
  // a harmless no-op but rewrites the live policy, which resets the rolling
  // window the guard is enforcing.
  const candidates = instances.filter((instance) => instance.guard !== target);

  const currentScope: MigrationScope = {
    destination: target,
    network: { name: NETWORK.name, passphrase: NETWORK.passphrase },
  };

  const readSource = useCallback(async (): Promise<SourceRead> => {
    if (!source.trim()) {
      return { kind: "error", message: "Choose the guard to copy from." };
    }
    if (!target.trim()) {
      return { kind: "error", message: "Choose the destination guard before reading a source." };
    }
    // The destination is read at the same time as the source. A preview is only
    // reviewable for a destination the chain answered for *now*: switching the
    // active guard must require a fresh read, not reuse the previous one.
    const [result, destination] = await Promise.all([
      readPolicy(server, source.trim()),
      readStatus(server, target.trim()),
    ]);
    if (!result.ok) return { kind: "error", message: result.error };
    if (!destination.ok) {
      return {
        kind: "error",
        message: `The destination ${target} could not be read: ${destination.error}`,
      };
    }
    if (result.value === null || result.value === undefined) return { kind: "empty" };
    return {
      kind: "read",
      preview: buildMigrationPreview({
        plan: planMigration(result.value),
        destination: target,
        network: { name: NETWORK.name, passphrase: NETWORK.passphrase },
      }),
    };
  }, [server, source, target]);

  function applyRead(next: SourceRead) {
    setRead(next);
    setApplied(null);
    setError(null);
    setReading(false);
  }

  async function fetchSource() {
    setReading(true);
    setError(null);
    setRead(null);
    applyRead(await readSource());
  }

  function previewOf(next: SourceRead | null): MigrationPreview | null {
    return next?.kind === "read" ? next.preview : null;
  }

  async function applyToTarget() {
    const preview = previewOf(read);
    if (!preview) return;

    // Re-check at the moment of submission, not just at render: the active guard
    // can switch in another tab between the operator reading the summary and
    // pressing apply. A stale preview refuses here rather than installing a
    // policy the operator never reviewed for this destination.
    const gate = canSubmitMigrationPreview(preview, currentScope);
    if (!gate.ok) {
      setError(`${gate.reason} Nothing was signed.`);
      return;
    }
    if (!preview.plan.ok) return;

    setApplying(true);
    setError(null);
    try {
      const outcome = await installPolicy({
        server,
        signer: signer(),
        guard: preview.destination,
        draft: preview.plan.draft,
      });
      setApplied(outcome);
      if (outcome.kind === "invoked" && outcome.result.kind === "submitted") await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setApplying(false);
    }
  }

  const preview = previewOf(read);
  const validity = preview ? migrationPreviewValidity(preview, currentScope) : null;
  const submitGate = preview ? canSubmitMigrationPreview(preview, currentScope) : null;
  const plan = preview && validity?.ok && preview.plan.ok ? preview.plan : null;

  return (
    <div className="stack" style={{ marginTop: 18 }}>
      <h3>Move a policy from another guard</h3>
      <p className="tiny muted">
        Reads the live policy off a source instance and prepares the same rules for{" "}
        <span className="mono">{target || "the selected guard"}</span>. Nothing is written until you
        sign it, and a field the source does not carry is reported as missing rather than defaulted.
      </p>

      <label className="field">
        <span className="lbl">Source guard</span>
        <select value={source} onChange={(event) => setSource(event.target.value)}>
          <option value="">Choose an instance…</option>
          {candidates.map((instance) => (
            <option key={instance.guard} value={instance.guard}>
              {instance.label} — {instance.guard}
            </option>
          ))}
        </select>
        <span className="hint">
          {instances.length === 1
            ? "Only this instance is known; add another from the Deploy step."
            : undefined}
        </span>
      </label>

      <div className="row">
        <button
          className="secondary"
          disabled={reading || source === ""}
          onClick={() => void fetchSource()}
        >
          {reading ? "Reading source..." : "Read source policy"}
        </button>
        {!wallet && <span className="tiny muted">Connect the admin wallet to apply a policy.</span>}
      </div>

      {read?.kind === "error" && (
        <ErrorBlock title="The source could not be read" detail={read.message} />
      )}
      {read?.kind === "empty" && (
        <div className="notice info">
          <strong>The source has no policy installed</strong>
          <span className="tiny">
            It is in the contract&apos;s default-deny state, so there is nothing to copy. Deploy and
            initialize it first, or choose another source.
          </span>
        </div>
      )}

      {preview && !preview.plan.ok && (
        <>
          <ErrorBlock title="This policy is not directly portable" detail={preview.plan.message} />
          <CompatibilityView report={preview.plan.report} />
        </>
      )}

      {preview && validity && !validity.ok && (
        <div className="error" role="alert">
          <span className="t">This preview is out of date</span>
          <span className="tiny">{validity.reason}</span>
          <span className="tiny">
            It was read for {describeMigrationScope(preview)}. The policy summary and the apply
            button stay hidden until the source and destination are read again and reviewed for the
            current destination.
          </span>
        </div>
      )}

      {plan && preview && (
        <div className="stack">
          <div className="grid">
            <div className="stat">
              <div className="k">From</div>
              <div className="v small mono">{source}</div>
              <div className="n">
                read from the chain at <span className="mono">{preview.readAt}</span>
              </div>
            </div>
            <div className="stat">
              <div className="k">To</div>
              <div className="v small mono">{preview.destination}</div>
              <div className="n">
                on {preview.network.name} — the target instance&apos;s policy will be replaced
              </div>
            </div>
            <div className="stat">
              <div className="k">Bound to</div>
              <div className="v small">destination + network</div>
              <div className="n">
                Change either one and this preview is invalidated until a fresh read.
              </div>
            </div>
          </div>

          <div className="scrolly">
            <table className="events">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Source value</th>
                </tr>
              </thead>
              <tbody>
                {sourceRows(plan.source).map((row) => (
                  <tr key={row.label}>
                    <td>{row.label}</td>
                    <td className="mono tiny">{row.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="notice info">
            <strong>What will be installed</strong>
            <span className="tiny">{plan.summary}</span>
            {plan.carried.length > 0 && (
              <ul className="tiny">
                {plan.carried.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
            {plan.dropped.length > 0 && (
              <ul className="tiny" style={{ color: "var(--danger)" }}>
                {plan.dropped.map((item) => (
                  <li key={item}>Not carried: {item}</li>
                ))}
              </ul>
            )}
          </div>

          <CompatibilityView report={plan.report} />

          <div className="row">
            <button
              disabled={!wallet || applying || !submitGate?.ok}
              onClick={() => void applyToTarget()}
            >
              {applying ? "Preparing..." : "Apply policy to target"}
            </button>
            <span className="tiny muted">
              {submitGate?.ok
                ? "The wallet is prompted once; the payload is this build's own validated encoding of the source policy."
                : submitGate?.reason}
            </span>
          </div>
        </div>
      )}

      {error && <ErrorBlock title="The migration could not be applied" detail={error} />}

      {applied?.kind === "invalid" && (
        <div className="error" role="alert">
          <span className="t">Refused before broadcast</span>
          <ul className="tiny">
            {applied.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}

      {applied?.kind === "invoked" && (
        <div className={applied.result.kind === "submitted" ? "notice info" : "error"}>
          <strong>
            {applied.result.kind === "submitted"
              ? "Migrated policy landed on chain"
              : applied.result.kind === "refused"
                ? "The wallet or the pre-flight refused the migration"
                : applied.result.kind === "exported"
                  ? "Migration transaction prepared, not broadcast"
                  : "The migration was broadcast and rejected"}
          </strong>
          {applied.result.kind === "submitted" ? (
            <span className="tiny">
              {starLink(applied.result.hash)} - ledger {applied.result.ledger ?? "-"}
            </span>
          ) : (
            <span className="tiny mono">
              {applied.result.kind === "exported" ? "Exported XDR" : applied.result.detail}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The compatibility findings, in three columns.
 *
 * Missing fields block the migration, unrecognised fields silently vanish, and
 * renamed fields are just the source using a different spelling — an operator
 * needs all three stated, because only the first two change what the target
 * will enforce.
 */
function CompatibilityView({ report }: { report: CompatibilityReport }) {
  if (
    report.ok &&
    report.unrecognised.length === 0 &&
    report.renamed.length === 0 &&
    report.notes.length === 0
  ) {
    return (
      <div className="checkline">
        <span className="pill ok" aria-hidden="true">
          ✓
        </span>
        <span className="tiny">
          Every field on the source matches this build&apos;s policy schema.
        </span>
      </div>
    );
  }
  return (
    <div className="stack" role="group" aria-label="Migration compatibility findings">
      {report.missing.length > 0 && (
        <div className="error" role="alert">
          <span className="t">Newly required, absent on the source</span>
          <span className="tiny">
            {report.missing.join(", ")} — re-enter these on the target rather than letting the
            migration invent a value.
          </span>
        </div>
      )}
      {report.typeIssues.length > 0 && (
        <div className="error" role="alert">
          <span className="t">Fields this build cannot read</span>
          <ul className="tiny">
            {report.typeIssues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}
      {report.unrecognised.length > 0 && (
        <div className="notice">
          <strong>Dropped on the way in</strong>
          <span className="tiny">
            {report.unrecognised.join(", ")} have no field on this build&apos;s policy, so they are
            not carried across.
          </span>
        </div>
      )}
      {report.renamed.length > 0 && (
        <div className="notice info">
          <strong>Matched by name</strong>
          <span className="tiny">
            {report.renamed.map((item) => `${item.from} → ${item.to}`).join(", ")}
          </span>
        </div>
      )}
      {report.notes.map((note) => (
        <p key={note} className="tiny muted">
          {note}
        </p>
      ))}

      {/* Field-by-field conversion details */}
      {report.fieldConversions && report.fieldConversions.length > 0 && (
        <details className="stack" style={{ marginTop: 12 }}>
          <summary>Field-by-field conversion details</summary>
          <p className="tiny muted">
            Each row shows how a source field maps to the target policy. Status codes:
            <code>copied</code> = identical, <code>transformed</code> = type converted,
            <code>defaulted</code> = missing (uses zero/empty), <code>unsupported</code> = dropped,
            <code>type-error</code> = blocks migration, <code>missing-required</code> = blocks
            migration.
          </p>
          <div className="scrolly">
            <table className="events">
              <thead>
                <tr>
                  <th>Target Field</th>
                  <th>Source Field</th>
                  <th>Source Value</th>
                  <th>Converted Value</th>
                  <th>Status</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {report.fieldConversions.map((conv, index) => (
                  <FieldConversionRow key={index} conversion={conv} />
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

function FieldConversionRow({ conversion }: { conversion: FieldConversion }) {
  const statusColors: Record<FieldConversionStatus, string> = {
    copied: "var(--ok)",
    transformed: "var(--warn)",
    defaulted: "var(--warn)",
    unsupported: "var(--danger)",
    unchanged: "var(--ok)",
    "type-error": "var(--danger)",
    "missing-required": "var(--danger)",
  };

  const formatValue = (value: unknown): string => {
    if (value === undefined) return "<em>absent</em>";
    if (value === null) return "<em>null</em>";
    if (typeof value === "bigint") return value.toString();
    if (Array.isArray(value)) return `[${value.join(", ")}]`;
    return String(value);
  };

  return (
    <tr style={{ borderLeft: `3px solid ${statusColors[conversion.status]}` }}>
      <td className="mono tiny">{conversion.targetField}</td>
      <td className="mono tiny">{conversion.sourceField ?? "<em>none</em>"}</td>
      <td
        className="mono tiny"
        dangerouslySetInnerHTML={{ __html: formatValue(conversion.sourceValue) }}
      />
      <td
        className="mono tiny"
        dangerouslySetInnerHTML={{ __html: formatValue(conversion.convertedValue) }}
      />
      <td>
        <span className="pill" style={{ background: statusColors[conversion.status] }}>
          {conversion.status}
        </span>
      </td>
      <td className="tiny">{conversion.detail}</td>
    </tr>
  );
}
