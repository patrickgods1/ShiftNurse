/**
 * One definition of "the period" as the solver, the conflict detector and the cost report see it.
 *
 * Lived in the desktop main process until M15, when the solver benchmark needed the real demo
 * unit's `SolveInput` in plain Node; a second copy there would have been a second, drifting
 * definition of what the solver is given. It is only reads: mostly the repositories' own,
 * composed, plus the one query no repository owns, `periodTailFor`'s same-unit overlap.
 * `perNurseRecordsFor` is the only source of person-scoped records (credentials, leave, pay
 * rates and the rest), so a nurse floated in brings hers wherever every caller reads them.
 */

import {
  type Assignment,
  type AvailabilityBlock,
  addDays,
  type BusyElsewhere,
  busyElsewhere,
  type CostContext,
  compareDates,
  dateInRange,
  datesInRange,
  deriveDemand,
  type FairnessLedgerEntry,
  floatedOff,
  groupsForPeriod,
  type HolidayWorkRecord,
  historyCompleteFrom,
  type Id,
  type IsoDate,
  isFloatedOff,
  type MaxHoursParams,
  maxHoursRule,
  type Nurse,
  type NurseCredential,
  type PaidLeaveCredit,
  type PaidSickCall,
  type PayRate,
  type Preference,
  paidLeaveCredits,
  type RestWaiver,
  type RuleSet,
  type SchedulePeriod,
  type ShiftType,
  type SolveInput,
  type TimeOffRequest,
  type Unit,
} from '@shiftnurse/core';
import { and, asc, eq, gte, inArray, lte, ne } from 'drizzle-orm';
import type { DbLike } from '../client.js';
import { dstTransitionsForPeriod } from '../host-dst.js';
import { toAssignment } from '../mappers.js';
import { assignment, schedulePeriod } from '../schema.js';
import { getHppdTarget, listActiveRatioRulesForUnit, listAcuityTiersForUnit } from './acuity.js';
import { availabilityBlocksElsewhere, listAvailabilityBlocks } from './availability-blocks.js';
import { paidSickCallsElsewhere, paidSickCallsForUnit } from './calloffs.js';
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
  listPayRatesForNurses,
  listPayRatesForUnit,
} from './pay.js';
import { listPreceptorshipsOverlapping } from './preceptorships.js';
import { restWaiversElsewhere, restWaiversForPeriod } from './rest-waivers.js';
import {
  listCredentials,
  listNurseCredentials,
  listNurseCredentialsForUnit,
  listNursesForUnit,
  listPreferencesForNurse,
  listPreferencesForUnit,
} from './roster.js';
import { getRuleSet } from './rulesets.js';
import {
  listAssignmentsForPeriod,
  listPeriodsForUnit,
  priorAssignmentsBefore,
} from './schedule.js';
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

/**
 * The first date from which the lookback tail is complete: the same published and archived
 * periods `priorAssignmentsBefore` reads, so the date says exactly how far that tail is complete;
 * archiving a pay period must not turn it into a gap. The
 * contracted-hours rule judges a pay period that began before the period only from here; without
 * it a gap in history would read as a nurse who worked nothing.
 */
export function historyFromFor(
  db: DbLike,
  period: Pick<SchedulePeriod, 'unitId' | 'startDate'>,
): IsoDate {
  return historyCompleteFrom(
    listPeriodsForUnit(db, period.unitId).filter((p) => p.status !== 'draft'),
    period.startDate,
    PRIOR_ASSIGNMENT_LOOKBACK_DAYS,
  );
}

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
  const unit = unitOrThrow(db, unitId);
  // A priced period prices its whole roster, floats included, at their own rates and leave.
  const records = period
    ? perNurseRecordsFor(db, unit, period, rosterForPeriod(db, period))
    : undefined;
  return {
    unit,
    payRates: records ? records.payRates : listPayRatesForUnit(db, unitId),
    differentials: listActiveDifferentials(db, unitId),
    overtimeRules: listActiveOvertimeRules(db, unitId),
    holidayDates: new Set<IsoDate>(holidays.map((h) => h.date)),
    majorHolidayDates: new Set<IsoDate>(holidays.filter((h) => h.isMajor).map((h) => h.date)),
    weekendDefinition: ruleSet.weekendDefinition,
    workWeekStartsOn: params.workWeekStartsOn ?? maxHoursRule.defaultParams.workWeekStartsOn,
    premiumStacking: pay.premiumStacking,
    holidayPayCoversOvertime: pay.holidayPayCoversOvertime,
    overtimeWindowAttribution: pay.overtimeWindowAttribution,
    ...(period
      ? { dstTransitions: dstTransitionsForPeriod(period, PRIOR_ASSIGNMENT_LOOKBACK_DAYS) }
      : {}),
    ...(params.paidLeaveCountsTowardOvertime
      ? {
          overtimeLeave: records
            ? overtimeLeave(records.timeOff, records.paidSickCalls)
            : overtimeLeave(listTimeOffForUnit(db, unitId), paidSickCallsForUnit(db, unitId)),
        }
      : {}),
  };
}

