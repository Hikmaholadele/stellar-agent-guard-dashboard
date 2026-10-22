/**
 * The webhook dispatcher (issue #141).
 *
 * Four things here can be wrong quietly, and each is pinned:
 *
 *   - **Serialization.** A payload that cannot survive `JSON.stringify` is not
 *     a payload — and the guard's numbers are stroops, so it carries `bigint`s
 *     the native serializer throws on. A receiver that silently lost digits
 *     above 2^53 would be worse than one that got nothing.
 *   - **Signing.** The signature is what makes the payload provable, so it has
 *     to cover the timestamp (otherwise a captured body replays forever) and
 *     has to match the bytes actually sent.
 *   - **Error handling.** Every failure mode is a value, not a throw: a
 *     misconfigured URL in a render effect must not take the console down, and
 *     "the endpoint answered 500" is a different problem from "the request
 *     never arrived".
 *   - **Rate limiting.** The cooldown is per event type and applies to
 *     deliveries, never to failures — an alert that was never sent must stay
 *     eligible, or a transient network blip silences the incident.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_WEBHOOK_SETTINGS,
  MAX_BLOCK_THRESHOLD,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_PAYLOAD_VERSION,
  WEBHOOK_PING_EVENT,
  WEBHOOK_SIGNATURE_HEADER,
  buildVerificationPing,
  buildWebhookPayload,
  buildWebhookRequest,
  countBlockedInWindow,
  createWebhookTriggerTracker,
  describeDispatch,
  dispatchWebhook,
  dueWebhookEvents,
  isRateLimited,
  loadWebhookSettings,
  normalizeWebhookSettings,
  saveWebhookSettings,
  serializeWebhookPayload,
  signWebhookBody,
  subscribeWebhookSettings,
  validateWebhookUrl,
  webhookConfigProblem,
  webhookEventsFor,
  type StorageLike,
  type WebhookPayload,
  type WebhookSettings,
} from "../../lib/guard/webhookDispatcher.ts";

const GUARD = "CB2M5YFEI74KVKZVES4UQNY3FLHMYE5R24EY2OSHB5LJH5FI2IJMSP5I";
const TIMESTAMP = "2026-10-03T12:00:00.000Z";
const SECRET = "shared-secret-value";

function settings(overrides: Partial<WebhookSettings> = {}): WebhookSettings {
  return {
    ...DEFAULT_WEBHOOK_SETTINGS,
    enabled: true,
    url: "https://hooks.example.com/guard",
    ...overrides,
  };
}

/** A `fetch` stub that records what it was called with. */
function recordingFetch(
  respond: (url: string, init: RequestInit) => { status: number } | Promise<{ status: number }>,
): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const stub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const { status } = await respond(url, init ?? {});
    return { status, ok: status >= 200 && status < 300 } as Response;
  }) as unknown as typeof fetch;
  return { fetch: stub, calls };
}

// ── Payload serialization ──────────────────────────────────────────────────

