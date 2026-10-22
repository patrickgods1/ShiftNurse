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
 * against a stale number. Leave already approved on the same balance counts as used, and comp
 * time banked from a finished schedule (`comp_time_credit`) counts as earned.
 *
 * A 72/80 nurse is charged 10 hours of annual or sick leave for each 9 of absence (`leaveChargeHours`): the
 * request keeps its worked hours, and the debit — balance projection and check — is charged. FMLA is not: its entitlement and use are
 * both in worked hours.
 *
 * FMLA hours used are counted from approved `fmla` time off, each day at the nurse's usual pace
 * of a week's hours over seven: a request of 14 calendar days uses two work weeks, however many
 * of those days the nurse would have worked. The entitlement, the eligibility tests and the
 * twelve-month year follow the policy's regime — Title 5 for VA staff, Title I otherwise — and
 * the hire date, not the seniority date, starts the length-of-service test where the roster
 * keeps one.
 *
 * Hours worked — for per-hour accrual, the 1,250-hour test and the 52-week average — are the
 * shifts of published or archived schedules on any unit, each at its own shift type's length
 * (`workedShiftsForNurseInRange`). A draft is a proposal, and a night floated to another unit is
 * still work.
 *
 * A balance whose rule caps yearly use (California sick leave, 40 hours or five of the unit's
 * usual shifts, whichever is greater) also reports a request that would pass the cap, however
 * large the balance. California pregnancy disability leave is
 * counted like FMLA, at the usual week's pace, against its own four months, which the law grants
 * per pregnancy (Gov. Code § 12945(a)(1)). The app has no pregnancy record, so the certification
 * covering the first day stands for this pregnancy's episode (D14) and the leave is counted over
 * its dates: a second pregnancy within a year starts fresh, and one pregnancy's leave spread over
 * more than a year is counted whole. Without a covering certification it falls back to the 12
 * months back from the first day and says so (`basis`). The certification table is the FMLA one;
 * if PDL ever gets an episode record of its own, it replaces that lookup alone. PDL has no
 * eligibility test.
 */

import {
  accrualRuleFor,
  addDays,
  type BalanceProjection,
  checkLeaveBalance,
  checkUseCap,
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
  leaveCapsFor,
  leaveChargeHours,
  type Nurse,
  payPeriodIndex,
  payPeriodWindow,
  pdlEntitlementHours,
  projectBalance,
  type TimeOffType,
  typicalShiftHours,
  type Unit,
} from '@shiftnurse/core';
import {
  createCompTimeElection,
  createFmlaCertification,
  type DbLike,
  deleteCompTimeElection,
  deleteFmlaCertification,
  getLeaveBalance,
  getNurse,
  getUnit,
  listCompTimeCreditsForNurse,
  listCompTimeElectionsForNurse,
  listFmlaCertifications,
  listLeaveBalancesForNurse,
  listShiftTypesForUnit,
  listTimeOffForNurse,
  type ShiftNurseDb,
  setLeaveBalance,
  transact,
  updateCompTimeElection,
  updateFmlaCertification,
  workedShiftsForNurseInRange,
} from '@shiftnurse/db';
import type { LeaveRequestCheck, ShiftNurseApi } from '../../shared/api.js';
import { ACTOR } from './context.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

const isBalanceType = (type: TimeOffType): type is LeaveBalanceType =>
  (LEAVE_BALANCE_TYPES as readonly TimeOffType[]).includes(type);

/**
 * Payroll's figure for one balance carried forward to `onDate`, or undefined when payroll's figure
 * was never entered. The request check and comp-time banking both read it here, so the balance a
 * credit is capped against is the one a later request is checked against. `start` stands in for a
 * missing row (banking starts a nurse with none at 0).
 *
 * Comp credits earn on their period's last day, so they count from the day after: the projection's
 * window is strict at both ends.
 */
export function projectedLeaveBalance(
  db: DbLike,
  nurseId: Id,
  type: LeaveBalanceType,
  onDate: IsoDate,
  start?: { balanceHours: number; asOf: IsoDate },
): BalanceProjection | undefined {
  const nurse = getNurse(db, nurseId);
  if (!nurse) throw new Error('That nurse was not found. Reload the page.');
  const unit = getUnit(db, nurse.unitId);
  if (!unit) throw new Error("That nurse's unit was not found. Reload the app.");
  return balanceProjectionFor(db, nurse, unit, type, onDate, start)?.projection;
}

