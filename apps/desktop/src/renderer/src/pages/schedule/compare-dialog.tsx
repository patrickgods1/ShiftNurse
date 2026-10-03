/**
 * Every variation beside the current draft, one row per thing a manager weighs: staffing gaps,
 * rule breaks, fairness, preferences, overtime, money. Main scores every column — the draft too —
 * with the same objective and rule engine, so a difference between two columns is a difference
 * between the schedules, never between two ways of counting.
 *
 * The best value on each row is marked across every column, the grid's included: keeping the
 * schedule already on the grid is one of the choices, and when it wins a row — or the overall
 * score — the manager should see that rather than be steered to a worse variation.
 */

import * as Dialog from '@radix-ui/react-dialog';
import type { ComparisonColumn } from '@shared/api.js';
import type { Id, Nurse } from '@shiftnurse/core';
import { useComparison } from '../../api-solver.js';
import { AsyncState } from '../../components/async-state.js';
import { DIALOG, OVERLAY } from '../../components/ui.js';
import { formatDollars, formatHours, formatSignedDollars } from '../../money.js';
import { SOLVER_LABELS } from '../../solver-labels.js';
import { spread } from './candidates.js';

interface CompareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  periodId: Id;
  batchId: Id | undefined;
  /** Variations before this batch, so columns carry the numbers the bar shows. */
  offset: number;
  nurses: readonly Nurse[];
  selected: number | undefined;
  onSelect: (index: number) => void;
  onPreview: (index: number) => void;
}

interface Row {
  label: string;
  hint?: string;
  value: (c: ComparisonColumn) => number | undefined;
  show: (c: ComparisonColumn, names: ReadonlyMap<Id, string>) => string;
  better: 'lower' | 'higher' | 'none';
  /** Decimals shown: values that read the same are ranked the same. */
  decimals?: number;
}

/** Fewest–most spreads read as fairer the narrower they are. */
const width = (r: { min: number; max: number }) => r.max - r.min;

const ROWS: Row[] = [
  {
    label: 'Short shifts',
    hint: 'Staff missing below a minimum or patient ratio',
    value: (c) => c.floorsShort,
    show: (c) => String(c.floorsShort),
    better: 'lower',
  },
  {
    label: 'Rule breaks',
    hint: 'Contract or safety rules broken',
    value: (c) => c.hardViolations,
    show: (c) => String(c.hardViolations),
    better: 'lower',
  },
  {
    label: 'Warnings',
    hint: 'Advice the schedule goes against',
    value: (c) => c.softViolations,
    show: (c) => String(c.softViolations),
    better: 'lower',
  },
  {
    label: 'Nights each',
    hint: 'Per nurse who works nights, fewest to most',
    value: (c) => width(c.digest.nights),
    show: (c) => spread(c.digest.nights),
    better: 'lower',
  },
  {
    label: 'Weekends each',
    hint: 'Per nurse with contracted hours, fewest to most',
    value: (c) => width(c.digest.weekends),
    show: (c) => spread(c.digest.weekends),
    better: 'lower',
  },
  {
    label: 'Night-to-day flips',
    hint: 'Day or evening shifts too soon after nights',
    value: (c) => c.digest.quickFlips,
    show: (c) => String(c.digest.quickFlips),
    better: 'lower',
  },
  {
    label: 'On days asked off',
    hint: 'Shifts inside a time-off request not yet decided',
    value: (c) => c.digest.onDaysAskedOff,
    show: (c) => String(c.digest.onDaysAskedOff),
    better: 'lower',
  },
  {
    label: 'Against preferences',
    hint: 'Shifts a nurse asked not to work',
    value: (c) => c.digest.againstPreference,
    show: (c) => String(c.digest.againstPreference),
    better: 'lower',
  },
  {
    label: 'Under contract',
    hint: 'Nurses short of their contracted hours',
    value: (c) => c.digest.nursesUnderContract,
    show: (c) => String(c.digest.nursesUnderContract),
    better: 'lower',
  },
  {
    label: 'Fairness, average',
    hint: '100 = everyone at their fair share',
    value: (c) => c.fairnessMean,
    show: (c) => c.fairnessMean.toFixed(0),
    better: 'higher',
    decimals: 0,
  },
  {
    label: 'Least fairly treated',
    hint: 'Lowest fairness among nurses with contracted hours',
    value: (c) => c.worstNurse?.score,
    show: (c, names) =>
      c.worstNurse
        ? `${c.worstNurse.score.toFixed(0)} · ${names.get(c.worstNurse.nurseId) ?? 'unknown'}`
        : '—',
    better: 'higher',
    decimals: 0,
  },
  {
    label: 'Overtime',
    value: (c) => c.overtimeHours,
    show: (c) => (c.overtimeHours === undefined ? '—' : formatHours(c.overtimeHours)),
    better: 'lower',
  },
  {
    label: 'Total cost',
    value: (c) => c.costTotal,
    show: (c) =>
      c.costTotal === undefined
        ? '—'
        : formatDollars(c.costTotal) +
          (c.unpricedAssignments ? ` · ${c.unpricedAssignments} unpriced` : ''),
    better: 'lower',
  },
  {
    label: 'Against budget',
    value: (c) => c.budgetVariance?.variance,
    show: (c) => (c.budgetVariance ? formatSignedDollars(c.budgetVariance.variance) : '—'),
    better: 'lower',
  },
  {
    label: 'Shifts that change',
    hint: 'Against the schedule on the grid now',
    value: (c) => c.shiftsChanged,
    show: (c) => String(c.shiftsChanged),
    better: 'none',
  },
];

