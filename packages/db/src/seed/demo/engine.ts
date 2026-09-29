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
  type Nurse,
  type NurseRole,
  nursesRequiredForMix,
  type OvertimeRule,
  type Preference,
  type RatioRule,
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
import { createHoliday } from '../../repositories/holidays.js';
import { createIncompatibilityGroup } from '../../repositories/incompatibility.js';
import {
  importFairnessLedgerEntries,
  type UpsertFairnessLedgerInput,
} from '../../repositories/ledger.js';
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
import {
  createNurse,
  grantCredential,
  replaceNursePreferences,
} from '../../repositories/roster.js';
import { createCredential } from '../../repositories/roster-io.js';
import { saveRuleSet } from '../../repositories/rulesets.js';
import {
  createAssignment,
  createPeriod,
  deleteAssignment,
  publishPeriod,
} from '../../repositories/schedule.js';
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
   * Drives the night differential, the all-night stretch limit and the fairness night count.
   * A federal evening tour is flagged too: Title 38 pays night differential on it.
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

export interface DemoProfile {
  id: string;
  unit: { name: string; unitType: string };
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
  rules: {
    weekend: WeekendDefinition;
    /** Parameter overrides by rule id, merged over the registry defaults. */
    params?: Readonly<Record<string, Record<string, unknown>>>;
  };
  keptApart?: readonly DemoKeptApart[];
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
  return true;
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
  const configs = base.configs.map((c) => ({
    ...c,
    params: { ...c.params, ...(profile.rules.params?.[c.ruleId] ?? {}) },
  }));
  const ruleSet = saveRuleSet(
    db,
    {
      unitId: unit.id,
      name: base.name,
      configs,
      weekendDefinition: profile.rules.weekend,
      fairnessWeights: base.fairnessWeights,
    },
    ACTOR,
  );
  bump('ruleSet');
  const nightIntoLeave = configs.find((c) => c.ruleId === 'approved-time-off-is-absolute')?.params
    ?.nightShiftEndingOnLeaveCounts;
  const limits: Limits = {
    nightIntoLeave: nightIntoLeave === true,
    minRestMinutes: 60 * numberParam(configs, 'min-rest-between-shifts', 'minRestHours', 10),
    maxRun: numberParam(configs, 'max-consecutive-shifts', 'maxConsecutiveShifts', 5),
    maxNights: numberParam(configs, 'max-consecutive-shifts', 'maxConsecutiveNights', 3),
    minDaysOff: numberParam(configs, 'max-consecutive-shifts', 'minDaysOffAfterMaxStretch', 2),
  };
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
  const staff: Staff[] = planned.map((p, index) => {
    const { row } = p;
    const traveler = row.employmentType === 'agency';
    // Unit seniority is the hire date. A traveler's is the start of their current contract,
    // which began before the history did (they are on an extension).
    const seniorityDate = traveler
      ? addDays(historyStart, -rng.nextInt(10, 40))
      : addDays(now, -Math.round(p.years * 365) - rng.nextInt(0, 60));
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
    return {
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
  });
  counts.chargeEligible = staff.filter((s) => s.nurse.isChargeEligible).length;

  // --- Credentials per person -----------------------------------------------------------------
  // Two-year cards renewed at random points: expiry is uniform over the next two years.
  const card = (days = 730) => addDays(now, rng.nextInt(10, days));
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
  for (const d of profile.differentials) {
    createDifferential(db, { unitId: unit.id, ...d, active: true }, ACTOR);
    bump('differential');
  }
  for (const o of profile.overtime) {
    createOvertimeRule(db, { unitId: unit.id, ...o, active: true }, ACTOR);
    bump('overtimeRule');
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
  const requestLeave = (
    s: Staff,
    startDate: IsoDate,
    endDate: IsoDate,
    type: 'pto' | 'education',
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
        requestLeave(s, startDate, addDays(startDate, rng.nextInt(0, 4)), 'pto', reason, 'decide');
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
  const legal = (s: Staff, date: IsoDate, shift: ShiftType) =>
    canWork(worked, s, date, shift, leave, limits, apart);

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

    /**
     * Who to ask, in the order a staffing office asks: contracted staff short of their hours,
     * then per-diem, then contracted staff catching up on the pay period (paid as overtime but
     * inside their contract), and only then someone beyond their contracted hours.
     */
    const tiersFor = (date: IsoDate, shift: ShiftType, role: NurseRole, onlyCharge: boolean) => {
      const free = staff.filter(
        (s) =>
          s.nurse.role === role &&
          (!onlyCharge || s.nurse.isChargeEligible) &&
          legal(s, date, shift) &&
          noviceSafe(s, date, shift),
      );
      const week = (s: Staff) => hoursInWeek(worked, s, date) + shift.durationHours;
      const short = (s: Staff) => fits(s, shift);
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
      if (isWeekendDate(date) && s.position !== 'flex') {
        const week = Math.floor(daysBetween(historyStart, date) / 7);
        w *= week % 2 === s.weekendGroup ? 3 : 0.3;
      }
      const deficit = Math.max(0, periodTarget(s) - hours(s));
      return w * (1 + (3 * deficit) / Math.max(1, periodTarget(s)));
    };
    const pick = (pool: Staff[], shift: ShiftType, date: IsoDate) =>
      rng.weightedPick(pool.map((s) => ({ value: s, weight: weight(s, shift, date) })));

    for (const date of datesInRange(start, end)) {
      for (const shift of shifts) {
        const mixes = forecast(date, shift, true);
        for (const [role, floor] of Object.entries(profile.floors[shift.abbreviation] ?? {})) {
          const r = role as NurseRole;
          // Scheduled to the forecast (which the period is judged by), and up again when the day
          // turned out busier.
          const ratio = Math.max(0, ...mixes.map((m) => nursesRequiredForMix(m, r, ratioRules)));
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
            const chargePool = tiersFor(date, shift, r, true).find((t) => t.length > 0);
            if (chargePool) add(pick(chargePool, shift, date), true);
          }
          while (staffed < min) {
            const tiers = tiersFor(date, shift, r, false);
            const tier = tiers.findIndex((t) => t.length > 0);
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
        const under = days.filter((d) => onShortShift(d, shift, s.nurse.role) < target);
        const date = rng.pick(under.length > 0 ? under : days);
        plan.push({ staff: s, date, shift, isCharge: false });
        worked.get(s.nurse.id)!.set(date, shift);
        credit(s, shift, 1);
      }
    }

    // Before posting, move shifts from anyone past their contract — or from per-diem staff — to
    // contracted staff still short, wherever the move is legal.
    const takerFor = (from: Staff, entry: PlannedShift) => {
      // If `from` is the last experienced RN covering a new grad, only another one may take over.
      const needsCover = leavesNoviceAlone(from, entry.date, entry.shift);
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
              !leavesNoviceAlone(staffOf(a), a.date, shiftOf(a)),
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
    requestLeave(s, startDate, endDate, 'pto', reason, i < 6 ? 'approve' : 'pending');
  }

  return { unitId: unit.id, draftPeriodId: draft.id, draftStart, draftEnd, counts };
}