describe("buildWebhookPayload / serializeWebhookPayload", () => {
  test("the body is JSON-parseable and carries the event, guard, network and timestamp", () => {
    const payload = buildWebhookPayload(
      { event: "FREEZE_ACTIVATED", guard: GUARD, network: "testnet", timestamp: TIMESTAMP },
      SECRET,
    );
    assert.equal(payload.version, WEBHOOK_PAYLOAD_VERSION);
    assert.equal(payload.signed, true);

    const parsed = JSON.parse(serializeWebhookPayload(payload)) as Record<string, unknown>;
    assert.equal(parsed.event, "FREEZE_ACTIVATED");
    assert.equal(parsed.guard, GUARD);
    assert.equal(parsed.network, "testnet");
    assert.equal(parsed.timestamp, TIMESTAMP);
    assert.equal(parsed.signed, true);
    assert.deepEqual(parsed.details, {});
  });

  test("a stroop amount survives serialization exactly rather than through Number()", () => {
    // Above 2^53: a lossy round-trip here would report a different amount than
    // the guard holds.
    const huge = 12_345_678_901_234_567_890n;
    const payload = buildWebhookPayload({
      event: "BLOCK_THRESHOLD_EXCEEDED",
      guard: GUARD,
      network: "testnet",
      timestamp: TIMESTAMP,
      details: { window_total_stroops: huge, blocked_count: 5 },
    });
    const parsed = JSON.parse(serializeWebhookPayload(payload)) as {
      details: { window_total_stroops: string; blocked_count: number };
    };
    assert.equal(parsed.details.window_total_stroops, "12345678901234567890");
    assert.equal(parsed.details.blocked_count, 5);
  });

  test("the same values always serialize to the same bytes, so the signature is stable", () => {
    const first = buildWebhookPayload({
      event: "DMS_EXPIRING",
      guard: GUARD,
      network: "testnet",
      timestamp: TIMESTAMP,
      details: { level: "critical", remaining_secs: 120 },
    });
    const second = buildWebhookPayload({
      event: "DMS_EXPIRING",
      guard: GUARD,
      network: "testnet",
      timestamp: TIMESTAMP,
      details: { level: "critical", remaining_secs: 120 },
    });
    assert.equal(serializeWebhookPayload(first), serializeWebhookPayload(second));
  });

  test("with no secret the payload declares itself unsigned rather than implying a signature", () => {
    const payload = buildWebhookPayload({
      event: "FREEZE_ACTIVATED",
      guard: GUARD,
      network: "testnet",
      timestamp: TIMESTAMP,
    });
    assert.equal(payload.signed, false);
    assert.equal(JSON.parse(serializeWebhookPayload(payload)).signed, false);
  });

  test("the verification ping uses the same envelope as a real alert", () => {
    const ping = buildVerificationPing({ guard: GUARD, network: "testnet", timestamp: TIMESTAMP });
    assert.equal(ping.event, WEBHOOK_PING_EVENT);
    assert.equal(ping.version, WEBHOOK_PAYLOAD_VERSION);
    assert.equal(ping.guard, GUARD);
    assert.equal(ping.network, "testnet");
    assert.ok(String(ping.details.message).includes("Verification ping"));
    assert.deepEqual(ping.details.expected_event_types, [...WEBHOOK_EVENT_TYPES]);
  });
});

// ── Signing ────────────────────────────────────────────────────────────────

describe("signWebhookBody", () => {
  test("produces a stable sha256 HMAC and changes with either the body or the timestamp", async () => {
    const body = serializeWebhookPayload(
      buildWebhookPayload({
        event: "FREEZE_ACTIVATED",
        guard: GUARD,
        network: "testnet",
        timestamp: TIMESTAMP,
      }),
    );
    const a = await signWebhookBody(body, SECRET, TIMESTAMP);
    const again = await signWebhookBody(body, SECRET, TIMESTAMP);
    const otherBody = await signWebhookBody(`${body} `, SECRET, TIMESTAMP);
    const otherTime = await signWebhookBody(body, SECRET, "2026-10-03T12:00:01.000Z");
    const otherSecret = await signWebhookBody(body, `${SECRET}x`, TIMESTAMP);

    assert.match(a, /^sha256=[0-9a-f]{64}$/);
    assert.equal(a, again);
    assert.notEqual(a, otherBody);
    // The timestamp is inside the signed material, so a captured body cannot be
    // replayed with a fresh timestamp and still verify.
    assert.notEqual(a, otherTime);
    assert.notEqual(a, otherSecret);
  });

  test("a signed request carries the signature over the exact bytes it sends", async () => {
    const payload = buildWebhookPayload(
      {
        event: "FREEZE_ACTIVATED",
        guard: GUARD,
        network: "testnet",
        timestamp: TIMESTAMP,
        details: { admin_frozen: true },
      },
      SECRET,
    );
    const request = await buildWebhookRequest(payload, settings({ secret: SECRET }));
    const headers = request.init.headers as Record<string, string>;

    assert.equal(request.url, "https://hooks.example.com/guard");
    assert.equal(request.init.method, "POST");
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(headers["X-Agent-Guard-Event"], "FREEZE_ACTIVATED");
    assert.equal(headers["X-Agent-Guard-Timestamp"], TIMESTAMP);
    assert.equal(
      headers[WEBHOOK_SIGNATURE_HEADER],
      await signWebhookBody(request.init.body as string, SECRET, TIMESTAMP),
    );
  });

  test("an unsigned request sends no signature header at all", async () => {
    const payload = buildWebhookPayload({
      event: "DMS_EXPIRING",
      guard: GUARD,
      network: "testnet",
      timestamp: TIMESTAMP,
    });
    const request = await buildWebhookRequest(payload, settings());
    const headers = request.init.headers as Record<string, string>;
    assert.equal(headers[WEBHOOK_SIGNATURE_HEADER], undefined);
  });
});

