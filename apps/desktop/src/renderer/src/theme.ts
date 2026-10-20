/**
 * Theme persistence and the one store behind every toggle, isolated from the component so
 * `main.tsx` (applying the saved theme before first paint, avoiding a flash) and each mounted
 * `ThemeToggle` share one source of truth. Per-toggle state let the header and Settings buttons
 * disagree, and applying a theme on mount pinned `data-theme` and silently stopped following the
 * OS; here nothing is written until the manager chooses.
 */

import { useSyncExternalStore } from 'react';

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

const DARK_QUERY = '(prefers-color-scheme: dark)';

export function systemPrefersDark(): boolean {
  return window.matchMedia?.(DARK_QUERY).matches ?? false;
}

/** The theme on screen now: the stored choice, else the OS's. */
export function effectiveTheme(): Theme {
  return loadStoredTheme() ?? (systemPrefersDark() ? 'dark' : 'light');
}

const listeners = new Set<() => void>();
let detach: (() => void) | undefined;

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function attach(): () => void {
  const media = window.matchMedia?.(DARK_QUERY);
  media?.addEventListener('change', notify);
  // Another window choosing a theme changes localStorage under this one.
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== STORAGE_KEY) return;
    // With no stored choice this removes data-theme, handing control back to the CSS media query.
    applyTheme(loadStoredTheme());
    notify();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    media?.removeEventListener('change', notify);
    window.removeEventListener('storage', onStorage);
  };
}

/** Notifies on a choice, an OS change, or another window's storage change. */
export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  // Listening only while someone is subscribed keeps the OS listener from outliving the UI.
  if (listeners.size === 1) detach = attach();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      detach?.();
      detach = undefined;
    }
  };
}

/** The manager's choice: store it, apply data-theme, notify every subscriber. */
export function chooseTheme(theme: Theme): void {
  storeTheme(theme);
  applyTheme(theme);
  notify();
}

export function useEffectiveTheme(): Theme {
  return useSyncExternalStore(subscribeTheme, effectiveTheme);
}
