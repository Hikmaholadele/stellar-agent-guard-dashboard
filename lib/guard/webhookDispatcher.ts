/**
 * The custom webhook dispatcher (issue #141).
 *
 * An operator whose incident process lives in Slack, PagerDuty or a SIEM needs
 * the guard to speak to it. Everything else in this console keeps its alerts
 * inside the tab that raised them — a chime, a banner, a row in the feed — so a
 * freeze that happens while nobody has the console open is a freeze nobody
 * hears about. This module dispatches those same events outward as a signed
 * HTTP POST.
 *
 * Five decisions shape it:
 *
 *   - **Client-side, like everything else here.** The POST goes from the
 *     operator's browser straight to the webhook URL. There is no server
 *     component that could hold the signing secret, and no relay that could
 *     quietly widen what is sent.
 *   - **Signed, and signing is opt-in.** When a secret is configured the body
 *     carries an HMAC-SHA256 over `<timestamp>.<body>` in a header, which is
 *     what lets the receiver prove the payload came from this console and was
 *     not replayed. With no secret the payload still sends — an operator
 *     pointing at an internal SIEM does not always get to choose a shared
 *     secret — and the headers say plainly that it is unsigned rather than
 *     implying a signature that is not there.
 *   - **Edge-triggered, then rate-limited.** A frozen guard stays frozen, and
 *     the console polls every few seconds; a level-triggered dispatcher would
 *     fire the same alert forever. Each event fires on the transition into its
 *     condition, and a per-event cooldown then bounds repeats even when a
 *     condition genuinely flaps.
 *   - **A failed dispatch is reported, never retried silently.** Retrying a
 *     webhook without backoff is how an alert endpoint gets taken down by the
 *     alert system. The rate limit is the ceiling; the operator decides whether
 *     to send again.
 *   - **The alert vocabulary lives here, not in the component.** Deciding that
 *     a freeze, a dead-man-switch countdown and a burst of refusals are worth
 *     waking somebody for is the security-relevant part, so it is a pure
 *     function with unit tests rather than an inline `if` in JSX — the same
 *     split `audioAlert.ts` uses.
 */

import { jsonWithBigints } from "./scval.ts";
import type { DmsAlert } from "./dmsAlert.ts";

// ── The alert vocabulary ───────────────────────────────────────────────────

/**
 * The events this console can dispatch.
 *
 * These are the three the issue names, and they are deliberately the three the
 * guard's own model distinguishes:
 *
 *   - `FREEZE_ACTIVATED` — the admin panic button took effect, or the dead-man
 *     switch fired. Someone changed the guardrails under traffic; every
 *     subsequent agent call is refused.
 *   - `DMS_EXPIRING` — the heartbeat deadline is approaching. This is the only
 *     one of the three that is *preventive*: it exists so the freeze it
 *     precedes never happens.
 *   - `BLOCK_THRESHOLD_EXCEEDED` — repeated refusals. One block is a
 *     transaction the operator expected to fail; a burst is a pattern worth
 *     interrupting for.
 */
export type WebhookEventType = "FREEZE_ACTIVATED" | "DMS_EXPIRING" | "BLOCK_THRESHOLD_EXCEEDED";

export const WEBHOOK_EVENT_TYPES: readonly WebhookEventType[] = [
  "FREEZE_ACTIVATED",
  "DMS_EXPIRING",
  "BLOCK_THRESHOLD_EXCEEDED",
];

/** How each event reads in the settings UI. */
export const WEBHOOK_EVENT_LABELS: Record<WebhookEventType, string> = {
  FREEZE_ACTIVATED: "Emergency freeze activated",
  DMS_EXPIRING: "Dead-man switch expiring",
  BLOCK_THRESHOLD_EXCEEDED: "Block threshold exceeded",
};

/** One line saying what the receiver will be told, so the choice is informed. */
export const WEBHOOK_EVENT_HINTS: Record<WebhookEventType, string> = {
  FREEZE_ACTIVATED: "Fires once when status().admin_frozen flips to true.",
  DMS_EXPIRING: "Fires once as the heartbeat deadline enters warning, and again if it worsens.",
  BLOCK_THRESHOLD_EXCEEDED: "Fires once when refusals in the alert window reach your threshold.",
};

