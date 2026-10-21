"use client";

/**
 * Connectivity, and what the console may claim while it is gone (issue #348).
 *
 * The service worker serves a cached app shell offline, which is useful for
 * opening the console and dangerous for reading it: an offline shell must not
 * make last-known values look like current chain state, and no write may be
 * prepared when the live read it needs cannot complete. This module holds the
 * one browser signal for that (`navigator.onLine` and its events) and the rule
 * that turns it, plus a failed live read, into a single visible statement.
 *
 * `online === false` is trustworthy; `online === true` only means a network
 * interface exists, so a failed read still disables writes on its own.
 */

import { useSyncExternalStore } from "react";

let online = true;

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function setOnline(value: boolean): void {
  if (online === value) return;
  online = value;
  emit();
}

if (typeof window !== "undefined") {
  online = navigator.onLine;
  window.addEventListener("online", () => setOnline(true));
  window.addEventListener("offline", () => setOnline(false));
}

/** The current connectivity, as a stable primitive for `useSyncExternalStore`. */
export function onlineSnapshot(): boolean {
  return online;
}

/** Subscribe to connectivity changes. Returns the unsubscribe function. */
export function subscribeOnline(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: drive connectivity without a browser's events. */
export function setOnlineForTest(value: boolean): void {
  setOnline(value);
}

/**
 * Live connectivity. The server snapshot is `true` because no connector exists
 * during SSR; the first client render reads the real value.
 */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribeOnline, onlineSnapshot, () => true);
}

export const OFFLINE_SHELL_TITLE = "Offline — cached app shell, not live chain data";

/**
 * Spoken once through the shell's announcement queue when connectivity drops.
 * The visible notice is not a live region of its own: every announcement in
 * this console leaves through `announce()`, so it inherits the queue's
 * ordering, deduplication and cap.
 */
export const OFFLINE_ANNOUNCEMENT =
  "Offline. This is the cached app shell, not live chain data, and write actions are unavailable until a live read succeeds.";

export const WRITES_UNAVAILABLE_TITLE = "Write actions are unavailable until a live read succeeds";

export interface OfflineView {
  /** Whether anything should be shown at all. */
  visible: boolean;
  /** True whenever writes must not be offered. */
  writesDisabled: boolean;
  title: string;
  detail: string;
}

/**
 * The one decision about what an offline (or read-blocked) console may do.
 *
 * Kept out of the components so the three states — online and readable, offline
 * with a cached shell, online but the required live read failed — are testable
 * without a browser.
 */
export function evaluateOffline(input: { online: boolean; liveReadFailed: boolean }): OfflineView {
  if (input.online && !input.liveReadFailed) {
    return { visible: false, writesDisabled: false, title: "", detail: "" };
  }

  if (!input.online) {
    return {
      visible: true,
      writesDisabled: true,
      title: OFFLINE_SHELL_TITLE,
      detail:
        "There is no network connection, so any values on screen are from the last successful live read — not current chain state — and the interface itself may be the cached shell. Nothing can be prepared or submitted until a live read succeeds.",
    };
  }

  return {
    visible: true,
    writesDisabled: true,
    title: WRITES_UNAVAILABLE_TITLE,
    detail:
      "The live read a write must preflight failed, so the console will not submit blind. Retry the read; write actions re-enable as soon as it succeeds.",
  };
}
