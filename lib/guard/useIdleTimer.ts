"use client";

/**
 * Operator session timeout and auto-lock (issue #98).
 *
 * An admin console left open on an unattended workstation is a live signing
 * opportunity for anyone who walks up. This module watches for real operator
 * presence — mouse, keyboard and touch — and, after a configurable period of
 * inactivity, warns and then locks: it tears down the wallet session so a
 * signed write can no longer be produced without reconnecting.
 *
 * The timing is owned by a framework-free `IdleTimer` class rather than the hook
 * body, for the same reason `ToastStore` exists: the semantics (reset on
 * activity, warn inside the lead window, expire once) are the part worth
 * testing with fake timers, and the hook is a thin binding of that class to
 * window events and React state.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** Lead time before the lock, during which the warning modal is shown. */
export const IDLE_WARNING_SECONDS = 60;

/** The default auto-lock, in milliseconds. */
export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

/** A `timeoutMs` of zero disables the timer entirely ("Never"). */
export const IDLE_TIMEOUT_NEVER_MS = 0;

export interface IdleTimeoutOption {
  label: string;
  valueMs: number;
}

export const IDLE_TIMEOUT_OPTIONS: readonly IdleTimeoutOption[] = [
  { label: "5 minutes", valueMs: 5 * 60 * 1000 },
  { label: "15 minutes", valueMs: DEFAULT_IDLE_TIMEOUT_MS },
  { label: "30 minutes", valueMs: 30 * 60 * 1000 },
  { label: "Never", valueMs: IDLE_TIMEOUT_NEVER_MS },
];

export const IDLE_TIMEOUT_STORAGE_KEY = "stellar-agent-guard-dashboard.idleTimeout.v1";

export type IdlePhase = "armed" | "warning" | "locked";

export interface IdleState {
  phase: IdlePhase;
  /** Whole seconds until the lock; `0` once locked. */
  secondsLeft: number;
}

export interface IdleTimerOptions {
  timeoutMs: number;
  warningSeconds?: number;
  /** Called whenever the phase or the countdown second changes. */
  onState: (state: IdleState) => void;
  /** Called exactly once, when the timeout elapses with no activity. */
  onExpire: () => void;
  /** Injectable clock, so tests can advance time deterministically. */
  now?: () => number;
}

/**
 * A countdown that resets on activity and fires once on expiry.
 *
 * One second-tick drives everything: `start()` arms a deadline, each tick
 * recomputes the remaining time from it, and `activity()` simply pushes the
 * deadline forward. Using a deadline (not a countdown counter) means the timer
 * cannot drift against the wall clock, and a tab throttled in the background
 * still expires at the right absolute time when it resumes.
 */
export class IdleTimer {
  private readonly timeoutMs: number;
  private readonly warningMs: number;
  private readonly onState: (state: IdleState) => void;
  private readonly onExpire: () => void;
  private readonly now: () => number;

  private deadline = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastState: IdleState | null = null;
  private expired = false;

  constructor(options: IdleTimerOptions) {
    this.timeoutMs = options.timeoutMs;
    this.warningMs = (options.warningSeconds ?? IDLE_WARNING_SECONDS) * 1000;
    this.onState = options.onState;
    this.onExpire = options.onExpire;
    this.now = options.now ?? Date.now;
  }

  /** Begin counting down from "now". */
  start(): void {
    this.arm();
    this.expired = false;
    this.tick();
    this.interval = setInterval(() => this.tick(), 1000);
  }

