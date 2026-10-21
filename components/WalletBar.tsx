"use client";

import { useEffect, useRef, useState } from "react";
import { useGuard } from "./GuardProvider.tsx";
import { AddressText, ErrorBlock, short, useAddressLabel } from "./bits.tsx";
import { AddressBookModal } from "./AddressBookModal.tsx";
import {
  isKnownInstance,
  looksLikeContractAddress,
  type GuardInstance,
} from "../lib/guard/instance.ts";
import { useDemoMode } from "../lib/guard/useDemoMode.ts";
import { IDLE_TIMEOUT_OPTIONS } from "../lib/guard/useIdleTimer.ts";
import {
  WALLET_PROVIDERS,
  walletProviderDescriptor,
  type WalletProviderId,
} from "../lib/guard/walletConnector.ts";
import {
  describeMismatch,
  describeSwitchOutcome,
  manualSwitchInstructions,
  mismatchExplanation,
  switchButtonLabel,
  type NetworkSwitchOutcome,
} from "../lib/guard/networkSwitch.ts";
import { OBSERVER_BADGE_LABEL, WRITE_DISABLED_HINT } from "../lib/guard/observerMode.ts";
import { usePrivacy } from "../lib/guard/privacyStore.ts";

export function WalletBar() {
  const {
    wallet,
    walletError,
    connecting,
    connect,
    disconnect,
    instances,
    guard,
    selectGuard,
    addInstance,
    removeInstance,
    renameInstance,
    session,
    providerId,
    availableProviders,
    observer,
    networkMismatch,
    switchNetwork,
  } = useGuard();
  const demo = useDemoMode();
  const { masked } = usePrivacy();
  const [newAddress, setNewAddress] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [bookOpen, setBookOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [switchOutcome, setSwitchOutcome] = useState<NetworkSwitchOutcome | null>(null);
  const [renameTarget, setRenameTarget] = useState<GuardInstance | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GuardInstance | null>(null);

  const selected = instances.find((instance) => instance.guard === guard);
  const guardNickname = useAddressLabel(guard);
  const provider = providerId ? walletProviderDescriptor(providerId) : null;
  const selectedRemovable = selected ? !isKnownInstance(selected.guard) : false;

  async function addByAddress() {
    const candidate = newAddress.trim();
    // Fast local feedback before the live check; the provider repeats the check
    // (and verifies the guard answers `status()`) before anything is saved.
    if (!looksLikeContractAddress(candidate)) {
      setAddError("That is not a Soroban contract address (56 characters, starting with C).");
      return;
    }
    setAdding(true);
    setAddError(null);
    const result = await addInstance(candidate, `Guard ${short(candidate, 6, 4)}`);
    setAdding(false);
    if (!result.ok) {
      setAddError(result.error ?? "That guard could not be added.");
      return;
    }
    setNewAddress("");
  }

  return (
    <div className="panel">
      <div className="split">
        <div>
          <label className="field">
            <span className="lbl">Guarded account (the smart account being operated)</span>
            {/* Native select on purpose: keyboard navigation, type-ahead and
                screen-reader semantics come for free, where a custom listbox
                would have to re-earn all three. */}
            <select
              value={guard}
              onChange={(event) => selectGuard(event.target.value)}
              aria-label="Active guard"
            >
              {instances.map((instance) => (
                <option key={instance.guard} value={instance.guard}>
                  {instance.label} — {masked ? "••••••••" : short(instance.guard, 8, 6)} ·{" "}
                  {instance.network}
                </option>
              ))}
            </select>
            <span className="hint">
              {selected?.provenance}
              {selected ? ` · network ${selected.network}` : ""}
              {guardNickname ? ` · in your address book as “${guardNickname}”` : ""}
            </span>
          </label>
          {selected && !demo && (
            <div className="row" style={{ marginTop: 6 }}>
              <button className="secondary" onClick={() => setRenameTarget(selected)}>
                Rename
              </button>
              {selectedRemovable && (
                <button className="secondary" onClick={() => setDeleteTarget(selected)}>
                  Delete
                </button>
              )}
            </div>
          )}
          <div className="row" style={{ marginTop: 8 }}>
            <input
              value={newAddress}
              onChange={(event) => {
                setNewAddress(event.target.value);
                setAddError(null);
              }}
              placeholder="Add a guard contract address (C…)"
              aria-label="Guard contract address"
              disabled={adding || demo}
            />
            <button
              className="secondary"
              onClick={() => {
                const candidate = newAddress.trim();
                if (!looksLikeContractAddress(candidate)) {
                  setAddError(
                    "That is not a Soroban contract address (52 characters, starting with C).",
                  );
                  return;
                }
                addInstance(candidate, `Guard ${short(candidate, 6, 4)}`);
                setNewAddress("");
              }}
            >
              {adding ? "Checking…" : "Add"}
            </button>
          </div>
          {addError && <ErrorBlock title="Could not add that guard" detail={addError} />}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="secondary" onClick={() => setBookOpen(true)}>
              Address book
            </button>
            <span className="tiny muted">Name the addresses you operate.</span>
          </div>
        </div>

        <div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="lbl muted" style={{ fontSize: 12.5 }}>
              Admin wallet
            </span>
            {/* The observer label is the console admitting what it cannot do,
                which is the difference between a read-only view and a broken one. */}
            {observer && (
              <span className="pill warn" data-testid="observer-badge" title={WRITE_DISABLED_HINT}>
                {OBSERVER_BADGE_LABEL}
              </span>
            )}
          </div>
          <div className="row" style={{ marginTop: 5 }}>
            {wallet ? (
              <>
                <span className="pill ok">connected</span>
                {provider && <span className="pill">{provider.name}</span>}
                <AddressText address={wallet.address} />
                <button
                  className="secondary"
                  onClick={() => setPickerOpen(true)}
                  disabled={connecting}
                >
                  Change wallet
                </button>
                <button className="secondary" onClick={disconnect}>
                  Disconnect
                </button>
              </>
            ) : (
              <>
                <button onClick={() => setPickerOpen(true)} disabled={connecting}>
                  {connecting ? "Waiting for wallet…" : "Connect admin wallet"}
                </button>
                {!connecting && <span className="tiny muted">Reading stays available.</span>}
              </>
            )}
          </div>

          {networkMismatch && (
            <div className="notice warn" role="alert" data-testid="network-mismatch">
              <strong>{describeMismatch(networkMismatch)}</strong>
              <span className="tiny">{mismatchExplanation(networkMismatch)}</span>
              <div className="row" style={{ marginTop: 8 }}>
                <button onClick={() => void switchNetwork().then(setSwitchOutcome)}>
                  {switchButtonLabel(networkMismatch)}
                </button>
              </div>
              {switchOutcome && (
                <div className="tiny" data-testid="switch-outcome" style={{ marginTop: 6 }}>
                  {describeSwitchOutcome(switchOutcome).text}
                </div>
              )}
              {switchOutcome && switchOutcome.kind !== "switched" && (
                <ul className="tiny muted" style={{ marginTop: 6 }}>
                  {manualSwitchInstructions(networkMismatch).map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <p className="tiny muted" style={{ marginTop: 8 }}>
            Every write on this page is signed inside {provider ? provider.name : "your wallet"} and
            broadcast straight to Soroban RPC. The console never sees, stores or transmits a secret
            key, and there is no server component that could hold one.
          </p>
          <label className="field" style={{ marginTop: 8 }}>
            <span className="lbl">Auto-lock after inactivity</span>
            <select
              value={String(session.timeoutMs)}
              onChange={(event) => session.setTimeoutMs(Number(event.target.value))}
            >
              {IDLE_TIMEOUT_OPTIONS.map((option) => (
                <option key={option.valueMs} value={String(option.valueMs)}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="hint">
              {session.timeoutMs === 0
                ? "The session will not lock automatically."
                : `The wallet disconnects after ${Math.round(session.timeoutMs / 60000)} minute(s) of inactivity, with a 60s warning first.`}
            </span>
          </label>
          {walletError && <ErrorBlock title="Wallet connection" detail={walletError} />}
        </div>
      </div>

      {bookOpen && <AddressBookModal onClose={() => setBookOpen(false)} />}
      {renameTarget && (
        <RenameGuardModal
          instance={renameTarget}
          onClose={() => setRenameTarget(null)}
          onRename={(label) => {
            renameInstance(renameTarget.guard, label);
            setRenameTarget(null);
          }}
        />
      )}
      {deleteTarget && (
        <DeleteGuardModal
          instance={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => {
            removeInstance(deleteTarget.guard);
            setDeleteTarget(null);
          }}
        />
      )}
      {pickerOpen && (
        <WalletPickerModal
          availableProviders={availableProviders}
          currentProvider={providerId}
          connecting={connecting}
          onClose={() => setPickerOpen(false)}
          onChoose={(id) => {
            setPickerOpen(false);
            void connect(id);
          }}
        />
      )}
    </div>
  );
}

/**
 * Rename a saved guard.
 *
 * A small dialog rather than an inline edit so the change is explicit and the
 * label can be reviewed before it is written; the operator's own label is what
 * the switcher shows, so a mis-typed rename is a mis-identified guard.
 */
export function RenameGuardModal({
  instance,
  onClose,
  onRename,
}: {
  instance: GuardInstance;
  onClose: () => void;
  onRename: (label: string) => void;
}) {
  const [label, setLabel] = useState(instance.label);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-guard-title"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <strong id="rename-guard-title">Rename this guard</strong>
        <p className="tiny muted mono">{instance.guard}</p>
        <label className="field">
          <span className="lbl">Label</span>
          <input
            value={label}
            autoFocus
            onChange={(event) => setLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && label.trim() !== "") onRename(label.trim());
            }}
          />
        </label>
        <div className="row">
          <button disabled={label.trim() === ""} onClick={() => onRename(label.trim())}>
            Save name
          </button>
          <button className="secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Confirm deleting a saved guard.
 *
 * This reuses the destructive-dialog pattern the PanicPanel's freeze challenge
 * established (issue #22): a deletion is not a single click. The confirm is a
 * separate, danger-styled action, and the copy states plainly what is removed —
 * the browser's saved entry and the state scoped to it — and what is not (the
 * contract on chain is untouched).
 */
export function DeleteGuardModal({
  instance,
  onClose,
  onConfirm,
}: {
  instance: GuardInstance;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-guard-title"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <strong id="delete-guard-title">Delete this saved guard?</strong>
        <p className="tiny">
          Removes <strong>{instance.label}</strong> (
          <span className="mono">{short(instance.guard, 10, 6)}</span>) from this browser&apos;s
          list and clears the drafts and filters saved for it. It does not touch the contract on
          chain.
        </p>
        <div className="row">
          <button className="danger" onClick={onConfirm}>
            Delete guard
          </button>
          <button className="secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The wallet selection modal (issue #96).
 *
 * Providers the browser did not detect are listed rather than hidden, because
 * hiding them leaves an operator with no path forward — each one is labelled
 * with where to get it, and choosing it still attempts the connection so a
 * wallet the probe missed (a permission-restricted browser, a second profile)
 * is not unfairly written off.
 */
export function WalletPickerModal({
  availableProviders,
  currentProvider,
  connecting,
  onClose,
  onChoose,
}: {
  availableProviders: WalletProviderId[];
  currentProvider: WalletProviderId | null;
  connecting: boolean;
  onClose: () => void;
  onChoose: (provider: WalletProviderId) => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wallet-picker-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <strong id="wallet-picker-title">Choose a wallet provider</strong>
        <p className="tiny muted">
          Any of these can sign for a guard. The console remembers which one you use.
        </p>
        <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
          {WALLET_PROVIDERS.map((descriptor) => {
            const detected = availableProviders.includes(descriptor.id);
            const isCurrent = descriptor.id === currentProvider;
            return (
              <div key={descriptor.id} className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <span className="pill" aria-hidden="true">
                    {descriptor.monogram}
                  </span>{" "}
                  <strong>{descriptor.name}</strong>
                  {isCurrent && <span className="pill ok"> current</span>}
                  <div className="tiny muted">{descriptor.blurb}</div>
                </div>
                <div className="row">
                  {detected ? (
                    <span className="pill ok tiny">detected</span>
                  ) : (
                    <a
                      className="tiny"
                      href={descriptor.installUrl}
                      target="_blank"
                      rel="noreferrer"
                      title={`Install ${descriptor.name}`}
                    >
                      not detected — get {descriptor.name}
                    </a>
                  )}
                  <button disabled={connecting} onClick={() => onChoose(descriptor.id)}>
                    {detected ? "Connect" : "Try anyway"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="secondary" onClick={onClose}>
            Cancel
          </button>
          <span className="tiny muted">
            Or keep observing — every read on this page works without a wallet.
          </span>
        </div>
      </div>
    </div>
  );
}
