/**
 * "Why?" as a modal. Denials, withdrawn approvals and applied resolutions all need a reason the
 * database will refuse to proceed without, so the confirm button stays disabled until one is
 * typed — the form and the repository enforce the same rule, and the form just says so first.
 */

import * as Dialog from '@radix-ui/react-dialog';
import { type ReactNode, useEffect, useState } from 'react';
import { DANGER, DIALOG, errorMessage, INPUT, LABEL, PRIMARY, SECONDARY } from './ui.js';

interface ReasonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  /** Destructive confirms (deny, withdraw) render in the danger style. */
  destructive?: boolean;
  /** When false the reason is optional and the confirm button is always enabled. */
  required?: boolean;
  pending: boolean;
  error: unknown;
  onConfirm: (reason: string) => void;
}

export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive = false,
  required = true,
  pending,
  error,
  onConfirm,
}: ReasonDialogProps) {
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  const canConfirm = !pending && (!required || reason.trim().length > 0);
  const message = errorMessage(error);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content data-testid="reason-dialog" className={`${DIALOG} w-[28rem]`}>
          <Dialog.Title className="text-base font-semibold text-text">{title}</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-text-muted">
            {description ??
              'This reason is written to the audit log and quoted if the decision is challenged.'}
          </Dialog.Description>
          <form
            className="mt-4 flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (canConfirm) onConfirm(reason.trim());
            }}
          >
            <label className={LABEL}>
              Reason{required ? '' : ' (optional)'}
              <textarea
                className={`${INPUT} min-h-20`}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required={required}
                // biome-ignore lint/a11y/noAutofocus: the dialog exists to collect this one field.
                autoFocus
              />
            </label>
            {message !== undefined ? (
              <p role="alert" className="text-sm text-danger">
                {message}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <button type="button" className={SECONDARY} disabled={pending}>
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="submit"
                className={destructive ? DANGER : PRIMARY}
                disabled={!canConfirm}
              >
                {pending ? 'Saving…' : confirmLabel}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
