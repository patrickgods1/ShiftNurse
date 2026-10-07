/**
 * Requests › Holiday requests: the pending requests that cover a holiday, in the order the
 * contract gives. It is advice: nothing here approves or denies, because peers agreeing among
 * themselves comes first and the manager records that by deciding.
 *
 * Under each holiday's requests for the day off, the nurses who want to work it (their
 * preferences), most senior first: when more volunteer than the day needs, seniority decides
 * who works it (VA–NNU Art. 10 § 4.D.6). A holiday with volunteers and no requests is listed too.
 */

import {
  compareDates,
  type HolidayClaim,
  type HolidayWorkClaim,
  type Id,
  type IsoDate,
  type Nurse,
} from '@shiftnurse/core';
import { useHolidays } from '../../api-config.js';
import { useHolidayPriority, useHolidayWorkPriority } from '../../api-requests.js';
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

interface HolidayEntry {
  holidayId: Id;
  name: string;
  date: IsoDate;
  claim: HolidayClaim | undefined;
  volunteers: HolidayWorkClaim[];
}

/** One entry per holiday with a request off or a volunteer to work it, by date. */
function holidayEntries(
  claims: readonly HolidayClaim[],
  work: readonly HolidayWorkClaim[],
  holidays: readonly { id: Id; name: string; date: IsoDate }[],
): HolidayEntry[] {
  const entries = new Map<Id, HolidayEntry>();
  for (const claim of claims) {
    entries.set(claim.holidayId, { ...claim, claim, volunteers: [] });
  }
  const holidaysById = new Map(holidays.map((h) => [h.id, h]));
  for (const w of work) {
    let entry = entries.get(w.holidayId);
    if (!entry) {
      const holiday = holidaysById.get(w.holidayId);
      // The claim came from this unit's holidays a moment ago; a miss is a holiday deleted since.
      if (!holiday) continue;
      entry = {
        holidayId: holiday.id,
        name: holiday.name,
        date: holiday.date,
        claim: undefined,
        volunteers: [],
      };
      entries.set(w.holidayId, entry);
    }
    entry.volunteers.push(w);
  }
  return [...entries.values()].sort((a, b) => compareDates(a.date, b.date));
}

export function HolidayRequestsPanel({ unitId, nursesById }: Props) {
  const claims = useHolidayPriority(unitId);
  const work = useHolidayWorkPriority(unitId);
  const holidays = useHolidays(unitId);
  const name = (id: Id) => {
    const n = nursesById.get(id);
    return n ? `${n.firstName} ${n.lastName}` : id;
  };
  const failed = claims.error ?? work.error ?? holidays.error;

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
        Pending requests that cover a holiday, in the contract’s order, and who wants to work it.
        Deciding them is still yours.
      </p>
      {failed ? (
        <AsyncState status="error" label="Could not load holiday requests" error={failed} />
      ) : claims.data && work.data && holidays.data ? (
        <HolidayList entries={holidayEntries(claims.data, work.data, holidays.data)} name={name} />
      ) : (
        <AsyncState status="loading" label="Loading holiday requests" />
      )}
    </section>
  );
}

function HolidayList({ entries, name }: { entries: HolidayEntry[]; name: (id: Id) => string }) {
  if (entries.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-4 text-sm text-text-muted">
        No pending request covers a holiday.
      </p>
    );
  }
  return (
    <ul className="space-y-3">
      {entries.map((entry) => (
        <li
          key={entry.holidayId}
          className="rounded-md border border-border bg-surface p-4"
          data-testid="holiday-claim"
        >
          <h3 className="text-sm font-medium text-text">
            {entry.name} · {formatDate(entry.date)}
          </h3>
          {entry.claim ? (
            <>
              <ol className="mt-2 space-y-1 text-sm" aria-label="Wants it off">
                {entry.claim.claimants.map((c) => (
                  <li key={c.requestId}>
                    <span className="font-medium">
                      {c.rank}. {name(c.nurseId)}
                    </span>{' '}
                    <span className="text-text-muted">{c.reason}</span>
                  </li>
                ))}
              </ol>
              {entry.claim.alreadyOff.length > 0 ? (
                <p className="mt-2 text-xs text-text-muted">
                  Already off: {entry.claim.alreadyOff.map(name).join(', ')}
                </p>
              ) : null}
            </>
          ) : null}
          {entry.volunteers.length > 0 ? (
            <>
              <h4 className="mt-3 text-xs font-medium text-text">Wants to work it</h4>
              <ol className="mt-1 space-y-1 text-sm" aria-label="Wants to work it">
                {entry.volunteers.map((v) => (
                  <li key={v.nurseId}>
                    <span className="font-medium">
                      {v.rank}. {name(v.nurseId)}
                    </span>{' '}
                    <span className="text-text-muted">{v.reason}</span>
                    {v.beyondNeed ? (
                      <span className="text-text-muted"> · more than the day needs</span>
                    ) : null}
                  </li>
                ))}
              </ol>
            </>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
