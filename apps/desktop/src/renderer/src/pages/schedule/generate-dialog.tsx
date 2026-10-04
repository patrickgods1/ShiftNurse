/**
 * The Generate flow for one draft period: choose how many variations and which solver (with an
 * honest estimate of how long that takes on this machine), then watch them run. The results are
 * not written anywhere — they appear above the grid as candidates to page through, preview,
 * compare and save (`candidates-bar.tsx`).
 *
 * Why several: variations of the same inputs land within a percent or two of each other in total
 * score, and differ in who carries the weekends, how much overtime, whose preferences give way.
 * That trade is the manager's to make, so Generate offers it rather than picking silently.
 */

import type {
  SolveBatchStatus,
  SolveEstimate,
  SolveRunStatus,
  SolverAvailability,
} from '@shared/api.js';
import type { Id, SchedulePeriod, SolverId } from '@shiftnurse/core';
import { useEffect, useState } from 'react';
import {
  useBatchEstimate,
  useCancelBatch,
  useSolverAvailability,
  useSolverSettings,
  useStartBatch,
} from '../../api-solver.js';
import { Modal } from '../../components/modal.js';
import { errorMessage, PRIMARY, SECONDARY } from '../../components/ui.js';
import { periodLabel } from '../../format.js';
import { formatDollars } from '../../money.js';
import { SOLVER_LABELS, SOLVER_ORDER } from '../../solver-labels.js';
import { bestChoice, digestLine, finishedRuns, spread, variationNumber } from './candidates.js';

/** Matches `MAX_BATCH_SIZE` in main; main clamps whatever arrives. */
const MAX_VARIATIONS = 10;
const DEFAULT_VARIATIONS = 3;

interface GenerateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unitId: Id;
  period: SchedulePeriod;
  lockedCount: number;
  unlockedCount: number;
  /** Time-off requests in the period still waiting for a decision. */
  undecidedRequests: number;
  /** The period's current batch, if any. */
  batch: SolveBatchStatus | null | undefined;
  /**
   * `setup` chooses what to generate; `batch` follows the period's batch — its progress, then its
   * summary. Owned by the board, so closing the dialog mid-run and reopening it lands back on the
   * run rather than on a fresh setup screen.
   */
  view: GenerateView;
  onViewChange: (view: GenerateView) => void;
  onCompare: () => void;
  onPreview: (index: number) => void;
}

export type GenerateView = 'setup' | 'batch';

