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
  payPeriodIndex,
  payPeriodWindow,
  rangesOverlap,
  weekdayOf,
} from '@shiftnurse/core';
import { Link } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';
import { useAssignments, useNurses, useShiftTypes, useTimeOff } from '../../api.js';
import { useCostReport } from '../../api-cost.js';
import { useDemand } from '../../api-demand.js';
import { useValidation } from '../../api-schedule.js';
import { AsyncState } from '../../components/async-state.js';
import { errorMessage, PRIMARY, SECONDARY } from '../../components/ui.js';
import { periodRange } from '../../format.js';
import { useUnit } from '../../unit-context.js';
import { ReasonDialog } from '../requests/reason-dialog.js';
import { AlertsPanel } from './alerts-panel.js';
import { AssignmentDialog } from './assignment-dialog.js';
import { variationNumber } from './candidates.js';
import { CandidatesBar } from './candidates-bar.js';
import { ChangeLog } from './change-log.js';
import { CompareDialog } from './compare-dialog.js';
import { CostSummary } from './cost-summary.js';
import { ExportMenu } from './export-menu.js';
import { GenerateDialog } from './generate-dialog.js';
import type { GridColumn } from './grid.js';
import { ScheduleGrid } from './grid.js';
import { sortNurses } from './grid-utils.js';
import { ShiftPalette } from './palette.js';
import { PublishDialog } from './publish-dialog.js';
import { useGenerateFlow } from './use-generate-flow.js';
import { useGridEdits } from './use-grid-edits.js';
import { useScheduleDialogs } from './use-schedule-dialogs.js';
import { ViolationSummary } from './violation-summary.js';

interface ScheduleBoardProps {
  unitId: Id;
  period: SchedulePeriod;
}

