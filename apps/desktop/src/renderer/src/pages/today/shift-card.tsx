/**
 * One shift on the Today screen: who is actually on it, whether that is enough for the census
 * the manager has entered (or, absent that, forecast or the coverage floor), and the one action
 * available from here — reporting a call-off. Everything else (replacements, call log) lives on
 * the call-off card once one exists.
 */

import type { RosterEntryView, TodayShiftView } from '@shared/api.js';
import type { Id, RoleStaffing } from '@shiftnurse/core';
import { useState } from 'react';
import { formatDateWithWeekday } from '../../format.js';
import { SMALL } from '../requests/ui.js';
import { CensusEntry } from './census-entry.js';
import { ReportCallOffDialog } from './report-call-off-dialog.js';

const STATUS_LABEL: Record<TodayShiftView['status'], string | undefined> = {
  current: 'Now',
  next: 'Next',
  other: undefined,
};

function basisLine(shift: TodayShiftView): string {
  if (shift.staffing.basis === 'actual') return `Actual census ${shift.staffing.census}`;
  if (shift.staffing.basis === 'forecast') return `Forecast census ${shift.staffing.census}`;
  return 'Coverage floor only';
}

function StaffingRow({ role }: { role: RoleStaffing }) {
  const short = role.shortfall > 0;
  return (
    <tr className={short ? 'text-danger' : 'text-text'}>
      <td className="px-3 py-1.5">
        {role.role}
        {role.bindingConstraint === 'ratio' || role.bindingConstraint === 'both' ? (
          <span className="ml-2 rounded bg-danger/15 px-1.5 py-0.5 text-xs font-semibold uppercase text-danger">
            ratio
          </span>
        ) : null}
      </td>
      <td className="px-3 py-1.5">{role.required}</td>
      <td className="px-3 py-1.5">{role.staffed}</td>
      <td className="px-3 py-1.5">{role.shortfall}</td>
    </tr>
  );
}

function rosterLabel(entry: RosterEntryView): string {
  return `${entry.nurse.lastName}, ${entry.nurse.firstName} (${entry.nurse.role})`;
}

export function ShiftCard({ unitId, shift }: { unitId: Id; shift: TodayShiftView }) {
  const [reporting, setReporting] = useState<RosterEntryView | undefined>(undefined);
  const statusLabel = STATUS_LABEL[shift.status];

  return (
    <div className="rounded-md border border-border bg-surface p-4">
      <div className="mb-2 flex items-center gap-2">
        <span
          aria-hidden
          className="h-3 w-3 rounded-full"
          style={{ backgroundColor: shift.shiftType.color }}
        />
        <span className="font-medium text-text">{shift.shiftType.abbreviation}</span>
        <span className="text-sm text-text-muted">{shift.shiftType.name}</span>
        <span className="text-sm text-text-muted">{formatDateWithWeekday(shift.date)}</span>
        {statusLabel !== undefined ? (
          <span className="rounded bg-accent/15 px-1.5 py-0.5 text-xs font-semibold uppercase text-accent">
            {statusLabel}
          </span>
        ) : null}
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-text-muted">
              <th scope="col" className="px-3 py-1.5 font-medium">
                Role
              </th>
              <th scope="col" className="px-3 py-1.5 font-medium">
                Required
              </th>
              <th scope="col" className="px-3 py-1.5 font-medium">
                Staffed
              </th>
              <th scope="col" className="px-3 py-1.5 font-medium">
                Shortfall
              </th>
            </tr>
          </thead>
          <tbody>
            {Object.values(shift.staffing.byRole).map((role) => (
              <StaffingRow key={role.role} role={role} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-xs text-text-muted">{basisLine(shift)}</p>

      <CensusEntry unitId={unitId} shift={shift} />

      <ul className="mt-3 flex flex-col gap-1 border-t border-border pt-3 text-sm">
        {shift.roster.map((entry) => (
          <li key={entry.assignment.id} className="flex items-center justify-between gap-2">
            <span className="text-text">
              {rosterLabel(entry)}
              {entry.assignment.isCharge ? (
                <span className="ml-2 text-xs uppercase text-text-muted">Charge</span>
              ) : null}
              {entry.assignment.isOvertime ? (
                <span className="ml-2 text-xs uppercase text-text-muted">OT</span>
              ) : null}
            </span>
            {entry.callOff !== undefined ? (
              <span className="rounded bg-danger/15 px-1.5 py-0.5 text-xs font-semibold uppercase text-danger">
                Called off
              </span>
            ) : (
              <button type="button" className={SMALL} onClick={() => setReporting(entry)}>
                Report call-off
              </button>
            )}
          </li>
        ))}
      </ul>

      <ReportCallOffDialog
        unitId={unitId}
        entry={reporting}
        shiftType={shift.shiftType}
        date={shift.date}
        onClose={() => setReporting(undefined)}
      />
    </div>
  );
}
