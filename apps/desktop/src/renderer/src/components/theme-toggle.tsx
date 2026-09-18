/**
 * Light/dark override. Absent a click, the app follows `prefers-color-scheme` (see styles.css);
 * this writes an explicit `data-theme` that wins over the OS setting and survives a restart.
 */

import { useEffect, useState } from 'react';
import { applyTheme, loadStoredTheme, storeTheme, type Theme } from '../theme.js';

function systemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(
    () => loadStoredTheme() ?? (systemPrefersDark() ? 'dark' : 'light'),
  );

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return (
    <button
      type="button"
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      className="rounded-md border border-border bg-surface px-2 py-1 text-sm text-text
        hover:bg-bg"
      onClick={() => {
        const next: Theme = theme === 'dark' ? 'light' : 'dark';
        setTheme(next);
        storeTheme(next);
      }}
    >
      {theme === 'dark' ? '☀️ Light' : '🌙 Dark'}
    </button>
  );
}
