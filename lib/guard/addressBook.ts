/**
 * The operator's address book: human-readable nicknames for Stellar addresses.
 *
 * `GA7Q…` and `CA3D…` are effectively unreadable once there are more than two of
 * them, and mistaking one for another when editing a policy allowlist is exactly
 * the kind of error a spend cap cannot catch. This module stores the
 * address-to-label mapping the operator curates, so the UI can render
 * "Soroswap Router (CA3D…12EF)" wherever an address appears.
 *
 * The persistence and validation seam mirrors `txHistory.ts` and `instance.ts`:
 * reads and writes are best-effort (private-mode and corrupt payloads degrade to
 * an empty book, never a crash), every stored address is validated with the SDK
 * so a bad import cannot poison the book, and `StorageLike` is injectable for
 * tests.
 *
 * Two rules make the book safe to move between workstations (issues #376, #377):
 *
 *  - The portable file is *versioned* and carries only public addresses, labels
 *    and the schema version — no timestamps, no wallet or browser state.
 *  - A write never silently replaces an entry. `saveContact` returns a conflict
 *    descriptor and the caller must choose `rename` or `update`; an import is
 *    likewise previewed record by record before anything changes.
 *
 * Nothing here touches chain state: the book is local convenience data, never a
 * substitute for a live read.
 *
 * Labels additionally follow the label policy in `inputSanitizer.ts` (issue
 * #384): whitespace is normalized (below), while invisible and control
 * characters are refused with a field-level error — typed saves, imported
 * records and previously stored entries all run through the same screen, so a
 * deceptive label can enter the book by no route.
 */

import { Address } from "@stellar/stellar-sdk";
import { validateLabel } from "./inputSanitizer.ts";
import {
  decodeVersionedRecord,
  encodeVersionedRecord,
  writeStoredValue,
} from "./versionedStorage.ts";

export interface Contact {
  /** A valid Stellar account (`G…`) or contract (`C…`) address. Identity. */
  address: string;
  /** The operator's own label, e.g. "Treasury Multisig". */
  label: string;
  /** ISO 8601 timestamp of when the contact was first added. */
  addedAt: string;
}

export const ADDRESS_BOOK_STORAGE_KEY = "stellar-agent-guard-dashboard.addressBook.v1";
export const ADDRESS_BOOK_SCHEMA = "stellar-agent-guard/address-book-storage";
export const ADDRESS_BOOK_VERSION = 1;

/** Stable identifier written into every exported file. */
export const ADDRESS_BOOK_EXPORT_SCHEMA = "stellar-agent-guard/address-book";

/** The export format this dashboard writes and reads. */
export const ADDRESS_BOOK_EXPORT_VERSION = 1;

/** Cap on stored contacts, so a bad import cannot grow without bound. */
export const ADDRESS_BOOK_LIMIT = 500;

/** The subset of `Storage` the store needs, so tests can inject a fake. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Addresses and aliases                                                      */
/* -------------------------------------------------------------------------- */

/** A well-formed account (`G…`) or contract (`C…`) address, checked with the SDK. */
export function isValidAddress(value: string): boolean {
  try {
    Address.fromString(value.trim());
    return true;
  } catch {
    return false;
  }
}

/** Validate a contact address and return a helpful reason if it is invalid. */
export function validateContactAddress(value: string):
  | {
      ok: true;
      address: string;
    }
  | {
      ok: false;
      reason: string;
    } {
  const trimmed = value.trim();
  if (trimmed === "") {
    return { ok: false, reason: "A contact needs an address." };
  }
  try {
    Address.fromString(trimmed);
    return { ok: true, address: trimmed };
  } catch {
    if (!/^G[A-Z2-7]{55}$/.test(trimmed) && !/^C[A-Z2-7]{55}$/.test(trimmed)) {
      return {
        ok: false,
        reason:
          "Stellar addresses start with G (account) or C (contract) and are 56 characters long.",
      };
    }
    if (trimmed.length !== 56) {
      return {
        ok: false,
        reason: `A Stellar address must be 56 characters; this one has ${trimmed.length}.`,
      };
    }
    return {
      ok: false,
      reason: "That doesn't look like a valid Stellar address; check for typos.",
    };
  }
}

