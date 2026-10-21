"use client";

/**
 * Registers the static-shell service worker, and asks before replacing the app.
 *
 * The worker caches only the app shell; every chain read bypasses it (see
 * `public/sw.js`). Registration waits for `load` so it never competes with the
 * first paint for bandwidth, and it is skipped outside production because a
 * cache-first shell in development would serve a stale build back at the
 * developer.
 *
 * Updates are deferred to the operator (#398). A new worker is left waiting and
 * a non-blocking notice offers an explicit reload; nothing activates while a
 * policy or deployment draft is dirty or a wallet write is in flight. The
 * reload action warns once more before discarding that work, and the activation
 * produces exactly one reload — never a replayed transaction, because the
 * worker serves only the shell and every write lives in the page that made it.
 *
 * Mounted by the root layout so every route, not just the console overview,
 * becomes installable.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  IDLE_PWA_ACTIVITY,
  PWA_UPDATE_ANNOUNCEMENT,
  SERVICE_WORKER_PATH,
  SERVICE_WORKER_SKIP_WAITING_MESSAGE,
  evaluatePwaUpdate,
  pwaActivitySnapshot,
  subscribePwaActivity,
  type PwaUpdateView,
} from "../lib/guard/pwa.ts";
import { announce } from "../lib/guard/useAnnounce.ts";
import { OFFLINE_ANNOUNCEMENT, evaluateOffline, useOnlineStatus } from "../lib/guard/online.ts";

export function PwaRegistrar() {
  // The worker that is ready but not active. `null` means no update is waiting.
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reloading, setReloading] = useState(false);
  // One reload per activation, however many `controllerchange` events arrive.
  const reloaded = useRef(false);
  const activity = useSyncExternalStore(
    subscribePwaActivity,
    pwaActivitySnapshot,
    () => IDLE_PWA_ACTIVITY,
  );
  const online = useOnlineStatus();
  const view = evaluatePwaUpdate({ updateAvailable: waiting !== null, activity });

  // Spoken through the same queue as every other announcement; the visible
  // notice below is not a second live region.
  useEffect(() => {
    if (!online) announce(OFFLINE_ANNOUNCEMENT);
  }, [online]);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    const container = navigator.serviceWorker;
    // Whether this page is controlled *right now*. It starts false on a first
    // install and flips on the `clients.claim()` that follows, so a later
    // update in the same session is still treated as an update.
    let controlled = container.controller !== null;

    const onControllerChange = () => {
      // The first activation only claims this page: there is no old shell on
      // screen to replace, so reloading would discard work for nothing.
      if (!controlled) {
        controlled = true;
        return;
      }
      if (reloaded.current) return;
      reloaded.current = true;
      window.location.reload();
    };
    container.addEventListener("controllerchange", onControllerChange);

    const hold = (worker: ServiceWorker) => {
      // Ready but deliberately held back: the page decides when to swap.
      setWaiting(worker);
      setDismissed(false);
      setConfirming(false);
      // Spoken through the shell's one live region, so the operator hears
      // about the update even if the notice is off-screen. The queue
      // deduplicates, so a re-detected worker cannot spam it.
      announce(PWA_UPDATE_ANNOUNCEMENT);
    };

    const watch = (registration: ServiceWorkerRegistration) => {
      if (registration.waiting) {
        if (controlled) hold(registration.waiting);
        // A first install that never got to activate can be promoted straight
        // away: no controlled page exists to interrupt.
        else registration.waiting.postMessage({ type: SERVICE_WORKER_SKIP_WAITING_MESSAGE });
        return;
      }
      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          if (installing.state !== "installed") return;
          if (!controlled) {
            installing.postMessage({ type: SERVICE_WORKER_SKIP_WAITING_MESSAGE });
            return;
          }
          hold(installing);
        });
      });
    };

    const register = () => {
      void container
        .register(SERVICE_WORKER_PATH)
        .then(watch)
        .catch((error: unknown) => {
          // A failed registration only costs the offline shell; the console
          // itself keeps working, so this is logged, never surfaced as an error.
          console.warn("Service worker registration failed:", error);
        });
    };

    if (document.readyState === "complete") {
      register();
      return () => container.removeEventListener("controllerchange", onControllerChange);
    }
    window.addEventListener("load", register, { once: true });
    return () => {
      window.removeEventListener("load", register);
      container.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  const reloadNow = useCallback(() => {
    // Deferred work needs one more confirmation from the operator. The second
    // press is the explicit instruction to discard it.
    if (view.deferred && !confirming) {
      setConfirming(true);
      return;
    }
    setReloading(true);
    waiting?.postMessage({ type: SERVICE_WORKER_SKIP_WAITING_MESSAGE });
    // If the worker has already gone, or the browser never fires
    // `controllerchange`, the explicit request still reloads the page.
    window.setTimeout(() => {
      if (reloaded.current) return;
      reloaded.current = true;
      window.location.reload();
    }, 3000);
  }, [view.deferred, confirming, waiting]);

  // The shell may be served offline before anything else on the page can run,
  // and this registrar is mounted by the root layout on every route — so this
  // is where the offline statement belongs. It says what is *not* current, and
  // it never replaces a value: the panel below keeps showing the last live read
  // or its own error.
  if (!online) {
    const offline = evaluateOffline({ online: false, liveReadFailed: false });
    return (
      <div className="pwa-update offline" role="region" aria-label="Connection status">
        <div className="pwa-update-body">
          <strong>{offline.title}</strong>
          <span className="tiny muted">{offline.detail}</span>
        </div>
      </div>
    );
  }

  if (!view.visible || dismissed) return null;

  return (
    <PwaUpdateNotice
      view={view}
      confirming={confirming}
      reloading={reloading}
      onReload={reloadNow}
      onKeepWorking={() => setConfirming(false)}
      onLater={() => setDismissed(true)}
    />
  );
}

/**
 * The update notice itself, separated from the lifecycle wiring so the three
 * cases the issue names — idle, dirty draft, pending write — can be rendered
 * and asserted without a real service worker.
 */
