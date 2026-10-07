/**
 * Who should get a holiday off when several nurses ask for it.
 *
 * Contracts such as the VA–NNU Master Agreement (Art. 10) settle a contested holiday in order:
 * peers agree among themselves, then whoever did not have the holiday off last year, then
 * seniority. Peer agreement is the manager's to record by deciding; the other two steps are
 * mechanical, and left to memory they are where a grievance starts ("she got Christmas two years
 * running"). This module only orders the pending requests: it approves and denies nothing, and
 * the solver and the holiday-rotation rule do not read it.
 *
 * "Last year's occurrence" is `previousOccurrence` (same name, 300–430 days earlier), the same
 * definition the rotation rule uses. When the unit has no such holiday there is no history to
 * judge by, so the nurse is not ranked behind anyone for it (`workedLastYear: null`).
 *
 * A shift is dated by its start day, so a request covers a holiday exactly when the holiday's
 * date falls in its inclusive range.
 *
 * A nurse on the Baylor weekend plan (38 U.S.C. § 7456) has no holiday entitlement under VA Handbook
 * 5011, so their request ranks behind every other claimant's, whatever their record or seniority —
 * and says so, since the reason is what the manager quotes when denying it.
 */

import { isBaylorPlan } from '../cost/cost.js';
import type { Holiday, Id, Nurse, TimeOffRequest } from '../domain/entities.js';
import { compareDates, dateInRange, type IsoDate } from '../domain/time.js';
import { previousOccurrence } from '../rules/holiday-rotation.js';
import type { HolidayWorkRecord } from '../rules/types.js';

export interface HolidayPriorityInput {
  /** Pending requests to rank; approved ones are passed separately as already holding the day. */
  pending: readonly TimeOffRequest[];
  approved: readonly TimeOffRequest[];
  nurses: readonly Nurse[];
  /** The unit's holidays, including last year's, so the previous occurrence can be found. */
  holidays: readonly Holiday[];
  /** Who worked each past holiday (`HolidayWorkRecord`, rules/types.ts). */
  holidayWork: readonly HolidayWorkRecord[];
}

export interface HolidayClaimant {
  requestId: Id;
  nurseId: Id;
  /** 1 = first in line. */
  rank: number;
  /** Null when the unit has no previous occurrence of the holiday. */
  workedLastYear: boolean | null;
  reason: string;
}

export interface HolidayClaim {
  holidayId: Id;
  date: IsoDate;
  name: string;
  claimants: HolidayClaimant[];
  /** Nurse ids with approved leave on the date. */
  alreadyOff: Id[];
}

export function holidayRequestPriority(input: HolidayPriorityInput): HolidayClaim[] {
  const nursesById = new Map(input.nurses.map((n) => [n.id, n]));
  const workedBy = new Map<Id, Set<Id>>();
  for (const record of input.holidayWork) {
    const set = workedBy.get(record.holidayId) ?? new Set<Id>();
    set.add(record.nurseId);
    workedBy.set(record.holidayId, set);
  }

  const holidays = [...input.holidays].sort((a, b) => compareDates(a.date, b.date));
  const claims: HolidayClaim[] = [];
  for (const holiday of holidays) {
    // Every holiday a pending request covers gets a claim, past ones included: a pending request
    // is about future dates in practice, and filtering by today here would make the answer depend
    // on the host clock instead of on the data passed in.
    const asking = input.pending.filter((r) => dateInRange(holiday.date, r.startDate, r.endDate));
    if (asking.length === 0) continue;

    const previous = previousOccurrence(holiday, input.holidays);
    const entries = asking.map((request) => {
      const nurse = nursesById.get(request.nurseId);
      // Bad data throws loudly: a request from an unknown nurse is corruption, not a skip.
      if (!nurse)
        throw new Error(`Time-off request ${request.id} names unknown nurse ${request.nurseId}`);
      const worked =
        previous === undefined ? null : (workedBy.get(previous.id)?.has(nurse.id) ?? false);
      return { request, nurse, worked };
    });
    entries.sort((a, b) => {
      const byPlan = Number(isBaylorPlan(a.nurse)) - Number(isBaylorPlan(b.nurse));
      if (byPlan !== 0) return byPlan;
      const byWorked = Number(b.worked === true) - Number(a.worked === true);
      if (byWorked !== 0) return byWorked;
      const bySeniority = compareDates(a.nurse.seniorityDate, b.nurse.seniorityDate);
      if (bySeniority !== 0) return bySeniority;
      return a.nurse.employeeId < b.nurse.employeeId
        ? -1
        : a.nurse.employeeId > b.nurse.employeeId
          ? 1
          : 0;
    });

    const alreadyOff = [
      ...new Set(
        input.approved
          .filter((r) => dateInRange(holiday.date, r.startDate, r.endDate))
          .map((r) => r.nurseId),
      ),
    ];
    claims.push({
      holidayId: holiday.id,
      date: holiday.date,
      name: holiday.name,
      alreadyOff,
      claimants: entries.map((e, i) => ({
        requestId: e.request.id,
        nurseId: e.nurse.id,
        rank: i + 1,
        workedLastYear: e.worked,
        reason: isBaylorPlan(e.nurse)
          ? BAYLOR_REASON
          : reasonFor(holiday.name, e.worked, e.nurse.seniorityDate),
      })),
    });
  }
  return claims;
}

const BAYLOR_REASON = 'On the Baylor weekend plan (38 U.S.C. § 7456): no holiday entitlement';

function reasonFor(name: string, worked: boolean | null, seniority: IsoDate): string {
  if (worked === true) return `Worked ${name} last year; seniority ${seniority}`;
  if (worked === false) return `Had ${name} off last year; seniority ${seniority}`;
  return `No record of last year's ${name}; seniority ${seniority}`;
}