// ── Dispatch and error handling ────────────────────────────────────────────

describe("dispatchWebhook", () => {
  const payload = (): WebhookPayload =>
    buildWebhookPayload(
      { event: "FREEZE_ACTIVATED", guard: GUARD, network: "testnet", timestamp: TIMESTAMP },
      SECRET,
    );

  test("a 2xx is a delivery, and the POST carried the payload", async () => {
    const { fetch: stub, calls } = recordingFetch(() => ({ status: 204 }));
    const result = await dispatchWebhook(payload(), settings({ secret: SECRET }), { fetch: stub });

    assert.equal(result.ok, true);
    assert.equal(result.outcome, "sent");
    assert.equal(result.status, 204);
    assert.equal(result.error, null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://hooks.example.com/guard");
    const body = JSON.parse(calls[0]!.init.body as string) as WebhookPayload;
    assert.equal(body.event, "FREEZE_ACTIVATED");
  });

  test("a non-2xx is `rejected` — the endpoint answered, so the payload or URL is wrong", async () => {
    const { fetch: stub } = recordingFetch(() => ({ status: 500 }));
    const result = await dispatchWebhook(payload(), settings({ secret: SECRET }), { fetch: stub });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, "rejected");
    assert.equal(result.status, 500);
    assert.match(result.error ?? "", /500/);
  });

  test("a request that never completes is `failed`, and never throws", async () => {
    const { fetch: stub } = recordingFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    const result = await dispatchWebhook(payload(), settings({ secret: SECRET }), { fetch: stub });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, "failed");
    assert.equal(result.status, null);
    assert.match(result.error ?? "", /Failed to fetch/);
  });

  test("an async rejection is caught the same way as a synchronous throw", async () => {
    const { fetch: stub } = recordingFetch(() => Promise.reject(new Error("network down")));
    const result = await dispatchWebhook(payload(), settings({ secret: SECRET }), { fetch: stub });
    assert.equal(result.outcome, "failed");
    assert.match(result.error ?? "", /network down/);
  });

  test("a disabled dispatcher sends nothing and says why", async () => {
    const { fetch: stub, calls } = recordingFetch(() => ({ status: 200 }));
    const result = await dispatchWebhook(payload(), settings({ enabled: false, secret: SECRET }), {
      fetch: stub,
    });
    assert.equal(result.outcome, "skipped");
    assert.match(result.error ?? "", /switched off/);
    assert.equal(calls.length, 0);
  });

  test("an unselected event is skipped rather than sent", async () => {
    const { fetch: stub, calls } = recordingFetch(() => ({ status: 200 }));
    const result = await dispatchWebhook(
      payload(),
      settings({ events: ["DMS_EXPIRING"], secret: SECRET }),
      { fetch: stub },
    );
    assert.equal(result.outcome, "skipped");
    assert.match(result.error ?? "", /not one of the selected/);
    assert.equal(calls.length, 0);
  });

  test("the verification ping ignores the event selection — testing is not paging", async () => {
    const { fetch: stub, calls } = recordingFetch(() => ({ status: 200 }));
    const result = await dispatchWebhook(
      buildVerificationPing({ guard: GUARD, network: "testnet", timestamp: TIMESTAMP }),
      settings({ events: [] }),
      { fetch: stub },
    );
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
  });

  test("a payload that claims to be signed but has no secret is reported, not sent", async () => {
    // The `signed` flag and the configured secret are two sources of truth, and
    // a mismatch would put a body on the wire that claims a signature it does
    // not have. Refusing is the only honest outcome.
    const { fetch: stub, calls } = recordingFetch(() => ({ status: 200 }));
    const result = await dispatchWebhook(payload(), settings({ secret: "" }), { fetch: stub });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, "failed");
    assert.match(result.error ?? "", /marked signed/);
    assert.equal(calls.length, 0);
  });

  test("a destination carrying credentials is skipped, never put on the wire", async () => {
    const { fetch: stub, calls } = recordingFetch(() => ({ status: 200 }));
    const result = await dispatchWebhook(
      buildWebhookPayload({
        event: "FREEZE_ACTIVATED",
        guard: GUARD,
        network: "testnet",
        timestamp: TIMESTAMP,
      }),
      settings({ url: "https://user:pass@hooks.example.com/x" }),
      { fetch: stub },
    );
    assert.equal(result.outcome, "skipped");
    assert.match(result.error ?? "", /must not carry credentials/);
    assert.equal(calls.length, 0);
  });
});

