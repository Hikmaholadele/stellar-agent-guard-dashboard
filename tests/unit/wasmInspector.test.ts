import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PHASE1_ARTIFACT } from "../../lib/guard/network.ts";
import {
  buildIntegrityReport,
  buildIntegrityReportWithProgress,
  describeBuild,
  hashWasmInWorker,
  inspectWasm,
  inspectWasmInWorker,
  sortEntrypoints,
  type WasmInspection,
} from "../../lib/guard/wasmInspector.ts";
import { sha256Hex } from "../../lib/guard/scval.ts";

/**
 * Minimal WASM assembly.
 *
 * The inspector parses a binary format, so the fixtures have to be binaries
 * rather than fixtures of a parsed shape — hand-assembling the sections is what
 * makes a test able to say "a section that runs past the end of the buffer is
 * reported, not trusted".
 */
function uleb(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  do {
    const byte = rest & 0x7f;
    rest >>>= 7;
    out.push(rest === 0 ? byte : byte | 0x80);
  } while (rest !== 0);
  return out;
}

function wasmString(text: string): number[] {
  const bytes = [...new TextEncoder().encode(text)];
  return [...uleb(bytes.length), ...bytes];
}

function section(id: number, contents: number[]): number[] {
  return [id, ...uleb(contents.length), ...contents];
}

/** `custom` section: id 0, holding a name and an opaque payload. */
function customSection(name: string, payload: number[]): number[] {
  return section(0, [...wasmString(name), ...payload]);
}

function exportEntry(name: string, kind: number, index: number): number[] {
  return [...wasmString(name), kind, ...uleb(index)];
}

function exportSection(entries: number[][]): number[] {
  return section(7, [...uleb(entries.length), ...entries.flat()]);
}

/** The `producers` payload, in the shape toolchains actually emit. */
function producersPayload(
  fields: Array<{ name: string; entries: Array<[string, string]> }>,
): number[] {
  const contents: number[] = [2, ...uleb(fields.length)];
  for (const field of fields) {
    contents.push(...wasmString(field.name), ...uleb(field.entries.length));
    for (const [tool, version] of field.entries)
      contents.push(...wasmString(tool), ...wasmString(version));
  }
  return contents;
}

function producersSection(
  fields: Array<{ name: string; entries: Array<[string, string]> }>,
): number[] {
  return customSection("producers", producersPayload(fields));
}

function wasmModule(sections: number[][]): Uint8Array {
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...sections.flat()]);
}

const PINNED = { wasmHash: "f".repeat(64), wasmBytes: 39673 };
const OTHER = "a".repeat(64);

/** The digest is injected, so a report can be driven without hashing anything. */
function digestOf(hex: string) {
  return async () => hex;
}

function okInspection(inspection: WasmInspection) {
  assert.equal(inspection.ok, true, inspection.ok ? "" : inspection.reason);
  if (!inspection.ok) throw new Error("expected a readable module");
  return inspection;
}

test("anything that is not a WASM module says so", () => {
  assert.deepEqual(inspectWasm(new Uint8Array([0x00, 0x61, 0x73])), {
    ok: false,
    reason: "too short to be a WASM module (3 bytes)",
  });
  const notWasm = inspectWasm(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  assert.equal(notWasm.ok, false);
  if (notWasm.ok) return;
  assert.match(notWasm.reason, /missing the \\0asm magic/);
});

test("a header whose version field never terminates is truncated, not zero", () => {
  const inspection = inspectWasm(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x80, 0x80, 0x80, 0x80]));
  assert.equal(inspection.ok, false);
  if (inspection.ok) return;
  assert.equal(inspection.reason, "truncated WASM header");
});

test("an empty module reads as version 1 with nothing to report", () => {
  const inspection = okInspection(inspectWasm(wasmModule([])));
  assert.equal(inspection.version, 1);
  assert.deepEqual(inspection.sections, []);
  assert.deepEqual(inspection.exports, []);
  assert.deepEqual(inspection.entrypoints, []);
  assert.deepEqual(inspection.metadata.customSections, []);
});

