"use client";

import { useState } from "react";
import { toastStore, useToast, type Toast } from "../lib/guard/useToast.ts";
import { redactDiagnostics } from "../lib/guard/inputSanitizer.ts";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API unavailable (permissions, insecure context) — fall back
    // to a selectable textarea so the details are still copyable by hand.
    try {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      document.body.removeChild(area);
      return true;
    } catch {
      return false;
    }
  }
}

function ErrorDetails({ toast }: { toast: Toast }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!toast.error) return null;

  const raw = [
    toast.error.message,
    toast.error.status !== undefined ? `status: ${toast.error.status}` : null,
    toast.error.stack ?? null,
  ]
    .filter((part): part is string => part !== null)
    .join("\n");

  return (
    <div className="toast-details">
      <button
        type="button"
        className="tiny toast-details-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "Hide error details" : "View error details"}
      </button>
      {open && (
        <div className="toast-details-body">
          <pre className="mono toast-details-raw">{raw}</pre>
          <button
            type="button"
            className="tiny toast-copy"
            onClick={() => {
              void copyText(redactDiagnostics(raw)).then((ok) => {
                setCopied(ok);
                if (ok) window.setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? "Copied" : "Copy details"}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Centralized toast viewport (issue #105).
 *
 * Fixed corner, `aria-live="polite"` so screen readers announce arrivals,
 * per-kind auto-dismiss owned by the store. Error toasts persist until
 * dismissed and carry an expandable raw-details inspector for RPC failures.
 */
export function ToastContainer() {
  const { toasts, dismiss } = useToast(toastStore);
  if (toasts.length === 0) return null;
  return (
    <div className="toast-viewport" role="region" aria-label="Notifications">
      <div aria-live="polite" className="toast-live">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.kind === "error" ? "alert" : "status"}
            className={`toast toast-${toast.kind} toast-enter`}
          >
            <div className="toast-head">
              <strong className="toast-title">{toast.title}</strong>
              <button
                type="button"
                className="tiny toast-dismiss"
                aria-label={`Dismiss: ${toast.title}`}
                onClick={() => dismiss(toast.id)}
              >
                Dismiss
              </button>
            </div>
            {toast.detail && <div className="tiny">{toast.detail}</div>}
            <ErrorDetails toast={toast} />
          </div>
        ))}
      </div>
    </div>
  );
}
