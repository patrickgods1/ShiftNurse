/**
 * What a manager is told about a nurse's leave while writing or deciding a request: whether the
 * paid hours fit the balance on file, and for FMLA how much of the 12 weeks is left and whether
 * the nurse has met the two eligibility tests.
 *
 * Everything here is advice. A short balance or an ineligible nurse never blocks a request — the
 * manager may know something payroll does not — so the check returns words and the dialogs show
 * them. The sums are core's (`leave/balances.ts`); main supplies the facts they need.
 *
 * FMLA hours used are counted from approved `fmla` time off (the type exists), each day at the
 * nurse's usual pace of a week's hours over seven: a request of 14 calendar days uses two work
 * weeks, however many of those days the nurse would have worked.
 */

import {
  addDays,
  checkLeaveBalance,
  compareDates,
  datesInRange,
  fmlaEligibility,
  fmlaRemaining,
  type Id,
  type IsoDate,
  type TimeOffType,
} from '@shiftnurse/core';
import {
  createFmlaCertification,
  type DbLike,
  deleteFmlaCertification,
  getLeaveBalance,
  getNurse,
  getUnit,
  listAssignmentsForNurseInRange,
  listFmlaCertifications,
  listLeaveBalancesForNurse,
  listShiftTypesForUnit,
  listTimeOffForNurse,
  type ShiftNurseDb,
  setLeaveBalance,
  transact,
  updateFmlaCertification,
} from '@shiftnurse/db';
import type { LeaveRequestCheck, ShiftNurseApi } from '../../shared/api.js';
import { ACTOR } from './context.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

export function checkLeaveRequest(
  db: DbLike,
  nurseId: Id,
  type: TimeOffType,
  startDate: IsoDate,
  endDate: IsoDate,
  paidHours: number,
): LeaveRequestCheck {
  const nurse = getNurse(db, nurseId);
  if (!nurse) throw new Error(`Unknown nurse ${nurseId}`);
  const result: LeaveRequestCheck = {};

  if (type === 'pto' || type === 'sick') {
    const balance = getLeaveBalance(db, nurseId, type);
    if (balance) {
      result.balance = {
        type,
        balanceHours: balance.balanceHours,
        asOf: balance.asOf,
        check: checkLeaveBalance({ balanceHours: balance.balanceHours, requestHours: paidHours }),
      };
    } else {
      result.noBalanceFor = type;
    }
  }

  if (type === 'fmla') {
    const unit = getUnit(db, nurse.unitId);
    if (!unit) throw new Error(`Unknown unit ${nurse.unitId}`);
    const weeklyHours = (nurse.contractedHoursPerPeriod * 7) / unit.payPeriodDays;
    const perDay = weeklyHours / 7;
    const usedHours = listTimeOffForNurse(db, nurseId)
      .filter((r) => r.type === 'fmla' && r.status === 'approved')
      .flatMap((r) =>
        datesInRange(r.startDate, r.endDate).map((date) => ({ date, hours: perDay })),
      );

    const unworked = new Set(
      listShiftTypesForUnit(db, nurse.unitId)
        .filter((t) => t.isOnCall)
        .map((t) => t.id),
    );
    const hoursByShiftType = new Map(
      listShiftTypesForUnit(db, nurse.unitId).map((t) => [t.id, t.durationHours]),
    );
    // The year back from the first day of leave: the regulation's 1,250-hour test.
    const hoursLast12Months = listAssignmentsForNurseInRange(
      db,
      nurseId,
      addDays(startDate, -365),
      addDays(startDate, -1),
    )
      .filter((a) => !unworked.has(a.shiftTypeId))
      .reduce((sum, a) => sum + (hoursByShiftType.get(a.shiftTypeId) ?? 0), 0);

    result.fmla = {
      weeklyHours: round2(weeklyHours),
      requestHours: round2(perDay * datesInRange(startDate, endDate).length),
      remainingHours: round2(fmlaRemaining({ weeklyHours, usedHours, onDate: startDate })),
      eligibility: fmlaEligibility({
        // Seniority is the hire date the roster keeps; a nurse whose seniority was bargained
        // earlier than their hire reads as eligible sooner than the law would.
        hiredOn: nurse.seniorityDate,
        onDate: startDate,
        hoursLast12Months,
      }),
      certified: listFmlaCertifications(db, nurseId).some(
        (c) => compareDates(c.startDate, startDate) <= 0 && compareDates(c.endDate, startDate) >= 0,
      ),
    };
  }
  return result;
}

export function leaveBalancesApi(db: ShiftNurseDb): ShiftNurseApi['leaveBalances'] {
  return {
    forNurse: (nurseId) => ({
      balances: listLeaveBalancesForNurse(db, nurseId),
      certifications: listFmlaCertifications(db, nurseId),
    }),
    setBalance: (nurseId, type, balanceHours, asOf) =>
      transact(db, (tx) => setLeaveBalance(tx, { nurseId, type, balanceHours, asOf }, ACTOR)),
    addCertification: (input) => transact(db, (tx) => createFmlaCertification(tx, input, ACTOR)),
    updateCertification: (id, patch) =>
      transact(db, (tx) => updateFmlaCertification(tx, id, patch, ACTOR)),
    removeCertification: (id) => transact(db, (tx) => deleteFmlaCertification(tx, id, ACTOR)),
    checkRequest: (nurseId, type, startDate, endDate, paidHours) =>
      checkLeaveRequest(db, nurseId, type, startDate, endDate, paidHours),
  };
}
