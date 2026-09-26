/**
 * Keyboard behaviour for a non-modal panel or popover that is not a Radix dialog (the roster's
 * nurse-detail drawer, a census cell's editor): focus moves into it when it opens, Escape closes
 * it, and focus goes back to whatever opened it. Without these a keyboard user who opened one had
 * no way out but tabbing through the whole page, and landed nowhere in particular when it closed.
 *
 * Escape is only taken while focus is inside the panel (or nowhere): a Radix dialog opened on top
 * of it traps focus in its own portal, and Escape there belongs to that dialog alone.
 */

import { type RefObject, useEffect, useRef } from 'react';

const FOCUSABLE = 'input, select, textarea, button, [tabindex]:not([tabindex="-1"])';

export function usePanelFocus(
  containerRef: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    containerRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target as Node | null;
      const inside = target !== null && containerRef.current?.contains(target);
      if (!inside && target !== document.body) return;
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      // Only if focus is still in the panel (or was dropped with it): never steal it back from
      // somewhere the user has since moved to.
      const active = document.activeElement;
      if (active === null || active === document.body || containerRef.current?.contains(active)) {
        previous?.focus();
      }
    };
  }, [open, containerRef]);
}
