/**
 * The day-of console: what a published schedule meets on the ground. One read (`dayOf.today`)
 * drives the whole page — current/next shifts with their live staffing check, and every open
 * call-off on the unit — so a manager watching an 05:40 call-out sees the same picture the
 * replacement finder is judging against, not a stale grid.
 */

import { useToday } from '../api-dayof.js';
import { AsyncState } from '../components/async-state.js';
import { PageHeader } from '../components/page-header.js';
import { StatCard } from '../components/stat-card.js';
import { formatDateWithWeekday } from '../format.js';
import { useUnitId } from '../unit-context.js';
import { CallOffCard } from './today/call-off-card.js';
import { ShiftCard } from './today/shift-card.js';

/** "0" -> "00". `minuteOfDay` comes from the host clock read in main; this only pads for display. */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatClock(minuteOfDay: number): string {
  const hours = Math.floor(minuteOfDay / 60) % 24;
  const minutes = minuteOfDay % 60;
  return `${pad2(hours)}:${pad2(minutes)}`;
}

export default function TodayPage() {
  const unitId = useUnitId();
  const todayQuery = useToday(unitId);

  if (todayQuery.isPending) {
    return <AsyncState status="loading" label="Loading today" />;
  }
  if (todayQuery.isError) {
    return <AsyncState status="error" label="Could not load today" error={todayQuery.error} />;
  }
  const summary = todayQuery.data;

  const onShiftNow = summary.shifts
    .filter((s) => s.status === 'current')
    .reduce((total, s) => total + s.roster.length, 0);
  const shortShifts = summary.shifts.filter((s) => s.staffing.short);
  const anyRatioBreached = summary.shifts.some((s) => s.staffing.ratioBreached);

  return (
    <div data-testid="today-page">
      <PageHeader
        title="Today"
        description={`${formatDateWithWeekday(summary.date)} · ${formatClock(summary.minuteOfDay)}`}
      />

      {summary.period === undefined ? (
        <div className="mb-4">
          <AsyncState status="empty" label="No schedule covers today." />
        </div>
      ) : null}

      <div className="grid grid-cols-3 gap-4">
        <StatCard label="On shift now" value={onShiftNow} />
        <StatCard
          label="Open call-offs"
          value={summary.openCallOffs.length}
          tone={summary.openCallOffs.length > 0 ? 'danger' : 'neutral'}
        />
        <StatCard
          label="Short shifts today"
          value={shortShifts.length}
          tone={anyRatioBreached ? 'danger' : shortShifts.length > 0 ? 'warn' : 'neutral'}
        />
      </div>

      <div className="mt-6 flex flex-col gap-4" data-testid="today-shifts">
        {summary.shifts.map((shift) => (
          <ShiftCard key={`${shift.date}-${shift.shiftType.id}`} unitId={unitId} shift={shift} />
        ))}
      </div>

      <div className="mt-6">
        <h2 className="mb-2 text-sm font-semibold text-text">Open call-offs</h2>
        <div className="flex flex-col gap-4" data-testid="call-offs-panel">
          {summary.openCallOffs.length === 0 ? (
            <p className="text-sm text-text-muted">No open call-offs.</p>
          ) : (
            summary.openCallOffs.map((callOff) => (
              <CallOffCard key={callOff.callOff.id} unitId={unitId} callOff={callOff} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