/**
 * The canonical form of an operator alias.
 *
 * Leading/trailing whitespace is dropped and internal runs of whitespace
 * collapse to one space, so `"  Treasury   Multisig "` and `"Treasury Multisig"`
 * are the same alias. Case is preserved for display; conflict detection compares
 * `aliasKey` instead, which folds case.
 */
export function normalizeAlias(label: string): string {
  return label.trim().replace(/\s+/g, " ");
}

/** The comparison key for an alias: normalized, then case-folded. */
export function aliasKey(label: string): string {
  return normalizeAlias(label).toLowerCase();
}

function sameAddress(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

/**
 * A free alias derived from `base`: `"Treasury"` becomes `"Treasury (2)"`,
 * `"Treasury (3)"`, … skipping any alias already taken (case-insensitively).
 * Deterministic, so the UI can show exactly what `rename` will store.
 */
export function suggestedAlias(base: string, contacts: readonly Contact[]): string {
  const normalized = normalizeAlias(base);
  const taken = new Set(contacts.map((contact) => aliasKey(contact.label)));
  let suffix = 2;
  while (taken.has(aliasKey(`${normalized} (${suffix})`))) suffix += 1;
  return `${normalized} (${suffix})`;
}

/* -------------------------------------------------------------------------- */
/* Storage                                                                    */
/* -------------------------------------------------------------------------- */

const listeners = new Set<() => void>();

/** Watch for contact changes made anywhere in this tab (add, edit, delete, import). */
export function subscribeAddressBook(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function isContact(value: unknown): value is Contact {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<Contact>;
  return (
    typeof entry.address === "string" &&
    typeof entry.label === "string" &&
    isValidAddress(entry.address) &&
    normalizeAlias(entry.label) !== "" &&
    // An entry that predates the label policy (or arrived in storage from a
    // hand-edited payload) is dropped rather than re-admitted: loading is a
    // save path too.
    validateLabel(entry.label).ok
  );
}

/** The stored book, validated and de-duplicated by address. A corrupt payload yields an empty book. */
export function loadAddressBook(storage: StorageLike | null = defaultStorage()): Contact[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(ADDRESS_BOOK_STORAGE_KEY);
    if (!raw) return [];
    const decoded = decodeVersionedRecord({
      raw,
      schema: ADDRESS_BOOK_SCHEMA,
      version: ADDRESS_BOOK_VERSION,
      migrations: { 0: (value) => value },
      validate: (value): value is unknown[] => Array.isArray(value),
    });
    if (!decoded.ok) return [];
    const fullyValid = decoded.value.every(isContact);
    if (decoded.needsMigration && fullyValid) {
      writeStoredValue(
        storage,
        ADDRESS_BOOK_STORAGE_KEY,
        encodeVersionedRecord(ADDRESS_BOOK_SCHEMA, ADDRESS_BOOK_VERSION, decoded.value),
      );
    }
    const seen = new Set<string>();
    const out: Contact[] = [];
    for (const entry of decoded.value) {
      if (!isContact(entry)) continue;
      const address = entry.address.trim();
      if (seen.has(address)) continue;
      seen.add(address);
      out.push({ ...entry, address, label: normalizeAlias(entry.label) });
    }
    return out.slice(0, ADDRESS_BOOK_LIMIT);
  } catch {
    return [];
  }
}

function persist(contacts: Contact[], storage: StorageLike | null): Contact[] {
  if (storage) {
    writeStoredValue(
      storage,
      ADDRESS_BOOK_STORAGE_KEY,
      encodeVersionedRecord(ADDRESS_BOOK_SCHEMA, ADDRESS_BOOK_VERSION, contacts),
    );
  }
  return contacts;
}

/* -------------------------------------------------------------------------- */
/* Saving with explicit conflict resolution                                   */
/* -------------------------------------------------------------------------- */

/** The explicit ways an operator may resolve a save conflict. `cancel` is UI-only. */
export type ContactResolution = "rename" | "update";

/** A save that could not be applied without the operator choosing a resolution. */
export interface ContactConflict {
  kind: "duplicate-address" | "alias-conflict";
  /** The normalized address the operator tried to save. */
  address: string;
  /** The normalized alias the operator tried to save. */
  label: string;
  /** The entry already holding the address or alias. Left untouched until resolved. */
  existing: Contact;
  /** Resolutions that would apply this save. The UI always offers cancel as well. */
  resolutions: ContactResolution[];
  /** What `rename` would store, for an alias conflict; `null` otherwise. */
  suggestedLabel: string | null;
}

export type SaveContactResult =
  | {
      status: "saved";
      action: "added" | "updated" | "renamed" | "unchanged";
      contact: Contact;
      contacts: Contact[];
    }
  | { status: "conflict"; conflict: ContactConflict; contacts: Contact[] };

/** A duplicate-address update keeps the original `addedAt`, like `upsertContact` did. */
function relabel(existing: Contact[], address: string, label: string): Contact[] {
  return existing.map((contact) =>
    sameAddress(contact.address, address) ? { ...contact, label } : contact,
  );
}

/**
 * Save a contact, refusing to overwrite anything without an explicit resolution.
 *
 * Outcomes, in order of precedence:
 *  - Invalid address or blank alias → throws, so the UI can show the reason.
 *  - Same address, same alias (after normalization/case folding) → `unchanged`,
 *    nothing written.
 *  - Same address, different alias → `duplicate-address` conflict. Apply with
 *    `resolution: "update"`, which relabels that one entry and keeps `addedAt`.
 *  - A *different* address already uses the alias → `alias-conflict` conflict.
 *    `resolution: "rename"` stores the new contact under `suggestedLabel`;
 *    `resolution: "update"` explicitly removes the old holder and gives the
 *    alias to the new address.
 *
 * Existing entries are never modified before the caller confirms a resolution.
 */
export function saveContact(
  input: { address: string; label: string; resolution?: ContactResolution },
  storage: StorageLike | null = defaultStorage(),
): SaveContactResult {
  const address = input.address.trim();
  if (!isValidAddress(address)) {
    throw new Error(
      `"${address || "(empty)"}" is not a valid Stellar address (a G… or C… account).`,
    );
  }
  // Screened on the raw input, before normalization: a label the policy
  // refuses throws with its field-level message rather than being silently
  // rewritten into something the operator did not type.
  const labelCheck = validateLabel(input.label);
  if (!labelCheck.ok) throw new Error(labelCheck.error);
  const label = normalizeAlias(input.label);
  if (label === "") {
    throw new Error("A contact needs a label.");
  }

  const existing = loadAddressBook(storage);
  const prior = existing.find((contact) => sameAddress(contact.address, address));

  if (prior) {
    if (aliasKey(prior.label) === aliasKey(label)) {
      return { status: "saved", action: "unchanged", contact: prior, contacts: existing };
    }
    if (input.resolution !== "update") {
      return {
        status: "conflict",
        conflict: {
          kind: "duplicate-address",
          address,
          label,
          existing: prior,
          resolutions: ["update"],
          suggestedLabel: null,
        },
        contacts: existing,
      };
    }
    const contact: Contact = { ...prior, label };
    const contacts = persist(relabel(existing, address, label), storage);
    notify();
    return { status: "saved", action: "updated", contact, contacts };
  }

  const holder = existing.find(
    (contact) =>
      !sameAddress(contact.address, address) && aliasKey(contact.label) === aliasKey(label),
  );

  if (holder && input.resolution !== "rename" && input.resolution !== "update") {
    return {
      status: "conflict",
      conflict: {
        kind: "alias-conflict",
        address,
        label,
        existing: holder,
        resolutions: ["rename", "update"],
        suggestedLabel: suggestedAlias(label, existing),
      },
      contacts: existing,
    };
  }

  if (existing.length >= ADDRESS_BOOK_LIMIT) {
    throw new Error(
      `The address book is full (${ADDRESS_BOOK_LIMIT} contacts). Delete a contact before adding another.`,
    );
  }

  if (holder && input.resolution === "rename") {
    const renamed = suggestedAlias(label, existing);
    const contact: Contact = { address, label: renamed, addedAt: new Date().toISOString() };
    const contacts = persist([contact, ...existing], storage);
    notify();
    return { status: "saved", action: "renamed", contact, contacts };
  }

  // A confirmed `update` of an alias conflict: the alias moves to the new
  // address, and the previous holder is removed rather than left ambiguous.
  const base =
    holder && input.resolution === "update"
      ? existing.filter((contact) => !sameAddress(contact.address, holder.address))
      : existing;
  const contact: Contact = { address, label, addedAt: new Date().toISOString() };
  const contacts = persist([contact, ...base].slice(0, ADDRESS_BOOK_LIMIT), storage);
  notify();
  return {
    status: "saved",
    action: holder ? "updated" : "added",
    contact,
    contacts,
  };
}

/**
 * Backwards-compatible convenience wrapper around `saveContact`.
 *
 * Re-adding a known address relabels it; a new address whose alias is taken is
 * stored under a disambiguated alias. It never deletes an entry. New UI code
 * should call `saveContact` directly so the operator sees the conflict and
 * chooses.
 */
export function upsertContact(
  input: { address: string; label: string },
  storage: StorageLike | null = defaultStorage(),
): Contact[] {
  const first = saveContact(input, storage);
  if (first.status === "saved") return first.contacts;
  const resolution: ContactResolution =
    first.conflict.kind === "duplicate-address" ? "update" : "rename";
  const resolved = saveContact({ ...input, resolution }, storage);
  return resolved.contacts;
}

/** Remove a contact by address. Removing an unknown address is a no-op. */
export function deleteContact(
  address: string,
  storage: StorageLike | null = defaultStorage(),
): Contact[] {
  const trimmed = address.trim();
  const existing = loadAddressBook(storage);
  if (!existing.some((contact) => sameAddress(contact.address, trimmed))) return existing;
  const contacts = persist(
    existing.filter((contact) => !sameAddress(contact.address, trimmed)),
    storage,
  );
  notify();
  return contacts;
}

/** The friendly label for an address, or `null` when it is not in the book. */
export function lookupLabel(
  address: string,
  storage: StorageLike | null = defaultStorage(),
): string | null {
  const trimmed = address.trim();
  if (trimmed === "") return null;
  return (
    loadAddressBook(storage).find((contact) => sameAddress(contact.address, trimmed))?.label ?? null
  );
}

/* -------------------------------------------------------------------------- */
/* Versioned export                                                           */
/* -------------------------------------------------------------------------- */

/** One record in the portable file: a public address and its label, nothing else. */
export interface AddressBookExportRecord {
  address: string;
  label: string;
}

/** The versioned file format. Deliberately excludes `addedAt` and browser state. */
export interface AddressBookExportDocument {
  schema: typeof ADDRESS_BOOK_EXPORT_SCHEMA;
  version: number;
  exportedAt: string;
  contacts: AddressBookExportRecord[];
}

/** The export as an object, for callers that want to inspect it before serialising. */
export function addressBookExportDocument(
  contacts: readonly Contact[],
  exportedAt: Date = new Date(),
): AddressBookExportDocument {
  return {
    schema: ADDRESS_BOOK_EXPORT_SCHEMA,
    version: ADDRESS_BOOK_EXPORT_VERSION,
    exportedAt: exportedAt.toISOString(),
    contacts: contacts.map((contact) => ({
      address: contact.address.trim(),
      label: normalizeAlias(contact.label),
    })),
  };
}

/** The book as a portable, versioned JSON file. */
export function exportAddressBook(contacts: readonly Contact[], exportedAt?: Date): string {
  return `${JSON.stringify(addressBookExportDocument(contacts, exportedAt), null, 2)}\n`;
}

/* -------------------------------------------------------------------------- */
/* Import: parse, preview, apply                                              */
/* -------------------------------------------------------------------------- */

interface ParsedDocument {
  version: number;
  legacy: boolean;
  records: unknown[];
}

/**
 * Read the envelope of an address-book file.
 *
 * Version 1 is `{ schema, version, exportedAt, contacts }`; a bare array is the
 * version-0 format this dashboard shipped before issue #376, and is still read
 * so older backups keep working. Anything else is rejected by version rather
 * than guessed at.
 */
function readDocument(source: string): ParsedDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("The file is not valid JSON.");
  }
  if (Array.isArray(parsed)) {
    return { version: 0, legacy: true, records: parsed };
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("The address book must be a JSON object or a legacy array of contacts.");
  }
  const document = parsed as Record<string, unknown>;
  if (typeof document.version !== "number" || !Number.isInteger(document.version)) {
    throw new Error("The address-book file has no integer schema version.");
  }
  if (document.version !== ADDRESS_BOOK_EXPORT_VERSION) {
    throw new Error(
      `Unsupported address-book file version ${document.version}; this dashboard reads version ${ADDRESS_BOOK_EXPORT_VERSION} and the legacy array format.`,
    );
  }
  if (document.schema !== undefined && document.schema !== ADDRESS_BOOK_EXPORT_SCHEMA) {
    throw new Error(`Unsupported address-book schema ${String(document.schema)}.`);
  }
  if (!Array.isArray(document.contacts)) {
    throw new Error("The address-book file has no contacts array.");
  }
  return { version: document.version, legacy: false, records: document.contacts };
}