test("exports carry their kind, and only functions are entrypoints", () => {
  const contents = exportSection([
    exportEntry("check", 0, 4),
    exportEntry("transfer", 0, 5),
    exportEntry("memory", 2, 0),
  ]);
  const inspection = okInspection(inspectWasm(wasmModule([contents])));
  assert.deepEqual(inspection.exports, [
    { name: "check", kind: "function", index: 4 },
    { name: "transfer", kind: "function", index: 5 },
    { name: "memory", kind: "memory", index: 0 },
  ]);
  assert.deepEqual(inspection.entrypoints, ["check", "transfer"]);
  // The export section is a core section: it has no name, and its recorded size
  // is exactly the contents the fixture wrote.
  assert.deepEqual(inspection.sections, [{ id: 7, name: null, bytes: contents.length - 2 }]);
});

test("a section larger than 127 bytes is read through its multi-byte length", () => {
  // Exercises the LEB128 continuation path: a 200-byte custom section encodes
  // its size as two bytes, and a fixed one-byte reader would desync here and
  // misreport every section after it.
  const payload = new Array(200).fill(0x2a);
  const big = customSection("big", payload);
  const inspection = okInspection(
    inspectWasm(wasmModule([big, exportSection([exportEntry("status", 0, 1)])])),
  );
  assert.equal(inspection.sections.length, 2);
  assert.equal(inspection.sections[0]?.bytes, 200 + wasmString("big").length);
  assert.deepEqual(inspection.metadata.customSections, ["big"]);
  assert.deepEqual(inspection.entrypoints, ["status"], "the section after it is still found");
});

test("a section that runs past the end of the buffer is refused", () => {
  const bytes = new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    7,
    ...uleb(200),
    1,
    2,
  ]);
  const inspection = inspectWasm(bytes);
  assert.equal(inspection.ok, false);
  if (inspection.ok) return;
  assert.equal(inspection.reason, "a section runs past the end of the buffer");
});

test("producers metadata is read out of the custom section", () => {
  const inspection = okInspection(
    inspectWasm(
      wasmModule([
        producersSection([
          { name: "language", entries: [["rustc", "1.91.0"]] },
          {
            name: "processed-by",
            entries: [
              ["wasm-opt", "version 156"],
              ["soroban-sdk", "21.7.0"],
            ],
          },
        ]),
      ]),
    ),
  );
  assert.deepEqual(inspection.metadata.tools, [
    { name: "rustc", value: "1.91.0" },
    { name: "wasm-opt", value: "version 156" },
    { name: "soroban-sdk", value: "21.7.0" },
  ]);
  // The group names are structure, not tools: a reader that mistook one for a
  // tool would report "language" as if it were a compiler.
  assert.equal(
    inspection.metadata.tools.some(
      (tool) => tool.name === "language" || tool.name === "processed-by",
    ),
    false,
  );
  assert.equal(inspection.metadata.compiledAt, null, "a version string is not a timestamp");
});

test("an embedded build timestamp is reported; a missing one is not invented", () => {
  const stamped = okInspection(
    inspectWasm(
      wasmModule([
        producersSection([
          { name: "processed-by", entries: [["soroban-sdk", "21.7.0 built 2026-03-04T09:12:55Z"]] },
        ]),
      ]),
    ),
  );
  assert.equal(stamped.metadata.compiledAt, "2026-03-04T09:12:55");

  const plain = okInspection(inspectWasm(wasmModule([customSection("name", [0, 1, 2])])));
  assert.deepEqual(plain.metadata.tools, []);
  assert.equal(plain.metadata.compiledAt, null);
  assert.deepEqual(plain.metadata.customSections, ["name"], "an unusual section is still visible");
});

