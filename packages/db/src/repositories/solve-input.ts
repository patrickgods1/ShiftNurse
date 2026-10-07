/**
 * One definition of "the period" as the solver, the conflict detector and the cost report see it.
 *
 * Lived in the desktop main process until M15, when the solver benchmark needed the real demo
 * unit's `SolveInput` in plain Node; a second copy there would have been a second, drifting
 * definition of what the solver is given. It is only reads, composed — no new data access.
 */

import {
  addDays,
  type CostContext,
  compareDates,
  dateInRange,
  datesInRange,
  deriveDemand,
  type FairnessLedgerEntry,
  groupsForPeriod,
  type HolidayWorkRecord,
  type Id,
  type IsoDate,
  type MaxHoursParams,
  maxHoursRule,
  type Nurse,
  type NurseCredential,
  type PaidLeaveCredit,
  type Preference,
  paidLeaveCredits,
  type RuleSet,
  type SchedulePeriod,
  type SolveInput,
  type TimeOffRequest,
  type Unit,
} from '@shiftnurse/core';
import type { DbLike } from '../client.js';
import { getHppdTarget, listActiveRatioRulesForUnit, listAcuityTiersForUnit } from './acuity.js';
import { listAvailabilityBlocks } from './availability-blocks.js';
import { paidSickCallsForUnit } from './calloffs.js';
import { listCensusForecastsInRange } from './census.js';
import {
  getUnit,
  listCoverageRequirementsForUnit,
  listHolidaysForUnit,
  listShiftCredentialRequirementsForUnit,
  listShiftTypesForUnit,
} from './config.js';
import { holidayWorkFor, holidayWorkIn } from './holidays.js';
import { listIncompatibilityGroups } from './incompatibility.js';
import { ledgerSince } from './ledger.js';
import { busyElsewhereFor, listFloatNurses } from './nurse-units.js';
import { listOvertimeVolunteersOverlapping } from './overtime-volunteers.js';
import {
  getPaySettings,
  listActiveDifferentials,
  listActiveOvertimeRules,
  listPayRatesForUnit,
} from './pay.js';
import { listPreceptorshipsOverlapping } from './preceptorships.js';
import { restWaiversForPeriod } from './rest-waivers.js';
import {
  listCredentials,
  listNurseCredentials,
  listNurseCredentialsForUnit,
  listNursesForUnit,
  listPreferencesForNurse,
  listPreferencesForUnit,
} from './roster.js';
import { getRuleSet } from './rulesets.js';
import { listAssignmentsForPeriod, priorAssignmentsBefore } from './schedule.js';
import {
  listTimeOffForNurse,
  listTimeOffForUnit,
  listTimeOffOverlappingForUnit,
} from './timeoff.js';

function unitOrThrow(db: DbLike, unitId: Id) {
  const unit = getUnit(db, unitId);
  if (!unit) throw new Error(`Unknown unit ${unitId}`);
  return unit;
}

/**
 * How far back the ledger is read. The burden window is 13 periods (~6 months of two-week
 * periods) with decay, so a year of rows is more than enough and keeps the query bounded on
 * a unit that has imported years of history.
 */
export const LEDGER_LOOKBACK_DAYS = 400;

/**
 * Days of earlier published shifts a period is judged with (`priorAssignments`, flagged out of
 * period). Rest and stretch rules need only the night before, but a rolling four-weekend quota
 * (`weekend-pattern`'s `maxWeekendsPer4Weeks`) reads the three weekends before the period's first
 * one, which reach up to 22 days back; a 14-day tail let a third weekend in four through unseen.
 * 28 is a whole number of weeks, so it covers that for any start day. Every loader that reads the
 * tail, or what the tail is judged with (leave, sick calls, offers, other units), uses this.
 */
export const PRIOR_ASSIGNMENT_LOOKBACK_DAYS = 28;

/** The window the loaders read other units over, matching the tail of prior shifts. */
export function elsewhereWindow(period: { startDate: IsoDate; endDate: IsoDate }): {
  start: IsoDate;
  end: IsoDate;
} {
  return {
    start: addDays(period.startDate, -PRIOR_ASSIGNMENT_LOOKBACK_DAYS),
    end: period.endDate,
  };
}