// ── URL validation ─────────────────────────────────────────────────────────

describe("validateWebhookUrl", () => {
  test("https is accepted anywhere", () => {
    for (const url of [
      "https://hooks.slack.com/services/T/B/X",
      "https://discord.com/api/webhooks/1/x",
      "https://events.pagerduty.com/v2/enqueue",
    ]) {
      assert.equal(validateWebhookUrl(url), null, url);
    }
  });

  test("http is refused except on loopback — an alert should not cross a network in clear text", () => {
    assert.match(validateWebhookUrl("http://hooks.example.com/guard") ?? "", /https/);
    assert.equal(validateWebhookUrl("http://localhost:3000/hook"), null);
    assert.equal(validateWebhookUrl("http://127.0.0.1:8080/hook"), null);
  });

  test("an empty or unparseable URL names the problem rather than returning false", () => {
    assert.match(validateWebhookUrl("") ?? "", /Enter a webhook URL/);
    assert.match(validateWebhookUrl("not a url") ?? "", /not a URL/);
    assert.match(validateWebhookUrl("ftp://example.com/x") ?? "", /Unsupported scheme/);
  });

  test("embedded credentials are refused — the userinfo would be sent to the real host", () => {
    for (const url of [
      "https://user:pass@hooks.example.com/x",
      "https://user@hooks.example.com/x",
      "https://:pass@hooks.example.com/x",
      "https://@hooks.example.com/x",
    ]) {
      assert.match(validateWebhookUrl(url) ?? "", /must not carry credentials/, url);
    }
  });

  test("credentials are refused even on loopback, where the scheme itself is allowed", () => {
    // The userinfo check runs before the localhost exemption: a credential is
    // never something to put on the wire, secure host or not.
    assert.match(
      validateWebhookUrl("http://user@localhost:3000/hook") ?? "",
      /must not carry credentials/,
    );
  });

  test("a malformed host that will not parse is refused rather than dispatched to", () => {
    for (const url of ["https://", "http://", "https://:8080", "https://exa mple.com"]) {
      assert.notEqual(validateWebhookUrl(url), null, url);
    }
  });

  test("an @ that belongs to the path is not read as a credential", () => {
    assert.equal(validateWebhookUrl("https://hooks.example.com/@team/x"), null);
  });

  test("an https URL with a port and a bare-IPv6 loopback both validate", () => {
    assert.equal(validateWebhookUrl("https://hooks.example.com:8443/x"), null);
    assert.equal(validateWebhookUrl("http://[::1]:8080/hook"), null);
  });
});

// ── Rate limiting ──────────────────────────────────────────────────────────

