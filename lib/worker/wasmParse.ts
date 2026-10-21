/**
 * WASM parsing worker with progress reporting and cancellation support.
 *
 * This worker runs the full WASM inspection (section table, exports, producers
 * metadata) off the main thread, reporting coarse progress phases so the UI
 * can show that work is happening without exposing partial parse results.
 * Cancellation terminates the parse loop cleanly without leaving a worker
 * running.
 */

import type {
  WasmInspection,
  WasmSection,
  WasmExport,
  BuildMetadata,
} from "../guard/wasmInspector.ts";

const MAGIC = [0x00, 0x61, 0x73, 0x6d] as const;
const CUSTOM_SECTION = 0;
const EXPORT_SECTION = 7;

const EXPORT_KINDS = {
  0: "function",
  1: "table",
  2: "memory",
  3: "global",
} as const;

type ProgressPhase =
  | { phase: "validating-header" }
  | { phase: "parsing-sections"; current: number; total: number }
  | { phase: "reading-exports"; count: number }
  | { phase: "reading-producers"; section: string }
  | { phase: "complete"; inspection: WasmInspection }
  | { phase: "error"; reason: string }
  | { phase: "cancelled" };

type WorkerMessage = { type: "parse"; bytes: ArrayBuffer } | { type: "cancel" };

function postProgress(phase: ProgressPhase) {
  self.postMessage({ type: "progress", phase });
}

function readUint32(bytes: Uint8Array, at: number): { value: number; next: number } | null {
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

function readProducers(body: Uint8Array): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  let offset = 0;
  const sectionName = readName(body, offset);
  if (!sectionName) return out;
  offset = sectionName.next;
  const version = readUint32(body, offset);
  if (!version) return out;
  offset = version.next;
  const fieldSections = readUint32(body, offset);
  if (!fieldSections) return out;
  offset = fieldSections.next;

  for (let section = 0; section < fieldSections.value; section += 1) {
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

let cancelled = false;

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  if (event.data.type === "cancel") {
    cancelled = true;
    return;
  }

  if (event.data.type === "parse") {
    cancelled = false;
    const bytes = new Uint8Array(event.data.bytes);

    // Phase 1: Validate header
    postProgress({ phase: "validating-header" });
    if (cancelled) {
      postProgress({ phase: "cancelled" });
      return;
    }

    if (bytes.length < 8) {
      postProgress({
        phase: "error",
        reason: `too short to be a WASM module (${bytes.length} bytes)`,
      });
      return;
    }
    for (const [index, expected] of MAGIC.entries()) {
      if (bytes[index] !== expected) {
        postProgress({
          phase: "error",
          reason: "missing the \\0asm magic: this is not a WASM module",
        });
        return;
      }
    }
    const version = readUint32(bytes, 4);
    if (!version) {
      postProgress({ phase: "error", reason: "truncated WASM header" });
      return;
    }

    // Phase 2: Parse sections
    const sections: WasmSection[] = [];
    const exports: WasmExport[] = [];
    const tools: Array<{ name: string; value: string }> = [];
    const customSections: string[] = [];
    let offset = 8;
    let truncated = false;

    // First pass: count sections to report total
    let tempOffset = 8;
    let sectionCount = 0;
    while (tempOffset < bytes.length && !cancelled) {
      const id = bytes[tempOffset];
      if (id === undefined) break;
      tempOffset += 1;
      const size = readUint32(bytes, tempOffset);
      if (!size) break;
      tempOffset = size.next;
      const end = tempOffset + size.value;
      if (end > bytes.length) break;
      tempOffset = end;
      sectionCount += 1;
    }

    let currentSection = 0;
    while (offset < bytes.length && !cancelled) {
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

      postProgress({ phase: "parsing-sections", current: ++currentSection, total: sectionCount });

      if (id === CUSTOM_SECTION && name) {
        customSections.push(name);
        if (name === "producers" || name === "wasmparser-process-info") {
          postProgress({ phase: "reading-producers", section: name });
          tools.push(...readProducers(body));
        }
      }
      if (id === EXPORT_SECTION) {
        exports.push(...readExports(body));
        postProgress({ phase: "reading-exports", count: exports.length });
      }
      offset = end;
    }

    if (cancelled) {
      postProgress({ phase: "cancelled" });
      return;
    }

    if (truncated) {
      postProgress({ phase: "error", reason: "a section runs past the end of the buffer" });
      return;
    }

    const entrypoints = exports.filter((item) => item.kind === "function").map((item) => item.name);
    const inspection: WasmInspection = {
      ok: true,
      version: version.value,
      sections,
      exports,
      entrypoints,
      metadata: { tools, compiledAt: findTimestamp(tools), customSections },
    };

    postProgress({ phase: "complete", inspection });
  }
};

export {};