export function PwaUpdateNotice({
  view,
  confirming,
  reloading,
  onReload,
  onKeepWorking,
  onLater,
}: {
  view: PwaUpdateView;
  confirming: boolean;
  reloading: boolean;
  onReload: () => void;
  onKeepWorking: () => void;
  onLater: () => void;
}) {
  if (!view.visible) return null;
  return (
    <div className="pwa-update" role="region" aria-labelledby="pwa-update-title">
      <div className="pwa-update-body">
        <strong id="pwa-update-title">{view.title}</strong>
        <span className="tiny muted">{view.detail}</span>
        {view.deferred && (
          <span className="tiny" style={{ color: "var(--warn)" }}>
            {view.reason === "pending-write"
              ? "Held back: a write is in flight."
              : "Held back: unsaved edits are open."}
          </span>
        )}
        {confirming && (
          <span className="tiny" style={{ color: "var(--danger)" }}>
            {view.reason === "pending-write"
              ? "Confirmed: reloading now may interrupt the pending transaction. Nothing will be replayed."
              : "Confirmed: reloading now discards the unsaved draft."}
          </span>
        )}
      </div>
      <div className="row">
        {confirming ? (
          <>
            <button onClick={onReload} disabled={reloading}>
              {reloading ? "Reloading…" : "Yes, reload now"}
            </button>
            <button className="secondary" onClick={onKeepWorking}>
              Keep working
            </button>
          </>
        ) : (
          <>
            <button onClick={onReload} disabled={reloading}>
              {reloading ? "Reloading…" : view.reloadLabel}
            </button>
            <button className="secondary" onClick={onLater}>
              Later
            </button>
          </>
        )}
      </div>
    </div>
  );
}