export function GenerateDialog({
  open,
  onOpenChange,
  unitId,
  period,
  lockedCount,
  unlockedCount,
  undecidedRequests,
  batch,
  view,
  onViewChange,
  onCompare,
  onPreview,
}: GenerateDialogProps) {
  /** A one-off override; undefined means "the unit's saved solver". */
  const [solver, setSolver] = useState<SolverId | undefined>(undefined);
  const [count, setCount] = useState(DEFAULT_VARIATIONS);
  const savedSolver = useSolverSettings(unitId).data?.solverId;
  const availability = useSolverAvailability().data;
  const start = useStartBatch(period.id);
  const cancel = useCancelBatch(period.id);
  const running = batch?.state === 'running';
  /** Carry on after the period's last batch (new seeds) rather than start at variation 1. */
  const [continueSeeds, setContinueSeeds] = useState(true);
  const previous = batch && batch.state !== 'running' ? batch : undefined;
  const continuing = previous !== undefined && continueSeeds;
  const options = {
    count,
    ...(solver !== undefined ? { solver } : {}),
    ...(continuing ? { continueAfter: previous.id } : {}),
  };
  const showSetup = !running && (view === 'setup' || !batch);
  const estimate = useBatchEstimate(period.id, options, open && showSetup);

  // A fresh open is a fresh decision.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the dialog opens.
  useEffect(() => {
    if (!open) return;
    setSolver(undefined);
    setContinueSeeds(true);
    start.reset();
    cancel.reset();
  }, [open]);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      data-testid="generate-dialog"
      size="md"
      title="Generate schedule"
      description={periodLabel(period)}
    >
      <div className="mt-4">
        {running && batch ? (
          <Running
            onClose={() => onOpenChange(false)}
            batch={batch}
            cancelling={cancel.isPending}
            onCancel={() => cancel.mutate(batch.id)}
          />
        ) : !showSetup && batch ? (
          <Finished
            onClose={() => onOpenChange(false)}
            batch={batch}
            onGenerateAgain={() => {
              start.reset();
              setContinueSeeds(true);
              // More of the same: the solver these variations asked for, not the unit default
              // (reopening the dialog to reach this summary reset the choice).
              setSolver(batch.fellBackFrom?.solver ?? batch.solver);
              onViewChange('setup');
            }}
            onCompare={() => {
              onOpenChange(false);
              onCompare();
            }}
            onPreview={(index) => {
              onOpenChange(false);
              onPreview(index);
            }}
          />
        ) : (
          <Confirm
            onClose={() => onOpenChange(false)}
            undecidedRequests={undecidedRequests}
            lockedCount={lockedCount}
            unlockedCount={unlockedCount}
            previous={previous}
            continuing={continuing}
            onContinueChange={setContinueSeeds}
            count={count}
            onCountChange={setCount}
            estimate={estimate.data}
            pending={start.isPending}
            error={start.isError ? errorMessage(start.error) : undefined}
            solver={solver ?? savedSolver}
            savedSolver={savedSolver}
            availability={availability}
            onSolverChange={setSolver}
            onGenerate={() => start.mutate(options, { onSuccess: () => onViewChange('batch') })}
          />
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

/** "about 40 s", "about 3 min": an estimate should not read more precise than it is. */
export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `about ${Math.max(5, Math.round(seconds / 5) * 5)} s`;
  return `about ${Math.round(seconds / 60)} min`;
}

function describeEstimate(estimate: SolveEstimate): string {
  const pace =
    estimate.count === 1
      ? ''
      : estimate.concurrency === 1
        ? ', one at a time'
        : estimate.concurrency >= estimate.count
          ? ', all at once'
          : `, ${estimate.concurrency} at a time`;
  const basis = estimate.basis === 'observed' ? 'based on your last run' : 'rough estimate';
  return `${formatDuration(estimate.totalMs)}${pace} (${basis})`;
}

function Confirm({
  onClose,
  lockedCount,
  undecidedRequests,
  unlockedCount,
  previous,
  continuing,
  onContinueChange,
  count,
  onCountChange,
  estimate,
  pending,
  error,
  solver,
  savedSolver,
  availability,
  onSolverChange,
  onGenerate,
}: {
  onClose: () => void;
  lockedCount: number;
  undecidedRequests: number;
  unlockedCount: number;
  /** Variations already waiting above the grid, which this Generate replaces. */
  /** The period's last batch, finished: what this Generate replaces or carries on from. */
  previous: SolveBatchStatus | undefined;
  continuing: boolean;
  onContinueChange: (continuing: boolean) => void;
  count: number;
  onCountChange: (count: number) => void;
  estimate: SolveEstimate | undefined;
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
        ShiftNurse staffs every shift to your floors and census, keeps everyone inside their
        contract and the unit's rules, and shares nights, weekends and holidays fairly — taking
        account of who carried them in past schedules.
      </p>
      <ul className="mt-3 list-disc pl-5 text-sm text-text-muted">
        <li>
          You get a few versions to choose between: each one balances the same rules a little
          differently.{' '}
          <span className="font-medium text-text">
            Nothing on the schedule changes until you pick one and save it.
          </span>
        </li>
        {undecidedRequests > 0 ? (
          <li className="text-warn">
            {undecidedRequests} time-off request{undecidedRequests === 1 ? ' is' : 's are'} still
            undecided. Generate keeps those days free where it can, but deciding them first gives
            the schedule you can rely on: approved leave is planned around, not patched later.
          </li>
        ) : null}
        {unlockedCount + lockedCount > 0 ? (
          <li>
            Saving replaces the {unlockedCount} shift{unlockedCount === 1 ? '' : 's'} on the
            schedule now
            {lockedCount > 0
              ? ` and keeps your ${lockedCount} locked shift${lockedCount === 1 ? '' : 's'} where ${lockedCount === 1 ? 'it is' : 'they are'}`
              : ''}
            . Lock a shift (click it) to keep it through every Generate.
          </li>
        ) : null}
      </ul>
      {previous ? (
        <PreviousBatch
          previous={previous}
          count={count}
          continuing={continuing}
          onContinueChange={onContinueChange}
        />
      ) : null}
      <div className="mt-4">
        <label className="flex w-40 flex-col gap-1 text-xs text-text-muted">
          Versions to compare
          <input
            type="number"
            data-testid="generate-count"
            min={1}
            max={MAX_VARIATIONS}
            value={count}
            onChange={(e) => {
              const next = Math.round(Number(e.target.value));
              if (Number.isFinite(next)) onCountChange(Math.min(MAX_VARIATIONS, Math.max(1, next)));
            }}
            className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-text"
          />
        </label>
      </div>
      <details className="mt-3 text-xs text-text-muted">
        <summary className="cursor-pointer select-none">Advanced: search method</summary>
        <label className="mt-2 flex max-w-sm flex-col gap-1">
          Search method (the unit's default is set in Settings › Generate)
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
      </details>
      {chosen?.available === false ? (
        <p className="mt-1 text-xs text-warn">
          {chosen.reason}. Generate will use the fallback solver and say so in the report.
        </p>
      ) : null}
      <p data-testid="generate-estimate" className="mt-3 text-sm text-text-muted">
        {estimate ? (
          <>
            Takes <span className="font-medium text-text">{describeEstimate(estimate)}</span>
            {estimate.solver !== solver && solver !== undefined
              ? ` with ${SOLVER_LABELS[estimate.solver].name}`
              : ''}
            .
          </>
        ) : (
          'Working out how long this takes…'
        )}
      </p>
      {error !== undefined ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="mt-6 flex justify-end gap-2">
        <button type="button" className={secondaryButton} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          data-testid="generate-confirm"
          disabled={pending}
          onClick={onGenerate}
          className={primaryButton}
        >
          {pending
            ? 'Starting…'
            : continuing
              ? `Generate ${count} more`
              : count === 1
                ? 'Generate'
                : `Generate ${count} variations`}
        </button>
      </div>
    </div>
  );
}

/**
 * What a new Generate does to the variations already waiting: carries on after them with seeds
 * not yet tried (the default — repeating variations 1–3 would show nothing new), or starts over.
 * Either way it replaces them, so an unsaved variation that beats the grid is called out.
 */
function PreviousBatch({
  previous,
  count,
  continuing,
  onContinueChange,
}: {
  previous: SolveBatchStatus;
  count: number;
  continuing: boolean;
  onContinueChange: (continuing: boolean) => void;
}) {
  const first = previous.offset + previous.count + 1;
  const last = first + count - 1;
  const done = finishedRuns(previous).length;
  const choice = bestChoice(previous);
  const unsavedWinner =
    choice?.kind === 'variation' && previous.saved !== choice.index ? choice : undefined;
  return (
    <div className="mt-3 rounded-md border border-border bg-bg px-3 py-2 text-sm">
      <label className="flex items-start gap-2 text-text">
        <input
          type="checkbox"
          data-testid="generate-continue"
          checked={continuing}
          onChange={(e) => onContinueChange(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          Try new seeds: variation{count === 1 ? ` ${first}` : `s ${first}–${last}`}
          <span className="block text-xs text-text-muted">
            {continuing
              ? 'Each new seed is a fresh search and may find a lower score than the last batch.'
              : `Unticked, this starts again at variation 1 and repeats what the same inputs gave before.`}
          </span>
        </span>
      </label>
      {done > 0 ? (
        <p className="mt-2 text-xs text-text-muted">
          This replaces the {done} variation{done === 1 ? '' : 's'} waiting above the grid.
          {unsavedWinner ? (
            <span className="font-medium text-warn">
              {' '}
              Variation {variationNumber(previous, unsavedWinner.index)} scores better than the grid
              and has not been saved — save it first to keep it.
            </span>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

function runFraction(run: SolveRunStatus): number {
  if (run.state === 'queued') return 0;
  if (run.state === 'running') return run.progress?.fraction ?? 0;
  return 1;
}

function describeRun(run: SolveRunStatus): string {
  switch (run.state) {
    case 'queued':
      return 'Waiting for a free slot';
    case 'running': {
      const phase =
        run.progress?.phase === 'seeding'
          ? 'Building the first draft'
          : run.progress?.phase === 'finishing'
            ? 'Finishing'
            : run.progress?.phase === 'searching'
              ? 'Searching for a better schedule'
              : 'Improving the draft';
      return `${phase} · ${Math.round((run.progress?.fraction ?? 0) * 100)}%`;
    }
    case 'done': {
      const s = run.summary;
      if (!s) return 'Done';
      return `Done · ${digestLine(s).slice(0, 3).join(' · ')}`;
    }
    case 'failed':
      return `Failed: ${run.error ?? 'unknown error'}`;
    case 'cancelled':
      return 'Stopped';
  }
}

function Running({
  onClose,
  batch,
  cancelling,
  onCancel,
}: {
  onClose: () => void;
  batch: SolveBatchStatus;
  cancelling: boolean;
  onCancel: () => void;
}) {
  const finished = batch.runs.filter((r) => r.state === 'done').length;
  const fraction = batch.runs.reduce((sum, r) => sum + runFraction(r), 0) / batch.count;
  return (
    <div data-testid="generate-running">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-text">
          {batch.count === 1 ? 'Generating' : `Generating ${batch.count} variations`} with{' '}
          {SOLVER_LABELS[batch.solver].name}
        </span>
        <span className="text-text-muted">
          {finished} of {batch.count} done
        </span>
      </div>
      <progress
        className="mt-2 h-2 w-full overflow-hidden rounded-full [&::-webkit-progress-bar]:bg-border
          [&::-webkit-progress-value]:bg-accent"
        value={fraction}
        max={1}
        aria-label="Generate progress"
      />
      {batch.fellBackFrom ? (
        <p className="mt-2 text-sm text-warn" data-testid="generate-fallback">
          Running {SOLVER_LABELS[batch.solver].name} instead of{' '}
          {SOLVER_LABELS[batch.fellBackFrom.solver].name}: {batch.fellBackFrom.reason}.
        </p>
      ) : null}
      <ol className="mt-3 max-h-56 overflow-y-auto rounded-md border border-border text-xs">
        {batch.runs.map((run) => (
          <li
            key={run.index}
            data-testid="generate-run"
            data-state={run.state}
            className="flex justify-between gap-3 border-b border-border px-2 py-1.5 last:border-b-0"
          >
            <span className="font-medium text-text">
              Variation {variationNumber(batch, run.index)}
            </span>
            <span
              className={
                run.state === 'failed'
                  ? 'text-danger'
                  : run.state === 'done'
                    ? 'text-text'
                    : 'text-text-muted'
              }
            >
              {describeRun(run)}
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs text-text-muted">
        You can close this window: the variations keep running, and Show progress above the grid
        brings you back here.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          data-testid="generate-cancel"
          disabled={cancelling}
          onClick={onCancel}
          className={secondaryButton}
        >
          {cancelling ? 'Stopping…' : 'Stop'}
        </button>
        <button type="button" className={primaryButton} onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

/** "21 s", "3 min 5 s": how long a finished batch actually took. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const rest = seconds % 60;
  return `${Math.floor(seconds / 60)} min${rest > 0 ? ` ${rest} s` : ''}`;
}

function Finished({
  onClose,
  batch,
  onGenerateAgain,
  onCompare,
  onPreview,
}: {
  onClose: () => void;
  batch: SolveBatchStatus;
  onGenerateAgain: () => void;
  onCompare: () => void;
  onPreview: (index: number) => void;
}) {
  const done = finishedRuns(batch);
  const choice = bestChoice(batch);
  const bestIndex = choice?.kind === 'variation' ? choice.index : choice?.bestVariation;
  const took =
    batch.finishedAt !== undefined
      ? ` in ${formatElapsed(batch.finishedAt - batch.startedAt)}`
      : '';

  if (batch.stale) {
    return (
      <div data-testid="generate-finished" data-state="stale">
        <p className="text-sm text-warn">
          These variations are out of date: {batch.stale}. Generate again for ones that fit the
          schedule as it is now.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className={secondaryButton} onClick={onClose}>
            Close
          </button>
          <button type="button" onClick={onGenerateAgain} className={primaryButton}>
            Generate again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="generate-finished" data-state={done.length > 0 ? 'done' : 'empty'}>
      <p className="text-sm font-medium text-text">
        {batch.cancelled
          ? `Stopped: ${done.length} of ${batch.count} variations finished${took}.`
          : `${done.length} of ${batch.count} variation${batch.count === 1 ? '' : 's'} finished${took}.`}
      </p>
      {choice?.kind === 'grid' ? (
        <p data-testid="generate-grid-best" className="mt-1 text-sm text-success">
          {choice.tie
            ? 'The schedule already on the grid is as good as the best of these — keep it.'
            : 'The schedule already on the grid is better balanced than any of these — keep it.'}
        </p>
      ) : choice ? (
        <p className="mt-1 text-sm text-success">
          Variation {variationNumber(batch, choice.index)} strikes the best balance of staffing,
          fairness, preferences and cost.
        </p>
      ) : null}
      {batch.fellBackFrom ? (
        <p className="mt-1 text-sm text-warn" data-testid="generate-fallback">
          Ran {SOLVER_LABELS[batch.solver].name} instead of{' '}
          {SOLVER_LABELS[batch.fellBackFrom.solver].name}: {batch.fellBackFrom.reason}.
        </p>
      ) : null}
      <table className="mt-3 w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-border text-left text-text-muted">
            <th className="px-2 py-1 font-medium">&nbsp;</th>
            <th className="px-2 py-1 font-medium">Short shifts</th>
            <th
              className="px-2 py-1 font-medium"
              title="Night shifts per nurse who works nights, fewest to most"
            >
              Nights each
            </th>
            <th className="px-2 py-1 font-medium" title="Weekends per nurse, fewest to most">
              Weekends each
            </th>
            <th
              className="px-2 py-1 font-medium"
              title="Day or evening shifts too soon after nights"
            >
              Night→day flips
            </th>
            <th className="px-2 py-1 font-medium">Under contract</th>
            <th
              className="px-2 py-1 font-medium"
              title="Shifts inside a time-off request still waiting for a decision"
            >
              On days asked off
            </th>
            <th className="px-2 py-1 text-right font-medium">Cost</th>
          </tr>
        </thead>
        <tbody>
          {batch.draftObjective !== undefined ? (
            <tr
              className={`border-b border-border ${choice?.kind === 'grid' ? 'font-semibold text-success' : 'text-text-muted'}`}
            >
              <th scope="row" className="px-2 py-1 text-left font-normal">
                On the grid now
              </th>
              <td colSpan={7} className="px-2 py-1">
                {choice?.kind === 'grid' ? 'Best balance — keep it' : 'Compare all for its numbers'}
              </td>
            </tr>
          ) : null}
          {batch.runs.map((run) => {
            const s = run.summary;
            const best = choice?.kind === 'variation' && choice.index === run.index;
            return (
              <tr
                key={run.index}
                data-testid="generate-run"
                data-state={run.state}
                className={`border-b border-border last:border-b-0 ${best ? 'font-semibold text-success' : 'text-text'}`}
              >
                <th scope="row" className="px-2 py-1 text-left font-normal">
                  Variation {variationNumber(batch, run.index)}
                </th>
                {run.state === 'done' && s ? (
                  <>
                    <td className={`px-2 py-1 ${s.floorsShort > 0 ? 'text-danger' : ''}`}>
                      {s.floorsShort}
                    </td>
                    <td className="px-2 py-1">{spread(s.digest.nights)}</td>
                    <td className="px-2 py-1">{spread(s.digest.weekends)}</td>
                    <td className={`px-2 py-1 ${s.digest.quickFlips > 0 ? 'text-warn' : ''}`}>
                      {s.digest.quickFlips}
                    </td>
                    <td className="px-2 py-1">{s.digest.nursesUnderContract}</td>
                    <td className={`px-2 py-1 ${s.digest.onDaysAskedOff > 0 ? 'text-warn' : ''}`}>
                      {s.digest.onDaysAskedOff}
                    </td>
                    <td className="px-2 py-1 text-right">
                      {s.costTotal !== undefined ? formatDollars(s.costTotal) : '—'}
                    </td>
                  </>
                ) : (
                  <td
                    colSpan={7}
                    className={`px-2 py-1 ${run.state === 'failed' ? 'text-danger' : 'text-text-muted'}`}
                  >
                    {describeRun(run)}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-text-muted">
        Nights are per nurse who works nights, weekends per nurse with contracted hours, fewest to
        most. Nothing on the schedule has changed yet: preview one, then save it.
      </p>
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          data-testid="generate-again"
          onClick={onGenerateAgain}
          className={secondaryButton}
        >
          Generate more
        </button>
        {done.length > 0 ? (
          <button
            type="button"
            data-testid="generate-compare"
            onClick={onCompare}
            className={secondaryButton}
          >
            Compare all
          </button>
        ) : null}
        {choice?.kind === 'grid' ? (
          <button
            type="button"
            data-testid="generate-keep"
            className={primaryButton}
            onClick={onClose}
          >
            Keep the grid
          </button>
        ) : bestIndex !== undefined ? (
          <button
            type="button"
            data-testid="generate-preview-best"
            onClick={() => onPreview(bestIndex)}
            className={primaryButton}
          >
            Preview variation {variationNumber(batch, bestIndex)} on the grid
          </button>
        ) : (
          <button type="button" className={primaryButton} onClick={onClose}>
            Close
          </button>
        )}
      </div>
    </div>
  );
}

const primaryButton = PRIMARY;
const secondaryButton = SECONDARY;