function balanceProjectionFor(
  db: DbLike,
  nurse: Nurse,
  unit: Unit,
  type: LeaveBalanceType,
  onDate: IsoDate,
  start?: { balanceHours: number; asOf: IsoDate },
) {
  const nurseId = nurse.id;
  const balance = getLeaveBalance(db, nurseId, type) ?? start;
  if (!balance) return undefined;
  const policy = unit.leavePolicy ?? DEFAULT_LEAVE_POLICY;
  const rule = accrualRuleFor(policy, nurse, type);
  const used = listTimeOffForNurse(db, nurseId)
    .filter((r) => r.type === type && r.status === 'approved' && (r.paidHours ?? 0) > 0)
    .map((r) => ({
      date: r.startDate,
      hours: leaveChargeHours(nurse.scheduleKind, type, r.paidHours ?? 0),
    }));
  const earned =
    type === 'comp'
      ? listCompTimeCreditsForNurse(db, nurseId).map((c) => ({
          date: c.periodEndDate,
          hours: c.creditedHours,
        }))
      : [];
  // Only a per-hour tier reads worked hours, and only for the pay periods that close
  // between payroll's date and the request.
  const hoursByPayPeriodStart = new Map<IsoDate, number>();
  if (rule?.tiers.some((t) => t.hoursPerAccruedHour !== undefined)) {
    const from = payPeriodWindow(payPeriodIndex(balance.asOf, unit), unit).start;
    const through = addDays(onDate, -1);
    for (const shift of workedShiftsForNurseInRange(db, nurseId, from, through)) {
      const key = payPeriodWindow(payPeriodIndex(shift.date, unit), unit).start;
      hoursByPayPeriodStart.set(key, (hoursByPayPeriodStart.get(key) ?? 0) + shift.hours);
    }
  }
  // A cap in days (California: 80 hours or 10 days) is counted in the unit's usual shift,
  // the same length a request's paid hours default to.
  const shiftHours = typicalShiftHours(listShiftTypesForUnit(db, unit.id));
  const projection = projectBalance({
    balanceHours: balance.balanceHours,
    asOf: balance.asOf,
    onDate,
    ...(rule ? { rule } : {}),
    serviceStart: nurse.hireDate ?? nurse.seniorityDate,
    calendar: unit,
    leaveYearStart: policy.leaveYearStart,
    hoursByPayPeriodStart,
    used,
    earned,
    shiftHours,
  });
  return { balance, rule, shiftHours, projection };
}

