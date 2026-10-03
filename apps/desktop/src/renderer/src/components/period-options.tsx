/**
 * The `<option>`s of every period picker. Periods are labelled by their dates (`periodLabel`),
 * and grouped so the schedules a manager is working on sit above months of past pay periods
 * — the demo unit alone has fourteen of those.
 */

import { type SchedulePeriod, today } from '@shiftnurse/core';
import { periodLabel } from '../format.js';

export function PeriodOptions({ periods }: { periods: readonly SchedulePeriod[] }) {
  const now = today();
  const current = periods.filter((p) => p.endDate >= now);
  const past = periods.filter((p) => p.endDate < now);
  const option = (p: SchedulePeriod) => (
    <option key={p.id} value={p.id}>
      {periodLabel(p)}
      {p.status === 'draft' ? ' — draft' : ''}
    </option>
  );
  if (current.length === 0 || past.length === 0) return <>{periods.map(option)}</>;
  return (
    <>
      <optgroup label="Current and upcoming">{current.map(option)}</optgroup>
      <optgroup label="Past schedules">{past.map(option)}</optgroup>
    </>
  );
}