/**
 * The holiday history this period's rotation reads: who worked the previous occurrence of every
 * holiday it could hold (300–430 days before, see `previousOccurrence`), and who worked the far
 * half of any pair it holds one half of — a pair can span months, so that half may be anywhere
 * in the past.
 */
export function holidayWorkForPeriod(db: DbLike, period: SchedulePeriod): HolidayWorkRecord[] {
  const lastYear = holidayWorkIn(
    db,
    period.unitId,
    addDays(period.startDate, -430),
    addDays(period.endDate, -300),
  );
  const holidays = listHolidaysForUnit(db, period.unitId);
  const inPeriod = new Set(
    holidays.filter((h) => dateInRange(h.date, period.startDate, period.endDate)).map((h) => h.id),
  );
  const partners = new Set<Id>();
  for (const h of holidays) {
    if (h.pairedHolidayId === null) continue;
    if (inPeriod.has(h.id)) partners.add(h.pairedHolidayId);
    if (inPeriod.has(h.pairedHolidayId)) partners.add(h.id);
  }
  const seen = new Set(lastYear.map((r) => r.holidayId));
  const farHalves = [...partners].filter((id) => !seen.has(id) && !inPeriod.has(id));
  return [...lastYear, ...holidayWorkFor(db, period.unitId, farHalves)];
}

/** Everything `deriveDemand` needs for a unit, loaded once per call. */
export function demandInputs(db: DbLike, unitId: Id, start: IsoDate, end: IsoDate) {
  const ratioStaffing = getUnit(db, unitId)?.ratioStaffing;
  return {
    shiftTypes: listShiftTypesForUnit(db, unitId),
    acuityTiers: listAcuityTiersForUnit(db, unitId),
    ratioRules: listActiveRatioRulesForUnit(db, unitId),
    coverageRequirements: listCoverageRequirementsForUnit(db, unitId),
    censusForecasts: listCensusForecastsInRange(db, unitId, start, end),
    hppdTarget: getHppdTarget(db, unitId),
    ...(ratioStaffing ? { ratioStaffing } : {}),
  };
}

export function ledgerHistory(db: DbLike, unitId: Id, before: IsoDate): FairnessLedgerEntry[] {
  return ledgerSince(db, unitId, addDays(before, -LEDGER_LOOKBACK_DAYS)).filter(
    (e) => compareDates(e.periodStart, before) < 0,
  );
}

/**
 * Everything `costSchedule` needs for a unit under a given rule set. The work-week start comes
 * from the max-hours rule's parameters so weekly overtime is counted over the same week the
 * rule engine polices — two different "weeks" would let a shift be flagged as overtime by the
 * rules and priced as straight time, or the reverse.
 */
export function costContext(
  db: DbLike,
  unitId: Id,
  ruleSet: RuleSet,
  // The period being priced bounds the leave read; without one all of the unit's leave is read.
  period?: SchedulePeriod,
): CostContext {
  const maxHours = ruleSet.configs.find((c) => c.ruleId === maxHoursRule.id);
  const params = (maxHours?.params ?? maxHoursRule.defaultParams) as Partial<MaxHoursParams>;
  const holidays = listHolidaysForUnit(db, unitId);
  const pay = getPaySettings(db, unitId);
  return {
    unit: unitOrThrow(db, unitId),
    payRates: listPayRatesForUnit(db, unitId),
    differentials: listActiveDifferentials(db, unitId),
    overtimeRules: listActiveOvertimeRules(db, unitId),
    holidayDates: new Set<IsoDate>(holidays.map((h) => h.date)),
    majorHolidayDates: new Set<IsoDate>(holidays.filter((h) => h.isMajor).map((h) => h.date)),
    weekendDefinition: ruleSet.weekendDefinition,
    workWeekStartsOn: params.workWeekStartsOn ?? maxHoursRule.defaultParams.workWeekStartsOn,
    premiumStacking: pay.premiumStacking,
    holidayPayCoversOvertime: pay.holidayPayCoversOvertime,
    ...(params.paidLeaveCountsTowardOvertime
      ? { overtimeLeave: overtimeLeave(db, unitId, period) }
      : {}),
  };
}

