/**
 * Add a year of holidays: the proposal `planHolidayYear` makes from the year before (or the US
 * federal list), shown for review. Every row can be left out, re-dated, renamed or moved between
 * major and minor before anything is saved; pairings follow along, and the notes say what was
 * skipped and which pairs must wait for a later year.
 */

import * as Dialog from '@radix-ui/react-dialog';
import type { Holiday, HolidayYearPlan, Id, IsoDate, PairTarget } from '@shiftnurse/core';
import { isIsoDate } from '@shiftnurse/core';
import { useState } from 'react';
import { useAddHolidayYear, useHolidayYearPlan } from '../../../api-config.js';
import { AsyncState } from '../../../components/async-state.js';
import {
  DIALOG,
  errorMessage,
  INPUT,
  OVERLAY,
  PRIMARY,
  SECONDARY,
} from '../../../components/ui.js';
import { applyPlanEdits, type PlanEdit } from './model.js';

export function HolidayYearDialog({
  unitId,
  holidays,
  open,
  defaultYear,
  onClose,
}: {
  unitId: Id;
  holidays: readonly Holiday[];
  open: boolean;
  defaultYear: number;
  onClose: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY} />
        <Dialog.Content className={`${DIALOG} w-[720px]`} aria-describedby="holiday-year-help">
          {open ? (
            <YearForm
              unitId={unitId}
              holidays={holidays}
              defaultYear={defaultYear}
              onClose={onClose}
            />
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function YearForm({
  unitId,
  holidays,
  defaultYear,
  onClose,
}: {
  unitId: Id;
  holidays: readonly Holiday[];
  defaultYear: number;
  onClose: () => void;
}) {
  const [year, setYear] = useState(defaultYear);
  const planQuery = useHolidayYearPlan(unitId, year);
  const add = useAddHolidayYear();
  const [edits, setEdits] = useState<Record<string, PlanEdit>>({});
  const [droppedRepairs, setDroppedRepairs] = useState<Set<Id>>(new Set());

  const plan = planQuery.data;
  const edit = (key: string, change: PlanEdit) =>
    setEdits((prev) => ({ ...prev, [key]: { ...prev[key], ...change } }));
  const input = plan
    ? applyPlanEdits(plan, edits, (minorId) => !droppedRepairs.has(minorId))
    : undefined;
  const badDate = input?.holidays.some((r) => !isIsoDate(r.date)) ?? false;
  const badName = input?.holidays.some((r) => r.name.trim() === '') ?? false;
  const existing = new Map(holidays.map((h) => [h.id, h]));

  return (
    <>
      <Dialog.Title className="text-base font-semibold text-text">
        Add a year of holidays
      </Dialog.Title>
      <p id="holiday-year-help" className="mt-1 text-sm text-text-muted">
        Proposed from last year's list with the same names, major/minor split and pairings. The
        federal holidays that move (Thanksgiving, Memorial Day) get their new dates; others keep
        their month and day. Check each date, then add.
      </p>

      <label className="mt-3 flex items-center gap-2 text-sm text-text">
        Year
        <input
          type="number"
          min={1971}
          max={9999}
          value={year}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isInteger(next) && next >= 1971 && next <= 9999) {
              setYear(next);
              setEdits({});
              setDroppedRepairs(new Set());
            }
          }}
          className={`${INPUT} w-24`}
        />
      </label>

      {planQuery.isPending ? (
        <AsyncState status="loading" label="Proposing holidays" />
      ) : planQuery.isError ? (
        <AsyncState status="error" label="Could not propose holidays" error={planQuery.error} />
      ) : plan === undefined || input === undefined ? null : (
        <>
          <p className="mt-3 text-sm text-text">
            {plan.holidays.length === 0
              ? `Nothing to add: ${year} already has every holiday.`
              : plan.holidays.every((p) => p.from === 'federal')
                ? `No holidays for ${year - 1} to copy, so this is the US federal list.`
                : `From ${year - 1}'s list.`}
          </p>
          {plan.holidays.length > 0 ? (
            <table className="mt-2 w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-text-muted">
                  <th className="py-1 pr-2 font-medium">Add</th>
                  <th className="py-1 pr-2 font-medium">Date</th>
                  <th className="py-1 pr-2 font-medium">Name</th>
                  <th className="py-1 pr-2 font-medium">Major</th>
                  <th className="py-1 font-medium">Paired with</th>
                </tr>
              </thead>
              <tbody>
                {plan.holidays.map((p) => {
                  const e = edits[p.key] ?? {};
                  const included = e.include !== false;
                  const row = input.holidays.find((r) => r.key === p.key);
                  const label = e.name ?? p.name;
                  return (
                    <tr key={p.key} className="border-b border-border last:border-0">
                      <td className="py-1 pr-2">
                        <input
                          type="checkbox"
                          aria-label={`Add ${label}`}
                          checked={included}
                          onChange={(event) => edit(p.key, { include: event.target.checked })}
                        />
                      </td>
                      <td className="py-1 pr-2">
                        <input
                          type="date"
                          aria-label={`Date of ${label}`}
                          disabled={!included}
                          value={e.date ?? p.date}
                          onChange={(event) => edit(p.key, { date: event.target.value as IsoDate })}
                          className={`${INPUT} py-0.5`}
                        />
                      </td>
                      <td className="py-1 pr-2">
                        <input
                          type="text"
                          aria-label={`Name of ${label}`}
                          disabled={!included}
                          value={label}
                          onChange={(event) => edit(p.key, { name: event.target.value })}
                          className={`${INPUT} w-full py-0.5`}
                        />
                      </td>
                      <td className="py-1 pr-2">
                        <input
                          type="checkbox"
                          aria-label={`${label} is a major holiday`}
                          disabled={!included}
                          checked={e.isMajor ?? p.isMajor}
                          onChange={(event) => edit(p.key, { isMajor: event.target.checked })}
                        />
                      </td>
                      <td className="py-1 text-xs text-text-muted">
                        {row?.pairWith ? describeTarget(row.pairWith, plan, edits, existing) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : null}

          <Notes
            plan={plan}
            edits={edits}
            existing={existing}
            dropped={droppedRepairs}
            onToggleRepair={(minorId, keep) =>
              setDroppedRepairs((prev) => {
                const next = new Set(prev);
                if (keep) next.delete(minorId);
                else next.add(minorId);
                return next;
              })
            }
          />

          {badDate || badName ? (
            <p role="alert" className="mt-2 text-sm text-danger">
              Every holiday being added needs a name and a date.
            </p>
          ) : add.isError ? (
            <p role="alert" className="mt-2 text-sm text-danger">
              {errorMessage(add.error)}
            </p>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className={SECONDARY} onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className={PRIMARY}
              disabled={
                add.isPending ||
                badDate ||
                badName ||
                (input.holidays.length === 0 && input.repairs.length === 0)
              }
              onClick={() => add.mutate({ unitId, input }, { onSuccess: onClose })}
            >
              {add.isPending
                ? 'Adding…'
                : `Add ${input.holidays.length} holiday${input.holidays.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </>
      )}
    </>
  );
}

function describeTarget(
  target: PairTarget,
  plan: HolidayYearPlan,
  edits: Readonly<Record<string, PlanEdit>>,
  existing: ReadonlyMap<Id, Holiday>,
): string {
  if ('holidayId' in target) {
    const h = existing.get(target.holidayId);
    return h ? `${h.name} (${h.date})` : '—';
  }
  const p = plan.holidays.find((x) => x.key === target.key);
  return p ? `${edits[p.key]?.name ?? p.name} (${edits[p.key]?.date ?? p.date})` : '—';
}

function Notes({
  plan,
  edits,
  existing,
  dropped,
  onToggleRepair,
}: {
  plan: HolidayYearPlan;
  edits: Readonly<Record<string, PlanEdit>>;
  existing: ReadonlyMap<Id, Holiday>;
  dropped: ReadonlySet<Id>;
  onToggleRepair: (minorId: Id, keep: boolean) => void;
}) {
  if (plan.repairs.length === 0 && plan.skipped.length === 0 && plan.unpaired.length === 0) {
    return null;
  }
  return (
    <div className="mt-3 flex flex-col gap-2 text-sm">
      {plan.repairs.map((r) => {
        const minor = existing.get(r.minorId);
        if (!minor) return null;
        return (
          <label key={r.minorId} className="flex items-center gap-2 text-text">
            <input
              type="checkbox"
              checked={!dropped.has(r.minorId)}
              onChange={(event) => onToggleRepair(r.minorId, event.target.checked)}
            />
            Also pair {minor.name} ({minor.date}) with{' '}
            {describeTarget(r.pairWith, plan, edits, existing)}
          </label>
        );
      })}
      {plan.skipped.length > 0 ? (
        <p className="text-text-muted">
          Not proposed: {plan.skipped.map((s) => `${s.name} (${s.reason})`).join('; ')}.
        </p>
      ) : null}
      {plan.unpaired.length > 0 ? (
        <p className="text-text-muted">
          Pairs that wait for a later year:{' '}
          {plan.unpaired.map((u) => `${u.name} with ${u.partner} ${u.year}`).join('; ')}. They are
          paired when{' '}
          {plan.unpaired
            .map((u) => u.year)
            .filter((y, i, a) => a.indexOf(y) === i)
            .join(', ')}{' '}
          is added.
        </p>
      ) : null}
    </div>
  );
}
