/**
 * The Generate flow for one draft period: confirm what will be replaced, watch the solver run
 * (with a real cancel), then read the solve report — what is still short, how legal, how fair,
 * how much — before going back to the grid, which by then already shows the new schedule.
 *
 * The report deliberately leads with the shortfalls. A solver that says "done" and leaves the
 * manager to discover the empty Saturday night from red badges has failed at its one job; the
 * unfilled list is the handoff to the resolution flow that M10 adds.
 */

import * as Dialog from '@radix-ui/react-dialog';
import type { SolveJobStatus, SolverAvailability } from '@shared/api.js';
import type {
  Id,
  SchedulePeriod,
  ShiftType,
  SolveReport,
  SolverId,
  UnfilledSlot,
} from '@shiftnurse/core';
import { useEffect, useMemo, useState } from 'react';
import {
  isSettled,
  useCancelSolve,
  useSolveJob,
  useSolverAvailability,
  useSolverSettings,
  useStartSolve,
} from '../../api-solver.js';
import { formatDate } from '../../format.js';
import { formatDollars } from '../../money.js';
import { SOLVER_LABELS, SOLVER_ORDER } from '../../solver-labels.js';

interface GenerateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unitId: Id;
  period: SchedulePeriod;
  shiftTypes: readonly ShiftType[];
  lockedCount: number;
  unlockedCount: number;
}