/** Paid leave by nurse, for a contract that counts it toward overtime. */
function overtimeLeave(db: DbLike, unitId: Id, period?: SchedulePeriod) {
  const byNurse = new Map<Id, PaidLeaveCredit[]>();
  const credits = paidLeaveCredits(
    period ? timeOffForPeriod(db, unitOrThrow(db, unitId), period) : listTimeOffForUnit(db, unitId),
    paidSickCallsForUnit(db, unitId),
  );
  for (const c of credits) byNurse.set(c.nurseId, [...(byNurse.get(c.nurseId) ?? []), c]);
  return byNurse;
}

/**
 * The dates a period's leave is read over: the lookback tail (as the prior assignments)
 * plus the pay periods and work weeks that touch the period. Contracted-hours and pay-period
 * overtime credit paid leave over a whole pay period, which starts up to payPeriodDays-1 before
 * the period and ends as far after it, and cost prices overtime over the tail's own weeks and
 * pay periods; one pay period (at least a week) either side of the tail covers every one of
 * them. Nothing else (ledger, pending-leave, capacity, conflicts) looks at a request outside
 * the period itself. One definition, so validation, alerts, cost and Generate read the same rows.
 */
export function timeOffWindow(
  unit: Pick<Unit, 'payPeriodDays'>,
  period: Pick<SchedulePeriod, 'startDate' | 'endDate'>,
): { start: IsoDate; end: IsoDate } {
  const slack = Math.max(7, unit.payPeriodDays);
  return {
    start: addDays(period.startDate, -(PRIOR_ASSIGNMENT_LOOKBACK_DAYS + slack)),
    end: addDays(period.endDate, slack),
  };
}

/** Requests overlapping `timeOffWindow`, whole: a straddling request keeps its full paid-hours spread. */
export function timeOffForPeriod(
  db: DbLike,
  unit: Pick<Unit, 'payPeriodDays'>,
  period: SchedulePeriod,
) {
  const { start, end } = timeOffWindow(unit, period);
  return listTimeOffOverlappingForUnit(db, period.unitId, start, end);
}

/**
 * The unit's nurses for a period: the home roster, then nurses floated in from other units. The
 * order is behaviour (the solver samples by index), so floats only ever append, and a unit with
 * no memberships gets exactly `listNursesForUnit`.
 */
export function rosterForPeriod(
  db: DbLike,
  period: Pick<SchedulePeriod, 'unitId' | 'startDate' | 'endDate'>,
): Nurse[] {
  const { start, end } = elsewhereWindow(period);
  return [
    ...listNursesForUnit(db, period.unitId),
    ...listFloatNurses(db, period.unitId, start, end),
  ];
}

/**
 * What a floated-in nurse brings that the unit-scoped lists miss, because those join through the
 * nurse's home unit: their credentials (a float nurse would otherwise read as holding none),
 * preferences, and the leave requests their home unit approved. Empty with no floats.
 */
export function floatExtras(
  db: DbLike,
  unit: Pick<Unit, 'id' | 'payPeriodDays'>,
  period: SchedulePeriod,
  nurses: readonly Nurse[],
): {
  nurseCredentials: NurseCredential[];
  preferences: Preference[];
  timeOff: TimeOffRequest[];
} {
  const { start, end } = timeOffWindow(unit, period);
  const floats = nurses.filter((n) => n.unitId !== unit.id);
  return {
    nurseCredentials: floats.flatMap((n) => listNurseCredentials(db, n.id)),
    preferences: floats.flatMap((n) => listPreferencesForNurse(db, n.id)),
    timeOff: floats
      .flatMap((n) => listTimeOffForNurse(db, n.id))
      .filter((r) => compareDates(r.startDate, end) <= 0 && compareDates(r.endDate, start) >= 0),
  };
}

/** The other units' shifts for this period's nurses, over the period and its lookback tail. */
export function elsewhereForPeriod(db: DbLike, period: SchedulePeriod, nurses: readonly Nurse[]) {
  const { start, end } = elsewhereWindow(period);
  return busyElsewhereFor(
    db,
    period.unitId,
    nurses.map((n) => n.id),
    start,
    end,
  );
}

