#!/usr/bin/env node
/**
 * The zero-server boundary, checked mechanically (issue #352).
 *
 * This dashboard is a pure client-side console: it holds no key, signs nothing,
 * and proxies nothing. That property is a list of absent files — no Next.js
 * route handler and no middleware — so it can be enforced better by a script
 * than by a shell grep in a review checklist. A `route.ts` under `app/` would be
 * the first place a proxy, a signer, or a secret could appear, so its existence
 * fails CI before review has to notice it.
 *
 * Usage:
 *   node scripts/check-no-server.mjs [root]
 *
 * `root` defaults to the working directory; the unit test points it at
 * temporary fixture trees so the check can be proven both ways without adding a
 * route file to this repository.
 */

import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** The architecture decision every failure is reported against. */
export const ADR_PATH = "docs/adr/001-zero-server-architecture.md";

/** Route handlers are only prohibited under `app/`, which is where Next.js reads them. */
const ROUTE_FILE = /^route\.(?:ts|tsx|js|jsx|mjs)$/;

/** A middleware file at any level would run on the server for every request. */
const MIDDLEWARE_FILE = /^middleware\.(?:ts|tsx|js|jsx|mjs)$/;

/** Directories that cannot contain reviewed source, or would make the scan slow. */
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "vendor",
  ".git",
  ".next",
  ".freebuff",
  "dist",
  "build",
  "out",
  "coverage",
  "playwright-report",
  "test-results",
]);

/**
 * Every server-side entry point under `root`, as paths relative to it.
 *
 * Hidden directories are skipped for the same reason as the list above: they
 * hold tool state, never application code. A directory that cannot be read is
 * skipped rather than fatal — the check's job is to find prohibited files, not
 * to audit permissions.
 */
export function findServerEntryPoints(root = process.cwd()) {
  const found = [];
  walk(root, root, found);
  return found.sort();
}

function walk(directory, root, found) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")) continue;
      walk(join(directory, entry.name), root, found);
      continue;
    }
    if (!entry.isFile()) continue;
    const path = relative(root, join(directory, entry.name)).split(sep).join("/");
    const directoryPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const inApp = directoryPath === "app" || directoryPath.startsWith("app/");
    if (inApp && ROUTE_FILE.test(entry.name)) found.push(path);
    else if (MIDDLEWARE_FILE.test(entry.name)) found.push(path);
  }
}

/**
 * Run the check, printing a clean line or the offending paths and why they are
 * prohibited. Returns the process exit code instead of exiting, so the unit
 * test can call it in-process.
 */
export function run(root = process.cwd()) {
  const offenders = findServerEntryPoints(root);
  if (offenders.length === 0) {
    console.log("no-server boundary: clean — no app route handlers and no middleware in the tree.");
    return 0;
  }
  console.error(
    `no-server boundary: ${offenders.length} server entry point(s) found. This project is client-only and non-custodial:`,
  );
  for (const path of offenders) console.error(`  ${path}`);
  console.error(
    [
      "",
      "A Next.js route handler or middleware could hold a key, sign on the operator's behalf, or proxy the RPC.",
      "That is the architecture decision, not a style preference:",
      `  ${ADR_PATH}`,
      "",
      "Remove the file, or change the decision and its review checklist first.",
    ].join("\n"),
  );
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run(process.argv[2]);
}
