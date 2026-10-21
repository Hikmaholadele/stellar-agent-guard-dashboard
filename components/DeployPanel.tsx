"use client";

/**
 * Real deployment, from the browser.
 *
 * The panel refuses to deploy anything until it has re-derived the pinned Phase 1
 * artifact's identity from the chain, and it reports the address the contract will
 * have *before* the wallet is prompted. After the create transaction it re-reads
 * the new instance and checks the bytecode it runs — so "deployed" means the
 * proven artifact exists at that address, not that a transaction was signed.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { checkArtifact, deployGuard, initializeGuard, planDeploy } from "../lib/guard/guardOps.ts";
import { rememberDeployment } from "../lib/guard/setupChecklist.ts";
import type { ArtifactCheck, DeployOutcome, DeployPlan } from "../lib/guard/guardOps.ts";
import { deployCostBreakdown } from "../lib/guard/deployCostCalculator.ts";
import type { InvokeResult } from "../lib/guard/submit.ts";
import { NETWORK, PHASE1_ARTIFACT } from "../lib/guard/network.ts";
import { fetchContractWasm, verifyWasmIdentity } from "../lib/guard/chain.ts";
import { toHex } from "../lib/guard/scval.ts";
import { validateInitParameters, type InitValidation } from "../lib/guard/initValidator.ts";
import { sanitizeAddressInput } from "../lib/guard/inputSanitizer.ts";
import {
  contractAlreadyDeployed,
  createSaltAddressPredictor,
  formatExpectedAttempts,
  formatSalt,
  parseSalt,
  randomSalt,
  searchVanitySalt,
  validateVanityPattern,
  type SaltEncoding,
  type VanityProgress,
} from "../lib/guard/saltGenerator.ts";
import {
  buildFundRequest,
  describeBalances,
  friendbotTarget,
  fundWithFriendbot,
  needsFunding,
  probeBalances,
  type BalanceReading,
  type FetchLike,
} from "../lib/guard/friendbot.ts";
import {
  buildIntegrityReport,
  buildIntegrityReportWithProgress,
  describeBuild,
  sortEntrypoints,
  type IntegrityReport,
  type WasmParseProgress,
  type WasmHashProgress,
} from "../lib/guard/wasmInspector.ts";
import { useGuard } from "./GuardProvider.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { writeControlState } from "../lib/guard/observerMode.ts";
import {
  compileDeploymentReceipt,
  deploymentReceiptFilename,
  formatDeploymentReceipt,
  type DeploymentReceipt,
} from "../lib/guard/printReport.ts";
import { announce } from "../lib/guard/useAnnounce.ts";
import { usePwaActivity } from "../lib/guard/usePwaActivity.ts";
import { MigrationWizard } from "./MigrationWizard.tsx";
import { ErrorBlock, OutcomeList, starLink } from "./bits.tsx";

/** Either the chain's answer about the artifact, or why there is not one. */
type ArtifactFetch = { artifact: ArtifactCheck } | { error: string };

