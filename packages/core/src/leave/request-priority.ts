/**
 * Who should be granted a contested day off first when several pending requests compete for it.
 *
 * The VA–NNU Master Agreement (Art. 13 §2.D.7) wants requests granted "on an equitable basis"
 * with a written reason for a denial. The app records the reason, but with nothing ranking the
 * claimants the manager decides from memory, and the nurse who is always denied keeps being
 * denied. This module orders them: lowest approval rate first (the fairness ledger's
 * `requestsApproved` / `requestsDenied`, summed over every period on file), then, on a holiday,
 * whoever worked last year's occurrence, then seniority, then who asked first. It is advice: it
 * approves and denies nothing, and the solver does not read it.
 *
 * A nurse with no decided request has never been denied, so ranks behind every nurse with a
 * record rather than ahead as a 0% would put them. "Last year's occurrence" is
 * `previousOccurrence`, the definition `holiday-priority.ts` and the rotation rule share; with no
 * such occurrence there is nothing to judge by and the step is skipped (`null`).
 */

import type {
  FairnessLedgerEntry,
  Holiday,
  Id,
  Nurse,
  TimeOffRequest,
} from '../domain/entities.js';
import { compareDates, type IsoDate } from '../domain/time.js';
import { previousOccurrence } from '../rules/holiday-rotation.js';
import type { HolidayWorkRecord } from '../rules/types.js';

export interface RequestPriorityInput {
  /** The competing pending requests for one date. */
  requests: readonly TimeOffRequest[];
  date: IsoDate;
  nurses: readonly Nurse[];
  /** Fairness ledger history (any periods); approval rate is summed over it. */
  ledger: readonly FairnessLedgerEntry[];
  /** The unit's holidays, past years included, and who worked them (for a holiday date). */
  holidays: readonly Holiday[];
  holidayWork: readonly HolidayWorkRecord[];
}

export interface RequestClaimant {
  requestId: Id;
  nurseId: Id;
  /** 1 = first in line. */
  rank: number;
  /** approved / (approved + denied) over the ledger; null with no decided request on record. */
  approvalRate: number | null;
  /** For a holiday date: whether the nurse worked last year's occurrence; null otherwise/unknown. */
  workedHolidayLastYear: boolean | null;
  reason: string;
}

export function competingRequestPriority(input: RequestPriorityInput): RequestClaimant[] {
  const nursesById = new Map(input.nurses.map((n) => [n.id, n]));
  const tally = new Map<Id, { approved: number; denied: number }>();
  for (const row of input.ledger) {
    const t = tally.get(row.nurseId) ?? { approved: 0, denied: 0 };
    t.approved += row.requestsApproved;
    t.denied += row.requestsDenied;
    tally.set(row.nurseId, t);
  }

  // Two holidays can share a date; the major one is the one a contract's rules are about, and
  // name order keeps the pick independent of row order.
  const holiday = input.holidays
    .filter((h) => h.date === input.date)
    .sort((a, b) => Number(b.isMajor) - Number(a.isMajor) || a.name.localeCompare(b.name))[0];
  const previous = holiday ? previousOccurrence(holiday, input.holidays) : undefined;
  const workedLast = new Set<Id>(
    previous
      ? input.holidayWork.filter((r) => r.holidayId === previous.id).map((r) => r.nurseId)
      : [],
  );

  const entries = input.requests.map((request) => {
    const nurse = nursesById.get(request.nurseId);
    // Bad data throws loudly: a request from an unknown nurse is corruption, not a skip.
    if (!nurse)
      throw new Error(`Time-off request ${request.id} names unknown nurse ${request.nurseId}`);
    const t = tally.get(nurse.id);
    const decided = t ? t.approved + t.denied : 0;
    return {
      request,
      nurse,
      approved: t?.approved ?? 0,
      decided,
      rate: decided > 0 ? (t?.approved ?? 0) / decided : null,
      worked: previous === undefined ? null : workedLast.has(nurse.id),
    };
  });

  entries.sort((a, b) => {
    if (a.rate !== b.rate) {
      if (a.rate === null) return 1;
      if (b.rate === null) return -1;
      return a.rate - b.rate;
    }
    const byWorked = Number(b.worked === true) - Number(a.worked === true);
    if (byWorked !== 0) return byWorked;
    const bySeniority = compareDates(a.nurse.seniorityDate, b.nurse.seniorityDate);
    if (bySeniority !== 0) return bySeniority;
    if (a.request.submittedAt !== b.request.submittedAt)
      return a.request.submittedAt - b.request.submittedAt;
    return a.nurse.employeeId < b.nurse.employeeId
      ? -1
      : a.nurse.employeeId > b.nurse.employeeId
        ? 1
        : 0;
  });

  return entries.map((e, i) => {
    const record =
      e.rate === null
        ? 'No decided requests on record'
        : `Approved ${e.approved} of ${e.decided} requests (${Math.round(e.rate * 100)}%)`;
    const worked = e.worked === true && holiday ? `; worked ${holiday.name} last year` : '';
    return {
      requestId: e.request.id,
      nurseId: e.nurse.id,
      rank: i + 1,
      approvalRate: e.rate,
      workedHolidayLastYear: e.worked,
      reason: `${record}; seniority ${e.nurse.seniorityDate}${worked}`,
    };
  });
}