export function checkLeaveRequest(
  db: DbLike,
  nurseId: Id,
  type: TimeOffType,
  startDate: IsoDate,
  endDate: IsoDate,
  paidHours: number,
): LeaveRequestCheck {
  const nurse = getNurse(db, nurseId);
  if (!nurse) throw new Error('That nurse was not found. Reload the page.');
  const unit = getUnit(db, nurse.unitId);
  if (!unit) throw new Error("That nurse's unit was not found. Reload the app.");
  const policy = unit.leavePolicy ?? DEFAULT_LEAVE_POLICY;
  const result: LeaveRequestCheck = {};

  const workedHours = (from: IsoDate, to: IsoDate) =>
    workedShiftsForNurseInRange(db, nurseId, from, to).reduce((sum, s) => sum + s.hours, 0);

  const serviceStart = nurse.hireDate ?? nurse.seniorityDate;

  if (isBalanceType(type)) {
    const projected = balanceProjectionFor(db, nurse, unit, type, startDate);
    if (projected) {
      const { balance, rule, shiftHours, projection } = projected;
      const requestHours = leaveChargeHours(nurse.scheduleKind, type, paidHours);
      const caps = rule ? leaveCapsFor(rule, shiftHours) : {};
      const capHours = caps.useCapHoursPerYear;
      const useCap =
        capHours === undefined
          ? undefined
          : checkUseCap({
              usedThisYearHours: projection.usedThisYearHours,
              requestHours,
              useCapHoursPerYear: capHours,
            });
      result.balance = {
        type,
        balanceHours: balance.balanceHours,
        asOf: balance.asOf,
        projectedHours: round2(projection.hours),
        accruedHours: round2(projection.accruedHours),
        usedHours: round2(projection.usedHours),
        forfeitedHours: round2(projection.forfeitedHours),
        earnedHours: round2(projection.earnedHours),
        usedThisYearHours: round2(projection.usedThisYearHours),
        check: checkLeaveBalance({ balanceHours: projection.hours, requestHours }),
        ...(capHours !== undefined && useCap && !useCap.ok
          ? { useCap: { capHours, overBy: round2(useCap.overBy) } }
          : {}),
      };
    } else {
      result.noBalanceFor = type;
    }
  }

  if (type === 'pregnancy_disability') {
    const weeklyHours = (nurse.contractedHoursPerPeriod * 7) / unit.payPeriodDays;
    const perDay = weeklyHours / 7;
    // This pregnancy's certification, else the 365 days ending on the first day, as FMLA's
    // rolling-back year counts them.
    const cert = listFmlaCertifications(db, nurseId).find(
      (c) => compareDates(c.startDate, startDate) <= 0 && compareDates(c.endDate, startDate) >= 0,
    );
    const basis = cert ? ('certification' as const) : ('rolling_year' as const);
    const period = cert
      ? { from: cert.startDate, to: cert.endDate }
      : { from: addDays(startDate, -364), to: startDate };
    const usedHours =
      perDay *
      listTimeOffForNurse(db, nurseId)
        .filter((r) => r.type === 'pregnancy_disability' && r.status === 'approved')
        .flatMap((r) => datesInRange(r.startDate, r.endDate))
        .filter(
          (date) => compareDates(date, period.from) >= 0 && compareDates(date, period.to) <= 0,
        ).length;
    const entitlementHours = pdlEntitlementHours({ contractWeeklyHours: weeklyHours });
    result.pdl = {
      entitlementHours: round2(entitlementHours),
      weeklyHours: round2(weeklyHours),
      period,
      usedHours: round2(usedHours),
      requestHours: round2(perDay * datesInRange(startDate, endDate).length),
      remainingHours: round2(Math.max(0, entitlementHours - usedHours)),
      basis,
    };
  }

  if (type === 'fmla') {
    const weeklyHours = (nurse.contractedHoursPerPeriod * 7) / unit.payPeriodDays;
    // Not charged 10/9 for a 72/80 nurse: § 7456A(b)(3) charges annual and sick leave *balances*
    // (comp time and PTO are charged hour for hour), but the FMLA
    // entitlement (6 × the biweekly tour, 12 × the usual week) and these used hours are both
    // counted in worked hours, so charging one side only would run the 12 weeks out in about 10.8.
    const perDay = weeklyHours / 7;
    const usedHours = listTimeOffForNurse(db, nurseId)
      .filter((r) => r.type === 'fmla' && r.status === 'approved')
      .flatMap((r) =>
        datesInRange(r.startDate, r.endDate).map((date) => ({ date, hours: perDay })),
      );

    // The year back from the first day of leave: the regulation's 1,250-hour test.
    const hoursLast12Months = workedHours(addDays(startDate, -365), addDays(startDate, -1));

    // The 52-week average stands in for the usual week only where the record reaches back the
    // whole 52 weeks; a shorter record would average a new hire's first weeks as the whole year.
    // Looked for in the four weeks up to the boundary, not the whole history: a nurse who worked
    // then has a record that reaches back the year. A longer gap (leave) reads as a short record,
    // which falls back to the contract week, the safer figure.
    const recordCoversYear =
      workedShiftsForNurseInRange(
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
              addDays(startDate, -364),
              addDays(startDate, -1),
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
    compElections: (nurseId) => listCompTimeElectionsForNurse(db, nurseId),
    addCompElection: (input) => transact(db, (tx) => createCompTimeElection(tx, input, ACTOR)),
    updateCompElection: (id, patch) =>
      transact(db, (tx) => updateCompTimeElection(tx, id, patch, ACTOR)),
    removeCompElection: (id) => transact(db, (tx) => deleteCompTimeElection(tx, id, ACTOR)),
    checkRequest: (nurseId, type, startDate, endDate, paidHours) =>
      checkLeaveRequest(db, nurseId, type, startDate, endDate, paidHours),
  };
}
