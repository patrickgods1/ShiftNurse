/**
 * A labelled date input that says why a date is wrong. A raw `<input type="date">` hands back ''
 * for a half-typed date and happily accepts one outside the period, so each form re-checked (or
 * forgot to) and the manager learned only when Save refused. Dates are compared as ISO strings
 * through core and shown through `formatDate`; a `Date` built from an ISO string would read it
 * as UTC and show the previous day west of Greenwich.
 */

import { compareDates, type IsoDate, isIsoDate } from '@shiftnurse/core';
import { useId } from 'react';
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
}: DateFieldProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  const draft = useFieldDraft(value);
  const shownValue = commitOnBlur ? draft.text : value;
  const problem = dateProblem(shownValue, min, max);
  const finish = () => {
    if (problem !== undefined) return;
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
          if (commitOnBlur) draft.setText(e.target.value);
          else onChange(isIsoDate(e.target.value) ? e.target.value : '');
        }}
        onFocus={commitOnBlur ? draft.bind.onFocus : undefined}
        onBlur={
          commitOnBlur
            ? () => {
                draft.bind.onBlur();
                finish();
              }
            : undefined
        }
        onKeyDown={
          commitOnBlur
            ? (e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                finish();
              }
            : undefined
        }
      />
    </Field>
  );
}
