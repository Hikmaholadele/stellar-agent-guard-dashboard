"use client";

import { useEffect, useRef, useState } from "react";
import { copyToClipboard } from "../lib/guard/clipboard.ts";
import { announce } from "../lib/guard/useAnnounce.ts";
import { redactDiagnostics } from "../lib/guard/inputSanitizer.ts";

/**
 * One-click copy for the addresses and hashes operators handle by hand (issue #33).
 *
 * Manual select-triple-click-copy fails in the worst way: a partial address or a
 * half-hash pastes into an explorer and comes back as "not found", which reads as
 * a chain problem rather than a copy problem. The button writes the *full* value
 * through the async Clipboard API and shows the result:
 *
 *   - success: the button swaps to "Copied ✓" for a moment, then reverts;
 *   - failure: an inline "select manually" hint renders and the value itself
 *     stays selectable on screen.
 *
 * Secure context: the async Clipboard API exists only in a secure context
 * (HTTPS / localhost exemptions) with write permission granted. Development over
 * plain `http://` from a LAN address, or a permission denial, makes the write
 * reject — the failure path below renders the hint and announces "Copy failed"
 * rather than failing silently, so the operator always knows the clipboard does
 * not hold the value and can select it the old way.
 *
 * Announcements go through the shared `announce()` channel. Copies are
 * user-initiated actions, so their result is announced under the same
 * user-action-result category the announcer already applies to transaction
 * milestones (polite, deduplicated by its duplicate window) — this is distinct
 * from poll-driven state changes, which the announcer deliberately suppresses.
 * Failure is announced with the same parity as success; a silent failure is the
 * one outcome the issue rules out.
 *
 * Focus: the component is a real `<button>` (keyboard-operable by default) and
 * never moves focus — after a click the button stays the active element, so a
 * keyboard operator can press Enter again to re-copy without re-tabbing.
 */
export function CopyButton({
  value,
  label,
  className,
}: {
  /** The exact string written to the clipboard — never truncated here. */
  value: string;
  /**
   * What is being copied, named for humans: the rendered aria-label is
   * `Copy ${label}` ("Copy guard address", "Copy transaction hash") — the
   * context-in-label rule, so a screen reader says what would be copied.
   */
  label: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const revertTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (revertTimer.current !== null) clearTimeout(revertTimer.current);
    };
  }, []);

  async function handleClick() {
    const sanitized = redactDiagnostics(value);
    const result = await copyToClipboard(sanitized);
    if (revertTimer.current !== null) clearTimeout(revertTimer.current);
    if (result.ok) {
      setError(null);
      setState("copied");
      announce("Copied");
      revertTimer.current = setTimeout(() => setState("idle"), COPIED_FEEDBACK_MS);
    } else {
      setState("failed");
      setError(result.error);
      announce("Copy failed", "assertive");
      revertTimer.current = setTimeout(() => setState("idle"), COPIED_FEEDBACK_MS);
    }
  }

  return (
    <span className="copy-wrap">
      <button
        type="button"
        className={`secondary copy-btn${className ? ` ${className}` : ""}`}
        onClick={() => void handleClick()}
        aria-label={`Copy ${label}`}
        title={`Copy ${label}`}
      >
        {state === "copied" ? "Copied ✓" : "Copy"}
      </button>
      {state === "failed" && error !== null && (
        <span role="alert" className="tiny copy-hint">
          copy failed — select the value manually ({error})
        </span>
      )}
    </span>
  );
}

/** How long the "Copied ✓" swap stays before reverting to "Copy". */
export const COPIED_FEEDBACK_MS = 2_000;
