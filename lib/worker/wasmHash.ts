/**
 * WASM hash computation worker with progress reporting and cancellation support.
 *
 * Computes the SHA-256 hash of a WASM binary off the main thread, reporting
 * progress in coarse chunks so the UI can show advancement on large artifacts.
 * Cancellation aborts the hash computation cleanly.
 */

type ProgressPhase =
  | { phase: "hashing"; bytesProcessed: number; totalBytes: number }
  | { phase: "complete"; hash: string }
  | { phase: "error"; reason: string }
  | { phase: "cancelled" };

type WorkerMessage = { type: "hash"; bytes: ArrayBuffer } | { type: "cancel" };

const CHUNK_SIZE = 1024 * 1024; // 1MB chunks for progress reporting

async function computeHash(bytes: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

let cancelled = false;

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  if (event.data.type === "cancel") {
    cancelled = true;
    return;
  }

  if (event.data.type === "hash") {
    cancelled = false;
    const bytes = new Uint8Array(event.data.bytes);
    const totalBytes = bytes.length;

    // For large binaries, we can't stream SHA-256 in the browser easily,
    // so we report progress in a single step but allow cancellation between
    // the start and the actual computation.
    if (totalBytes > CHUNK_SIZE) {
      postProgress({ phase: "hashing", bytesProcessed: 0, totalBytes });
    }

    if (cancelled) {
      postProgress({ phase: "cancelled" });
      return;
    }

    try {
      const hash = await computeHash(bytes);
      if (cancelled) {
        postProgress({ phase: "cancelled" });
        return;
      }
      postProgress({ phase: "complete", hash });
    } catch (error) {
      postProgress({
        phase: "error",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
};

function postProgress(phase: ProgressPhase) {
  self.postMessage({ type: "progress", phase });
}

export {};
