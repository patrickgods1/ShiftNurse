/**
 * How a setting explains itself: a one-line hint that is always visible (what the setting does)
 * and an ⓘ tip for the longer why — when a unit would change it, typical values, the trade-off.
 *
 * Help that lives only in a hover is help nobody finds, and a manager changes these settings
 * once a year, so the hint stays on the page. The tip is a real button: it opens on hover and
 * on keyboard focus, and a screen reader announces its content as the button's description.
 *
 * The tip sits beside the `<label>`, never inside it. A label with no `for` labels its first
 * labelable descendant, and a button is one — a tip inside would steal the label from the input
 * and fold "About …" into the input's accessible name.
 */

import * as Tooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

/** The id a field's hint carries, for the input's `aria-describedby`. */
export function hintIdFor(fieldId: string): string {
  return `${fieldId}-hint`;
}

/** The id a field's error carries. */
export function errorIdFor(fieldId: string): string {
  return `${fieldId}-error`;
}

/** `aria-describedby` for an input with the given hint and error present. */
export function describedBy(
  fieldId: string,
  parts: { hint?: boolean; error?: boolean },
): string | undefined {
  const ids = [
    parts.hint ? hintIdFor(fieldId) : undefined,
    parts.error ? errorIdFor(fieldId) : undefined,
  ].filter((id): id is string => id !== undefined);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

/** Mounted once at the root so moving between tips skips the open delay. */
export function TipProvider({ children }: { children: ReactNode }) {
  return (
    <Tooltip.Provider delayDuration={300} skipDelayDuration={200}>
      {children}
    </Tooltip.Provider>
  );
}

export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          aria-label={`About ${label}`}
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-border text-[10px] font-semibold leading-none text-text-muted hover:border-accent hover:text-accent"
        >
          i
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="z-[60] max-w-80 rounded-md border border-border bg-surface px-3 py-2 text-xs leading-relaxed text-text shadow-lg"
        >
          {children}
          <Tooltip.Arrow className="fill-border" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** A label with its tip, for a column header or a legend where there is no input to wrap. */
export function LabelWithTip({
  label,
  tip,
  className,
}: {
  label: string;
  tip: ReactNode;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1 ${className ?? ''}`}>
      {label}
      <InfoTip label={label}>{tip}</InfoTip>
    </span>
  );
}

/**
 * A labelled input with an optional hint, tip and error. The input is `children`; give it
 * `id={id}` and `aria-describedby={describedBy(id, { hint: …, error: … })}`.
 * `compact` is for the one-line add rows: small muted label, no hint line. `footer` goes last.
 */
export function Field({
  id,
  label,
  tip,
  hint,
  error,
  compact = false,
  disabled = false,
  className,
  footer,
  children,
}: {
  id: string;
  label: string;
  tip?: ReactNode;
  hint?: ReactNode;
  error?: string;
  /** Rendered last, under the hint and error: a default value, a reset link. */
  footer?: ReactNode;
  compact?: boolean;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`flex flex-col gap-1 ${disabled ? 'opacity-60' : ''} ${className ?? ''}`}
      data-disabled={disabled || undefined}
    >
      <div className="flex items-center gap-1">
        <label
          htmlFor={id}
          className={compact ? 'text-xs text-text-muted' : 'text-sm font-medium text-text'}
        >
          {label}
        </label>
        {tip !== undefined ? <InfoTip label={label}>{tip}</InfoTip> : null}
      </div>
      {children}
      {hint !== undefined && !compact ? (
        <p id={hintIdFor(id)} className="text-xs text-text-muted">
          {hint}
        </p>
      ) : null}
      {error !== undefined ? (
        <p id={errorIdFor(id)} role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
      {footer}
    </div>
  );
}

/** A checkbox with its label to the right, and the hint indented under the label. */
export function CheckField({
  id,
  label,
  tip,
  hint,
  disabled = false,
  children,
}: {
  id: string;
  label: string;
  tip?: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`flex flex-col gap-1 ${disabled ? 'opacity-60' : ''}`}>
      <div className="flex items-center gap-2">
        {children}
        <label htmlFor={id} className="text-sm font-medium text-text">
          {label}
        </label>
        {tip !== undefined ? <InfoTip label={label}>{tip}</InfoTip> : null}
      </div>
      {hint !== undefined ? (
        <p id={hintIdFor(id)} className="pl-6 text-xs text-text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
