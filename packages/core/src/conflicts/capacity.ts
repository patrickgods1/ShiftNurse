/**
 * Can the unit spare this nurse on the days they asked for?
 *
 * A time-off request is decided before the schedule exists — that is the point of a request
 * window — so judging it against the draft ("+2 slots short") says nothing useful: an empty draft
 * reads every request as a disaster, and a generated one reads it by whoever the solver happened
 * to place. A staffing office judges it by capacity instead: on each day, how many shifts the
 * floors need, and how many the staff not already off can cover at their contracted hours.
 *
 * Supply is expected, not promised: a 0.9 FTE on 12-hour shifts covers 72 / 14 / 12 ≈ 0.43 of
 * a shift a day. A day is judged against the unit's *usual* day — every contracted nurse of the
 * role working, the requester included — not against a perfect one. Many units are built to
 * fill a small gap with per-diem staff every day (the community demo's 27 RNs cover 162 of the
 * 168 shifts a pay period needs), and judged against a perfect day every request on every day
 * read "needs per-diem", a warning a manager learns to ignore. So a day is "short" when the gap
 * is more than the per-diem staff left can take one shift each, "tight" when leave adds a whole
 * shift or more to the usual gap (less than that, the pay period's other days absorb it), and
 * "ok" otherwise. The same is read again as if every other pending request on that day were
 * approved too, because a manager deciding one is deciding against the rest.
 */

import type { Id, NurseRole, TimeOffRequest } from '../domain/entities.js';
import { dateInRange, type IsoDate } from '../domain/time.js';
import type { SolveInput } from '../solver/types.js';

export type CapacityVerdict = 'ok' | 'tight' | 'short';

export interface DayCapacity {
  date: IsoDate;
  role: NurseRole;
  /** Shifts the day's floors need for this role, every standalone shift together. */
  needed: number;
  /** Shifts the contracted staff not on leave supply on an average day, to one decimal. */
  supply: number;
  /** What the role's whole contracted staff supply on a day nobody is off, to one decimal. */
  usualSupply: number;
  /** Per-diem and agency staff of this role not on leave: up to one shift each. */
  perDiem: number;
  /** Same-role nurses already approved off that day (the requester aside). */
  offApproved: number;
  /** Same-role nurses with another pending request that day. */
  offPending: number;
  verdict: CapacityVerdict;
  /** The verdict if every other pending request that day were approved as well. */
  verdictIfAllApproved: CapacityVerdict;
}

const ROLES: readonly NurseRole[] = ['RN', 'LPN', 'CNA'];
const EPSILON = 1e-9;

function judge(
  supply: number,
  usualSupply: number,
  perDiem: number,
  needed: number,
): CapacityVerdict {
  const gap = Math.max(0, needed - supply);
  if (gap > perDiem + EPSILON) return 'short';
  const usualGap = Math.max(0, needed - usualSupply);
  return gap - usualGap + EPSILON >= 1 ? 'tight' : 'ok';
}

const oneDecimal = (n: number) => Math.round(n * 10) / 10;

function offOn(requests: readonly TimeOffRequest[], nurseId: Id, date: IsoDate, status: string) {
  return requests.some(
    (r) =>
      r.nurseId === nurseId && r.status === status && dateInRange(date, r.startDate, r.endDate),
  );
}

export function leaveCapacity(input: SolveInput, requestId: Id): DayCapacity[] {
  const request = input.timeOff.find((r) => r.id === requestId);
  if (!request) throw new Error(`Time-off request ${requestId} is not in this period's input`);
  const requester = input.nurses.find((n) => n.id === request.nurseId);
  const shiftTypes = new Map(input.shiftTypes.map((s) => [s.id, s]));
  const others = input.timeOff.filter((r) => r.id !== requestId);
  const out: DayCapacity[] = [];

  const dates = [...new Set(input.demand.map((d) => d.date))]
    .filter((d) => dateInRange(d, request.startDate, request.endDate))
    .sort();
  for (const date of dates) {
    for (const role of ROLES) {
      // Only roles the requester's absence touches: a nurse's leave does not move the CNA count.
      if (requester && requester.role !== role) continue;
      let needed = 0;
      let neededHours = 0;
      for (const d of input.demand) {
        if (d.date !== date) continue;
        const st = shiftTypes.get(d.shiftTypeId);
        // Inside shifts (a mid 8 within the day 12) share the containing shift's staff.
        if (!st || st.isOnCall || st.withinShiftTypeId !== null || !st.active) continue;
        const count = d.byRole[role]?.minCount ?? 0;
        needed += count;
        neededHours += count * st.durationHours;
      }
      if (needed === 0) continue;
      const shiftHours = neededHours / needed;

      let supply = 0;
      let usualSupply = 0;
      let supplyIfAll = 0;
      let perDiem = 0;
      let perDiemIfAll = 0;
      let offApproved = 0;
      let offPending = 0;
      const share = (hours: number) => hours / input.unit.payPeriodDays / shiftHours;
      for (const nurse of input.nurses) {
        if (!nurse.active || nurse.role !== role) continue;
        usualSupply += share(nurse.contractedHoursPerPeriod);
        if (nurse.id === request.nurseId) continue;
        if (offOn(others, nurse.id, date, 'approved')) {
          offApproved++;
          continue;
        }
        const pending = offOn(others, nurse.id, date, 'pending');
        if (pending) offPending++;
        const contracted = nurse.contractedHoursPerPeriod > 0;
        const own = share(nurse.contractedHoursPerPeriod);
        if (contracted) supply += own;
        else perDiem++;
        if (!pending) {
          if (contracted) supplyIfAll += own;
          else perDiemIfAll++;
        }
      }
      out.push({
        date,
        role,
        needed,
        supply: oneDecimal(supply),
        usualSupply: oneDecimal(usualSupply),
        perDiem,
        offApproved,
        offPending,
        verdict: judge(supply, usualSupply, perDiem, needed),
        verdictIfAllApproved: judge(supplyIfAll, usualSupply, perDiemIfAll, needed),
      });
    }
  }
  return out;
}
