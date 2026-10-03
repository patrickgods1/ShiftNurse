/**
 * The variations a Generate produced, above the grid: page through them, preview one in place of
 * the draft, compare them all, and save the one to keep. While the batch runs it shows progress;
 * once anything the solver read has changed it says so, because a variation solved against last
 * week's leave is not an answer to this week's.
 */

import type { SolveBatchStatus } from '@shared/api.js';
import type { ReactNode } from 'react';
import { SOLVER_LABELS } from '../../solver-labels.js';
import { bestChoice, digestLine, finishedRuns, variationNumber } from './candidates.js';

interface CandidatesBarProps {
  batch: SolveBatchStatus;
  /** Run index of the variation on show. */
  selected: number | undefined;
  onSelect: (index: number) => void;
  previewing: boolean;
  onTogglePreview: () => void;
  onCompare: () => void;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
  onShowProgress: () => void;
  saving: boolean;
  error: string | undefined;
}

export function CandidatesBar({
  batch,
  selected,
  onSelect,
  previewing,
  onTogglePreview,
  onCompare,
  onSave,
  onDiscard,
  onCancel,
  onShowProgress,
  saving,
  error,
}: CandidatesBarProps) {
  const done = finishedRuns(batch);
  const position = done.findIndex((r) => r.index === selected);
  const current = position >= 0 ? done[position] : undefined;
  const choice = bestChoice(batch);

  if (batch.stale) {
    return (
      <Panel tone="warn">
        <p className="text-sm text-text">
          These variations are out of date: {batch.stale}. Generate again for ones that fit the
          schedule as it is now.
        </p>
        <button type="button" onClick={onDiscard} className={secondaryButton}>
          Dismiss
        </button>
      </Panel>
    );
  }

  if (batch.state === 'running') {
    return (
      <Panel>
        <p className="text-sm text-text">
          Generating {batch.count === 1 ? 'a schedule' : `${batch.count} variations`} with{' '}
          {SOLVER_LABELS[batch.solver].name} · {done.length} of {batch.count} done
        </p>
        <div className="flex shrink-0 gap-2">
          <button type="button" onClick={onShowProgress} className={secondaryButton}>
            Show progress
          </button>
          <button type="button" onClick={onCancel} className={secondaryButton}>
            Stop
          </button>
        </div>
      </Panel>
    );
  }

  if (done.length === 0) {
    const failure = batch.runs.find((r) => r.error)?.error;
    return (
      <Panel tone="danger">
        <p className="text-sm text-text">
          {batch.cancelled
            ? 'Generate was stopped before any variation finished.'
            : `No variation finished${failure ? `: ${failure}` : '.'}`}
        </p>
        <button type="button" onClick={onDiscard} className={secondaryButton}>
          Dismiss
        </button>
      </Panel>
    );
  }

  const summary = current?.summary;
  return (
    <div
      data-testid="candidates-bar"
      className="mb-3 rounded-md border border-accent/50 bg-surface px-3 py-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Previous variation"
            disabled={position <= 0}
            onClick={() => onSelect(done[position - 1]!.index)}
            className={pagerButton}
          >
            ‹
          </button>
          <span className="text-sm font-medium text-text" data-testid="candidate-position">
            Variation {current ? variationNumber(batch, current.index) : '—'}{' '}
            <span className="font-normal text-text-muted">
              ({position + 1} of {done.length})
            </span>
          </span>
          <button
            type="button"
            aria-label="Next variation"
            disabled={position < 0 || position >= done.length - 1}
            onClick={() => onSelect(done[position + 1]!.index)}
            className={pagerButton}
          >
            ›
          </button>
          {current && choice?.kind === 'variation' && choice.index === current.index ? (
            <span className="rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">
              Best overall
            </span>
          ) : null}
          {current && batch.saved === current.index ? (
            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">
              On the draft
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="candidate-preview"
            aria-pressed={previewing}
            onClick={onTogglePreview}
            className={secondaryButton}
          >
            {previewing ? 'Exit preview' : 'Preview on grid'}
          </button>
          <button type="button" onClick={onShowProgress} className={secondaryButton}>
            Summary
          </button>
          <button
            type="button"
            data-testid="candidate-compare"
            onClick={onCompare}
            className={secondaryButton}
          >
            Compare
          </button>
          <button type="button" onClick={onDiscard} className={secondaryButton}>
            Discard
          </button>
          {current && batch.saved === current.index ? (
            <span
              data-testid="candidate-saved"
              className="self-center rounded-md px-3 py-1.5 text-sm font-medium text-success"
            >
              ✓ Saved — this is the draft now
            </span>
          ) : (
            <button
              type="button"
              data-testid="candidate-save"
              disabled={saving || current === undefined}
              onClick={onSave}
              className={primaryButton}
            >
              {saving ? 'Saving…' : 'Save this schedule'}
            </button>
          )}
        </div>
      </div>
      {summary ? (
        <p className="mt-1 text-xs text-text-muted">
          {digestLine(summary).map((part, i) => (
            <span
              key={part}
              className={
                i === 0
                  ? summary.floorsShort > 0
                    ? 'text-danger'
                    : 'text-success'
                  : part.includes('rule break')
                    ? 'text-danger'
                    : undefined
              }
            >
              {i > 0 ? ' · ' : ''}
              {part}
            </span>
          ))}
          {current?.fellBackFrom
            ? ` · ran ${SOLVER_LABELS[current.solver].name} instead of ${SOLVER_LABELS[current.fellBackFrom.solver].name}`
            : ''}
        </p>
      ) : null}
      {choice?.kind === 'grid' && batch.saved === undefined ? (
        <p data-testid="grid-is-best" className="mt-1 text-xs font-medium text-success">
          {choice.tie
            ? 'The schedule on the grid is already as good as the best variation.'
            : 'The schedule on the grid is better balanced than every variation — keep it.'}
        </p>
      ) : null}
      {error !== undefined ? (
        <p role="alert" className="mt-1 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Panel({ children, tone }: { children: ReactNode; tone?: 'warn' | 'danger' }) {
  const border =
    tone === 'warn' ? 'border-warn' : tone === 'danger' ? 'border-danger' : 'border-border';
  return (
    <div
      data-testid="candidates-bar"
      className={`mb-3 flex items-center justify-between gap-3 rounded-md border ${border} bg-surface px-3 py-2`}
    >
      {children}
    </div>
  );
}

const primaryButton =
  'rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60';
const secondaryButton =
  'rounded-md border border-border px-3 py-1.5 text-sm text-text hover:bg-bg disabled:opacity-60';
const pagerButton =
  'rounded-md border border-border px-2 py-0.5 text-sm text-text hover:bg-bg disabled:opacity-40';
