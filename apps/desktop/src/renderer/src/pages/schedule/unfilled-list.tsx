/**
 * The shifts an option leaves below their floor, in a manager's words. A count ("3 floors short")
 * sent the manager hunting the grid for Saturday night; naming the shift and the role is what
 * lets them decide whether to save the option or generate again. Only the first 50 reach the
 * renderer, so beyond what is listed the full count says how many more there are.
 */

import type { SolveRunSummary } from '@shared/api.js';
import { Link } from '@tanstack/react-router';
import { useShiftTypes } from '../../api.js';
import { formatDateWithWeekday } from '../../format.js';
import { useUnitId } from '../../unit-context.js';

/** Lines shown before "and N more": a short list reads at a glance, a long one is a second grid. */
const MAX_LINES = 8;

export function UnfilledList({
  summary,
}: {
  summary: Pick<SolveRunSummary, 'unfilled' | 'unfilledSlots'>;
}) {
  const shiftTypes = useShiftTypes(useUnitId());
  if (summary.unfilledSlots === 0) return null;

  const names = new Map((shiftTypes.data ?? []).map((st) => [st.id, st.name]));
  // One line per shift: a night short an RN and an LVN is one gap to the manager, not two.
  const lines: { key: string; date: string; shift: string; short: string[] }[] = [];
  for (const slot of summary.unfilled) {
    const key = `${slot.date}|${slot.shiftTypeId}`;
    // A short pool can be filled by either an RN or an LVN, so it says so.
    const text =
      slot.role === 'licensed'
        ? `${slot.shortfall} licensed nurse${slot.shortfall === 1 ? '' : 's'} (RN or LVN)`
        : `${slot.shortfall} ${slot.role}`;
    const line = lines.find((l) => l.key === key);
    if (line) line.short.push(text);
    else
      lines.push({
        key,
        date: slot.date,
        shift: names.get(slot.shiftTypeId) ?? 'Shift',
        short: [text],
      });
  }
  const shown = lines.slice(0, MAX_LINES);
  // Slots, not lines, so the remainder also counts what the 50-row cap left out of the status.
  const listedSlots = shown.reduce((sum, l) => sum + l.short.length, 0);
  const more = summary.unfilledSlots - listedSlots;

  return (
    <div data-testid="unfilled-list" className="mt-2 text-xs text-text">
      <ul className="list-disc pl-5">
        {shown.map((l) => (
          <li key={l.key}>
            {formatDateWithWeekday(l.date)}, {l.shift}: short {l.short.join(', ')}
          </li>
        ))}
        {more > 0 ? <li className="text-text-muted">and {more} more</li> : null}
      </ul>
      <p className="mt-1 text-text-muted">
        <Link to="/requests" className="text-accent underline">
          Requests › Conflicts ranks ways to cover them once you save
        </Link>
      </p>
    </div>
  );
}
