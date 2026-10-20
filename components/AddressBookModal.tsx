"use client";

/**
 * The operator address book modal (issues #100, #376, #377).
 *
 * Lets the operator name Stellar addresses ("Treasury Multisig", "Soroswap
 * Router") so the rest of the console can render those names instead of a wall
 * of look-alike strkeys. Add, edit and delete are validated against the SDK's
 * address parser before they touch storage.
 *
 * Two safeguards are enforced in this component rather than left to chance:
 *
 *  - A save that collides with an existing address or alias stops and shows the
 *    conflict. Nothing is written until the operator picks rename, update or
 *    cancel, so an ambiguous nickname can never quietly take over an entry.
 *  - An import is classified first — valid, invalid, duplicate and alias
 *    conflict — and the operator confirms merge or replace against that preview.
 *    Both actions write browser-local labels only; chain state is untouched.
 *
 * The dialog reuses the focus discipline established by the freeze confirmation
 * in `PanicPanel`: focus moves in on open, Escape closes, focus returns to
 * whoever opened it.
 */

import { useEffect, useRef, useState } from "react";
import {
  applyAddressBookImport,
  deleteContact,
  exportAddressBook,
  loadAddressBook,
  normalizeAlias,
  previewAddressBookImport,
  saveContact,
  subscribeAddressBook,
  type Contact,
  type ContactConflict,
  type ContactResolution,
  type ImportMode,
  type ImportPreview,
} from "../lib/guard/addressBook.ts";
import { validateLabel } from "../lib/guard/inputSanitizer.ts";

const ISSUE_LABELS = {
  invalid: "Invalid",
  "duplicate-address": "Duplicate",
  "alias-conflict": "Alias conflict",
} as const;