interface ParsedRecord {
  address: string;
  label: string;
}

/**
 * Validate one imported record, or say precisely why it is invalid.
 *
 * The returned `reason` is operator-facing and includes the record number, so a
 * preview can point at the offending line without rejecting the whole file.
 */
function parseRecord(entry: unknown, index: number): ParsedRecord | { error: string } {
  if (typeof entry !== "object" || entry === null) {
    return { error: `Contact ${index + 1} must be an object.` };
  }
  const value = entry as Record<string, unknown>;
  const address = typeof value.address === "string" ? value.address.trim() : "";
  const rawLabel = typeof value.label === "string" ? value.label : "";
  if (!isValidAddress(address)) {
    return {
      error: `Contact ${index + 1}: "${address || "(empty)"}" is not a valid Stellar address.`,
    };
  }
  // The same label policy as a typed save: an imported label with invisible
  // characters is reported record by record in the preview, never half-applied.
  const labelCheck = validateLabel(rawLabel);
  if (!labelCheck.ok) {
    return { error: `Contact ${index + 1}: ${labelCheck.error}` };
  }
  const label = normalizeAlias(rawLabel);
  if (label === "") {
    return { error: `Contact ${index + 1}: a label is required.` };
  }
  return { address, label };
}

/**
 * Parse an exported book back into contacts, strictly.
 *
 * Every address is validated and every label required, so a corrupted or
 * hand-edited import is rejected with the offending index rather than half
 * landing in the book. Reads both version 1 and the legacy array format.
 */
