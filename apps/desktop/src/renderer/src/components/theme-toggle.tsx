/**
 * Light/dark override. Absent a click the app follows `prefers-color-scheme`, live; a click
 * writes an explicit `data-theme` that wins and survives a restart. Both toggles read one store
 * (`theme.ts`).
 */

import { chooseTheme, type Theme, useEffectiveTheme } from '../theme.js';

export function ThemeToggle() {
  const theme = useEffectiveTheme();

  return (
    <button
      type="button"
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      className="rounded-md border border-border bg-surface px-2 py-1 text-sm text-text
        hover:bg-bg"
      onClick={() => {
        const next: Theme = theme === 'dark' ? 'light' : 'dark';
        chooseTheme(next);
      }}
    >
      {theme === 'dark' ? '☀️ Light' : '🌙 Dark'}
    </button>
  );
}
