/**
 * The demo dataset: a realistic 42-nurse med-surg unit with six months of history.
 *
 * ## Why this is deliberately imperfect
 *
 * A demo that is too tidy makes every feature look inert. Fairness scoring has nothing to
 * correct if history is already fair; conflict detection has nothing to surface if nobody
 * wants the same weekend off; compliance alerts have nothing to flag if no credential is
 * expiring. So this seeder plants specific, known problems:
 *
 * - night and weekend work skewed toward a subset of nurses (via hidden affinity weights),
 * - a cluster of pending PTO requests on the same weekend of the upcoming period,
 * - a few ACLS certifications expiring inside that period,
 * - census actuals that diverge from forecasts, so the back-test has something to show.
 *
 * ## Determinism
 *
 * Every random choice comes from a seeded `Rng`. Two runs with the same seed produce the
 * same database, which is what makes golden-file solver tests possible and lets "did my
 * change do that?" be answered by diffing rather than guessing.
 */

import {
  type AcuityTier,
  type Assignment,
  addDays,
  type CostContext,
  type CoverageRequirement,
  costSchedule,
  DEFAULT_WEEKEND,
  datesInRange,
  defaultRuleSet,
  type EmploymentType,
  type Id,
  type IsoDate,
  isoDate,
  isWeekendDate,
  type Nurse,
  type NurseRole,
  type Preference,
  Rng,
  ScheduleView,
  type ShiftType,
  today,
  type Weekday,
  weekdayOf,
} from '@shiftnurse/core';
import type { DbLike } from '../client.js';
import { ids } from '../ids.js';
import { createAcuityTier, createRatioRule, upsertHppdTarget } from '../repositories/acuity.js';
import { logCallAttempt, markCallOffCovered, reportCallOff } from '../repositories/calloffs.js';
import {
  createHoliday,
  createShiftCredentialRequirement,
  createShiftType,
  createUnit,
  upsertCoverageRequirement,
} from '../repositories/config.js';
import {
  importFairnessLedgerEntries,
  type UpsertFairnessLedgerInput,
} from '../repositories/ledger.js';
import {
  listActiveDifferentials,
  listActiveOvertimeRules,
  listPayRatesForUnit,
  setBudget,
} from '../repositories/pay.js';
import { createNurse, grantCredential, replaceNursePreferences } from '../repositories/roster.js';
import { saveRuleSet } from '../repositories/rulesets.js';
import {
  createAssignment,
  createPeriod,
  deleteAssignment,
  publishPeriod,
} from '../repositories/schedule.js';
import { approveTimeOff, createTimeOffRequest, denyTimeOff } from '../repositories/timeoff.js';
import * as s from '../schema.js';

const ACTOR = 'demo-seed';

export interface SeedOptions {
  /** PRNG seed. Same seed, same database. */
  seed?: number;
  /** The "current" date the dataset is built around. Defaults to the host clock. */
  today?: IsoDate;
  /** Whole pay periods of history to generate. */
  historyPeriods?: number;
}

export interface SeedResult {
  unitId: Id;
  draftPeriodId: Id;
  draftStart: IsoDate;
  draftEnd: IsoDate;
  counts: Record<string, number>;
}

/** Hidden per-nurse traits that shape history without being stored. */
interface Trait {
  nurse: Nurse;
  /** 8 or 12 — the length this nurse habitually works. */
  shiftLength: 8 | 12;
  /** Higher = more often chosen for nights. This is what makes history unfair. */
  nightAffinity: number;
  weekendAffinity: number;
  /** Shifts this nurse should work per pay period to land near their FTE. */
  targetShiftsPerPeriod: number;
}

const FIRST_NAMES = [
  'Maria',
  'James',
  'Aisha',
  'Wei',
  'Priya',
  'Daniel',
  'Fatima',
  'Luis',
  'Grace',
  'Tomasz',
  'Keiko',
  'Samuel',
  'Chioma',
  'Elena',
  'Marcus',
  'Hana',
  'Ibrahim',
  'Sofia',
  'Noah',
  'Amara',
  'Rafael',
  'Ingrid',
  'Kwame',
  'Leila',
  'Owen',
  'Yuki',
  'Nadia',
  'Diego',
  'Siobhan',
  'Arjun',
  'Beatriz',
  'Caleb',
  'Dalia',
  'Emeka',
  'Freya',
  'Gabriel',
  'Hiroshi',
  'Isabel',
  'Jonas',
  'Kavya',
  'Lorenzo',
  'Mei',
];
const LAST_NAMES = [
  'Okafor',
  'Nguyen',
  'Petrov',
  'Alvarez',
  'Chen',
  'Haddad',
  'Kowalski',
  'Mensah',
  'Rossi',
  'Sato',
  'Bergström',
  'Dubois',
  'Farouk',
  'Iyer',
  'Jensen',
  'Kim',
  'Lindqvist',
  'Moreau',
  'Nakamura',
  'Oduya',
  'Park',
  'Quinn',
  'Rahman',
  'Silva',
  'Tanaka',
  'Uribe',
  'Varga',
  'Walsh',
  'Xu',
  'Yilmaz',
  'Zhang',
  'Abbott',
  'Brennan',
  'Castillo',
  'Delgado',
  'Eriksen',
  'Fischer',
  'Gomez',
  'Hussain',
  'Ivanova',
  'Jackson',
  'Khan',
];

