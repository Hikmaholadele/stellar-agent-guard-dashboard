import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";
import {
  IDLE_PWA_ACTIVITY,
  PWA_MANIFEST_PATH,
  PWA_OFFLINE_PATH,
  PWA_THEME_COLOR,
  PWA_UPDATE_AVAILABLE_TITLE,
  SERVICE_WORKER_PATH,
  SERVICE_WORKER_SKIP_WAITING_MESSAGE,
  evaluatePwaUpdate,
  pwaActivitySnapshot,
  registerPwaActivity,
  subscribePwaActivity,
} from "../../lib/guard/pwa.ts";
import {
  OFFLINE_SHELL_TITLE,
  WRITES_UNAVAILABLE_TITLE,
  evaluateOffline,
  onlineSnapshot,
  setOnlineForTest,
  subscribeOnline,
} from "../../lib/guard/online.ts";

interface ManifestIcon {
  src: string;
  type: string;
  sizes: string;
  purpose?: string;
}

interface WebAppManifest {
  id: string;
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: ManifestIcon[];
}

const manifest = JSON.parse(readFileSync("public/manifest.json", "utf8")) as WebAppManifest;

describe("web app manifest", () => {
  it("is served from the path the application and its metadata agree on", () => {
    assert.equal(PWA_MANIFEST_PATH, "/manifest.json");
    assert.equal(existsSync(`public${PWA_MANIFEST_PATH}`), true);
    assert.equal(existsSync(`public${SERVICE_WORKER_PATH}`), true);
  });

  it("declares the installed app's identity", () => {
    assert.match(manifest.name, /stellar agent guard/i);
    assert.ok(manifest.short_name.length > 0 && manifest.short_name.length <= 12);
    assert.ok(manifest.description.length > 0);
    assert.equal(manifest.start_url, "/");
    assert.equal(manifest.scope, "/");
    assert.equal(manifest.id, "/");
    assert.equal(manifest.display, "standalone");
  });

  it("uses the console's own dark palette for the browser chrome", () => {
    assert.equal(manifest.theme_color, PWA_THEME_COLOR);
    assert.equal(manifest.background_color, PWA_THEME_COLOR);
    // The manifest colours must not drift from the stylesheet's page background.
    const css = readFileSync("app/globals.css", "utf8");
    assert.match(
      css,
      new RegExp(`--bg:\\s*${PWA_THEME_COLOR}`, "i"),
      "manifest theme colour must match the console's --bg token",
    );
  });

  it("ships a regular and a maskable icon, and both files exist", () => {
    assert.ok(
      manifest.icons.length >= 2,
      "an installed app needs at least a regular and a maskable icon",
    );
    const purposes = manifest.icons.map((icon) => icon.purpose ?? "any");
    assert.ok(purposes.includes("any"), "a purpose=any icon is required");
    assert.ok(purposes.includes("maskable"), "a purpose=maskable icon is required");

    for (const icon of manifest.icons) {
      assert.match(icon.src, /^\//, `${icon.src} must be an absolute public path`);
      assert.equal(icon.type, "image/svg+xml");
      // `sizes: any` is the correct declaration for a resolution-independent SVG.
      assert.equal(icon.sizes, "any");
      assert.equal(existsSync(`public${icon.src}`), true, `${icon.src} must exist under public/`);
    }
  });
});

// ── Service worker ─────────────────────────────────────────────────────────

const ORIGIN = "https://dashboard.test";

interface FetchRequestLike {
  url: string;
  method: string;
  mode: string;
}

interface ServiceWorkerEvent {
  request?: FetchRequestLike;
  data?: unknown;
  respondWith?(value: Promise<Response>): void;
  waitUntil?(value: Promise<unknown>): void;
}

type SwListener = (event: ServiceWorkerEvent) => void;

interface FetchOutcome {
  respondWithCalled: boolean;
  response: Response | undefined;
}

/**
 * Runs `public/sw.js` in a sandbox with just enough of the worker global scope
 * to observe what it does: the `caches` and `fetch` calls it makes, and whether
 * it took ownership of a request by calling `respondWith`.
 *
 * Testing the real file (rather than a copy of its rules) is what makes the
 * bypass assertions meaningful — a stale-worker regression has to fail here.
 */
function createServiceWorkerHarness() {
  const listeners: Record<string, SwListener[]> = {
    install: [],
    activate: [],
    fetch: [],
    message: [],
  };
  const storage = new Map<string, Response>();
  const putUrls: string[] = [];
  const matchUrls: string[] = [];
  const precached: string[] = [];
  const fetchedUrls: string[] = [];
  const openedCaches = new Set<string>();
  const deletedCaches: string[] = [];
  let networkDown = false;
  // Update-lifecycle observations: a new shell must not promote itself.
  let skipWaitingCalls = 0;
  let claimCalls = 0;

  const absolute = (input: string): string => {
    try {
      return new URL(input, ORIGIN).href;
    } catch {
      return input;
    }
  };

  const keyOf = (input: unknown): string => {
    if (typeof input === "string") return absolute(input);
    if (typeof input === "object" && input !== null && "url" in input) {
      return String((input as { url: unknown }).url);
    }
    return String(input);
  };

  const cache = {
    async addAll(urls: string[]): Promise<void> {
      for (const url of urls) {
        precached.push(url);
        storage.set(absolute(url), new Response("precached", { status: 200 }));
      }
    },
    async match(request: unknown): Promise<Response | undefined> {
      matchUrls.push(keyOf(request));
      return storage.get(keyOf(request));
    },
    async put(request: unknown, response: Response): Promise<void> {
      putUrls.push(keyOf(request));
      storage.set(keyOf(request), response);
    },
  };

  const caches = {
    async open(name: string): Promise<typeof cache> {
      openedCaches.add(name);
      return cache;
    },
    async keys(): Promise<string[]> {
      return [...openedCaches];
    },
    async delete(name: string): Promise<boolean> {
      deletedCaches.push(name);
      openedCaches.delete(name);
      return true;
    },
  };

  const fakeFetch = async (request: unknown): Promise<Response> => {
    fetchedUrls.push(keyOf(request));
    if (networkDown) throw new Error("offline");
    return new Response("network", { status: 200 });
  };

  const self = {
    location: { origin: ORIGIN },
    addEventListener(type: string, listener: SwListener): void {
      (listeners[type] ??= []).push(listener);
    },
    async skipWaiting(): Promise<void> {
      skipWaitingCalls += 1;
    },
    clients: {
      async claim(): Promise<void> {
        claimCalls += 1;
      },
    },
  };

  new vm.Script(readFileSync("public/sw.js", "utf8"), { filename: "public/sw.js" }).runInNewContext(
    {
      self,
      caches,
      fetch: fakeFetch,
      Response,
      URL,
      console,
    },
  );

  async function install(): Promise<void> {
    const pending: Promise<unknown>[] = [];
    const event: ServiceWorkerEvent = {
      waitUntil(value) {
        pending.push(Promise.resolve(value));
      },
    };
    for (const listener of listeners.install ?? []) listener(event);
    await Promise.all(pending);
  }

  async function activate(): Promise<void> {
    const pending: Promise<unknown>[] = [];
    const event: ServiceWorkerEvent = {
      waitUntil(value) {
        pending.push(Promise.resolve(value));
      },
    };
    for (const listener of listeners.activate ?? []) listener(event);
    await Promise.all(pending);
  }

  /** Deliver a `postMessage` from a page to the worker. */
  async function dispatchMessage(data: unknown): Promise<void> {
    const pending: Promise<unknown>[] = [];
    const event: ServiceWorkerEvent = {
      data,
      waitUntil(value) {
        pending.push(Promise.resolve(value));
      },
    };
    for (const listener of listeners.message ?? []) listener(event);
    await Promise.all(pending);
  }

  /** Pretend a previous shell version left its cache behind. */
  function seedCache(name: string): void {
    openedCaches.add(name);
  }

  async function dispatchFetch(
    url: string,
    options: { mode?: string; method?: string } = {},
  ): Promise<FetchOutcome> {
    const request: FetchRequestLike = {
      url: absolute(url),
      method: options.method ?? "GET",
      mode: options.mode ?? "no-cors",
    };
    let respondWithCalled = false;
    let responsePromise: Promise<Response> | undefined;
    const pending: Promise<unknown>[] = [];
    const event: ServiceWorkerEvent = {
      request,
      respondWith(value) {
        respondWithCalled = true;
        responsePromise = value;
      },
      waitUntil(value) {
        pending.push(Promise.resolve(value));
      },
    };
    for (const listener of listeners.fetch ?? []) listener(event);
    const response = responsePromise ? await responsePromise : undefined;
    // Let any background revalidation the worker scheduled settle too.
    await Promise.allSettled(pending);
    return { respondWithCalled, response };
  }

  return {
    precached,
    putUrls,
    matchUrls,
    fetchedUrls,
    deletedCaches,
    install,
    activate,
    dispatchMessage,
    dispatchFetch,
    seedCache,
    skipWaitingCalls(): number {
      return skipWaitingCalls;
    },
    claimCalls(): number {
      return claimCalls;
    },
    setNetworkDown(down: boolean): void {
      networkDown = down;
    },
    resetCounters(): void {
      putUrls.length = 0;
      matchUrls.length = 0;
      fetchedUrls.length = 0;
    },
  };
}

/** The endpoints that must never be served from, or written to, a cache. */
const NETWORK_ONLY_URLS = [
  "https://soroban-testnet.stellar.org/soroban/rpc",
  "https://soroban-testnet.stellar.org/",
  `${ORIGIN}/soroban/rpc`,
  "https://horizon-testnet.stellar.org/accounts/GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWH",
  `${ORIGIN}/horizon/accounts/GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWH`,
];

describe("service worker cache-bypassing rules", () => {
  it("precaches the static shell on install, including the offline document", async () => {
    const sw = createServiceWorkerHarness();
    await sw.install();
    assert.ok(sw.precached.includes("/"));
    assert.ok(sw.precached.includes(PWA_MANIFEST_PATH));
    assert.ok(sw.precached.includes(PWA_OFFLINE_PATH));
    assert.ok(sw.precached.includes("/icons/icon.svg"));
    assert.ok(sw.precached.includes("/icons/icon-maskable.svg"));
  });

  it("hard-bypasses every Soroban RPC and Horizon request", async () => {
    const sw = createServiceWorkerHarness();
    await sw.install();
    for (const url of NETWORK_ONLY_URLS) {
      sw.resetCounters();
      const outcome = await sw.dispatchFetch(url, { mode: "cors" });
      assert.equal(
        outcome.respondWithCalled,
        false,
        `${url} must bypass the worker so the browser's own network path handles it`,
      );
      assert.deepEqual(sw.putUrls, [], `${url} must never be written to a cache`);
      assert.deepEqual(sw.matchUrls, [], `${url} must never be read from a cache`);
      assert.deepEqual(sw.fetchedUrls, [], `${url} must not even be proxied through the worker`);
    }
  });

  it("caches same-origin static assets", async () => {
    const sw = createServiceWorkerHarness();
    await sw.install();
    sw.resetCounters();

    const outcome = await sw.dispatchFetch("/icons/icon.svg");
    assert.equal(outcome.respondWithCalled, true, "static assets are served by the worker");
    assert.equal(outcome.response?.status, 200);
    assert.deepEqual(
      sw.putUrls,
      [`${ORIGIN}/icons/icon.svg`],
      "the asset is written to the static cache",
    );
  });

  it("serves a navigation from the network, and the cached shell when the network is gone", async () => {
    const sw = createServiceWorkerHarness();
    await sw.install();

    sw.resetCounters();
    const online = await sw.dispatchFetch("/", { mode: "navigate" });
    assert.equal(online.respondWithCalled, true);
    assert.equal(online.response?.status, 200);
    assert.deepEqual(sw.fetchedUrls, [`${ORIGIN}/`]);

    sw.setNetworkDown(true);
    const offline = await sw.dispatchFetch("/configure", { mode: "navigate" });
    assert.equal(offline.respondWithCalled, true, "an offline navigation still gets a response");
    assert.equal(offline.response?.status, 200, "the precached shell answers it");
  });

  it("never takes over a write, and never caches one", async () => {
    const sw = createServiceWorkerHarness();
    await sw.install();
    sw.resetCounters();

    const outcome = await sw.dispatchFetch("/", { method: "POST", mode: "cors" });
    assert.equal(outcome.respondWithCalled, false);
    assert.deepEqual(sw.putUrls, []);
    assert.deepEqual(sw.fetchedUrls, []);
  });

  it("returns a network error rather than throwing when offline with an empty cache", async () => {
    const sw = createServiceWorkerHarness();
    sw.setNetworkDown(true);

    const outcome = await sw.dispatchFetch("/configure", { mode: "navigate" });
    assert.equal(outcome.respondWithCalled, true);
    assert.equal(outcome.response?.status, 0, "a `Response.error()` is the graceful empty answer");
  });
});

// ── Wiring ─────────────────────────────────────────────────────────────────

describe("PWA wiring", () => {
  it("points the document at the manifest, tints the chrome, and mounts the registrar", () => {
    const layout = readFileSync("app/layout.tsx", "utf8");
    assert.match(layout, /manifest:\s*PWA_MANIFEST_PATH/);
    assert.match(layout, /themeColor:\s*PWA_THEME_COLOR/);
    assert.match(layout, /<PwaRegistrar\s*\/>/);
  });

  it("registers the service worker from the canonical path", () => {
    const registrar = readFileSync("components/PwaRegistrar.tsx", "utf8");
    assert.match(registrar, /navigator\.serviceWorker[\s\S]*?\.register\(SERVICE_WORKER_PATH\)/);
  });

  it("serves the worker and manifest with the types and revalidation they need", () => {
    const config = readFileSync("next.config.ts", "utf8");
    assert.match(config, /source:\s*"\/sw\.js"/);
    assert.match(config, /Service-Worker-Allowed/);
    assert.match(config, /application\/manifest\+json/);
  });

  it("agrees with the worker on the message that promotes an update", () => {
    const worker = readFileSync("public/sw.js", "utf8");
    assert.match(worker, /addEventListener\("message"/);
    assert.ok(
      worker.includes(`"${SERVICE_WORKER_SKIP_WAITING_MESSAGE}"`),
      "sw.js must compare against the shared message literal",
    );
    // The worker must not promote itself on install: the page owns that choice.
    const installHandler = worker.slice(
      worker.indexOf('addEventListener("install"'),
      worker.indexOf('addEventListener("message"'),
    );
    assert.ok(installHandler.length > 0, "the install handler must exist");
    assert.doesNotMatch(
      installHandler,
      /self\.skipWaiting\(/,
      "install must not call skipWaiting, or an update replaces the app unasked",
    );

    const registrar = readFileSync("components/PwaRegistrar.tsx", "utf8");
    assert.match(registrar, /registration\.waiting/);
    assert.match(registrar, /controllerchange/);
    assert.match(registrar, /postMessage\(\{\s*type:\s*SERVICE_WORKER_SKIP_WAITING_MESSAGE\s*\}\)/);
  });
});

// ── Deferred updates (#398, #399) ──────────────────────────────────────────

describe("service worker update lifecycle", () => {
  it("leaves a new shell waiting on install instead of taking over", async () => {
    const sw = createServiceWorkerHarness();
    await sw.install();

    assert.ok(sw.precached.includes("/"), "the shell is still precached");
    assert.equal(sw.skipWaitingCalls(), 0, "install must not promote itself");
    assert.equal(sw.claimCalls(), 0, "nothing is claimed until activation is asked for");
  });

  it("promotes the waiting worker only for the explicit message, then claims once", async () => {
    const sw = createServiceWorkerHarness();
    sw.seedCache("stellar-agent-guard-static-v0");
    await sw.install();

    await sw.dispatchMessage({ type: "UNRELATED" });
    await sw.dispatchMessage(undefined);
    assert.equal(sw.skipWaitingCalls(), 0, "an unrelated message cannot activate an update");

    await sw.dispatchMessage({ type: SERVICE_WORKER_SKIP_WAITING_MESSAGE });
    assert.equal(sw.skipWaitingCalls(), 1);

    await sw.activate();
    assert.equal(sw.claimCalls(), 1);
    assert.deepEqual(
      sw.deletedCaches,
      ["stellar-agent-guard-static-v0"],
      "the superseded shell cache is removed on activation",
    );
  });

  it("does not replay or intercept a pending write after activation", async () => {
    const sw = createServiceWorkerHarness();
    await sw.install();
    await sw.dispatchMessage({ type: SERVICE_WORKER_SKIP_WAITING_MESSAGE });
    await sw.activate();
    sw.resetCounters();

    const outcome = await sw.dispatchFetch("/", { method: "POST", mode: "cors" });
    assert.equal(outcome.respondWithCalled, false);
    assert.deepEqual(sw.putUrls, [], "a write is never cached, before or after an update");
    assert.deepEqual(sw.fetchedUrls, [], "the worker does not replay a write");
  });

  it("keeps chain reads network-only after activation", async () => {
    const sw = createServiceWorkerHarness();
    await sw.install();
    await sw.dispatchMessage({ type: SERVICE_WORKER_SKIP_WAITING_MESSAGE });
    await sw.activate();

    for (const url of NETWORK_ONLY_URLS) {
      sw.resetCounters();
      const outcome = await sw.dispatchFetch(url, { mode: "cors" });
      assert.equal(outcome.respondWithCalled, false, `${url} must stay uncached after an update`);
      assert.deepEqual(sw.matchUrls, []);
      assert.deepEqual(sw.putUrls, []);
      assert.deepEqual(sw.fetchedUrls, []);
    }
  });

  it("shows no notice when no update is waiting", async () => {
    const sw = createServiceWorkerHarness();
    await sw.install();
    assert.equal(evaluatePwaUpdate({ updateAvailable: false }).visible, false);
  });
});

describe("deferred update notice", () => {
  it("offers an explicit reload when nothing is at risk", () => {
    const view = evaluatePwaUpdate({ updateAvailable: true, activity: IDLE_PWA_ACTIVITY });
    assert.equal(view.visible, true);
    assert.equal(view.deferred, false);
    assert.equal(view.reason, null);
    assert.equal(view.title, PWA_UPDATE_AVAILABLE_TITLE);
    assert.equal(view.reloadLabel, "Reload now");
    assert.match(view.detail, /chain reads are always fetched live/i);
  });

  it("defers while a policy or deployment draft is dirty", () => {
    const view = evaluatePwaUpdate({
      updateAvailable: true,
      activity: { draftDirty: true, pendingWrites: 0 },
    });
    assert.equal(view.visible, true);
    assert.equal(view.deferred, true);
    assert.equal(view.reason, "draft");
    assert.equal(view.reloadLabel, "Reload and discard draft");
    assert.match(view.detail, /unsaved/i);
    assert.match(view.detail, /discards the draft/i);
  });

  it("defers while a wallet write is pending, and a write outranks a draft", () => {
    const pending = evaluatePwaUpdate({
      updateAvailable: true,
      activity: { draftDirty: true, pendingWrites: 2 },
    });
    assert.equal(pending.deferred, true);
    assert.equal(pending.reason, "pending-write");
    assert.equal(pending.reloadLabel, "Reload anyway");
    assert.match(pending.detail, /in flight/i);
    assert.match(pending.detail, /nothing is replayed/i);
  });
});

describe("PWA activity registry", () => {
  it("reports a draft and counts pending writes independently", () => {
    const releaseDraft = registerPwaActivity("draft");
    const releaseFirst = registerPwaActivity("write");
    const releaseSecond = registerPwaActivity("write");

    try {
      assert.deepEqual(pwaActivitySnapshot(), { draftDirty: true, pendingWrites: 2 });
    } finally {
      releaseDraft();
      releaseFirst();
      releaseSecond();
    }
  });

  it("returns to the shared idle snapshot when every hold is released", () => {
    const release = registerPwaActivity("draft");
    assert.equal(pwaActivitySnapshot().draftDirty, true);
    release();
    release(); // double release is a no-op, not a negative count
    assert.equal(pwaActivitySnapshot(), IDLE_PWA_ACTIVITY);
    assert.equal(pwaActivitySnapshot().pendingWrites, 0);
  });

  it("notifies subscribers on every change and stops after unsubscribe", () => {
    let calls = 0;
    const unsubscribe = subscribePwaActivity(() => {
      calls += 1;
    });
    const release = registerPwaActivity("write");
    assert.equal(calls, 1);
    release();
    assert.equal(calls, 2);
    unsubscribe();
    const again = registerPwaActivity("write");
    again();
    assert.equal(calls, 2);
    assert.equal(pwaActivitySnapshot(), IDLE_PWA_ACTIVITY);
  });
});

// ── Cached shell vs live chain data (#348) ─────────────────────────────────

describe("cached shell marker", () => {
  it("tags an offline navigation as cached, and leaves a live one untagged", async () => {
    const sw = createServiceWorkerHarness();
    await sw.install();

    sw.setNetworkDown(true);
    const offline = await sw.dispatchFetch("/configure", { mode: "navigate" });
    assert.equal(offline.response?.status, 200);
    assert.equal(
      offline.response?.headers.get("X-Guard-Shell"),
      "cached",
      "the page can tell the cached shell from a live document",
    );

    // Reconnect: the same navigation is fetched from the network again and the
    // marker is gone, so the notice disappears with it.
    sw.setNetworkDown(false);
    const online = await sw.dispatchFetch("/", { mode: "navigate" });
    assert.equal(online.response?.headers.get("X-Guard-Shell"), null);
  });

  it("tags a stale cached asset, and not a freshly fetched one", async () => {
    const sw = createServiceWorkerHarness();
    await sw.install();

    sw.setNetworkDown(true);
    const stale = await sw.dispatchFetch("/icons/icon.svg");
    assert.equal(stale.response?.status, 200);
    assert.equal(stale.response?.headers.get("X-Guard-Shell"), "cached");

    sw.setNetworkDown(false);
    const fresh = await sw.dispatchFetch("/icons/not-cached.svg");
    assert.equal(fresh.response?.headers.get("X-Guard-Shell"), null);
  });
});

describe("offline decision", () => {
  it("says nothing when online with successful live reads", () => {
    const view = evaluateOffline({ online: true, liveReadFailed: false });
    assert.equal(view.visible, false);
    assert.equal(view.writesDisabled, false);
  });

  it("states that an offline shell is not live chain data, and disables writes", () => {
    const view = evaluateOffline({ online: false, liveReadFailed: false });
    assert.equal(view.visible, true);
    assert.equal(view.writesDisabled, true);
    assert.equal(view.title, OFFLINE_SHELL_TITLE);
    assert.match(view.detail, /last successful live read/i);
    assert.match(view.detail, /cached shell/i);
    assert.match(view.detail, /not current chain state/i);
  });

  it("disables writes when the required live read failed, even while online", () => {
    const view = evaluateOffline({ online: true, liveReadFailed: true });
    assert.equal(view.visible, true);
    assert.equal(view.writesDisabled, true);
    assert.equal(view.title, WRITES_UNAVAILABLE_TITLE);
    assert.match(view.detail, /will not submit blind/i);
  });
});

describe("connectivity store", () => {
  it("reports browser online/offline changes and stops after unsubscribe", () => {
    let calls = 0;
    const unsubscribe = subscribeOnline(() => {
      calls += 1;
    });
    try {
      setOnlineForTest(false);
      assert.equal(onlineSnapshot(), false);
      setOnlineForTest(false); // an unchanged value is not a new event
      assert.equal(calls, 1);
    } finally {
      setOnlineForTest(true);
      unsubscribe();
    }
    assert.equal(calls, 2);
    assert.equal(onlineSnapshot(), true);
  });
});