export function parseAddressBook(source: string): Contact[] {
  const document = readDocument(source);
  const seen = new Set<string>();
  return document.records.map((entry, index) => {
    const parsed = parseRecord(entry, index);
    if ("error" in parsed) throw new Error(parsed.error);
    if (seen.has(parsed.address)) {
      throw new Error(`Contact ${index + 1}: duplicate address ${parsed.address}.`);
    }
    seen.add(parsed.address);
    return { address: parsed.address, label: parsed.label, addedAt: new Date().toISOString() };
  });
}

export type ImportIssueKind = "invalid" | "duplicate-address" | "alias-conflict";

/** One record that an import would not apply cleanly, with the reason. */
export interface ImportIssue {
  kind: ImportIssueKind;
  /** 1-based position in the imported file. */
  index: number;
  address: string;
  label: string;
  reason: string;
  /** The local entry causing a duplicate/alias conflict; `null` for invalid records. */
  existing: Contact | null;
}

export type ImportMode = "merge" | "replace";

/**
 * Everything the operator needs to decide before local data changes.
 *
 * `result.merge` keeps every existing contact and adds only records with no
 * conflict; `result.replace` discards the current book and writes every record
 * that is valid and unique *within the file*. A record that conflicts with the
 * current book is therefore applyable under `replace` but not `merge` — which is
 * why both plans are computed from the same preview.
 */
