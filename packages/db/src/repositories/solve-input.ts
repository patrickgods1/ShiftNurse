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
  type PaidLeaveCredit,
  paidLeaveCredits,
  type RuleSet,
  type SchedulePeriod,
  type SolveInput,
  type Unit,
} from '@shiftnurse/core';
import type { DbLike } from '../client.js';
import { getHppdTarget, listActiveRatioRulesForUnit, listAcuityTiersForUnit } from './acuity.js';
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
import { listActiveDifferentials, listActiveOvertimeRules, listPayRatesForUnit } from './pay.js';
import {
  listCredentials,
  listNurseCredentialsForUnit,
  listNursesForUnit,
  listPreferencesForUnit,
} from './roster.js';
import { getRuleSet } from './rulesets.js';
import { listAssignmentsForPeriod, priorAssignmentsBefore } from './schedule.js';
import { listTimeOffForUnit, listTimeOffOverlappingForUnit } from './timeoff.js';

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
  return {
    shiftTypes: listShiftTypesForUnit(db, unitId),
    acuityTiers: listAcuityTiersForUnit(db, unitId),
    ratioRules: listActiveRatioRulesForUnit(db, unitId),
    coverageRequirements: listCoverageRequirementsForUnit(db, unitId),
    censusForecasts: listCensusForecastsInRange(db, unitId, start, end),
    hppdTarget: getHppdTarget(db, unitId),
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
  return {
    unit: unitOrThrow(db, unitId),
    payRates: listPayRatesForUnit(db, unitId),
    differentials: listActiveDifferentials(db, unitId),
    overtimeRules: listActiveOvertimeRules(db, unitId),
    holidayDates: new Set<IsoDate>(holidays.map((h) => h.date)),
    majorHolidayDates: new Set<IsoDate>(holidays.filter((h) => h.isMajor).map((h) => h.date)),
    weekendDefinition: ruleSet.weekendDefinition,
    workWeekStartsOn: params.workWeekStartsOn ?? maxHoursRule.defaultParams.workWeekStartsOn,
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
 * The dates a period's leave is read over: the 14-day lookback tail (as the prior assignments)
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
  return { start: addDays(period.startDate, -(14 + slack)), end: addDays(period.endDate, slack) };
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

/** Shared loader behind the solver and the conflict detector: one definition of "the period". */
export function loadPeriodInput(db: DbLike, period: SchedulePeriod): SolveInput {
  const ruleSet = getRuleSet(db, period.ruleSetId);
  if (!ruleSet) throw new Error(`Period ${period.id} cites unknown rule set ${period.ruleSetId}`);
  const unitId = period.unitId;
  // Each table read once: the demand inputs carry the shift types, and the solver's cost data is
  // just the three pay tables (it takes unit, holidays and the work week from the input itself).
  const demand = demandInputs(db, unitId, period.startDate, period.endDate);
  const unit = unitOrThrow(db, unitId);
  const timeOff = timeOffForPeriod(db, unit, period);
  return {
    unit,
    period,
    ruleSet,
    nurses: listNursesForUnit(db, unitId),
    shiftTypes: demand.shiftTypes,
    demand: deriveDemand(datesInRange(period.startDate, period.endDate), demand).all(),
    assignments: listAssignmentsForPeriod(db, period.id),
    priorAssignments: priorAssignmentsBefore(db, unitId, period.startDate, 14),
    timeOff,
    // From the lookback tail on, as far as the weekly rules read.
    paidSickCalls: paidSickCallsForUnit(db, unitId, {
      start: addDays(period.startDate, -14),
      end: period.endDate,
    }),
    credentials: listCredentials(db),
    nurseCredentials: listNurseCredentialsForUnit(db, unitId),
    shiftCredentialRequirements: listShiftCredentialRequirementsForUnit(db, unitId),
    holidays: listHolidaysForUnit(db, unitId),
    holidayWork: holidayWorkForPeriod(db, period),
    preferences: listPreferencesForUnit(db, unitId),
    ledgerHistory: ledgerHistory(db, unitId, period.startDate),
    // Only groups that can apply to this period (its first morning shares the night before),
    // so ending an unrelated group does not make Generate's candidates stale.
    incompatibilityGroups: groupsForPeriod(
      listIncompatibilityGroups(db, unitId),
      addDays(period.startDate, -1),
      period.endDate,
    ),
    cost: {
      payRates: listPayRatesForUnit(db, unitId),
      differentials: listActiveDifferentials(db, unitId),
      overtimeRules: listActiveOvertimeRules(db, unitId),
    },
  };
}