/** Shared loader behind the solver and the conflict detector: one definition of "the period". */
export function loadPeriodInput(db: DbLike, period: SchedulePeriod): SolveInput {
  const ruleSet = getRuleSet(db, period.ruleSetId);
  if (!ruleSet) throw new Error(`Period ${period.id} cites unknown rule set ${period.ruleSetId}`);
  const unitId = period.unitId;
  // Each table read once: the demand inputs carry the shift types, and the solver's cost data is
  // just the three pay tables (it takes unit, holidays and the work week from the input itself).
  const demand = demandInputs(db, unitId, period.startDate, period.endDate);
  const unit = unitOrThrow(db, unitId);
  const nurses = rosterForPeriod(db, period);
  const floats = floatExtras(db, unit, period, nurses);
  const elsewhere = elsewhereForPeriod(db, period, nurses);
  const timeOff = [...timeOffForPeriod(db, unit, period), ...floats.timeOff];
  return {
    unit,
    period,
    ruleSet,
    nurses,
    // Other units' shift types are inactive: demand, coverage and the solvers leave them alone.
    shiftTypes: [...demand.shiftTypes, ...elsewhere.shiftTypes],
    demand: deriveDemand(datesInRange(period.startDate, period.endDate), demand).all(),
    assignments: listAssignmentsForPeriod(db, period.id),
    // Other units' shifts ride with the lookback tail: judged by every nurse rule, never moved.
    priorAssignments: [
      ...priorAssignmentsBefore(db, unitId, period.startDate, PRIOR_ASSIGNMENT_LOOKBACK_DAYS),
      ...elsewhere.assignments,
    ],
    timeOff,
    // From the lookback tail on, as far as the weekly rules read.
    paidSickCalls: paidSickCallsForUnit(db, unitId, {
      start: addDays(period.startDate, -PRIOR_ASSIGNMENT_LOOKBACK_DAYS),
      end: period.endDate,
    }),
    credentials: listCredentials(db),
    nurseCredentials: [...listNurseCredentialsForUnit(db, unitId), ...floats.nurseCredentials],
    shiftCredentialRequirements: listShiftCredentialRequirementsForUnit(db, unitId),
    holidays: listHolidaysForUnit(db, unitId),
    holidayWork: holidayWorkForPeriod(db, period),
    preferences: [...listPreferencesForUnit(db, unitId), ...floats.preferences],
    ledgerHistory: ledgerHistory(db, unitId, period.startDate),
    // Only groups that can apply to this period (its first morning shares the night before),
    // so ending an unrelated group does not make Generate's candidates stale.
    incompatibilityGroups: groupsForPeriod(
      listIncompatibilityGroups(db, unitId),
      addDays(period.startDate, -1),
      period.endDate,
    ),
    // The lookback tail is judged too (its overtime counts toward the first week), so offers are
    // read from there on; one covering only other periods would make Generate's candidates stale.
    overtimeVolunteers: listOvertimeVolunteersOverlapping(
      db,
      unitId,
      addDays(period.startDate, -PRIOR_ASSIGNMENT_LOOKBACK_DAYS),
      period.endDate,
    ),
    // Judged over the lookback too, like the offers above: a preceptorship that ended inside it
    // still decides whether the first days of the period read as oriented.
    preceptorships: listPreceptorshipsOverlapping(
      db,
      unitId,
      addDays(period.startDate, -PRIOR_ASSIGNMENT_LOOKBACK_DAYS),
      period.endDate,
    ),
    restWaivers: restWaiversForPeriod(db, unitId, period.startDate, period.endDate),
    // A recurring window is judged against any date, so the whole unit's list is the input.
    availabilityBlocks: listAvailabilityBlocks(db, unitId),
    cost: {
      payRates: listPayRatesForUnit(db, unitId),
      differentials: listActiveDifferentials(db, unitId),
      overtimeRules: listActiveOvertimeRules(db, unitId),
    },
  };
}