export interface ImportPreview {
  version: number;
  /** `true` for the pre-#376 bare-array format, upgraded on import. */
  legacy: boolean;
  /** Records in the file. */
  total: number;
  /** New contacts a merge would add, in file order. */
  mergeable: Contact[];
  /** Contacts a replace would write, in file order. */
  replaceable: Contact[];
  /** What the whole book becomes under each mode. */
  result: { merge: Contact[]; replace: Contact[] };
  invalid: ImportIssue[];
  duplicates: ImportIssue[];
  aliasConflicts: ImportIssue[];
  /** All issues in file order, for rendering. */
  issues: ImportIssue[];
  /** Non-fatal observations, e.g. the legacy format being upgraded. */
  warnings: string[];
}

/**
 * Classify an imported file against the current book without writing anything.
 *
 * Conflict rules, applied per record in file order:
 *  - invalid address/label → `invalid`, skipped by both modes;
 *  - repeats an address already seen in this file → `duplicate-address`;
 *  - alias taken by a *different* address earlier in the file → `alias-conflict`
 *    (a replacement book cannot hold both, so `replace` skips it too);
 *  - address already in the local book → `duplicate-address` (with the local
 *    entry attached); merge skips it, replace accepts the imported label;
 *  - alias already used by a different local address → `alias-conflict`; merge
 *    skips it, replace accepts it.
 *
 * Skipped records are reported, never silently renamed or overwritten.
 */