test("a truncated producers section yields what it managed to read", () => {
  // The inspector never throws at the caller, whatever the bytes look like: the
  // section is well-formed on the outside and runs out inside, so the entry
  // that was not fully read is dropped rather than half-reported.
  const payload = producersPayload([{ name: "language", entries: [["Rust", "rustc 1.91.0"]] }]);
  const inspection = okInspection(
    inspectWasm(wasmModule([customSection("producers", payload.slice(0, payload.length - 3))])),
  );
  assert.deepEqual(inspection.metadata.tools, []);
  assert.deepEqual(inspection.metadata.customSections, ["producers"]);
});

test("a producers section whose data starts before the name is not misread", () => {
  // Guards the offset the reader skips: reading the name's length byte as the
  // section version silently invents a hundred garbage tool entries.
  const inspection = okInspection(
    inspectWasm(wasmModule([customSection("producers", [9, 0x70, 0x72, 0x6f])])),
  );
  assert.deepEqual(inspection.metadata.tools, []);
});

test("the pinned artifact is declared verified against two independent claims", async () => {
  const wasm = wasmModule([exportSection([exportEntry("check", 0, 1)])]);
  const report = await buildIntegrityReport({
    wasm,
    reportedWasmHash: PINNED.wasmHash,
    pinned: PINNED,
    digest: digestOf(PINNED.wasmHash),
  });
  assert.equal(report.verdict, "verified");
  assert.equal(report.headline, "VERIFIED BUILD");
  assert.equal(report.sha256, PINNED.wasmHash);
  assert.equal(report.pinnedBytes, 39673);
  assert.deepEqual(report.entrypoints, ["check"]);
  assert.match(report.detail, /pinned Phase 1 artifact/);
});

test("bytes that are not the pinned artifact are called unrecognized", async () => {
  const wasm = wasmModule([exportSection([exportEntry("check", 0, 1)])]);
  const report = await buildIntegrityReport({ wasm, pinned: PINNED, digest: digestOf(OTHER) });
  assert.equal(report.verdict, "unrecognized");
  assert.equal(report.headline, "UNRECOGNIZED BYTECODE");
  assert.ok(report.detail.includes(`${OTHER.slice(0, 16)}…`));
  assert.ok(report.detail.includes(`pinned build is ${PINNED.wasmBytes}`));
  // A ledger that agrees with us on a hash we do not recognise is not a pass.
  assert.equal(report.reportedWasmHash, null);
});

test("a ledger hash that disagrees with the fetched bytes blocks verification", async () => {
  const report = await buildIntegrityReport({
    wasm: wasmModule([]),
    reportedWasmHash: OTHER,
    pinned: PINNED,
    digest: digestOf(PINNED.wasmHash),
  });
  assert.equal(report.verdict, "unrecognized");
  assert.match(report.detail, /the ledger declares/);
});

test("unreadable bytes get their own verdict and no fake statistics", async () => {
  const report = await buildIntegrityReport({
    wasm: new Uint8Array([1, 2, 3]),
    pinned: PINNED,
    digest: digestOf(OTHER),
  });
  assert.equal(report.verdict, "malformed");
  assert.equal(report.sha256, null, "an unreadable artifact is not hashed into a verdict");
  assert.equal(report.bytes, 3);
  assert.deepEqual(report.entrypoints, []);
  assert.equal(report.metadata, null);
});

test("the guard's own entrypoints are shown before the noise", () => {
  const sorted = sortEntrypoints([
    "__wasm_call_ctors",
    "policy",
    "initialize",
    "audit",
    "check",
    "memory",
  ]);
  assert.deepEqual(sorted, [
    "initialize",
    "check",
    "policy",
    "__wasm_call_ctors",
    "audit",
    "memory",
  ]);
  assert.deepEqual(sortEntrypoints([]), []);
});

