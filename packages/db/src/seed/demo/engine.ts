/**
 * The realistic-demo engine: builds a unit, its roster, rules, pay and six months of history from
 * a `DemoProfile` — the facts of one kind of real unit — so each demo in the welcome screen's list
 * differs in what real units differ in (shift pattern, skill mix, ratios, pay rules, holidays,
 * contract limits) while sharing one scheduler.
 *
 * Nothing here is planted: the rigged dataset with known, asserted problems is `scenarios.ts`.
 *
 * ## The history is staffed the way a staffing office would
 *
 * Each pay period is planned in memory, balanced, then posted:
 *
 * - **Legal first.** Every placement passes `canWork`, which mirrors the rules the app enforces
 *   on the unit's own rule set: rest between shift windows, consecutive-day and all-night stretch
 *   limits, days off after a maximum stretch, approved leave (including a night ending on its
 *   first morning), and nobody before their hire date.
 * - **To the forecast.** Floors are raised to the ratio need of the *forecast* census — what the
 *   rule engine judges a period by — and of the actual one when the day ran busier.
 * - **Asked in order.** Contracted staff short of their hours, then per-diem, then contracted staff
 *   catching up on a pay period, and overtime last. Targets above the floor go only to contracted
 *   staff behind on their hours, so they do not spend hours later floors need.
 * - **Balanced before posting.** Shifts move from anyone past their contract to anyone short,
 *   wherever the move is legal — the pass a scheduler makes before posting.
 *
 * - **Kept apart.** Staff the profile keeps apart (`keptApart`) are never put on the floor
 *   together once their group applies — separated, as a real ward separates them, by tour.
 *
 * - **Capped weekends.** Where the unit's weekend-pattern rule is on, `canWork` enforces its run and
 *   per-window limits, and the history is planned so each half of the staff works alternate
 *   weekends (see `weekendHold` and the top-up pass).
 * - **Overtime by agreement.** Where `no-mandatory-overtime` is on, overtime is asked of
 *   volunteers (`createOvertimeVolunteer`) only.
 *
 * - **Removals checked too.** A shift moved away or called off must not leave its nurse in an
 *   illegal stretch (`canRemove`): taking the day off "day, night, night, night, night" leaves
 *   four nights.
 *
 * Leave requests carry the paid hours of the shifts they cover and are denied when too many of a
 * role are already off; staff call-offs (about two a week) are paid from sick leave. Both count
 * toward contracted hours, so a vacation comes off the nurse's target for the period and its
 * shifts go to the per-diem pool, then to overtime. A nurse at contract who picks up a call-off
 * still reads "over contract" — the rule counts any hours past it — so a few past pay periods
 * show that, as they would on a real unit.
 *
 * Every random choice comes from a seeded `Rng`: same profile, seed and date, same database.
 */

import {
  type AcuityTier,
  type Assignment,
  addDays,
  type CostContext,
  compareDates,
  containingDate,
  costSchedule,
  coveringShift,
  datesInRange,
  daysBetween,
  defaultRuleSet,
  type EmploymentType,
  groupInForce,
  type Id,
  type IncompatibilityGroup,
  type IsoDate,
  isWeekendDate,
  type JurisdictionId,
  type LeaveBalanceType,
  type Nurse,
  type NurseRole,
  nursesRequiredForMix,
  type OvertimeRule,
  type Preceptorship,
  type Preference,
  type RatioRule,
  type RatioStaffing,
  Rng,
  type RuleConfig,
  restMinutesBetween,
  ScheduleView,
  type ShiftType,
  shiftWindow,
  suggestedPaidLeaveHours,
  today,
  usFederalHolidays,
  type Weekday,
  type WeekendDefinition,
  weekdayOf,
  weekendKey,
  windowEndDate,
  windowsOverlap,
} from '@shiftnurse/core';
import type { ShiftNurseTx } from '../../client.js';
import { ids } from '../../ids.js';
import { createAcuityTier, createRatioRule, upsertHppdTarget } from '../../repositories/acuity.js';
import {
  logCallAttempt,
  markCallOffCovered,
  markCallOffUncovered,
  reportCallOff,
} from '../../repositories/calloffs.js';
import { recordActualCensus, upsertCensusForecast } from '../../repositories/census.js';
import {
  createShiftCredentialRequirement,
  createShiftType,
  createUnit,
  upsertCoverageRequirement,
} from '../../repositories/config.js';
import { recordHoldover } from '../../repositories/holdovers.js';
import { createHoliday } from '../../repositories/holidays.js';
import { createIncompatibilityGroup } from '../../repositories/incompatibility.js';
import { createFmlaCertification, setLeaveBalance } from '../../repositories/leave-balances.js';
import {
  closeLeaveBidRound,
  createLeaveBidRound,
  submitLeaveBid,
} from '../../repositories/leave-bidding.js';
import {
  importFairnessLedgerEntries,
  type UpsertFairnessLedgerInput,
} from '../../repositories/ledger.js';
import { createNurseUnit } from '../../repositories/nurse-units.js';
import { createOvertimeVolunteer } from '../../repositories/overtime-volunteers.js';
import {
  createDifferential,
  createOvertimeRule,
  createPayRate,
  type DifferentialInput,
  listActiveDifferentials,
  listActiveOvertimeRules,
  listPayRatesForUnit,
  setBudget,
} from '../../repositories/pay.js';
import { createPreceptorship } from '../../repositories/preceptorships.js';
import {
  createNurse,
  grantCredential,
  replaceNursePreferences,
} from '../../repositories/roster.js';
import { createCredential } from '../../repositories/roster-io.js';
import { getLatestRuleSet, saveRuleSet } from '../../repositories/rulesets.js';
import {
  createAssignment,
  createPeriod,
  deleteAssignment,
  publishPeriod,
} from '../../repositories/schedule.js';
import { applyJurisdiction } from '../../repositories/setup.js';
import { approveTimeOff, createTimeOffRequest, denyTimeOff } from '../../repositories/timeoff.js';
import type { SeedOptions, SeedResult } from '../types.js';

const ACTOR = 'demo-seed';

// ---------------------------------------------------------------------------
// The profile: everything that differs between one real unit and another
// ---------------------------------------------------------------------------

export interface DemoShift {
  code: string;
  name: string;
  startTime: string;
  durationHours: number;
  /**
   * Drives the all-night stretch limit and the fairness night count, and the night differential
   * where it is not priced by the clock (a differential with a `window` ignores this flag).
   */
  isNight: boolean;
  color: string;
  /** Census difference from the day tour: patients discharged before this shift starts. */
  censusDelta: number;
  /**
   * The code of the shift this one runs inside, which covers it: charge nurse, ACLS and new-grad
   * cover come from whoever is on that shift. Listed after it.
   */
  within?: string;
}

export interface DemoRosterRow {
  role: NurseRole;
  employmentType: EmploymentType;
  fte: number;
  contractedHoursPerPeriod: number;
  /** The shift code this position is hired to work, or `flex` for per-diem staff. */
  position: string;
  /**
   * A shorter shift this position works a set number of times each pay period on top of its
   * home shifts: six 12s and one 8 make 80 hours. Its hours are held back for it, so the home
   * shifts stop where the pattern needs them to.
   */
  shortShift?: { code: string; perPayPeriod: number };
  count: number;
  /** How many of these are new graduates in their first year (RN rows only). */
  newGrads?: number;
}

export interface DemoPayInput {
  role: NurseRole;
  employmentType: EmploymentType;
  /** Whole years of service. */
  years: number;
  isChargeEligible: boolean;
}

/**
 * Staff the manager keeps off the floor together. One member is drawn from each slot, never a
 * charge nurse or a new grad (a unit cannot afford to lose either to a separation). Dates are
 * days from the next schedule's first day; negative is the past.
 */
export interface DemoKeptApart {
  name: string;
  reason: string;
  maxTogether: number;
  members: readonly { role: NurseRole; position: string }[];
  startsIn: number;
  endsIn?: number;
}

export interface DemoLeaveBalances {
  /**
   * The balance vacation is kept in, and the type of the vacation requests that draw on it:
   * `pto` for a private hospital, `annual` for federal staff.
   */
  vacationType: LeaveBalanceType;
  /** The most vacation leave a full-time employee of the role carries into a leave year. */
  carryoverCapHours: (role: NurseRole) => number;
  /** Hours earned each pay period by a full-time employee; part-time staff earn it pro rata. */
  accrual: (input: { role: NurseRole; years: number }) => { annual: number; sick: number };
}

/** Days are from the next schedule's first day; negative is the past. */
export interface DemoFmla {
  note: string;
  intermittent: boolean;
  startsIn: number;
  endsIn: number;
}

export interface DemoPreceptorship {
  /** The position the orientee and preceptor are hired to; the orientee is one of its new grads. */
  position: string;
  /** The orientee's hire date, in days from the next schedule's first day (negative: before). */
  hiredIn: number;
  weeks: number;
}

export interface DemoFloatUnit {
  name: string;
  unitType: string;
  /** Codes of the profile's shifts the sibling unit works. */
  shifts: readonly string[];
  competency: string;
  /** Experienced RNs and LVNs who hold a membership. */
  rns: number;
  lpns: number;
}

export interface DemoLeaveBid {
  /** `MM-DD` in the year the schedule starts in. */
  opens: string;
  closes: string;
  offPerDay: Partial<Record<NurseRole, number>>;
  maxAwardsPerNurse: number;
  /** The share of full- and part-time staff who submit a bid. */
  share: number;
  /** Each bid is one to this many one-week choices. */
  maxChoices: number;
}

export interface DemoProfile {
  id: string;
  unit: { name: string; unitType: string; ratioStaffing?: RatioStaffing };
  /** Weeks in the upcoming schedule. */
  scheduleWeeks: number;
  /**
   * Any known pay-period start. The next schedule starts at the next pay-period start on this
   * cycle; without one, next Sunday.
   */
  payPeriodCycle?: IsoDate;
  shifts: readonly DemoShift[];
  roster: readonly DemoRosterRow[];
  /** Charge-eligible RNs to appoint per position, most senior first. */
  chargeNurses: Readonly<Record<string, number>>;
  floors: Readonly<Record<string, Partial<Record<NurseRole, { min: number; target: number }>>>>;
  census: {
    beds: number;
    minimum: number;
    /** Day-tour census by weekday, Sunday first. */
    weekday: readonly [number, number, number, number, number, number, number];
    /** Adjustment by month, January first. */
    seasonal: readonly number[];
  };
  /** Acuity tiers, lowest first; `share` is the fraction of patients at each tier above the first. */
  tiers: readonly { name: string; careHoursPerPatientDay: number; share: number }[];
  /** Patient-per-nurse ceilings by tier level. Empty where no ratio law or plan applies. */
  ratios: readonly { role: NurseRole; tierLevel: number; max: number; citation: string }[];
  hppdTarget: number;
  credentials: {
    /** ACLS nurses required on every shift. */
    aclsPerShift: number;
    /** Every RN holds ACLS (critical care), rather than charge nurses and about half the rest. */
    aclsForAllRNs: boolean;
    /** Extra specialty certifications, held by a share of experienced RNs. */
    specialty?: { code: string; name: string; share: number };
  };
  pay: {
    roleDefault: Partial<Record<NurseRole, number>>;
    rate: (input: DemoPayInput) => number;
    /** The yearly pay adjustment: effective with the first pay period of `month` (1–12). */
    raise: { month: number; percent: number };
  };
  differentials: readonly Omit<DifferentialInput, 'unitId' | 'active'>[];
  overtime: readonly Omit<OvertimeRule, 'id' | 'unitId' | 'active'>[];
  /** `hospital-six`: the six most US hospitals pay premium on; `federal`: all eleven. */
  holidays: 'hospital-six' | 'federal';
  /**
   * A state or federal preset (`setup.ts`), applied right after the rule set is saved and before
   * any period, so every published period snapshots the version the preset produced.
   */
  jurisdiction?: JurisdictionId;
  rules: {
    weekend: WeekendDefinition;
    /** Rule ids that are off by default and switched on for this unit (params below apply). */
    enable?: readonly string[];
    /** Parameter overrides by rule id, merged over the registry defaults. */
    params?: Readonly<Record<string, Record<string, unknown>>>;
  };
  keptApart?: readonly DemoKeptApart[];
  /**
   * Leave balances for the full- and part-time staff. Seeded only where set: the draws come after
   * everything else, so the other demos' data is unchanged.
   */
  leaveBalances?: DemoLeaveBalances;
  /**
   * Give some long-serving staff a hire date later than their seniority date: seniority credited
   * under the contract from an earlier facility, with employment here beginning later. Chosen by
   * staff index, not drawn, so no later draw moves.
   */
  bridgedService?: boolean;
  /** FMLA certifications on distinct staff (never a charge nurse or a new grad). */
  fmla?: readonly DemoFmla[];
  /** Orientations of new grads, each with an experienced full-time preceptor on their position. */
  preceptorships?: readonly DemoPreceptorship[];
  /** A sibling unit some staff are members of, to float to. It never has a roster of its own. */
  floatUnit?: DemoFloatUnit;
  /** A leave-year bid round for the year after the schedule's, bid on by about half the staff. */
  annualLeaveBid?: DemoLeaveBid;
  /**
   * Volunteered holdovers in the published history, one per entry, minutes past the end of a
   * tour of `shift`. Placed by a scan, not drawn, so no later draw moves.
   */
  holdovers?: readonly DemoHoldover[];
}

