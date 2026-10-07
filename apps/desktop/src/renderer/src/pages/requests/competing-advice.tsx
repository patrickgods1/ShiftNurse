/**
 * The equity order for requests that compete for the same day, shown as advice. The core
 * conflict carries it (`Conflict.advisedOrder`); this file only words it, so the Requests list
 * and the decide dialog quote the same reason text. Nothing here approves or denies anything.
 */

import type { Conflict, Id, Nurse } from '@shiftnurse/core';
import { formatDateWithWeekday } from '../../format.js';

export function nurseLabel(nursesById: ReadonlyMap<Id, Nurse>, id: Id): string {
  const n = nursesById.get(id);
  return n ? `${n.firstName} ${n.lastName}` : id;
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

/** A pending request's notes: one per competing conflict that names it, keyed by request id. */
export function competingNotes(conflicts: readonly Conflict[]): Map<Id, string[]> {
  const notes = new Map<Id, string[]>();
  for (const c of conflicts) {
    if (c.kind !== 'competing_time_off' || !c.advisedOrder) continue;
    const date = c.dates[0];
    for (const claimant of c.advisedOrder) {
      const list = notes.get(claimant.requestId) ?? [];
      list.push(
        `Competes for ${date ? formatDateWithWeekday(date) : 'these days'}: ` +
          `${ordinal(claimant.rank)} of ${c.advisedOrder.length} in line — ${claimant.reason}`,
      );
      notes.set(claimant.requestId, list);
    }
  }
  return notes;
}

export function CompetingAdvice({
  conflicts,
  requestId,
  nursesById,
}: {
  conflicts: readonly Conflict[];
  requestId: Id;
  nursesById: ReadonlyMap<Id, Nurse>;
}) {
  const mine = conflicts.filter(
    (c) => c.kind === 'competing_time_off' && c.advisedOrder && c.timeOffIds.includes(requestId),
  );
  if (mine.length === 0) return null;
  return (
    <div data-testid="decide-competing-advice" className="rounded-md border border-border p-3">
      <p className="text-xs font-medium text-text-muted">Who should get it first</p>
      {mine.map((c) => (
        <div key={c.id} className="mt-1">
          {c.dates[0] ? (
            <p className="text-xs text-text-muted">{formatDateWithWeekday(c.dates[0])}</p>
          ) : null}
          <ol className="list-decimal pl-5">
            {c.advisedOrder?.map((a) => (
              <li key={a.requestId}>
                {nurseLabel(nursesById, a.nurseId)} — {a.reason}
                {a.requestId === requestId ? ' (this request)' : ''}
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}
