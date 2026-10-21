/**
 * Bytecode integrity: what a deployed contract actually runs.
 *
 * `verifyWasmIdentity` in `chain.ts` already proves the ledger's declared hash
 * matches the bytes it stores. This module answers the operator-facing question
 * on top of that: how big the artifact is, which functions it exports, what
 * toolchain embedded its own name in it, and whether the whole thing is the
 * artifact this build pins. A contract built from different source can satisfy
 * every read in the dashboard and still not be the code that was audited, so
 * the mismatch case is the one worth shouting about.
 *
 * Parsing is done directly on the binary rather than through a WASM library: the
 * dashboard has no server half and a dependency that parses binaries in the
 * browser is a larger surface than the eleven bytes of a section header.
 *
 * Progress and cancellation are handled via Web Workers so the UI stays
 * responsive while parsing and hashing large artifacts.
 */

import { PHASE1_ARTIFACT } from "./network.ts";
import { sha256Hex } from "./scval.ts";

export interface WasmParseProgress {
  phase:
    | "validating-header"
    | "parsing-sections"
    | "reading-exports"
    | "reading-producers"
    | "complete"
    | "error"
    | "cancelled";
  current?: number;
  total?: number;
  count?: number;
  section?: string;
  reason?: string;
  inspection?: WasmInspection;
}

export interface WasmHashProgress {
  phase: "hashing" | "complete" | "error" | "cancelled";
  bytesProcessed?: number;
  totalBytes?: number;
  hash?: string;
  reason?: string;
}

type WasmParseWorker = Worker & {
  postMessage(message: { type: "parse"; bytes: ArrayBuffer } | { type: "cancel" }): void;
  onmessage: ((event: MessageEvent<{ type: "progress"; phase: WasmParseProgress }>) => void) | null;
};

type WasmHashWorker = Worker & {
  postMessage(message: { type: "hash"; bytes: ArrayBuffer } | { type: "cancel" }): void;
  onmessage: ((event: MessageEvent<{ type: "progress"; phase: WasmHashProgress }>) => void) | null;
};

const MAGIC = [0x00, 0x61, 0x73, 0x6d] as const;

const CUSTOM_SECTION = 0;
const EXPORT_SECTION = 7;

const EXPORT_KINDS = {
  0: "function",
  1: "table",
  2: "memory",
  3: "global",
} as const;

export interface WasmSection {
  id: number;
  /** The name of a custom section; `null` for the numeric core sections. */
  name: string | null;
  bytes: number;
}

export interface WasmExport {
  name: string;
  kind: "function" | "table" | "memory" | "global";
  index: number;
}

export interface BuildMetadata {
  /** Key/value pairs from a `producers`-style custom section, if one is present. */
  tools: Array<{ name: string; value: string }>;
  /** A timestamp only when one is actually embedded; never invented. */
  compiledAt: string | null;
  /** Every custom section name, so an unusual build is visible rather than silent. */
  customSections: string[];
}

export type WasmInspection =
  | {
      ok: true;
      version: number;
      sections: WasmSection[];
      exports: WasmExport[];
      /** The callable names a Soroban contract exposes: the functions RPC can invoke. */
      entrypoints: string[];
      metadata: BuildMetadata;
    }
  | { ok: false; reason: string };

/**
 * Walk the WASM section table.
 *
 * Deliberately total: a truncated or non-WASM buffer comes back as a stated
 * reason rather than a throw, because the caller is showing this in a drawer
 * next to a hash an operator is about to trust.
 */
