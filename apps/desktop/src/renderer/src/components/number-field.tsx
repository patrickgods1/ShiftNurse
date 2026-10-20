/**
 * A labelled number input that never turns a blank into 0. It holds the typed text locally and
 * commits on blur or Enter, only when the value is valid and changed, so a form that writes to
 * the database does not record an audited row per keystroke or per no-op visit. `commit="change"`
 * is for the few fields that feed a live preview. It never clamps while typing; out-of-range text
 * stays on screen with the reason.
 */

import { useId, useState } from 'react';
import {
  numberFieldProblem,
  numberFieldText,
  parseNumberField,
  useFieldDraft,
} from '../field-values.js';
import { describedBy, Field } from './field-help.js';
import { INPUT } from './ui.js';

export interface NumberFieldProps {
  label: string;
  value: number | undefined;
  /** Called only with a value that passes numberFieldProblem and differs from `value`. */
  onCommit(value: number | undefined): void;
  /** 'blur' (default): commit on blur or Enter. 'change': commit every valid keystroke. */
  commit?: 'blur' | 'change';
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  /** Blank commits `undefined` instead of showing "Enter a number." Default false. */
  allowBlank?: boolean;
  hint?: string;
  tip?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  'data-testid'?: string;
}

export function NumberField({
  label,
  value,
  onCommit,
  commit = 'blur',
  min,
  max,
  step,
  integer,
  allowBlank = false,
  hint,
  tip,
  id,
  disabled,
  className,
  'data-testid': testId,
}: NumberFieldProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  const draft = useFieldDraft(numberFieldText(value));
  const [blurred, setBlurred] = useState(false);
  const opts = { min, max, integer, allowBlank };
  const problem = numberFieldProblem(draft.text, opts);
  const shown = blurred || draft.dirty ? problem : undefined;

  const nextFor = (text: string) => (text.trim() === '' ? undefined : parseNumberField(text));

  const finish = () => {
    if (problem !== undefined) return;
    const next = nextFor(draft.text);
    if (next !== value) onCommit(next);
    // Show what was committed: the field may still be focused (Enter), so it will not follow `value`.
    draft.reset(numberFieldText(next));
  };

  return (
    <Field
      id={fieldId}
      label={label}
      hint={hint}
      tip={tip}
      error={shown}
      disabled={disabled ?? false}
      className={className}
    >
      <input
        id={fieldId}
        type="number"
        inputMode={integer ? 'numeric' : 'decimal'}
        className={INPUT}
        value={draft.text}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        data-testid={testId}
        aria-invalid={shown !== undefined || undefined}
        aria-describedby={describedBy(fieldId, {
          hint: hint !== undefined,
          error: shown !== undefined,
        })}
        onFocus={draft.bind.onFocus}
        onChange={(e) => {
          const text = e.target.value;
          draft.setText(text);
          if (commit === 'change' && numberFieldProblem(text, opts) === undefined) {
            const next = nextFor(text);
            if (next !== value) onCommit(next);
          }
        }}
        onBlur={() => {
          draft.bind.onBlur();
          setBlurred(true);
          finish();
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          // A surrounding form would otherwise submit a second time on top of this commit.
          e.preventDefault();
          finish();
        }}
      />
    </Field>
  );
}
