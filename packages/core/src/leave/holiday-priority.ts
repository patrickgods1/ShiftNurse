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
 *
 * The other side of the day is who wants to WORK it (`holiday_appetite` preferences). When more
 * nurses volunteer than the floor needs, seniority alone decides (VA–NNU 2023 Master Agreement
 * Art. 10 § 4.D.6); without a written order the surplus volunteer is picked from memory.
 * `holidayWorkPriority` gives that order. A Baylor-plan nurse has no holiday entitlement, so
 * their volunteering earns no claim. The solver reads the same preference as a reward scaled by
 * seniority, so its pick agrees with this advice when it can.
 */

import { isBaylorPlan } from '../cost/cost.js';
import type { Holiday, Id, Nurse, Preference, TimeOffRequest } from '../domain/entities.js';
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
      return bySeniority(a.nurse, b.nurse);
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

export interface HolidayWorkInput {
  holidays: readonly Holiday[];
  nurses: readonly Nurse[];
  /** Every kind may be passed; only `holiday_appetite` is read. */
  preferences: readonly Preference[];
  /** RNs the holiday's date needs, by holiday id; absent means no volunteer is marked surplus. */
  needed?: ReadonlyMap<Id, number>;
}

export interface HolidayWorkClaim {
  holidayId: Id;
  nurseId: Id;
  /** 1 = first in line to work it. */
  rank: number;
  reason: string;
  /** Ranked past the number the date needs: the volunteer seniority leaves out. */
  beyondNeed: boolean;
}

/** Volunteers per holiday in seniority order, holidays by date. */
export function holidayWorkPriority(input: HolidayWorkInput): HolidayWorkClaim[] {
  const nursesById = new Map(input.nurses.map((n) => [n.id, n]));
  const volunteers = new Map<Id, Nurse[]>();
  for (const pref of input.preferences) {
    if (pref.kind !== 'holiday_appetite') continue;
    const nurse = nursesById.get(pref.nurseId);
    if (!nurse) throw new Error(`Preference ${pref.id} names unknown nurse ${pref.nurseId}`);
    if (isBaylorPlan(nurse)) continue;
    const list = volunteers.get(pref.holidayId) ?? [];
    // Two rows for the same holiday are one volunteer, not two places in the queue.
    if (!list.includes(nurse)) list.push(nurse);
    volunteers.set(pref.holidayId, list);
  }

  const holidays = [...input.holidays].sort((a, b) => compareDates(a.date, b.date));
  const claims: HolidayWorkClaim[] = [];
  for (const holiday of holidays) {
    const list = volunteers.get(holiday.id);
    if (!list) continue;
    const needed = input.needed?.get(holiday.id);
    [...list].sort(bySeniority).forEach((nurse, i) => {
      claims.push({
        holidayId: holiday.id,
        nurseId: nurse.id,
        rank: i + 1,
        reason: i === 0 ? 'most senior volunteer' : `volunteer, ${i} more senior`,
        beyondNeed: needed !== undefined && i >= needed,
      });
    });
  }
  return claims;
}

/** Most senior first; the employee id breaks a shared start date so the order is stable. */
function bySeniority(a: Nurse, b: Nurse): number {
  const byDate = compareDates(a.seniorityDate, b.seniorityDate);
  if (byDate !== 0) return byDate;
  return a.employeeId < b.employeeId ? -1 : a.employeeId > b.employeeId ? 1 : 0;
}
