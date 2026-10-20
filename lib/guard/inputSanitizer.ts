/**
 * Accidental key-leak guard — the global secret-key paste interceptor.
 *
 * Operators configure agent and admin *addresses* in this dashboard, and a
 * Stellar secret seed (`S…`, 56 characters) is never one of them. The worst
 * input the console could receive is a secret key pasted into what the
 * operator believes is an address field, so every text-entry paste and change
 * is screened against the secret-seed shape before a value can settle.
 *
 * Three layers, in the order a paste actually happens:
 *
 *   1. `paste` (capture, document-level): the clipboard text is inspected
 *      before the browser inserts it, and a secret-shaped paste is cancelled —
 *      `preventDefault()` means the value never reaches the field or React
 *      state at all.
 *   2. `input`: a safety net for engines that surface no clipboard data; the
 *      post-insertion value is screened and cleared if it matches.
 *   3. `change`: fires on blur, so a secret sitting in a field is still caught
 *      before the operator moves on.
 *
 * A blocked value clears the field immediately and raises a high-priority
 * alert rendered by `<SecretKeyGuard />`. The store is deliberately
 * framework-free so its semantics are unit-testable under node:test — the
 * same split as `useToast` and `useAnnounce`.
 *
 * The file also hosts the *label policy* for operator-authored text (issue
 * #384) — the second place where what a field displays must equal what it
 * contains. Both sections share one principle: a value that can display as
 * something other than what it says is refused, with a reason the operator
 * can act on.
 */

/** The Stellar secret seed shape: `S` followed by 55 uppercase base32 characters. */
export const SECRET_KEY_PATTERN = /^S[A-Z0-9]{55}$/;

/** The exact warning every blocked paste or change raises. */
export const SECRET_KEY_WARNING =
  "SECURITY ALERT: You pasted a secret key. This dashboard never requires secret keys. Do not share your private key.";

/** True when the whole value is exactly a Stellar secret seed (whitespace around it ignored). */
export function isStellarSecretKey(value: string): boolean {
  return SECRET_KEY_PATTERN.test(value.trim());
}

/**
 * Find a secret-shaped token anywhere in pasted text.
 *
 * A paste like "key: SA…", a JSON keypair dump or a newline-separated list
 * must be caught as surely as a bare secret, so beyond the exact match this
 * scans for a token standing alone between non-alphanumeric edges. A longer
 * run (57+ characters) or one embedded in other alphanumerics is not a strkey
 * and is deliberately not flagged.
 */
export function findSecretKeyInText(text: string): string | null {
  if (isStellarSecretKey(text)) return text.trim();
  const token = /(?:^|[^A-Za-z0-9])(S[A-Z0-9]{55})(?![A-Za-z0-9])/.exec(text);
  return token?.[1] ?? null;
}

/**
 * The screening primitive: any value a text field is about to accept goes
 * through here. Clean values pass through untouched; a value that *is* or
 * *contains* a secret seed comes back empty — there is no partial keep.
 */
export function sanitizeAddressInput(value: string): string {
  return findSecretKeyInText(value) === null ? value : "";
}

// ── Human-readable label policy (issue #384) ───────────────────────────────
//
// Address-book nicknames and guard-registry names are what the operator reads
// when choosing an account, so a label must display exactly what it says — in
// the console, in exports, and in a terminal. Two invisible-character attacks
// make that false, and both are refused here rather than normalized away:
//
//   - **Zero-width characters** (ZWSP, ZWNJ, ZWJ, word joiner, BOM, soft
//     hyphen) let two *different* labels render identically ("Vault\u200B"
//     and "Vault"), so an operator cannot tell which entry they picked.
//   - **Bidi controls** (embeddings, overrides, isolates, marks) can reorder
//     the rendered text, so a label can display as something other than the
//     string that was saved.
//
// The documented normalization policy, applied in this order by the callers:
//
//   1. Whitespace is *normalized*, never rejected: leading/trailing whitespace
//      is dropped and internal runs collapse to one space (`normalizeAlias` in
//      `addressBook.ts` owns that step; tabs and newlines are whitespace).
//   2. Anything invisible that is not whitespace is *rejected* by
//      `validateLabel` with a field-level error naming the offending code
//      point. Stripping them instead would be destructive — the saved label
//      would differ from what the operator submitted — and accepting them
//      would allow a deceptive label through, so the save is refused and the
//      operator fixes the field.
//   3. Everything else is preserved untouched: accented Latin, non-Latin
//      scripts (Cyrillic, CJK, Arabic, Hebrew), emoji and punctuation are
//      valid label text and are never rewritten.

