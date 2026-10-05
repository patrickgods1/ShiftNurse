/**
 * "Census dropped": a shift with more nurses of a role than its patients need. Lists who goes
 * home first, in the unit's own order, each place with the reason the order gave it, and lets the
 * manager mark who volunteered. Only the nurse at the top can be cancelled — the order is the
 * contract's, and main refuses anything else — so the one button is on that row, behind a
 * confirmation that repeats why.
 */

import type { OverstaffedRole, TodayShiftView } from '@shared/api.js';
import type { Id } from '@shiftnurse/core';
import { useState } from 'react';
import { useCancelForCensus, useCancellationOrder } from '../../api-dayof.js';
import { useConfirm } from '../../components/confirm.js';
import { DANGER, errorMessage } from '../../components/ui.js';

export function CensusDrop({
  unitId,
  shift,
  over,
}: {
  unitId: Id;
  shift: TodayShiftView;
  over: OverstaffedRole;
}) {
  const confirm = useConfirm();
  // In the order they offered: the first to offer is the first volunteer sent home.
  const [volunteers, setVolunteers] = useState<Id[]>([]);
  const orderQuery = useCancellationOrder(
    over.periodId,
    shift.date,
    shift.shiftType.id,
    over.role,
    volunteers,
  );
  const cancel = useCancelForCensus(unitId);
  const view = orderQuery.data;

  async function cancelNext(nurseId: Id, name: string, reason: string) {
    const ok = await confirm({
      title: `Cancel ${name}’s ${shift.shiftType.abbreviation} shift?`,
      description: `${reason} The shift comes off the schedule and counts as a low-census cancellation.`,
      confirmLabel: `Cancel ${name}`,
    });
    if (!ok) return;
    cancel.mutate(
      {
        periodId: over.periodId,
        date: shift.date,
        shiftTypeId: shift.shiftType.id,
        role: over.role,
        volunteers,
        nurseId,
      },
      { onSuccess: () => setVolunteers([]) },
    );
  }

  return (
    <div
      className="mt-3 rounded-md border border-warn/40 bg-warn/10 p-3"
      data-testid={`census-drop-${over.role}`}
    >
      <h3 className="text-sm font-semibold text-text">
        Census dropped — {over.excess} more than needed
      </h3>
      <p className="text-xs text-text-muted">
        {over.role}: {over.staffed} on the shift, {over.required} needed. Whoever goes home first is
        at the top.
      </p>
      {orderQuery.isError ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {errorMessage(orderQuery.error)}
        </p>
      ) : null}
      {view !== undefined ? (
        <>
          <ol className="mt-2 flex flex-col gap-2 text-sm">
            {view.order.map((place, index) => (
              <li
                key={place.nurseId}
                className="flex items-start justify-between gap-3 rounded border border-border bg-surface px-2 py-1.5"
              >
                <div className="flex flex-col">
                  <span className="text-text">
                    {index + 1}. {place.name}
                  </span>
                  <span className="text-xs text-text-muted">{place.reason}</span>
                  <label className="mt-1 flex items-center gap-1.5 text-xs text-text-muted">
                    <input
                      type="checkbox"
                      checked={volunteers.includes(place.nurseId)}
                      onChange={(e) =>
                        setVolunteers(
                          e.target.checked
                            ? [...volunteers, place.nurseId]
                            : volunteers.filter((id) => id !== place.nurseId),
                        )
                      }
                    />
                    {`${place.name} volunteered to go home`}
                  </label>
                </div>
                {index === 0 && view.excess > 0 ? (
                  <button
                    type="button"
                    className={DANGER}
                    disabled={cancel.isPending}
                    onClick={() => void cancelNext(place.nurseId, place.name, place.reason)}
                  >
                    {`Cancel ${place.name}`}
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
          {view.excluded.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1 text-xs text-text-muted">
              {view.excluded.map((e) => (
                <li key={e.nurseId}>
                  <span className="font-medium">Not cancelled:</span> {e.reason}
                </li>
              ))}
            </ul>
          ) : null}
          {view.order.length === 0 ? (
            <p className="mt-2 text-sm text-text-muted">
              Nobody on this shift can be ranked for cancellation under the unit’s order. Settings ›
              Requests sets which groups are included.
            </p>
          ) : null}
        </>
      ) : null}
      {errorMessage(cancel.error) !== undefined ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {errorMessage(cancel.error)}
        </p>
      ) : null}
    </div>
  );
}