export interface DemoHoldover {
  shift: string;
  minutes: number;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

const FIRST_NAMES = [
  'Maria',
  'James',
  'Aisha',
  'David',
  'Priya',
  'Michael',
  'Jennifer',
  'Luis',
  'Grace',
  'Kevin',
  'Keisha',
  'Samuel',
  'Chioma',
  'Elena',
  'Marcus',
  'Hannah',
  'Omar',
  'Sofia',
  'Tyler',
  'Amara',
  'Rafael',
  'Jessica',
  'Kwame',
  'Leila',
  'Brian',
  'Yuki',
  'Nadia',
  'Diego',
  'Megan',
  'Arjun',
  'Beatriz',
  'Caleb',
  'Danielle',
  'Emeka',
  'Rachel',
  'Gabriel',
  'Hiroshi',
  'Isabel',
  'Jordan',
  'Kavya',
  'Lorenzo',
  'Mei',
  'Nicole',
  'Andre',
  'Tiffany',
  'Victor',
  'Ashley',
  'Mateo',
  'Lauren',
  'Tomas',
  'Brittany',
  'Imani',
  'Connor',
  'Rosa',
  'Ethan',
  'Fatima',
  'Stephanie',
  'Jamal',
  'Olivia',
  'Minh',
  'Carlos',
  'Denise',
  'Reggie',
  'Angela',
  'Marisol',
  'Terrence',
];
const LAST_NAMES = [
  'Johnson',
  'Nguyen',
  'Garcia',
  'Okafor',
  'Chen',
  'Williams',
  'Patel',
  'Rodriguez',
  'Brown',
  'Kim',
  'Martinez',
  'Davis',
  'Haddad',
  'Lopez',
  'Wilson',
  'Mensah',
  'Anderson',
  'Thomas',
  'Hernandez',
  'Moore',
  'Jackson',
  'Martin',
  'Lee',
  'Thompson',
  'White',
  'Harris',
  'Sanchez',
  'Clark',
  'Ramirez',
  'Lewis',
  'Robinson',
  'Walker',
  'Young',
  'Allen',
  'Reyes',
  'Wright',
  'Scott',
  'Torres',
  'Hill',
  'Flores',
  'Green',
  'Adams',
  'Nelson',
  'Baker',
  'Hall',
  'Rivera',
  'Campbell',
  'Mitchell',
  'Carter',
  'Roberts',
  'Phillips',
  'Evans',
  'Turner',
  'Diaz',
  'Parker',
  'Cruz',
  'Edwards',
  'Collins',
  'Stewart',
  'Morris',
  'Bautista',
  'Tran',
  'Washington',
  'Santos',
  'Aguilar',
  'Fong',
];

const OFFICE_HOLIDAYS = new Set([
  "New Year's Day",
  'Memorial Day',
  'Independence Day',
  'Labor Day',
  'Thanksgiving Day',
  'Christmas Day',
]);

// ---------------------------------------------------------------------------
// Scheduling state
// ---------------------------------------------------------------------------

interface Staff {
  nurse: Nurse;
  position: string;
  /** Which alternate weekend this nurse works. */
  weekendGroup: 0 | 1;
  /**
   * Hours a pay period the contract (or a per-diem commitment) calls for. Counted in hours, not
   * shifts, so a pattern of mixed lengths (six 12s and an 8) comes out right.
   */
  targetHours: number;
  /** The length of the shift this person is hired to work, which a day of paid leave pays. */
  shiftHours: number;
  /** The row's short shift, resolved, if the position works one. */
  shortShift?: { shift: ShiftType; perPayPeriod: number };
  /** Contracted hours a week: past this a shift is a catch-up or an overtime pick-up. */
  weeklyHours: number;
  years: number;
}

interface Limits {
  /** The time-off rule's calendar-day option: a shift into leave's first morning counts. */
  nightIntoLeave: boolean;
  minRestMinutes: number;
  maxRun: number;
  maxNights: number;
  minDaysOff: number;
  /**
   * Orientations, where the profile has them: an orientee works only on a shift their preceptor is
   * on, or the one it runs inside, which is what the rule judges.
   */
  orientation?: {
    byOrientee: ReadonlyMap<Id, readonly Preceptorship[]>;
    shiftsById: ReadonlyMap<Id, ShiftType>;
  };
  /** The weekend-pattern rule, when enabled: weekends are counted per schedule-length window. */
  weekends?: {
    definition: WeekendDefinition;
    maxConsecutive: number;
    /** Absent: no per-window limit. */
    maxPerWindow?: number;
    windowDays: number;
    windowAnchor: IsoDate;
  };
}

/** A shift planned for a pay period, before the period is posted. */
interface PlannedShift {
  staff: Staff;
  date: IsoDate;
  shift: ShiftType;
  isCharge: boolean;
}

/** What each person works on each date. */
type Worked = Map<Id, Map<IsoDate, ShiftType>>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type PreferenceDraft = DistributiveOmit<Preference, 'id' | 'nurseId'>;

const round2 = (n: number) => Math.round(n * 100) / 100;

function numberParam(
  configs: readonly RuleConfig[],
  ruleId: string,
  key: string,
  fallback: number,
): number {
  const value = configs.find((c) => c.ruleId === ruleId)?.params?.[key];
  return typeof value === 'number' ? value : fallback;
}

/**
 * Could this person take `shift` on `date` without breaking a rule the unit's rule set
 * enforces? Looks both ways: a call-off replacement lands inside a schedule already built.
 */
function canWork(
  worked: Worked,
  staff: Staff,
  date: IsoDate,
  shift: ShiftType,
  leave: ReadonlySet<string>,
  limits: Limits,
  apart: readonly IncompatibilityGroup[],
  lend = false,
): boolean {
  const id = staff.nurse.id;
  if (compareDates(date, staff.nurse.seniorityDate) < 0) return false; // Not hired yet.
  const mine = worked.get(id)!;
  if (mine.has(date) || leave.has(`${id}|${date}`)) return false;
  const window = shiftWindow(date, shift);
  if (breaksApart(worked, id, date, window, apart)) return false;
  // Leave belongs to the shifts dated in it. Only where the rule set makes a day off a whole
  // calendar day does a shift running into leave's first morning count too.
  if (limits.nightIntoLeave) {
    const endDate = windowEndDate(window);
    if (endDate !== date && leave.has(`${id}|${endDate}`)) return false;
  }
  // Rest between this shift and the ones either side.
  for (const offset of [-1, 1]) {
    const other = mine.get(addDays(date, offset));
    if (!other) continue;
    const rest = restMinutesBetween(window, shiftWindow(addDays(date, offset), other));
    if (rest < limits.minRestMinutes) return false;
  }
  // The stretch this shift would sit in.
  let first = date;
  while (mine.has(addDays(first, -1))) first = addDays(first, -1);
  let last = date;
  while (mine.has(addDays(last, 1))) last = addDays(last, 1);
  const length = daysBetween(first, last) + 1;
  if (length > limits.maxRun) return false;
  const days = datesInRange(first, last);
  const nightly = days.every((d) => (d === date ? shift : mine.get(d)!).isNight);
  if (nightly && length > limits.maxNights) return false;
  // Days off after a maximum-length stretch, on whichever side of this one it falls: fewer than
  // `minDaysOff` clear days between the two stretches is a violation.
  const stretchEndingAt = (d: IsoDate) => {
    let n = 0;
    for (let x = d; mine.has(x); x = addDays(x, -1)) n++;
    return n;
  };
  for (let daysOff = 1; daysOff < limits.minDaysOff; daysOff++) {
    // A long stretch before this one, too close.
    if (stretchEndingAt(addDays(first, -daysOff - 1)) >= limits.maxRun) {
      const between = datesInRange(addDays(first, -daysOff), addDays(first, -1));
      if (between.every((d) => !mine.has(d))) return false;
    }
    // This one is long, and the next starts too soon.
    if (length >= limits.maxRun && mine.has(addDays(last, daysOff + 1))) return false;
  }
  if (limits.orientation) {
    const preceptors = (limits.orientation.byOrientee.get(id) ?? []).filter(
      (p) => compareDates(date, p.startDate) >= 0 && compareDates(date, p.endDate) <= 0,
    );
    if (preceptors.length > 0) {
      const cover = coveringShift(shift, date, limits.orientation.shiftsById);
      const withThem = preceptors.some((p) => {
        const theirs = worked.get(p.preceptorId)!;
        return theirs.get(date) === shift || (cover && theirs.get(cover.date) === cover.shiftType);
      });
      // No preceptor yet means not yet: the preceptor is placed first.
      if (!withThem) return false;
    }
  }
  if (limits.weekends) {
    if (breaksWeekends(mine, date, shift, limits.weekends)) return false;
    // Each half works its own alternate weekends. A nurse lent to the other half's weekend has
    // used one of their two, so their own then runs short: only the intermittent pool lends.
    const key = weekendKey(shiftWindow(date, shift), limits.weekends.definition) as IsoDate | null;
    if (key !== null && staff.position !== 'flex') {
      const parity = weekendParity(limits.weekends.windowAnchor, key);
      if (parity !== staff.weekendGroup && !lend) return false;
    }
  }
  return true;
}

/** Which half of the staff works the weekend keyed `key`: alternate weekends from the anchor. */
function weekendParity(anchor: IsoDate, key: IsoDate): 0 | 1 {
  // Keys before the anchor give a negative remainder (or -0), hence the abs.
  return Math.abs(Math.floor(daysBetween(anchor, key) / 7) % 2) as 0 | 1;
}

/** Whether the nurse works any shift of the weekend keyed `k` (Friday night to Sunday). */
function weekendWorked(
  mine: ReadonlyMap<IsoDate, ShiftType>,
  k: IsoDate,
  definition: WeekendDefinition,
): boolean {
  return [-1, 0, 1].some((offset) => {
    const d = addDays(k, offset);
    const s = mine.get(d);
    return s !== undefined && weekendKey(shiftWindow(d, s), definition) === k;
  });
}

/**
 * Would this shift give the nurse more weekends than the weekend-pattern rule allows: too many in
 * a row, or too many in the schedule-length window it falls in? A weekend already worked adds no
 * new one. A weekend's shifts are dated the Friday (a night running in) to the Sunday.
 */
function breaksWeekends(
  mine: ReadonlyMap<IsoDate, ShiftType>,
  date: IsoDate,
  shift: ShiftType,
  w: NonNullable<Limits['weekends']>,
): boolean {
  const key = weekendKey(shiftWindow(date, shift), w.definition) as IsoDate | null;
  if (key === null) return false;
  const workedBefore = (k: IsoDate) => weekendWorked(mine, k, w.definition);
  if (workedBefore(key)) return false;
  const worked = (k: IsoDate) => k === key || workedBefore(k);
  let run = 1;
  for (let k = addDays(key, -7); worked(k); k = addDays(k, -7)) run++;
  for (let k = addDays(key, 7); worked(k); k = addDays(k, 7)) run++;
  if (run > w.maxConsecutive) return true;
  if (w.maxPerWindow === undefined) return false;
  // "Two in four" counts weekends by their key, four to a window. The rule also judges each
  // published pay period alone, and a Sunday's tour belongs to the weekend before it, so a pay
  // period touches three weekends: at most `maxPerWindow` of those, counted by the shifts dated in it.
  const windowOf = (k: IsoDate) => Math.floor(daysBetween(w.windowAnchor, k) / w.windowDays);
  let inWindow = 1;
  for (let j = -3; j <= 3; j++) {
    const other = addDays(key, 7 * j);
    if (j !== 0 && windowOf(other) === windowOf(key) && workedBefore(other)) inWindow++;
  }
  if (inWindow > w.maxPerWindow) return true;
  const from = addDays(w.windowAnchor, Math.floor(daysBetween(w.windowAnchor, date) / 14) * 14);
  const keys = new Set<string>([key]);
  for (const d of datesInRange(from, addDays(from, 13))) {
    const s = mine.get(d);
    const k = s && weekendKey(shiftWindow(d, s), w.definition);
    if (k) keys.add(k);
  }
  return keys.size > w.maxPerWindow;
}

/**
 * Would this shift put the person on the floor with more of a group they are kept apart from
 * than it allows? Counts every member whose shift overlaps any of this one's hours, which is
 * exact for a cap of one and errs on the safe side above it.
 */
function breaksApart(
  worked: Worked,
  id: Id,
  date: IsoDate,
  window: ReturnType<typeof shiftWindow>,
  apart: readonly IncompatibilityGroup[],
): boolean {
  for (const group of apart) {
    if (!group.nurseIds.includes(id) || !groupInForce(group, date)) continue;
    let together = 1;
    for (const other of group.nurseIds) {
      if (other === id) continue;
      const theirs = worked.get(other)!;
      const overlaps = [-1, 0, 1].some((offset) => {
        const d = addDays(date, offset);
        const s = theirs.get(d);
        return (
          s !== undefined && groupInForce(group, d) && windowsOverlap(window, shiftWindow(d, s))
        );
      });
      if (overlaps) together++;
    }
    if (together > group.maxTogether) return true;
  }
  return false;
}

/**
 * Could this person's shift on `date` come off the schedule without breaking a rule? Removal
 * only shortens stretches, but the consecutive-nights limit counts all-night stretches, so
 * taking the day off the front of "day, night, night, night, night" leaves four nights.
 */
function canRemove(worked: Worked, staff: Staff, date: IsoDate, limits: Limits): boolean {
  const mine = worked.get(staff.nurse.id)!;
  // The stretch left on each side, counted only if it is all nights.
  const allNights = (d: IsoDate, step: number) => {
    let n = 0;
    for (let x = d; mine.has(x); x = addDays(x, step)) {
      if (!mine.get(x)!.isNight) return 0;
      n++;
    }
    return n;
  };
  return (
    allNights(addDays(date, -1), -1) <= limits.maxNights &&
    allNights(addDays(date, 1), 1) <= limits.maxNights
  );
}

function hoursBetween(worked: Worked, staff: Staff, start: IsoDate, end: IsoDate): number {
  const mine = worked.get(staff.nurse.id)!;
  let hours = 0;
  for (const d of datesInRange(start, end)) hours += mine.get(d)?.durationHours ?? 0;
  return hours;
}

function hoursInWeek(worked: Worked, staff: Staff, date: IsoDate): number {
  const weekStart = addDays(date, -weekdayOf(date));
  const mine = worked.get(staff.nurse.id)!;
  let hours = 0;
  for (let i = 0; i < 7; i++) hours += mine.get(addDays(weekStart, i))?.durationHours ?? 0;
  return hours;
}

// ---------------------------------------------------------------------------
// The seeder
// ---------------------------------------------------------------------------

/**
 * Build the whole unit. Call inside a transaction: a half-seeded database is worse than an empty
 * one.
 */
export function seedFromProfile(
  db: ShiftNurseTx,
  profile: DemoProfile,
  options: SeedOptions = {},
): SeedResult {
  const rng = new Rng(options.seed ?? 20260926);
  const now = options.today ?? today();
  const historyPeriods = options.historyPeriods ?? 13; // six months of two-week pay periods
  const counts: Record<string, number> = {};
  const bump = (key: string, by = 1) => {
    counts[key] = (counts[key] ?? 0) + by;
  };

  // --- Calendar -------------------------------------------------------------------------------
  let draftStart = addDays(now, (7 - weekdayOf(now)) % 7 || 7);
  if (profile.payPeriodCycle) {
    const offset = ((daysBetween(profile.payPeriodCycle, draftStart) % 14) + 14) % 14;
    if (offset !== 0) draftStart = addDays(draftStart, 14 - offset);
  }
  const draftEnd = addDays(draftStart, profile.scheduleWeeks * 7 - 1);
  const historyStart = addDays(draftStart, -14 * historyPeriods);

  const unit = createUnit(
    db,
    { ...profile.unit, payPeriodDays: 14, payPeriodAnchor: historyStart },
    ACTOR,
  );
  bump('unit');

  // --- Shifts ---------------------------------------------------------------------------------
  const shifts: ShiftType[] = [];
  for (const [i, spec] of profile.shifts.entries()) {
    const within = spec.within ? shifts.find((x) => x.abbreviation === spec.within)!.id : null;
    shifts.push(
      createShiftType(
        db,
        {
          unitId: unit.id,
          name: spec.name,
          abbreviation: spec.code,
          startTime: spec.startTime,
          durationHours: spec.durationHours,
          isNight: spec.isNight,
          isOnCall: false,
          color: spec.color,
          sortOrder: i + 1,
          active: true,
          withinShiftTypeId: within,
        },
        ACTOR,
      ),
    );
  }
  bump('shiftType', shifts.length);
  const shiftByCode = new Map(shifts.map((s) => [s.abbreviation, s]));
  const shiftById = new Map(shifts.map((s) => [s.id, s]));
  /** Container id → the shifts running inside it. */
  const innerShifts = new Map<Id, ShiftType[]>();
  for (const s of shifts) {
    if (s.withinShiftTypeId === null) continue;
    innerShifts.set(s.withinShiftTypeId, [...(innerShifts.get(s.withinShiftTypeId) ?? []), s]);
  }
  const specOf = (s: ShiftType) => profile.shifts.find((x) => x.code === s.abbreviation)!;

  // --- Credentials ----------------------------------------------------------------------------
  const BLS = createCredential(
    db,
    { code: 'BLS', name: 'Basic Life Support', tracksExpiry: true },
    ACTOR,
  );
  const ACLS = createCredential(
    db,
    { code: 'ACLS', name: 'Advanced Cardiac Life Support', tracksExpiry: true },
    ACTOR,
  );
  const PRECEPTOR = createCredential(
    db,
    { code: 'PRECEPTOR', name: 'Preceptor', tracksExpiry: false },
    ACTOR,
  );
  const SPECIALTY = profile.credentials.specialty
    ? createCredential(
        db,
        {
          code: profile.credentials.specialty.code,
          name: profile.credentials.specialty.name,
          tracksExpiry: true,
        },
        ACTOR,
      )
    : undefined;
  bump('credential', SPECIALTY ? 4 : 3);
  for (const shift of shifts) {
    createShiftCredentialRequirement(
      db,
      {
        unitId: unit.id,
        shiftTypeId: shift.id,
        role: 'RN',
        credentialId: ACLS.id,
        minCount: profile.credentials.aclsPerShift,
      },
      ACTOR,
    );
    bump('shiftCredentialRequirement');
  }

  // --- Acuity, ratios, HPPD -------------------------------------------------------------------
  const tiers: AcuityTier[] = profile.tiers.map((t, i) =>
    createAcuityTier(
      db,
      {
        unitId: unit.id,
        name: t.name,
        level: i + 1,
        careHoursPerPatientDay: t.careHoursPerPatientDay,
      },
      ACTOR,
    ),
  );
  bump('acuityTier', tiers.length);
  const ratioRules: RatioRule[] = profile.ratios.map((r) =>
    createRatioRule(
      db,
      {
        unitId: unit.id,
        role: r.role,
        acuityTierId: tiers[r.tierLevel - 1]!.id,
        maxPatientsPerNurse: r.max,
        citation: r.citation,
        active: true,
      },
      ACTOR,
    ),
  );
  bump('ratioRule', ratioRules.length);
  upsertHppdTarget(db, unit.id, profile.hppdTarget, ACTOR);
  bump('hppdTarget');

  // --- Staffing floors ------------------------------------------------------------------------
  for (const wd of [0, 1, 2, 3, 4, 5, 6] as Weekday[]) {
    for (const shift of shifts) {
      for (const [role, floor] of Object.entries(profile.floors[shift.abbreviation] ?? {})) {
        upsertCoverageRequirement(
          db,
          {
            unitId: unit.id,
            shiftTypeId: shift.id,
            weekday: wd,
            date: null,
            role: role as NurseRole,
            minCount: floor.min,
            targetCount: floor.target,
          },
          ACTOR,
        );
        bump('coverageRequirement');
      }
    }
  }

  // --- Holidays -------------------------------------------------------------------------------
  const holidayDates = new Set<IsoDate>();
  const lastYear = Number(draftEnd.slice(0, 4)) + 1;
  for (let year = Number(historyStart.slice(0, 4)); year <= lastYear; year++) {
    for (const holiday of usFederalHolidays(year)) {
      if (profile.holidays === 'hospital-six' && !OFFICE_HOLIDAYS.has(holiday.name)) continue;
      createHoliday(db, { unitId: unit.id, ...holiday }, ACTOR);
      holidayDates.add(holiday.date);
      bump('holiday');
    }
  }

  // --- Rules ----------------------------------------------------------------------------------
  const base = defaultRuleSet(unit.id);
  const baseConfigs = base.configs.map((c) => ({
    ...c,
    ...(profile.rules.enable?.includes(c.ruleId) ? { enabled: true } : {}),
    params: { ...c.params, ...(profile.rules.params?.[c.ruleId] ?? {}) },
  }));
  const saved = saveRuleSet(
    db,
    {
      unitId: unit.id,
      name: base.name,
      configs: baseConfigs,
      weekendDefinition: profile.rules.weekend,
      fairnessWeights: base.fairnessWeights,
    },
    ACTOR,
  );
  bump('ruleSet');
  // The preset saves a newer version; everything below reads what is actually in force.
  let ruleSet = saved;
  let configs: readonly RuleConfig[] = baseConfigs;
  // The preset plans against the rules already in force and adds only what is missing.
  for (const d of profile.differentials) {
    createDifferential(db, { unitId: unit.id, ...d, active: true }, ACTOR);
    bump('differential');
  }
  for (const o of profile.overtime) {
    createOvertimeRule(db, { unitId: unit.id, ...o, active: true }, ACTOR);
    bump('overtimeRule');
  }
  if (profile.jurisdiction) {
    applyJurisdiction(db, unit.id, profile.jurisdiction, ACTOR);
    ruleSet = getLatestRuleSet(db, unit.id)!;
    configs = ruleSet.configs;
  }
  const nightIntoLeave = configs.find((c) => c.ruleId === 'approved-time-off-is-absolute')?.params
    ?.nightShiftEndingOnLeaveCounts;
  const limits: Limits = {
    nightIntoLeave: nightIntoLeave === true,
    minRestMinutes: 60 * numberParam(configs, 'min-rest-between-shifts', 'minRestHours', 10),
    maxRun: numberParam(configs, 'max-consecutive-shifts', 'maxConsecutiveShifts', 5),
    maxNights: numberParam(configs, 'max-consecutive-shifts', 'maxConsecutiveNights', 3),
    minDaysOff: numberParam(configs, 'max-consecutive-shifts', 'minDaysOffAfterMaxStretch', 2),
  };
  const weekendRule = configs.find((c) => c.ruleId === 'weekend-pattern');
  if (weekendRule?.enabled) {
    const perWindow = weekendRule.params.maxWeekendsPerPeriod;
    limits.weekends = {
      definition: ruleSet.weekendDefinition,
      maxConsecutive: numberParam(configs, 'weekend-pattern', 'maxConsecutiveWeekends', 1),
      ...(typeof perWindow === 'number' ? { maxPerWindow: perWindow } : {}),
      windowDays: profile.scheduleWeeks * 7,
      windowAnchor: draftStart,
    };
  }
  const noMandatoryOvertime = configs.find((c) => c.ruleId === 'no-mandatory-overtime');
  // Where the rule set judges overtime over the pay period, a history period (one pay period)
  // is overtime past its threshold rather than a week past forty.
  const overtimeByPayPeriod =
    configs.find((c) => c.ruleId === 'max-hours-per-week')?.params?.overtimeByPayPeriod === true;
  const overtimeThreshold = overtimeByPayPeriod
    ? numberParam(configs, 'max-hours-per-week', 'payPeriodOvertimeThresholdHours', 80)
    : 40;

  // --- Staff ----------------------------------------------------------------------------------
  // Planned in full before anyone is created: who is charge-eligible depends on the seniority
  // order of their whole position.
  interface Planned {
    row: DemoRosterRow;
    k: number;
    years: number;
    newGrad: boolean;
    charge: boolean;
  }
  const planned: Planned[] = [];
  for (const row of profile.roster) {
    for (let k = 0; k < row.count; k++) {
      const newGrad = k >= row.count - (row.newGrads ?? 0);
      const years = newGrad
        ? rng.nextInt(2, 11) / 12
        : rng.weightedPick([
            { value: rng.nextInt(1, 2), weight: 3 },
            { value: rng.nextInt(3, 7), weight: 4 },
            { value: rng.nextInt(8, 15), weight: 3 },
            { value: rng.nextInt(16, 30), weight: 1 },
          ]);
      planned.push({ row, k, years, newGrad, charge: false });
    }
  }
  for (const [position, needed] of Object.entries(profile.chargeNurses)) {
    const senior = planned
      .filter(
        (p) =>
          p.row.role === 'RN' &&
          p.row.position === position &&
          p.row.employmentType !== 'agency' &&
          p.row.employmentType !== 'per_diem' &&
          !p.newGrad &&
          p.years >= 3,
      )
      .sort((a, b) => b.years - a.years)
      .slice(0, needed);
    for (const p of senior) p.charge = true;
  }

  const firstNames = rng.shuffle(FIRST_NAMES);
  const lastNames = rng.shuffle(LAST_NAMES);
  if (planned.length > FIRST_NAMES.length) throw new Error('Demo roster is larger than its names');
  // Each orientation takes the next new grad of its position and sets their hire date, which an
  // orientation starts on. The hire date is not drawn, so the draws below are the same.
  const orientations = (profile.preceptorships ?? []).map((spec) => ({
    spec,
    orientee: undefined as Staff | undefined,
  }));
  const staff: Staff[] = planned.map((p, index) => {
    const { row } = p;
    const traveler = row.employmentType === 'agency';
    const orientation = p.newGrad
      ? orientations.find((o) => !o.orientee && o.spec.position === row.position)
      : undefined;
    // Unit seniority is the hire date. A traveler's is the start of their current contract,
    // which began before the history did (they are on an extension).
    const drawnSeniority = traveler
      ? addDays(historyStart, -rng.nextInt(10, 40))
      : addDays(now, -Math.round(p.years * 365) - rng.nextInt(0, 60));
    const seniorityDate = orientation
      ? addDays(draftStart, orientation.spec.hiredIn)
      : drawnSeniority;
    // About one in six of the 6+ year employees has seniority credited from an earlier facility,
    // their employment here beginning two to four years later. Always before the history, so
    // staffing is unaffected.
    const bridged =
      profile.bridgedService === true &&
      !traveler &&
      !orientation &&
      row.employmentType !== 'per_diem' &&
      p.years >= 6 &&
      index % 6 === 0;
    const first = firstNames[index]!;
    const last = lastNames[index]!;
    const nurse = createNurse(
      db,
      {
        unitId: unit.id,
        employeeId: String(204100 + index * 7 + rng.nextInt(0, 6)),
        firstName: first,
        lastName: last,
        role: row.role,
        employmentType: row.employmentType,
        fte: row.fte,
        contractedHoursPerPeriod: row.contractedHoursPerPeriod,
        seniorityDate,
        ...(bridged ? { hireDate: addDays(seniorityDate, 365 * (2 + (index % 3))) } : {}),
        isChargeEligible: p.charge,
        isNovice: p.newGrad,
        isFloatEligible: !p.newGrad && !traveler && rng.chance(0.4),
        phone: `555-01${String(index).padStart(2, '0')}`,
        email: `${first}.${last}@example.org`.toLowerCase(),
        active: true,
      },
      ACTOR,
    );
    bump('nurse');
    const home = shiftByCode.get(row.position);
    const shiftHours = home?.durationHours ?? shifts[0]!.durationHours;
    const short = row.shortShift
      ? { shift: shiftByCode.get(row.shortShift.code)!, perPayPeriod: row.shortShift.perPayPeriod }
      : undefined;
    // The long week of a mixed pattern: three 12s and the 8 is 44 hours, the short week 36.
    const shortWeek = short ? (short.shift.durationHours * short.perPayPeriod) / 2 : 0;
    const member: Staff = {
      nurse,
      position: row.position,
      weekendGroup: (p.k % 2) as 0 | 1,
      // A per-diem nurse typically works two or three shifts a week when the unit needs them.
      shiftHours,
      ...(short ? { shortShift: short } : {}),
      targetHours:
        row.contractedHoursPerPeriod > 0
          ? row.contractedHoursPerPeriod
          : Math.round(72 / shiftHours) * shiftHours,
      weeklyHours:
        row.contractedHoursPerPeriod > 0 ? row.contractedHoursPerPeriod / 2 + shortWeek : 36,
      years: p.years,
    };
    if (orientation) orientation.orientee = member;
    return member;
  });
  counts.chargeEligible = staff.filter((s) => s.nurse.isChargeEligible).length;
  if (limits.weekends) {
    // Two weekends in four, a pay period at a time, comes to alternate weekends for everyone, so
    // each weekend is staffed by one half. The halves must each hold charge nurses, and each role
    // on each tour, or a weekend that falls to the short half runs without them.
    const seen = new Map<string, number>();
    for (const s of staff) {
      const group = `${s.nurse.role}|${s.position}|${s.nurse.isChargeEligible}`;
      const n = seen.get(group) ?? 0;
      seen.set(group, n + 1);
      s.weekendGroup = (n % 2) as 0 | 1;
    }
  }

  // --- Credentials per person -----------------------------------------------------------------
  // Two-year cards renewed at random points: expiry is uniform over the next two years.
  const card = (days = 730) => addDays(now, rng.nextInt(10, days));
  const preceptorHolders = new Set<Id>();
  for (const s of staff) {
    const grant = (credentialId: Id, expiresOn?: IsoDate) => {
      grantCredential(db, { nurseId: s.nurse.id, credentialId, expiresOn }, ACTOR);
      bump('nurseCredential');
    };
    grant(BLS.id, card());
    const rn = s.nurse.role === 'RN';
    const acls =
      rn &&
      (profile.credentials.aclsForAllRNs ||
        s.nurse.isChargeEligible ||
        s.nurse.employmentType === 'agency' ||
        rng.chance(0.5));
    if (acls) grant(ACLS.id, card());
    if (rn && s.years >= 3 && s.nurse.employmentType !== 'agency' && rng.chance(0.45)) {
      grant(PRECEPTOR.id);
      preceptorHolders.add(s.nurse.id);
    }
    if (SPECIALTY && rn && s.years >= 2 && rng.chance(profile.credentials.specialty!.share)) {
      grant(SPECIALTY.id, card(3 * 365));
    }
  }

  // --- Preferences ----------------------------------------------------------------------------
  const dayShift = shifts.find((s) => !s.isNight)!;
  for (const s of staff) {
    const prefs: Preference[] = [];
    const add = (p: PreferenceDraft) =>
      prefs.push({ ...p, id: ids.preference(), nurseId: s.nurse.id } as Preference);
    const home = shiftByCode.get(s.position);
    if (home?.isNight) add({ kind: 'prefer_shift_type', shiftTypeId: home.id, weight: 4 });
    if (home && !home.isNight) {
      for (const off of shifts.filter((x) => x.isNight)) {
        add({ kind: 'avoid_shift_type', shiftTypeId: off.id, weight: 5 });
      }
    }
    // Most people would rather not work weekends; a few (students, second jobs) prefer them.
    add({
      kind: 'weekend_appetite',
      level: rng.weightedPick([
        { value: -1, weight: 6 },
        { value: 0, weight: 3 },
        { value: 1, weight: 1 },
      ]),
      weight: rng.nextInt(1, 3),
    });
    if (rng.chance(0.5)) {
      const block = dayShift.durationHours >= 12 ? rng.pick([2, 3, 3]) : rng.pick([4, 5, 5]);
      add({ kind: 'preferred_block_length', shifts: block, weight: 2 });
    }
    if (rng.chance(0.2)) {
      add({ kind: 'avoid_weekday', weekday: rng.pick([1, 2, 3, 4, 5]) as Weekday, weight: 2 });
    }
    replaceNursePreferences(db, s.nurse.id, prefs, ACTOR);
    bump('preference', prefs.length);
  }

  // --- Staff kept apart -----------------------------------------------------------------------
  const apart: IncompatibilityGroup[] = [];
  const inGroup = new Set<Id>();
  for (const spec of profile.keptApart ?? []) {
    const nurseIds = spec.members.map(({ role, position }) => {
      const pool = staff.filter(
        (s) =>
          s.nurse.role === role &&
          s.position === position &&
          !s.nurse.isChargeEligible &&
          !s.nurse.isNovice &&
          !inGroup.has(s.nurse.id),
      );
      if (pool.length === 0) throw new Error(`No ${role} on ${position} left to keep apart`);
      const chosen = rng.pick(pool).nurse.id;
      inGroup.add(chosen);
      return chosen;
    });
    apart.push(
      createIncompatibilityGroup(
        db,
        {
          unitId: unit.id,
          name: spec.name,
          nurseIds,
          maxTogether: spec.maxTogether,
          startsOn: addDays(draftStart, spec.startsIn),
          ...(spec.endsIn !== undefined ? { endsOn: addDays(draftStart, spec.endsIn) } : {}),
        },
        spec.reason,
        ACTOR,
      ),
    );
    bump('incompatibilityGroup');
  }

  // --- Overtime volunteers --------------------------------------------------------------------
  // Where overtime needs the nurse's agreement, about a third of the staff have offered, with a
  // standing offer over the whole history and the draft. Draws only here, so units without the
  // rule keep their data.
  const volunteers = new Set<Id>();
  if (noMandatoryOvertime?.enabled) {
    for (const s of staff) {
      const { employmentType: type } = s.nurse;
      if (type !== 'full_time' && type !== 'part_time') continue;
      if (!rng.chance(1 / 3)) continue;
      createOvertimeVolunteer(
        db,
        {
          unitId: unit.id,
          nurseId: s.nurse.id,
          startDate: historyStart,
          endDate: draftEnd,
          note: 'Standing offer to pick up extra shifts',
        },
        ACTOR,
      );
      volunteers.add(s.nurse.id);
      bump('overtimeVolunteer');
    }
  }

  // --- Orientation ----------------------------------------------------------------------------
  // Chosen by seniority, not drawn, so the draws stay as they were. The preceptor is on the
  // orientee's half of the weekends, or the orientee could never work a weekend with them.
  if (orientations.length > 0) {
    const taken = new Set<Id>();
    const byOrientee = new Map<Id, Preceptorship[]>();
    for (const { spec, orientee } of orientations) {
      if (!orientee) throw new Error(`No new grad on ${spec.position} to orient`);
      const candidates = staff
        .filter(
          (s) =>
            s.nurse.role === 'RN' &&
            s.nurse.employmentType === 'full_time' &&
            s.position === spec.position &&
            !s.nurse.isNovice &&
            !s.nurse.isChargeEligible &&
            !inGroup.has(s.nurse.id) &&
            !taken.has(s.nurse.id) &&
            s.weekendGroup === orientee.weekendGroup,
        )
        .sort(
          (a, b) =>
            Number(preceptorHolders.has(b.nurse.id)) - Number(preceptorHolders.has(a.nurse.id)) ||
            b.years - a.years,
        );
      const preceptor = candidates[0];
      if (!preceptor) throw new Error(`No preceptor on ${spec.position} for the orientee`);
      taken.add(preceptor.nurse.id);
      if (!preceptorHolders.has(preceptor.nurse.id)) {
        grantCredential(db, { nurseId: preceptor.nurse.id, credentialId: PRECEPTOR.id }, ACTOR);
        bump('nurseCredential');
      }
      const record = createPreceptorship(
        db,
        {
          unitId: unit.id,
          orienteeId: orientee.nurse.id,
          preceptorId: preceptor.nurse.id,
          startDate: orientee.nurse.seniorityDate,
          endDate: addDays(orientee.nurse.seniorityDate, spec.weeks * 7 - 1),
        },
        ACTOR,
      );
      byOrientee.set(orientee.nurse.id, [record]);
      bump('preceptorship');
    }
    limits.orientation = { byOrientee, shiftsById: shiftById };
  }

  // --- Pay ------------------------------------------------------------------------------------
  const rateStart = addDays(historyStart, -365);
  const raiseMonth = String(profile.pay.raise.month).padStart(2, '0');
  const raiseDate = datesInRange(historyStart, draftEnd).find(
    (d) => d.slice(5, 7) === raiseMonth && daysBetween(historyStart, d) % 14 === 0,
  );
  const raised = (rate: number) => round2(rate * (1 + profile.pay.raise.percent / 100));
  const rate = (nurseId: Id | null, role: NurseRole | null, hourlyRate: number, from: IsoDate) => {
    createPayRate(db, { nurseId, role, hourlyRate, effectiveFrom: from }, ACTOR);
    bump('payRate');
  };
  for (const [role, amount] of Object.entries(profile.pay.roleDefault)) {
    rate(null, role as NurseRole, amount, rateStart);
    if (raiseDate) rate(null, role as NurseRole, raised(amount), raiseDate);
  }
  for (const s of staff) {
    const traveler = s.nurse.employmentType === 'agency';
    const amount = round2(
      profile.pay.rate({
        role: s.nurse.role,
        employmentType: s.nurse.employmentType,
        years: Math.floor(s.years),
        isChargeEligible: s.nurse.isChargeEligible,
      }),
    );
    rate(s.nurse.id, null, amount, traveler ? s.nurse.seniorityDate : rateStart);
    if (raiseDate && !traveler) rate(s.nurse.id, null, raised(amount), raiseDate);
  }

  // --- Census ---------------------------------------------------------------------------------
  const mixFor = (census: number): Record<Id, number> => {
    const mix: Record<Id, number> = {};
    let rest = census;
    for (let i = tiers.length - 1; i >= 1; i--) {
      const n = Math.round(census * profile.tiers[i]!.share);
      mix[tiers[i]!.id] = n;
      rest -= n;
    }
    mix[tiers[0]!.id] = rest;
    return mix;
  };
  const clamp = (n: number) => Math.max(profile.census.minimum, Math.min(profile.census.beds, n));
  const baseCensus = (date: IsoDate) =>
    profile.census.weekday[weekdayOf(date)]! +
    (profile.census.seasonal[Number(date.slice(5, 7)) - 1] ?? 0);
  /** Every acuity mix a shift is judged or staffed by: the forecast, then what happened. */
  const forecast = (date: IsoDate, shift: ShiftType, withActual: boolean) => {
    const projected = clamp(baseCensus(date) + specOf(shift).censusDelta + rng.nextInt(-1, 1));
    const row = upsertCensusForecast(
      db,
      {
        unitId: unit.id,
        date,
        shiftTypeId: shift.id,
        projectedCensus: projected,
        acuityMix: mixFor(projected),
        source: 'forecast',
      },
      ACTOR,
    );
    bump('censusForecast');
    if (!withActual) return [row.acuityMix];
    const census = clamp(projected + rng.nextInt(-2, 2));
    const mix = mixFor(census);
    // Acuity drifts from the model: now and then a patient is sicker than expected.
    if (tiers.length > 1) {
      const sicker = Math.min(mix[tiers[0]!.id]!, rng.nextInt(0, 1));
      mix[tiers[0]!.id] = mix[tiers[0]!.id]! - sicker;
      mix[tiers[1]!.id] = mix[tiers[1]!.id]! + sicker;
    }
    recordActualCensus(db, row.id, census, mix, ACTOR);
    return [row.acuityMix, mix];
  };

  // --- Leave ----------------------------------------------------------------------------------
  // Decided before the history is staffed, as it would have been: approved leave keeps the nurse
  // off the schedule. A request is denied when too many of the same role are already off.
  const leave = new Set<string>();
  /** Paid leave hours by nurse and date, once approved: they count toward the contract. */
  const leavePaid = new Map<string, number>();
  const offByRoleDate = new Map<string, number>();
  const offLimit = (role: NurseRole) =>
    Math.max(1, Math.floor(staff.filter((s) => s.nurse.role === role).length / 10));
  // Vacation is drawn from the balance the profile keeps it in, as payroll would.
  const vacationType = profile.leaveBalances?.vacationType ?? 'pto';
  const requestLeave = (
    s: Staff,
    startDate: IsoDate,
    endDate: IsoDate,
    type: LeaveBalanceType | 'education',
    reason: string,
    decision: 'decide' | 'approve' | 'pending',
  ) => {
    const days = datesInRange(startDate, endDate).length;
    // Paid as the shifts the nurse would have worked over those days.
    const paidHours = suggestedPaidLeaveHours({
      type,
      days,
      contractedHoursPerPeriod: s.nurse.contractedHoursPerPeriod,
      payPeriodDays: 14,
      shiftHours: s.shiftHours,
    });
    const request = createTimeOffRequest(
      db,
      { nurseId: s.nurse.id, startDate, endDate, type, reason, paidHours },
      ACTOR,
    );
    bump('timeOffRequest');
    if (decision === 'pending') {
      bump('timeOffPending');
      return;
    }
    const dates = datesInRange(startDate, endDate);
    const key = (d: IsoDate) => `${s.nurse.role}|${d}`;
    const full = dates.some((d) => (offByRoleDate.get(key(d)) ?? 0) >= offLimit(s.nurse.role));
    if (decision === 'decide' && full) {
      denyTimeOff(db, request.id, ACTOR, 'Too many staff already approved off on those dates');
      bump('timeOffDenied');
      return;
    }
    approveTimeOff(db, request.id, ACTOR);
    bump('timeOffApproved');
    for (const d of dates) {
      leave.add(`${s.nurse.id}|${d}`);
      leavePaid.set(`${s.nurse.id}|${d}`, paidHours / dates.length);
      offByRoleDate.set(key(d), (offByRoleDate.get(key(d)) ?? 0) + 1);
    }
  };
  const employees = staff.filter(
    (s) => s.nurse.employmentType === 'full_time' || s.nurse.employmentType === 'part_time',
  );
  for (const s of employees) {
    for (let r = rng.nextInt(1, 3); r > 0; r--) {
      const startDate = addDays(historyStart, rng.nextInt(0, 14 * historyPeriods - 5));
      if (compareDates(startDate, s.nurse.seniorityDate) < 0) continue; // Before they were hired.
      if (rng.chance(0.1)) {
        requestLeave(s, startDate, startDate, 'education', 'Continuing education', 'decide');
      } else {
        const reason = rng.pick(['Vacation', 'Family event', 'Appointment', 'Personal']);
        requestLeave(
          s,
          startDate,
          addDays(startDate, rng.nextInt(0, 4)),
          vacationType,
          reason,
          'decide',
        );
      }
    }
  }

  // --- History --------------------------------------------------------------------------------
  const worked: Worked = new Map(staff.map((s) => [s.nurse.id, new Map()]));
  const rows = new Map<Id, Assignment>();
  const costContext: CostContext = {
    unit,
    payRates: listPayRatesForUnit(db, unit.id),
    differentials: listActiveDifferentials(db, unit.id),
    overtimeRules: listActiveOvertimeRules(db, unit.id),
    holidayDates,
    weekendDefinition: ruleSet.weekendDefinition,
    workWeekStartsOn: 0,
  };
  const ledgerInputs: UpsertFairnessLedgerInput[] = [];
  const historyCosts: number[] = [];
  const roundToThousand = (dollars: number) => Math.round(dollars / 1000) * 1000;
  const contracted = (s: Staff) => s.nurse.employmentType !== 'per_diem';
  const legal = (s: Staff, date: IsoDate, shift: ShiftType, lend = false) =>
    canWork(worked, s, date, shift, leave, limits, apart, lend);

  for (let p = 0; p < historyPeriods; p++) {
    const start = addDays(historyStart, p * 14);
    const end = addDays(start, 13);
    const period = createPeriod(
      db,
      {
        unitId: unit.id,
        name: `Pay period ${start}`,
        startDate: start,
        endDate: end,
        ruleSetId: ruleSet.id,
        ruleSetVersion: ruleSet.version,
      },
      ACTOR,
    );
    bump('period');
    const hoursWorked = new Map<Id, number>();
    const shortWorked = new Map<Id, number>();
    const hours = (s: Staff) => hoursWorked.get(s.nurse.id) ?? 0;
    /** Record a shift planned (+1) or taken away (-1). */
    const credit = (s: Staff, shift: ShiftType, sign: 1 | -1) => {
      hoursWorked.set(s.nurse.id, hours(s) + sign * shift.durationHours);
      if (shift === s.shortShift?.shift) {
        shortWorked.set(s.nurse.id, (shortWorked.get(s.nurse.id) ?? 0) + sign);
      }
    };
    /** Hours still held back for the short shifts this pay period owes. */
    const reserved = (s: Staff) =>
      s.shortShift
        ? Math.max(0, s.shortShift.perPayPeriod - (shortWorked.get(s.nurse.id) ?? 0)) *
          s.shortShift.shift.durationHours
        : 0;
    // Paid leave in this pay period counts toward the contract, so it comes off the hours
    // still to schedule, as it would for a real scheduler. It pays whole home shifts.
    const periodTarget = (s: Staff) => {
      let paid = 0;
      for (const d of datesInRange(start, end)) paid += leavePaid.get(`${s.nurse.id}|${d}`) ?? 0;
      return Math.max(0, s.targetHours - Math.round(paid / s.shiftHours) * s.shiftHours);
    };
    /**
     * Whether `shift` fits inside what the nurse is still owed this pay period. A short shift
     * fits only while one is owed; any other shift must leave room for the short ones.
     */
    const fits = (s: Staff, shift: ShiftType) => {
      if (shift === s.shortShift?.shift) {
        return reserved(s) > 0 && hours(s) + shift.durationHours <= periodTarget(s);
      }
      return hours(s) + shift.durationHours + reserved(s) <= periodTarget(s);
    };
    /**
     * Hours held back on a weekday for the weekend the nurse's half works later in this pay
     * period: a tour for each of its days in the period. Without it they spend the period's
     * hours on weekdays, and the weekend, which only they can work under the weekends cap, runs
     * short.
     */
    const weekendHold = (s: Staff, date: IsoDate, shift: ShiftType) => {
      const wk = limits.weekends;
      if (!wk || s.position === 'flex') return 0;
      if (weekendKey(shiftWindow(date, shift), wk.definition) !== null) return 0;
      const mine = worked.get(s.nurse.id)!;
      let held = 0;
      for (const saturday of datesInRange(date, end)) {
        if (weekdayOf(saturday) !== 6) continue;
        const parity = weekendParity(wk.windowAnchor, saturday);
        if (parity === s.weekendGroup && !weekendWorked(mine, saturday, wk.definition)) {
          // Friday and Saturday, and the Sunday too unless it falls in the next pay period.
          held += (saturday === end ? 2 : 3) * s.shiftHours;
        }
      }
      // Never more than half the pay period's hours: a part-timer's weekend is two tours.
      return Math.min(held, periodTarget(s) / 2);
    };
    const plan: PlannedShift[] = [];
    const periodRows: Id[] = [];

    // A standalone shift always has an experienced RN: its charge nurse, placed first. A shift
    // inside another has no charge nurse of its own; a new grad on it is covered by the
    // experienced RNs on it or on the shift it runs inside, as on a real unit. So a new grad
    // joins it only with that cover, and nobody takes the last of that cover away.
    const experiencedRnOn = (date: IsoDate, shift: ShiftType, except?: Staff) =>
      staff.some(
        (x) =>
          x !== except &&
          x.nurse.role === 'RN' &&
          !x.nurse.isNovice &&
          worked.get(x.nurse.id)!.get(date) === shift,
      );
    const noviceOn = (date: IsoDate, shift: ShiftType, except?: Staff) =>
      staff.some(
        (x) => x !== except && x.nurse.isNovice && worked.get(x.nurse.id)!.get(date) === shift,
      );
    const covered = (date: IsoDate, shift: ShiftType, except?: Staff) => {
      if (experiencedRnOn(date, shift, except)) return true;
      const cover = coveringShift(shift, date, shiftById);
      return cover !== undefined && experiencedRnOn(cover.date, cover.shiftType, except);
    };
    /** The inside shifts a shift on `date` covers, dated. */
    const innerOf = (date: IsoDate, shift: ShiftType) =>
      (innerShifts.get(shift.id) ?? []).flatMap((inner) =>
        [date, addDays(date, 1)]
          .filter((d) => containingDate(inner, shift, d) === date)
          .map((d) => ({ date: d, shift: inner })),
      );
    const noviceSafe = (s: Staff, date: IsoDate, shift: ShiftType) =>
      shift.withinShiftTypeId === null || !s.nurse.isNovice || covered(date, shift);
    /** Whether taking `s` off leaves a new grad on this shift, or one inside it, uncovered. */
    const leavesNoviceAlone = (s: Staff, date: IsoDate, shift: ShiftType) => {
      if (s.nurse.isNovice || s.nurse.role !== 'RN') return false;
      const affected = [
        ...(shift.withinShiftTypeId === null ? [] : [{ date, shift }]),
        ...innerOf(date, shift),
      ];
      return affected.some((x) => noviceOn(x.date, x.shift, s) && !covered(x.date, x.shift, s));
    };
    /** Whether taking the preceptor off this shift leaves their orientee on it, or inside it, alone. */
    const leavesOrienteeAlone = (s: Staff, date: IsoDate, shift: ShiftType) => {
      const orientation = limits.orientation;
      if (!orientation) return false;
      const affected = [{ date, shift }, ...innerOf(date, shift)];
      return [...orientation.byOrientee].some(([orienteeId, records]) =>
        records.some(
          (r) =>
            r.preceptorId === s.nurse.id &&
            affected.some(
              (x) =>
                compareDates(x.date, r.startDate) >= 0 &&
                compareDates(x.date, r.endDate) <= 0 &&
                worked.get(orienteeId)!.get(x.date) === x.shift,
            ),
        ),
      );
    };

    /**
     * Who to ask, in the order a staffing office asks: contracted staff short of their hours,
     * then per-diem, then contracted staff catching up on the pay period (paid as overtime but
     * inside their contract), and only then someone beyond their contracted hours.
     */
    // Where overtime needs the nurse's agreement, a placement that could be flagged overtime
    // (the pay period or week past its threshold) is asked of volunteers only; anyone else
    // stays inside it, so no row they hold is overtime.
    const needsVolunteer = (s: Staff, date: IsoDate, shift: ShiftType) =>
      noMandatoryOvertime?.enabled === true &&
      !volunteers.has(s.nurse.id) &&
      (overtimeByPayPeriod ? hoursBetween(worked, s, start, end) : hoursInWeek(worked, s, date)) +
        shift.durationHours >
        overtimeThreshold;
    const tiersFor = (
      date: IsoDate,
      shift: ShiftType,
      role: NurseRole,
      onlyCharge: boolean,
      lend = false,
    ) => {
      const free = staff.filter(
        (s) =>
          s.nurse.role === role &&
          !needsVolunteer(s, date, shift) &&
          (!onlyCharge || s.nurse.isChargeEligible) &&
          legal(s, date, shift, lend) &&
          noviceSafe(s, date, shift),
      );
      const week = (s: Staff) => hoursInWeek(worked, s, date) + shift.durationHours;
      const short = (s: Staff) =>
        fits(s, shift) &&
        (shift === s.shortShift?.shift ||
          hours(s) + shift.durationHours + reserved(s) + weekendHold(s, date, shift) <=
            periodTarget(s));
      return [
        free.filter((s) => contracted(s) && short(s) && week(s) <= s.weeklyHours),
        free.filter((s) => !contracted(s) && short(s) && week(s) <= 36),
        free.filter((s) => contracted(s) && short(s) && week(s) <= 48),
        free.filter((s) => contracted(s) && s.nurse.employmentType !== 'agency' && week(s) <= 48),
      ];
    };
    const weight = (s: Staff, shift: ShiftType, date: IsoDate) => {
      const owedShort = shift === s.shortShift?.shift && reserved(s) > 0;
      let w = s.position === shift.abbreviation || owedShort ? 10 : s.position === 'flex' ? 2 : 0.3;
      if (limits.weekends) {
        // Where weekends are capped, a weekend's Friday night to Sunday goes to as few nurses as
        // possible, each spending their two weekends in four on it, not a tour here and there.
        const key = weekendKey(
          shiftWindow(date, shift),
          limits.weekends.definition,
        ) as IsoDate | null;
        if (key !== null && s.position !== 'flex') {
          const mine = worked.get(s.nurse.id)!;
          const parity = weekendParity(limits.weekends.windowAnchor, key);
          w *= parity === s.weekendGroup ? 3 : 0.05;
          if (weekendWorked(mine, key, limits.weekends.definition)) w *= 4;
        }
      } else if (isWeekendDate(date) && s.position !== 'flex') {
        const week = Math.floor(daysBetween(historyStart, date) / 7);
        w *= week % 2 === s.weekendGroup ? 3 : 0.3;
      }
      const deficit = Math.max(0, periodTarget(s) - hours(s));
      return w * (1 + (3 * deficit) / Math.max(1, periodTarget(s)));
    };
    const pick = (pool: Staff[], shift: ShiftType, date: IsoDate) =>
      rng.weightedPick(pool.map((s) => ({ value: s, weight: weight(s, shift, date) })));

    const planDates = datesInRange(start, end);
    for (const date of planDates) {
      for (const shift of shifts) {
        const mixes = forecast(date, shift, true);
        for (const [role, floor] of Object.entries(profile.floors[shift.abbreviation] ?? {})) {
          const r = role as NurseRole;
          // Scheduled to the forecast (which the period is judged by), and up again when the day
          // turned out busier.
          const bedside = Math.max(0, ...mixes.map((m) => nursesRequiredForMix(m, r, ratioRules)));
          // A charge nurse kept free of patients is not one of the nurses the ratio counts, so a
          // standalone shift needs one more RN (as `deriveDemand` reads it). Break relief is not
          // modelled: a profile that sets break minutes would need it added here.
          const keepsChargeFree =
            r === 'RN' &&
            bedside > 0 &&
            shift.withinShiftTypeId === null &&
            profile.unit.ratioStaffing?.chargeNurseTakesPatients === false;
          const ratio = bedside + (keepsChargeFree ? 1 : 0);
          const min = Math.max(floor.min, ratio);
          const target = Math.max(min, floor.target);
          let staffed = 0;
          const add = (s: Staff, isCharge = false) => {
            plan.push({ staff: s, date, shift, isCharge });
            worked.get(s.nurse.id)!.set(date, shift);
            credit(s, shift, 1);
            staffed++;
          };
          if (r === 'RN' && shift.withinShiftTypeId === null) {
            // A half with no charge nurse for its weekend borrows the other's, last of all.
            const chargePool = [false, true]
              .map((lend) => tiersFor(date, shift, r, true, lend).find((t) => t.length > 0))
              .find((pool) => pool !== undefined);
            if (chargePool) add(pick(chargePool, shift, date), true);
          }
          while (staffed < min) {
            let tiers = tiersFor(date, shift, r, false);
            let tier = tiers.findIndex((t) => t.length > 0);
            if (tier === -1) {
              // Short: borrow from the other half's weekend before running short.
              tiers = tiersFor(date, shift, r, false, true);
              tier = tiers.findIndex((t) => t.length > 0);
            }
            if (tier === -1) break; // Nobody left who could legally work it: the shift ran short.
            if (tier === tiers.length - 1) bump('overtimePicks');
            add(pick(tiers[tier]!, shift, date));
          }
          // Above the floor, only contracted staff behind on their hours for the period so far.
          const elapsed = (daysBetween(start, date) + 1) / 14;
          while (staffed < target) {
            // Behind by whole home shifts: the pay period's share so far, rounded down.
            const pool = tiersFor(date, shift, r, false)[0]!.filter(
              (s) =>
                hours(s) < Math.floor((periodTarget(s) / s.shiftHours) * elapsed) * s.shiftHours,
            );
            if (pool.length === 0) break;
            add(pick(pool, shift, date));
          }
        }
      }
    }

    // Anyone still owed their short shift gets it, as a scheduler would place it: on a legal
    // day, preferring one where that shift is still under target for their role.
    const onShortShift = (date: IsoDate, shift: ShiftType, role: NurseRole) =>
      plan.filter((e) => e.date === date && e.shift === shift && e.staff.nurse.role === role)
        .length;
    for (const s of staff) {
      if (!s.shortShift) continue;
      const shift = s.shortShift.shift;
      const target = profile.floors[shift.abbreviation]?.[s.nurse.role]?.target ?? 0;
      while (reserved(s) > 0) {
        const days = datesInRange(start, end).filter(
          (d) =>
            fits(s, shift) &&
            hoursInWeek(worked, s, d) + shift.durationHours <= 48 &&
            legal(s, d, shift) &&
            noviceSafe(s, d, shift),
        );
        if (days.length === 0) break;
        // Where weekends are capped, a short shift is not worth a weekend: it is kept for the
        // weekends the nurse already works, so the floors on the rest keep their cover.
        const wk = limits.weekends;
        const spare = wk
          ? days.filter((d) => {
              const key = weekendKey(shiftWindow(d, shift), wk.definition) as IsoDate | null;
              return key === null || weekendWorked(worked.get(s.nurse.id)!, key, wk.definition);
            })
          : days;
        const choices = spare.length > 0 ? spare : days;
        const under = choices.filter((d) => onShortShift(d, shift, s.nurse.role) < target);
        const date = rng.pick(under.length > 0 ? under : choices);
        plan.push({ staff: s, date, shift, isCharge: false });
        worked.get(s.nurse.id)!.set(date, shift);
        credit(s, shift, 1);
      }
    }

    // Where weekends are capped, a nurse's half of the weekends leaves them short of their hours on
    // some pay periods (the days they may not work are the weekends). A scheduler tops them up on
    // a legal day, where their own tour is still under its target.
    if (limits.weekends) {
      for (const s of staff) {
        const home = shiftByCode.get(s.position);
        if (!home || !contracted(s) || s.position === 'flex') continue;
        const target = profile.floors[home.abbreviation]?.[s.nurse.role]?.target ?? 0;
        while (fits(s, home)) {
          const days = datesInRange(start, end).filter(
            (d) =>
              hoursInWeek(worked, s, d) + home.durationHours <= 48 &&
              legal(s, d, home) &&
              noviceSafe(s, d, home),
          );
          if (days.length === 0) break;
          const under = days.filter((d) => onShortShift(d, home, s.nurse.role) < target);
          const date = rng.pick(under.length > 0 ? under : days);
          plan.push({ staff: s, date, shift: home, isCharge: false });
          worked.get(s.nurse.id)!.set(date, home);
          credit(s, home, 1);
        }
      }
    }

    // Before posting, move shifts from anyone past their contract — or from per-diem staff — to
    // contracted staff still short, wherever the move is legal.
    const takerFor = (from: Staff, entry: PlannedShift) => {
      // If `from` is the last experienced RN covering a new grad, only another one may take over.
      const needsCover = leavesNoviceAlone(from, entry.date, entry.shift);
      if (leavesOrienteeAlone(from, entry.date, entry.shift)) return undefined;
      const mine = worked.get(from.nurse.id)!;
      mine.delete(entry.date);
      if (!canRemove(worked, from, entry.date, limits)) {
        mine.set(entry.date, entry.shift);
        return undefined;
      }
      const taker = staff.find(
        (u) =>
          u !== from &&
          u.nurse.role === from.nurse.role &&
          contracted(u) &&
          fits(u, entry.shift) &&
          (!entry.isCharge || u.nurse.isChargeEligible) &&
          hoursInWeek(worked, u, entry.date) + entry.shift.durationHours <= 48 &&
          legal(u, entry.date, entry.shift) &&
          noviceSafe(u, entry.date, entry.shift) &&
          (!needsCover || !u.nurse.isNovice),
      );
      mine.set(entry.date, entry.shift);
      return taker;
    };
    for (let moved = true; moved; ) {
      moved = false;
      for (const entry of plan) {
        const from = entry.staff;
        if (contracted(from) && hours(from) <= periodTarget(from)) continue;
        const taker = takerFor(from, entry);
        if (!taker) continue;
        worked.get(from.nurse.id)!.delete(entry.date);
        worked.get(taker.nurse.id)!.set(entry.date, entry.shift);
        credit(from, entry.shift, -1);
        credit(taker, entry.shift, 1);
        entry.staff = taker;
        moved = true;
      }
    }

    // Post the period. A shift is overtime once the Sunday-to-Saturday week passes 40 hours, or
    // the pay period its threshold where overtime is judged that way.
    const windowHours = new Map<string, number>();
    plan.sort(
      (a, b) => compareDates(a.date, b.date) || a.shift.startTime.localeCompare(b.shift.startTime),
    );
    for (const entry of plan) {
      const windowKey = overtimeByPayPeriod
        ? entry.staff.nurse.id
        : `${entry.staff.nurse.id}|${addDays(entry.date, -weekdayOf(entry.date))}`;
      const windowTotal = (windowHours.get(windowKey) ?? 0) + entry.shift.durationHours;
      windowHours.set(windowKey, windowTotal);
      const row = createAssignment(
        db,
        {
          periodId: period.id,
          nurseId: entry.staff.nurse.id,
          shiftTypeId: entry.shift.id,
          date: entry.date,
          source: 'solver',
          isCharge: entry.isCharge,
          isOvertime: windowTotal > overtimeThreshold,
        },
        ACTOR,
      );
      rows.set(row.id, row);
      periodRows.push(row.id);
      bump('assignment');
    }

    // About two call-offs a week. Per-diem staff are phoned first, overtime is the last resort.
    const staffOf = (a: Assignment) => staff.find((s) => s.nurse.id === a.nurseId)!;
    const shiftOf = (a: Assignment) => shifts.find((x) => x.id === a.shiftTypeId)!;
    const callable = rng
      .shuffle(
        periodRows
          .map((id) => rows.get(id)!)
          .filter(
            (a) =>
              !a.isCharge &&
              canRemove(worked, staffOf(a), a.date, limits) &&
              !leavesNoviceAlone(staffOf(a), a.date, shiftOf(a)) &&
              !leavesOrienteeAlone(staffOf(a), a.date, shiftOf(a)),
          ),
      )
      .slice(0, rng.nextInt(3, 5));
    for (const absent of callable) {
      const reason = rng.weightedPick([
        { value: 'Sick', weight: 6 },
        { value: 'Sick child', weight: 2 },
        { value: 'Family emergency', weight: 1 },
        { value: 'Car trouble', weight: 1 },
      ]);
      // Staff are paid from sick leave; per-diem and travel nurses have none.
      const absentNurse = staff.find((s) => s.nurse.id === absent.nurseId)!;
      const sickPay =
        absentNurse.nurse.employmentType === 'full_time' ||
        absentNurse.nurse.employmentType === 'part_time'
          ? { paidSickHours: shifts.find((x) => x.id === absent.shiftTypeId)!.durationHours }
          : {};
      const callOff = reportCallOff(db, absent.id, ACTOR, reason, sickPay);
      bump('callOff');
      deleteAssignment(db, absent.id, ACTOR, `Called off: ${reason}`);
      rows.delete(absent.id);
      periodRows.splice(periodRows.indexOf(absent.id), 1);
      const absentStaff = staff.find((s) => s.nurse.id === absent.nurseId)!;
      worked.get(absentStaff.nurse.id)!.delete(absent.date);
      const shift = shifts.find((s) => s.id === absent.shiftTypeId)!;
      credit(absentStaff, shift, -1);
      const [under, perDiem, catchUp, overtime] = tiersFor(
        absent.date,
        shift,
        absentStaff.nurse.role,
        false,
      );
      const phoneList = [
        ...rng.shuffle(perDiem!),
        ...rng.shuffle(under!),
        ...rng.shuffle(catchUp!),
        ...rng.shuffle(overtime!),
      ]
        .filter((s) => s !== absentStaff)
        .slice(0, rng.nextInt(2, 5));
      // An RN call-off is covered whenever anyone can legally come in — below ratio the unit
      // cannot run — while an assistant's shift sometimes just runs one short.
      const covered = phoneList.length > 0 && (absentStaff.nurse.role === 'RN' || rng.chance(0.8));
      for (const [i, s] of phoneList.entries()) {
        if (covered && i === phoneList.length - 1) {
          if (contracted(s) && hours(s) >= periodTarget(s)) bump('overtimeCallouts');
          logCallAttempt(db, callOff.id, s.nurse.id, 'accepted', ACTOR);
          bump('callAttempt');
          const before = overtimeByPayPeriod
            ? hoursBetween(worked, s, start, end)
            : hoursInWeek(worked, s, absent.date);
          const replacement = createAssignment(
            db,
            {
              periodId: period.id,
              nurseId: s.nurse.id,
              shiftTypeId: shift.id,
              date: absent.date,
              source: 'callout',
              isOvertime: before + shift.durationHours > overtimeThreshold,
            },
            ACTOR,
          );
          worked.get(s.nurse.id)!.set(absent.date, shift);
          credit(s, shift, 1);
          rows.set(replacement.id, replacement);
          periodRows.push(replacement.id);
          bump('assignment');
          markCallOffCovered(db, callOff.id, replacement.id, ACTOR);
          break;
        }
        const outcome = rng.pick(['no_answer', 'declined', 'left_message'] as const);
        logCallAttempt(db, callOff.id, s.nurse.id, outcome, ACTOR);
        bump('callAttempt');
      }
      if (!covered) {
        markCallOffUncovered(db, callOff.id, ACTOR, 'Nobody available; the shift worked one short');
        bump('callOffUncovered');
      }
    }

    publishPeriod(db, period.id, ACTOR);
    const periodAssignments = periodRows.map((id) => rows.get(id)!);
    const actual = costSchedule(
      new ScheduleView({
        period,
        assignments: periodAssignments,
        nurses: staff.map((s) => s.nurse),
        shiftTypes: shifts,
      }),
      costContext,
    ).totals.total;
    historyCosts.push(actual);
    // Budgeted from the staffing plan, so what was spent lands a few percent either side.
    const budget = roundToThousand(actual * (0.97 + 0.07 * rng.nextFloat()));
    setBudget(db, unit.id, period.id, budget, ACTOR);
    bump('budget');

    const hoursOf = (a: Assignment) => shifts.find((s) => s.id === a.shiftTypeId)!.durationHours;
    const nightIds = new Set(shifts.filter((s) => s.isNight).map((s) => s.id));
    for (const s of staff) {
      const mine = periodAssignments.filter((a) => a.nurseId === s.nurse.id);
      const nights = mine.filter((a) => nightIds.has(a.shiftTypeId)).length;
      const nightPosition = shiftByCode.get(s.position)?.isNight ?? false;
      const weekends = new Set(
        mine
          .filter((a) => isWeekendDate(a.date))
          .map((a) => addDays(a.date, -((weekdayOf(a.date) + 1) % 7))),
      );
      const totalHours = mine.reduce((h, a) => h + hoursOf(a), 0);
      const overtimeHours = overtimeByPayPeriod
        ? Math.max(0, totalHours - overtimeThreshold)
        : [0, 7].reduce((sum, offset) => {
            const from = addDays(start, offset);
            const to = addDays(from, 6);
            const inWeek = mine
              .filter((a) => compareDates(a.date, from) >= 0 && compareDates(a.date, to) <= 0)
              .reduce((h, a) => h + hoursOf(a), 0);
            return sum + Math.max(0, inWeek - 40);
          }, 0);
      ledgerInputs.push({
        nurseId: s.nurse.id,
        periodId: period.id,
        periodStart: start,
        nightShifts: nights,
        weekendsWorked: weekends.size,
        holidaysWorked: mine.filter((a) => holidayDates.has(a.date)).length,
        onCallShifts: 0,
        undesirableShifts: nightPosition ? 0 : nights,
        totalHours,
        overtimeHours,
        preferenceHitRate:
          mine.length === 0 ? 1 : nightPosition ? nights / mine.length : 1 - nights / mine.length,
      });
    }
  }
  importFairnessLedgerEntries(db, ledgerInputs, ACTOR);
  bump('fairnessLedger', ledgerInputs.length);

  // --- Holdovers ------------------------------------------------------------------------------
  // After every period is published and priced (budgets and run rate stay as they were), and with
  // no draws. Each is a weekday tour, off a holiday, where the extra time breaks nothing: the
  // rest before the nurse's next shift stays within the unit's minimum and the week within the
  // engine's 48-hour cap. Spread across the history by taking the candidate a share of the way
  // through the list. Volunteered, as most are: the nurse stayed, nobody required it.
  if (profile.holdovers) {
    // One nurse each: three people held over once, not one nurse three times.
    const taken = new Set<Id>();
    for (const [i, spec] of profile.holdovers.entries()) {
      const shift = shiftByCode.get(spec.shift);
      if (!shift) throw new Error(`Holdover on unknown shift ${spec.shift}`);
      const fits = [...rows.values()].filter((a) => {
        if (a.shiftTypeId !== shift.id || a.isCharge || taken.has(a.nurseId)) return false;
        // Never in the last two days of history: the draft's first shift must not lose rest to it.
        if (compareDates(a.date, addDays(draftStart, -2)) >= 0) return false;
        const weekday = weekdayOf(a.date);
        if (weekday < 1 || weekday > 4) return false;
        if (holidayDates.has(a.date) || holidayDates.has(addDays(a.date, 1))) return false;
        const s = staff.find((x) => x.nurse.id === a.nurseId)!;
        if (s.nurse.isNovice) return false;
        const mine = worked.get(a.nurseId)!;
        if (hoursInWeek(worked, s, a.date) + spec.minutes / 60 > 48) return false;
        // Under the overtime threshold even with it, so the holdover is the only overtime on the
        // row and its price is the minutes alone.
        const windowStart = overtimeByPayPeriod
          ? addDays(historyStart, Math.floor(daysBetween(historyStart, a.date) / 14) * 14)
          : addDays(a.date, -weekdayOf(a.date));
        const windowEnd = addDays(windowStart, overtimeByPayPeriod ? 13 : 6);
        if (
          hoursBetween(worked, s, windowStart, windowEnd) + spec.minutes / 60 >
          overtimeThreshold
        ) {
          return false;
        }
        const endMinute = shiftWindow(a.date, shift).endMinute + spec.minutes;
        return [1, 2].every((ahead) => {
          const next = mine.get(addDays(a.date, ahead));
          const nextStart = next && shiftWindow(addDays(a.date, ahead), next).startMinute;
          return nextStart === undefined || nextStart - endMinute >= limits.minRestMinutes;
        });
      });
      if (fits.length === 0) throw new Error(`No place for a holdover on ${spec.shift}`);
      const chosen = fits[Math.floor((fits.length * (i + 1)) / (profile.holdovers.length + 1))]!;
      taken.add(chosen.nurseId);
      recordHoldover(
        db,
        { assignmentId: chosen.id, minutes: spec.minutes, mandated: false },
        ACTOR,
      );
      bump('holdover');
    }
  }

  // --- The next schedule ----------------------------------------------------------------------
  const draft = createPeriod(
    db,
    {
      unitId: unit.id,
      name: `Schedule ${draftStart} to ${draftEnd}`,
      startDate: draftStart,
      endDate: draftEnd,
      ruleSetId: ruleSet.id,
      ruleSetVersion: ruleSet.version,
    },
    ACTOR,
  );
  bump('period');
  const draftDates = datesInRange(draftStart, draftEnd);
  for (const date of draftDates) {
    for (const shift of shifts) forecast(date, shift, false);
  }
  const recent = historyCosts.slice(-3);
  const runRate = recent.reduce((sum, c) => sum + c, 0) / Math.max(1, recent.length);
  setBudget(db, unit.id, draft.id, roundToThousand((runRate * profile.scheduleWeeks) / 2), ACTOR);
  bump('budget');

  // Requests for the next schedule: a few approved as they came in, the rest waiting on the
  // manager. They bunch on Fridays and around holidays, as they do.
  const popular = draftDates.filter((d) => weekdayOf(d) === 5 || holidayDates.has(d));
  const requesters = rng.shuffle(employees).slice(0, Math.min(16, employees.length));
  for (const [i, s] of requesters.entries()) {
    const startDate = rng.chance(0.5) ? rng.pick(popular) : rng.pick(draftDates.slice(0, -5));
    if (i === requesters.length - 1) {
      requestLeave(s, startDate, startDate, 'education', 'Certification course', 'pending');
      continue;
    }
    // Two week-long vacations; the rest a long weekend or a day or two.
    const endDate = addDays(startDate, i < 2 ? 6 : rng.nextInt(0, 2));
    const reason =
      i < 2 ? 'Vacation' : rng.pick(['Family event', 'Wedding', 'Appointment', 'Personal']);
    requestLeave(s, startDate, endDate, vacationType, reason, i < 6 ? 'approve' : 'pending');
  }

  // --- Leave, certifications, floats and bidding ----------------------------------------------
  // Last, so a profile that sets none of them draws nothing here and keeps its data.
  const asOf = addDays(draftStart, -1);
  const cycle = profile.payPeriodCycle ?? draftStart;
  /** The pay period start on or after `date`: leave years begin with one. */
  const payPeriodOnOrAfter = (date: IsoDate) => {
    const offset = ((daysBetween(cycle, date) % 14) + 14) % 14;
    return offset === 0 ? date : addDays(date, 14 - offset);
  };

  if (profile.leaveBalances) {
    const { vacationType: balanceType, carryoverCapHours, accrual } = profile.leaveBalances;
    const asOfYear = Number(asOf.slice(0, 4));
    const thisYearStart = payPeriodOnOrAfter(`${asOfYear}-01-01` as IsoDate);
    // Before the year's first pay period, the leave year is still last year's.
    const yearStart =
      compareDates(asOf, thisYearStart) >= 0
        ? thisYearStart
        : payPeriodOnOrAfter(`${asOfYear - 1}-01-01` as IsoDate);
    const periodsBetween = (from: IsoDate, to: IsoDate) =>
      Math.max(0, Math.floor(daysBetween(from, to) / 14));
    for (const s of employees) {
      const rates = accrual({ role: s.nurse.role, years: s.years });
      // Part-time staff earn by the hours they work: pro rata to an 80-hour pay period.
      const share = Math.min(1, s.nurse.contractedHoursPerPeriod / 80);
      const annualRate = rates.annual * share;
      // Leave is projected from when employment here began, as the app does.
      const hired = s.nurse.hireDate ?? s.nurse.seniorityDate;
      // What came into the leave year: what has accrued since hire, never above the cap, and
      // some of it spent. This year's accrual and spending follow.
      const earnedBefore = annualRate * periodsBetween(hired, yearStart);
      const cap = carryoverCapHours(s.nurse.role);
      const carried = Math.min(cap, earnedBefore) * (0.1 + 0.9 * rng.nextFloat());
      const accruedThisYear =
        annualRate * periodsBetween(compareDates(hired, yearStart) > 0 ? hired : yearStart, asOf);
      // Kept at or under the ceiling: carry-in plus this year's accrual can pass it, and a balance
      // above it would be forfeiting at the next turnover.
      const annual = Math.min(cap, (carried + accruedThisYear) * (1 - 0.55 * rng.nextFloat()));
      // Sick leave accrues for the whole career and has no cap; most of it goes unused.
      const sickEarned = rates.sick * share * periodsBetween(hired, asOf);
      const sick = sickEarned * (0.55 + 0.4 * rng.nextFloat());
      setLeaveBalance(
        db,
        { nurseId: s.nurse.id, type: balanceType, balanceHours: round2(annual), asOf },
        ACTOR,
      );
      setLeaveBalance(
        db,
        { nurseId: s.nurse.id, type: 'sick', balanceHours: round2(sick), asOf },
        ACTOR,
      );
      bump('leaveBalance', 2);
    }
  }

  if (profile.fmla) {
    const taken = new Set<Id>(
      [...(limits.orientation?.byOrientee ?? [])].flatMap(([id, rs]) => [
        id,
        ...rs.map((r) => r.preceptorId),
      ]),
    );
    // A year's service is what FMLA asks, so a new grad is never the nurse on it.
    const pool = rng.shuffle(
      employees.filter((s) => !s.nurse.isChargeEligible && s.years >= 1 && !taken.has(s.nurse.id)),
    );
    for (const [i, spec] of profile.fmla.entries()) {
      const s = pool[i];
      if (!s) throw new Error('Not enough staff for the FMLA certifications');
      createFmlaCertification(
        db,
        {
          nurseId: s.nurse.id,
          startDate: addDays(draftStart, spec.startsIn),
          endDate: addDays(draftStart, spec.endsIn),
          intermittent: spec.intermittent,
          note: spec.note,
        },
        ACTOR,
      );
      bump('fmlaCertification');
    }
  }

  if (profile.floatUnit) {
    const spec = profile.floatUnit;
    const sibling = createUnit(
      db,
      {
        name: spec.name,
        unitType: spec.unitType,
        payPeriodDays: 14,
        payPeriodAnchor: historyStart,
      },
      ACTOR,
    );
    bump('floatUnit');
    for (const [i, code] of spec.shifts.entries()) {
      const from = profile.shifts.find((x) => x.code === code)!;
      createShiftType(
        db,
        {
          unitId: sibling.id,
          name: from.name,
          abbreviation: from.code,
          startTime: from.startTime,
          durationHours: from.durationHours,
          isNight: from.isNight,
          isOnCall: false,
          color: from.color,
          sortOrder: i + 1,
          active: true,
          withinShiftTypeId: null,
        },
        ACTOR,
      );
    }
    // Experienced and never a charge nurse, whom the home unit cannot spare; those who said they
    // would float first, and the intermittent pool among them, since the units share nurses. Orientees and preceptors stay home.
    const inOrientation = new Set<Id>(
      [...(limits.orientation?.byOrientee ?? [])].flatMap(([id, rs]) => [
        id,
        ...rs.map((r) => r.preceptorId),
      ]),
    );
    const floaters = (role: NurseRole, n: number) => {
      const pool = staff.filter(
        (s) =>
          s.nurse.role === role &&
          s.nurse.employmentType !== 'agency' &&
          !s.nurse.isChargeEligible &&
          !s.nurse.isNovice &&
          s.years >= 2 &&
          !inOrientation.has(s.nurse.id),
      );
      const willing = rng.shuffle(pool.filter((s) => s.nurse.isFloatEligible));
      const others = rng.shuffle(pool.filter((s) => !s.nurse.isFloatEligible));
      if (willing.length + others.length < n) throw new Error(`Not enough ${role}s to float`);
      return [...willing, ...others].slice(0, n);
    };
    for (const s of [...floaters('RN', spec.rns), ...floaters('LPN', spec.lpns)]) {
      createNurseUnit(
        db,
        { nurseId: s.nurse.id, unitId: sibling.id, competency: spec.competency },
        ACTOR,
      );
      bump('nurseUnit');
    }
  }

  if (profile.annualLeaveBid) {
    const spec = profile.annualLeaveBid;
    const draftYear = Number(draftStart.slice(0, 4));
    const leaveYear = draftYear + 1;
    const coversStart = payPeriodOnOrAfter(`${leaveYear}-01-01` as IsoDate);
    const coversEnd = addDays(payPeriodOnOrAfter(`${leaveYear + 1}-01-01` as IsoDate), -1);
    const opensOn = `${draftYear}-${spec.opens}` as IsoDate;
    const closesOn = `${draftYear}-${spec.closes}` as IsoDate;
    const round = createLeaveBidRound(
      db,
      {
        unitId: unit.id,
        name: `${leaveYear} annual leave`,
        coversStart,
        coversEnd,
        opensOn,
        closesOn,
        offPerDay: spec.offPerDay,
        maxAwardsPerNurse: spec.maxAwardsPerNurse,
      },
      ACTOR,
    );
    bump('leaveBidRound');
    // Pay periods start on Sundays, so each choice is a Sunday-to-Saturday week of the leave year.
    const weeks = Math.floor((daysBetween(coversStart, coversEnd) + 1) / 7);
    for (const s of employees) {
      if (!rng.chance(spec.share)) continue;
      const picked = rng
        .shuffle(Array.from({ length: weeks }, (_, w) => w))
        .slice(0, rng.nextInt(1, spec.maxChoices));
      submitLeaveBid(
        db,
        round.id,
        s.nurse.id,
        picked.map((w, i) => ({
          rank: i + 1,
          startDate: addDays(coversStart, w * 7),
          endDate: addDays(coversStart, w * 7 + 6),
        })),
        ACTOR,
      );
      bump('leaveBid');
    }
    // Bidding that has ended is closed. The round is never awarded here: awarding is the
    // manager's step (results are due 15 October), and an evaluator should see it undone.
    if (compareDates(now, closesOn) > 0) closeLeaveBidRound(db, round.id, ACTOR);
  }

  return { unitId: unit.id, draftPeriodId: draft.id, draftStart, draftEnd, counts };
}