/**
 * Every character class the label policy rejects: C0 controls outside the
 * whitespace set, DEL + C1 controls, soft hyphen, zero-width and directional
 * marks, bidi embeddings/overrides/isolates, the word joiner, the BOM, and the
 * Unicode line/paragraph separators. Whitespace (space, tab, newline, NBSP, …)
 * is deliberately absent — it is normalized, not rejected.
 */
export const DISALLOWED_LABEL_CHARS =
  /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u00AD\u180E\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u;

/** Readable names for the disallowed characters operators actually meet. */
const LABEL_CHAR_NAMES: Record<string, string> = {
  "\u00AD": "SOFT HYPHEN",
  "\u180E": "MONGOLIAN VOWEL SEPARATOR",
  "\u200B": "ZERO WIDTH SPACE",
  "\u200C": "ZERO WIDTH NON-JOINER",
  "\u200D": "ZERO WIDTH JOINER",
  "\u200E": "LEFT-TO-RIGHT MARK",
  "\u200F": "RIGHT-TO-LEFT MARK",
  "\u2028": "LINE SEPARATOR",
  "\u2029": "PARAGRAPH SEPARATOR",
  "\u202A": "LEFT-TO-RIGHT EMBEDDING",
  "\u202B": "RIGHT-TO-LEFT EMBEDDING",
  "\u202C": "POP DIRECTIONAL FORMATTING",
  "\u202D": "LEFT-TO-RIGHT OVERRIDE",
  "\u202E": "RIGHT-TO-LEFT OVERRIDE",
  "\u2060": "WORD JOINER",
  "\u2066": "LEFT-TO-RIGHT ISOLATE",
  "\u2067": "RIGHT-TO-LEFT ISOLATE",
  "\u2068": "FIRST STRONG ISOLATE",
  "\u2069": "POP DIRECTIONAL ISOLATE",
  "\uFEFF": "ZERO WIDTH NO-BREAK SPACE (BOM)",
};

/** The first character of a label the policy refuses, where it is, and why. */
export interface DisallowedLabelChar {
  char: string;
  /** The code point, formatted `U+XXXX`. */
  code: string;
  name: string;
  /** Zero-based index of the offending character in the original string. */
  index: number;
}

/**
 * Find the first disallowed character in a label, or null when the label is
 * clean. Runs on the *raw* value, before whitespace normalization, so nothing
 * can hide behind a character the normalizer would rewrite.
 */
export function findDisallowedLabelChar(value: string): DisallowedLabelChar | null {
  const match = new RegExp(DISALLOWED_LABEL_CHARS.source, "u").exec(value);
  if (!match) return null;
  const char = match[0]!;
  const point = char.codePointAt(0)!; // a matched character always has one
  const code = `U+${point.toString(16).toUpperCase().padStart(4, "0")}`;
  const named = LABEL_CHAR_NAMES[char];
  return {
    char,
    code,
    name: named ?? (point <= 0x9f ? "CONTROL CHARACTER" : "INVISIBLE FORMAT CHARACTER"),
    index: match.index,
  };
}

/** The result of screening a label: accepted as-is, or a field-level error. */
export type LabelCheck = { ok: true } | { ok: false; error: string };

/**
 * The label policy as callers use it: reject a label containing any invisible
 * or control character, with an operator-facing message that names the exact
 * code point so the fix is mechanical. A label the policy accepts is returned
 * ok without modification — normalization is the callers' next step, and a
 * preserved international label is never rewritten.
 */
export function validateLabel(raw: string): LabelCheck {
  const found = findDisallowedLabelChar(raw);
  if (found === null) return { ok: true };
  return {
    ok: false,
    error:
      `The label contains ${found.code} (${found.name}) at position ${found.index + 1}. ` +
      "Invisible and control characters are not allowed in labels — they can make two labels " +
      "look identical or display as different text than what was saved. Remove the highlighted " +
      "characters and try again.",
  };
}

// ── Security alert store ─────────────────────────────────────────────────────
// One current alert, not a queue: repeated blocks accumulate into the attempt
// count of the alert already on screen rather than stacking dialogs.

export interface SecretKeyAlert {
  message: string;
  /** How many blocked attempts this alert covers. */
  attempts: number;
  /** Epoch ms of the first blocked attempt. */
  at: number;
}

let currentAlert: SecretKeyAlert | null = null;
const alertListeners = new Set<(alert: SecretKeyAlert | null) => void>();

