/**
 * Who goes home first when the census drops. The contract usually fixes the order, and the unit's
 * own differs in small ways (no agency staff, volunteers last), so the tiers are reorderable and
 * can be left out. A tier left out is never cancelled by the screen: the manager still can, by
 * hand, but the app will not rank someone the unit's policy excludes.
 */

import type { CancellationTier } from '@shiftnurse/core';
import { useState } from 'react';
import { useCancellationPolicy, useSaveCancellationPolicy } from '../../api-dayof.js';
import { AsyncState } from '../../components/async-state.js';
import { LabelWithTip } from '../../components/field-help.js';
import { errorMessage, PRIMARY, SECONDARY, SMALL } from '../../components/ui.js';
import { useUnsavedChanges } from '../../components/unsaved-changes.js';
import { useUnitId } from '../../unit-context.js';

const ALL_TIERS: readonly CancellationTier[] = [
  'volunteer',
  'agency',
  'overtime',
  'per_diem',
  'rotation',
];

const TIER_TEXT: Record<CancellationTier, { label: string; hint: string }> = {
  volunteer: { label: 'Nurses who offer to go home', hint: 'In the order they offered.' },
  agency: {
    label: 'Agency and travel nurses',
    hint: 'The unit pays a premium for them; the most junior goes first.',
  },
  overtime: {
    label: 'Staff on overtime for the shift',
    hint: 'Overtime nobody needs any more; the most junior goes first.',
  },
  per_diem: {
    label: 'Per diem staff',
    hint: 'No contracted hours to protect; the most junior goes first.',
  },
  rotation: {
    label: 'The unit’s own staff, in rotation',
    hint: 'The fewest cancellations in the last year, then whoever was cancelled longest ago, then the most junior.',
  },
};

interface Row {
  tier: CancellationTier;
  included: boolean;
}

function rowsFor(saved: readonly CancellationTier[]): Row[] {
  return [
    ...saved.map((tier) => ({ tier, included: true })),
    ...ALL_TIERS.filter((t) => !saved.includes(t)).map((tier) => ({ tier, included: false })),
  ];
}

export default function CancellationOrderPanel() {
  const unitId = useUnitId();
  const policyQuery = useCancellationPolicy(unitId);
  if (policyQuery.isPending) return <AsyncState status="loading" label="Loading order" />;
  if (policyQuery.isError) {
    return <AsyncState status="error" label="Could not load order" error={policyQuery.error} />;
  }
  return <OrderForm key={policyQuery.data.join(',')} saved={policyQuery.data} />;
}

function OrderForm({ saved }: { saved: CancellationTier[] }) {
  const unitId = useUnitId();
  const save = useSaveCancellationPolicy(unitId);
  const [rows, setRows] = useState<Row[]>(() => rowsFor(saved));

  const chosen = rows.filter((r) => r.included).map((r) => r.tier);
  const dirty = chosen.join(',') !== saved.join(',');
  useUnsavedChanges('Cancellation order', dirty);

  function move(index: number, by: -1 | 1) {
    const target = index + by;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    [next[index], next[target]] = [next[target]!, next[index]!];
    setRows(next);
  }

  return (
    <section
      className="rounded-md border border-border bg-surface p-4"
      data-testid="cancellation-order"
    >
      <h2 className="text-sm font-semibold text-text">
        <LabelWithTip
          label="Low-census cancellation order"
          tip={
            'Most contracts fix who is sent home first when there are more nurses on a shift than ' +
            'its patients need. Match yours here; the Today screen then ranks the shift’s nurses ' +
            'by it and gives each place its reason. The charge nurse is never cancelled.'
          }
        />
      </h2>
      <p className="mt-1 max-w-prose text-sm text-text-muted">
        When a shift has more nurses than it needs, Today lists who goes home first, top to bottom.
        Untick a tier to leave those nurses out of the list.
      </p>
      <ol className="mt-3 flex max-w-xl flex-col gap-2">
        {rows.map((row, index) => (
          <li
            key={row.tier}
            className="flex items-center gap-3 rounded-md border border-border bg-bg px-3 py-2"
          >
            <input
              type="checkbox"
              id={`tier-${row.tier}`}
              checked={row.included}
              onChange={(e) =>
                setRows(rows.map((r) => (r === row ? { ...r, included: e.target.checked } : r)))
              }
            />
            <label htmlFor={`tier-${row.tier}`} className="flex flex-1 flex-col text-sm text-text">
              {TIER_TEXT[row.tier].label}
              <span className="text-xs text-text-muted">{TIER_TEXT[row.tier].hint}</span>
            </label>
            <button
              type="button"
              className={SMALL}
              aria-label={`Move ${TIER_TEXT[row.tier].label} up`}
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              Up
            </button>
            <button
              type="button"
              className={SMALL}
              aria-label={`Move ${TIER_TEXT[row.tier].label} down`}
              disabled={index === rows.length - 1}
              onClick={() => move(index, 1)}
            >
              Down
            </button>
          </li>
        ))}
      </ol>
      {chosen.length === 0 ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          Keep at least one tier, or nobody can be ranked for cancellation.
        </p>
      ) : null}
      {errorMessage(save.error) !== undefined ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {errorMessage(save.error)}
        </p>
      ) : null}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          className={PRIMARY}
          disabled={!dirty || chosen.length === 0 || save.isPending}
          onClick={() => save.mutate(chosen)}
        >
          Save order
        </button>
        <button
          type="button"
          className={SECONDARY}
          disabled={!dirty || save.isPending}
          onClick={() => {
            setRows(rowsFor(saved));
            save.reset();
          }}
        >
          Discard
        </button>
      </div>
    </section>
  );
}
