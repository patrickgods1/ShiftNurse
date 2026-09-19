/**
 * Everything below the period picker for one scheduling period: the violation summary, the
 * palette, the grid, and the popover for editing a single assignment. Split out of `schedule.tsx`
 * (which only owns period selection) so remounting on period change — via `key={period.id}` at
 * the call site — cleanly resets all of this component's local drag/pending state instead of
 * needing to reconcile it against a different period's data.
 */

import type { Assignment, Id, IsoDate, SchedulePeriod, Violation } from '@shiftnurse/core';
import {
  datesInRange,
  violationsByAssignment as indexByAssignment,
  violationsByDate as indexByDate,
  violationsByNurse as indexByNurse,
  isWeekendDate,
  weekdayOf,
} from '@shiftnurse/core';
import { useCallback, useMemo, useState } from 'react';
import { useAssignments, useNurses, useShiftTypes } from '../../api.js';
import { useCostReport } from '../../api-cost.js';
import {
  useCreateAssignment,
  useDeleteAssignment,
  useMoveAssignment,
  useSetLocked,
  useUpdateAssignment,
  useValidation,
} from '../../api-schedule.js';
import { AsyncState } from '../../components/async-state.js';
import { AssignmentDialog } from './assignment-dialog.js';
import { CostSummary } from './cost-summary.js';
import { GenerateDialog } from './generate-dialog.js';
import type { GridColumn } from './grid.js';
import { ScheduleGrid } from './grid.js';
import { makePendingId } from './grid-utils.js';
import { ShiftPalette } from './palette.js';
import { ViolationSummary } from './violation-summary.js';

interface ScheduleBoardProps {
  unitId: Id;
  period: SchedulePeriod;
}

function makeGhost(
  periodId: Id,
  input: { nurseId: Id; date: IsoDate; shiftTypeId: Id },
): Assignment {
  return {
    id: makePendingId(),
    periodId,
    nurseId: input.nurseId,
    shiftTypeId: input.shiftTypeId,
    date: input.date,
    source: 'manual',
    isLocked: false,
    isCharge: false,
    isOvertime: false,
  };
}

