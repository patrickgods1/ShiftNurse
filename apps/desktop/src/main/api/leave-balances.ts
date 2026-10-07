/**
 * What a manager is told about a nurse's leave while writing or deciding a request: whether the
 * paid hours fit the balance the nurse will have on the first day, and for FMLA how much of the
 * entitlement is left and whether the nurse has met the eligibility tests.
 *
 * Everything here is advice. A short balance or an ineligible nurse never blocks a request — the
 * manager may know something payroll does not — so the check returns words and the dialogs show
 * them. The sums are core's (`leave/`); main supplies the facts they need, read through the
 * unit's `leavePolicy` (a unit with none is read as `DEFAULT_LEAVE_POLICY`: Title I, no accrual).
 *
 * A balance is payroll's figure carried forward to the request's first day (`projectBalance`):
 * the manager approving leave three pay periods after payroll's date would otherwise be checking
 * against a stale number. Leave already approved on the same balance counts as used.
 *
 * A 72/80 nurse is charged 10 hours of leave for each 9 of absence (`leaveChargeHours`): the
 * request keeps its worked hours, and the debit — balance projection and check — is charged. FMLA is not: its entitlement and use are
 * both in worked hours.
 *
 * FMLA hours used are counted from approved `fmla` time off, each day at the nurse's usual pace
 * of a week's hours over seven: a request of 14 calendar days uses two work weeks, however many
 * of those days the nurse would have worked. The entitlement, the eligibility tests and the
 * twelve-month year follow the policy's regime — Title 5 for VA staff, Title I otherwise — and
 * the hire date, not the seniority date, starts the length-of-service test where the roster
 * keeps one.
 */

