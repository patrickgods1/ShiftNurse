/**
 * Reading what a manager typed into a number box. `Number('')` is 0, so every form that wrote
 * `Number(e.target.value)` turned a cleared field into a saved zero (a 0-hour rest rule, a 0
 * census), and a form that wrote on every keystroke recorded one audited row per digit. These
 * helpers keep "blank" and "not a number" distinct from 0, and `useFieldDraft` lets a field hold
 * its own text until the manager is done, then follow the saved value again.
 */

import { useEffect, useState } from 'react';

/** '' or whitespace → undefined; a finite number → that number; anything else → undefined. Never 0 for blank. */
export function parseNumberField(text: string): number | undefined {
  const t = text.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** Like parseNumberField, but a non-integer is undefined. */
export function parseIntegerField(text: string): number | undefined {
  const n = parseNumberField(text);
  return n !== undefined && Number.isInteger(n) ? n : undefined;
}

/** The text a number input shows for a stored value: '' for undefined or null. */
export function numberFieldText(value: number | null | undefined): string {
  return value === undefined || value === null ? '' : String(value);
}

/** Why `text` cannot be committed, in the manager's words, or undefined when it can. */
export function numberFieldProblem(
  text: string,
  opts: { min?: number; max?: number; integer?: boolean; allowBlank?: boolean },
): string | undefined {
  if (text.trim() === '') return opts.allowBlank ? undefined : 'Enter a number.';
  const n = parseNumberField(text);
  if (n === undefined) return 'Enter a number.';
  if (opts.integer && !Number.isInteger(n)) return 'Enter a whole number.';
  if (opts.min !== undefined && n < opts.min) return `Must be at least ${opts.min}.`;
  if (opts.max !== undefined && n > opts.max) return `Must be at most ${opts.max}.`;
  return undefined;
}

/**
 * Local text for a field that follows `saved` while the field is neither focused nor edited.
 * This replaces `key={saved}` remounts, which dropped focus and the caret mid-edit.
 */
export function useFieldDraft(saved: string): {
  text: string;
  setText(text: string): void;
  dirty: boolean;
  bind: { onFocus(): void; onBlur(): void };
  /** Back to following `saved`, or to `text` (what was just committed) until `saved` catches up. */
  reset(text?: string): void;
} {
  const [text, setTextState] = useState(saved);
  const [focused, setFocused] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!focused && !dirty) setTextState(saved);
  }, [saved, focused, dirty]);

  return {
    text,
    setText(next) {
      setTextState(next);
      setDirty(true);
    },
    dirty,
    bind: {
      onFocus: () => setFocused(true),
      onBlur: () => setFocused(false),
    },
    reset(next) {
      setTextState(next ?? saved);
      setDirty(false);
    },
  };
}