describe("isRateLimited / dueWebhookEvents", () => {
  const NOW = 1_000_000;

  test("nothing sent yet is never limited", () => {
    assert.equal(isRateLimited(settings({ minIntervalMs: 60_000 }), null, NOW), false);
  });

  test("a dispatch inside the cooldown suppresses the next one, and the boundary passes", () => {
    const configured = settings({ minIntervalMs: 60_000 });
    assert.equal(isRateLimited(configured, NOW - 1, NOW), true);
    assert.equal(isRateLimited(configured, NOW - 59_999, NOW), true);
    // Exactly at the boundary is outside the cooldown: the operator asked for
    // "at most every 60s", and 60s is permitted.
    assert.equal(isRateLimited(configured, NOW - 60_000, NOW), false);
    assert.equal(isRateLimited(configured, NOW - 120_000, NOW), false);
  });

  test("a zero cooldown means every dispatch is allowed", () => {
    assert.equal(isRateLimited(settings({ minIntervalMs: 0 }), NOW, NOW), false);
  });

  test("the cooldown is per event type — a freeze does not silence the countdown before it", () => {
    const configured = settings({ minIntervalMs: 60_000 });
    const due = dueWebhookEvents({
      settings: configured,
      events: ["FREEZE_ACTIVATED", "DMS_EXPIRING"],
      lastSentAt: { FREEZE_ACTIVATED: NOW - 1_000 },
      nowMs: NOW,
    });
    assert.deepEqual(due, ["DMS_EXPIRING"]);
  });

  test("an event that is not selected is never due, however long ago it last fired", () => {
    const due = dueWebhookEvents({
      settings: settings({ events: ["DMS_EXPIRING"] }),
      events: ["FREEZE_ACTIVATED", "DMS_EXPIRING"],
      lastSentAt: { DMS_EXPIRING: NOW - 999_999 },
      nowMs: NOW,
    });
    assert.deepEqual(due, ["DMS_EXPIRING"]);
  });
});

// ── Trigger detection ──────────────────────────────────────────────────────

describe("webhookEventsFor", () => {
  const healthy = { adminFrozen: false, dms: null, blockedCount: 0 };

  test("a freeze the operator caused is dispatched", () => {
    const events = webhookEventsFor(settings(), { ...healthy, adminFrozen: true });
    assert.ok(events.includes("FREEZE_ACTIVATED"));
  });

  test("a failed status read produces no freeze alert — an unread is not an unfrozen guard", () => {
    const events = webhookEventsFor(settings(), { ...healthy, adminFrozen: null });
    assert.deepEqual(events, []);
  });

  test("a dead-man countdown at any level above none fires, and none does not", () => {
    const dms = (level: "none" | "warning" | "critical" | "expired") =>
      ({
        level,
        remainingSecs: 60,
        totalSecs: 3_600,
        fractionRemaining: 0.02,
        elapsedSecs: 3_540,
        expiresAtMs: 1_700_000_000_000,
      }) as const;
    assert.deepEqual(webhookEventsFor(settings(), { ...healthy, dms: dms("none") }), []);
    assert.deepEqual(webhookEventsFor(settings(), { ...healthy, dms: null }), []);
    for (const level of ["warning", "critical", "expired"] as const) {
      assert.ok(
        webhookEventsFor(settings(), { ...healthy, dms: dms(level) }).includes("DMS_EXPIRING"),
        level,
      );
    }
  });

  test("the block alert waits for the configured threshold, not for the first refusal", () => {
    assert.deepEqual(
      webhookEventsFor(settings({ blockThreshold: 5 }), { ...healthy, blockedCount: 4 }),
      [],
    );
    assert.deepEqual(
      webhookEventsFor(settings({ blockThreshold: 5 }), { ...healthy, blockedCount: 5 }),
      ["BLOCK_THRESHOLD_EXCEEDED"],
    );
  });

  test("an unselected event is never produced, however alarming the state", () => {
    const events = webhookEventsFor(settings({ events: ["DMS_EXPIRING"] }), {
      adminFrozen: true,
      dms: null,
      blockedCount: 99,
    });
    assert.deepEqual(events, []);
  });
});

