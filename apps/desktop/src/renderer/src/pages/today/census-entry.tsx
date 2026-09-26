/**
 * Actual census for one of today's shifts, entered right on the shift card so a manager can
 * correct the forecast the moment they know the real count — which immediately re-runs the
 * staffing check via `dayOf.today`, since a role's `required` is derived from whichever basis
 * (actual, forecast, floor) is in force.
 *
 * When no forecast row exists yet for this date/shift, there is nothing to record actuals
 * against, so the first save creates one (`census.upsert`, `source: 'manual'`) and then records
 * the actual on the row it gets back.
 */

import type { TodayShiftView } from '@shared/api.js';
import type { Id } from '@shiftnurse/core';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  sumMix,
  useAcuityTiers,
  useRecordActualCensus,
  useUpsertCensus,
} from '../../api-demand.js';
import { errorMessage, INPUT, LABEL, PRIMARY } from '../../components/ui.js';

export function CensusEntry({ unitId, shift }: { unitId: Id; shift: TodayShiftView }) {
  const date = shift.date;
  const census = shift.census;
  const tiersQuery = useAcuityTiers(unitId);
  const tiers = tiersQuery.data ?? [];

  const [censusValue, setCensusValue] = useState<number>(
    census?.actualCensus ?? census?.projectedCensus ?? 0,
  );
  const [mix, setMix] = useState<Record<Id, number>>(
    census?.actualAcuityMix ?? census?.acuityMix ?? {},
  );

  useEffect(() => {
    setCensusValue(census?.actualCensus ?? census?.projectedCensus ?? 0);
    setMix(census?.actualAcuityMix ?? census?.acuityMix ?? {});
  }, [census]);

  const queryClient = useQueryClient();
  const recordActual = useRecordActualCensus(unitId, date, date);
  const upsertCensus = useUpsertCensus(unitId, date, date);

  const mixTotal = sumMix(mix);
  const balanced = mixTotal === censusValue;
  const pending = recordActual.isPending || upsertCensus.isPending;
  const saveError = errorMessage(upsertCensus.error ?? recordActual.error);

  async function save() {
    let id = census?.id;
    if (id === undefined) {
      const created = await upsertCensus.mutateAsync({
        unitId,
        date,
        shiftTypeId: shift.shiftType.id,
        projectedCensus: censusValue,
        acuityMix: mix,
        source: 'manual',
      });
      id = created.id;
    }
    await recordActual.mutateAsync({ id, actualCensus: censusValue, actualAcuityMix: mix });
    void queryClient.invalidateQueries({ queryKey: ['dayOf'] });
  }

  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-2 border-t border-border pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        // The mutations carry their own error; catching here only stops an unhandled rejection.
        if (balanced) save().catch(() => undefined);
      }}
    >
      <label className={LABEL}>
        Actual census
        <input
          type="number"
          min={0}
          className={`${INPUT} w-20`}
          value={censusValue}
          onChange={(e) => setCensusValue(Number(e.target.value))}
        />
      </label>
      {tiers.map((tier) => (
        <label key={tier.id} className={LABEL}>
          {tier.name}
          <input
            type="number"
            min={0}
            className={`${INPUT} w-20`}
            value={mix[tier.id] ?? 0}
            onChange={(e) => setMix((m) => ({ ...m, [tier.id]: Number(e.target.value) }))}
          />
        </label>
      ))}
      {!balanced ? <p className="text-xs text-danger">Tiers must add up to {censusValue}</p> : null}
      {saveError !== undefined ? (
        <p role="alert" className="text-xs text-danger">
          Census not saved: {saveError}
        </p>
      ) : null}
      <button type="submit" className={PRIMARY} disabled={!balanced || pending}>
        {pending ? 'Saving…' : 'Save census'}
      </button>
    </form>
  );
}