/**
 * Build the whole dataset. Call inside a transaction: a half-seeded database is worse than
 * an empty one.
 */
export function seedDemoUnit(db: DbLike, options: SeedOptions = {}): SeedResult {
  const rng = new Rng(options.seed ?? 20260917);
  const now = options.today ?? today();
  const historyPeriods = options.historyPeriods ?? 13; // ~6 months of 14-day periods
  const counts: Record<string, number> = {};
  const bump = (key: string, by = 1) => {
    counts[key] = (counts[key] ?? 0) + by;
  };

  // --- Calendar anchors -----------------------------------------------------
  // The upcoming draft starts next Sunday; history runs back from there in whole periods.
  const daysToSunday = (7 - weekdayOf(now)) % 7 || 7;
  const draftStart = addDays(now, daysToSunday);
  const draftEnd = addDays(draftStart, 6 * 7 - 1);
  const historyStart = addDays(draftStart, -14 * historyPeriods);

  // --- Unit -----------------------------------------------------------------
  const unit = createUnit(
    db,
    {
      name: '4 West Medical-Surgical',
      unitType: 'Medical-Surgical',
      payPeriodDays: 14,
      payPeriodAnchor: historyStart,
    },
    ACTOR,
  );
  bump('unit');

  // --- Shift types ----------------------------------------------------------
  const st = (
    name: string,
    abbreviation: string,
    startTime: string,
    durationHours: number,
    extra: Partial<ShiftType>,
    sortOrder: number,
  ): ShiftType =>
    createShiftType(
      db,
      {
        unitId: unit.id,
        name,
        abbreviation,
        startTime,
        durationHours,
        isNight: false,
        isOnCall: false,
        color: '#64748b',
        sortOrder,
        active: true,
        ...extra,
      },
      ACTOR,
    );
  const DAY12 = st('Day 12', 'D12', '07:00', 12, { color: '#f59e0b' }, 1);
  const NIGHT12 = st('Night 12', 'N12', '19:00', 12, { isNight: true, color: '#4f46e5' }, 2);
  const DAY8 = st('Day 8', 'D8', '07:00', 8, { color: '#10b981' }, 3);
  const EVE8 = st('Evening 8', 'E8', '15:00', 8, { color: '#f97316' }, 4);
  const NIGHT8 = st('Night 8', 'N8', '23:00', 8, { isNight: true, color: '#6366f1' }, 5);
  const ONCALL = st('On call', 'OC', '19:00', 12, { isOnCall: true, color: '#94a3b8' }, 6);
  bump('shiftType', 6);

  // --- Credentials (no repository yet; direct insert) -----------------------
  const cred = (code: string, name: string, tracksExpiry = true): Id => {
    const id = ids.credential();
    db.insert(s.credential).values({ id, code, name, tracksExpiry }).run();
    bump('credential');
    return id;
  };
  const BLS = cred('BLS', 'Basic Life Support');
  const ACLS = cred('ACLS', 'Advanced Cardiac Life Support');
  const PALS = cred('PALS', 'Pediatric Advanced Life Support');
  const PRECEPTOR = cred('PRECEPTOR', 'Preceptor certified', false);

  // Every night shift needs one ACLS RN; the two 12-hour shifts each need a preceptor for the
  // novices. The 8-hour supplements overlap the 12s, so the preceptor on the 12 covers them.
  createShiftCredentialRequirement(
    db,
    { unitId: unit.id, shiftTypeId: NIGHT12.id, role: 'RN', credentialId: ACLS, minCount: 1 },
    ACTOR,
  );
  for (const shiftType of [DAY12, NIGHT12]) {
    createShiftCredentialRequirement(
      db,
      {
        unitId: unit.id,
        shiftTypeId: shiftType.id,
        role: null,
        credentialId: PRECEPTOR,
        minCount: 1,
      },
      ACTOR,
    );
  }
  bump('shiftCredentialRequirement', 3);

  // --- Acuity ---------------------------------------------------------------
  const tier = (name: string, level: number, careHoursPerPatientDay: number): AcuityTier =>
    createAcuityTier(db, { unitId: unit.id, name, level, careHoursPerPatientDay }, ACTOR);
  const ROUTINE = tier('Routine', 1, 4);
  const MODERATE = tier('Moderate', 2, 6);
  const HIGH = tier('High', 3, 9);
  bump('acuityTier', 3);

  const ratio = (role: NurseRole, tierId: Id | null, max: number, citation?: string) =>
    createRatioRule(
      db,
      {
        unitId: unit.id,
        role,
        acuityTierId: tierId,
        maxPatientsPerNurse: max,
        citation,
        active: true,
      },
      ACTOR,
    );
  ratio('RN', ROUTINE.id, 5, 'Example: CA Title 22 §70217 med-surg 1:5');
  ratio('RN', MODERATE.id, 4, 'Example: telemetry 1:4');
  ratio('RN', HIGH.id, 2, 'Example: step-down 1:2');
  // No LPN ratio: on a med-surg unit LPNs work under RN supervision, so a per-LPN patient
  // ceiling would make the demand model ask for a second full complement of nurses on every
  // shift. LPN staffing is the coverage floor's business.
  bump('ratioRule', 3);
  upsertHppdTarget(db, unit.id, 6.5, ACTOR);
  bump('hppdTarget');

  // --- Coverage floors ------------------------------------------------------
  // Weekdays run heavier on the 8-hour shifts; weekends lean on 12s.
  const floor = (
    shiftType: ShiftType,
    role: NurseRole,
    weekday: Weekday,
    min: number,
    target: number,
  ) => {
    upsertCoverageRequirement(
      db,
      {
        unitId: unit.id,
        shiftTypeId: shiftType.id,
        weekday,
        date: null,
        role,
        minCount: min,
        targetCount: target,
      },
      ACTOR,
    );
    bump('coverageRequirement');
  };
  for (const wd of [0, 1, 2, 3, 4, 5, 6] as Weekday[]) {
    const weekend = wd === 0 || wd === 6;
    floor(DAY12, 'RN', wd, weekend ? 5 : 4, 5);
    floor(DAY12, 'LPN', wd, 1, 2);
    floor(DAY12, 'CNA', wd, 1, 2);
    floor(NIGHT12, 'RN', wd, 3, 4);
    floor(NIGHT12, 'LPN', wd, 1, 1);
    floor(NIGHT12, 'CNA', wd, 1, 1);
    if (!weekend) {
      floor(DAY8, 'RN', wd, 1, 2);
      floor(EVE8, 'RN', wd, 1, 2);
      floor(NIGHT8, 'RN', wd, 1, 1);
    }
    floor(ONCALL, 'RN', wd, 1, 1);
  }

  // --- Holidays -------------------------------------------------------------
  const year = Number(draftStart.slice(0, 4));
  for (const [date, name, isMajor] of [
    [`${year}-01-01`, "New Year's Day", true],
    [`${year}-05-25`, 'Memorial Day', false],
    [`${year}-07-04`, 'Independence Day', true],
    [`${year}-09-07`, 'Labor Day', false],
    [`${year}-11-26`, 'Thanksgiving', true],
    [`${year}-12-25`, 'Christmas Day', true],
    [`${year + 1}-01-01`, "New Year's Day", true],
  ] as const) {
    createHoliday(db, { unitId: unit.id, date: isoDate(date), name, isMajor }, ACTOR);
    bump('holiday');
  }

  // --- Rule set -------------------------------------------------------------
  const base = defaultRuleSet(unit.id);
  const ruleSet = saveRuleSet(
    db,
    {
      unitId: unit.id,
      name: base.name,
      configs: base.configs,
      weekendDefinition: DEFAULT_WEEKEND,
      fairnessWeights: base.fairnessWeights,
    },
    ACTOR,
  );
  bump('ruleSet');

  // --- Nurses ---------------------------------------------------------------
  const traits: Trait[] = [];
  const firstNames = rng.shuffle(FIRST_NAMES);
  const lastNames = rng.shuffle(LAST_NAMES);
  // The role mix is dealt, not drawn: the floors below need about ten RNs, two LPNs and two
  // CNAs on the unit every day, and a random draw that lands on one CNA would make the demo
  // unstaffable by construction rather than by any decision the solver could explain.
  const roles = rng.shuffle<NurseRole>([
    ...Array.from({ length: 30 }, () => 'RN' as const),
    ...Array.from({ length: 7 }, () => 'LPN' as const),
    ...Array.from({ length: 5 }, () => 'CNA' as const),
  ]);
  // Employment is dealt for the same reason: the contracted hours have to add up to the
  // demand, and eight zero-hour RNs in one draw would not.
  const employmentTypes = rng.shuffle<EmploymentType>([
    ...Array.from({ length: 25 }, () => 'full_time' as const),
    ...Array.from({ length: 10 }, () => 'part_time' as const),
    ...Array.from({ length: 5 }, () => 'per_diem' as const),
    ...Array.from({ length: 2 }, () => 'agency' as const),
  ]);
  for (let i = 0; i < 42; i++) {
    const role = roles[i]!;
    const employmentType = employmentTypes[i]!;
    const fte =
      employmentType === 'full_time'
        ? 1
        : employmentType === 'part_time'
          ? rng.pick([0.6, 0.8])
          : 0;
    const seniorityDate = addDays(now, -rng.nextInt(90, 20 * 365));
    // A full-time 12-hour nurse works three 12s a week — 72 hours a period — which is what a
    // 40-hour overtime threshold allows; only 8-hour nurses can reach 80 without overtime.
    const shiftLength: 8 | 12 = rng.chance(0.8) ? 12 : 8;
    const contractedHoursPerPeriod = Math.round(fte * (shiftLength === 12 ? 72 : 80));
    const isNovice = rng.chance(0.15) && employmentType !== 'agency';
    const nurse = createNurse(
      db,
      {
        unitId: unit.id,
        employeeId: `E${String(1001 + i)}`,
        firstName: firstNames[i]!,
        lastName: lastNames[i]!,
        role,
        employmentType,
        fte,
        contractedHoursPerPeriod,
        seniorityDate,
        isChargeEligible:
          role === 'RN' &&
          !isNovice &&
          traits.filter((t) => t.nurse.isChargeEligible).length < 20 &&
          rng.chance(0.5),
        isNovice,
        isFloatEligible: rng.chance(0.7),
        phone: `555-01${String(i).padStart(2, '0')}`,
        active: true,
      },
      ACTOR,
    );
    bump('nurse');
    const perPeriodHours = fte > 0 ? contractedHoursPerPeriod : rng.pick([24, 36]);
    traits.push({
      nurse,
      shiftLength,
      // Skewed on purpose: a few nurses carry most nights and weekends.
      nightAffinity: rng.chance(0.25) ? rng.nextInt(4, 8) : rng.nextInt(1, 2),
      weekendAffinity: rng.chance(0.3) ? rng.nextInt(3, 6) : 1,
      targetShiftsPerPeriod: Math.max(1, Math.round(perPeriodHours / shiftLength)),
    });
  }

  // --- Credentials per nurse ------------------------------------------------
  let acls = 0;
  const expiringInDraft = rng.shuffle(traits.filter((t) => t.nurse.role === 'RN')).slice(0, 3);
  for (const t of traits) {
    grantCredential(
      db,
      { nurseId: t.nurse.id, credentialId: BLS, expiresOn: addDays(now, rng.nextInt(120, 700)) },
      ACTOR,
    );
    bump('nurseCredential');
    if (t.nurse.role === 'RN' && (expiringInDraft.includes(t) || rng.chance(0.7))) {
      // Deliberately expire a few inside the draft period so the compliance alert fires.
      const expiresOn = expiringInDraft.includes(t)
        ? addDays(draftStart, rng.nextInt(3, 35))
        : addDays(now, rng.nextInt(120, 700));
      grantCredential(db, { nurseId: t.nurse.id, credentialId: ACLS, expiresOn }, ACTOR);
      bump('nurseCredential');
      acls++;
    }
    if (t.nurse.role === 'RN' && rng.chance(0.2)) {
      grantCredential(
        db,
        { nurseId: t.nurse.id, credentialId: PALS, expiresOn: addDays(now, rng.nextInt(120, 700)) },
        ACTOR,
      );
      bump('nurseCredential');
    }
    if (!t.nurse.isNovice && rng.chance(0.5)) {
      grantCredential(db, { nurseId: t.nurse.id, credentialId: PRECEPTOR }, ACTOR);
      bump('nurseCredential');
    }
  }
  counts.aclsHolders = acls;
  counts.aclsExpiringInDraft = expiringInDraft.length;

  // --- Preferences ----------------------------------------------------------
  for (const t of traits) {
    const prefs: Preference[] = [];
    if (t.nightAffinity >= 4) {
      prefs.push({
        id: ids.preference(),
        nurseId: t.nurse.id,
        kind: 'prefer_shift_type',
        shiftTypeId: NIGHT12.id,
        weight: 4,
      });
    } else if (rng.chance(0.5)) {
      prefs.push({
        id: ids.preference(),
        nurseId: t.nurse.id,
        kind: 'avoid_shift_type',
        shiftTypeId: NIGHT12.id,
        weight: rng.nextInt(2, 5),
      });
    }
    prefs.push({
      id: ids.preference(),
      nurseId: t.nurse.id,
      kind: 'weekend_appetite',
      level: t.weekendAffinity >= 3 ? 1 : rng.pick([-1, 0]),
      weight: rng.nextInt(1, 5),
    });
    if (rng.chance(0.4)) {
      prefs.push({
        id: ids.preference(),
        nurseId: t.nurse.id,
        kind: 'preferred_block_length',
        shifts: rng.pick([2, 3, 4]),
        weight: rng.nextInt(1, 3),
      });
    }
    if (rng.chance(0.3)) {
      prefs.push({
        id: ids.preference(),
        nurseId: t.nurse.id,
        kind: 'avoid_weekday',
        weekday: rng.pick([1, 3, 5]) as Weekday,
        weight: rng.nextInt(1, 3),
      });
    }
    replaceNursePreferences(db, t.nurse.id, prefs, ACTOR);
    bump('preference', prefs.length);
  }

  // --- Pay (no repositories yet; direct insert) -----------------------------
  const rateStart = addDays(historyStart, -30);
  for (const [role, rate] of [
    ['RN', 48],
    ['LPN', 31],
    ['CNA', 22],
  ] as const) {
    db.insert(s.payRate)
      .values({
        id: ids.payRate(),
        nurseId: null,
        role,
        hourlyRate: rate,
        effectiveFrom: rateStart,
      })
      .run();
    bump('payRate');
  }
  for (const t of traits) {
    if (t.nurse.employmentType === 'agency') {
      db.insert(s.payRate)
        .values({
          id: ids.payRate(),
          nurseId: t.nurse.id,
          role: null,
          hourlyRate: 95,
          effectiveFrom: rateStart,
        })
        .run();
      bump('payRate');
    } else if (rng.chance(0.25)) {
      const base = t.nurse.role === 'RN' ? 48 : t.nurse.role === 'LPN' ? 31 : 22;
      db.insert(s.payRate)
        .values({
          id: ids.payRate(),
          nurseId: t.nurse.id,
          role: null,
          hourlyRate: base + rng.nextInt(2, 12),
          effectiveFrom: rateStart,
        })
        .run();
      bump('payRate');
    }
  }
  for (const [kind, mode, amount] of [
    ['night', 'flat', 4.5],
    ['weekend', 'flat', 3],
    ['holiday', 'multiplier', 1.5],
    ['charge', 'flat', 2.5],
    ['on_call', 'flat', 6],
    ['agency', 'multiplier', 1.0],
  ] as const) {
    db.insert(s.differential)
      .values({ id: ids.differential(), unitId: unit.id, kind, mode, amount, active: true })
      .run();
    bump('differential');
  }
  db.insert(s.overtimeRule)
    .values({
      id: ids.overtimeRule(),
      unitId: unit.id,
      basis: 'weekly',
      thresholdHours: 40,
      multiplier: 1.5,
      active: true,
    })
    .run();
  bump('overtimeRule');

  // --- Census forecasts (no repository yet; direct insert) ------------------
  const forecastFor = (date: IsoDate, shiftType: ShiftType, withActual: boolean) => {
    const dayIndex = datesInRange(historyStart, date).length;
    // Weekday/weekend rhythm plus a slow seasonal drift.
    const seasonal = Math.round(3 * Math.sin(dayIndex / 30));
    const base = (isWeekendDate(date) ? 14 : 16) + seasonal + (shiftType.isNight ? -2 : 0);
    const projected = Math.max(10, base + rng.nextInt(-2, 2));
    const high = rng.nextInt(1, 3);
    const moderate = rng.nextInt(4, 7);
    const mix = {
      [ROUTINE.id]: projected - high - moderate,
      [MODERATE.id]: moderate,
      [HIGH.id]: high,
    };
    let actual: Record<Id, number> | null = null;
    let actualCensus: number | null = null;
    if (withActual) {
      // Actuals diverge from forecast so the back-test has something to show.
      const delta = rng.nextInt(-4, 4);
      actualCensus = Math.max(10, projected + delta);
      const aHigh = Math.max(0, high + rng.nextInt(-1, 2));
      const aMod = Math.max(0, moderate + rng.nextInt(-2, 2));
      actual = {
        [ROUTINE.id]: Math.max(0, actualCensus - aHigh - aMod),
        [MODERATE.id]: aMod,
        [HIGH.id]: aHigh,
      };
    }
    db.insert(s.censusForecast)
      .values({
        id: ids.census(),
        unitId: unit.id,
        date,
        shiftTypeId: shiftType.id,
        projectedCensus: projected,
        acuityMix: mix,
        actualCensus,
        actualAcuityMix: actual,
        source: 'forecast',
      })
      .run();
    bump('censusForecast');
  };

  // --- History: published periods with plausible, uneven schedules ---------
  const historicalAssignments: Assignment[] = [];
  const staffed = (
    date: IsoDate,
    shiftType: ShiftType,
    role: NurseRole,
    need: number,
    periodId: Id,
    busyToday: Set<Id>,
    shiftsThisPeriod: Map<Id, number>,
    chargeTaken: { done: boolean },
  ) => {
    const pool = traits.filter(
      (t) =>
        t.nurse.role === role &&
        !busyToday.has(t.nurse.id) &&
        (shiftType.isOnCall || t.shiftLength === shiftType.durationHours) &&
        (shiftsThisPeriod.get(t.nurse.id) ?? 0) < t.targetShiftsPerPeriod + 1,
    );
    const weekend = isWeekendDate(date);
    for (let n = 0; n < need && pool.length > 0; n++) {
      const chosen = rng.weightedPick(
        pool.map((t) => ({
          value: t,
          weight:
            1 +
            (shiftType.isNight ? t.nightAffinity : 0) +
            (weekend ? t.weekendAffinity : 0) +
            // Under-scheduled nurses get pulled forward, keeping hours near FTE.
            Math.max(0, t.targetShiftsPerPeriod - (shiftsThisPeriod.get(t.nurse.id) ?? 0)),
        })),
      );
      pool.splice(pool.indexOf(chosen), 1);
      busyToday.add(chosen.nurse.id);
      shiftsThisPeriod.set(chosen.nurse.id, (shiftsThisPeriod.get(chosen.nurse.id) ?? 0) + 1);
      const isCharge = !chargeTaken.done && chosen.nurse.isChargeEligible && !shiftType.isOnCall;
      if (isCharge) chargeTaken.done = true;
      historicalAssignments.push(
        createAssignment(
          db,
          {
            periodId,
            nurseId: chosen.nurse.id,
            shiftTypeId: shiftType.id,
            date,
            source: 'solver',
            isCharge,
          },
          ACTOR,
        ),
      );
      bump('assignment');
    }
  };

  const shiftTypes = [DAY12, NIGHT12, DAY8, EVE8, NIGHT8, ONCALL];
  // The 12-hour shifts carry the census. The 8-hour shifts overlap them as floor-staffed
  // supplements: a forecast on each of them would make the ratio maths demand a full
  // complement of nurses for the same patients three times over.
  const forecastShiftTypes = [DAY12, NIGHT12];
  const floors: CoverageRequirement[] = db
    .select()
    .from(s.coverageRequirement)
    .all()
    .map((r) => ({
      id: r.id,
      unitId: r.unitId,
      shiftTypeId: r.shiftTypeId,
      weekday: (r.weekday ?? null) as Weekday | null,
      date: null,
      role: r.role,
      minCount: r.minCount,
      targetCount: r.targetCount,
    }));

  const ledgerInputs: UpsertFairnessLedgerInput[] = [];
  const holidayDates = new Set<IsoDate>(
    db
      .select({ d: s.holiday.date })
      .from(s.holiday)
      .all()
      .map((r) => r.d as IsoDate),
  );
  const nurses = traits.map((t) => t.nurse);
  const costContext: CostContext = {
    unit,
    payRates: listPayRatesForUnit(db, unit.id),
    differentials: listActiveDifferentials(db, unit.id),
    overtimeRules: listActiveOvertimeRules(db, unit.id),
    holidayDates,
    weekendDefinition: ruleSet.weekendDefinition,
    workWeekStartsOn: 0,
  };
  const historyCosts: number[] = [];
  const roundToThousand = (dollars: number) => Math.round(dollars / 1000) * 1000;

  for (let p = 0; p < historyPeriods; p++) {
    const start = addDays(historyStart, p * 14);
    const end = addDays(start, 13);
    const period = createPeriod(
      db,
      {
        unitId: unit.id,
        name: `Period ${start}`,
        startDate: start,
        endDate: end,
        ruleSetId: ruleSet.id,
        ruleSetVersion: ruleSet.version,
      },
      ACTOR,
    );
    bump('period');
    const shiftsThisPeriod = new Map<Id, number>();
    const periodAssignments: Assignment[] = [];
    const startIndex = historicalAssignments.length;

    for (const date of datesInRange(start, end)) {
      const busyToday = new Set<Id>();
      const wd = weekdayOf(date);
      for (const shiftType of shiftTypes) {
        if (forecastShiftTypes.includes(shiftType)) forecastFor(date, shiftType, true);
        const chargeTaken = { done: false };
        for (const role of ['RN', 'LPN', 'CNA'] as const) {
          const f = floors.find(
            (c) => c.shiftTypeId === shiftType.id && c.role === role && c.weekday === wd,
          );
          if (!f || f.minCount === 0) continue;
          staffed(
            date,
            shiftType,
            role,
            f.targetCount,
            period.id,
            busyToday,
            shiftsThisPeriod,
            chargeTaken,
          );
        }
      }
    }
    periodAssignments.push(...historicalAssignments.slice(startIndex));
    publishPeriod(db, period.id, ACTOR);

    // Budgets sit a few percent either side of what the period actually cost, so the
    // dashboard's budget-vs-actual shows both over and under without being wildly off.
    const actual = costSchedule(
      new ScheduleView({ period, assignments: periodAssignments, nurses, shiftTypes }),
      costContext,
    ).totals.total;
    historyCosts.push(actual);
    setBudget(
      db,
      unit.id,
      period.id,
      roundToThousand(actual * (0.97 + 0.07 * rng.nextFloat())),
      ACTOR,
    );
    bump('budget');

    // Ledger derived from what was actually generated, so history and scoring agree.
    for (const t of traits) {
      const mine = periodAssignments.filter((a) => a.nurseId === t.nurse.id);
      const byType = (id: Id) => mine.filter((a) => a.shiftTypeId === id).length;
      const nights = byType(NIGHT12.id) + byType(NIGHT8.id);
      const onCall = byType(ONCALL.id);
      const worked = mine.filter((a) => a.shiftTypeId !== ONCALL.id);
      const weekendKeys = new Set(
        worked
          .filter((a) => isWeekendDate(a.date))
          .map((a) => addDays(a.date, -((weekdayOf(a.date) + 1) % 7))),
      );
      const hours = worked.reduce(
        (sum, a) => sum + (shiftTypes.find((x) => x.id === a.shiftTypeId)?.durationHours ?? 0),
        0,
      );
      ledgerInputs.push({
        nurseId: t.nurse.id,
        periodId: period.id,
        periodStart: start,
        nightShifts: nights,
        weekendsWorked: weekendKeys.size,
        holidaysWorked: worked.filter((a) => holidayDates.has(a.date)).length,
        onCallShifts: onCall,
        undesirableShifts: t.nightAffinity < 4 ? nights : 0,
        totalHours: hours,
        overtimeHours: Math.max(0, hours - Math.max(t.nurse.contractedHoursPerPeriod, 1)),
        preferenceHitRate:
          t.nightAffinity >= 4
            ? Math.min(1, nights / Math.max(1, worked.length))
            : 1 - nights / Math.max(1, worked.length),
      });
    }
  }
  importFairnessLedgerEntries(db, ledgerInputs, ACTOR);
  bump('fairnessLedger', ledgerInputs.length);

  // --- Historical time off with a realistic approve/deny record -------------
  let approvedCount = 0;
  let deniedCount = 0;
  for (const t of traits) {
    const requests = rng.nextInt(0, 3);
    for (let r = 0; r < requests; r++) {
      const startOffset = rng.nextInt(0, 14 * historyPeriods - 7);
      const startDate = addDays(historyStart, startOffset);
      const req = createTimeOffRequest(
        db,
        {
          nurseId: t.nurse.id,
          startDate,
          endDate: addDays(startDate, rng.nextInt(0, 6)),
          type: rng.weightedPick([
            { value: 'pto' as const, weight: 8 },
            { value: 'education' as const, weight: 1 },
            { value: 'unpaid' as const, weight: 1 },
          ]),
        },
        ACTOR,
      );
      bump('timeOffRequest');
      // Junior nurses get denied a little more often — a bias the equity scoring should surface.
      const seniorityYears = datesInRange(t.nurse.seniorityDate, now).length / 365;
      if (rng.chance(seniorityYears < 3 ? 0.7 : 0.9)) {
        approveTimeOff(db, req.id, ACTOR);
        approvedCount++;
      } else {
        denyTimeOff(
          db,
          req.id,
          ACTOR,
          'Would have left the unit below minimum staffing that weekend',
        );
        deniedCount++;
      }
    }
  }
  counts.timeOffApproved = approvedCount;
  counts.timeOffDenied = deniedCount;

  // --- A few resolved historical call-offs with call attempts ---------------
  const callOffCandidates = rng
    .shuffle(historicalAssignments.filter((a) => a.shiftTypeId === DAY12.id))
    .slice(0, 4);
  for (const a of callOffCandidates) {
    const co = reportCallOff(db, a.id, ACTOR, rng.pick(['Sick', 'Child care', 'Car trouble']));
    bump('callOff');
    // Only nurses NOT already working that day can be phoned — otherwise the backfill
    // would collide with their existing assignment on the (nurse, date, shift) unique index.
    const workingThatDay = new Set(
      historicalAssignments.filter((x) => x.date === a.date).map((x) => x.nurseId),
    );
    const pool = rng
      .shuffle(traits.filter((t) => t.nurse.role === 'RN' && !workingThatDay.has(t.nurse.id)))
      .slice(0, rng.nextInt(2, 4));
    let coveredBy: Trait | undefined;
    for (const t of pool) {
      const outcome =
        t === pool[pool.length - 1]
          ? 'accepted'
          : rng.pick(['no_answer', 'declined', 'left_message'] as const);
      logCallAttempt(db, co.id, t.nurse.id, outcome, ACTOR);
      bump('callAttempt');
      if (outcome === 'accepted') coveredBy = t;
    }
    if (coveredBy) {
      // The absent nurse's row must go before the replacement lands, exactly as a live
      // backfill does — otherwise the fairness ledger and every downstream count still see
      // the shift as worked by someone who called off it.
      deleteAssignment(db, a.id, ACTOR, 'Called off');
      const removedIndex = historicalAssignments.findIndex((x) => x.id === a.id);
      if (removedIndex !== -1) historicalAssignments.splice(removedIndex, 1);
      const replacement = createAssignment(
        db,
        {
          periodId: a.periodId,
          nurseId: coveredBy.nurse.id,
          shiftTypeId: a.shiftTypeId,
          date: a.date,
          source: 'callout',
          isOvertime: true,
        },
        ACTOR,
      );
      bump('assignment');
      // Back into the pool immediately: a later call-off in this same loop draws its cover
      // from `historicalAssignments`, and this nurse is now busy on this date/shift too.
      historicalAssignments.push(replacement);
      markCallOffCovered(db, co.id, replacement.id, ACTOR);
    }
  }

  // --- The upcoming draft: forecasts, no assignments, pending requests ------
  const draft = createPeriod(
    db,
    {
      unitId: unit.id,
      name: `Draft ${draftStart}`,
      startDate: draftStart,
      endDate: draftEnd,
      ruleSetId: ruleSet.id,
      ruleSetVersion: ruleSet.version,
    },
    ACTOR,
  );
  bump('period');
  for (const date of datesInRange(draftStart, draftEnd)) {
    for (const shiftType of forecastShiftTypes) forecastFor(date, shiftType, false);
  }
  // Six weeks is three pay periods; budget it at the recent run rate plus a little growth.
  const recent = historyCosts.slice(-3);
  const runRate = recent.reduce((sum, c) => sum + c, 0) / Math.max(1, recent.length);
  setBudget(db, unit.id, draft.id, roundToThousand(runRate * 3 * 1.02), ACTOR);
  bump('budget');

  // The deliberate conflict: six nurses want the same weekend off, three weeks in.
  const contestedSaturday = addDays(draftStart, 20);
  const contesters = rng.shuffle(traits.filter((t) => t.nurse.role === 'RN')).slice(0, 6);
  for (const t of contesters) {
    createTimeOffRequest(
      db,
      {
        nurseId: t.nurse.id,
        startDate: addDays(contestedSaturday, -1),
        endDate: addDays(contestedSaturday, 1),
        type: 'pto',
        reason: 'Family wedding',
      },
      ACTOR,
    );
    bump('timeOffRequest');
    bump('pendingContested');
  }
  // Plus an ordinary scatter of pending requests.
  for (const t of rng.shuffle(traits).slice(0, 10)) {
    const startDate = addDays(draftStart, rng.nextInt(0, 35));
    createTimeOffRequest(
      db,
      {
        nurseId: t.nurse.id,
        startDate,
        endDate: addDays(startDate, rng.nextInt(0, 4)),
        type: 'pto',
      },
      ACTOR,
    );
    bump('timeOffRequest');
  }

  return { unitId: unit.id, draftPeriodId: draft.id, draftStart, draftEnd, counts };
}
