/**
 * Renders derived staffing demand (date × shift, one column per role) with the binding
 * constraint named next to each minimum — "why does it say 4?" should never require opening
 * the coverage/ratio settings pages to answer.
 */

import type { BindingConstraint, ShiftDemand, ShiftType } from '@shiftnurse/core';
import { NURSE_ROLES } from '@shiftnurse/core';
import { formatDateWithWeekday } from '../../format.js';

const CONSTRAINT_LABEL: Record<BindingConstraint, string> = {
  coverage_floor: 'floor',
  ratio: 'ratio',
  both: 'both',
};

interface DemandTableProps {
  demand: ShiftDemand[];
  shiftTypesById: Map<string, ShiftType>;
}

export function DemandTable({ demand, shiftTypesById }: DemandTableProps) {
  const activeRoles = NURSE_ROLES.filter((role) =>
    demand.some((d) => (d.byRole[role]?.minCount ?? 0) > 0),
  );

  const sorted = [...demand].sort((a, b) =>
    a.date === b.date
      ? (shiftTypesById.get(a.shiftTypeId)?.sortOrder ?? 0) -
        (shiftTypesById.get(b.shiftTypeId)?.sortOrder ?? 0)
      : a.date < b.date
        ? -1
        : 1,
  );

  if (sorted.length === 0) {
    return <p className="text-sm text-text-muted">No shifts in this range.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-md border border-border bg-surface">
      <table data-testid="demand-table" className="w-full min-w-[640px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-text-muted">
            <th className="px-3 py-2 font-medium">Date</th>
            <th className="px-3 py-2 font-medium">Shift</th>
            {activeRoles.length === 0 ? (
              <th className="px-3 py-2 font-medium">Minimum</th>
            ) : (
              activeRoles.map((role) => (
                <th key={role} className="px-3 py-2 font-medium">
                  {role}
                </th>
              ))
            )}
            <th className="px-3 py-2 font-medium">HPPD nurses</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((d) => {
            const shiftType = shiftTypesById.get(d.shiftTypeId);
            return (
              <tr
                key={`${d.date}::${d.shiftTypeId}`}
                className="border-b border-border last:border-0"
              >
                <td className="px-3 py-2 text-text">{formatDateWithWeekday(d.date)}</td>
                <td className="px-3 py-2 text-text">
                  {shiftType?.name ?? d.shiftTypeId}
                  {d.fromCoverageFloorOnly ? (
                    <span className="ml-1.5 text-xs text-text-muted">no forecast</span>
                  ) : null}
                </td>
                {activeRoles.length === 0 ? (
                  <td className="px-3 py-2 text-text-muted">0</td>
                ) : (
                  activeRoles.map((role) => {
                    const roleDemand = d.byRole[role];
                    if (roleDemand === undefined || roleDemand.minCount === 0) {
                      return (
                        <td key={role} className="px-3 py-2 text-text-muted">
                          —
                        </td>
                      );
                    }
                    return (
                      <td
                        key={role}
                        className="px-3 py-2 text-text"
                        title={`Coverage floor min ${roleDemand.coverageFloorMin}, ratio-derived ${roleDemand.ratioDerived}`}
                      >
                        {roleDemand.minCount}{' '}
                        <span className="rounded bg-bg px-1.5 py-0.5 text-xs text-text-muted">
                          {CONSTRAINT_LABEL[roleDemand.bindingConstraint]}
                        </span>
                      </td>
                    );
                  })
                )}
                <td className="px-3 py-2 text-text-muted">{d.hppdRecommendedNurses.toFixed(1)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
