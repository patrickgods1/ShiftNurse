/**
 * The shell every dialog was composing by hand: Radix Root/Portal/Overlay/Content with a title
 * and description. Radix keeps the focus trap, focus return and Escape; this only fixes the
 * look, so a dialog that drifts (a missing overlay, a title with no description for screen
 * readers) is a prop away from the rest instead of a copy of 22 files.
 *
 * `children` render directly under the description with no wrapper, so a form inside keeps the
 * `mt-4` the dialogs already give it. `footer` is for a plain right-aligned action row; a form
 * whose submit button must live inside the `<form>` puts its own row in `children` instead.
 */

import * as Dialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { ToastOutlet } from './toast.js';
import { DIALOG, OVERLAY, POPUP } from './ui.js';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';
export type ModalVariant = 'popup' | 'dialog';

// Literal class names, so Tailwind sees them. The widths are the ones the dialogs used.
const WIDTHS: Record<ModalVariant, Record<ModalSize, string>> = {
  popup: { sm: 'w-[360px]', md: 'w-[420px]', lg: 'w-[520px]', xl: 'w-[720px]' },
  dialog: { sm: 'w-[26rem]', md: 'w-[32rem]', lg: 'w-[40rem]', xl: 'w-[60rem]' },
};

export interface ModalProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: ReactNode;
  description?: ReactNode;
  size?: ModalSize;
  variant?: ModalVariant;
  footer?: ReactNode;
  children?: ReactNode;
  'data-testid'?: string;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  onInteractOutside?: (event: Event) => void;
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  size = 'md',
  variant = 'dialog',
  footer,
  children,
  'data-testid': testId,
  onEscapeKeyDown,
  onInteractOutside,
}: ModalProps) {
  // A popup holds short content, but a tall one must scroll rather than run off the screen.
  const frame = variant === 'popup' ? `${POPUP} max-h-[calc(100vh-2rem)] overflow-y-auto` : DIALOG;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY} />
        <Dialog.Content
          data-testid={testId}
          className={`${frame} ${WIDTHS[variant][size]}`}
          onEscapeKeyDown={onEscapeKeyDown}
          onInteractOutside={onInteractOutside}
          // Without a description Radix warns; opting out says the dialog has none on purpose.
          {...(description === undefined ? { 'aria-describedby': undefined } : {})}
        >
          <Dialog.Title className="text-base font-semibold text-text">{title}</Dialog.Title>
          {description !== undefined ? (
            <Dialog.Description className="mt-1 text-sm text-text-muted">
              {description}
            </Dialog.Description>
          ) : null}
          {children}
          {footer !== undefined ? (
            <div className="mt-4 flex justify-end gap-2">{footer}</div>
          ) : null}
          {/* Radix aria-hides everything outside a modal, and a click on a toast out there would
              count as an outside click: raised inside, toasts are announced and safe to press. */}
          <ToastOutlet />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
