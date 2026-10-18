/**
 * "How to read the grid": the paragraph that explains the counts, outlines and marks. It sat
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
        A number beside a name or in a day's header counts that nurse's or that day's rule breaks:
        red with ⬣ for hard breaks the schedule must fix, amber with ▲ for warnings it can accept;
        the full list is under the Violations pill above the grid. On a shift, a solid red outline
        is a hard break and a dashed amber one a warning; C marks the charge nurse, 🔒 a shift kept
        through every Generate, ♡ a shift against what the nurse asked for, and +1.5h a holdover.
        While previewing an option, outlined shifts differ from the draft. A row marked Inactive is
        a nurse who has left but still holds shifts — move or remove them. The Staffing row counts
        the people each day is short; open it by shift for staffed / needed, where RN+LPN is a
        pooled licensed ratio.
      </p>
    </details>
  );
}