function emitAlert(): void {
  for (const listener of [...alertListeners]) listener(currentAlert);
}

export function getSecretKeyAlert(): SecretKeyAlert | null {
  return currentAlert;
}

/**
 * Watch the alert. The listener is called once immediately with the current
 * value (so nothing raised before the view mounted is lost) and again on
 * every change. Returns the unsubscribe function.
 */
export function subscribeSecretKeyAlerts(
  listener: (alert: SecretKeyAlert | null) => void,
): () => void {
  alertListeners.add(listener);
  listener(currentAlert);
  return () => {
    alertListeners.delete(listener);
  };
}

/** Raise (or repeat) the warning. A repeat bumps the attempt count in place. */
export function raiseSecretKeyAlert(now: number = Date.now()): void {
  currentAlert =
    currentAlert === null
      ? { message: SECRET_KEY_WARNING, attempts: 1, at: now }
      : { ...currentAlert, attempts: currentAlert.attempts + 1 };
  emitAlert();
}

export function dismissSecretKeyAlert(): void {
  if (currentAlert === null) return;
  currentAlert = null;
  emitAlert();
}

// ── DOM interception ─────────────────────────────────────────────────────────

/** Input types where a pasted secret would actually sit as text. */
const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "email", "password", "number"]);

function isTextEntryTarget(
  target: EventTarget | null,
): target is HTMLInputElement | HTMLTextAreaElement {
  if (typeof HTMLInputElement === "undefined" || typeof HTMLTextAreaElement === "undefined") {
    return false;
  }
  if (target instanceof HTMLTextAreaElement) return !target.readOnly && !target.disabled;
  if (target instanceof HTMLInputElement) {
    if (target.disabled || target.readOnly) return false;
    return TEXT_INPUT_TYPES.has(target.type);
  }
  return false;
}

function readClipboardText(event: Event): string | null {
  const data = (event as ClipboardEvent).clipboardData;
  if (!data) return null;
  const read = (type: string): string => {
    try {
      return data.getData(type);
    } catch {
      // Some engines throw for unimplemented types; an unreadable type is
      // simply not evidence of a secret.
      return "";
    }
  };
  return read("text/plain") || read("text");
}

/**
 * Empty the field the React-safe way.
 *
 * React tracks the value property to detect onChange; writing through the
 * native prototype setter (the technique React itself uses) keeps that tracker
 * consistent, and the synthetic `input` event lets a controlled field settle
 * on the cleared state instead of keeping the pre-paste value on screen.
 */
function clearInputValue(element: HTMLInputElement | HTMLTextAreaElement): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) setter.call(element, "");
  else element.value = "";

  // Created through the element's own realm (not a bare `new Event`), so the
  // event is a first-class citizen of whatever document the field lives in.
  const event = element.ownerDocument.createEvent("Event");
  event.initEvent("input", true, false);
  element.dispatchEvent(event);
}

function handlePaste(event: Event): void {
  const element = event.target;
  if (!isTextEntryTarget(element)) return;
  const pasted = readClipboardText(event);
  // No clipboard data means the paste itself cannot be pre-screened; the
  // `input` and `change` nets below still screen whatever lands in the field.
  if (pasted === null) return;
  if (findSecretKeyInText(pasted) === null) return;
  event.preventDefault();
  clearInputValue(element);
  raiseSecretKeyAlert();
}

function screenFieldValue(event: Event): void {
  const element = event.target;
  if (!isTextEntryTarget(element)) return;
  if (findSecretKeyInText(element.value) === null) return;
  clearInputValue(element);
  raiseSecretKeyAlert();
}

export interface SecretKeyGuardOptions {
  /** Where the listeners attach; defaults to the current document. */
  target?: Document;
}

/**
 * Install the document-level paste/change screen.
 *
 * Listeners run in the capture phase so the screen sees every event before any
 * field-level handler can consume it, and they cover every text input on every
 * route — including fields added later. Returns the uninstall function.
 */
export function installSecretKeyGuard(options: SecretKeyGuardOptions = {}): () => void {
  const target = options.target ?? (typeof document !== "undefined" ? document : null);
  if (!target) return () => {};

  target.addEventListener("paste", handlePaste, true);
  target.addEventListener("input", screenFieldValue, true);
  target.addEventListener("change", screenFieldValue, true);
  return () => {
    target.removeEventListener("paste", handlePaste, true);
    target.removeEventListener("input", screenFieldValue, true);
    target.removeEventListener("change", screenFieldValue, true);
  };
}