export function previewAddressBookImport(
  source: string,
  current: readonly Contact[],
): ImportPreview {
  const document = readDocument(source);
  const issues: ImportIssue[] = [];
  const invalid: ImportIssue[] = [];
  const duplicates: ImportIssue[] = [];
  const aliasConflicts: ImportIssue[] = [];
  const warnings: string[] = [];
  const mergeable: Contact[] = [];
  const replaceable: Contact[] = [];

  const fileAddresses = new Set<string>();
  const fileAliases = new Map<string, string>();

  const addIssue = (issue: ImportIssue) => {
    issues.push(issue);
    if (issue.kind === "invalid") invalid.push(issue);
    else if (issue.kind === "duplicate-address") duplicates.push(issue);
    else aliasConflicts.push(issue);
  };

  const localByAddress = new Map(current.map((contact) => [contact.address.trim(), contact]));
  const localByAlias = new Map(current.map((contact) => [aliasKey(contact.label), contact]));

  document.records.forEach((entry, index) => {
    const parsed = parseRecord(entry, index);
    if ("error" in parsed) {
      addIssue({
        kind: "invalid",
        index: index + 1,
        address:
          typeof (entry as { address?: unknown })?.address === "string"
            ? String((entry as { address?: string }).address).trim()
            : "",
        label:
          typeof (entry as { label?: unknown })?.label === "string"
            ? normalizeAlias(String((entry as { label?: string }).label))
            : "",
        reason: parsed.error,
        existing: null,
      });
      return;
    }

    const contact: Contact = {
      address: parsed.address,
      label: parsed.label,
      addedAt: new Date().toISOString(),
    };

    if (fileAddresses.has(parsed.address)) {
      addIssue({
        kind: "duplicate-address",
        index: index + 1,
        address: parsed.address,
        label: parsed.label,
        reason: `Contact ${index + 1}: ${parsed.address} appears more than once in this file.`,
        existing: null,
      });
      return;
    }
    const earlierAliasAddress = fileAliases.get(aliasKey(parsed.label));
    if (earlierAliasAddress !== undefined) {
      addIssue({
        kind: "alias-conflict",
        index: index + 1,
        address: parsed.address,
        label: parsed.label,
        reason: `Contact ${index + 1}: the alias "${parsed.label}" is also used by ${earlierAliasAddress} in this file.`,
        existing: null,
      });
      return;
    }

    fileAddresses.add(parsed.address);
    fileAliases.set(aliasKey(parsed.label), parsed.address);

    const localSameAddress = localByAddress.get(parsed.address);
    if (localSameAddress) {
      if (aliasKey(localSameAddress.label) === aliasKey(parsed.label)) {
        addIssue({
          kind: "duplicate-address",
          index: index + 1,
          address: parsed.address,
          label: parsed.label,
          reason: `Contact ${index + 1}: ${parsed.address} is already saved with this alias.`,
          existing: localSameAddress,
        });
        // A replace can still keep it as the authoritative copy.
        replaceable.push(contact);
        return;
      }
      addIssue({
        kind: "duplicate-address",
        index: index + 1,
        address: parsed.address,
        label: parsed.label,
        reason: `Contact ${index + 1}: ${parsed.address} is already saved as "${localSameAddress.label}"; the local alias is kept unless you replace the book.`,
        existing: localSameAddress,
      });
      replaceable.push(contact);
      return;
    }

    const localAliasHolder = localByAlias.get(aliasKey(parsed.label));
    if (localAliasHolder && !sameAddress(localAliasHolder.address, parsed.address)) {
      addIssue({
        kind: "alias-conflict",
        index: index + 1,
        address: parsed.address,
        label: parsed.label,
        reason: `Contact ${index + 1}: the alias "${parsed.label}" is already used by ${localAliasHolder.address}; merge skips it, replace moves the alias.`,
        existing: localAliasHolder,
      });
      replaceable.push(contact);
      return;
    }

    mergeable.push(contact);
    replaceable.push(contact);
  });

  if (document.legacy) {
    warnings.push(
      "This is a legacy (version 0) export; it will be upgraded to version 1 on import.",
    );
  }
  if (mergeable.length + current.length > ADDRESS_BOOK_LIMIT) {
    warnings.push(
      `The merged book would exceed ${ADDRESS_BOOK_LIMIT} contacts; only the first ${ADDRESS_BOOK_LIMIT} are kept.`,
    );
  }
  if (replaceable.length > ADDRESS_BOOK_LIMIT) {
    warnings.push(
      `The imported file exceeds ${ADDRESS_BOOK_LIMIT} contacts; only the first ${ADDRESS_BOOK_LIMIT} are kept.`,
    );
  }

  return {
    version: document.version,
    legacy: document.legacy,
    total: document.records.length,
    mergeable: mergeable.slice(0, Math.max(0, ADDRESS_BOOK_LIMIT - current.length)),
    replaceable: replaceable.slice(0, ADDRESS_BOOK_LIMIT),
    result: {
      merge: [...current, ...mergeable].slice(0, ADDRESS_BOOK_LIMIT),
      replace: replaceable.slice(0, ADDRESS_BOOK_LIMIT),
    },
    invalid,
    duplicates,
    aliasConflicts,
    issues,
    warnings,
  };
}