export function inspectWasm(bytes: Uint8Array): WasmInspection {
  if (bytes.length < 8)
    return { ok: false, reason: `too short to be a WASM module (${bytes.length} bytes)` };
  for (const [index, expected] of MAGIC.entries()) {
    if (bytes[index] !== expected) {
      return { ok: false, reason: "missing the \\0asm magic: this is not a WASM module" };
    }
  }
  const version = readUint32(bytes, 4);
  if (!version) return { ok: false, reason: "truncated WASM header" };

  const sections: WasmSection[] = [];
  const exports: WasmExport[] = [];
  const tools: Array<{ name: string; value: string }> = [];
  const customSections: string[] = [];
  let offset = 8;
  let truncated = false;

  while (offset < bytes.length) {
    const id = bytes[offset];
    if (id === undefined) break;
    offset += 1;
    const size = readUint32(bytes, offset);
    if (!size) {
      truncated = true;
      break;
    }
    offset = size.next;
    const end = offset + size.value;
    if (end > bytes.length) {
      truncated = true;
      break;
    }
    const body = bytes.subarray(offset, end);
    const name = id === CUSTOM_SECTION ? readSectionName(body) : null;
    sections.push({ id, name, bytes: size.value });

    if (id === CUSTOM_SECTION && name) {
      customSections.push(name);
      if (name === "producers" || name === "wasmparser-process-info") {
        tools.push(...readProducers(body));
      }
    }
    if (id === EXPORT_SECTION) exports.push(...readExports(body));
    offset = end;
  }

  if (truncated) return { ok: false, reason: "a section runs past the end of the buffer" };

  const entrypoints = exports.filter((item) => item.kind === "function").map((item) => item.name);
  return {
    ok: true,
    version: version.value,
    sections,
    exports,
    entrypoints,
    metadata: { tools, compiledAt: findTimestamp(tools), customSections },
  };
}

interface LEB {
  value: number;
  next: number;
}

/** unsigned LEB128, capped where a section length must be sane. */
function readUint32(bytes: Uint8Array, at: number): LEB | null {
  let result = 0;
  let shift = 0;
  let index = at;
  while (index < bytes.length) {
    const byte = bytes[index];
    if (byte === undefined) return null;
    result += (byte & 0x7f) << shift;
    index += 1;
    if ((byte & 0x80) === 0) {
      if (result < 0) return null;
      return { value: result, next: index };
    }
    shift += 7;
    if (shift > 35) return null;
  }
  return null;
}

function readName(bytes: Uint8Array, at: number): { value: string; next: number } | null {
  const length = readUint32(bytes, at);
  if (!length) return null;
  const end = length.next + length.value;
  if (end > bytes.length) return null;
  return { value: new TextDecoder().decode(bytes.subarray(length.next, end)), next: end };
}

function readSectionName(body: Uint8Array): string | null {
  return readName(body, 0)?.value ?? null;
}

/**
 * The `producers` section: a version, then one entry per tool group ("language",
 * "processed-by"), each holding a group name and a list of `tool -> version`
 * pairs. Rust emits `language / rustc 1.x.y` and `processed-by / wasm-opt`; a
 * build that carries nothing simply shows as such.
 */
function readProducers(body: Uint8Array): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  let offset = 0;
  // A custom section's payload begins with the section name itself; the
  // producers data starts after it.
  const sectionName = readName(body, offset);
  if (!sectionName) return out;
  offset = sectionName.next;
  // Skip the section's own version field.
  const version = readUint32(body, offset);
  if (!version) return out;
  offset = version.next;
  const fieldSections = readUint32(body, offset);
  if (!fieldSections) return out;
  offset = fieldSections.next;

  for (let section = 0; section < fieldSections.value; section += 1) {
    // Each group is a name ("processed-by") followed by how many tools it lists.
    const groupName = readName(body, offset);
    if (!groupName) return out;
    offset = groupName.next;
    const count = readUint32(body, offset);
    if (!count) break;
    offset = count.next;
    for (let item = 0; item < count.value; item += 1) {
      const name = readName(body, offset);
      if (!name) return out;
      offset = name.next;
      const value = readName(body, offset);
      if (!value) return out;
      offset = value.next;
      out.push({ name: name.value, value: value.value });
    }
  }
  return out;
}

/** Only a real embedded timestamp; a missing one is reported as missing. */
function findTimestamp(tools: ReadonlyArray<{ name: string; value: string }>): string | null {
  for (const tool of tools) {
    const match = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.exec(tool.value);
    if (match) return match[0];
  }
  return null;
}

