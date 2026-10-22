/**
 * Focus management for a modal dialog, in one place.
 *
 * A modal has to do four things or it is broken in one of two directions: move
 * focus into itself on open, keep Tab cycling inside it, close on Escape, and
 * give focus back to the control that opened it. Skip the first and focus stays
 * behind the dialog on a page the operator cannot see; skip the last and focus
 * lands nowhere on dismissal. Both fail WCAG 2.1 AA keyboard requirements, and
 * both are invisible to a mouse-driven test.
 *
 * It lives here, rather than inline in the panel that uses it, for two reasons
 * the freeze dialog is the proof of: the trap and the announcement of a result
 * have to coexist, and "the result is announced before the dialog is torn down"
 * is only assertable if the teardown is a unit something else can observe.
 *
 * The focus restore happens in the effect's cleanup rather than in the close
 * handler, so *every* way out of the dialog — Escape, Cancel, or proceeding to
 * sign — returns focus exactly once, and the restore is ordered after whatever
 * the close itself announced.
 */

import { useEffect, useRef, type RefObject } from "react";

export interface ModalFocusOptions {
  /** True while the dialog is mounted. */
  open: boolean;
  /** The dialog node itself. */
  containerRef: RefObject<HTMLElement | null>;
  /** The control that opened the dialog; it receives focus back on close. */
  returnFocusRef: RefObject<HTMLElement | null>;
  /** An available control to focus if the original trigger cannot receive focus. */
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  /** Called on Escape. */
  onDismiss: () => void;
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export function useModalFocus({
  open,
  containerRef,
  returnFocusRef,
  fallbackFocusRef,
  onDismiss,
}: ModalFocusOptions): void {
  // The dismiss callback is almost always a fresh closure, so it is read through
  // a ref: subscribing the keydown listener to its identity would re-run the
  // whole effect (and re-arm the focus restore) on every render of the owner.
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  });

  useEffect(() => {
    if (!open) return;
    const dialog = containerRef.current;
    if (!dialog) return;

    const focusables = () => Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));

    // Focus the dialog itself first, so a screen reader announces the title
    // before the operator tabs into its controls.
    dialog.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismissRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      const inside = active !== null && dialog.contains(active);
      if (event.shiftKey && (active === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      // Dismissal in any form (Escape, Cancel, or proceeding to sign) returns
      // focus to the trigger. The trigger row is re-created when the dialog
      // closes, and React re-attaches refs during the commit — before this
      // cleanup runs — so the ref already points at the live button. Reading
      // `.current` at cleanup time is the whole point; a snapshot taken when the
      // effect started would be null (the row is unmounted while the dialog is
      // open) or a detached node.
      // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberate late ref read, see above
      const returnFocusTarget = returnFocusRef.current;
      returnFocusTarget?.focus();
      // eslint-disable-next-line react-hooks/exhaustive-deps -- fallback is attached in the closing commit.
      if (document.activeElement !== returnFocusTarget) fallbackFocusRef?.current?.focus();
    };
  }, [open, containerRef, returnFocusRef, fallbackFocusRef]);
}