  /** Stop the timer and release its interval. */
  stop(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Record operator presence: reset the deadline and leave the warning state. */
  activity(): void {
    if (this.interval === null) return;
    this.arm();
    this.expired = false;
    this.tick();
  }

  /** Recompute against the absolute deadline after a background tab resumes. */
  checkDeadline(): void {
    if (this.interval !== null) this.tick();
  }

  private arm(): void {
    this.deadline = this.now() + this.timeoutMs;
  }

  private tick(): void {
    const remaining = this.deadline - this.now();
    if (remaining <= 0) {
      this.publish({ phase: "locked", secondsLeft: 0 });
      if (!this.expired) {
        this.expired = true;
        this.stop();
        this.onExpire();
      }
      return;
    }
    const secondsLeft = Math.ceil(remaining / 1000);
    const phase: IdlePhase = remaining <= this.warningMs ? "warning" : "armed";
    this.publish({ phase, secondsLeft });
  }

  private publish(state: IdleState): void {
    if (
      this.lastState !== null &&
      this.lastState.phase === state.phase &&
      this.lastState.secondsLeft === state.secondsLeft
    ) {
      return;
    }
    this.lastState = state;
    this.onState(state);
  }
}

/** The timeout the operator last chose, or the default. Corrupt storage falls back. */
export function loadIdleTimeoutMs(storage?: StorageLike | null): number {
  const store = storage === undefined ? defaultStorage() : storage;
  if (!store) return DEFAULT_IDLE_TIMEOUT_MS;
  try {
    const raw = store.getItem(IDLE_TIMEOUT_STORAGE_KEY);
    if (raw === null) return DEFAULT_IDLE_TIMEOUT_MS;
    const value = Number(raw);
    const known = IDLE_TIMEOUT_OPTIONS.some((option) => option.valueMs === value);
    return known ? value : DEFAULT_IDLE_TIMEOUT_MS;
  } catch {
    return DEFAULT_IDLE_TIMEOUT_MS;
  }
}

/** Remember the operator's chosen timeout. */
export function saveIdleTimeoutMs(valueMs: number, storage?: StorageLike | null): void {
  const store = storage === undefined ? defaultStorage() : storage;
  if (!store) return;
  try {
    store.setItem(IDLE_TIMEOUT_STORAGE_KEY, String(valueMs));
  } catch {
    // A private-mode write only loses the preference; the default still applies.
  }
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export interface UseIdleTimerOptions {
  /** 0 disables the timer. */
  timeoutMs: number;
  /** When false, no listeners are attached and no countdown runs. */
  enabled: boolean;
  onExpire: () => void;
  warningSeconds?: number;
}

export interface UseIdleTimer {
  state: IdleState;
  /** "Stay connected": acknowledge the warning and reset the countdown. */
  stayConnected: () => void;
}

const ACTIVITY_EVENTS: readonly ("mousemove" | "keydown" | "touchstart")[] = [
  "mousemove",
  "keydown",
  "touchstart",
];

/**
 * Bind an `IdleTimer` to real user presence.
 *
 * Returns the live countdown state (for the warning modal) and a `stayConnected`
 * handler. `onExpire` is read through a ref so a parent re-rendering with a new
 * callback identity does not tear down and restart the countdown — restarting on
 * every render would mean the timer effectively never expires while the page is
 * interactive.
 */
export function useIdleTimer(options: UseIdleTimerOptions): UseIdleTimer {
  const { timeoutMs, enabled, warningSeconds } = options;
  const onExpireRef = useRef(options.onExpire);
  // Keep the latest callback without re-arming the timer: refs are updated
  // after render, never during it.
  useEffect(() => {
    onExpireRef.current = options.onExpire;
  });

  const [state, setState] = useState<IdleState>(() => ({
    phase: "armed",
    secondsLeft: Math.ceil(timeoutMs / 1000),
  }));
  const timerRef = useRef<IdleTimer | null>(null);

  useEffect(() => {
    if (!enabled || timeoutMs <= 0) {
      timerRef.current = null;
      return;
    }
    const timer = new IdleTimer({
      timeoutMs,
      ...(warningSeconds === undefined ? {} : { warningSeconds }),
      onState: setState,
      onExpire: () => onExpireRef.current(),
    });
    timerRef.current = timer;
    timer.start();

    const record = () => timer.activity();
    const checkDeadline = () => timer.checkDeadline();
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, record, { passive: true });
    }
    document.addEventListener("visibilitychange", checkDeadline);
    return () => {
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, record);
      }
      document.removeEventListener("visibilitychange", checkDeadline);
      timer.stop();
      timerRef.current = null;
    };
  }, [enabled, timeoutMs, warningSeconds]);

  const stayConnected = useCallback(() => {
    timerRef.current?.activity();
  }, []);

  return { state, stayConnected };
}