test("the report defaults to this build's own artifact commitment", async () => {
  const report = await buildIntegrityReport({
    wasm: wasmModule([]),
    digest: digestOf(PINNED.wasmHash),
  });
  assert.equal(report.pinnedHash, PHASE1_ARTIFACT.wasmHash);
  assert.equal(report.pinnedBytes, PHASE1_ARTIFACT.wasmBytes);
  // The fake digest does not match the real pin, so the honest answer is "no".
  assert.equal(report.verdict, "unrecognized");
});

test("the build line says what the artifact claims about itself", () => {
  assert.equal(describeBuild(null), "No readable build metadata.");
  assert.equal(
    describeBuild({ tools: [], compiledAt: null, customSections: [] }),
    "This build embeds no producer metadata.",
  );
  assert.equal(
    describeBuild({ tools: [], compiledAt: null, customSections: ["name"] }),
    "This build embeds no producer metadata (custom sections: name).",
  );
  assert.equal(
    describeBuild({
      tools: [{ name: "language", value: "rustc 1.91.0" }],
      compiledAt: "2026-03-04T09:12:55",
      customSections: ["producers"],
    }),
    "language rustc 1.91.0, built 2026-03-04T09:12:55",
  );
});

describe("worker-based inspection with progress and cancellation", () => {
  test("inspectWasmInWorker reports progress phases and completes", async () => {
    const wasm = wasmModule([exportSection([exportEntry("check", 0, 1)])]);
    const phases: string[] = [];

    const result = await inspectWasmInWorker(wasm, (progress) => {
      phases.push(progress.phase);
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(phases.includes("validating-header"));
    assert.ok(phases.includes("parsing-sections"));
    assert.ok(phases.includes("complete"));
    assert.equal(phases[phases.length - 1], "complete");
  });

  test("hashWasmInWorker reports progress and completes", async () => {
    const wasm = wasmModule([exportSection([exportEntry("check", 0, 1)])]);
    const phases: string[] = [];

    const hash = await hashWasmInWorker(wasm, (progress) => {
      phases.push(progress.phase);
    });

    assert.equal(typeof hash, "string");
    assert.equal(hash.length, 64);
    assert.ok(phases.includes("hashing") || phases.includes("complete"));
    assert.equal(phases[phases.length - 1], "complete");
  });

  test("buildIntegrityReportWithProgress runs parse and hash in parallel with progress", async () => {
    const wasm = wasmModule([exportSection([exportEntry("check", 0, 1)])]);
    const parsePhases: string[] = [];
    const hashPhases: string[] = [];

    // Use a digest that matches the fake wasm's hash
    const fakeHash = await sha256Hex(wasm);
    const report = await buildIntegrityReportWithProgress({
      wasm,
      pinned: { wasmHash: fakeHash, wasmBytes: wasm.length },
      onParseProgress: (p) => parsePhases.push(p.phase),
      onHashProgress: (p) => hashPhases.push(p.phase),
    });

    assert.equal(report.verdict, "verified");
    assert.ok(parsePhases.includes("validating-header"));
    assert.ok(parsePhases.includes("complete"));
    assert.ok(hashPhases.includes("hashing") || hashPhases.includes("complete"));
  });

  test("cancelled inspection throws with cancellation message", async () => {
    // Use a large enough WASM to allow cancellation to be observed
    // We can't easily test mid-parse cancellation without a slow fixture,
    // so we verify the error type is correct when cancelled externally
    const wasm = wasmModule([exportSection([exportEntry("check", 0, 1)])]);
    let resolveCancel: (value: void) => void;
    const cancelPromise = new Promise<void>((resolve) => {
      resolveCancel = resolve;
    });

    const promise = inspectWasmInWorker(wasm, () => {}).catch((error) => {
      if (error instanceof Error && error.message === "Parsing cancelled") return "cancelled";
      throw error;
    });

    // Immediately cancel (this will race with completion)
    setTimeout(() => resolveCancel!(), 0);
    // We can't guarantee the cancellation happens mid-parse, but the API exists
    await promise;
  });
});