export function ScheduleBoard({ unitId, period }: ScheduleBoardProps) {
  const nursesQuery = useNurses(unitId);
  const shiftTypesQuery = useShiftTypes(unitId);
  const assignmentsQuery = useAssignments(period.id);
  const validationQuery = useValidation(period.id);
  const costQuery = useCostReport(period.id);

  const createAssignment = useCreateAssignment(period.id, unitId);
  const moveAssignment = useMoveAssignment(period.id, unitId);
  const updateAssignment = useUpdateAssignment(period.id, unitId);
  const deleteAssignment = useDeleteAssignment(period.id, unitId);
  const setLocked = useSetLocked(period.id, unitId);

  const readOnly = period.status !== 'draft';

  const [pendingIds, setPendingIds] = useState<ReadonlySet<Id>>(new Set());
  const [pendingCreates, setPendingCreates] = useState<readonly Assignment[]>([]);
  const [openAssignmentId, setOpenAssignmentId] = useState<Id | undefined>(undefined);
  const [generateOpen, setGenerateOpen] = useState(false);

  const markPending = useCallback((id: Id) => {
    setPendingIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);
  const clearPending = useCallback((id: Id) => {
    setPendingIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const columns: GridColumn[] = useMemo(
    () =>
      datesInRange(period.startDate, period.endDate).map((date) => ({
        date,
        weekday: weekdayOf(date),
        isWeekend: isWeekendDate(date),
      })),
    [period.startDate, period.endDate],
  );

  const violationResult = validationQuery.data?.result;
  const violationsByAssignmentMap = useMemo(
    (): Map<Id, Violation[]> =>
      violationResult ? indexByAssignment(violationResult.violations) : new Map(),
    [violationResult],
  );
  const violationsByNurseMap = useMemo(
    (): Map<Id, Violation[]> =>
      violationResult ? indexByNurse(violationResult.violations) : new Map(),
    [violationResult],
  );
  const violationsByDateMap = useMemo(
    (): Map<IsoDate, Violation[]> =>
      violationResult ? indexByDate(violationResult.violations) : new Map(),
    [violationResult],
  );

  const handleCreate = useCallback(
    (input: { nurseId: Id; date: IsoDate; shiftTypeId: Id }) => {
      if (readOnly) return;
      const ghost = makeGhost(period.id, input);
      setPendingCreates((prev) => [...prev, ghost]);
      createAssignment.mutate(
        { periodId: period.id, ...input },
        { onSettled: () => setPendingCreates((prev) => prev.filter((g) => g.id !== ghost.id)) },
      );
    },
    [readOnly, period.id, createAssignment],
  );

  const handleMove = useCallback(
    (input: { assignmentId: Id; nurseId: Id; shiftTypeId: Id; date: IsoDate }) => {
      if (readOnly) return;
      markPending(input.assignmentId);
      const ghost = makeGhost(period.id, input);
      setPendingCreates((prev) => [...prev, ghost]);
      moveAssignment.mutate(input, {
        onSettled: () => {
          clearPending(input.assignmentId);
          setPendingCreates((prev) => prev.filter((g) => g.id !== ghost.id));
        },
      });
    },
    [readOnly, period.id, moveAssignment, markPending, clearPending],
  );

  const handleToggleLock = useCallback(
    (assignment: Assignment) => {
      markPending(assignment.id);
      setLocked.mutate(
        { assignmentId: assignment.id, locked: !assignment.isLocked },
        { onSettled: () => clearPending(assignment.id) },
      );
    },
    [setLocked, markPending, clearPending],
  );

  const handleToggleCharge = useCallback(
    (assignment: Assignment) => {
      markPending(assignment.id);
      updateAssignment.mutate(
        { assignmentId: assignment.id, patch: { isCharge: !assignment.isCharge } },
        { onSettled: () => clearPending(assignment.id) },
      );
    },
    [updateAssignment, markPending, clearPending],
  );

  const handleToggleOvertime = useCallback(
    (assignment: Assignment) => {
      markPending(assignment.id);
      updateAssignment.mutate(
        { assignmentId: assignment.id, patch: { isOvertime: !assignment.isOvertime } },
        { onSettled: () => clearPending(assignment.id) },
      );
    },
    [updateAssignment, markPending, clearPending],
  );

  const handleRemove = useCallback(
    (assignment: Assignment) => {
      markPending(assignment.id);
      setOpenAssignmentId(undefined);
      deleteAssignment.mutate(assignment.id, { onSettled: () => clearPending(assignment.id) });
    },
    [deleteAssignment, markPending, clearPending],
  );

  const handleChipDelete = useCallback(
    (assignment: Assignment) => {
      if (window.confirm('Remove this assignment?')) handleRemove(assignment);
    },
    [handleRemove],
  );

  if (nursesQuery.isPending || shiftTypesQuery.isPending || assignmentsQuery.isPending) {
    return <AsyncState status="loading" label="Loading schedule" />;
  }
  if (nursesQuery.isError || shiftTypesQuery.isError || assignmentsQuery.isError) {
    return (
      <AsyncState
        status="error"
        label="Could not load schedule"
        error={nursesQuery.error ?? shiftTypesQuery.error ?? assignmentsQuery.error}
      />
    );
  }

  const assignments = assignmentsQuery.data;
  const allAssignments =
    pendingCreates.length > 0 ? [...assignments, ...pendingCreates] : assignments;

  const openAssignment = allAssignments.find((a) => a.id === openAssignmentId);
  const openNurse = openAssignment
    ? nursesQuery.data.find((n) => n.id === openAssignment.nurseId)
    : undefined;
  const openShiftType = openAssignment
    ? shiftTypesQuery.data.find((st) => st.id === openAssignment.shiftTypeId)
    : undefined;
  const openViolations = openAssignment
    ? (violationsByAssignmentMap.get(openAssignment.id) ?? [])
    : [];

  return (
    <div>
      <ViolationSummary result={violationResult} />
      <CostSummary report={costQuery.data} />
      {!readOnly ? (
        <div className="mb-3 flex items-start justify-between gap-3">
          <ShiftPalette shiftTypes={shiftTypesQuery.data} readOnly={false} />
          <button
            type="button"
            data-testid="generate-open"
            onClick={() => setGenerateOpen(true)}
            className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white"
          >
            Generate
          </button>
        </div>
      ) : null}
      <ScheduleGrid
        nurses={nursesQuery.data}
        shiftTypes={shiftTypesQuery.data}
        columns={columns}
        assignments={allAssignments}
        pendingIds={pendingIds}
        readOnly={readOnly}
        violationsByAssignment={violationsByAssignmentMap}
        violationsByNurse={violationsByNurseMap}
        violationsByDate={violationsByDateMap}
        onMove={handleMove}
        onCreate={handleCreate}
        onChipOpen={(a) => setOpenAssignmentId(a.id)}
        onChipDelete={handleChipDelete}
      />
      <GenerateDialog
        open={generateOpen}
        onOpenChange={setGenerateOpen}
        unitId={unitId}
        period={period}
        shiftTypes={shiftTypesQuery.data}
        lockedCount={assignments.filter((a) => a.isLocked).length}
        unlockedCount={assignments.filter((a) => !a.isLocked).length}
      />
      <AssignmentDialog
        assignment={openAssignment}
        nurse={openNurse}
        shiftType={openShiftType}
        violations={openViolations ?? []}
        pending={openAssignment ? pendingIds.has(openAssignment.id) : false}
        onClose={() => setOpenAssignmentId(undefined)}
        onToggleLock={handleToggleLock}
        onToggleCharge={handleToggleCharge}
        onToggleOvertime={handleToggleOvertime}
        onRemove={handleRemove}
      />
    </div>
  );
}
