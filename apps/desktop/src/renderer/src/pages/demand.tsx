/**
 * The Demand page: manual census entry, forecast-from-history proposals, the staffing demand
 * those numbers imply, and a back-test of the forecaster against what actually happened.
 *
 * This is the one page where a manager's raw guess ("22 patients Tuesday") turns into a
 * contractual/ratio-driven nurse count — see packages/core/src/acuity/demand.ts for why that
 * derivation exists and packages/core/src/acuity/forecast.ts for why the model stays simple.
 */

import type { Id, IsoDate, ShiftType } from '@shiftnurse/core';
import { addDays, datesInRange, isoDate, today } from '@shiftnurse/core';
import { useMemo, useState } from 'react';
import { usePeriods, useShiftTypes } from '../api.js';
import {
  tierNameLookup,
  useAcuityTiers,
  useBacktest,
  useCensus,
  useDemand,
  useProposeCensus,
  useRecordActualCensus,
  useUpsertCensus,
  useUpsertManyCensus,
} from '../api-demand.js';
import { AsyncState } from '../components/async-state.js';
import { PageHeader } from '../components/page-header.js';
import { useUnitId } from '../unit-context.js';
import { BacktestPanel } from './demand/backtest-panel.js';
import { CensusGrid } from './demand/census-grid.js';
import { DemandTable } from './demand/demand-table.js';
import { ProposeDialog } from './demand/propose-dialog.js';

const LOOKBACK_OPTIONS = [4, 8, 12] as const;

/** The current draft period if there is one, else the next 14 days from today. */
function useDefaultRange(unitId: Id | undefined): { start: IsoDate; end: IsoDate } {
  const periodsQuery = usePeriods(unitId);
  return useMemo(() => {
    const draft = periodsQuery.data?.find((p) => p.status === 'draft');
    if (draft !== undefined) return { start: draft.startDate, end: draft.endDate };
    const start = today();
    return { start, end: addDays(start, 13) };
  }, [periodsQuery.data]);
}

function shiftTypesById(shiftTypes: ShiftType[] | undefined): Map<Id, ShiftType> {
  return new Map((shiftTypes ?? []).map((s) => [s.id, s]));
}

