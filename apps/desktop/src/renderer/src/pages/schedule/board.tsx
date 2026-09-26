/**
 * Everything below the period picker for one scheduling period: the violation summary, the
 * palette, the grid, and the popover for editing a single assignment. Split out of `schedule.tsx`
 * (which only owns period selection) so remounting on period change — via `key={period.id}` at
 * the call site — cleanly resets all of this component's local drag/pending state instead of
 * needing to reconcile it against a different period's data.
 *
 * A published period is still editable — that is what the change log exists for — but every
 * edit first collects a reason through `ReasonDialog`, and the same reason is what main writes
 * to `schedule_change` and refuses to proceed without. Only an archived period is read-only.
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
import { errorMessage } from '../../components/ui.js';
import { ReasonDialog } from '../requests/reason-dialog.js';
import { AlertsPanel } from './alerts-panel.js';
import { AssignmentDialog } from './assignment-dialog.js';
import { ChangeLog } from './change-log.js';
import { CostSummary } from './cost-summary.js';
import { ExportMenu } from './export-menu.js';
import { GenerateDialog } from './generate-dialog.js';
import type { GridColumn } from './grid.js';
import { ScheduleGrid } from './grid.js';
import { makePendingId } from './grid-utils.js';
import { ShiftPalette } from './palette.js';
import { PublishDialog } from './publish-dialog.js';
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
  // The handlers below depend on `mutate`, which TanStack keeps stable, not on the mutation
  // objects, which change identity with every state change and would re-render every grid row.
  const createMutate = createAssignment.mutate;
  const moveMutate = moveAssignment.mutate;
  const updateMutate = updateAssignment.mutate;
  const deleteMutate = deleteAssignment.mutate;
  const lockMutate = setLocked.mutate;

  const readOnly = period.status === 'archived';
  const published = period.status === 'published';

  const [pendingIds, setPendingIds] = useState<ReadonlySet<Id>>(new Set());
  const [pendingCreates, setPendingCreates] = useState<readonly Assignment[]>([]);
  const [openAssignmentId, setOpenAssignmentId] = useState<Id | undefined>(undefined);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [changeLogOpen, setChangeLogOpen] = useState(false);
  /** An edit waiting on its reason. Set only on a published period. */
  const [pendingEdit, setPendingEdit] = useState<
    { title: string; run: (reason: string | undefined) => void } | undefined
  >(undefined);

  // On a draft the edit runs at once; on a published period it waits for the reason dialog.
  const withReason = useCallback(
    (title: string, run: (reason: string | undefined) => void) => {
      if (published) setPendingEdit({ title, run });
      else run(undefined);
    },
    [published],
  );

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
      withReason('Add a shift to the published schedule', (reason) => {
        const ghost = makeGhost(period.id, input);
        setPendingCreates((prev) => [...prev, ghost]);
        createMutate(
          { periodId: period.id, ...input, reason },
          { onSettled: () => setPendingCreates((prev) => prev.filter((g) => g.id !== ghost.id)) },
        );
      });
    },
    [readOnly, period.id, createMutate, withReason],
  );

  const handleMove = useCallback(
    (input: { assignmentId: Id; nurseId: Id; shiftTypeId: Id; date: IsoDate }) => {
      if (readOnly) return;
      withReason('Move a shift on the published schedule', (reason) => {
        markPending(input.assignmentId);
        const ghost = makeGhost(period.id, input);
        setPendingCreates((prev) => [...prev, ghost]);
        moveMutate(
          { ...input, reason },
          {
            onSettled: () => {
              clearPending(input.assignmentId);
              setPendingCreates((prev) => prev.filter((g) => g.id !== ghost.id));
            },
          },
        );
      });
    },
    [readOnly, period.id, moveMutate, markPending, clearPending, withReason],
  );

  const handleToggleLock = useCallback(
    (assignment: Assignment) => {
      markPending(assignment.id);
      lockMutate(
        { assignmentId: assignment.id, locked: !assignment.isLocked },
        { onSettled: () => clearPending(assignment.id) },
      );
    },
    [lockMutate, markPending, clearPending],
  );

  const handleToggleCharge = useCallback(
    (assignment: Assignment) => {
      withReason('Change the charge nurse on the published schedule', (reason) => {
        markPending(assignment.id);
        updateMutate(
          { assignmentId: assignment.id, patch: { isCharge: !assignment.isCharge }, reason },
          { onSettled: () => clearPending(assignment.id) },
        );
      });
    },
    [updateMutate, markPending, clearPending, withReason],
  );

  const handleToggleOvertime = useCallback(
    (assignment: Assignment) => {
      withReason('Change overtime authorisation on the published schedule', (reason) => {
        markPending(assignment.id);
        updateMutate(
          { assignmentId: assignment.id, patch: { isOvertime: !assignment.isOvertime }, reason },
          { onSettled: () => clearPending(assignment.id) },
        );
      });
    },
    [updateMutate, markPending, clearPending, withReason],
  );

  const handleRemove = useCallback(
    (assignment: Assignment) => {
      setOpenAssignmentId(undefined);
      withReason('Remove a shift from the published schedule', (reason) => {
        markPending(assignment.id);
        deleteMutate(
          { assignmentId: assignment.id, reason },
          { onSettled: () => clearPending(assignment.id) },
        );
      });
    },
    [deleteMutate, markPending, clearPending, withReason],
  );

  const handleChipOpen = useCallback((a: Assignment) => setOpenAssignmentId(a.id), []);

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

  // A rejected edit (locked source, archived period, missing reason, DB error) silently snaps
  // the chip back on settle; without this the manager cannot tell a refusal from a glitch.
  // A mutation keeps its error until its next run, so the latest failure stays up until
  // dismissed or retried.
  const failedEdit = [
    createAssignment,
    moveAssignment,
    updateAssignment,
    deleteAssignment,
    setLocked,
  ].find((m) => m.isError);

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
      <ViolationSummary status={validationQuery.status} result={violationResult} />
      {failedEdit ? (
        <div
          role="alert"
          data-testid="edit-error"
          className="mb-3 flex items-center justify-between gap-3 rounded-md border border-danger bg-surface px-3 py-2 text-sm text-danger"
        >
          <p>That change was not saved: {errorMessage(failedEdit.error)}</p>
          <button
            type="button"
            onClick={() => failedEdit.reset()}
            className="shrink-0 text-xs underline underline-offset-2 hover:no-underline"
          >
            Dismiss
          </button>
        </div>
      ) : null}
      <CostSummary report={costQuery.data} />
      <AlertsPanel periodId={period.id} />
      <div className="mb-3 flex items-start justify-between gap-3">
        {!readOnly ? (
          <ShiftPalette shiftTypes={shiftTypesQuery.data} readOnly={false} />
        ) : (
          <p className="text-sm text-text-muted">This period is archived and read-only.</p>
        )}
        <div className="flex shrink-0 items-center gap-2">
          <ExportMenu periodId={period.id} />
          {published ? (
            <button
              type="button"
              data-testid="change-log-open"
              onClick={() => setChangeLogOpen((o) => !o)}
              className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text hover:bg-bg"
            >
              {changeLogOpen ? 'Hide change log' : 'Change log'}
            </button>
          ) : null}
          {period.status === 'draft' ? (
            <button
              type="button"
              data-testid="generate-open"
              onClick={() => setGenerateOpen(true)}
              className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text hover:bg-bg"
            >
              Generate
            </button>
          ) : null}
          {!readOnly ? (
            <button
              type="button"
              data-testid="publish-open"
              onClick={() => setPublishOpen(true)}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white"
            >
              {published ? 'Publish changes' : 'Publish'}
            </button>
          ) : null}
        </div>
      </div>
      {published && changeLogOpen ? <ChangeLog periodId={period.id} /> : null}
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
        onChipOpen={handleChipOpen}
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
      <PublishDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        unitId={unitId}
        period={period}
        nurses={nursesQuery.data}
        shiftTypes={shiftTypesQuery.data}
      />
      <ReasonDialog
        open={pendingEdit !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingEdit(undefined);
        }}
        title={pendingEdit?.title ?? 'Reason for this change'}
        description="Staff already hold this schedule. The reason is written to the change log and the audit trail, and is what a nurse will be told."
        confirmLabel="Apply change"
        pending={false}
        error={undefined}
        onConfirm={(reason) => {
          const edit = pendingEdit;
          setPendingEdit(undefined);
          edit?.run(reason);
        }}
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