describe("countBlockedInWindow", () => {
  const NOW = 1_700_000_000_000;
  const at = (offsetMs: number) => new Date(NOW - offsetMs).toISOString();
  const blocked = (ledgerClosedAt: string | null) => ({
    decision: { result: "blocked" },
    ledgerClosedAt,
  });

  test("counts refusals inside the window and ignores ones before it", () => {
    const events = [
      blocked(at(1_000)),
      blocked(at(60_000)),
      blocked(at(299_000)),
      blocked(at(301_000)),
    ];
    assert.equal(countBlockedInWindow(events, 300, NOW), 3);
  });

  test("an allowed decision is not a refusal", () => {
    assert.equal(
      countBlockedInWindow([{ decision: { result: "allowed" }, ledgerClosedAt: at(0) }], 300, NOW),
      0,
    );
    assert.equal(countBlockedInWindow([{ ledgerClosedAt: at(0) }], 300, NOW), 0);
  });

  test("a refusal with no usable timestamp counts as recent rather than disappearing", () => {
    // The alternative — discarding it — would let a burst hide behind a missing
    // timestamp.
    assert.equal(countBlockedInWindow([blocked(null)], 300, NOW), 1);
    assert.equal(countBlockedInWindow([blocked("not-a-date")], 300, NOW), 1);
  });
});

describe("createWebhookTriggerTracker", () => {
  test("a condition that stays true fires once, not once per poll", () => {
    const tracker = createWebhookTriggerTracker();
    assert.deepEqual(tracker.entered(["FREEZE_ACTIVATED"]), ["FREEZE_ACTIVATED"]);
    assert.deepEqual(tracker.entered(["FREEZE_ACTIVATED"]), []);
    assert.deepEqual(tracker.entered(["FREEZE_ACTIVATED"]), []);
  });

  test("clearing and re-entering the same condition fires again", () => {
    const tracker = createWebhookTriggerTracker();
    tracker.entered(["FREEZE_ACTIVATED"]);
    assert.deepEqual(tracker.entered([]), []);
    assert.deepEqual(tracker.entered(["FREEZE_ACTIVATED"]), ["FREEZE_ACTIVATED"]);
  });

  test("worsening the dead-man switch is a transition, so it can re-fire", () => {
    const tracker = createWebhookTriggerTracker();
    assert.deepEqual(tracker.entered(["DMS_EXPIRING"]), ["DMS_EXPIRING"]);
    // The warning still holds, but the tracker compares on the event, not the
    // level — so the cooldown, not the tracker, is what bounds repeats of an
    // unchanged condition. A suppressed repeat must not be recorded as an
    // observation, which is why the caller filters before tracking.
    assert.deepEqual(tracker.entered(["DMS_EXPIRING"]), []);
  });

  test("reset forgets the observation, so a guard switch alerts on the new guard's state", () => {
    const tracker = createWebhookTriggerTracker();
    tracker.entered(["FREEZE_ACTIVATED"]);
    tracker.reset();
    assert.deepEqual(tracker.entered(["FREEZE_ACTIVATED"]), ["FREEZE_ACTIVATED"]);
  });

  test("events are tracked independently", () => {
    const tracker = createWebhookTriggerTracker();
    assert.deepEqual(tracker.entered(["FREEZE_ACTIVATED", "DMS_EXPIRING"]), [
      "FREEZE_ACTIVATED",
      "DMS_EXPIRING",
    ]);
    assert.deepEqual(tracker.entered(["FREEZE_ACTIVATED", "DMS_EXPIRING"]), []);
    assert.deepEqual(tracker.entered(["DMS_EXPIRING"]), []);
  });
});

// ── Configuration ──────────────────────────────────────────────────────────

