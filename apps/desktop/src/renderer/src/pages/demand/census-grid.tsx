/**
 * Rows = dates in the selected range, columns = active non-on-call shift types. Each cell owns
 * its own save (see CensusCell) so entering a week of numbers doesn't require one big form
 * submit — a manager fills what they know and leaves the rest "—".
 */

import type { AcuityTier, CensusForecast, Id, IsoDate, ShiftType } from '@shiftnurse/core';
import { formatDateWithWeekday } from '../../format.js';
import { CensusCell } from './census-cell.js';

interface CensusGridProps {
  unitId: Id;
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
  unitId,
  dates,
  shiftTypes,
  census,
  tiers,
  todayIso,
  onSaveForecast,
  onSaveActual,
  saving,
}: CensusGridProps) {
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
            <th className="px-3 py-2 font-medium">Date</th>
            {activeShiftTypes.map((s) => (
              <th key={s.id} className="px-3 py-2 font-medium">
                {s.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dates.map((date) => (
            <tr key={date} className="border-b border-border last:border-0">
              <td className="px-3 py-2 text-text">{formatDateWithWeekday(date)}</td>
              {activeShiftTypes.map((shiftType) => {
                const existing = census.find(
                  (c) => c.date === date && c.shiftTypeId === shiftType.id,
                );
                return (
                  <td key={shiftType.id} className="p-1 text-center">
                    <CensusCell
                      date={date}
                      shiftTypeId={shiftType.id}
                      unitId={unitId}
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
