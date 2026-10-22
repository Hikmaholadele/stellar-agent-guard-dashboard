import { useEffect } from "react";

let unsavedChanges = false;
const listeners = new Set<() => void>();

export function subscribeUnsavedChanges(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getUnsavedChanges(): boolean {
  return unsavedChanges;
}

function publishUnsavedChanges(next: boolean): void {
  if (unsavedChanges === next) return;
  unsavedChanges = next;
  for (const listener of [...listeners]) listener();
}

/** Register whether the current policy draft differs from its saved baseline. */
export function useUnsavedChangesWarning(isDirty: boolean): void {
  useEffect(() => {
    publishUnsavedChanges(isDirty);
    return () => publishUnsavedChanges(false);
  }, [isDirty]);
}
