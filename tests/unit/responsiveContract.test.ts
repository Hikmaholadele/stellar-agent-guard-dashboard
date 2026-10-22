import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Responsive stylesheet contract for /configure (upstream issue #35).
 *
 * jsdom has no layout engine, so layout itself cannot be asserted here — the
 * plain-CSS equivalent of a class-contract test asserts the *stylesheet
 * wiring*: the media-query block exists, the responsive rules are inside it,
 * and the form component actually uses the classes. Real layout proof is the
 * manual 375px screenshot check named in the PR (reviewer checklist), with
 * Playwright viewport tests as the tracked follow-up.
 */

const stylesheet = readFileSync("app/globals.css", "utf8");
const formSource = readFileSync("components/PolicyForm.tsx", "utf8");

/** Extract a top-level `@media` block's body by brace matching. */
function mediaBlock(query: string): string {
  const start = stylesheet.indexOf(`@media ${query}`);
  assert.ok(start >= 0, `expected an @media ${query} block in globals.css`);
  let depth = 0;
  let i = stylesheet.indexOf("{", start);
  const open = i;
  for (; i < stylesheet.length; i++) {
    if (stylesheet[i] === "{") depth += 1;
    if (stylesheet[i] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return stylesheet.slice(open, i + 1);
}

test("responsive contract: rules live inside the 720px media block", async (t) => {
  const block = mediaBlock("(max-width: 720px)");

  await t.test("split collapses to one column under the breakpoint", () => {
    assert.match(block, /\.split\s*\{[^}]*grid-template-columns:\s*1fr/);
  });

  await t.test("form action bar stacks full-width buttons (touch-height 44px)", () => {
    assert.match(block, /\.form-actions\s*\{[^}]*flex-direction:\s*column/);
    assert.match(block, /\.form-actions button\s*\{[^}]*min-height:\s*44px/);
    assert.match(block, /\.form-actions button\s*\{[^}]*width:\s*100%/);
  });

  await t.test("list-editor remove buttons get a >=44px touch target", () => {
    assert.match(block, /\.asset-caps button\.secondary\s*\{[^}]*min-height:\s*44px/);
  });

  await t.test("inline date-range pair stacks instead of overflowing", () => {
    assert.match(block, /\.form-inline-row\s*\{[^}]*flex-direction:\s*column/);
  });
});

test("responsive contract: the form actually uses the classes", async (t) => {
  await t.test("PolicyForm's action bar carries the sticky .form-actions class", () => {
    assert.match(formSource, /className="form-actions row"/);
  });

  await t.test("PolicyForm's inline date pair carries .form-inline-row", () => {
    assert.match(formSource, /className="row form-inline-row"/);
  });

  await t.test("action bar is sticky below the fold (sticky positioning wired)", () => {
    const sticky = stylesheet.match(/\.form-actions\s*\{[^}]*position:\s*sticky/);
    assert.ok(sticky, "expected .form-actions { position: sticky; ... } outside the media block");
  });
});

/**
 * Responsive table contract (#338).
 *
 * Same jsdom limitation as above: layout itself is not measured here. What is
 * asserted is the contract that makes the narrow layout understandable — the
 * semantic header cells are still real `<th scope="col">`, every data cell
 * carries the row label that the stacked layout prints, and the stylesheet
 * hides the header row visually (never semantically) while wrapping long
 * addresses instead of clipping them.
 */

const fleetSource = readFileSync("components/FleetTable.tsx", "utf8");
const telemetrySource = readFileSync("components/TelemetryFeed.tsx", "utf8");
const historySource = readFileSync("components/TxHistoryTable.tsx", "utf8");

const TABLES = [
  { name: "FleetTable", source: fleetSource },
  { name: "TelemetryFeed", source: telemetrySource },
  { name: "TxHistoryTable", source: historySource },
];

test("responsive tables: headers stay semantic and rows carry their labels", async (t) => {
  for (const table of TABLES) {
    await t.test(`${table.name} declares every header cell as a column header`, () => {
      const headers = table.source.match(/<th\b[^>]*>/g) ?? [];
      assert.ok(headers.length > 0, "expected the table to render header cells");
      for (const header of headers) {
        assert.match(header, /scope="col"/, `unscoped header in ${table.name}: ${header}`);
      }
    });

    await t.test(`${table.name} opts into the stacked layout`, () => {
      assert.match(table.source, /events stack/);
      assert.match(table.source, /className=/);
      assert.match(table.source, /scrolly table-stack/);
    });
  }

  await t.test("each data cell has a row label for the compact layout", () => {
    const expected: Array<[string, string[]]> = [
      ["FleetTable", ["Guard", "Network", "Status", "24h Spend", "DMS Countdown", "Actions"]],
      ["TelemetryFeed", ["Event", "Decision", "Guard", "Source", "Time", "Transaction"]],
      [
        "TxHistoryTable",
        ["Timestamp", "Operation", "Status", "Network", "Tx Hash", "Gas Fee", "Chain verification"],
      ],
    ];
    for (const [name, labels] of expected) {
      const source = TABLES.find((table) => table.name === name)!.source;
      for (const label of labels) {
        assert.match(
          source,
          new RegExp(`<td[^>]*data-label="${label}"`),
          `${name} is missing data-label="${label}"`,
        );
      }
    }
  });

  await t.test("stacked rules live inside the 720px media block", () => {
    const block = mediaBlock("(max-width: 720px)");
    assert.match(block, /table\.events\.stack thead\s*\{[^}]*position:\s*absolute/);
    assert.match(block, /table\.events\.stack td::before\s*\{[^}]*content:\s*attr\(data-label\)/);
    assert.match(block, /table\.events\.stack td\s*\{[^}]*overflow-wrap:\s*anywhere/);
    assert.match(block, /table\.events\.stack td button\s*\{[^}]*min-height:\s*32px/);
    assert.match(block, /\.scrolly\.table-stack\s*\{[^}]*max-height:\s*none/);
    assert.match(block, /table\.events\.stack td \.row\s*\{[^}]*flex-wrap:\s*wrap/);
  });

  await t.test("key actions stay reachable without horizontal overlap", () => {
    // The fleet table's Inspect/Freeze pair and the history verification
    // controls live in cells that wrap; the stacked row is a block, so the
    // buttons cannot be pushed off-screen by a long address.
    const block = mediaBlock("(max-width: 720px)");
    assert.match(fleetSource, /flexWrap:\s*"wrap"/);
    assert.match(
      block,
      /table\.events\.stack tr,\s*table\.events\.stack td\s*\{[^}]*display:\s*block/,
    );
  });
});
