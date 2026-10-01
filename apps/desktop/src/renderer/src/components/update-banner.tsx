/**
 * "ShiftNurse 0.2.0 is available." Builds cannot update themselves (they are unsigned), so the
 * manager is pointed at the release page to download it. The link opens in the system browser
 * through main's window-open handler, which allows only https.
 */

import { useState } from 'react';
import { useAvailableUpdate } from '../api.js';

export function UpdateBanner() {
  const { data: update } = useAvailableUpdate();
  const [dismissed, setDismissed] = useState(false);
  if (!update || dismissed) return null;

  return (
    <output className="flex items-center gap-3 border-b border-border bg-accent/10 px-4 py-2 text-sm text-text">
      <span>
        ShiftNurse {update.version} is available. Install it the same way as this version; your data
        stays where it is.
      </span>
      <a
        href={update.url}
        target="_blank"
        rel="noreferrer"
        className="font-medium text-accent underline underline-offset-2"
      >
        Download
      </a>
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