function readExports(body: Uint8Array): WasmExport[] {
  const out: WasmExport[] = [];
  const count = readUint32(body, 0);
  if (!count) return out;
  let offset = count.next;
  for (let index = 0; index < count.value; index += 1) {
    const name = readName(body, offset);
    if (!name) return out;
    offset = name.next;
    const kind = body[offset];
    if (kind === undefined) return out;
    offset += 1;
    const target = readUint32(body, offset);
    if (!target) return out;
    offset = target.next;
    out.push({
      name: name.value,
      kind: EXPORT_KINDS[kind as keyof typeof EXPORT_KINDS] ?? "global",
      index: target.value,
    });
  }
  return out;
}

export type IntegrityVerdict = "verified" | "unrecognized" | "malformed";

export interface IntegrityReport {
  verdict: IntegrityVerdict;
  headline: string;
  detail: string;
  sha256: string | null;
  bytes: number;
  pinnedHash: string;
  pinnedBytes: number;
  /** The ledger's own declaration, kept beside the recomputed hash. */
  reportedWasmHash: string | null;
  entrypoints: string[];
  sections: WasmSection[];
  metadata: BuildMetadata | null;
}

/**
 * Hash the artifact and compare it to the pinned build.
 *
 * `reportedWasmHash` is what the ledger claims the code is; `sha256` is what
 * these bytes actually are. A verified badge requires the recomputed hash to
 * equal the pinned one, and the ledger's claim to agree — two independent
 * statements about the same artifact.
 */
export async function buildIntegrityReport(params: {
  wasm: Uint8Array;
  reportedWasmHash?: string | null;
  pinned?: { wasmHash: string; wasmBytes: number };
  digest?: (bytes: Uint8Array) => Promise<string>;
}): Promise<IntegrityReport> {
  const pinned = params.pinned ?? {
    wasmHash: PHASE1_ARTIFACT.wasmHash,
    wasmBytes: PHASE1_ARTIFACT.wasmBytes,
  };
  const digest = params.digest ?? sha256Hex;
  const inspection = inspectWasm(params.wasm);
  const bytes = params.wasm.length;

  if (!inspection.ok) {
    return {
      verdict: "malformed",
      headline: "UNRECOGNIZED BYTECODE",
      detail: `The fetched bytes are not a readable WASM module: ${inspection.reason}`,
      sha256: null,
      bytes,
      pinnedHash: pinned.wasmHash,
      pinnedBytes: pinned.wasmBytes,
      reportedWasmHash: params.reportedWasmHash ?? null,
      entrypoints: [],
      sections: [],
      metadata: null,
    };
  }

  const sha256 = await digest(params.wasm);
  const matchesPinned = sha256 === pinned.wasmHash;
  const ledgerAgrees =
    !params.reportedWasmHash || params.reportedWasmHash.toLowerCase() === sha256.toLowerCase();

  if (matchesPinned && ledgerAgrees) {
    return {
      verdict: "verified",
      headline: "VERIFIED BUILD",
      detail: `These bytes are the pinned Phase 1 artifact (${sha256.slice(0, 16)}…, ${bytes} bytes).`,
      sha256,
      bytes,
      pinnedHash: pinned.wasmHash,
      pinnedBytes: pinned.wasmBytes,
      reportedWasmHash: params.reportedWasmHash ?? null,
      entrypoints: inspection.entrypoints,
      sections: inspection.sections,
      metadata: inspection.metadata,
    };
  }

  const why = !matchesPinned
    ? `its hash is ${sha256.slice(0, 16)}…, not the pinned ${pinned.wasmHash.slice(0, 16)}…`
    : `the ledger declares ${params.reportedWasmHash?.slice(0, 16)}… for this contract`;
  return {
    verdict: "unrecognized",
    headline: "UNRECOGNIZED BYTECODE",
    detail: `This contract is not the pinned artifact: ${why} (${bytes} bytes, pinned build is ${pinned.wasmBytes}).`,
    sha256,
    bytes,
    pinnedHash: pinned.wasmHash,
    pinnedBytes: pinned.wasmBytes,
    reportedWasmHash: params.reportedWasmHash ?? null,
    entrypoints: inspection.entrypoints,
    sections: inspection.sections,
    metadata: inspection.metadata,
  };
}

/** The names worth showing first: the guard's own entrypoints, then the rest. */
const GUARD_ENTRYPOINTS = [
  "initialize",
  "set_policy",
  "check",
  "transfer",
  "transfer_from",
  "freeze",
  "status",
  "policy",
];

