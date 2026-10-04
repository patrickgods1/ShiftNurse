/**
 * The save bar for a settings editor that holds edits until Save. Each editor used to hand-roll
 * Save and Discard, and most forgot to register with `useUnsavedChanges`, so a tab switch threw a
 * half-edited form away without a word. Wrapping the form here makes the guard automatic: the
 * shell is the one place that tells the guard the form is dirty.
 */

import type { ReactNode } from 'react';
import { errorMessage, PRIMARY, SECONDARY } from './ui.js';
import { useUnsavedChanges } from './unsaved-changes.js';

export interface EditorShellProps {
  /** Name the discard confirmation quotes: "Discard unsaved changes to Rules?" */
  label: string;
  dirty: boolean;
  saving?: boolean;
  error?: unknown;
  /** False while the edits cannot be saved yet (a field is invalid); Save stays disabled. */
  canSave?: boolean;
  /** The `id` of the form holding the fields: Enter in a field then saves, as it did before. */
  formId?: string;
  onSave(): void;
  onDiscard(): void;
  saveLabel?: string;
  children: ReactNode;
}

export function EditorShell({
  label,
  dirty,
  saving = false,
  error,
  canSave = true,
  formId,
  onSave,
  onDiscard,
  saveLabel = 'Save',
  children,
}: EditorShellProps) {
  useUnsavedChanges(label, dirty);
  const message = errorMessage(error);
  return (
    <div className="flex flex-col gap-4">
      {children}
      <div
        data-sticky-footer
        className="sticky bottom-0 flex items-center justify-end gap-3 border-t border-border bg-bg px-4 py-3"
      >
        {message !== undefined ? (
          <p role="alert" className="mr-auto text-sm text-danger">
            {message}
          </p>
        ) : dirty ? (
          <p className="mr-auto text-sm text-text-muted">Unsaved changes</p>
        ) : null}
        <button type="button" className={SECONDARY} disabled={!dirty || saving} onClick={onDiscard}>
          Discard
        </button>
        <button
          // With a form, the browser's own submit path runs the form's `onSubmit`, so a button
          // outside the form and Enter inside it are the same action.
          {...(formId !== undefined
            ? { type: 'submit' as const, form: formId }
            : { type: 'button' as const, onClick: onSave })}
          className={PRIMARY}
          disabled={!dirty || !canSave || saving}
        >
          {saving ? 'Saving…' : saveLabel}
        </button>
      </div>
    </div>
  );
}