describe("settings persistence and validation", () => {
  function memoryStorage(): StorageLike & { value: string | null } {
    const store = {
      value: null as string | null,
      getItem() {
        return store.value;
      },
      setItem(_key: string, value: string) {
        store.value = value;
      },
    };
    return store;
  }

  test("nothing stored means nothing enabled — an operator opts in explicitly", () => {
    const loaded = loadWebhookSettings(memoryStorage());
    assert.equal(loaded.enabled, false);
    assert.equal(loaded.url, "");
    assert.deepEqual(loaded.events, [...WEBHOOK_EVENT_TYPES]);
  });

  test("a round trip preserves the configuration", () => {
    const storage = memoryStorage();
    saveWebhookSettings(
      settings({ url: " https://hooks.example.com/x ", secret: SECRET, blockThreshold: 3 }),
      storage,
    );
    const loaded = loadWebhookSettings(storage);
    assert.equal(loaded.url, "https://hooks.example.com/x");
    assert.equal(loaded.secret, SECRET);
    assert.equal(loaded.blockThreshold, 3);
  });

  test("a corrupt payload degrades to the defaults rather than throwing", () => {
    const storage = memoryStorage();
    storage.value = "{not json";
    assert.equal(loadWebhookSettings(storage).enabled, false);
  });

  test("one unknown event type drops that entry, not the operator's other two", () => {
    const normalised = normalizeWebhookSettings({
      enabled: true,
      url: "https://hooks.example.com/x",
      events: ["DMS_EXPIRING", "NOT_A_REAL_EVENT", "FREEZE_ACTIVATED"],
    });
    assert.deepEqual(normalised.events, ["DMS_EXPIRING", "FREEZE_ACTIVATED"]);
  });

  test("nonsense numbers are clamped into a usable range instead of disabling alerts", () => {
    const normalised = normalizeWebhookSettings({
      blockThreshold: 0,
      minIntervalMs: -1,
      blockWindowSecs: Number.NaN,
    });
    assert.equal(normalised.blockThreshold, 1);
    assert.equal(normalised.minIntervalMs, 0);
    assert.equal(normalised.blockWindowSecs, DEFAULT_WEBHOOK_SETTINGS.blockWindowSecs);
    assert.equal(
      normalizeWebhookSettings({ blockThreshold: 10_000 }).blockThreshold,
      MAX_BLOCK_THRESHOLD,
    );
  });

  test("subscribers are notified when settings change and released on unsubscribe", () => {
    let calls = 0;
    const unsubscribe = subscribeWebhookSettings(() => {
      calls += 1;
    });
    saveWebhookSettings(settings(), memoryStorage());
    unsubscribe();
    saveWebhookSettings(settings(), memoryStorage());
    assert.equal(calls, 1);
  });

  test("webhookConfigProblem names the first thing that would stop a dispatch", () => {
    assert.match(webhookConfigProblem({ ...DEFAULT_WEBHOOK_SETTINGS }) ?? "", /switched off/);
    assert.match(webhookConfigProblem(settings({ url: "" })) ?? "", /Enter a webhook URL/);
    assert.match(webhookConfigProblem(settings({ url: "http://example.com" })) ?? "", /https/);
    assert.match(webhookConfigProblem(settings({ events: [] })) ?? "", /at least one alert type/);
    assert.equal(webhookConfigProblem(settings()), null);
  });
});

// ── Operator-facing copy ───────────────────────────────────────────────────

describe("describeDispatch", () => {
  test("only a real delivery is ever described as delivered", () => {
    const base = buildWebhookPayload({
      event: "FREEZE_ACTIVATED",
      guard: GUARD,
      network: "testnet",
      timestamp: TIMESTAMP,
    });
    assert.match(
      describeDispatch({ ok: true, outcome: "sent", status: 200, error: null, payload: base }),
      /Delivered/,
    );
    for (const outcome of ["rate-limited", "skipped", "rejected", "failed"] as const) {
      const text = describeDispatch({
        ok: false,
        outcome,
        status: outcome === "rejected" ? 503 : null,
        error: null,
        payload: base,
      });
      assert.doesNotMatch(text, /^Delivered/);
      assert.ok(text.length > 0);
    }
  });

  test("an unsigned delivery says so rather than implying a signature exists", () => {
    const payload = buildWebhookPayload({
      event: "FREEZE_ACTIVATED",
      guard: GUARD,
      network: "testnet",
      timestamp: TIMESTAMP,
    });
    assert.match(
      describeDispatch({ ok: true, outcome: "sent", status: 200, error: null, payload }),
      /unsigned/,
    );
  });

  test("a rejection names the status and a failure names the transport", () => {
    const payload = buildWebhookPayload({
      event: "FREEZE_ACTIVATED",
      guard: GUARD,
      network: "testnet",
      timestamp: TIMESTAMP,
    });
    assert.match(
      describeDispatch({
        ok: false,
        outcome: "rejected",
        status: 404,
        error: null,
        payload,
      }),
      /404/,
    );
    assert.match(
      describeDispatch({
        ok: false,
        outcome: "failed",
        status: null,
        error: "Failed to fetch",
        payload,
      }),
      /Failed to fetch/,
    );
  });
});
