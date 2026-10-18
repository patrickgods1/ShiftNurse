/**
 * The app's one confirmation dialog, called like `window.confirm` but awaited:
 *
 *   const confirm = useConfirm();
 *   if (await confirm({ title: 'Remove this assignment?', confirmLabel: 'Remove' })) …
 *
 * `window.confirm` draws a native box titled with the app's URL, cannot be styled or themed,
 * blocks the renderer while open, and names its buttons "OK"/"Cancel" — which reads badly for
 * "Delete this pay rate?". This one is rendered through `Modal`, so focus is trapped and
 * returned and failures raised while it is open appear inside it; Escape cancels, and the
 * destructive button says what it does.
 */

import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from 'react';
import { Modal } from './modal.js';
import { DANGER, PRIMARY, SECONDARY } from './ui.js';

export interface ConfirmOptions {
  title: string;
  /** One or two sentences on what happens, when the title alone does not say it. */
  description?: string;
  /** The confirming button's label: a verb, e.g. "Delete". Defaults to "Confirm". */
  confirmLabel?: string;
  /** Styles the confirming button as destructive. Defaults to true: most confirms are deletes. */
  danger?: boolean;
  /** Where focus goes on close when the control that asked may be gone (a chip being deleted). */
  returnFocus?: () => HTMLElement | null | undefined;
}

type Confirm = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Confirm | undefined>(undefined);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | undefined>(undefined);
  const resolver = useRef<((answer: boolean) => void) | undefined>(undefined);
  // `options` is already cleared by the time the dialog's close focus runs, so the latest
  // question's target is kept here until then.
  const returnFocus = useRef<ConfirmOptions['returnFocus']>(undefined);

  const confirm = useCallback<Confirm>((next) => {
    // A second confirm while one is open answers the first "no" rather than leaving it hanging.
    resolver.current?.(false);
    returnFocus.current = next.returnFocus;
    setOptions(next);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const answer = (value: boolean) => {
    resolver.current?.(value);
    resolver.current = undefined;
    setOptions(undefined);
  };

  const danger = options?.danger ?? true;
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={options !== undefined}
        onOpenChange={(open) => !open && answer(false)}
        variant="popup"
        size="sm"
        role="alertdialog"
        title={options?.title ?? ''}
        // Without a description the title is read again, as before, so the question is announced.
        description={
          options?.description ? (
            options.description
          ) : (
            <span className="sr-only">{options?.title}</span>
          )
        }
        returnFocus={() => returnFocus.current?.()}
        footer={
          <>
            <button type="button" className={SECONDARY} onClick={() => answer(false)}>
              Cancel
            </button>
            <button
              type="button"
              data-testid="confirm-accept"
              className={danger ? DANGER : PRIMARY}
              onClick={() => answer(true)}
            >
              {options?.confirmLabel ?? 'Confirm'}
            </button>
          </>
        }
      />
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): Confirm {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm must be used within a ConfirmProvider');
  return confirm;
}
