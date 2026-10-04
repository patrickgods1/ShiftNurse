/**
 * Reporting a call-off is the entry point to the whole day-of flow, so it stays a one-field
 * confirmation — nurse, shift and date for context, an optional reason — built on the same
 * `ReasonDialog` the Requests screens use rather than a bespoke modal. The caller keys it on
 * the assignment id, so picking a different nurse remounts it with fresh mutation state — no
 * effect has to reset a stale error by hand.
 *
 * Staff call-offs are usually paid from sick leave, and paid sick hours count toward the nurse's
 * contracted hours once the shift is covered — so the box starts ticked for employees and
 * unticked for per-diem and travel nurses, who accrue none.
 */

import type { RosterEntryView } from '@shared/api.js';
import type { Id, IsoDate, ShiftType } from '@shiftnurse/core';
import { useState } from 'react';
import { useReportCallOff } from '../../api-dayof.js';
import { formatDateWithWeekday } from '../../format.js';
import { ReasonDialog } from '../requests/reason-dialog.js';

interface ReportCallOffDialogProps {
  unitId: Id;
  entry: RosterEntryView | undefined;
  /** False keeps `entry` for the title while Radix closes and returns focus to the trigger. */
  open?: boolean;
  shiftType: ShiftType;
  date: IsoDate;
  onClose: () => void;
  /** Called with the new call-off's id once it is saved, so the page can bring its card into view. */
  onReported?: (callOffId: Id) => void;
}

export function ReportCallOffDialog({
  unitId,
  entry,
  open = true,
  shiftType,
  date,
  onClose,
  onReported,
}: ReportCallOffDialogProps) {
  const reportCallOff = useReportCallOff(unitId);
  const employee =
    entry?.nurse.employmentType === 'full_time' || entry?.nurse.employmentType === 'part_time';
  const [paidSick, setPaidSick] = useState(employee);

  return (
    <ReasonDialog
      open={entry !== undefined && open}
      onOpenChange={(next) => !next && onClose()}
      title={
        entry
          ? `Report call-off — ${entry.nurse.lastName}, ${entry.nurse.firstName}`
          : 'Report call-off'
      }
      description={
        entry
          ? `${shiftType.abbreviation} ${shiftType.name} · ${formatDateWithWeekday(date)}`
          : undefined
      }
      confirmLabel="Report call-off"
      required={false}
      pending={reportCallOff.isPending}
      error={reportCallOff.error}
      onConfirm={(reason) => {
        if (!entry) return;
        reportCallOff.mutate(
          {
            assignmentId: entry.assignment.id,
            ...(reason ? { reason } : {}),
            ...(paidSick ? { paidSickHours: shiftType.durationHours } : {}),
          },
          {
            onSuccess: (callOff) => {
              onClose();
              onReported?.(callOff.id);
            },
          },
        );
      }}
    >
      <label className="flex items-center gap-2 text-sm text-text">
        <input
          type="checkbox"
          checked={paidSick}
          onChange={(e) => setPaidSick(e.target.checked)}
          data-testid="paid-sick"
        />
        Paid from sick leave ({shiftType.durationHours}h, counts toward contracted hours)
      </label>
    </ReasonDialog>
  );
}