// parked-until-upstream: #13
// The multi-artifact version picker is blocked until the upstream stellar-agent-guard-contracts
// repository lands its release-workflow and publishes its first versioned artifact, and the SDK
// exports GUARD_WASM_HASH for the recommended build.
export function DeployPanel() {
  const { server, signer, wallet, refresh, addInstance, guard } = useGuard();
  const [artifact, setArtifact] = useState<ArtifactCheck | null>(null);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [salt, setSalt] = useState<Uint8Array>(() => randomSalt());
  // The plan is stored together with the inputs it was computed for, so a plan
  // that no longer matches the wallet or salt is simply not shown. Deriving
  // staleness by key avoids the synchronous clear-in-an-effect that would
  // otherwise render a plan for the wrong account for one frame.
  const [planFor, setPlanFor] = useState<{ key: string; plan: DeployPlan } | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [outcome, setOutcome] = useState<DeployOutcome | null>(null);
  const [liveSteps, setLiveSteps] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [agentPubkey, setAgentPubkey] = useState("");
  const [initResult, setInitResult] = useState<InvokeResult | null>(null);
  // Deploy is a write like any other: available to a connected admin, inert and
  // self-explanatory to an observer (#101).
  const deployControl = writeControlState(wallet, {
    busy: deploying,
    extraDisabled: artifact?.ok !== true,
    label: "deploy a guard",
  });

  // The salt can be typed as well as rolled. `salt` stays the bytes that will
  // actually be deployed, and the text box is only its presentation, so the
  // address preview below always describes the real salt.
  const [saltText, setSaltText] = useState("");
  const [saltEncoding, setSaltEncoding] = useState<SaltEncoding>("hex");

  const [vanityPattern, setVanityPattern] = useState("");
  const [vanityPosition, setVanityPosition] = useState<"prefix" | "suffix">("prefix");
  const [vanityProgress, setVanityProgress] = useState<VanityProgress | null>(null);
  const [vanityFound, setVanityFound] = useState<{ address: string; attempts: number } | null>(
    null,
  );
  const [vanityError, setVanityError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  // A plain object the loop reads between candidates: an `AbortController`'s
  // signal is not what `searchVanitySalt` checks, and the flag has to survive
  // re-renders without becoming state.
  const cancelSearch = useRef({ aborted: false });

  const [collision, setCollision] = useState<{ exists: boolean; detail: string | null } | null>(
    null,
  );

  const [balances, setBalances] = useState<BalanceReading[] | null>(null);
  const [checkingBalance, setCheckingBalance] = useState(false);
  const [fundingAccount, setFundingAccount] = useState(false);
  const [fundMessage, setFundMessage] = useState<string | null>(null);

  const [integrity, setIntegrity] = useState<IntegrityReport | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [inspectProgress, setInspectProgress] = useState<
    WasmParseProgress | WasmHashProgress | null
  >(null);
  const [inspectCancelled, setInspectCancelled] = useState(false);

  // Guard init parameters, audited by the pre-flight validator before the
  // "Sign and initialize" button will enable. The admin is whoever is connected,
  // so its address is not a separate input — it is read from the wallet below.
  const [agentAddress, setAgentAddress] = useState("");
  const [dmsDurationSecs, setDmsDurationSecs] = useState("");
  const [perTxCap, setPerTxCap] = useState("");
  const [windowCap, setWindowCap] = useState("");
  const initValidation = validateInitParameters({
    adminAddress: wallet?.address ?? "",
    agentAddress,
    dmsDurationSecs,
    perTxCap,
    windowCap,
  });

  // A deploy in flight is a pending write, and a typed salt or half-filled
  // init form is an unsaved deployment draft. A service-worker update waits for
  // both rather than replacing the app underneath them (#398).
  usePwaActivity(deploying, "write");
  usePwaActivity(saltText.trim() !== "" || agentPubkey.trim() !== "", "draft");

  const [balance, setBalance] = useState<string | null>(null);
  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    void (async () => {
      try {
        const account = (await server.getAccount(wallet.address)) as unknown as {
          balances?: Array<{ asset_type?: string; balance?: string }>;
        };
        const native = account.balances?.find((entry) => entry.asset_type === "native");
        if (!cancelled) setBalance(native?.balance ?? "0");
      } catch {
        if (!cancelled) setBalance("0");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [server, wallet]);

  // Fetching and applying are separate: `fetchArtifact` touches no state, so the
  // effect below has nothing synchronous to write, and the panel is never blanked
  // for a frame while a re-check is in flight. Both states are applied together,
  // and only once the chain has answered.
  const fetchArtifact = useCallback(async (): Promise<ArtifactFetch> => {
    try {
      return { artifact: await checkArtifact(server) };
    } catch (caught) {
      return { error: caught instanceof Error ? caught.message : String(caught) };
    }
  }, [server]);

  const applyArtifact = useCallback((result: ArtifactFetch) => {
    if ("artifact" in result) {
      setArtifact(result.artifact);
      setArtifactError(null);
    } else {
      setArtifact(null);
      setArtifactError(result.error);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await fetchArtifact();
      if (!cancelled) applyArtifact(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchArtifact, applyArtifact]);

  const planKey = wallet ? `${wallet.address}:${toHex(salt)}` : "";
  const plan = planFor?.key === planKey ? planFor.plan : null;
  const deployCost =
    wallet && balance !== null
      ? deployCostBreakdown({
          uploadWasm: plan ? !plan.codePresent : false,
          wasmBytes: PHASE1_ARTIFACT.wasmBytes,
          contractInstanceBytes: 64,
          accountBalanceXlm: balance,
        })
      : null;

  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await planDeploy(server, wallet.address, salt);
        if (!cancelled) setPlanFor({ key: planKey, plan: next });
      } catch {
        // A plan that cannot be computed leaves the panel saying so, rather than
        // showing a plan for a different account.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [server, wallet, salt, planKey]);

  // Asked whether the predicted address is already taken, because the salt is
  // deterministic: reusing one from an earlier deployment is a collision the
  // chain would only report at signing time.
  const predicted = plan?.predicted ?? "";
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = predicted === "" ? null : await contractAlreadyDeployed(server, predicted);
      if (!cancelled) setCollision(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [server, predicted]);

  /** Bound so the page keeps ownership of `fetch`; a bare reference can throw. */
  const fetchJson = useCallback<FetchLike>(async (url, init) => {
    const response = await fetch(url, init);
    return {
      status: response.status,
      json: () => response.json() as Promise<unknown>,
      text: () => response.text(),
    };
  }, []);

  const fundTarget = friendbotTarget({ rpcUrl: NETWORK.rpcUrl, passphrase: NETWORK.passphrase });

  /**
   * What the salt box holds right now, parsed as it is typed.
   *
   * A derived value rather than state set on click: an operator must not be able
   * to press "Use this salt" with an invalid salt still in the box, and the
   * reason has to appear before the mistake is confirmable.
   */
  const typedSalt = saltText.trim() === "" ? null : parseSalt(saltText, saltEncoding);
  const saltNotice = !typedSalt
    ? null
    : !typedSalt.ok
      ? typedSalt.message
      : typedSalt.paddedBytes > 0
        ? `Text salt padded with ${typedSalt.paddedBytes} zero byte(s) to reach 32; the preview below is the padded salt.`
        : null;

  function applyTypedSalt() {
    if (typedSalt?.ok !== true) return;
    setSalt(typedSalt.bytes);
  }

  async function startVanitySearch() {
    if (!wallet) {
      setVanityError("Connect the admin wallet: the address depends on who deploys.");
      return;
    }
    const invalid = validateVanityPattern(vanityPattern, vanityPosition);
    if (invalid) {
      setVanityError(invalid);
      return;
    }
    setVanityError(null);
    setVanityFound(null);
    setVanityProgress(null);
    cancelSearch.current = { aborted: false };
    setSearching(true);
    const outcome = await searchVanitySalt({
      pattern: vanityPattern,
      position: vanityPosition,
      saltAddress: createSaltAddressPredictor({ deployerPublicKey: wallet.address }),
      signal: cancelSearch.current,
      onProgress: setVanityProgress,
    });
    setSearching(false);
    if (outcome.status === "found") {
      setSalt(outcome.salt);
      setSaltEncoding("hex");
      setSaltText(formatSalt(outcome.salt));
      setVanityFound({ address: outcome.address, attempts: outcome.attempts });
      return;
    }
    if (outcome.status === "invalid") {
      setVanityError(outcome.message);
      return;
    }
    setVanityError(
      outcome.reason === "aborted"
        ? `Stopped after ${outcome.attempts} salts.`
        : `No salt in ${outcome.attempts} tries produced a ${vanityPosition} of “${vanityPattern.toUpperCase()}” — ${formatExpectedAttempts(vanityPattern.trim().length)}.`,
    );
  }

  async function checkBalances() {
    if (!fundTarget.supported) return;
    const targets = [wallet?.address ?? "", agentAddress].filter((value) => value.trim() !== "");
    if (targets.length === 0) return;
    setCheckingBalance(true);
    setFundMessage(null);
    setBalances(await probeBalances(targets, fundTarget, fetchJson));
    setCheckingBalance(false);
  }

  async function fundNow() {
    if (!fundTarget.supported) return;
    const unread = balances ?? [];
    const targets = unread
      .filter((reading) => reading.state.state === "unfunded" || reading.state.state === "absent")
      .map((reading) => reading.address);
    if (targets.length === 0) return;
    setFundingAccount(true);
    setFundMessage(null);
    const results = await fundWithFriendbot(targets, fundTarget, fetchJson);
    setFundMessage(
      results.map((result) => `${result.address.slice(0, 5)}…: ${result.message}`).join(" · "),
    );
    // Re-read rather than assume: a funded account shows its new balance, and a
    // faucet that accepted the request but failed upstream is caught here.
    setBalances(await probeBalances(targets, fundTarget, fetchJson));
    setFundingAccount(false);
  }

  async function inspectBytecode() {
    const target = outcome?.guard ?? guard;
    if (target === "") {
      setInspectError("Nothing to inspect yet: deploy or select a guard first.");
      return;
    }
    setInspecting(true);
    setInspectCancelled(false);
    setInspectError(null);
    setInspectProgress(null);
    setIntegrity(null);
    try {
      const [wasm, identity] = await Promise.all([
        fetchContractWasm(server, target),
        verifyWasmIdentity(server, target),
      ]);
      const report = await buildIntegrityReportWithProgress({
        wasm,
        reportedWasmHash: identity.reportedWasmHash,
        onParseProgress: (progress) => setInspectProgress(progress),
        onHashProgress: (progress) => setInspectProgress(progress),
      });
      setIntegrity(report);
    } catch (caught) {
      if (caught instanceof Error && caught.message === "Parsing cancelled") {
        setInspectCancelled(true);
        setInspectProgress(null);
      } else if (caught instanceof Error && caught.message === "Hashing cancelled") {
        setInspectCancelled(true);
        setInspectProgress(null);
      } else {
        setInspectError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      setInspecting(false);
    }
  }

  function cancelInspect() {
    setInspectCancelled(true);
    // The worker will handle cancellation internally
  }

  /**
   * The handoff record for the deploy on screen (#396).
   *
   * Derived from the outcome rather than stored, so it can never drift from the
   * transactions and read the panel is showing. The live read is passed through
   * as what it is: a success, a failure, or — when the flow never reached it —
   * `null`, which the receipt records as "unavailable" rather than verified.
   */
  const receipt = outcome
    ? compileDeploymentReceipt({
        network: { name: NETWORK.name, passphrase: NETWORK.passphrase },
        predictedAddress: plan?.predicted ?? outcome.guard,
        deployedAddress: outcome.guard,
        pinned: { hash: PHASE1_ARTIFACT.wasmHash, bytes: PHASE1_ARTIFACT.wasmBytes },
        read:
          outcome.identity !== null
            ? { ok: true, value: outcome.identity }
            : outcome.readError !== null
              ? { ok: false, error: outcome.readError }
              : null,
        steps: outcome.steps,
      })
    : null;

  function downloadDeploymentReceipt(record: DeploymentReceipt) {
    const url = URL.createObjectURL(
      new Blob([formatDeploymentReceipt(record)], { type: "application/json;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = deploymentReceiptFilename(record);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    announce("Downloaded the deployment verification receipt");
  }

  async function deploy() {
    setDeploying(true);
    setError(null);
    setOutcome(null);
    setLiveSteps([]);
    try {
      const result = await deployGuard({
        server,
        signer: signer(),
        salt,
        onStep: (step) => setLiveSteps((current) => [...current, step.label]),
      });
      setOutcome(result);
      if (result.verified) {
        addInstance(result.guard, "Deployed from this console");
        // Record the predicted address as the wizard's deploy marker — the one
        // post-deploy fact the chain cannot re-derive for this browser.
        rememberDeployment(result.guard);
      }
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDeploying(false);
    }
  }

  async function initialize(target: string) {
    setError(null);
    setInitResult(null);
    try {
      const result = await initializeGuard({
        server,
        signer: signer(),
        guard: target,
        agentPubkeyHex: agentPubkey,
      });
      setInitResult(result);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <div className="panel" id="deploy">
      <h2>Deploy a guard</h2>

      <p className="tiny muted">
        Deploys the artifact Phase 1 proved. The bytecode is fetched from the chain and hashed here
        before anything is signed, so this cannot ship a different binary than the one that was
        verified.
      </p>

      <div className="grid" style={{ marginTop: 12 }}>
        <div className="stat">
          <div className="k">Pinned artifact</div>
          <div className="v small mono">{PHASE1_ARTIFACT.wasmHash.slice(0, 16)}...</div>
          <div className="n">{PHASE1_ARTIFACT.wasmBytes} bytes</div>
        </div>
        {artifactError && (
          <div className="stat">
            <div className="k">On-chain artifact</div>
            <div className="v small" style={{ color: "var(--danger)" }}>
              unreadable
            </div>
            <div className="n">{artifactError}</div>
          </div>
        )}
        {artifact && (
          <>
            <div className="stat">
              <div className="k">Fetched from chain</div>
              <div className="v small mono">{artifact.live.fetchedSha256.slice(0, 16)}...</div>
              <div className="n">{artifact.live.bytes} bytes</div>
            </div>
            <div className="stat">
              <div className="k">Identity</div>
              <div
                className="v small"
                style={{ color: artifact.ok ? "var(--ok)" : "var(--danger)" }}
              >
                {artifact.ok ? "matches" : "MISMATCH"}
              </div>
              <div className="n">{artifact.ok ? "deploy is permitted" : "deploy is refused"}</div>
            </div>
          </>
        )}
      </div>

      {artifact && !artifact.ok && <ErrorBlock title="Deploy refused" detail={artifact.detail} />}
      {artifact && artifact.ok && (
        <p className="tiny muted" style={{ marginTop: 8 }}>
          {artifact.detail}
        </p>
      )}

      <h3>What this deploy will do</h3>
      {!wallet ? (
        <p className="tiny muted">Connect the admin wallet to compute the contract address.</p>
      ) : plan ? (
        <div className="grid">
          <div className="stat">
            <div className="k">Predicted guard address</div>
            <div className="v small mono" title={plan.predicted}>
              {plan.predicted}
            </div>
            <div className="n">
              computed before signing, then confirmed by reading the instance back{" "}
              <CopyButton value={plan.predicted} label="predicted guard address" />
            </div>
          </div>
          <div className="stat">
            <div className="k">Pinned bytecode already on chain</div>
            <div className="v small">{plan.codePresent ? "yes" : "no"}</div>
            <div className="n">
              {plan.codePresent
                ? "one transaction: the create"
                : "two transactions: upload, then create"}
            </div>
          </div>
        </div>
      ) : (
        <p className="tiny muted">Working out the deploy plan...</p>
      )}

      {collision?.exists && (
        <div className="error" role="alert" style={{ marginTop: 8 }}>
          <span className="t">Address already taken</span>
          <span className="tiny">
            A contract already lives at {predicted}. Generate a new salt or choose another before
            signing — the deploy would fail on collision rather than overwrite anything.
          </span>
        </div>
      )}

      <h3>Choose the salt</h3>
      <p className="tiny muted">
        The guard&apos;s address comes from the deployer and this salt, so the salt decides where
        the deployment lands. It can be rolled randomly, typed, or searched for.
      </p>

      <div className="row">
        <label className="field">
          <span className="lbl">Current salt (hex)</span>
          <input
            className="mono"
            value={formatSalt(salt)}
            readOnly
            aria-label="Current salt in hex"
            onFocus={(event) => event.target.select()}
          />
        </label>
      </div>

      <div className="split">
        <label className="field">
          <span className="lbl">Encoding</span>
          <select
            value={saltEncoding}
            onChange={(event) => setSaltEncoding(event.target.value as SaltEncoding)}
          >
            <option value="hex">Hex — 64 characters</option>
            <option value="utf8">Text — up to 32 bytes</option>
          </select>
        </label>
        <label className="field">
          <span className="lbl">{saltEncoding === "hex" ? "Hex salt" : "Text salt"}</span>
          <input
            className="mono"
            value={saltText}
            onChange={(event) => setSaltText(event.target.value)}
            placeholder={saltEncoding === "hex" ? "0x3a7f… 64 hex digits" : "my-project-guard"}
            aria-label="Salt to deploy with"
          />
        </label>
      </div>

      <div className="row">
        <button
          className="secondary"
          onClick={applyTypedSalt}
          disabled={deploying || typedSalt?.ok !== true}
        >
          Use this salt
        </button>
        <button
          className="secondary"
          onClick={() => {
            setSalt(randomSalt());
            setSaltText("");
          }}
          disabled={deploying}
        >
          New random salt
        </button>
      </div>
      {saltNotice && (
        <p
          className="tiny"
          style={{ color: typedSalt && !typedSalt.ok ? "var(--danger)" : "var(--warn)" }}
          role="status"
        >
          {saltNotice}
        </p>
      )}

      <div className="split">
        <label className="field">
          <span className="lbl">Vanity text</span>
          <input
            value={vanityPattern}
            onChange={(event) => setVanityPattern(event.target.value)}
            placeholder="AGENT or CA3T"
            aria-label="Text the guard address should contain"
            disabled={searching}
          />
          <span className="hint">
            {vanityPattern.trim() === ""
              ? "Each extra character costs about 32× the attempts before it."
              : formatExpectedAttempts(vanityPattern.trim().toUpperCase().length)}
          </span>
        </label>
        <label className="field">
          <span className="lbl">Position</span>
          <select
            value={vanityPosition}
            onChange={(event) => setVanityPosition(event.target.value as "prefix" | "suffix")}
            disabled={searching}
          >
            <option value="prefix">Address starts with</option>
            <option value="suffix">Address ends with</option>
          </select>
        </label>
      </div>

      <div className="row">
        {searching ? (
          <button className="secondary" onClick={() => (cancelSearch.current.aborted = true)}>
            Stop searching
          </button>
        ) : (
          <button className="secondary" onClick={() => void startVanitySearch()} disabled={!wallet}>
            Search for a salt
          </button>
        )}
        {!wallet && <span className="tiny muted">Connect the admin wallet to search.</span>}
      </div>

      {searching && vanityProgress && (
        <p className="tiny mono" role="status">
          {vanityProgress.attempts.toLocaleString()} salts tried ·{" "}
          {(vanityProgress.elapsedMs / 1000).toFixed(1)}s · closest {vanityProgress.closest}
        </p>
      )}
      {vanityFound && (
        <div className="notice info">
          <strong>Found in {vanityFound.attempts.toLocaleString()} tries</strong>
          <span className="tiny mono">{vanityFound.address}</span>
          <span className="tiny">
            That salt is now loaded above; the plan is recomputed for it.
          </span>
        </div>
      )}
      {vanityError && (
        <p className="tiny" style={{ color: "var(--danger)" }} role="status">
          {vanityError}
        </p>
      )}

      {wallet && plan && deployCost && (
        <div className={deployCost.warning ? "error" : "notice info"} style={{ marginTop: 12 }}>
          <strong>Deployment reserve check</strong>
          <div
            className="tiny"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 10,
              marginTop: 8,
            }}
          >
            <div>
              <div className="tiny muted">Base tx fee</div>
              <div className="mono">{deployCost.baseFeeXlm} XLM</div>
            </div>
            <div>
              <div className="tiny muted">WASM upload</div>
              <div className="mono">{deployCost.wasmUploadFeeXlm} XLM</div>
            </div>
            <div>
              <div className="tiny muted">Contract instance</div>
              <div className="mono">{deployCost.contractInstanceFeeXlm} XLM</div>
            </div>
            <div>
              <div className="tiny muted">Initial rent</div>
              <div className="mono">{deployCost.initialRentDepositXlm} XLM</div>
            </div>
            <div>
              <div className="tiny muted">Required total</div>
              <div className="mono">{deployCost.totalRequiredXlm} XLM</div>
            </div>
            <div>
              <div className="tiny muted">Wallet balance</div>
              <div className="mono">{deployCost.balanceXlm} XLM</div>
            </div>
          </div>
          <div className="tiny muted" style={{ marginTop: 8 }}>
            Remaining after required spend:{" "}
            <span className="mono">{deployCost.balanceAfterRequiredXlm} XLM</span>
          </div>
          {deployCost.warning && (
            <div className="tiny" style={{ marginTop: 8 }}>
              Balance is below the reserve safety threshold ({deployCost.safetyBufferXlm} XLM
              cushion): fund at least{" "}
              {(Number(deployCost.totalRequiredXlm) + Number(deployCost.safetyBufferXlm)).toFixed(
                7,
              )}{" "}
              XLM before signing.
            </div>
          )}
        </div>
      )}

      <div className="row" style={{ marginTop: 14 }}>
        <button
          disabled={deployControl.disabled}
          title={deployControl.title}
          onClick={() => void deploy()}
        >
          {deploying ? "Deploying..." : "Deploy guard"}
        </button>
        <button
          className="secondary"
          onClick={() => {
            void fetchArtifact().then(applyArtifact);
          }}
          disabled={deploying}
        >
          Re-check artifact
        </button>
      </div>

      {liveSteps.length > 0 && deploying && (
        <div className="notice info">
          <strong>Deploy in progress</strong>
          {liveSteps.map((step) => (
            <div key={step} className="tiny mono">
              {step}
            </div>
          ))}
        </div>
      )}

      {error && <ErrorBlock title="The deploy could not be completed" detail={error} />}

      {outcome && (
        <div className={outcome.verified ? "notice info" : "error"}>
          <strong>
            {outcome.verified
              ? "Deployed and verified against the pinned artifact"
              : outcome.readError !== null
                ? "A contract was created, but its bytecode could not be read back"
                : "A contract was created, but it is NOT the pinned artifact"}
          </strong>
          <span className="tiny mono">{outcome.guard}</span>{" "}
          <CopyButton value={outcome.guard} label="deployed guard address" />
          <OutcomeList steps={outcome.steps} />
          {outcome.readError !== null && (
            <p className="tiny" style={{ color: "var(--danger)" }}>
              The post-deploy read failed, so nothing about this instance&apos;s bytecode is
              verified: {outcome.readError}. Re-check the artifact, or inspect the contract, before
              routing an agent through it.
            </p>
          )}
          {outcome.identity && (
            <p className="tiny muted">
              Instance runs {outcome.identity.fetchedSha256.slice(0, 20)}... (
              {outcome.identity.bytes} bytes), ledger reports{" "}
              {outcome.identity.reportedWasmHash?.slice(0, 20) ?? "none"}...
            </p>
          )}
        </div>
      )}

      {receipt && (
        <div className="notice info" role="status">
          <strong>Deployment verification receipt</strong>
          <span className="tiny">
            A client-generated record of this deploy: network, predicted and deployed addresses,
            pinned artifact, transaction references and the verification outcome. It is not a signed
            credential, and it contains no keys, signed XDR or wallet session details.
          </span>
          <span className="tiny muted">
            Verification: {receipt.verification.status} — {receipt.verification.summary}
          </span>
          <div className="row" style={{ marginTop: 8 }}>
            <button
              className="secondary"
              onClick={() => downloadDeploymentReceipt(receipt)}
              title="Download the deployment receipt as JSON"
            >
              Download receipt
            </button>
            <span className="tiny muted mono">{deploymentReceiptFilename(receipt)}</span>
          </div>
        </div>
      )}

      <h3>Funding on {fundTarget.supported ? fundTarget.label : "this network"}</h3>
      {!fundTarget.supported ? (
        <p className="tiny muted" role="status">
          Auto-funding is off: {fundTarget.reason} The deployer and the agent still have to hold XLM
          before the guard can pay for its own transactions.
        </p>
      ) : (
        <>
          <p className="tiny muted">
            A new agent keypair starts empty, and an empty account cannot submit the heartbeats that
            keep a guard alive. This reads the balances the chain actually holds.
          </p>
          <div className="row">
            <button
              className="secondary"
              onClick={() => void checkBalances()}
              disabled={checkingBalance || !wallet}
            >
              {checkingBalance ? "Checking..." : "Check balances"}
            </button>
            <button
              onClick={() => void fundNow()}
              disabled={fundingAccount || !needsFunding(balances ?? [])}
            >
              {fundingAccount ? "Funding..." : "Fund with Friendbot"}
            </button>
          </div>
          {balances && (
            <div className={needsFunding(balances) ? "error" : "notice info"} role="status">
              <span className="t">
                {needsFunding(balances) ? "Unfunded account warning" : "Balances look funded"}
              </span>
              <span className="tiny mono">{describeBalances(balances)}</span>
            </div>
          )}
          {fundMessage && (
            <p className="tiny mono" role="status">
              {fundMessage}
            </p>
          )}
        </>
      )}

      <details className="stack" style={{ marginTop: 14 }}>
        <summary>Bytecode inspector</summary>
        <p className="tiny muted">
          Fetches the contract&apos;s stored WASM, hashes it here with Web Crypto, and compares it
          to the pinned artifact — a second opinion on what the ledger says it is running. Parsing
          and hashing run in a Web Worker so the UI stays responsive.
        </p>
        <div className="row">
          <button
            className="secondary"
            onClick={() => void inspectBytecode()}
            disabled={inspecting}
          >
            {inspecting ? "Reading bytecode..." : "Inspect this contract"}
          </button>
          {inspecting && (
            <button className="secondary" onClick={() => void cancelInspect()}>
              Cancel
            </button>
          )}
          <span className="tiny muted">
            Inspecting {(outcome?.guard ?? guard) || "no instance yet"}
          </span>
        </div>
        {inspecting && inspectProgress && (
          <div className="stack" style={{ marginTop: 8 }} role="status">
            <div className="tiny mono">
              {(() => {
                const p = inspectProgress as WasmParseProgress | WasmHashProgress;
                if ("phase" in p) {
                  switch (p.phase) {
                    case "validating-header":
                      return "Validating WASM header...";
                    case "parsing-sections":
                      return `Parsing sections: ${p.current ?? 0} / ${p.total ?? "?"}`;
                    case "reading-exports":
                      return `Reading exports: ${p.count ?? 0} found`;
                    case "reading-producers":
                      return `Reading producers: ${p.section}`;
                    case "hashing":
                      return `Hashing: ${p.bytesProcessed ?? 0} / ${p.totalBytes ?? "?"} bytes`;
                    case "complete":
                      return "Complete";
                    case "error":
                      return `Error: ${p.reason}`;
                    case "cancelled":
                      return "Cancelled";
                  }
                }
                return "Working...";
              })()}
            </div>
            {inspectProgress.phase === "parsing-sections" && inspectProgress.total && (
              <progress
                value={inspectProgress.current ?? 0}
                max={inspectProgress.total}
                style={{ width: "100%", height: 6 }}
              />
            )}
            {inspectProgress.phase === "hashing" && inspectProgress.totalBytes && (
              <progress
                value={inspectProgress.bytesProcessed ?? 0}
                max={inspectProgress.totalBytes}
                style={{ width: "100%", height: 6 }}
              />
            )}
          </div>
        )}
        {inspectCancelled && (
          <p className="tiny" style={{ color: "var(--warn)" }} role="status">
            Inspection cancelled by operator.
          </p>
        )}
        {inspectError && (
          <ErrorBlock title="The bytecode could not be read" detail={inspectError} />
        )}
        {integrity && (
          <div className={integrity.verdict === "verified" ? "notice info" : "error"} role="status">
            <strong>{integrity.headline}</strong>
            <span className="tiny">{integrity.detail}</span>
            <div className="grid">
              <div className="stat">
                <div className="k">SHA-256</div>
                <div className="v small mono">
                  {integrity.sha256 ? `${integrity.sha256.slice(0, 16)}...` : "unreadable"}
                </div>
                <div className="n">{integrity.bytes} bytes</div>
              </div>
              <div className="stat">
                <div className="k">Pinned artifact</div>
                <div className="v small mono">{integrity.pinnedHash.slice(0, 16)}...</div>
                <div className="n">{integrity.pinnedBytes} bytes</div>
              </div>
              <div className="stat">
                <div className="k">Ledger declares</div>
                <div className="v small mono">
                  {integrity.reportedWasmHash
                    ? `${integrity.reportedWasmHash.slice(0, 16)}...`
                    : "not reported"}
                </div>
                <div className="n">the hash stored with the contract instance</div>
              </div>
            </div>
            <p className="tiny">
              <strong>Entrypoints:</strong>{" "}
              <span className="mono">
                {sortEntrypoints(integrity.entrypoints).join(", ") || "none exported"}
              </span>
            </p>
            <p className="tiny muted">
              <strong>Build metadata:</strong> {describeBuild(integrity.metadata)}
            </p>
            {integrity.verdict !== "verified" && (
              <p className="tiny" style={{ color: "var(--danger)" }}>
                Do not route an agent through this instance until the bytecode is accounted for.
              </p>
            )}
          </div>
        )}
      </details>

      <h3>Initialize a guard</h3>
      <p className="tiny muted">
        Registers the connected wallet as admin and the agent&apos;s raw Ed25519 public key.
        One-time: the account is default-deny until a policy is installed on the Configure step.
      </p>
      <label className="field">
        <span className="lbl">Agent public key (32 raw Ed25519 bytes, hex)</span>
        <input
          value={agentPubkey}
          onChange={(event) => setAgentPubkey(sanitizeAddressInput(event.target.value))}
          placeholder="53b093e0281a2d8f4276b77fd21e3380b3329f09097ace3d9e60cf0f2f9039e2"
        />
        <span className="hint">
          This is the raw 32-byte key the agent signs with, not its G... strkey form. The SDK
          derives it from the agent keypair.
        </span>
      </label>

      <p className="tiny muted">
        The values below are checked before anything is signed. They describe the guard the
        initialization will create, so a mistake here is caught now rather than discovered in
        production.
      </p>

      <label className="field">
        <span className="lbl">Agent account address (G…)</span>
        <input
          value={agentAddress}
          onChange={(event) => setAgentAddress(sanitizeAddressInput(event.target.value))}
          placeholder="GBUQ… (must differ from the connected admin)"
          aria-label="Agent account address"
        />
      </label>

      <div className="grid">
        <label className="field">
          <span
            className="lbl"
            title="Seconds the agent may miss its heartbeat before the dead-man's switch freezes the account (docs/glossary.md — Dead-Man's Switch)"
          >
            Dead-man grace (seconds)
          </span>
          <input
            value={dmsDurationSecs}
            onChange={(event) => setDmsDurationSecs(event.target.value)}
            placeholder="3600"
            inputMode="numeric"
          />
        </label>
        <label className="field">
          <span className="lbl">Per-transaction cap (units)</span>
          <input
            value={perTxCap}
            onChange={(event) => setPerTxCap(event.target.value)}
            placeholder="1000"
            inputMode="numeric"
          />
        </label>
        <label className="field">
          <span className="lbl">Rolling-window cap (units)</span>
          <input
            value={windowCap}
            onChange={(event) => setWindowCap(event.target.value)}
            placeholder="5000"
            inputMode="numeric"
          />
        </label>
      </div>

      <InitChecklist validation={initValidation} />

      <div className="row">
        <button
          disabled={!wallet || agentPubkey.trim().length === 0 || !initValidation.canDeploy}
          onClick={() => void initialize(outcome?.guard ?? "")}
        >
          Sign and initialize
        </button>
        {!wallet && <span className="tiny muted">Connect the admin wallet to initialize.</span>}
        {wallet && !initValidation.canDeploy && (
          <span className="tiny" style={{ color: "var(--danger)" }}>
            Resolve {initValidation.blockers.length} blocker
            {initValidation.blockers.length === 1 ? "" : "s"} above before initializing.
          </span>
        )}
      </div>

      {initResult && (
        <div className={initResult.kind === "submitted" ? "notice info" : "error"}>
          <strong>
            {initResult.kind === "submitted"
              ? "initialize landed on chain"
              : initResult.kind === "refused"
                ? "initialize was refused before broadcast"
                : "initialize was broadcast and rejected"}
          </strong>
          {initResult.kind === "submitted" ? (
            <span className="tiny">
              {starLink(initResult.hash)} - ledger {initResult.ledger ?? "-"}
            </span>
          ) : (
            <span className="tiny mono">
              {initResult.kind === "exported" ? "Exported" : initResult.detail}
            </span>
          )}
        </div>
      )}

      <MigrationWizard target={outcome?.guard ?? guard} />
    </div>
  );
}

/**
 * The pre-flight guardrail checklist.
 *
 * A passed rule reads as a green line; a fatal failure reads as a blocker
 * banner. Every result is shown, including the passing ones, because an
 * operator needs to see what *was* verified — an all-clear with no visible
 * checks is indistinguishable from a validator that never ran.
 */
function InitChecklist({ validation }: { validation: InitValidation }) {
  return (
    <div
      className="stack"
      style={{ marginTop: 12 }}
      role="group"
      aria-label="Initialization pre-flight checks"
    >
      {validation.checks.map((item) =>
        item.passed ? (
          <div key={item.id} className="checkline">
            <span className="pill ok" aria-hidden="true">
              ✓
            </span>
            <span className="tiny">{item.label}</span>
          </div>
        ) : (
          <div key={item.id} className="error" role="alert">
            <span className="t">Blocker: {item.label}</span>
            <span className="tiny">{item.detail}</span>
          </div>
        ),
      )}
    </div>
  );
}