export function sortEntrypoints(entrypoints: readonly string[]): string[] {
  const known = GUARD_ENTRYPOINTS.filter((name) => entrypoints.includes(name));
  const rest = entrypoints.filter((name) => !known.includes(name)).sort();
  return [...known, ...rest];
}

/** One-line summary of the toolchain that claims to have built this. */
export function describeBuild(metadata: BuildMetadata | null): string {
  if (!metadata) return "No readable build metadata.";
  if (metadata.tools.length === 0 && metadata.compiledAt === null) {
    const sections =
      metadata.customSections.length > 0
        ? ` (custom sections: ${metadata.customSections.join(", ")})`
        : "";
    return `This build embeds no producer metadata${sections}.`;
  }
  const tools = metadata.tools.map((tool) => `${tool.name} ${tool.value}`.trim()).join(", ");
  const stamp = metadata.compiledAt ? `, built ${metadata.compiledAt}` : "";
  return `${tools || "no tool entries"}${stamp}`;
}

/**
 * Parse a WASM binary in a Web Worker with progress reporting and cancellation.
 *
 * Returns a promise that resolves with the inspection result, or rejects if
 * cancelled or an error occurs. The `onProgress` callback is invoked for each
 * progress phase reported by the worker.
 */
export function inspectWasmInWorker(
  bytes: Uint8Array,
  onProgress: (progress: WasmParseProgress) => void,
): Promise<WasmInspection> {
  return new Promise((resolve, reject) => {
    let worker: WasmParseWorker;
    try {
      // @ts-ignore - Next.js handles worker imports
      worker = new Worker(new URL("../worker/wasmParse.ts", import.meta.url), { type: "module" });
    } catch {
      // Fallback to inline parsing if workers are not supported
      // Report progress phases to match worker behavior
      onProgress({ phase: "validating-header" });
      onProgress({ phase: "parsing-sections", current: 1, total: 1 });
      onProgress({ phase: "reading-exports", count: 0 });
      const result = inspectWasm(bytes);
      if (result.ok) {
        onProgress({ phase: "complete", inspection: result });
        resolve(result);
      } else {
        onProgress({ phase: "error", reason: result.reason });
        reject(new Error(result.reason));
      }
      return;
    }

    worker.onmessage = (event: MessageEvent<{ type: "progress"; phase: WasmParseProgress }>) => {
      const { phase } = event.data;
      onProgress(phase);
      if (phase.phase === "complete" && phase.inspection) {
        worker.terminate();
        resolve(phase.inspection);
      } else if (phase.phase === "error") {
        worker.terminate();
        reject(new Error(phase.reason));
      } else if (phase.phase === "cancelled") {
        worker.terminate();
        reject(new Error("Parsing cancelled"));
      }
    };

    worker.onerror = (error) => {
      worker.terminate();
      reject(new Error(`Worker error: ${error.message}`));
    };

    // Post the bytes to the worker (transfer ownership for efficiency)
    worker.postMessage(
      {
        type: "parse",
        bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      },
      [bytes.buffer],
    );

    // Return a cancellation function
    return () => {
      worker.postMessage({ type: "cancel" });
    };
  });
}

/**
 * Compute SHA-256 hash of a WASM binary in a Web Worker with progress reporting and cancellation.
 *
 * Returns a promise that resolves with the hex hash string, or rejects if
 * cancelled or an error occurs. The `onProgress` callback is invoked for each
 * progress phase reported by the worker.
 */
