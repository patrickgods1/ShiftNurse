/**
 * The shell every dialog was composing by hand: Radix Root/Portal/Overlay/Content with a title
 * and description. Radix keeps the focus trap and Escape; focus return is ours, because Radix
 * returns focus only to a `Dialog.Trigger` and every dialog here opens from state. Otherwise this
 * only fixes the look, so a dialog that drifts (a missing overlay, a title with no description
 * for screen readers) is a prop away from the rest instead of a copy of 22 files.
 *
 * `children` render directly under the description with no wrapper, so a form inside keeps the
 * `mt-4` the dialogs already give it. `footer` is for a plain right-aligned action row; a form
 * whose submit button must live inside the `<form>` puts its own row in `children` instead.
 */

import * as Dialog from '@radix-ui/react-dialog';
import { type ReactNode, useLayoutEffect, useRef } from 'react';
import { restoreFocus } from './focus.js';
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
  /** Where focus goes when the dialog closes, resolved at close time; when it returns nothing focusable, focus goes back to the control that opened the dialog. */
  returnFocus?: () => HTMLElement | null | undefined;
  /** 'alertdialog' for a question that must be answered (the confirm). Default 'dialog'. */
  role?: 'dialog' | 'alertdialog';
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
  returnFocus,
  role = 'dialog',
}: ModalProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  // A layout effect runs before FocusScope's own effect moves focus in, so the opener is still the
  // active element. The containment check stops StrictMode's re-run from capturing an element
  // inside the dialog once focus has moved there.
  useLayoutEffect(() => {
    if (!open || opener.current !== null) return;
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active !== document.body &&
      !contentRef.current?.contains(active)
    ) {
      opener.current = active;
    }
  }, [open]);

  // A popup holds short content, but a tall one must scroll rather than run off the screen.
  const frame = variant === 'popup' ? `${POPUP} max-h-[calc(100vh-2rem)] overflow-y-auto` : DIALOG;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY} />
        <Dialog.Content
          ref={contentRef}
          role={role}
          data-testid={testId}
          className={`${frame} ${WIDTHS[variant][size]}`}
          onEscapeKeyDown={onEscapeKeyDown}
          onInteractOutside={onInteractOutside}
          // Radix's own handler would focus a trigger we never render and leave focus on body.
          // This is the one hook that runs after FocusScope's deferred unmount, so focus set here
          // is not overridden a tick later.
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const previous = opener.current;
            opener.current = null;
            restoreFocus(returnFocus?.(), previous);
          }}
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
            <div className="mt-4 flex flex-wrap justify-end gap-2">{footer}</div>
          ) : null}
          {/* Radix aria-hides everything outside a modal, and a click on a toast out there would
              count as an outside click: raised inside, toasts are announced and safe to press. */}
          <ToastOutlet />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
