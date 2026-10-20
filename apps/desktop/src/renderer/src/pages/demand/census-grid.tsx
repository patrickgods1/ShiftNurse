/**
 * Rows = dates in the selected range, columns = active non-on-call shift types. Each cell owns
 * its own save (see CensusCell) so entering a week of numbers doesn't require one big form
 * submit — a manager fills what they know and leaves the rest "—".
 */

import type { AcuityTier, CensusForecast, Id, IsoDate, ShiftType } from '@shiftnurse/core';
import { useMemo } from 'react';
import { formatDateWithWeekday } from '../../format.js';
import { CensusCell } from './census-cell.js';

interface CensusGridProps {
  dates: IsoDate[];
  shiftTypes: ShiftType[];
  census: CensusForecast[];
  tiers: AcuityTier[];
  todayIso: IsoDate;
  onSaveForecast: (date: IsoDate, shiftTypeId: Id, census: number, mix: Record<Id, number>) => void;
  onSaveActual: (existing: CensusForecast, census: number, mix: Record<Id, number>) => void;
  saving: boolean;
}

export function CensusGrid({
  dates,
  shiftTypes,
  census,
  tiers,
  todayIso,
  onSaveForecast,
  onSaveActual,
  saving,
}: CensusGridProps) {
  // One pass over the census instead of a scan per cell (rows x shift types x census rows).
  const censusByCell = useMemo(
    () => new Map(census.map((c) => [`${c.date}::${c.shiftTypeId}`, c])),
    [census],
  );
  const activeShiftTypes = shiftTypes.filter((s) => s.active && !s.isOnCall);

  if (activeShiftTypes.length === 0) {
    return (
      <p className="text-sm text-text-muted">No active shift types configured for this unit yet.</p>
    );
  }

  return (
    <div
      data-testid="census-grid"
      className="overflow-x-auto rounded-md border border-border bg-surface"
    >
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-text-muted">
            <th scope="col" className="px-3 py-2 font-medium">
              Date
            </th>
            {activeShiftTypes.map((s) => (
              <th key={s.id} scope="col" className="px-3 py-2 font-medium">
                {s.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dates.map((date) => (
            <tr key={date} className="border-b border-border last:border-0">
              <th scope="row" className="px-3 py-2 text-left font-normal text-text">
                {formatDateWithWeekday(date)}
              </th>
              {activeShiftTypes.map((shiftType) => {
                const existing = censusByCell.get(`${date}::${shiftType.id}`);
                return (
                  <td key={shiftType.id} className="p-1 text-center">
                    <CensusCell
                      date={date}
                      shiftTypeId={shiftType.id}
                      existing={existing}
                      tiers={tiers}
                      isPast={date < todayIso}
                      saving={saving}
                      onSaveForecast={(c, mix) => onSaveForecast(date, shiftType.id, c, mix)}
                      onSaveActual={(c, mix) => {
                        if (existing !== undefined) onSaveActual(existing, c, mix);
                      }}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
