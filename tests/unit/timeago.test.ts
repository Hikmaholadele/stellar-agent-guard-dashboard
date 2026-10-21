import assert from "node:assert/strict";
import { describe, it, before, test } from "node:test";
import { formatEventTimestamp, formatTimeAgo } from "../../lib/guard/time.ts";
import { installDom, loadReact, type Act } from "./domHarness.ts";
import { TimeAgo } from "../../components/bits.tsx";
import fs from "node:fs/promises";

installDom();

let react: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: Act;

before(async () => {
  const loaded = await loadReact();
  react = loaded.react;
  createRoot = loaded.createRoot;
  act = loaded.act;
});

describe("formatTimeAgo", () => {
  const fixedNow = 1700000000n; // arbitrary deterministic "now"

  it("returns 'just now' for diff < 10s (boundary at 9s)", () => {
    assert.equal(formatTimeAgo(fixedNow - 0n, fixedNow), "just now");
    assert.equal(formatTimeAgo(fixedNow - 9n, fixedNow), "just now");
  });

  it("returns seconds for diff < 60s (boundary at 10s and 59s)", () => {
    assert.equal(formatTimeAgo(fixedNow - 10n, fixedNow), "10s");
    assert.equal(formatTimeAgo(fixedNow - 59n, fixedNow), "59s");
  });

  it("returns minutes for diff < 60m (boundary at 60s and 3599s)", () => {
    assert.equal(formatTimeAgo(fixedNow - 60n, fixedNow), "1m");
    assert.equal(formatTimeAgo(fixedNow - 119n, fixedNow), "1m");
    assert.equal(formatTimeAgo(fixedNow - 3599n, fixedNow), "59m");
  });

  it("returns hours for diff < 24h (boundary at 3600s and 86399s)", () => {
    assert.equal(formatTimeAgo(fixedNow - 3600n, fixedNow), "1h");
    assert.equal(formatTimeAgo(fixedNow - 7199n, fixedNow), "1h");
    assert.equal(formatTimeAgo(fixedNow - 86399n, fixedNow), "23h");
  });

  it("returns days for diff >= 24h (boundary at 86400s)", () => {
    assert.equal(formatTimeAgo(fixedNow - 86400n, fixedNow), "1d");
    assert.equal(formatTimeAgo(fixedNow - 172800n, fixedNow), "2d");
  });

  it("handles clock skew gracefully by capping at 0s (future timestamps)", () => {
    assert.equal(formatTimeAgo(fixedNow + 10n, fixedNow), "just now");
    assert.equal(formatTimeAgo(fixedNow + 3600n, fixedNow), "just now");
  });

  it("supports number input deterministically", () => {
    const fixedNowNum = 1700000000;
    assert.equal(formatTimeAgo(fixedNowNum - 45, fixedNowNum), "45s");
    assert.equal(formatTimeAgo(fixedNowNum - 4000, fixedNowNum), "1h");
  });
});