/** The verification ping — not a security event, and never subject to the event filters. */
export const WEBHOOK_PING_EVENT = "WEBHOOK_TEST" as const;

export type WebhookPayloadEvent = WebhookEventType | typeof WEBHOOK_PING_EVENT;

function isEventType(value: unknown): value is WebhookEventType {
  return typeof value === "string" && (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

// ── Settings ───────────────────────────────────────────────────────────────

export const WEBHOOK_SETTINGS_STORAGE_KEY = "stellar-agent-guard-dashboard.webhooks.v1";

/**
 * Default cooldown between two dispatches of the same event.
 *
 * One minute is short enough that a freeze that is cleared and re-applied still
 * alerts, and long enough that a polled condition cannot become a loop.
 */
export const DEFAULT_WEBHOOK_MIN_INTERVAL_MS = 60_000;

/** The window refusals are counted over before `BLOCK_THRESHOLD_EXCEEDED` fires. */
export const DEFAULT_BLOCK_WINDOW_SECS = 300;

/** How many refusals in that window count as a burst. */
export const DEFAULT_BLOCK_THRESHOLD = 5;

/** Ceiling on the threshold, so a stored value cannot disable the alert by absurdity. */
export const MAX_BLOCK_THRESHOLD = 100;

export interface WebhookSettings {
  /** Master switch. Off means nothing is dispatched, whatever else is configured. */
  enabled: boolean;
  /** The destination. Required before anything can be dispatched. */
  url: string;
  /** Which security events this console dispatches. */
  events: WebhookEventType[];
  /**
   * Shared secret for the HMAC-SHA256 signature. Empty means the payload is
   * sent unsigned — which the headers and the payload's own `signed` field
   * both state, rather than implying a signature that is not present.
   */
  secret: string;
  /** Minimum milliseconds between two dispatches of the *same* event type. */
  minIntervalMs: number;
  /** Refusals within `blockWindowSecs` that trigger `BLOCK_THRESHOLD_EXCEEDED`. */
  blockThreshold: number;
  blockWindowSecs: number;
}

/** Nothing configured: an operator has to opt in before anything leaves the tab. */
export const DEFAULT_WEBHOOK_SETTINGS: WebhookSettings = {
  enabled: false,
  url: "",
  events: [...WEBHOOK_EVENT_TYPES],
  secret: "",
  minIntervalMs: DEFAULT_WEBHOOK_MIN_INTERVAL_MS,
  blockThreshold: DEFAULT_BLOCK_THRESHOLD,
  blockWindowSecs: DEFAULT_BLOCK_WINDOW_SECS,
};

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

/**
 * Validate a webhook URL, returning the reason it is unusable or `null`.
 *
 * Plain `http://` is rejected for everything except loopback: a security alert
 * carrying a guard address and a freeze state should not cross a network in
 * clear text because an operator mistyped the scheme. `localhost` is exempt
 * because the common first target — a receiver on the operator's own machine —
 * is not going to have a certificate.
 *
 * Credentials are rejected before the scheme is even considered. A `user:pass@`
 * — or a bare `@` — in the authority is not somewhere a webhook belongs: the
 * browser would send those bytes as HTTP basic auth to whoever really owns the
 * host, and an `@` lets the text before it masquerade as the destination the
 * operator meant. A host that will not parse is likewise refused; it would
 * otherwise resolve to an endpoint nobody chose.
 */
export function validateWebhookUrl(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed === "") return "Enter a webhook URL.";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "That is not a URL. It needs to start with https://.";
  }
  // `URL` moves any non-empty userinfo into `username`/`password`, which catches
  // `user@`, `:pass@` and `user:pass@`. It does *not* flag the empty-credential
  // `https://@host`, whose username is `""` — so the authority itself is scanned
  // for the `@` delimiter too. That scan is scoped to the authority (the bytes
  // between `//` and the first `/`, `?` or `#`), so a legitimate `@` in a path
  // segment (`/hooks/@team`) still validates.
  if (parsed.username !== "" || parsed.password !== "" || authorityHasCredentials(trimmed)) {
    return "Remove the username, password, or `@` from the host. A webhook URL must not carry credentials.";
  }
  if (parsed.protocol === "https:") return null;
  if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) return null;
  if (parsed.protocol === "http:") {
    return "Use https:// for a webhook URL. Plain http is only allowed on localhost.";
  }
  return `Unsupported scheme "${parsed.protocol}". Webhooks must be https://.`;
}

