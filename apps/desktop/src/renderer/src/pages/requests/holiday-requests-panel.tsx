/**
 * Requests › Holiday requests: the pending requests that cover a holiday, in the order the
 * contract gives. It is advice: nothing here approves or denies, because peers agreeing among
 * themselves comes first and the manager records that by deciding.
 */

import type { HolidayClaim, Id, Nurse } from '@shiftnurse/core';
import { useHolidayPriority } from '../../api-requests.js';
import { AsyncState } from '../../components/async-state.js';
import { LabelWithTip } from '../../components/field-help.js';
import { formatDate } from '../../format.js';

const PRIORITY_TIP =
  'The order the contract gives: whoever worked this holiday last year, then seniority. Peers ' +
  'agreeing among themselves comes first; record that by deciding.';

/** "Holiday priority 2 of 3" for each holiday a request covers, keyed by request id. */
export function holidayNotes(claims: readonly HolidayClaim[]): Map<Id, string[]> {
  const notes = new Map<Id, string[]>();
  for (const claim of claims) {
    for (const c of claim.claimants) {
      const list = notes.get(c.requestId) ?? [];
      list.push(
        claim.claimants.length > 1
          ? `Holiday priority ${c.rank} of ${claim.claimants.length} for ${claim.name}`
          : `Only request for ${claim.name}`,
      );
      notes.set(c.requestId, list);
    }
  }
  return notes;
}

interface Props {
  unitId: Id;
  nursesById: ReadonlyMap<Id, Nurse>;
}

export function HolidayRequestsPanel({ unitId, nursesById }: Props) {
  const claims = useHolidayPriority(unitId);
  const name = (id: Id) => {
    const n = nursesById.get(id);
    return n ? `${n.firstName} ${n.lastName}` : id;
  };

  return (
    <section
      aria-labelledby="holiday-requests-heading"
      data-testid="holiday-requests-panel"
      className="mt-8"
    >
      <h2 id="holiday-requests-heading" className="text-sm font-semibold text-text">
        <LabelWithTip label="Holiday requests" tip={PRIORITY_TIP} />
      </h2>
      <p className="mb-3 text-sm text-text-muted">
        Pending requests that cover a holiday, in the contract’s order. Deciding them is still
        yours.
      </p>
      {claims.isPending ? (
        <AsyncState status="loading" label="Loading holiday requests" />
      ) : claims.isError ? (
        <AsyncState status="error" label="Could not load holiday requests" error={claims.error} />
      ) : claims.data.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-sm text-text-muted">
          No pending request covers a holiday.
        </p>
      ) : (
        <ul className="space-y-3">
          {claims.data.map((claim) => (
            <li
              key={claim.holidayId}
              className="rounded-md border border-border bg-surface p-4"
              data-testid="holiday-claim"
            >
              <h3 className="text-sm font-medium text-text">
                {claim.name} · {formatDate(claim.date)}
              </h3>
              <ol className="mt-2 space-y-1 text-sm">
                {claim.claimants.map((c) => (
                  <li key={c.requestId}>
                    <span className="font-medium">
                      {c.rank}. {name(c.nurseId)}
                    </span>{' '}
                    <span className="text-text-muted">{c.reason}</span>
                  </li>
                ))}
              </ol>
              {claim.alreadyOff.length > 0 ? (
                <p className="mt-2 text-xs text-text-muted">
                  Already off: {claim.alreadyOff.map(name).join(', ')}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