import {
  type Assignment,
  accrualRuleFor,
  addDays,
  checkLeaveBalance,
  compareDates,
  DEFAULT_LEAVE_POLICY,
  datesInRange,
  fmlaEligibility,
  fmlaEntitlementHours,
  fmlaStanding,
  type Id,
  type IsoDate,
  LEAVE_BALANCE_TYPES,
  type LeaveBalanceType,
  leaveChargeHours,
  payPeriodIndex,
  payPeriodWindow,
  projectBalance,
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

const isBalanceType = (type: TimeOffType): type is LeaveBalanceType =>
  (LEAVE_BALANCE_TYPES as readonly TimeOffType[]).includes(type);

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
  const unit = getUnit(db, nurse.unitId);
  if (!unit) throw new Error(`Unknown unit ${nurse.unitId}`);
  const policy = unit.leavePolicy ?? DEFAULT_LEAVE_POLICY;
  const result: LeaveRequestCheck = {};

  // Hours worked (on-call standby is not work), per assignment date, for per-hour accrual and
  // the Title I hours tests. The declared shift length is the truth, never end minus start.
  const shiftTypes = listShiftTypesForUnit(db, nurse.unitId);
  const unworked = new Set(shiftTypes.filter((t) => t.isOnCall).map((t) => t.id));
  const lengthOf = new Map(shiftTypes.map((t) => [t.id, t.durationHours]));
  const workedHours = (assignments: readonly Assignment[]) =>
    assignments
      .filter((a) => !unworked.has(a.shiftTypeId))
      .reduce((sum, a) => sum + (lengthOf.get(a.shiftTypeId) ?? 0), 0);

  const serviceStart = nurse.hireDate ?? nurse.seniorityDate;

  if (isBalanceType(type)) {
    const balance = getLeaveBalance(db, nurseId, type);
    if (balance) {
      const rule = accrualRuleFor(policy, nurse, type);
      const used = listTimeOffForNurse(db, nurseId)
        .filter((r) => r.type === type && r.status === 'approved' && (r.paidHours ?? 0) > 0)
        .map((r) => ({
          date: r.startDate,
          hours: leaveChargeHours(nurse.scheduleKind, r.paidHours ?? 0),
        }));
      // Only a per-hour tier reads worked hours, and only for the pay periods that close
      // between payroll's date and the request.
      const hoursByPayPeriodStart = new Map<IsoDate, number>();
      if (rule?.tiers.some((t) => t.hoursPerAccruedHour !== undefined)) {
        const from = payPeriodWindow(payPeriodIndex(balance.asOf, unit), unit).start;
        const through = addDays(startDate, -1);
        const byPeriod = new Map<IsoDate, Assignment[]>();
        for (const a of listAssignmentsForNurseInRange(db, nurseId, from, through)) {
          const key = payPeriodWindow(payPeriodIndex(a.date, unit), unit).start;
          byPeriod.set(key, [...(byPeriod.get(key) ?? []), a]);
        }
        for (const [key, assignments] of byPeriod) {
          hoursByPayPeriodStart.set(key, workedHours(assignments));
        }
      }
      const projection = projectBalance({
        balanceHours: balance.balanceHours,
        asOf: balance.asOf,
        onDate: startDate,
        ...(rule ? { rule } : {}),
        serviceStart,
        calendar: unit,
        leaveYearStart: policy.leaveYearStart,
        hoursByPayPeriodStart,
        used,
      });
      result.balance = {
        type,
        balanceHours: balance.balanceHours,
        asOf: balance.asOf,
        projectedHours: round2(projection.hours),
        accruedHours: round2(projection.accruedHours),
        usedHours: round2(projection.usedHours),
        forfeitedHours: round2(projection.forfeitedHours),
        check: checkLeaveBalance({
          balanceHours: projection.hours,
          requestHours: leaveChargeHours(nurse.scheduleKind, paidHours),
        }),
      };
    } else {
      result.noBalanceFor = type;
    }
  }

  if (type === 'fmla') {
    const weeklyHours = (nurse.contractedHoursPerPeriod * 7) / unit.payPeriodDays;
    // Not charged 10/9 for a 72/80 nurse: § 7456A(d) charges leave *balances*, but the FMLA
    // entitlement (6 × the biweekly tour, 12 × the usual week) and these used hours are both
    // counted in worked hours, so charging one side only would run the 12 weeks out in about 10.8.
    const perDay = weeklyHours / 7;
    const usedHours = listTimeOffForNurse(db, nurseId)
      .filter((r) => r.type === 'fmla' && r.status === 'approved')
      .flatMap((r) =>
        datesInRange(r.startDate, r.endDate).map((date) => ({ date, hours: perDay })),
      );

    // The year back from the first day of leave: the regulation's 1,250-hour test.
    const hoursLast12Months = workedHours(
      listAssignmentsForNurseInRange(db, nurseId, addDays(startDate, -365), addDays(startDate, -1)),
    );

    // The 52-week average stands in for the usual week only where the record reaches back the
    // whole 52 weeks; a shorter record would average a new hire's first weeks as the whole year.
    // Looked for in the four weeks up to the boundary, not the whole history: a nurse who worked
    // then has a record that reaches back the year. A longer gap (leave) reads as a short record,
    // which falls back to the contract week, the safer figure.
    const recordCoversYear =
      listAssignmentsForNurseInRange(
        db,
        nurseId,
        addDays(startDate, -364 - 28),
        addDays(startDate, -364),
      ).length > 0;
    const entitlement = fmlaEntitlementHours({
      regime: policy.fmla.regime,
      contractWeeklyHours: weeklyHours,
      ...(policy.fmla.regime === 'title1' && recordCoversYear
        ? {
            scheduledHoursLast52Weeks: workedHours(
              listAssignmentsForNurseInRange(
                db,
                nurseId,
                addDays(startDate, -364),
                addDays(startDate, -1),
              ),
            ),
          }
        : {}),
    });
    const standing = fmlaStanding({
      policy: policy.fmla,
      entitlementHours: entitlement.hours,
      usedHours,
      onDate: startDate,
    });

    result.fmla = {
      regime: policy.fmla.regime,
      weeklyHours: round2(weeklyHours),
      entitlementHours: round2(entitlement.hours),
      basis: entitlement.basis,
      period: standing.period,
      requestHours: round2(perDay * datesInRange(startDate, endDate).length),
      remainingHours: round2(standing.remainingHours),
      eligibility: fmlaEligibility({
        regime: policy.fmla.regime,
        hiredOn: serviceStart,
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
