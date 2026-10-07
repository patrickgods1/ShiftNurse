/**
 * The day-of console: what a published schedule meets on the ground. One read (`dayOf.today`)
 * drives the whole page — current/next shifts with their live staffing check, and every open
 * call-off on the unit — so a manager watching an 05:40 call-out sees the same picture the
 * replacement finder is judging against, not a stale grid.
 */

import type { RosterEntryView, TodayShiftView } from '@shared/api.js';
import type { Id } from '@shiftnurse/core';
import { useEffect, useRef, useState } from 'react';
import { useToday } from '../api-dayof.js';
import { AsyncState } from '../components/async-state.js';
import { PageHeader } from '../components/page-header.js';
import { StatCard } from '../components/stat-card.js';
import { PRIMARY } from '../components/ui.js';
import { formatDateWithWeekday } from '../format.js';
import { useUnitId } from '../unit-context.js';
import { CallOffCard } from './today/call-off-card.js';
import { CallOffPicker } from './today/call-off-picker.js';
import { ReportCallOffDialog } from './today/report-call-off-dialog.js';
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
  const [picking, setPicking] = useState(false);
  const [reporting, setReporting] = useState<
    { entry: RosterEntryView; shift: TodayShiftView } | undefined
  >(undefined);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportedId, setReportedId] = useState<Id | undefined>(undefined);

  // The new card only exists once the invalidated read returns, so wait for it by id. Whatever
  // the first read after the report holds, the wait ends there: a card that never shows up must
  // not claim focus from a refetch minutes later.
  // `dataUpdatedAt`, not the list: an unchanged read keeps its reference (structural sharing).
  const readAt = todayQuery.dataUpdatedAt;
  const baseline = useRef<{ id: Id; readAt: number } | undefined>(undefined);
  useEffect(() => {
    if (reportedId === undefined) return;
    if (baseline.current?.id !== reportedId) baseline.current = { id: reportedId, readAt };
    const card = document.getElementById(`call-off-${reportedId}`);
    if (card !== null) {
      card.scrollIntoView?.({ block: 'center' });
      card.focus({ preventScroll: true });
      setReportedId(undefined);
    } else if (readAt !== baseline.current.readAt) {
      setReportedId(undefined);
    }
  }, [reportedId, readAt]);

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
        actions={
          <button
            type="button"
            className={PRIMARY}
            data-testid="someone-called-off"
            onClick={() => setPicking(true)}
          >
            Someone called off
          </button>
        }
      />

      {summary.period === undefined ? (
        <div className="mb-4 short:mb-2">
          <AsyncState status="empty" label="No schedule covers today." />
        </div>
      ) : null}

      <div className="grid grid-cols-3 gap-4 short:gap-2">
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
          <ShiftCard
            key={`${shift.date}-${shift.shiftType.id}`}
            unitId={unitId}
            periodId={summary.period?.id}
            periodStatus={summary.period?.status}
            shift={shift}
            onReport={(entry) => {
              setReporting({ entry, shift });
              setReportOpen(true);
            }}
          />
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

      <CallOffPicker
        open={picking}
        onOpenChange={setPicking}
        shifts={summary.shifts}
        onPick={(entry, shift) => {
          setPicking(false);
          setReporting({ entry, shift });
          setReportOpen(true);
        }}
      />
      {reporting !== undefined ? (
        <ReportCallOffDialog
          key={reporting.entry.assignment.id}
          unitId={unitId}
          entry={reporting.entry}
          open={reportOpen}
          shiftType={reporting.shift.shiftType}
          date={reporting.shift.date}
          onClose={() => setReportOpen(false)}
          onReported={setReportedId}
        />
      ) : null}
    </div>
  );
}
