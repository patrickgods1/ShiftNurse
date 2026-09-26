/**
 * The app's one confirmation dialog, called like `window.confirm` but awaited:
 *
 *   const confirm = useConfirm();
 *   if (await confirm({ title: 'Remove this assignment?', confirmLabel: 'Remove' })) …
 *
 * `window.confirm` draws a native box titled with the app's URL, cannot be styled or themed,
 * blocks the renderer while open, and names its buttons "OK"/"Cancel" — which reads badly for
 * "Delete this pay rate?". This one uses the same Radix dialog as the rest of the app, so focus
 * is trapped and returned, Escape cancels, and the destructive button says what it does.
 */

import * as Dialog from '@radix-ui/react-dialog';
import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from 'react';
import { DANGER, OVERLAY, POPUP, PRIMARY, SECONDARY } from './ui.js';

export interface ConfirmOptions {
  title: string;
  /** One or two sentences on what happens, when the title alone does not say it. */
  description?: string;
  /** The confirming button's label: a verb, e.g. "Delete". Defaults to "Confirm". */
  confirmLabel?: string;
  /** Styles the confirming button as destructive. Defaults to true: most confirms are deletes. */
  danger?: boolean;
}

type Confirm = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Confirm | undefined>(undefined);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | undefined>(undefined);
  const resolver = useRef<((answer: boolean) => void) | undefined>(undefined);

  const confirm = useCallback<Confirm>((next) => {
    // A second confirm while one is open answers the first "no" rather than leaving it hanging.
    resolver.current?.(false);
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
      <Dialog.Root open={options !== undefined} onOpenChange={(open) => !open && answer(false)}>
        <Dialog.Portal>
          <Dialog.Overlay className={OVERLAY} />
          <Dialog.Content role="alertdialog" className={`${POPUP} w-[380px]`}>
            <Dialog.Title className="text-sm font-semibold text-text">
              {options?.title}
            </Dialog.Title>
            {options?.description ? (
              <Dialog.Description className="mt-2 text-sm text-text-muted">
                {options.description}
              </Dialog.Description>
            ) : (
              <Dialog.Description className="sr-only">{options?.title}</Dialog.Description>
            )}
            <div className="mt-4 flex justify-end gap-2">
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
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): Confirm {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm must be used within a ConfirmProvider');
  return confirm;
}