export function GenerateDialog({
  open,
  onOpenChange,
  unitId,
  period,
  shiftTypes,
  lockedCount,
  unlockedCount,
}: GenerateDialogProps) {
  const [jobId, setJobId] = useState<Id | undefined>(undefined);
  const [seed, setSeed] = useState<number | undefined>(undefined);
  /** A one-off override; undefined means "the unit's saved solver". */
  const [solver, setSolver] = useState<SolverId | undefined>(undefined);
  const savedSolver = useSolverSettings(unitId).data?.solverId;
  const availability = useSolverAvailability().data;
  const start = useStartSolve();
  const cancel = useCancelSolve();
  const job = useSolveJob(jobId, period.id, unitId);
  const status = job.data;

  // A fresh open is a fresh decision; the last run's report should not linger behind it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the dialog opens.
  useEffect(() => {
    if (!open) return;
    setJobId(undefined);
    setSolver(undefined);
    start.reset();
    cancel.reset();
  }, [open]);

  const running = status !== undefined && !isSettled(status);

  function launch(nextSeed?: number) {
    setSeed(nextSeed);
    start.mutate(
      {
        periodId: period.id,
        options: {
          ...(nextSeed !== undefined ? { seed: nextSeed } : {}),
          ...(solver !== undefined ? { solver } : {}),
        },
      },
      { onSuccess: (s) => setJobId(s.id) },
    );
  }

  const startError = start.error instanceof Error ? start.error.message : undefined;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !running && onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          data-testid="generate-dialog"
          className="fixed z-50 left-1/2 top-1/2 w-[34rem] max-w-[calc(100vw-2rem)] -translate-x-1/2
            -translate-y-1/2 rounded-lg border border-border bg-surface p-6 shadow-lg"
          onEscapeKeyDown={(e) => running && e.preventDefault()}
          onPointerDownOutside={(e) => running && e.preventDefault()}
        >
          <Dialog.Title className="mb-1 text-lg font-semibold text-text">
            Generate schedule
          </Dialog.Title>
          <Dialog.Description className="mb-4 text-sm text-text-muted">
            {period.name} · {formatDate(period.startDate)} – {formatDate(period.endDate)}
          </Dialog.Description>

          {status === undefined ? (
            <Confirm
              lockedCount={lockedCount}
              unlockedCount={unlockedCount}
              pending={start.isPending}
              error={startError}
              solver={solver ?? savedSolver}
              savedSolver={savedSolver}
              availability={availability}
              onSolverChange={setSolver}
              onGenerate={() => launch()}
            />
          ) : running ? (
            <Running
              status={status}
              cancelling={cancel.isPending}
              onCancel={() => cancel.mutate(status.id)}
            />
          ) : (
            <Finished
              status={status}
              shiftTypes={shiftTypes}
              onRetry={() => launch((seed ?? status.seed) + 1)}
              onClose={() => onOpenChange(false)}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------

function Confirm({
  lockedCount,
  unlockedCount,
  pending,
  error,
  solver,
  savedSolver,
  availability,
  onSolverChange,
  onGenerate,
}: {
  lockedCount: number;
  unlockedCount: number;
  pending: boolean;
  error: string | undefined;
  solver: SolverId | undefined;
  savedSolver: SolverId | undefined;
  availability: SolverAvailability[] | undefined;
  onSolverChange: (solver: SolverId) => void;
  onGenerate: () => void;
}) {
  const byId = new Map((availability ?? []).map((a) => [a.id, a]));
  const chosen = solver !== undefined ? byId.get(solver) : undefined;
  return (
    <div>
      <p className="text-sm text-text">
        The solver fills every shift from the coverage floors and census demand, keeps each nurse
        within the contract rules, and balances nights, weekends and holidays against the fairness
        ledger.
      </p>
      <ul className="mt-3 list-disc pl-5 text-sm text-text-muted">
        <li>
          <span className="font-medium text-text">{unlockedCount}</span> unlocked shift
          {unlockedCount === 1 ? '' : 's'} on the grid will be replaced.
        </li>
        <li>
          <span className="font-medium text-text">{lockedCount}</span> locked shift
          {lockedCount === 1 ? '' : 's'} will be kept exactly where they are.
        </li>
        <li>Running it again on the same inputs produces the same schedule.</li>
      </ul>
      <label className="mt-4 flex flex-col gap-1 text-xs text-text-muted">
        Solver
        <select
          data-testid="generate-solver"
          className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-text"
          value={solver ?? ''}
          disabled={solver === undefined}
          onChange={(e) => onSolverChange(e.target.value as SolverId)}
        >
          {SOLVER_ORDER.map((id) => (
            <option key={id} value={id}>
              {SOLVER_LABELS[id].name}
              {id === savedSolver ? ' — unit default' : ''}
              {byId.get(id)?.available === false ? ' (not installed)' : ''}
            </option>
          ))}
        </select>
      </label>
      {chosen?.available === false ? (
        <p className="mt-1 text-xs text-warn">
          {chosen.reason}. Generate will use the fallback solver and say so in the report.
        </p>
      ) : null}
      {error !== undefined ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="mt-6 flex justify-end gap-2">
        <Dialog.Close asChild>
          <button type="button" className={secondaryButton}>
            Cancel
          </button>
        </Dialog.Close>
        <button
          type="button"
          data-testid="generate-confirm"
          disabled={pending}
          onClick={onGenerate}
          className={primaryButton}
        >
          {pending ? 'Starting…' : 'Generate'}
        </button>
      </div>
    </div>
  );
}

function Running({
  status,
  cancelling,
  onCancel,
}: {
  status: SolveJobStatus;
  cancelling: boolean;
  onCancel: () => void;
}) {
  const progress = status.progress;
  const fraction = status.state === 'applying' ? 1 : (progress?.fraction ?? 0);
  const phase =
    status.state === 'applying'
      ? 'Writing the schedule'
      : progress?.phase === 'seeding'
        ? 'Building the first draft'
        : progress?.phase === 'finishing'
          ? 'Finishing'
          : 'Improving the draft';
  return (
    <div data-testid="generate-running">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-text">{phase}</span>
        <span className="text-text-muted">{Math.round(fraction * 100)}%</span>
      </div>
      <progress
        className="mt-2 h-2 w-full overflow-hidden rounded-full [&::-webkit-progress-bar]:bg-border
          [&::-webkit-progress-value]:bg-accent"
        value={fraction}
        max={1}
        aria-label="Solve progress"
      />
      {progress ? (
        <dl className="mt-3 grid grid-cols-3 gap-2 text-xs text-text-muted">
          <div>
            <dt>Iterations</dt>
            <dd className="font-medium text-text">
              {progress.iteration.toLocaleString()} / {progress.maxIterations.toLocaleString()}
            </dd>
          </div>
          <div>
            <dt>Floor gaps</dt>
            <dd
              className={`font-medium ${progress.hardShortfall > 0 ? 'text-danger' : 'text-success'}`}
            >
              {progress.hardShortfall}
            </dd>
          </div>
          <div>
            <dt>Elapsed</dt>
            <dd className="font-medium text-text">{(progress.elapsedMs / 1000).toFixed(1)}s</dd>
          </div>
        </dl>
      ) : null}
      <div className="mt-6 flex justify-end">
        <button
          type="button"
          data-testid="generate-cancel"
          disabled={cancelling || status.state === 'applying'}
          onClick={onCancel}
          className={secondaryButton}
        >
          {cancelling ? 'Stopping…' : 'Stop'}
        </button>
      </div>
    </div>
  );
}

function Finished({
  status,
  shiftTypes,
  onRetry,
  onClose,
}: {
  status: SolveJobStatus;
  shiftTypes: readonly ShiftType[];
  onRetry: () => void;
  onClose: () => void;
}) {
  const report = status.report;
  return (
    <div data-testid="generate-finished" data-state={status.state}>
      {status.state === 'failed' ? (
        <p role="alert" className="text-sm text-danger">
          The solver stopped with an error: {status.error ?? 'unknown error'}
        </p>
      ) : status.state === 'cancelled' ? (
        <p className="text-sm text-text-muted">
          Stopped before finishing. The grid was not changed.
        </p>
      ) : (
        <p className="text-sm text-success">
          Schedule written: {status.applied?.created ?? 0} shifts generated,{' '}
          {status.applied?.preservedLocked ?? 0} locked shifts kept.
        </p>
      )}
      {status.fellBackFrom ? (
        <p className="mt-2 text-sm text-warn" data-testid="generate-fallback">
          Ran {SOLVER_LABELS[status.solver].name} instead of{' '}
          {SOLVER_LABELS[status.fellBackFrom.solver].name}: {status.fellBackFrom.reason}.
        </p>
      ) : null}
      {report ? <Report report={report} shiftTypes={shiftTypes} /> : null}
      <div className="mt-6 flex items-center justify-between gap-2">
        <span className="text-xs text-text-muted">
          {SOLVER_LABELS[status.solver].name} · seed {status.seed}
          {report?.stats.gap !== undefined
            ? ` · within ${(report.stats.gap * 100).toFixed(1)}% of optimal`
            : ''}
          {report
            ? ` · ${report.stats.iterations.toLocaleString()} iterations · ${(report.stats.elapsedMs / 1000).toFixed(1)}s`
            : ''}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="generate-retry"
            onClick={onRetry}
            className={secondaryButton}
          >
            Try another variation
          </button>
          <button
            type="button"
            data-testid="generate-close"
            onClick={onClose}
            className={primaryButton}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function Report({ report, shiftTypes }: { report: SolveReport; shiftTypes: readonly ShiftType[] }) {
  const names = useMemo(() => new Map(shiftTypes.map((s) => [s.id, s.name])), [shiftTypes]);
  const hard = report.hardViolations.length;
  const soft = report.softViolations.length;
  const scores = report.fairness.scores;
  const meanScore =
    scores.length > 0 ? scores.reduce((sum, s) => sum + s.score, 0) / scores.length : 0;

  return (
    <div className="mt-4">
      <dl className="grid grid-cols-3 gap-3 text-sm">
        <Stat
          label="Unfilled"
          tone={report.unfilled.length > 0 ? 'danger' : 'success'}
          value={`${report.unfilled.length} slot${report.unfilled.length === 1 ? '' : 's'}`}
        />
        <Stat
          label="Rules"
          tone={hard > 0 ? 'danger' : soft > 0 ? 'warn' : 'success'}
          value={`${hard} hard · ${soft} soft`}
        />
        <Stat
          label="Fairness"
          tone="neutral"
          value={`${Math.round(meanScore)} avg · Gini ${report.fairness.distribution.score.gini.toFixed(2)}`}
        />
        {report.cost ? (
          <Stat
            label="Cost"
            tone={report.cost.unpricedAssignments > 0 ? 'warn' : 'neutral'}
            value={
              formatDollars(report.cost.totals.total) +
              (report.cost.unpricedAssignments > 0
                ? ` · ${report.cost.unpricedAssignments} unpriced`
                : '')
            }
          />
        ) : null}
      </dl>
      {report.unfilled.length > 0 ? (
        <div className="mt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
            Still short after every legal option
          </p>
          <ul
            data-testid="generate-unfilled"
            className="mt-1 max-h-40 overflow-y-auto rounded-md border border-border text-xs"
          >
            {report.unfilled.map((slot) => (
              <li
                key={`${slot.date}-${slot.shiftTypeId}-${slot.role}-${slot.standard}`}
                className="flex justify-between gap-2 border-b border-border px-2 py-1 last:border-b-0"
              >
                <span className="text-text">
                  {formatDate(slot.date)} · {names.get(slot.shiftTypeId) ?? slot.shiftTypeId}
                </span>
                <span className="text-danger">{describeShortfall(slot)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function describeShortfall(slot: UnfilledSlot): string {
  const need = `${slot.shortfall} ${slot.role}${slot.shortfall === 1 ? '' : 's'} short`;
  return slot.standard === 'ratio' ? `${need} (patient ratio)` : need;
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'success' | 'warn' | 'danger' | 'neutral';
}) {
  const color =
    tone === 'success'
      ? 'text-success'
      : tone === 'warn'
        ? 'text-warn'
        : tone === 'danger'
          ? 'text-danger'
          : 'text-text';
  return (
    <div className="rounded-md border border-border bg-bg px-3 py-2">
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className={`font-medium ${color}`}>{value}</dd>
    </div>
  );
}

const primaryButton =
  'rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60';
const secondaryButton =
  'rounded-md border border-border px-3 py-1.5 text-sm text-text hover:bg-bg disabled:opacity-60';
