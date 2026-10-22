"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type PropsWithChildren } from "react";
import { useRouter } from "next/navigation";
import {
  getUnsavedChanges,
  subscribeUnsavedChanges,
} from "../lib/guard/useUnsavedChangesWarning.ts";

interface NavigationRouter {
  push(href: string): void;
}

export function UnsavedChangesProvider({ children }: PropsWithChildren) {
  const router = useRouter();
  return <UnsavedChangesGuardView router={router}>{children}</UnsavedChangesGuardView>;
}

export function UnsavedChangesGuardView({
  children,
  router,
}: PropsWithChildren<{ router: NavigationRouter }>) {
  const isDirty = useSyncExternalStore(subscribeUnsavedChanges, getUnsavedChanges, () => false);
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isDirty) return;

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    const onClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      if (
        !anchor ||
        anchor.hasAttribute("download") ||
        (anchor.target && anchor.target !== "_self")
      ) {
        return;
      }

      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin) return;
      if (
        destination.pathname === window.location.pathname &&
        destination.search === window.location.search
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setPendingHref(`${destination.pathname}${destination.search}${destination.hash}`);
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [isDirty]);

  useEffect(() => {
    if (!pendingHref) return;
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPendingHref(null);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [pendingHref]);

  function discardChanges() {
    if (!pendingHref) return;
    const destination = pendingHref;
    setPendingHref(null);
    router.push(destination);
  }

  return (
    <>
      {children}
      {pendingHref && (
        <div className="modal-backdrop" role="presentation" onClick={() => setPendingHref(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="unsaved-policy-title"
            aria-describedby="unsaved-policy-description"
            ref={dialogRef}
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="unsaved-policy-title" style={{ marginTop: 0 }}>
              You have unsaved policy changes. Discard changes or continue editing?
            </h2>
            <p id="unsaved-policy-description" className="tiny muted">
              Leaving this page will discard the current policy draft.
            </p>
            <div className="row" style={{ marginTop: 14 }}>
              <button onClick={discardChanges}>Discard changes</button>
              <button className="secondary" onClick={() => setPendingHref(null)}>
                Continue editing
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