export function hashWasmInWorker(
  bytes: Uint8Array,
  onProgress: (progress: WasmHashProgress) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let worker: WasmHashWorker;
    try {
      // @ts-ignore - Next.js handles worker imports
      worker = new Worker(new URL("../worker/wasmHash.ts", import.meta.url), { type: "module" });
    } catch {
      // Fallback to inline hashing if workers are not supported
      onProgress({ phase: "hashing", bytesProcessed: 0, totalBytes: bytes.length });
      sha256Hex(bytes)
        .then((hash) => {
          onProgress({ phase: "complete", hash });
          resolve(hash);
        })
        .catch((error) => {
          onProgress({ phase: "error", reason: error.message });
          reject(error);
        });
      return;
    }

    worker.onmessage = (event: MessageEvent<{ type: "progress"; phase: WasmHashProgress }>) => {
      const { phase } = event.data;
      onProgress(phase);
      if (phase.phase === "complete" && phase.hash) {
        worker.terminate();
        resolve(phase.hash);
      } else if (phase.phase === "error") {
        worker.terminate();
        reject(new Error(phase.reason));
      } else if (phase.phase === "cancelled") {
        worker.terminate();
        reject(new Error("Hashing cancelled"));
      }
    };

    worker.onerror = (error) => {
      worker.terminate();
      reject(new Error(`Worker error: ${error.message}`));
    };

    // Post the bytes to the worker (transfer ownership for efficiency)
    worker.postMessage(
      {
        type: "hash",
        bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      },
      [bytes.buffer],
    );

    // Return a cancellation function
    return () => {
      worker.postMessage({ type: "cancel" });
    };
  });
}

/**
 * Build an integrity report using worker-based parsing and hashing with progress reporting.
 *
 * This is the main entry point for the UI: it fetches the bytecode, then runs
 * both parsing and hashing in workers with progress callbacks, allowing the
 * operator to see coarse progress and cancel if needed.
 */
export async function buildIntegrityReportWithProgress(params: {
  wasm: Uint8Array;
  reportedWasmHash?: string | null;
  pinned?: { wasmHash: string; wasmBytes: number };
  onParseProgress?: (progress: WasmParseProgress) => void;
  onHashProgress?: (progress: WasmHashProgress) => void;
}): Promise<IntegrityReport> {
  const pinned = params.pinned ?? {
    wasmHash: PHASE1_ARTIFACT.wasmHash,
    wasmBytes: PHASE1_ARTIFACT.wasmBytes,
  };
  const bytes = params.wasm.length;

  // Run parsing and hashing in parallel
  const [inspection, sha256] = await Promise.all([
    inspectWasmInWorker(params.wasm, params.onParseProgress ?? (() => {})),
    hashWasmInWorker(params.wasm, params.onHashProgress ?? (() => {})),
  ]);

  if (!inspection.ok) {
    return {
      verdict: "malformed",
      headline: "UNRECOGNIZED BYTECODE",
      detail: `The fetched bytes are not a readable WASM module: ${inspection.reason}`,
      sha256: null,
      bytes,
      pinnedHash: pinned.wasmHash,
      pinnedBytes: pinned.wasmBytes,
      reportedWasmHash: params.reportedWasmHash ?? null,
      entrypoints: [],
      sections: [],
      metadata: null,
    };
  }

  const matchesPinned = sha256 === pinned.wasmHash;
  const ledgerAgrees =
    !params.reportedWasmHash || params.reportedWasmHash.toLowerCase() === sha256.toLowerCase();

  if (matchesPinned && ledgerAgrees) {
    return {
      verdict: "verified",
      headline: "VERIFIED BUILD",
      detail: `These bytes are the pinned Phase 1 artifact (${sha256.slice(0, 16)}…, ${bytes} bytes).`,
      sha256,
      bytes,
      pinnedHash: pinned.wasmHash,
      pinnedBytes: pinned.wasmBytes,
      reportedWasmHash: params.reportedWasmHash ?? null,
      entrypoints: inspection.entrypoints,
      sections: inspection.sections,
      metadata: inspection.metadata,
    };
  }

  const why = !matchesPinned
    ? `its hash is ${sha256.slice(0, 16)}…, not the pinned ${pinned.wasmHash.slice(0, 16)}…`
    : `the ledger declares ${params.reportedWasmHash?.slice(0, 16)}… for this contract`;
  return {
    verdict: "unrecognized",
    headline: "UNRECOGNIZED BYTECODE",
    detail: `This contract is not the pinned artifact: ${why} (${bytes} bytes, pinned build is ${pinned.wasmBytes}).`,
    sha256,
    bytes,
    pinnedHash: pinned.wasmHash,
    pinnedBytes: pinned.wasmBytes,
    reportedWasmHash: params.reportedWasmHash ?? null,
    entrypoints: inspection.entrypoints,
    sections: inspection.sections,
    metadata: inspection.metadata,
  };
}