export function ScheduleBoard({ unitId, period }: ScheduleBoardProps) {
  const unit = useUnit();
  const nursesQuery = useNurses(unitId);
  const shiftTypesQuery = useShiftTypes(unitId);
  const assignmentsQuery = useAssignments(period.id);
  const validationQuery = useValidation(period.id);
  const costQuery = useCostReport(period.id);
  const pendingTimeOff = useTimeOff(unitId, 'pending').data;
  const demandQuery = useDemand(unitId, period.startDate, period.endDate);

  const readOnly = period.status === 'archived';
  const published = period.status === 'published';

  const dialogs = useScheduleDialogs();
  const edits = useGridEdits({
    period,
    unitId,
    readOnly,
    published,
    assignments: assignmentsQuery.data,
    nurses: nursesQuery.data,
    shiftTypes: shiftTypesQuery.data,
    onRemoveStart: dialogs.closeAssignment,
  });
  const {
    batch,
    saveCandidate,
    discardBatch,
    cancelBatch,
    selectedIndex,
    setChosenIndex,
    setPreviewing,
    previewVariation,
    previewActive,
    previewQuery,
    preview,
    previewLabel,
    highlightKeys,
    handleSaveCandidate,
  } = useGenerateFlow({
    period,
    unitId,
    assignments: assignmentsQuery.data,
    onSaved: edits.clearUndo,
  });
  const { pendingIds, pendingCreates, failedEdit } = edits;

  const columns: GridColumn[] = useMemo(
    () =>
      datesInRange(period.startDate, period.endDate).map((date) => ({
        date,
        weekday: weekdayOf(date),
        isWeekend: isWeekendDate(date),
        weekStart: date !== period.startDate && weekdayOf(date) === weekdayOf(period.startDate),
      })),
    [period.startDate, period.endDate],
  );
  const columnDates = useMemo(() => columns.map((c) => c.date), [columns]);
  const sortedNurses = useMemo(() => sortNurses(nursesQuery.data ?? []), [nursesQuery.data]);

  // An empty draft has not been built yet. Judged as a schedule it is every shift short — "378
  // hard violations" in red before the manager has done anything — so it is not judged at all.
  const emptyDraft =
    period.status === 'draft' && !preview && (assignmentsQuery.data?.length ?? 0) === 0;
  const violationResult = preview
    ? preview.validation.result
    : emptyDraft
      ? undefined
      : validationQuery.data?.result;
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

  const { openAssignment: openAssignmentById } = dialogs;
  const handleChipOpen = useCallback(
    (a: Assignment) => openAssignmentById(a.id),
    [openAssignmentById],
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
  const gridAssignments = preview ? preview.assignments : allAssignments;

  const undecided = (pendingTimeOff ?? []).filter((r) =>
    rangesOverlap(r.startDate, r.endDate, period.startDate, period.endDate),
  ).length;
  const openGenerate = () => {
    // A run in progress is the thing to show; otherwise Generate means a new one.
    dialogs.openGenerateOn(batch?.state === 'running' ? 'batch' : 'setup');
  };

  const showDate = (date: string) => {
    document
      .querySelector(`[data-testid="schedule-grid"] [data-date="${date}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  };

  const openAssignment = allAssignments.find((a) => a.id === dialogs.openAssignmentId);
  const openNurse = openAssignment
    ? nursesQuery.data.find((n) => n.id === openAssignment.nurseId)
    : undefined;
  const openShiftType = openAssignment
    ? shiftTypesQuery.data.find((st) => st.id === openAssignment.shiftTypeId)
    : undefined;
  const openContext = (() => {
    if (!openAssignment || !openNurse) return undefined;
    const window = payPeriodWindow(payPeriodIndex(openAssignment.date, unit), unit);
    const byType = new Map(shiftTypesQuery.data.map((st) => [st.id, st]));
    const hours = allAssignments
      .filter(
        (a) =>
          a.nurseId === openNurse.id &&
          a.date >= window.start &&
          a.date <= window.end &&
          !byType.get(a.shiftTypeId)?.isOnCall,
      )
      .reduce((sum, a) => sum + (byType.get(a.shiftTypeId)?.durationHours ?? 0), 0);
    const alsoOnShift = allAssignments
      .filter(
        (a) =>
          a.date === openAssignment.date &&
          a.shiftTypeId === openAssignment.shiftTypeId &&
          a.nurseId !== openNurse.id,
      )
      .map((a) => nursesQuery.data.find((n) => n.id === a.nurseId))
      .filter((n): n is NonNullable<typeof n> => n !== undefined)
      .sort((a, b) => a.lastName.localeCompare(b.lastName));
    return {
      hoursThisPayPeriod: hours,
      contractedHours: openNurse.contractedHoursPerPeriod,
      payPeriodLabel: periodRange({ startDate: window.start, endDate: window.end }),
      alsoOnShift,
    };
  })();
  const swapOptions = openAssignment
    ? allAssignments
        .filter(
          (a) =>
            a.date === openAssignment.date &&
            a.nurseId !== openAssignment.nurseId &&
            a.shiftTypeId !== openAssignment.shiftTypeId &&
            !a.isLocked,
        )
        .flatMap((a) => {
          const nurse = nursesQuery.data.find((n) => n.id === a.nurseId);
          const shiftType = shiftTypesQuery.data.find((st) => st.id === a.shiftTypeId);
          return nurse && shiftType ? [{ assignment: a, nurse, shiftType }] : [];
        })
        .sort((x, y) => x.nurse.lastName.localeCompare(y.nurse.lastName))
    : [];
  const openViolations = openAssignment
    ? (violationsByAssignmentMap.get(openAssignment.id) ?? [])
    : [];

  return (
    <div>
      {batch && period.status === 'draft' ? (
        <CandidatesBar
          batch={batch}
          selected={selectedIndex}
          onSelect={setChosenIndex}
          previewing={previewActive}
          onTogglePreview={() => setPreviewing((p) => !p)}
          onCompare={() => dialogs.setCompareOpen(true)}
          onSave={() => void handleSaveCandidate()}
          onDiscard={() => {
            setPreviewing(false);
            discardBatch.mutate(batch.id);
          }}
          onCancel={() => cancelBatch.mutate(batch.id)}
          onShowProgress={() => {
            dialogs.openGenerateOn('batch');
          }}
          saving={saveCandidate.isPending}
          error={
            saveCandidate.isError
              ? `That variation was not saved: ${errorMessage(saveCandidate.error)}`
              : previewQuery.isError && previewActive
                ? `Could not preview it: ${errorMessage(previewQuery.error)}`
                : undefined
          }
        />
      ) : null}
      {previewActive && selectedIndex !== undefined ? (
        <div
          role="status"
          data-testid="preview-banner"
          className="mb-3 flex items-center justify-between gap-3 rounded-md border border-accent bg-accent/10 px-3 py-2 text-sm text-text"
        >
          <p>
            Previewing variation {batch ? variationNumber(batch, selectedIndex) : selectedIndex + 1}{' '}
            — nothing is saved yet.{' '}
            {preview
              ? `Outlined shifts differ from the draft (${preview.diff.added} added, ${preview.diff.removed} removed, ${preview.diff.changed} changed).`
              : 'Loading…'}
          </p>
          <button
            type="button"
            onClick={() => setPreviewing(false)}
            className="shrink-0 text-xs underline underline-offset-2 hover:no-underline"
          >
            Exit preview
          </button>
        </div>
      ) : null}
      {period.status === 'draft' && undecided > 0 ? (
        <div
          role="status"
          data-testid="pending-requests-nudge"
          className="mb-3 flex items-center justify-between gap-3 rounded-md border border-warn bg-surface px-3 py-2 text-sm text-text"
        >
          <p>
            {undecided} time-off request{undecided === 1 ? ' is' : 's are'} waiting for a decision
            in this period. Decide {undecided === 1 ? 'it' : 'them'} before generating, so the
            schedule works around approved leave.
          </p>
          <Link to="/requests" className="shrink-0 text-xs underline underline-offset-2">
            Review requests
          </Link>
        </div>
      ) : null}
      {emptyDraft && !batch ? (
        <div
          data-testid="empty-draft"
          className="mb-3 rounded-md border border-accent/50 bg-surface px-4 py-4"
        >
          <p className="text-sm font-medium text-text">This schedule hasn't been built yet.</p>
          <p className="mt-1 text-sm text-text-muted">
            Generate fills every shift from your staffing floors, contracts, approved leave and
            preferences, and shares nights and weekends fairly. You can also drag shifts onto the
            grid by hand.
          </p>
          <button type="button" onClick={openGenerate} className={`${PRIMARY} mt-3`}>
            Generate schedule
          </button>
        </div>
      ) : null}
      {emptyDraft ? null : (
        <ViolationSummary
          status={preview ? 'success' : validationQuery.status}
          result={violationResult}
          previewLabel={previewLabel}
        />
      )}
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
      {emptyDraft ? null : (
        <>
          <CostSummary
            report={preview ? preview.cost : costQuery.data}
            previewLabel={previewLabel}
          />
          <AlertsPanel
            periodId={period.id}
            published={period.status !== 'draft'}
            onShowDate={showDate}
            preview={
              preview && previewLabel ? { alerts: preview.alerts, label: previewLabel } : undefined
            }
          />
        </>
      )}
      <div className="mb-3 flex items-start justify-between gap-3">
        {previewActive ? (
          <p className="text-sm text-text-muted">
            A preview is read-only: save the variation, or exit the preview, to edit.
          </p>
        ) : !readOnly ? (
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
              onClick={() => dialogs.toggleChangeLog()}
              className={SECONDARY}
            >
              {dialogs.changeLogOpen ? 'Hide change log' : 'Change log'}
            </button>
          ) : null}
          {period.status === 'draft' ? (
            <button
              type="button"
              data-testid="generate-open"
              onClick={openGenerate}
              // Until there is a schedule, building one is the next step, not publishing it.
              className={emptyDraft ? PRIMARY : SECONDARY}
            >
              Generate
            </button>
          ) : null}
          {!readOnly ? (
            <button
              type="button"
              data-testid="publish-open"
              onClick={() => dialogs.setPublishOpen(true)}
              disabled={emptyDraft}
              title={emptyDraft ? 'Generate or add shifts before publishing' : undefined}
              className={emptyDraft ? SECONDARY : PRIMARY}
            >
              {published ? 'Publish changes' : 'Publish'}
            </button>
          ) : null}
        </div>
      </div>
      {published && dialogs.changeLogOpen ? <ChangeLog periodId={period.id} /> : null}
      {emptyDraft ? null : (
        <p className="mb-2 text-xs text-text-muted" data-testid="grid-legend">
          A red number counts rule breaks: in a day's header for that day, beside a name for that
          nurse — hover it to read them. On a shift, C marks the charge nurse and ♡ a shift that
          goes against what the nurse asked for. The rows under the grid show staffed / needed.
        </p>
      )}
      <ScheduleGrid
        nurses={nursesQuery.data}
        shiftTypes={shiftTypesQuery.data}
        columns={columns}
        assignments={gridAssignments}
        pendingIds={pendingIds}
        readOnly={readOnly || previewActive}
        highlightKeys={highlightKeys}
        violationsByAssignment={violationsByAssignmentMap}
        violationsByNurse={violationsByNurseMap}
        violationsByDate={violationsByDateMap}
        onMove={edits.handleMove}
        onCreate={edits.handleCreate}
        onChipOpen={handleChipOpen}
        onChipDelete={edits.handleChipDelete}
        demand={demandQuery.data}
        againstPreference={
          preview ? preview.validation.againstPreference : validationQuery.data?.againstPreference
        }
      />
      <GenerateDialog
        open={dialogs.generateOpen}
        onOpenChange={dialogs.setGenerateOpen}
        unitId={unitId}
        period={period}
        lockedCount={assignments.filter((a) => a.isLocked).length}
        undecidedRequests={undecided}
        unlockedCount={assignments.filter((a) => !a.isLocked).length}
        batch={batch}
        view={dialogs.generateView}
        onViewChange={dialogs.setGenerateView}
        onCompare={() => dialogs.setCompareOpen(true)}
        onPreview={previewVariation}
      />
      <CompareDialog
        open={dialogs.compareOpen}
        onOpenChange={dialogs.setCompareOpen}
        periodId={period.id}
        batchId={batch?.id}
        offset={batch?.offset ?? 0}
        nurses={nursesQuery.data}
        selected={selectedIndex}
        onSelect={setChosenIndex}
        onPreview={previewVariation}
      />
      <PublishDialog
        open={dialogs.publishOpen}
        onOpenChange={dialogs.setPublishOpen}
        unitId={unitId}
        period={period}
        nurses={nursesQuery.data}
        shiftTypes={shiftTypesQuery.data}
      />
      <ReasonDialog
        open={edits.pendingEdit !== undefined}
        onOpenChange={(open) => {
          if (!open) edits.cancelPendingEdit();
        }}
        title={edits.pendingEdit?.title ?? 'Reason for this change'}
        description="Staff already hold this schedule. The reason is written to the change log and the audit trail, and is what a nurse will be told."
        confirmLabel="Apply change"
        pending={false}
        error={undefined}
        onConfirm={edits.resolvePendingEdit}
      />
      <AssignmentDialog
        assignment={openAssignment}
        nurse={openNurse}
        shiftType={openShiftType}
        violations={openViolations ?? []}
        pending={openAssignment ? pendingIds.has(openAssignment.id) : false}
        onClose={dialogs.closeAssignment}
        onToggleLock={edits.handleToggleLock}
        onToggleCharge={edits.handleToggleCharge}
        onToggleOvertime={edits.handleToggleOvertime}
        onRemove={edits.handleRemove}
        nurses={sortedNurses}
        dates={columnDates}
        onMove={edits.handleMove}
        context={openContext}
        shiftTypes={shiftTypesQuery.data}
        swapOptions={swapOptions}
        onSwap={edits.handleSwap}
      />
    </div>
  );
}