describe("formatEventTimestamp (issue #387 — UTC + zoned local time)", () => {
  it("renders the same instant as stable UTC and explicitly zoned local time", () => {
    const ts = formatEventTimestamp("2026-10-21T12:34:56.789Z", "UTC");
    assert.ok(ts);
    assert.equal(ts.utc, "2026-10-21T12:34:56Z");
    assert.equal(ts.local, "2026-10-21 12:34:56");
    assert.equal(ts.zoneLabel, "UTC+00:00");
  });

  it("keeps the UTC value identical while the local rendering follows the zone", () => {
    const utc = formatEventTimestamp("2026-10-21T12:34:56Z", "UTC");
    const berlin = formatEventTimestamp("2026-10-21T12:34:56Z", "Europe/Berlin");
    assert.ok(utc && berlin);
    assert.equal(berlin.utc, utc.utc, "the UTC rendering must not depend on the display zone");
    assert.equal(berlin.local, "2026-10-21 14:34:56");
    assert.equal(berlin.zoneLabel, "UTC+02:00");
  });

  it("returns null for invalid or missing timestamps instead of guessing a date", () => {
    assert.equal(formatEventTimestamp("not-a-date"), null);
    assert.equal(formatEventTimestamp(""), null);
    assert.equal(formatEventTimestamp(null), null);
    assert.equal(formatEventTimestamp(undefined), null);
  });

  it("renders events near the UTC day boundary with both days unambiguous", () => {
    // Just before and at UTC midnight: the UTC day flips, and New York's
    // local day is still the previous one — the reason both values are shown.
    const lastSecond = formatEventTimestamp("2025-12-31T23:59:59Z", "America/New_York");
    assert.ok(lastSecond);
    assert.equal(lastSecond.utc, "2025-12-31T23:59:59Z");
    assert.equal(lastSecond.local, "2025-12-31 18:59:59");
    assert.equal(lastSecond.zoneLabel, "UTC-05:00");

    const midnight = formatEventTimestamp("2026-01-01T00:00:00Z", "America/New_York");
    assert.ok(midnight);
    assert.equal(midnight.utc, "2026-01-01T00:00:00Z");
    assert.equal(midnight.local, "2025-12-31 19:00:00", "local day differs across UTC midnight");
    assert.notEqual(midnight.local.slice(0, 10), midnight.utc.slice(0, 10));
  });

  it("labels the offset actually in force across a spring-forward DST transition", () => {
    // US DST 2026 begins 2026-03-08 02:00 local: 01:59:59 EST is followed
    // directly by 03:00:00 EDT, and the zone label must change with it.
    const before = formatEventTimestamp("2026-03-08T06:59:59Z", "America/New_York");
    assert.ok(before);
    assert.equal(before.local, "2026-03-08 01:59:59");
    assert.equal(before.zoneLabel, "UTC-05:00");

    const after = formatEventTimestamp("2026-03-08T07:00:00Z", "America/New_York");
    assert.ok(after);
    assert.equal(after.local, "2026-03-08 03:00:00", "02:xx local does not exist that day");
    assert.equal(after.zoneLabel, "UTC-04:00");

    // One second apart on the clock, an hour apart in wall time — and the UTC
    // values stay one second apart, which is why they are the reportable ones.
    assert.notEqual(before.local, after.local);
    assert.equal(Date.parse(`${after.utc}`) - Date.parse(`${before.utc}`), 1000);
  });

  it("disambiguates the repeated hour of a fall-back DST transition", () => {
    // US DST 2026 ends 2026-11-01 02:00 EDT, which repeats as 01:00 EST:
    // local 01:30 happens twice, and only the zone label tells them apart.
    const first = formatEventTimestamp("2026-11-01T05:30:00Z", "America/New_York");
    const second = formatEventTimestamp("2026-11-01T06:30:00Z", "America/New_York");
    assert.ok(first && second);
    assert.equal(first.local, "2026-11-01 01:30:00");
    assert.equal(second.local, "2026-11-01 01:30:00");
    assert.equal(first.zoneLabel, "UTC-04:00");
    assert.equal(second.zoneLabel, "UTC-05:00");
    assert.notEqual(first.utc, second.utc, "the UTC values separate what local time cannot");
  });

  it("defaults to the runtime's own zone with an explicit label and an unchanged UTC value", () => {
    const ts = formatEventTimestamp("2026-10-21T12:34:56Z");
    assert.ok(ts);
    assert.equal(ts.utc, "2026-10-21T12:34:56Z");
    assert.match(ts.zoneLabel, /^UTC[+-]\d{2}:\d{2}$/);
    assert.match(ts.local, /^2026-10-21 \d{2}:\d{2}:\d{2}$/);
  });
});

test("<TimeAgo /> renders relative text and absolute ISO timestamp attributes", async () => {
  const fixtureUrl = new URL("../fixtures/phase3-proof.json", import.meta.url);
  const data = JSON.parse(await fs.readFile(fixtureUrl, "utf8"));
  const iso = data.ranAt;

  assert.equal(typeof iso, "string");

  const container = document.createElement("div");
  document.body.appendChild(container);

  let root: ReturnType<typeof createRoot> | undefined;
  await act(async () => {
    root = createRoot(container);
    root.render(react.createElement(TimeAgo, { iso }));
  });

  const timeEl = container.querySelector("time.timeago") as HTMLTimeElement;
  assert.ok(timeEl, "a <time> element should be rendered");

  assert.equal(timeEl.getAttribute("datetime"), iso);
  assert.equal(timeEl.getAttribute("title"), iso);

  const relText = timeEl.textContent;
  assert.ok(
    relText && /^(just now|\d+[smhd])$/.test(relText),
    `Rendered text "${relText}" should match relative time format`,
  );

  await act(async () => {
    root?.unmount();
  });
  container.remove();
});
