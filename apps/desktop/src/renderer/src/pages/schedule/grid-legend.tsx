/**
 * "How to read the grid": the paragraph that explains the red counts and chip marks. It sat
 * above the grid on every visit and cost a row of a small screen, yet a manager needs it once.
 * Closed by default, and remembered per viewer so someone who wants it open keeps it open.
 */

import { useState } from 'react';

const KEY = 'shiftnurse.gridLegendOpen';

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    // Storage can be unavailable; the legend then simply starts closed.
    return false;
  }
}

export function GridLegend() {
  const [open, setOpen] = useState(readOpen);

  return (
    <details
      data-testid="grid-legend"
      open={open}
      onToggle={(e) => {
        const next = e.currentTarget.open;
        setOpen(next);
        try {
          window.localStorage.setItem(KEY, next ? '1' : '0');
        } catch {
          // Not remembering is harmless.
        }
      }}
      className="mb-2 text-xs text-text-muted"
    >
      <summary className="w-fit cursor-pointer select-none underline-offset-2 hover:underline">
        How to read the grid
      </summary>
      <p className="mt-1">
        A red number counts rule breaks: in a day's header for that day, beside a name for that
        nurse — hover it to read them. On a shift, C marks the charge nurse and ♡ a shift that goes
        against what the nurse asked for. The Staffing row under the grid counts the people each day
        is short; open it by shift for staffed / needed.
      </p>
    </details>
  );
}
