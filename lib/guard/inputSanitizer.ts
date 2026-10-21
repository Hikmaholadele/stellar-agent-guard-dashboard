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

const LABEL_CHARACTER_NAMES = new Map<number, string>([
  [0x00ad, "SOFT HYPHEN"],
  [0x034f, "COMBINING GRAPHEME JOINER"],
  [0x061c, "ARABIC LETTER MARK"],
  [0x200b, "ZERO WIDTH SPACE"],
  [0x200c, "ZERO WIDTH NON-JOINER"],
  [0x200d, "ZERO WIDTH JOINER"],
  [0x202a, "LEFT-TO-RIGHT EMBEDDING"],
  [0x202b, "RIGHT-TO-LEFT EMBEDDING"],
  [0x202c, "POP DIRECTIONAL FORMATTING"],
  [0x202d, "LEFT-TO-RIGHT OVERRIDE"],
  [0x202e, "RIGHT-TO-LEFT OVERRIDE"],
  [0x2060, "WORD JOINER"],
  [0x2066, "LEFT-TO-RIGHT ISOLATE"],
  [0x2067, "RIGHT-TO-LEFT ISOLATE"],
  [0x2068, "FIRST STRONG ISOLATE"],
  [0x2069, "POP DIRECTIONAL ISOLATE"],
  [0xfeff, "BOM"],
]);

export interface DisallowedLabelCharacter {
  index: number;
  code: string;
  name: string;
}

export function findDisallowedLabelChar(value: string): DisallowedLabelCharacter | null {
  let index = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    const isControl = /\p{Cc}/u.test(character) && !/[\t\n\r]/u.test(character);
    const isInvisible = /[\p{Cf}\p{Zl}\p{Zp}]/u.test(character);
    if (isControl || isInvisible) {
      const code = `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
      const name =
        LABEL_CHARACTER_NAMES.get(codePoint) ??
        (codePoint === 0x2028
          ? "LINE SEPARATOR"
          : codePoint === 0x2029
            ? "PARAGRAPH SEPARATOR"
            : isControl
              ? "CONTROL CHARACTER"
              : "FORMAT CHARACTER");
      return { index, code, name };
    }
    index += character.length;
  }
  return null;
}

export function validateLabel(value: string): { ok: true } | { ok: false; error: string } {
  const disallowed = findDisallowedLabelChar(value);
  if (!disallowed) return { ok: true };
  return {
    ok: false,
    error: `Label contains ${disallowed.name} (${disallowed.code}) at position ${disallowed.index + 1}.`,
  };
}

/**
 * Redact secret-like patterns (Stellar secret seeds, URL credentials, auth tokens)
 * from diagnostic text, error messages, and incident summaries before they leave the dashboard.
 *
 * Keeps public addresses (G..., C...), transaction hashes (64-character hex),
 * and error codes intact.
 */
export function redactDiagnostics(text: string): string {
  if (!text) return text;
  let result = text;
  // 1. Redact Stellar secret keys (S followed by uppercase alphanumeric characters, standard 56 chars or test sentinels)
  result = result.replace(/(^|[^A-Za-z0-9])(S[A-Z0-9]{50,60})(?![A-Za-z0-9])/g, "$1[REDACTED]");

  // 2. Redact credential-like URL basic auth credentials: https://user:pass@host -> https://user:[REDACTED]@host
  result = result.replace(/(https?:\/\/[^\/\s:@]+):[^\/\s:@]+@/g, "$1:[REDACTED]@");

  // 3. Redact credential-like URL query parameters (token, api_key, apikey, secret, password, auth, bearer, key)
  result = result.replace(
    /([?&](?:token|api_key|apikey|secret|password|auth|bearer|key)=)[^&\s#]+/gi,
    "$1[REDACTED]",
  );

  // 4. Redact Bearer authorization headers/tokens
  result = result.replace(/(Bearer\s+)[A-Za-z0-9_\-\.]+/gi, "$1[REDACTED]");

  // 5. Redact secret-bearing JSON fields
  result = result.replace(
    /("(?:secretKey|privateKey|password|secret|token|apiKey|api_key)"\s*:\s*")[^"]+(")/gi,
    "$1[REDACTED]$2",
  );

  return result;
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
