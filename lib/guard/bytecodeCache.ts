export interface CacheEntry {
  hash: string;
  /** Size of the verified WASM, so a cache hit can still report it. */
  byteLength: number;
  expiresAt: number;
}

export const BYTECODE_CACHE_STORAGE_KEY = "stellar_bytecode_hash_cache";
const MAX_ENTRIES = 50;
const TTL_MS = 60 * 60 * 1000;

const memoryStore: Record<string, CacheEntry> = {};

function getStore(): Record<string, CacheEntry> {
  if (typeof sessionStorage === "undefined") return memoryStore;
  try {
    const raw = sessionStorage.getItem(BYTECODE_CACHE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function setStore(store: Record<string, CacheEntry>) {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(BYTECODE_CACHE_STORAGE_KEY, JSON.stringify(store));
  } catch {}
}

function cacheKey(networkPassphrase: string, contractId: string): string {
  return `${networkPassphrase}:${contractId}`;
}

/** Return a live entry, dropping it first if its TTL has elapsed. */
function liveEntry(store: Record<string, CacheEntry>, key: string): CacheEntry | null {
  const entry = store[key];
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    delete store[key];
    setStore(store);
    return null;
  }
  return entry;
}

export function getCachedHash(networkPassphrase: string, contractId: string): string | null {
  const store = getStore();
  const key = cacheKey(networkPassphrase, contractId);
  const entry = liveEntry(store, key);
  if (!entry) return null;

  // Re-insert so the entry becomes the most-recently used one.
  delete store[key];
  store[key] = entry;
  setStore(store);

  return entry.hash;
}

/**
 * The verified bytecode size for a cached entry. `verifyWasmIdentity` returns
 * the byte count alongside the hash, so it has to survive a cache hit too.
 */
export function getCachedByteLength(networkPassphrase: string, contractId: string): number | null {
  const store = getStore();
  const entry = liveEntry(store, cacheKey(networkPassphrase, contractId));
  return entry ? entry.byteLength : null;
}

export function setCachedHash(
  networkPassphrase: string,
  contractId: string,
  hash: string,
  byteLength = 0,
): void {
  const store = getStore();
  const key = cacheKey(networkPassphrase, contractId);

  const keys = Object.keys(store);
  if (keys.length >= MAX_ENTRIES && !store[key]) {
    delete store[keys[0] as string];
  }

  if (store[key]) {
    delete store[key];
  }

  store[key] = {
    hash,
    byteLength,
    expiresAt: Date.now() + TTL_MS,
  };

  setStore(store);
}

export function invalidateCachedHash(networkPassphrase: string, contractId: string): void {
  const store = getStore();
  const key = cacheKey(networkPassphrase, contractId);
  if (store[key]) {
    delete store[key];
    setStore(store);
  }
}