/** Does the URL's authority contain an `@`, marking userinfo (even empty)? */
function authorityHasCredentials(raw: string): boolean {
  // scheme://[userinfo@]host[:port][/path?query#fragment]
  const authority = /^[^:/?#]+:\/\/([^/?#]*)/.exec(raw)?.[1] ?? "";
  return authority.includes("@");
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

/** Clamp the cooldown into a range that cannot silence alerts forever or busy-loop. */
export function clampMinIntervalMs(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_WEBHOOK_MIN_INTERVAL_MS;
  return Math.min(3_600_000, Math.max(0, Math.round(parsed)));
}

function clampThreshold(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_BLOCK_THRESHOLD;
  return Math.min(MAX_BLOCK_THRESHOLD, Math.max(1, Math.round(parsed)));
}

function clampWindow(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_BLOCK_WINDOW_SECS;
  return Math.min(86_400, Math.max(10, Math.round(parsed)));
}

/**
 * Coerce anything into valid settings.
 *
 * A stored payload from an older build, a hand-edited `localStorage` entry or a
 * partially-written object all land here, so every field is validated
 * independently: one unknown event type in the saved list drops that entry, not
 * the operator's other two.
 */
export function normalizeWebhookSettings(value: unknown): WebhookSettings {
  if (typeof value !== "object" || value === null) return { ...DEFAULT_WEBHOOK_SETTINGS };
  const candidate = value as Partial<WebhookSettings>;
  return {
    enabled: candidate.enabled === true,
    url: typeof candidate.url === "string" ? candidate.url.trim() : "",
    events: Array.isArray(candidate.events)
      ? candidate.events.filter(isEventType)
      : [...WEBHOOK_EVENT_TYPES],
    secret: typeof candidate.secret === "string" ? candidate.secret : "",
    minIntervalMs: clampMinIntervalMs(candidate.minIntervalMs),
    blockThreshold: clampThreshold(candidate.blockThreshold),
    blockWindowSecs: clampWindow(candidate.blockWindowSecs),
  };
}

export function loadWebhookSettings(
  storage: StorageLike | null = defaultStorage(),
): WebhookSettings {
  if (!storage) return { ...DEFAULT_WEBHOOK_SETTINGS };
  try {
    const raw = storage.getItem(WEBHOOK_SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_WEBHOOK_SETTINGS };
    return normalizeWebhookSettings(JSON.parse(raw) as unknown);
  } catch {
    // Corrupt storage is a lost preference, never a broken console.
    return { ...DEFAULT_WEBHOOK_SETTINGS };
  }
}

export function saveWebhookSettings(
  settings: WebhookSettings,
  storage: StorageLike | null = defaultStorage(),
): WebhookSettings {
  const normalised = normalizeWebhookSettings(settings);
  if (storage) {
    try {
      storage.setItem(WEBHOOK_SETTINGS_STORAGE_KEY, JSON.stringify(normalised));
    } catch {
      // A private-mode write only loses the configuration for this session.
    }
  }
  notifyWebhookSettings();
  return normalised;
}

const listeners = new Set<() => void>();

/** Watch for webhook settings changed anywhere in this tab. */
export function subscribeWebhookSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyWebhookSettings(): void {
  for (const listener of [...listeners]) listener();
}

// ── Payload ────────────────────────────────────────────────────────────────

/** The payload shape version, so a receiver can tell future changes apart. */
export const WEBHOOK_PAYLOAD_VERSION = 1;

/**
 * Values a payload detail may carry.
 *
 * `bigint` is allowed because the guard's numbers are stroops — a receiver that
 * coerced one through `Number()` would silently lose digits above 2^53, which
 * is the whole reason to send the value at all.
 */
export type WebhookDetailValue = string | number | boolean | null | bigint | string[];

export type WebhookDetails = Record<string, WebhookDetailValue>;

export interface WebhookPayload {
  version: number;
  event: WebhookPayloadEvent;
  guard: string;
  network: string;
  /** ISO 8601, the moment the console built the payload. */
  timestamp: string;
  /** Whether the body below is covered by the signature header. */
  signed: boolean;
  details: WebhookDetails;
}

export interface BuildPayloadInput {
  event: WebhookPayloadEvent;
  guard: string;
  network: string;
  /** Defaults to now; passed explicitly by the tests so a payload is reproducible. */
  timestamp?: string;
  details?: WebhookDetails;
}

/**
 * Build a payload.
 *
 * Field order is fixed by construction rather than by insertion discipline, so
 * the serialized body — and therefore the signature over it — is identical for
 * the same values regardless of how the caller assembled the details.
 */
export function buildWebhookPayload(input: BuildPayloadInput, secret = ""): WebhookPayload {
  return {
    version: WEBHOOK_PAYLOAD_VERSION,
    event: input.event,
    guard: input.guard,
    network: input.network,
    timestamp: input.timestamp ?? new Date().toISOString(),
    signed: secret.trim() !== "",
    details: input.details ?? {},
  };
}

/**
 * The exact bytes that are signed and sent.
 *
 * `jsonWithBigints` rather than a bare `JSON.stringify`: a stroop amount is a
 * `bigint`, and `JSON.stringify` throws on the first one it meets — which would
 * turn a stroop-denominated alert into a crash rather than an alert.
 */
export function serializeWebhookPayload(payload: WebhookPayload): string {
  return jsonWithBigints(payload);
}

// ── Signing ────────────────────────────────────────────────────────────────

export const WEBHOOK_SIGNATURE_HEADER = "X-Agent-Guard-Signature";
export const WEBHOOK_TIMESTAMP_HEADER = "X-Agent-Guard-Timestamp";
export const WEBHOOK_EVENT_HEADER = "X-Agent-Guard-Event";
export const WEBHOOK_SIGNATURE_SCHEME = "sha256";

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function subtleCrypto(): SubtleCrypto | null {
  const scope = globalThis as { crypto?: Crypto };
  return scope.crypto?.subtle ?? null;
}

/**
 * HMAC-SHA256 over `<timestamp>.<body>`, as `sha256=<hex>`.
 *
 * The timestamp is inside the signed material, not merely beside it: that is
 * what lets a receiver reject a captured payload replayed outside its window.
 * Web Crypto is used rather than a bundled hash so there is no crypto
 * dependency to audit, and `globalThis.crypto.subtle` exists in both the browser
 * and the Node test runner.
 */
export async function signWebhookBody(
  body: string,
  secret: string,
  timestamp: string,
): Promise<string> {
  const subtle = subtleCrypto();
  if (!subtle) throw new Error("This browser has no Web Crypto, so the payload cannot be signed.");
  const key = await subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  return `${WEBHOOK_SIGNATURE_SCHEME}=${hex(signature)}`;
}

export interface WebhookRequest {
  url: string;
  init: RequestInit;
}

/**
 * The exact HTTP request for a payload: method, headers and body.
 *
 * Separated from the send so the signing and the headers are unit-testable
 * without a network, and so "what would we put on the wire" has one answer
 * rather than one per call site.
 */
export async function buildWebhookRequest(
  payload: WebhookPayload,
  settings: WebhookSettings,
): Promise<WebhookRequest> {
  const body = serializeWebhookPayload(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [WEBHOOK_EVENT_HEADER]: payload.event,
    [WEBHOOK_TIMESTAMP_HEADER]: payload.timestamp,
  };
  if (payload.signed) {
    // The payload says it is signed, so signing it is not optional — and a
    // payload whose `signed` flag disagrees with the configured secret would
    // send bytes no one can verify. Failing loudly beats sending a body that
    // looks signed and is not.
    if (settings.secret.trim() === "") {
      throw new Error(
        "The payload is marked signed but no signing secret is configured; set one or build the payload unsigned.",
      );
    }
    headers[WEBHOOK_SIGNATURE_HEADER] = await signWebhookBody(
      body,
      settings.secret,
      payload.timestamp,
    );
  }
  return { url: settings.url.trim(), init: { method: "POST", headers, body } };
}

// ── Rate limiting ──────────────────────────────────────────────────────────

/**
 * Has this event type already been dispatched inside the cooldown?
 *
 * Per event type, not global: a dead-man-switch warning and a freeze are
 * different incidents, and one operator's freeze should not suppress the
 * countdown that precedes it. A `lastSentAt` of `null` (nothing sent yet) is
 * never limited, and a zero cooldown disables limiting entirely — which is the
 * honest reading of "send every time" rather than a silent floor.
 */
export function isRateLimited(
  settings: WebhookSettings,
  lastSentAtMs: number | null | undefined,
  nowMs: number,
): boolean {
  if (lastSentAtMs === null || lastSentAtMs === undefined) return false;
  if (settings.minIntervalMs <= 0) return false;
  return nowMs - lastSentAtMs < settings.minIntervalMs;
}

/**
 * Which events are due to fire right now.
 *
 * `lastSentAt` is a per-event-type record; `nowMs` and the conditions come from
 * the console's current read. This is the whole trigger decision in one pure
 * function — selection, threshold and rate limit — so the component that calls
 * it has no security logic of its own to get wrong.
 */
export function dueWebhookEvents(input: {
  settings: WebhookSettings;
  events: readonly WebhookEventType[];
  lastSentAt?: Partial<Record<WebhookEventType, number>>;
  nowMs: number;
}): WebhookEventType[] {
  const selected = new Set(input.settings.events);
  return input.events.filter(
    (event) =>
      selected.has(event) && !isRateLimited(input.settings, input.lastSentAt?.[event], input.nowMs),
  );
}

// ── Dispatch ───────────────────────────────────────────────────────────────

export type DispatchOutcome =
  /** The endpoint answered 2xx. */
  | "sent"
  /** The cooldown for this event type has not elapsed. */
  | "rate-limited"
  /** Nothing to send: disabled, no URL, or the event is not selected. */
  | "skipped"
  /** The endpoint answered, and not with success. */
  | "rejected"
  /** The request never completed: DNS, TLS, CORS, offline. */
  | "failed";

export interface DispatchResult {
  ok: boolean;
  outcome: DispatchOutcome;
  /** HTTP status when the endpoint answered at all. */
  status: number | null;
  error: string | null;
  payload: WebhookPayload;
}

export interface DispatchDeps {
  /** Injected so tests never touch the network. */
  fetch?: typeof fetch;
  nowMs?: number;
}

/**
 * Send one payload, reporting what happened rather than throwing.
 *
 * A webhook is an outbound call to somebody else's infrastructure, so every
 * failure mode has to survive as a value: a dispatcher that throws into a
 * render effect takes the console down with a misconfigured URL. The
 * distinctions that matter to an operator are preserved — `rejected` (the
 * endpoint answered 4xx/5xx, so the payload or the URL is wrong) is a different
  problem from `failed` (the request never arrived).
 */
export async function dispatchWebhook(
  payload: WebhookPayload,
  settings: WebhookSettings,
  deps: DispatchDeps = {},
): Promise<DispatchResult> {
  const notSent = (outcome: DispatchOutcome, error: string | null = null): DispatchResult => ({
    ok: false,
    outcome,
    status: null,
    error,
    payload,
  });

  if (!settings.enabled) return notSent("skipped", "Webhook dispatch is switched off.");
  const urlError = validateWebhookUrl(settings.url);
  if (urlError) return notSent("skipped", urlError);
  if (
    !settings.events.includes(payload.event as WebhookEventType) &&
    payload.event !== WEBHOOK_PING_EVENT
  ) {
    return notSent("skipped", `${payload.event} is not one of the selected alert types.`);
  }

  const doFetch = deps.fetch ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    return notSent("failed", "This browser has no fetch, so nothing could be sent.");
  }

  let request: WebhookRequest;
  try {
    request = await buildWebhookRequest(payload, settings);
  } catch (error) {
    return notSent("failed", error instanceof Error ? error.message : String(error));
  }

  try {
    const response = await doFetch(request.url, request.init);
    const status = typeof response.status === "number" ? response.status : null;
    if (status !== null && (status < 200 || status >= 300)) {
      return {
        ok: false,
        outcome: "rejected",
        status,
        error: `The webhook endpoint answered ${status}.`,
        payload,
      };
    }
    return { ok: true, outcome: "sent", status, error: null, payload };
  } catch (error) {
    return {
      ok: false,
      outcome: "failed",
      status: null,
      error: error instanceof Error ? error.message : String(error),
      payload,
    };
  }
}

// ── The verification ping ──────────────────────────────────────────────────

/**
 * The sample payload the "Test webhook" button sends.
 *
 * A configuration is only trustworthy once something has actually left the
 * browser, and "the operator clicked a button and saw it work" is the only
 * evidence available client-side. The ping is deliberately the same envelope as
 * a real alert — same headers, same signing, same JSON — so what the receiver
 * parses for the test is what it will parse during an incident. It bypasses the
 * event selection and the cooldown on purpose: an operator verifying the setup
 * is not the same action as being paged.
 */
export function buildVerificationPing(input: {
  guard: string;
  network: string;
  timestamp?: string;
}): WebhookPayload {
  return buildWebhookPayload({
    event: WEBHOOK_PING_EVENT,
    guard: input.guard,
    network: input.network,
    ...(input.timestamp === undefined ? {} : { timestamp: input.timestamp }),
    details: {
      message: "Verification ping from the Stellar Agent Guard dashboard.",
      dashboard: "stellar-agent-guard-dashboard",
      expected_event_types: [...WEBHOOK_EVENT_TYPES],
    },
  });
}

// ── Trigger detection ──────────────────────────────────────────────────────

export interface WebhookConditions {
  /** `status().admin_frozen`, or `null` when that read failed. */
  adminFrozen: boolean | null;
  /** The dead-man-switch alert, or `null` when it could not be evaluated. */
  dms: DmsAlert | null;
  /** Refusals seen in the alert window, oldest ignored. */
  blockedCount: number;
}

/**
 * Which security events the current state warrants.
 *
 * A `null` condition produces nothing. A failed `status()` read is not an
 * unfrozen guard, and an unreadable countdown is not a healthy one — the same
 * "a failed read is not a value" rule the rest of the console keeps, applied to
 * the decision of whether to page somebody.
 *
 * Which refusals to count is the caller's, because only it knows the window:
 * see `countBlockedInWindow`.
 */
export function webhookEventsFor(
  settings: WebhookSettings,
  conditions: WebhookConditions,
): WebhookEventType[] {
  const selected = new Set(settings.events);
  const events: WebhookEventType[] = [];
  if (selected.has("FREEZE_ACTIVATED") && conditions.adminFrozen === true) {
    events.push("FREEZE_ACTIVATED");
  }
  if (selected.has("DMS_EXPIRING") && conditions.dms !== null && conditions.dms.level !== "none") {
    events.push("DMS_EXPIRING");
  }
  if (
    selected.has("BLOCK_THRESHOLD_EXCEEDED") &&
    conditions.blockedCount >= settings.blockThreshold
  ) {
    events.push("BLOCK_THRESHOLD_EXCEEDED");
  }
  return events;
}

/** The smallest window shape `countBlockedInWindow` needs. */
export interface BlockCandidate {
  decision?: { result?: string } | null;
  /** Ledger close time when known; the observation time otherwise. */
  ledgerClosedAt?: string | null;
  observedAt?: string | null;
}

/**
 * Refusals inside the alert window.
 *
 * `DMS_EXPIRING` and `FREEZE_ACTIVATED` are conditions on chain; a burst of
 * refusals is a condition on the *feed*, and the feed is a rolling buffer that
 * drops old rows. So the window is counted over what the console actually has,
 * and a window longer than the buffer is reported as the buffer's worth rather
 * than as a count that silently went down — the threshold means "this many
 * refusals in the recent past", and the buffer is the recent past this console
 * kept.
 *
 * A row with no usable timestamp counts. That is the conservative direction: an
 * event whose time is unknown is treated as recent rather than discarded, so a
 * burst cannot hide behind a missing timestamp.
 */
export function countBlockedInWindow(
  events: readonly BlockCandidate[],
  windowSecs: number,
  nowMs: number,
): number {
  const cutoff = nowMs - windowSecs * 1000;
  let count = 0;
  for (const event of events) {
    if (event.decision?.result !== "blocked") continue;
    const stamp = event.ledgerClosedAt ?? event.observedAt ?? null;
    if (stamp === null) {
      count += 1;
      continue;
    }
    const at = Date.parse(stamp);
    if (Number.isNaN(at) || at >= cutoff) count += 1;
  }
  return count;
}

// ── Edge tracking ──────────────────────────────────────────────────────────

/**
 * Which events have *just* become true, given what was true last time.
 *
 * This is what makes the dispatcher edge-triggered. `status().admin_frozen`
 * stays true for as long as the guard is frozen, and the console polls every
 * few seconds, so a level-triggered dispatcher would page on every poll until
 * somebody unfroze the account. Comparing against the previous observation
 * means one alert per transition — and `DMS_EXPIRING` can still re-fire as it
 * worsens, because worsening is a transition too.
 *
 * The tracker is deliberately not a latch that can get stuck: it stores the
 * last observed level rather than "have I ever seen this", so clearing and
 * re-entering the same condition alerts again.
 */
export function createWebhookTriggerTracker(): {
  /** Events whose condition is true now and was not true at the previous observation. */
  entered(events: readonly WebhookEventType[]): WebhookEventType[];
  /** Forget the previous observation — e.g. after a guard switch. */
  reset(): void;
  readonly lastSeen: readonly WebhookEventType[];
} {
  let previous: WebhookEventType[] = [];
  return {
    entered(events) {
      const fresh = events.filter((event) => !previous.includes(event));
      previous = [...events];
      return fresh;
    },
    reset() {
      previous = [];
    },
    get lastSeen() {
      return previous;
    },
  };
}

// ── Operator-facing copy ───────────────────────────────────────────────────

/**
 * What a dispatch result means in words.
 *
 * A status code alone does not tell an operator whether to fix a URL, fix a
 * secret or wait — and "sent" is the only word that should ever be paired with
 * a claim that the alert was delivered.
 */
export function describeDispatch(result: DispatchResult): string {
  switch (result.outcome) {
    case "sent":
      return result.payload.signed
        ? "Delivered, with a signature the receiver can verify."
        : "Delivered, but unsigned — set a signing secret if the receiver verifies signatures.";
    case "rate-limited":
      return "Suppressed by the cooldown; the previous alert for this event is still current.";
    case "skipped":
      return result.error ?? "Nothing was sent.";
    case "rejected":
      return `The endpoint refused it${result.status === null ? "" : ` (${result.status})`}. Check the URL and the payload format.`;
    case "failed":
      return `The request never completed${result.error === null ? "" : `: ${result.error}`}. A browser will also refuse a cross-origin webhook the endpoint does not allow.`;
  }
}

/** Is the configuration complete enough to dispatch anything? */
export function webhookConfigProblem(settings: WebhookSettings): string | null {
  if (!settings.enabled) return "Webhook dispatch is switched off.";
  const urlError = validateWebhookUrl(settings.url);
  if (urlError) return urlError;
  if (settings.events.length === 0) return "Select at least one alert type.";
  return null;
}