export default function DemandPage() {
  const unitId = useUnitId();
  const defaultRange = useDefaultRange(unitId);
  const [start, setStart] = useState<IsoDate | undefined>(undefined);
  const [end, setEnd] = useState<IsoDate | undefined>(undefined);
  const rangeStart = start ?? defaultRange.start;
  const rangeEnd = end ?? defaultRange.end;

  const [lookbackWeeks, setLookbackWeeks] = useState<(typeof LOOKBACK_OPTIONS)[number]>(8);
  const [seasonal, setSeasonal] = useState(true);
  const [proposeOpen, setProposeOpen] = useState(false);

  const shiftTypesQuery = useShiftTypes(unitId);
  const tiersQuery = useAcuityTiers(unitId);
  const censusQuery = useCensus(unitId, rangeStart, rangeEnd);
  const demandQuery = useDemand(unitId, rangeStart, rangeEnd);
  const backtestQuery = useBacktest(unitId, { lookbackWeeks, seasonal });

  const upsertCensus = useUpsertCensus(unitId, rangeStart, rangeEnd);
  const upsertMany = useUpsertManyCensus(unitId, rangeStart, rangeEnd);
  const recordActual = useRecordActualCensus(unitId, rangeStart, rangeEnd);
  const proposeMutation = useProposeCensus(unitId);

  const byId = shiftTypesById(shiftTypesQuery.data);
  const dates = useMemo(() => datesInRange(rangeStart, rangeEnd), [rangeStart, rangeEnd]);
  const todayIso = useMemo(() => today(), []);

  const loading =
    shiftTypesQuery.isPending ||
    tiersQuery.isPending ||
    censusQuery.isPending ||
    demandQuery.isPending;
  const erroredQuery = [shiftTypesQuery, tiersQuery, censusQuery, demandQuery].find(
    (q) => q.isError,
  );

  return (
    <div data-testid="demand-page">
      <PageHeader
        title="Demand"
        description="Census forecasts, the staffing demand they imply, and how well the forecast holds up"
        actions={
          <button
            type="button"
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white
              disabled:opacity-50"
            disabled={proposeMutation.isPending}
            onClick={() => {
              proposeMutation.mutate(
                { start: rangeStart, end: rangeEnd, options: { lookbackWeeks, seasonal } },
                { onSuccess: () => setProposeOpen(true) },
              );
            }}
          >
            {proposeMutation.isPending ? 'Proposing…' : 'Propose from history'}
          </button>
        }
      />

      <div className="mb-6 flex flex-wrap items-end gap-4 rounded-md border border-border bg-surface p-4">
        <div>
          <label htmlFor="demand-start" className="block text-xs font-medium text-text-muted">
            Start date
          </label>
          <input
            id="demand-start"
            type="date"
            value={rangeStart}
            onChange={(e) => setStart(isoDate(e.target.value))}
            className="mt-1 rounded border border-border bg-bg px-2 py-1 text-sm text-text"
          />
        </div>
        <div>
          <label htmlFor="demand-end" className="block text-xs font-medium text-text-muted">
            End date
          </label>
          <input
            id="demand-end"
            type="date"
            value={rangeEnd}
            onChange={(e) => setEnd(isoDate(e.target.value))}
            className="mt-1 rounded border border-border bg-bg px-2 py-1 text-sm text-text"
          />
        </div>
        <div>
          <label htmlFor="lookback-weeks" className="block text-xs font-medium text-text-muted">
            Lookback weeks
          </label>
          <select
            id="lookback-weeks"
            value={lookbackWeeks}
            onChange={(e) =>
              setLookbackWeeks(Number(e.target.value) as (typeof LOOKBACK_OPTIONS)[number])
            }
            className="mt-1 rounded border border-border bg-bg px-2 py-1 text-sm text-text"
          >
            {LOOKBACK_OPTIONS.map((weeks) => (
              <option key={weeks} value={weeks}>
                {weeks}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 pb-1.5 text-sm text-text">
          <input
            type="checkbox"
            checked={seasonal}
            onChange={(e) => setSeasonal(e.target.checked)}
          />
          Apply seasonal adjustment
        </label>
      </div>

      {loading ? (
        <AsyncState status="loading" label="Loading demand data" />
      ) : erroredQuery !== undefined ? (
        <AsyncState status="error" label="Could not load demand data" error={erroredQuery.error} />
      ) : (
        <>
          <section className="mb-8">
            <h2 className="mb-2 text-sm font-semibold text-text">Census</h2>
            <CensusGrid
              unitId={unitId}
              dates={dates}
              shiftTypes={shiftTypesQuery.data ?? []}
              census={censusQuery.data ?? []}
              tiers={tiersQuery.data ?? []}
              todayIso={todayIso}
              saving={upsertCensus.isPending || recordActual.isPending}
              onSaveForecast={(date, shiftTypeId, projectedCensus, acuityMix) => {
                upsertCensus.mutate({
                  unitId,
                  date,
                  shiftTypeId,
                  projectedCensus,
                  acuityMix,
                  source: 'manual',
                });
              }}
              onSaveActual={(existing, actualCensus, actualAcuityMix) => {
                recordActual.mutate({ id: existing.id, actualCensus, actualAcuityMix });
              }}
            />
          </section>

          <section className="mb-8">
            <h2 className="mb-2 text-sm font-semibold text-text">Derived staffing demand</h2>
            <DemandTable demand={demandQuery.data ?? []} shiftTypesById={byId} />
          </section>

          <section>
            <h2 className="mb-2 text-sm font-semibold text-text">Forecast back-test</h2>
            {backtestQuery.isPending ? (
              <AsyncState status="loading" label="Loading back-test" />
            ) : backtestQuery.isError ? (
              <AsyncState
                status="error"
                label="Could not load back-test"
                error={backtestQuery.error}
              />
            ) : (
              <BacktestPanel result={backtestQuery.data} shiftTypesById={byId} />
            )}
          </section>
        </>
      )}

      <ProposeDialog
        open={proposeOpen}
        onOpenChange={setProposeOpen}
        proposals={proposeMutation.data ?? []}
        existing={censusQuery.data ?? []}
        shiftTypesById={byId}
        tierNames={tierNameLookup(tiersQuery.data)}
        accepting={upsertMany.isPending}
        onAccept={(accepted) => {
          upsertMany.mutate(
            accepted.map((p) => ({
              unitId,
              date: p.date,
              shiftTypeId: p.shiftTypeId,
              projectedCensus: p.projectedCensus,
              acuityMix: p.acuityMix,
              source: 'forecast' as const,
            })),
            { onSuccess: () => setProposeOpen(false) },
          );
        }}
      />
    </div>
  );
}
