"use client";

import { useEffect, useState } from "react";

export type PrivacySubscriber = (masked: boolean) => void;

/**
 * In-memory privacy preference store (issue #383).
 *
 * Masks presentation text (balances and long public identifiers) on screen
 * while keeping live reads, transaction construction, and copy semantics untouched.
 *
 * Persistence rule:
 * By default, the mask preference is temporary (in-memory only) and NOT persisted
 * to localStorage unless explicitly chosen by the operator.
 */
class PrivacyStore {
  private masked: boolean = false;
  private persist: boolean = false;
  private subscribers = new Set<PrivacySubscriber>();

  constructor() {
    if (typeof localStorage !== "undefined") {
      try {
        const saved = localStorage.getItem("privacy-mask");
        if (saved !== null) {
          this.masked = saved === "true";
          this.persist = true;
        }
      } catch {
        // Ignore storage exceptions (e.g. private browsing)
      }
    }
  }

  get(): boolean {
    return this.masked;
  }

  isPersisted(): boolean {
    return this.persist;
  }

  set(masked: boolean, persist?: boolean): void {
    this.masked = masked;
    if (persist !== undefined) {
      this.persist = persist;
    }
    if (this.persist && typeof localStorage !== "undefined") {
      try {
        localStorage.setItem("privacy-mask", String(this.masked));
      } catch {
        // Ignore
      }
    } else if (!this.persist && typeof localStorage !== "undefined") {
      try {
        localStorage.removeItem("privacy-mask");
      } catch {
        // Ignore
      }
    }
    for (const sub of this.subscribers) {
      sub(this.masked);
    }
  }

  toggle(persist?: boolean): void {
    this.set(!this.masked, persist);
  }

  setPersist(persist: boolean): void {
    this.persist = persist;
    if (persist && typeof localStorage !== "undefined") {
      try {
        localStorage.setItem("privacy-mask", String(this.masked));
      } catch {
        // Ignore
      }
    } else if (!persist && typeof localStorage !== "undefined") {
      try {
        localStorage.removeItem("privacy-mask");
      } catch {
        // Ignore
      }
    }
  }

  resetForTesting(): void {
    this.masked = false;
    this.persist = false;
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.removeItem("privacy-mask");
      } catch {
        // Ignore
      }
    }
    for (const sub of this.subscribers) {
      sub(this.masked);
    }
  }

  subscribe(fn: PrivacySubscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }
}

export const privacyStore = new PrivacyStore();

/**
 * React hook to read and toggle privacy masking.
 */
export function usePrivacy(): {
  masked: boolean;
  togglePrivacy: (persist?: boolean) => void;
  setPrivacy: (masked: boolean, persist?: boolean) => void;
  persist: boolean;
  setPersist: (persist: boolean) => void;
} {
  const [masked, setMasked] = useState<boolean>(() => privacyStore.get());
  const [persist, setPersistState] = useState<boolean>(() => privacyStore.isPersisted());

  useEffect(() => {
    return privacyStore.subscribe((next) => {
      setMasked(next);
      setPersistState(privacyStore.isPersisted());
    });
  }, []);

  return {
    masked,
    togglePrivacy: (p) => privacyStore.toggle(p),
    setPrivacy: (m, p) => privacyStore.set(m, p),
    persist,
    setPersist: (p) => {
      privacyStore.setPersist(p);
      setPersistState(p);
    },
  };
}

export const MASKED_IDENTIFIER = "••••••••••••••••";
export const MASKED_BALANCE = "••••••";

/**
 * Mask a public address or identifier for presentation.
 * Returns the original value if masking is false or value is empty.
 * If masked, returns an obscured string with a clear `(masked)` label.
 */
export function maskIdentifier(value: string, masked = true): string {
  if (!masked || !value) return value;
  if (value.length <= 8) return "•••• (masked)";
  return `${value.slice(0, 4)}••••${value.slice(-4)} (masked)`;
}

/**
 * Mask a balance string or number for presentation.
 * Returns the original value if masking is false.
 * If masked, returns `"•••• (masked)"` or `"•••• ${unit} (masked)"`.
 */
export function maskBalance(value: string | number | bigint, masked = true, unit?: string): string {
  if (!masked) return String(value);
  return unit ? `•••• ${unit} (masked)` : "•••• (masked)";
}
