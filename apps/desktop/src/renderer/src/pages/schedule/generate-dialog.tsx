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

import * as Dialog from '@radix-ui/react-dialog';
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
import { errorMessage, OVERLAY } from '../../components/ui.js';
import { formatDate } from '../../format.js';
import { SOLVER_LABELS, SOLVER_ORDER } from '../../solver-labels.js';
import { bestChoice, finishedRuns, variationNumber } from './candidates.js';

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
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY} />
        <Dialog.Content
          data-testid="generate-dialog"
          className="fixed z-50 left-1/2 top-1/2 w-[34rem] max-w-[calc(100vw-2rem)] -translate-x-1/2
            -translate-y-1/2 rounded-lg border border-border bg-surface p-6 shadow-lg"
        >
          <Dialog.Title className="mb-1 text-lg font-semibold text-text">
            Generate schedule
          </Dialog.Title>
          <Dialog.Description className="mb-4 text-sm text-text-muted">
            {period.name} · {formatDate(period.startDate)} – {formatDate(period.endDate)}
          </Dialog.Description>

          {running && batch ? (
            <Running
              batch={batch}
              cancelling={cancel.isPending}
              onCancel={() => cancel.mutate(batch.id)}
            />
          ) : !showSetup && batch ? (
            <Finished
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
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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
  lockedCount,
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
  lockedCount: number;
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
        The solver fills every shift from the coverage floors and census demand, keeps each nurse
        within the contract rules, and balances nights, weekends and holidays against the fairness
        ledger.
      </p>
      <ul className="mt-3 list-disc pl-5 text-sm text-text-muted">
        <li>
          Each variation is a different search of the same inputs. Compare them, preview them on the
          grid, and save the one you want —{' '}
          <span className="font-medium text-text">nothing on the grid changes until you save</span>.
        </li>
        <li>
          Saving replaces the <span className="font-medium text-text">{unlockedCount}</span>{' '}
          unlocked shift{unlockedCount === 1 ? '' : 's'} on the grid and keeps the{' '}
          <span className="font-medium text-text">{lockedCount}</span> locked one
          {lockedCount === 1 ? '' : 's'} exactly where they are.
        </li>
        <li>
          A variation's number fixes it: the same inputs always give the same variation 1, 2, 3…
        </li>
      </ul>
      {previous ? (
        <PreviousBatch
          previous={previous}
          count={count}
          continuing={continuing}
          onContinueChange={onContinueChange}
        />
      ) : null}
      <div className="mt-4 grid grid-cols-[8rem_1fr] gap-3">
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          Variations
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
        <label className="flex flex-col gap-1 text-xs text-text-muted">
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
      </div>
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
      return `Done · ${s.floorsShort === 0 ? 'every floor filled' : `${s.floorsShort} short`} · score ${Math.round(s.objective).toLocaleString()}`;
    }
    case 'failed':
      return `Failed: ${run.error ?? 'unknown error'}`;
    case 'cancelled':
      return 'Stopped';
  }
}

function Running({
  batch,
  cancelling,
  onCancel,
}: {
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
        <Dialog.Close asChild>
          <button type="button" className={primaryButton}>
            Close
          </button>
        </Dialog.Close>
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
  batch,
  onGenerateAgain,
  onCompare,
  onPreview,
}: {
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
          <Dialog.Close asChild>
            <button type="button" className={secondaryButton}>
              Close
            </button>
          </Dialog.Close>
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
            ? 'The schedule on the grid already scores as well as the best of these.'
            : `The schedule on the grid scores better than every variation (${choice.gridScore.toLocaleString()} against ${choice.bestScore.toLocaleString()}). Keeping it is the strongest choice.`}
        </p>
      ) : choice ? (
        <p className="mt-1 text-sm text-success">
          Variation {variationNumber(batch, choice.index)} scores best (
          {choice.score.toLocaleString()}
          {choice.gridScore !== undefined
            ? ` against ${choice.gridScore.toLocaleString()} on the grid now`
            : ''}
          ).
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
            <th className="px-2 py-1 font-medium">Short</th>
            <th className="px-2 py-1 font-medium">Rule breaks</th>
            <th className="px-2 py-1 text-right font-medium">Score</th>
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
              <td className="px-2 py-1">—</td>
              <td className="px-2 py-1">—</td>
              <td className="px-2 py-1 text-right">
                {Math.round(batch.draftObjective).toLocaleString()}
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
                    <td className="px-2 py-1">
                      {s.hardViolations} hard · {s.softViolations} soft
                    </td>
                    <td className="px-2 py-1 text-right">
                      {Math.round(s.objective).toLocaleString()}
                    </td>
                  </>
                ) : (
                  <td
                    colSpan={3}
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
        Score is everything the solver weighs — staffing, hours, fairness, preferences, cost — in
        one number; lower is better. Nothing on the grid has changed.
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
          <Dialog.Close asChild>
            <button type="button" data-testid="generate-keep" className={primaryButton}>
              Keep the grid
            </button>
          </Dialog.Close>
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
          <Dialog.Close asChild>
            <button type="button" className={primaryButton}>
              Close
            </button>
          </Dialog.Close>
        )}
      </div>
    </div>
  );
}

const primaryButton =
  'rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60';
const secondaryButton =
  'rounded-md border border-border px-3 py-1.5 text-sm text-text hover:bg-bg disabled:opacity-60';
