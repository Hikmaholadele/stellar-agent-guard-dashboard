import { useEffect, useEffectEvent, useRef, useState } from "react";

export const FORM_VALIDATION_DEBOUNCE_MS = 300;

export type FormFieldErrors = Record<string, string>;
export type FormValidator<T extends object> = (values: T) => FormFieldErrors;

interface ValidationSnapshot<T extends object> {
  values: T;
  errors: FormFieldErrors;
}

/**
 * Field errors that follow the operator's typing.
 *
 * Validation runs against the values as they are now, but a message is only
 * shown once typing has paused for `FORM_VALIDATION_DEBOUNCE_MS`, so a
 * half-typed address is not reported as invalid on every keystroke. Once
 * shown, a message disappears the moment the current values no longer produce
 * it, rather than waiting for another debounce: a corrected field stops being
 * described as broken immediately.
 *
 * Only fields the operator has changed are ever flagged. A form that is still
 * filling itself in — a restored wallet, a policy read from chain — changes
 * values without anyone typing, and flagging every still-blank field the
 * moment that data lands would be noise, not feedback.
 */
export function useFormValidation<T extends object>(
  values: T,
  validate: FormValidator<T>,
): FormFieldErrors {
  const valuesKey = JSON.stringify(values);
  const [snapshot, setSnapshot] = useState<ValidationSnapshot<T> | null>(null);
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const previous = useRef(values);
  const validateCurrent = useEffectEvent(() => ({ values, errors: validate(values) }));

  // Record which fields changed since the last committed render. Runs before
  // the debounce below, so the fields a change touches are known by the time
  // the debounced validation result is shown.
  useEffect(() => {
    const before = previous.current;
    previous.current = values;
    const changed = Object.keys(values).filter(
      (field) =>
        JSON.stringify(before[field as keyof T]) !== JSON.stringify(values[field as keyof T]),
    );
    if (changed.length === 0) return;
    setTouched((current) => {
      const next = new Set(current);
      for (const field of changed) next.add(field);
      return next;
    });
    // `values` is a dep so the effect sees the committed values, not just the
    // key; an equal-value re-render finds no change and updates nothing.
  }, [valuesKey, values]);

  useEffect(() => {
    const timer = setTimeout(() => setSnapshot(validateCurrent()), FORM_VALIDATION_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [valuesKey]);

  if (snapshot === null) return {};

  const currentErrors = validate(values);
  const visibleErrors: FormFieldErrors = {};
  for (const [field, message] of Object.entries(snapshot.errors)) {
    // A field nobody has edited has nothing to answer for yet.
    if (!touched.has(field)) continue;
    // An edited field is re-validated by the next debounce; until then its old
    // message would describe values that are no longer in the form.
    if (
      JSON.stringify(snapshot.values[field as keyof T]) !== JSON.stringify(values[field as keyof T])
    ) {
      continue;
    }
    // Cross-field fixes (a window cap corrected by shrinking the per-tx cap)
    // clear the message without touching the field it is attached to.
    if (currentErrors[field] !== message) continue;
    visibleErrors[field] = message;
  }
  return visibleErrors;
}
