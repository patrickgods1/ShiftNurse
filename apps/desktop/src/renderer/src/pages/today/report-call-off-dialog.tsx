/**
 * Reporting a call-off is the entry point to the whole day-of flow, so it stays a one-field
 * confirmation — nurse, shift and date for context, an optional reason — built on the same
 * `ReasonDialog` the Requests screens use rather than a bespoke modal. The caller keys it on
 * the assignment id, so picking a different nurse remounts it with fresh mutation state — no
 * effect has to reset a stale error by hand.
 */

import type { RosterEntryView } from '@shared/api.js';
import type { Id, IsoDate, ShiftType } from '@shiftnurse/core';
import { useReportCallOff } from '../../api-dayof.js';
import { formatDateWithWeekday } from '../../format.js';
import { ReasonDialog } from '../requests/reason-dialog.js';

interface ReportCallOffDialogProps {
  unitId: Id;
  entry: RosterEntryView | undefined;
  shiftType: ShiftType;
  date: IsoDate;
  onClose: () => void;
}

export function ReportCallOffDialog({
  unitId,
  entry,
  shiftType,
  date,
  onClose,
}: ReportCallOffDialogProps) {
  const reportCallOff = useReportCallOff(unitId);

  return (
    <ReasonDialog
      open={entry !== undefined}
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
          { assignmentId: entry.assignment.id, ...(reason ? { reason } : {}) },
          { onSuccess: onClose },
        );
      }}
    />
  );
}