/** Indexes of the columns holding the best value, or none when every column ties. */
function bestOf(row: Row, columns: readonly ComparisonColumn[]): Set<number> {
  if (row.better === 'none') return new Set();
  const scale = 10 ** (row.decimals ?? 0);
  const values = columns.map((c) => {
    const v = row.value(c);
    return v === undefined ? undefined : Math.round(v * scale) / scale;
  });
  const present = values.filter((v): v is number => v !== undefined);
  if (present.length < 2) return new Set();
  const target = row.better === 'lower' ? Math.min(...present) : Math.max(...present);
  // Rounded as shown, so two columns that read the same are not told apart by what is hidden.
  const same = (v: number) => v === target;
  const best = new Set(values.flatMap((v, i) => (v !== undefined && same(v) ? [i] : [])));
  return best.size === present.length ? new Set() : best;
}

export function CompareDialog({
  open,
  onOpenChange,
  periodId,
  batchId,
  offset,
  nurses,
  selected,
  onSelect,
  onPreview,
}: CompareDialogProps) {
  const comparison = useComparison(periodId, batchId, open);
  const names = new Map(nurses.map((n) => [n.id, `${n.firstName} ${n.lastName}`]));
  const data = comparison.data;
  const hasBudget = data?.candidates.some((c) => c.budgetVariance !== undefined) ?? false;
  const rows = ROWS.filter((r) => r.label !== 'Against budget' || hasBudget);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY} />
        <Dialog.Content data-testid="compare-dialog" className={`${DIALOG} w-[60rem]`}>
          <Dialog.Title className="mb-1 text-lg font-semibold text-text">
            Compare variations
          </Dialog.Title>
          <Dialog.Description className="mb-4 text-sm text-text-muted">
            Each variation beside the schedule on the grid now. The best on each row is marked, the
            grid included; pick a variation to preview or save it.
          </Dialog.Description>
          {comparison.isPending ? (
            <AsyncState status="loading" label="Scoring the variations" />
          ) : comparison.isError || !data ? (
            <AsyncState
              status="error"
              label="Could not compare the variations"
              error={comparison.error}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-text-muted">
                    <th className="px-2 py-2 font-medium">&nbsp;</th>
                    <th className="px-2 py-2 font-medium">On the grid</th>
                    {data.candidates.map((c) => (
                      <th
                        key={c.index}
                        className={`px-2 py-2 font-medium ${c.index === selected ? 'bg-accent/10' : ''}`}
                      >
                        <button
                          type="button"
                          onClick={() => onSelect(c.index!)}
                          aria-pressed={c.index === selected}
                          className="text-left text-text underline-offset-2 hover:underline"
                        >
                          Variation {offset + c.index! + 1}
                        </button>
                        {c.fellBackFrom ? (
                          <span
                            className="block text-[10px] text-warn"
                            title={c.fellBackFrom.reason}
                          >
                            ran {c.solver ? SOLVER_LABELS[c.solver].name : 'fallback'}
                          </span>
                        ) : null}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    // Column 0 is the grid; variation i is column i + 1.
                    const best = bestOf(row, [data.draft, ...data.candidates]);
                    return (
                      <tr key={row.label} className="border-b border-border last:border-b-0">
                        <th scope="row" className="px-2 py-1.5 text-left font-normal text-text">
                          {row.label}
                          {row.hint ? (
                            <span className="block text-[11px] text-text-muted">{row.hint}</span>
                          ) : null}
                        </th>
                        <td
                          className={`px-2 py-1.5 ${
                            best.has(0) ? 'font-semibold text-success' : 'text-text-muted'
                          }`}
                        >
                          {row.show(data.draft, names)}
                          {best.has(0) ? <span className="sr-only"> (best)</span> : null}
                        </td>
                        {data.candidates.map((c, i) => (
                          <td
                            key={c.index}
                            className={`px-2 py-1.5 ${c.index === selected ? 'bg-accent/10' : ''} ${
                              best.has(i + 1) ? 'font-semibold text-success' : 'text-text'
                            }`}
                          >
                            {row.show(c, names)}
                            {best.has(i + 1) ? <span className="sr-only"> (best)</span> : null}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button type="button" className={secondaryButton}>
                Close
              </button>
            </Dialog.Close>
            <button
              type="button"
              disabled={selected === undefined}
              onClick={() => {
                if (selected === undefined) return;
                onPreview(selected);
                onOpenChange(false);
              }}
              className={primaryButton}
            >
              Preview variation {selected === undefined ? '' : offset + selected + 1} on the grid
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const primaryButton =
  'rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60';
const secondaryButton =
  'rounded-md border border-border px-3 py-1.5 text-sm text-text hover:bg-bg disabled:opacity-60';
