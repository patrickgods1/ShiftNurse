/**
 * Where keyboard focus can go, and putting it back. Dialogs and panels here open from state, not
 * from a Radix trigger, so nothing returns focus for them: without these, closing one drops focus
 * on `<body>` and the next Tab starts at the top of the page, losing the manager's place in the
 * grid. The checks matter because `.focus()` on a disabled, removed or inert element silently
 * does nothing — focus stays where it was and the keyboard user is stranded.
 */

/** Controls a keyboard user can reach with Tab: enabled form controls, buttons, links, explicit tab stops. */
export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * True when `el` can take programmatic focus now: an HTMLElement in the document, not disabled,
 * not under [inert]. tabIndex -1 counts (roving tab stops): a grid cell that is not the current
 * tab stop must still be refocusable.
 */
export function isFocusable(el: Element | null | undefined): el is HTMLElement {
  return (
    el instanceof HTMLElement &&
    el.isConnected &&
    !(el as HTMLButtonElement).disabled &&
    el.closest('[inert]') === null
  );
}

/** The first FOCUSABLE_SELECTOR match inside `container` that isFocusable, or undefined. */
export function firstFocusable(container: ParentNode | null | undefined): HTMLElement | undefined {
  if (!container) return undefined;
  for (const el of container.querySelectorAll(FOCUSABLE_SELECTOR)) {
    if (isFocusable(el)) return el;
  }
  return undefined;
}

/** Focuses the first candidate that isFocusable; returns whether one took focus. Never throws. */
export function restoreFocus(...candidates: readonly (HTMLElement | null | undefined)[]): boolean {
  for (const candidate of candidates) {
    if (isFocusable(candidate)) {
      candidate.focus();
      return true;
    }
  }
  return false;
}
