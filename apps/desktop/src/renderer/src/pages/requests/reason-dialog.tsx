/**
 * "Why?" as a modal. Denials, withdrawn approvals and applied resolutions all need a reason the
 * database will refuse to proceed without, so the confirm button stays disabled until one is
 * typed — the form and the repository enforce the same rule, and the form just says so first.
 */

import { type ReactNode, useEffect, useState } from 'react';
import { Modal } from '../../components/modal.js';
import { DANGER, errorMessage, INPUT, LABEL, PRIMARY, SECONDARY } from '../../components/ui.js';

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
  /** Extra fields shown under the reason, for dialogs that record more than the reason. */
  children?: ReactNode;
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
  children,
}: ReasonDialogProps) {
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  const canConfirm = !pending && (!required || reason.trim().length > 0);
  const message = errorMessage(error);

  return (
    <Modal
      open={open}
      onOpenChange={(next) => !pending && onOpenChange(next)}
      data-testid="reason-dialog"
      size="sm"
      title={title}
      description={
        description ??
        'This reason is written to the audit log and quoted if the decision is challenged.'
      }
    >
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
        {children}
        {message !== undefined ? (
          <p role="alert" className="text-sm text-danger">
            {message}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className={SECONDARY}
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </button>
          <button type="submit" className={destructive ? DANGER : PRIMARY} disabled={!canConfirm}>
            {pending ? 'Saving…' : confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