export function AddressBookModal({ onClose }: { onClose: () => void }) {
  const [contacts, setContacts] = useState<Contact[]>(() => loadAddressBook());
  const [editingAddress, setEditingAddress] = useState("");
  const [editingLabel, setEditingLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ContactConflict | null>(null);
  const [pendingSave, setPendingSave] = useState<{ address: string; label: string } | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [confirmMode, setConfirmMode] = useState<ImportMode | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => subscribeAddressBook(() => setContacts(loadAddressBook())), []);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  function clearEditor() {
    setEditingAddress("");
    setEditingLabel("");
    setConflict(null);
    setPendingSave(null);
  }

  function save() {
    setError(null);
    setNotice(null);
    setConflict(null);
    setPendingSave(null);
    try {
      const result = saveContact({ address: editingAddress, label: editingLabel });
      if (result.status === "conflict") {
        // Existing entries stay exactly as they are until a resolution is chosen.
        setPendingSave({ address: editingAddress.trim(), label: normalizeAlias(editingLabel) });
        setConflict(result.conflict);
        return;
      }
      setNotice(
        result.action === "unchanged"
          ? "That address already has this alias; nothing changed."
          : `Saved "${result.contact.label}".`,
      );
      clearEditor();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function resolveConflict(resolution: ContactResolution) {
    if (!pendingSave) return;
    setError(null);
    try {
      const result = saveContact({ ...pendingSave, resolution });
      if (result.status === "conflict") {
        setConflict(result.conflict);
        return;
      }
      setNotice(
        resolution === "rename"
          ? `Saved the new address as "${result.contact.label}" so the existing alias is unchanged.`
          : result.action === "updated" && conflict?.kind === "alias-conflict"
            ? `Moved the alias "${result.contact.label}" to ${result.contact.address}; the previous holder was removed.`
            : `Updated ${result.contact.address} to "${result.contact.label}".`,
      );
      clearEditor();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function cancelConflict() {
    setConflict(null);
    setPendingSave(null);
    setNotice("No changes were made; the existing entry is untouched.");
  }

  function edit(contact: Contact) {
    setEditingAddress(contact.address);
    setEditingLabel(contact.label);
    setError(null);
    setConflict(null);
    setPendingSave(null);
  }

  function remove(address: string) {
    deleteContact(address);
    if (editingAddress === address) {
      clearEditor();
    }
  }

  function doExport() {
    const blob = new Blob([exportAddressBook(contacts)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "stellar-agent-guard-address-book.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function doImport(file: File) {
    setError(null);
    setNotice(null);
    setPreview(null);
    setConfirmMode(null);
    try {
      const text = await file.text();
      const next = previewAddressBookImport(text, loadAddressBook());
      setPreview(next);
      if (next.mergeable.length === 0 && next.replaceable.length === 0) {
        setNotice("Nothing in that file can be imported; see the reasons below.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function confirmImport(mode: ImportMode) {
    if (!preview) return;
    const tally = applyAddressBookImport(preview, mode);
    setNotice(
      mode === "merge"
        ? `Merged ${tally.applied} contact(s) into the book; ${tally.skipped} record(s) were skipped. The book now has ${tally.total}.`
        : `Replaced the book with ${tally.applied} imported contact(s); ${tally.skipped} record(s) were skipped. The book now has ${tally.total}.`,
    );
    setPreview(null);
    setConfirmMode(null);
    clearEditor();
  }

  const addressInBook = contacts.some((contact) => contact.address === editingAddress.trim());
  // The label policy (issue #384) is also enforced here as a field-level error,
  // live as the operator types: invisible and control characters are named at
  // the field instead of only after the save is refused.
  const labelCheck = validateLabel(editingLabel);
  const labelError = labelCheck.ok ? null : labelCheck.error;
  const previewHasIssues =
    preview !== null &&
    preview.invalid.length + preview.duplicates.length + preview.aliasConflicts.length > 0;

  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="address-book-title"
        ref={dialogRef}
        tabIndex={-1}
      >
        <strong id="address-book-title">Address book</strong>
        <p className="tiny muted">
          Give the addresses you operate a name. Nicknames appear beside truncated addresses
          wherever the console shows them; the full address is always available on hover. Labels are
          browser-local convenience data and are never sent to the network.
        </p>

        <label className="field">
          <span className="lbl">Address (G… account or C… contract)</span>
          <input
            value={editingAddress}
            onChange={(event) => {
              setEditingAddress(event.target.value);
              setError(null);
              setConflict(null);
              setPendingSave(null);
            }}
            placeholder="GBUQ…"
            aria-label="Contact address"
          />
        </label>
        <label className="field">
          <span className="lbl">Nickname</span>
          <input
            value={editingLabel}
            onChange={(event) => {
              setEditingLabel(event.target.value);
              setError(null);
              setConflict(null);
              setPendingSave(null);
            }}
            placeholder="Treasury Multisig"
            aria-label="Contact nickname"
            aria-invalid={labelError === null ? undefined : true}
            aria-describedby={labelError === null ? undefined : "contact-label-error"}
          />
          {labelError !== null && (
            <span
              id="contact-label-error"
              className="hint"
              role="alert"
              style={{ color: "var(--danger)" }}
            >
              {labelError}
            </span>
          )}
        </label>
        {error && (
          <div className="error" role="alert">
            <span className="t">Could not save that contact</span>
            <span className="mono">{error}</span>
          </div>
        )}
        {notice && <div className="notice info">{notice}</div>}

        {conflict && pendingSave && (
          <div className="notice" role="alert">
            <strong>
              {conflict.kind === "duplicate-address"
                ? "That address is already saved"
                : "That alias is already in use"}
            </strong>
            <span className="tiny">
              {conflict.kind === "duplicate-address"
                ? `${conflict.address} is saved as "${conflict.existing.label}".`
                : `"${conflict.existing.label}" belongs to ${conflict.existing.address}.`}{" "}
              Nothing has been changed yet — choose how to resolve it.
            </span>
            <div className="row" style={{ flexWrap: "wrap" }}>
              {conflict.suggestedLabel !== null && (
                <button onClick={() => resolveConflict("rename")}>
                  Rename to “{conflict.suggestedLabel}”
                </button>
              )}
              <button className="secondary" onClick={() => resolveConflict("update")}>
                {conflict.kind === "duplicate-address"
                  ? "Update label"
                  : "Move alias to this address"}
              </button>
              <button className="secondary" onClick={cancelConflict}>
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="row">
          <button onClick={save} disabled={conflict !== null}>
            {addressInBook ? "Update contact" : "Add contact"}
          </button>
          <button className="secondary" onClick={doExport} disabled={contacts.length === 0}>
            Export JSON
          </button>
          <button className="secondary" onClick={() => fileInputRef.current?.click()}>
            Import JSON
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="visually-hidden"
            aria-label="Import address book file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void doImport(file);
            }}
          />
        </div>

        {preview && (
          <div
            className="notice info"
            style={{ marginTop: 12 }}
            role="group"
            aria-label="Import preview"
          >
            <strong>
              Import preview — version {preview.version}
              {preview.legacy ? " (legacy, upgraded on import)" : ""}
            </strong>
            <span className="tiny">
              {preview.total} record(s) read: {preview.mergeable.length} can be merged,{" "}
              {preview.replaceable.length} can be written by a replace, {preview.invalid.length}{" "}
              invalid, {preview.duplicates.length} duplicate, {preview.aliasConflicts.length} alias
              conflict. Nothing has been imported.
            </span>

            {previewHasIssues && (
              <ul className="tiny" style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {preview.issues.slice(0, 20).map((issue) => (
                  <li key={`${issue.kind}-${issue.index}`}>
                    <strong>{ISSUE_LABELS[issue.kind]}:</strong> {issue.reason}
                  </li>
                ))}
                {preview.issues.length > 20 && (
                  <li className="muted">…and {preview.issues.length - 20} more.</li>
                )}
              </ul>
            )}
            {preview.warnings.map((warning) => (
              <span className="tiny muted" key={warning}>
                {warning}
              </span>
            ))}

            {confirmMode === null ? (
              <div className="row" style={{ flexWrap: "wrap" }}>
                <button
                  onClick={() => setConfirmMode("merge")}
                  disabled={preview.mergeable.length === 0}
                >
                  Merge {preview.mergeable.length} contact(s)
                </button>
                <button
                  className="secondary"
                  onClick={() => setConfirmMode("replace")}
                  disabled={preview.replaceable.length === 0}
                >
                  Replace book with {preview.replaceable.length}
                </button>
                <button className="secondary" onClick={() => setPreview(null)}>
                  Cancel import
                </button>
              </div>
            ) : (
              <div className="row" style={{ flexWrap: "wrap" }}>
                <span className="tiny" style={{ flexBasis: "100%" }}>
                  {confirmMode === "merge"
                    ? `Add ${preview.mergeable.length} contact(s) and keep the ${contacts.length} already saved. Conflicts listed above are skipped, never overwritten.`
                    : `Replace all ${contacts.length} local contact(s) with ${preview.replaceable.length} imported contact(s). Local contacts not in this file will be removed.`}
                </span>
                <button onClick={() => confirmImport(confirmMode)}>
                  Confirm {confirmMode === "merge" ? "merge" : "replace"}
                </button>
                <button className="secondary" onClick={() => setConfirmMode(null)}>
                  Back
                </button>
              </div>
            )}
          </div>
        )}

        <div className="stack" style={{ marginTop: 12 }}>
          {contacts.length === 0 ? (
            <p className="tiny muted">No contacts yet. Add one above.</p>
          ) : (
            contacts.map((contact) => (
              <div
                key={contact.address}
                className="checkline"
                style={{ justifyContent: "space-between" }}
              >
                <span>
                  <strong style={{ fontSize: 13 }}>{contact.label}</strong>{" "}
                  <span className="mono tiny muted" title={contact.address}>
                    {contact.address.slice(0, 6)}…{contact.address.slice(-4)}
                  </span>
                </span>
                <span className="row" style={{ gap: 6 }}>
                  <button className="secondary" onClick={() => edit(contact)}>
                    Edit
                  </button>
                  <button className="secondary" onClick={() => remove(contact.address)}>
                    Delete
                  </button>
                </span>
              </div>
            ))
          )}
        </div>

        <div className="row">
          <button className="secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
