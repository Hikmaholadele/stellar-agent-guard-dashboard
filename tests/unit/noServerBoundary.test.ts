import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ADR_PATH, findServerEntryPoints, run } from "../../scripts/check-no-server.mjs";

/**
 * The check is proven in both directions: a clean tree passes, and temporary
 * fixture paths fail with the offending paths named. The fixtures live in the
 * OS temp directory, never under `app/`, because adding a prohibited file to
 * the repository to test for prohibited files would be the regression itself.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "guard-no-server-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, content = "export {};\n"): void {
  const absolute = join(root, path);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content);
}

/** Capture what `run` prints, so a failure message can be asserted. */
function capture(action: () => number): { code: number; stdout: string; stderr: string } {
  const logged: string[] = [];
  const errored: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...args: unknown[]) => void logged.push(args.join(" "));
  console.error = (...args: unknown[]) => void errored.push(args.join(" "));
  try {
    return { code: action(), stdout: logged.join("\n"), stderr: errored.join("\n") };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

describe("no-server boundary check", () => {
  it("passes a clean tree and says so", () => {
    write("app/page.tsx");
    write("components/Panel.tsx");
    write("lib/guard/chain.ts");

    assert.deepEqual(findServerEntryPoints(root), []);
    const result = capture(() => run(root));
    assert.equal(result.code, 0);
    assert.match(result.stdout, /no app route handlers and no middleware/i);
    assert.equal(result.stderr, "");
  });

  it("fails on an app route handler and prints its path", () => {
    write("app/page.tsx");
    write("app/api/guard/route.ts");
    write("app/api/guard/route.tsx");
    write("app/api/guard/route.js");

    const offenders = findServerEntryPoints(root);
    assert.deepEqual(offenders, [
      "app/api/guard/route.js",
      "app/api/guard/route.ts",
      "app/api/guard/route.tsx",
    ]);

    const result = capture(() => run(root));
    assert.equal(result.code, 1);
    for (const path of offenders) {
      assert.ok(result.stderr.includes(path), `the offending path ${path} is named`);
    }
    assert.ok(result.stderr.includes(ADR_PATH), "the failure links the architecture decision");
  });

  it("fails on a middleware file anywhere in the tree", () => {
    write("middleware.ts");
    write("app/page.tsx");

    assert.deepEqual(findServerEntryPoints(root), ["middleware.ts"]);
    const result = capture(() => run(root));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /middleware\.ts/);
    assert.match(result.stderr, /client-only and non-custodial/i);
  });

  it("is not fooled by a route-shaped file outside app/", () => {
    write("app/page.tsx");
    write("tests/fixtures/route.ts");
    write("scripts/route.tsx");

    assert.deepEqual(findServerEntryPoints(root), []);
    assert.equal(capture(() => run(root)).code, 0);
  });

  it("keeps this repository clean", () => {
    assert.deepEqual(findServerEntryPoints(), []);
  });
});
