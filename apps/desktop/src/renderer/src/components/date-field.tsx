/**
 * A labelled date input that says why a date is wrong. A raw `<input type="date">` hands back ''
 * for a half-typed date and happily accepts one outside the period, so each form re-checked (or
 * forgot to) and the manager learned only when Save refused. Dates are compared as ISO strings
 * through core and shown through `formatDate`; a `Date` built from an ISO string would read it
 * as UTC and show the previous day west of Greenwich.
 */

import { compareDates, type IsoDate, isIsoDate } from '@shiftnurse/core';
import { useEffect, useId, useRef, useState } from 'react';
import { useFieldDraft } from '../field-values.js';
import { formatDate } from '../format.js';
import { describedBy, Field } from './field-help.js';
import { INPUT } from './ui.js';

export interface DateFieldProps {
  label: string;
  value: IsoDate | '';
  onChange(value: IsoDate | ''): void;
  min?: IsoDate;
  max?: IsoDate;
  required?: boolean;
  hint?: string;
  /** The longer why, shown in the ⓘ tip beside the label. */
  tip?: string;
  id?: string;
  disabled?: boolean;
  /** Hold the typed date locally and call onChange only on blur or Enter, with a valid ISO date or '' that differs from `value`. Default false (today's per-change behaviour). */
  commitOnBlur?: boolean;
  /** A problem the form found (say, "required"); shown when the date itself is not at fault. */
  error?: string;
}

/** The problem with `value`, or undefined. Empty is the form's business (`required`). */
export function dateProblem(
  value: string,
  min: IsoDate | undefined,
  max: IsoDate | undefined,
): string | undefined {
  if (value === '') return undefined;
  if (!isIsoDate(value)) return 'Enter a valid date.';
  if (min !== undefined && compareDates(value, min) < 0) {
    return `Pick a date on or after ${formatDate(min)}`;
  }
  if (max !== undefined && compareDates(value, max) > 0) {
    return `Pick a date on or before ${formatDate(max)}`;
  }
  return undefined;
}

export function DateField({
  label,
  value,
  onChange,
  min,
  max,
  required,
  hint,
  tip,
  id,
  disabled,
  commitOnBlur = false,
  error,
}: DateFieldProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  const draft = useFieldDraft(value);
  const shownValue = commitOnBlur ? draft.text : value;
  // Chromium reports a partly typed date (2026-10-) as '' too; only validity.badInput tells it from
  // a real clear, so leaving it must not write '' over the saved date.
  const [partial, setPartial] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const reverting = commitOnBlur && (draft.dirty || partial);
  // Radix's dialog listens for Escape on document in the capture phase, ahead of any handler on the
  // input, so only a window-level capture listener can keep a revert from also closing the form.
  // A clean field registers nothing and Escape closes the dialog as usual.
  const { reset } = draft;
  useEffect(() => {
    if (!reverting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.target !== inputRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      setPartial(false);
      reset();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [reverting, reset]);
  // The form's own error must not stop a corrected date from committing, so `finish` checks only
  // the date's own problem.
  const ownProblem = partial ? 'Enter a valid date.' : dateProblem(shownValue, min, max);
  const problem = ownProblem ?? error;
  const finish = (badInput: boolean) => {
    if (badInput && draft.text === '') {
      setPartial(true);
      return;
    }
    if (ownProblem !== undefined) return;
    if (draft.text !== value) onChange(draft.text as IsoDate | '');
    draft.reset(draft.text);
  };
  return (
    <Field
      id={fieldId}
      label={label}
      hint={hint}
      tip={tip}
      error={problem}
      disabled={disabled ?? false}
    >
      <input
        id={fieldId}
        ref={inputRef}
        type="date"
        className={INPUT}
        value={shownValue}
        min={min}
        max={max}
        required={required}
        disabled={disabled}
        aria-invalid={problem !== undefined || undefined}
        aria-describedby={describedBy(fieldId, {
          hint: hint !== undefined,
          error: problem !== undefined,
        })}
        // An unparseable half-typed date arrives as '' from the browser; pass it on as such.
        onChange={(e) => {
          if (commitOnBlur) {
            setPartial(false);
            draft.setText(e.target.value);
          } else onChange(isIsoDate(e.target.value) ? e.target.value : '');
        }}
        onFocus={commitOnBlur ? draft.bind.onFocus : undefined}
        onBlur={
          commitOnBlur
            ? (e) => {
                draft.bind.onBlur();
                finish(e.currentTarget.validity.badInput);
              }
            : undefined
        }
        onKeyDown={
          commitOnBlur
            ? (e) => {
                if (e.key === 'Escape') {
                  setPartial(false);
                  draft.reset();
                  return;
                }
                if (e.key !== 'Enter') return;
                e.preventDefault();
                finish(e.currentTarget.validity.badInput);
              }
            : undefined
        }
      />
    </Field>
  );
}