/** The result of applying a previewed import. */
export interface ImportTally {
  mode: ImportMode;
  /** Records written to the book (new or relabelled under replace). */
  applied: number;
  /** Records skipped because they were invalid or conflicted. */
  skipped: number;
  total: number;
  /** The book after the import. */
  contacts: Contact[];
}

/**
 * Apply a previewed import. The only function here that writes during an
 * import, and it writes only browser-local address-book data — no chain state,
 * wallet configuration or signing material is touched.
 */
export function applyAddressBookImport(
  preview: ImportPreview,
  mode: ImportMode,
  storage: StorageLike | null = defaultStorage(),
): ImportTally {
  const contacts = mode === "merge" ? preview.result.merge : preview.result.replace;
  const applied = mode === "merge" ? preview.mergeable.length : preview.replaceable.length;
  // Persist before notifying: subscribers re-read storage on notify, so the
  // reverse order would show the old book until the next unrelated change.
  persist(contacts, storage);
  notify();
  return {
    mode,
    applied,
    skipped: Math.max(0, preview.total - applied),
    total: contacts.length,
    contacts,
  };
}

/**
 * Merge an imported book into the current one, additively.
 *
 * Kept for callers that have already validated their records. Existing contacts
 * not present in the import are kept — an import should not silently delete
 * addresses the operator already relied on. On an address collision the imported
 * label wins; this is an explicit merge, not the interactive save path.
 */
export function mergeAddressBook(
  current: Contact[],
  incoming: Contact[],
  storage: StorageLike | null = defaultStorage(),
): ImportTally {
  const byAddress = new Map(
    current.map((contact) => [
      contact.address.trim(),
      { ...contact, label: normalizeAlias(contact.label) },
    ]),
  );
  let added = 0;
  let updated = 0;
  for (const contact of incoming) {
    const address = contact.address.trim();
    const label = normalizeAlias(contact.label);
    const prior = byAddress.get(address);
    if (prior === undefined) {
      byAddress.set(address, { ...contact, address, label });
      added += 1;
    } else if (aliasKey(prior.label) !== aliasKey(label)) {
      byAddress.set(address, { ...prior, label });
      updated += 1;
    }
  }
  const merged = [...byAddress.values()].slice(0, ADDRESS_BOOK_LIMIT);
  persist(merged, storage);
  notify();
  return {
    mode: "merge",
    applied: added + updated,
    skipped: 0,
    total: merged.length,
    contacts: merged,
  };
}