/** Paid leave by nurse, for a contract that counts it toward overtime. */
function overtimeLeave(timeOff: readonly TimeOffRequest[], paidSickCalls: readonly PaidSickCall[]) {
  const byNurse = new Map<Id, PaidLeaveCredit[]>();
  const credits = paidLeaveCredits(timeOff, paidSickCalls);
  for (const c of credits) {
    const list = byNurse.get(c.nurseId);
    if (list) list.push(c);
    else byNurse.set(c.nurseId, [c]);
  }
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

/** What each nurse brings wherever they work, read for this period's roster. */
export interface PerNurseRecords {
  nurseCredentials: NurseCredential[];
  preferences: Preference[];
  timeOff: TimeOffRequest[];
  paidSickCalls: PaidSickCall[];
  restWaivers: RestWaiver[];
  availabilityBlocks: AvailabilityBlock[];
  payRates: PayRate[];
}

/**
 * The single source of person-scoped records for a period: the rows this unit's loaders read
 * today, in today's order, then what the roster brings from elsewhere. A unit nobody floats to,
 * whose nurses have nothing recorded on another unit, reads exactly as before.
 *
 * Every unit-scoped read joins through the nurse's home unit (or the unit a row was recorded
 * on), so without the brought part a floated-in nurse's accommodation, rate, waiver and sick
 * pay would never reach Generate, the grid, cost or alerts here. Home parts come first and
 * unchanged because the solver samples by index; the brought parts only append.
 */
export function perNurseRecordsFor(
  db: DbLike,
  unit: Pick<Unit, 'id' | 'payPeriodDays'>,
  period: SchedulePeriod,
  nurses: readonly Nurse[],
): PerNurseRecords {
  const floats = nurses.filter((n) => n.unitId !== unit.id);
  const ids = nurses.map((n) => n.id);
  // From the lookback tail on, as far as the weekly rules read.
  const tail = elsewhereWindow(period);
  const leave = timeOffWindow(unit, period);
  return {
    nurseCredentials: [
      ...listNurseCredentialsForUnit(db, unit.id),
      ...floats.flatMap((n) => listNurseCredentials(db, n.id)),
    ],
    preferences: [
      ...listPreferencesForUnit(db, unit.id),
      ...floats.flatMap((n) => listPreferencesForNurse(db, n.id)),
    ],
    timeOff: [
      ...timeOffForPeriod(db, unit, period),
      ...floats
        .flatMap((n) => listTimeOffForNurse(db, n.id))
        .filter(
          (r) =>
            compareDates(r.startDate, leave.end) <= 0 && compareDates(r.endDate, leave.start) >= 0,
        ),
    ],
    paidSickCalls: [
      ...paidSickCallsForUnit(db, unit.id, tail),
      ...paidSickCallsElsewhere(db, unit.id, ids, tail),
    ],
    restWaivers: [
      ...restWaiversForPeriod(db, unit.id, period.startDate, period.endDate),
      ...restWaiversElsewhere(db, unit.id, ids, period.startDate, period.endDate),
    ],
    // A recurring window is judged against any date, so every block is the input, not a range.
    availabilityBlocks: [
      ...listAvailabilityBlocks(db, unit.id),
      ...availabilityBlocksElsewhere(db, unit.id, ids),
    ],
    payRates: [
      ...listPayRatesForUnit(db, unit.id),
      ...listPayRatesForNurses(
        db,
        floats.map((n) => n.id),
      ),
    ],
  };
}

/**
 * Everything a period is judged against but does not own: its own unit's published and archived
 * shifts before it (real shift types) and inside it on other periods (as busy time), and other
 * units' shifts over the tail and the period (as busy time). The one loader of a period's tail,
 * so Generate and the grid judge a period against the same rows.
 */
export function periodTailFor(
  db: DbLike,
  period: SchedulePeriod,
  nurses: readonly Nurse[],
): { priorAssignments: Assignment[]; shiftTypes: ShiftType[] } {
  const nurseIds = nurses.map((n) => n.id);
  const overlap = sameUnitOverlap(db, period, nurseIds);
  const { start, end } = elsewhereWindow(period);
  const elsewhere = busyElsewhereFor(db, period.unitId, nurseIds, start, end);
  const before = priorAssignmentsBefore(
    db,
    period.unitId,
    period.startDate,
    PRIOR_ASSIGNMENT_LOOKBACK_DAYS,
  );
  // A night floated off the day before would otherwise read, on its real type, as this unit's
  // cover carried into the first morning. Each is swapped for its copy in place, so the tail
  // keeps its order and a tail with no floats is exactly as before.
  const floated = before.some(isFloatedOff)
    ? floatedOff(before.filter(isFloatedOff), listShiftTypesForUnit(db, period.unitId))
    : undefined;
  const copyById = new Map(floated?.assignments.map((a) => [a.id, a]));
  return {
    priorAssignments: [
      ...before.map((a) => copyById.get(a.id) ?? a),
      ...overlap.assignments,
      ...elsewhere.assignments,
    ],
    shiftTypes: uniqueById([
      ...overlap.shiftTypes,
      ...elsewhere.shiftTypes,
      ...(floated?.shiftTypes ?? []),
    ]),
  };
}

/**
 * A period's rows as rules judge them (D20): this unit's own, and floated-off shifts as busy time.
 */
export function splitFloatedOff(
  rows: readonly Assignment[],
  shiftTypes: readonly ShiftType[],
): { onUnit: Assignment[]; busy: BusyElsewhere } {
  return {
    onUnit: rows.filter((a) => !isFloatedOff(a)),
    busy: floatedOff(rows.filter(isFloatedOff), shiftTypes),
  };
}

/** First of each id kept: a copy type met twice (tail and period) is one type. */
export function uniqueById<T extends { id: Id }>(items: readonly T[]): T[] {
  const seen = new Set<Id>();
  const out: T[] = [];
  for (const t of items) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

/**
 * This unit's posted shifts on other periods dated inside this one: a draft laid over a published
 * period. Without them Generate could put a nurse on a night before the day they are already
 * posted to work, and validation would not see the turnaround. They go through `busyElsewhere`
 * rather than keep their real types: those are active, and an active locked row inside the
 * horizon would count as this period's staffing in coverage, cost and the CP-SAT encoder. Drafts
 * stay out for `priorAssignmentsBefore`'s reason; rows dated before the period already arrive
 * there with their real types.
 */
function sameUnitOverlap(db: DbLike, period: SchedulePeriod, nurseIds: readonly Id[]) {
  if (nurseIds.length === 0) return { shiftTypes: [], assignments: [] };
  const rows = db
    .select({ row: assignment })
    .from(assignment)
    .innerJoin(schedulePeriod, eq(assignment.periodId, schedulePeriod.id))
    .where(
      and(
        eq(schedulePeriod.unitId, period.unitId),
        ne(schedulePeriod.id, period.id),
        inArray(schedulePeriod.status, ['published', 'archived']),
        gte(assignment.date, period.startDate),
        lte(assignment.date, period.endDate),
        inArray(assignment.nurseId, [...nurseIds]),
      ),
    )
    .orderBy(asc(assignment.date), asc(assignment.id))
    .all()
    .map((r) => toAssignment(r.row));
  return busyElsewhere(
    rows,
    listShiftTypesForUnit(db, period.unitId),
    `another ${unitOrThrow(db, period.unitId).name} schedule`,
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
  const pay = getPaySettings(db, unitId);
  const nurses = rosterForPeriod(db, period);
  const records = perNurseRecordsFor(db, unit, period, nurses);
  const tail = periodTailFor(db, period, nurses);
  // A floated-off shift is never this unit's own row (SA and CP-SAT count locked in-period rows
  // on the floor); it rides with the tail as her busy time.
  const split = splitFloatedOff(listAssignmentsForPeriod(db, period.id), demand.shiftTypes);
  return {
    unit,
    period,
    ruleSet,
    nurses,
    // Busy-time shift types are inactive: demand, coverage and the solvers leave them alone.
    shiftTypes: uniqueById([...demand.shiftTypes, ...tail.shiftTypes, ...split.busy.shiftTypes]),
    demand: deriveDemand(datesInRange(period.startDate, period.endDate), demand).all(),
    assignments: split.onUnit,
    // Busy time rides with the lookback tail: judged by every nurse rule, never moved.
    priorAssignments: [...tail.priorAssignments, ...split.busy.assignments],
    historyFrom: historyFromFor(db, period),
    timeOff: records.timeOff,
    paidSickCalls: records.paidSickCalls,
    credentials: listCredentials(db),
    nurseCredentials: records.nurseCredentials,
    shiftCredentialRequirements: listShiftCredentialRequirementsForUnit(db, unitId),
    holidays: listHolidaysForUnit(db, unitId),
    holidayWork: holidayWorkForPeriod(db, period),
    preferences: records.preferences,
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
    restWaivers: records.restWaivers,
    availabilityBlocks: records.availabilityBlocks,
    dstTransitions: dstTransitionsForPeriod(period, PRIOR_ASSIGNMENT_LOOKBACK_DAYS),
    cost: {
      payRates: records.payRates,
      differentials: listActiveDifferentials(db, unitId),
      overtimeRules: listActiveOvertimeRules(db, unitId),
      premiumStacking: pay.premiumStacking,
      holidayPayCoversOvertime: pay.holidayPayCoversOvertime,
      overtimeWindowAttribution: pay.overtimeWindowAttribution,
    },
  };
}
