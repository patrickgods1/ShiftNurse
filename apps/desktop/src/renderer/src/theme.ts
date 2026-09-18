/**
 * Theme persistence, isolated from the toggle component so both `main.tsx` (applying the saved
 * theme before first paint, avoiding a flash) and `theme-toggle.tsx` (changing it later) share
 * one source of truth for the localStorage key and fallback behaviour.
 */

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'shiftnurse.theme';

export function loadStoredTheme(): Theme | undefined {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : undefined;
  } catch {
    // Private browsing / blocked storage: fall back to the OS preference every time.
    return undefined;
  }
}

export function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Nothing to do — the toggle still works for this session, it just won't persist.
  }
}

export function applyTheme(theme: Theme | undefined): void {
  const root = document.documentElement;
  if (theme === undefined) {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
}
