/**
 * The published schedule's history: every version that went out and every reasoned edit since.
 * This is the page a manager opens when a nurse asks "why did my Saturday move?" — the answer
 * is the reason typed at the time, quoted verbatim, next to what the shift was and what it
 * became.
 */

import type { Nurse, ScheduleChange, ShiftType } from '@shiftnurse/core';
import { useMemo } from 'react';
import { useNurses, useShiftTypes } from '../../api.js';
import { useChanges, useVersions } from '../../api-publish.js';
import { AsyncState } from '../../components/async-state.js';
import { formatDate } from '../../format.js';
import { useUnitId } from '../../unit-context.js';

const KIND_LABEL: Record<ScheduleChange['kind'], string> = {
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
};

const SOURCE_LABEL: Record<ScheduleChange['source'], string> = {
  manual: 'grid edit',
  exchange: 'shift exchange',
  time_off: 'time off',
  resolution: 'conflict resolution',
  backfill: 'call-off backfill',
};

function describe(change: ScheduleChange, shiftTypes: ReadonlyMap<string, ShiftType>): string {
  const label = shiftTypes.get(change.shiftTypeId)?.abbreviation ?? change.shiftTypeId;
  if (change.kind !== 'changed') return `${label} on ${formatDate(change.date)}`;
  const flags = (a: ScheduleChange['after']) =>
    [a?.isCharge ? 'charge' : '', a?.isOvertime ? 'OT' : ''].filter(Boolean).join(', ') || 'plain';
  return `${label} on ${formatDate(change.date)}: ${flags(change.before)} → ${flags(change.after)}`;
}

export function ChangeLog({ periodId }: { periodId: string }) {
  const unitId = useUnitId();
  const versionsQuery = useVersions(periodId);
  const changesQuery = useChanges(periodId);
  const nursesQuery = useNurses(unitId);
  const shiftTypesQuery = useShiftTypes(unitId);

  const nurses = useMemo(
    () => new Map<string, Nurse>((nursesQuery.data ?? []).map((n) => [n.id, n])),
    [nursesQuery.data],
  );
  const shiftTypes = useMemo(
    () => new Map<string, ShiftType>((shiftTypesQuery.data ?? []).map((s) => [s.id, s])),
    [shiftTypesQuery.data],
  );

  if (versionsQuery.isPending || changesQuery.isPending) {
    return <AsyncState status="loading" label="Loading change log" />;
  }
  if (versionsQuery.isError || changesQuery.isError) {
    return (
      <AsyncState
        status="error"
        label="Could not load change log"
        error={versionsQuery.error ?? changesQuery.error}
      />
    );
  }
  const versions = [...versionsQuery.data].reverse();
  const changes = changesQuery.data;

  return (
    <section
      data-testid="change-log"
      className="mb-3 grid gap-3 rounded-md border border-border bg-surface p-3 text-sm md:grid-cols-[16rem_1fr]"
    >
      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
          Versions
        </h3>
        <ul className="flex flex-col gap-1">
          {versions.map((v) => (
            <li key={v.id} className="text-xs">
              <span className="font-medium text-text">v{v.version}</span>{' '}
              <span className="text-text-muted">{new Date(v.publishedAt).toLocaleString()}</span>
              <br />
              <span className="text-text-muted">
                {v.version === 1 ? `${v.added} shifts` : `+${v.added} −${v.removed} ~${v.changed}`}
                {v.reason ? ` — ${v.reason}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
          Changes since publishing ({changes.length})
        </h3>
        {changes.length === 0 ? (
          <p className="text-xs text-text-muted">No edits since this schedule was published.</p>
        ) : (
          <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
            {changes.map((c) => {
              const nurse = nurses.get(c.nurseId);
              const name = nurse ? `${nurse.firstName} ${nurse.lastName}` : c.nurseId;
              return (
                <li key={c.id} className="text-xs" data-testid="change-log-entry">
                  <span className="font-medium text-text">
                    {KIND_LABEL[c.kind]} — {name}
                  </span>{' '}
                  <span className="text-text-muted">{describe(c, shiftTypes)}</span>
                  <br />
                  <span className="text-text">“{c.reason}”</span>{' '}
                  <span className="text-text-muted">
                    · {SOURCE_LABEL[c.source]} · v{c.version} · {new Date(c.at).toLocaleString()}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
