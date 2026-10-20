/**
 * Says in words when the database sits on a redirected or network folder (D24). SQLite can be
 * damaged there, and nothing else would tell the manager. Settings › About keeps the text after
 * "Not now" hides this for the session.
 */

import { useState } from 'react';
import { useAppInfo } from '../api.js';

export function DataLocationBanner() {
  const { data } = useAppInfo();
  const [dismissed, setDismissed] = useState(false);
  if (!data?.dataLocationWarning || dismissed) return null;

  return (
    <output className="flex items-center gap-3 border-b border-border bg-accent/10 px-4 py-2 text-sm text-text">
      <span>{data.dataLocationWarning}</span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="ml-auto text-xs text-text-muted hover:text-text"
      >
        Not now
      </button>
    </output>
  );
}
