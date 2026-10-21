/*
 * Stellar Agent Guard — service worker.
 *
 * The dashboard is a pure client-side console whose every number comes from a
 * live Soroban RPC read. Caching is therefore only ever applied to the *static
 * shell* (documents, scripts, styles, fonts, icons) so a phone can open the
 * console instantly or after a local network drop. Nothing that carries chain
 * state is ever stored:
 *
 *   - `/soroban/rpc` and any Horizon endpoint are hard-bypassed below. The fetch
 *     handler returns without calling `respondWith`, which hands the request
 *     straight to the browser's own network path — no cache read, no cache write,
 *     and no chance of a stale policy, freeze flag or balance being rendered as
 *     if it were live.
 *
 * A stale shell is recoverable — reloading fetches it again. A stale freeze flag
 * is not: during an incident the console must show what the chain says now.
 *
 * Updates never replace a running app on their own. This worker deliberately
 * does not call `skipWaiting()` while installing: a new shell that activated
 * itself could discard a policy draft or interrupt a wallet approval. It waits,
 * the page shows a non-blocking notice, and only the page's explicit request
 * (the `GUARD_SKIP_WAITING` message below) promotes it. See `lib/guard/pwa.ts`.
 */

/** Must equal `SERVICE_WORKER_SKIP_WAITING_MESSAGE` in `lib/guard/pwa.ts`. */
const SKIP_WAITING_MESSAGE = "GUARD_SKIP_WAITING";

// Versioned so activation of a new shell drops the previous one's cached assets
// instead of mixing two builds in one cache.
const CACHE_NAME = "stellar-agent-guard-static-v3";
const OFFLINE_URL = "/offline.html";

/*
 * Set on any response the worker answered from its cache (issue #348).
 *
 * A cached shell is indistinguishable from a live one by looking at it, which
 * is exactly the confusion the console must avoid: the page can read this
 * header on a navigation or asset response and say that it is showing cached
 * interface, not current chain state. Chain reads never pass through here, so
 * they never carry the marker.
 */
const CACHED_SHELL_HEADER = "X-Guard-Shell";

/** Everything the shell needs to render without the network. */
const PRECACHE_URLS = [
  "/",
  OFFLINE_URL,
  "/manifest.json",
  "/icons/icon.svg",
  "/icons/icon-maskable.svg",
];

/*
 * Chain endpoints are matched on host *and* path, because the RPC can be reached
 * as either `https://soroban-testnet.stellar.org` or a path on a gateway
 * (`/soroban/rpc`), and Horizon is always a `horizon*.stellar.org` host.
 */
const NETWORK_ONLY_HOST_MARKERS = ["soroban", "horizon"];
const NETWORK_ONLY_PATH_MARKERS = ["/soroban/rpc", "/rpc", "/horizon"];

/**
 * True for any request that must go to the network, uncached, every time.
 * Unknown or unparsable URLs return true: bypassing is always the safe default.
 */
function isNetworkOnlyRequest(url) {
  let parsed;
  try {
    parsed = new URL(url, self.location.origin);
  } catch {
    return true;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  if (NETWORK_ONLY_HOST_MARKERS.some((marker) => host.includes(marker))) return true;
  if (NETWORK_ONLY_PATH_MARKERS.some((marker) => path.includes(marker))) return true;
  return false;
}

function isSameOrigin(url) {
  try {
    return new URL(url, self.location.origin).origin === self.location.origin;
  } catch {
    return false;
  }
}

/** Only a successful, non-opaque response is worth storing. */
function isCacheable(response) {
  return Boolean(response) && response.status === 200 && (response.type === "basic" || response.type === "default");
}

/**
 * A cached response, tagged so the page knows it did not come from the network.
 *
 * `Response` headers are immutable, so the body is re-wrapped with a fresh
 * header set; the status and body are the cached ones, unchanged.
 */
function markCached(response) {
  if (!response) return response;
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  headers[CACHED_SHELL_HEADER] = "cached";
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(PRECACHE_URLS);
      // No `skipWaiting()` here on purpose: the new worker stays in `waiting`
      // until a page asks for it, so the operator decides when to reload.
    })(),
  );
});

/*
 * The one way an update takes over.
 *
 * The page posts this only after an explicit reload action, and after warning
 * the operator if a draft or a pending write would be discarded. A message from
 * anywhere else is ignored, and nothing about a transaction is persisted or
 * replayed by activation: this worker only ever serves the static shell.
 */
self.addEventListener("message", (event) => {
  if (!event.data || event.data.type !== SKIP_WAITING_MESSAGE) return;
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Writes are never cached and never served from a cache.
  if (request.method !== "GET") return;

  // ── The hard bypass: chain reads go straight to the network ──────────────
  if (isNetworkOnlyRequest(request.url)) return;

  // Document navigations: fresh when online, cached shell when not.
  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(event, request));
    return;
  }

  // Static same-origin assets: cache-first with a background refresh.
  if (isSameOrigin(request.url)) {
    event.respondWith(handleStatic(event, request));
  }
});

async function handleStatic(event, request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const refresh = fetch(request)
    .then(async (response) => {
      if (isCacheable(response)) await cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  if (cached) {
    // Serve the cached copy now and let the refresh settle in the background.
    // The tag lets the page say the asset is stale rather than current.
    event.waitUntil(refresh);
    return markCached(cached);
  }
  const fresh = await refresh;
  return fresh || Response.error();
}

async function handleNavigation(event, request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (isCacheable(response)) await cache.put(request, response.clone());
    return response;
  } catch {
    const cached =
      (await cache.match(request)) ||
      (await cache.match("/")) ||
      (await cache.match(OFFLINE_URL));
    // An offline navigation is served the cached shell, tagged so the page can
    // announce that it is offline interface rather than live chain state.
    return cached ? markCached(cached) : Response.error();
  }
}
