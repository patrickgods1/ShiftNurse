/**
 * Schedule grid entry point: pick a scheduling period (defaulting to the current draft), create
 * a new one, and render the nurse x day grid for it. A published period renders read-only —
 * `ScheduleBoard` disables drag and edits once `period.status !== 'draft'`, since dragging a
 * shift around after publish would be silently invisible to whatever already went out to staff.
 */

import type { Id, SchedulePeriod } from '@shiftnurse/core';
import { useEffect, useMemo, useState } from 'react';
import { usePeriods } from '../api.js';
import { AsyncState } from '../components/async-state.js';
import { PageHeader } from '../components/page-header.js';
import { PeriodOptions } from '../components/period-options.js';
import { PRIMARY } from '../components/ui.js';
import { defaultPeriod } from '../default-period.js';
import { useUnitId } from '../unit-context.js';
import { ScheduleBoard } from './schedule/board.js';
import { NewPeriodDialog } from './schedule/new-period-dialog.js';

const STATUS_BADGE: Record<SchedulePeriod['status'], string> = {
  draft: 'bg-text-muted/15 text-text-muted',
  published: 'bg-success/15 text-success',
  archived: 'bg-border text-text-muted',
};

export default function SchedulePage({ focusNurseId }: { focusNurseId?: Id | undefined } = {}) {
  const unitId = useUnitId();
  const periodsQuery = usePeriods(unitId);
  const periods = periodsQuery.data ?? [];
  const [selectedId, setSelectedId] = useState<Id | undefined>(undefined);
  const [newPeriodOpen, setNewPeriodOpen] = useState(false);

  const fallback = useMemo(() => defaultPeriod(periods), [periods]);

  useEffect(() => {
    if (selectedId === undefined && fallback !== undefined) setSelectedId(fallback.id);
  }, [selectedId, fallback]);

  const selected = periods.find((p) => p.id === selectedId) ?? fallback;

  // Handed to the board so the picker, palette and actions share one row.
  const periodPicker = (
    <div className="flex items-center gap-3">
      <label className="text-sm text-text-muted" htmlFor="period-select">
        Period
      </label>
      <select
        id="period-select"
        data-testid="period-select"
        value={selected?.id ?? ''}
        onChange={(e) => setSelectedId(e.target.value)}
        className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text"
      >
        <PeriodOptions periods={periods} />
      </select>
      {selected !== undefined ? (
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
            STATUS_BADGE[selected.status]
          }`}
        >
          {selected.status}
        </span>
      ) : null}
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Schedule"
        description="Build and review the shift schedule for a period"
        actions={
          <button
            type="button"
            data-testid="new-period"
            onClick={() => setNewPeriodOpen(true)}
            className={PRIMARY}
          >
            New period
          </button>
        }
      />

      {periodsQuery.isPending ? (
        <AsyncState status="loading" label="Loading periods" />
      ) : periodsQuery.isError ? (
        <AsyncState status="error" label="Could not load periods" error={periodsQuery.error} />
      ) : periods.length === 0 ? (
        <AsyncState status="empty" label="No scheduling periods yet. Create one to start." />
      ) : selected !== undefined ? (
        <ScheduleBoard
          key={selected.id}
          leading={periodPicker}
          unitId={unitId}
          period={selected}
          focusNurseId={focusNurseId}
        />
      ) : null}

      <NewPeriodDialog
        open={newPeriodOpen}
        onOpenChange={setNewPeriodOpen}
        unitId={unitId}
        onCreated={(period) => setSelectedId(period.id)}
      />
    </div>
  );
}
