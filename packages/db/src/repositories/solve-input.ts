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
  datesInRange,
  deriveDemand,
  type FairnessLedgerEntry,
  type Id,
  type IsoDate,
  type MaxHoursParams,
  maxHoursRule,
  type RuleSet,
  type SchedulePeriod,
  type SolveInput,
} from '@shiftnurse/core';
import type { DbLike } from '../client.js';
import { listCensusForecastsInRange } from './census.js';
import {
  getHppdTarget,
  getRuleSet,
  getUnit,
  listActiveRatioRulesForUnit,
  listAcuityTiersForUnit,
  listCoverageRequirementsForUnit,
  listHolidaysForUnit,
  listShiftCredentialRequirementsForUnit,
  listShiftTypesForUnit,
} from './config.js';
import {
  ledgerSince,
  listActiveDifferentials,
  listActiveOvertimeRules,
  listPayRatesForUnit,
} from './operations.js';
import {
  listCredentials,
  listNurseCredentialsForUnit,
  listNursesForUnit,
  listPreferencesForUnit,
} from './roster.js';
import { listAssignmentsForPeriod, priorAssignmentsBefore } from './schedule.js';
import { listTimeOffForUnit } from './timeoff.js';

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
export function costContext(db: DbLike, unitId: Id, ruleSet: RuleSet): CostContext {
  const maxHours = ruleSet.configs.find((c) => c.ruleId === maxHoursRule.id);
  const params = (maxHours?.params ?? maxHoursRule.defaultParams) as Partial<MaxHoursParams>;
  return {
    unit: unitOrThrow(db, unitId),
    payRates: listPayRatesForUnit(db, unitId),
    differentials: listActiveDifferentials(db, unitId),
    overtimeRules: listActiveOvertimeRules(db, unitId),
    holidayDates: new Set<IsoDate>(listHolidaysForUnit(db, unitId).map((h) => h.date)),
    weekendDefinition: ruleSet.weekendDefinition,
    workWeekStartsOn: params.workWeekStartsOn ?? maxHoursRule.defaultParams.workWeekStartsOn,
  };
}

/** Shared loader behind the solver and the conflict detector: one definition of "the period". */
export function loadPeriodInput(db: DbLike, period: SchedulePeriod): SolveInput {
  const ruleSet = getRuleSet(db, period.ruleSetId);
  if (!ruleSet) throw new Error(`Period ${period.id} cites unknown rule set ${period.ruleSetId}`);
  const unitId = period.unitId;
  // Each table read once: the demand inputs carry the shift types, and the solver's cost data is
  // just the three pay tables (it takes unit, holidays and the work week from the input itself).
  const demand = demandInputs(db, unitId, period.startDate, period.endDate);
  return {
    unit: unitOrThrow(db, unitId),
    period,
    ruleSet,
    nurses: listNursesForUnit(db, unitId),
    shiftTypes: demand.shiftTypes,
    demand: deriveDemand(datesInRange(period.startDate, period.endDate), demand).all(),
    assignments: listAssignmentsForPeriod(db, period.id),
    priorAssignments: priorAssignmentsBefore(db, unitId, period.startDate, 14),
    timeOff: listTimeOffForUnit(db, unitId),
    credentials: listCredentials(db),
    nurseCredentials: listNurseCredentialsForUnit(db, unitId),
    shiftCredentialRequirements: listShiftCredentialRequirementsForUnit(db, unitId),
    holidays: listHolidaysForUnit(db, unitId),
    preferences: listPreferencesForUnit(db, unitId),
    ledgerHistory: ledgerHistory(db, unitId, period.startDate),
    cost: {
      payRates: listPayRatesForUnit(db, unitId),
      differentials: listActiveDifferentials(db, unitId),
      overtimeRules: listActiveOvertimeRules(db, unitId),
    },
  };
}
