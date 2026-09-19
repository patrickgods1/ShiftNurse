/**
 * Fairness: how evenly a period's draft spreads the shifts nobody wants, per nurse and for the
 * unit as a whole. The report is recomputed in main for whichever period is selected; the
 * trend and history are per unit and survive a period change, so a manager can import a year
 * of spreadsheets here and immediately see the draft re-scored against it.
 */

import type { Id } from '@shiftnurse/core';
import { useEffect, useMemo, useState } from 'react';
import { useNurses, usePeriods } from '../api.js';
import { useFairnessReport, useFairnessTrend } from '../api-fairness.js';
import { AsyncState } from '../components/async-state.js';
import { PageHeader } from '../components/page-header.js';
import { defaultPeriod } from '../default-period.js';
import { formatDate } from '../format.js';
import { useUnitId } from '../unit-context.js';
import { ImportHistoryDialog } from './fairness/import-dialog.js';
import { NurseFairnessTable } from './fairness/nurse-table.js';
import { ComponentDistributionStrip, FairnessSummary } from './fairness/summary.js';
import { TrendPanel } from './fairness/trend-panel.js';

export default function FairnessPage() {
  const unitId = useUnitId();
  const periodsQuery = usePeriods(unitId);
  const nursesQuery = useNurses(unitId);
  const trendQuery = useFairnessTrend(unitId);
  const periods = periodsQuery.data ?? [];
  const [selectedId, setSelectedId] = useState<Id | undefined>(undefined);
  const [importOpen, setImportOpen] = useState(false);

  const fallback = useMemo(() => defaultPeriod(periods), [periods]);
  useEffect(() => {
    if (selectedId === undefined && fallback !== undefined) setSelectedId(fallback.id);
  }, [selectedId, fallback]);
  const selected = periods.find((p) => p.id === selectedId) ?? fallback;

  const reportQuery = useFairnessReport(selected?.id);
  const trend = trendQuery.data ?? [];

  return (
    <div>
      <PageHeader
        title="Fairness"
        description="Who is carrying more than their share, and by how much"
        actions={
          <button
            type="button"
            data-testid="import-history"
            onClick={() => setImportOpen(true)}
            className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text hover:bg-bg"
          >
            Import history…
          </button>
        }
      />

      {periodsQuery.isPending ? (
        <AsyncState status="loading" label="Loading periods…" />
      ) : periodsQuery.isError ? (
        <AsyncState status="error" label="Could not load periods" error={periodsQuery.error} />
      ) : periods.length === 0 ? (
        <AsyncState
          status="empty"
          label="No scheduling periods yet. Create one on the Schedule page to score it."
        />
      ) : (
        <>
          <div className="mb-4 flex items-center gap-3">
            <label className="text-sm text-text-muted" htmlFor="fairness-period-select">
              Period
            </label>
            <select
              id="fairness-period-select"
              value={selected?.id ?? ''}
              onChange={(e) => setSelectedId(e.target.value)}
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text"
            >
              {periods.map((period) => (
                <option key={period.id} value={period.id}>
                  {period.name} · {formatDate(period.startDate)} – {formatDate(period.endDate)}
                </option>
              ))}
            </select>
          </div>

          {reportQuery.isPending ? (
            <AsyncState status="loading" label="Scoring the period…" />
          ) : reportQuery.isError ? (
            <AsyncState
              status="error"
              label="Could not score the period"
              error={reportQuery.error}
            />
          ) : (
            <div className="flex flex-col gap-6">
              <FairnessSummary report={reportQuery.data} />
              <ComponentDistributionStrip report={reportQuery.data} />
              <NurseFairnessTable
                scores={reportQuery.data.scores}
                nurses={nursesQuery.data ?? []}
                trend={trend}
              />
            </div>
          )}
        </>
      )}

      <section className="mt-6" aria-labelledby="fairness-trend-heading">
        <h2 id="fairness-trend-heading" className="mb-2 text-sm font-semibold text-text">
          Trend
        </h2>
        {trendQuery.isPending ? (
          <AsyncState status="loading" label="Loading history…" />
        ) : trendQuery.isError ? (
          <AsyncState status="error" label="Could not load history" error={trendQuery.error} />
        ) : (
          <TrendPanel points={trend} />
        )}
      </section>

      <ImportHistoryDialog open={importOpen} onOpenChange={setImportOpen} unitId={unitId} />
    </div>
  );
}
