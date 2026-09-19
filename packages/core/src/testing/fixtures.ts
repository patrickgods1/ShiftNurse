/**
 * Test fixtures: a small, realistic unit that rule and solver tests can build scenarios on.
 *
 * Kept in `src` rather than a test folder because the demo-data seeder reuses these shapes,
 * and because a fixture that drifts from the real entity definitions is worse than none.
 */

import { type DemandInputs, deriveDemand } from '../acuity/demand.js';
import type {
  AcuityTier,
  Assignment,
  CensusForecast,
  CoverageRequirement,
  Credential,
  FairnessLedgerEntry,
  Holiday,
  HppdTarget,
  Id,
  Nurse,
  NurseCredential,
  NurseRole,
  Preference,
  RatioRule,
  SchedulePeriod,
  ShiftCredentialRequirement,
  ShiftType,
  TimeOffRequest,
  Unit,
} from '../domain/entities.js';
import { datesInRange, type IsoDate, isoDate, type Weekday } from '../domain/time.js';
import { buildRuleContext, defaultRuleSet } from '../rules/registry.js';
import type { RuleContext, RuleSet } from '../rules/types.js';
import { ScheduleView } from '../schedule/view.js';
import type { SolveCostInput, SolveInput } from '../solver/types.js';

export const UNIT_ID = 'unit-1';

export const testUnit: Unit = {
  id: UNIT_ID,
  name: '4 West Medical-Surgical',
  unitType: 'Medical-Surgical',
  payPeriodDays: 14,
  payPeriodAnchor: isoDate('2026-01-04'), // a Sunday
};

// ---------------------------------------------------------------------------
// Shift types
// ---------------------------------------------------------------------------

function shift(
  id: string,
  name: string,
  abbreviation: string,
  startTime: string,
  durationHours: number,
  extra: Partial<ShiftType> = {},
): ShiftType {
  return {
    id,
    unitId: UNIT_ID,
    name,
    abbreviation,
    startTime,
    durationHours,
    isNight: false,
    isOnCall: false,
    color: '#64748b',
    sortOrder: 0,
    active: true,
    ...extra,
  };
}

export const DAY_12 = shift('st-d12', 'Day 12', 'D12', '07:00', 12, {
  sortOrder: 1,
  color: '#f59e0b',
});
export const NIGHT_12 = shift('st-n12', 'Night 12', 'N12', '19:00', 12, {
  isNight: true,
  sortOrder: 2,
  color: '#4f46e5',
});
export const DAY_8 = shift('st-d8', 'Day 8', 'D8', '07:00', 8, { sortOrder: 3, color: '#10b981' });
export const EVENING_8 = shift('st-e8', 'Evening 8', 'E8', '15:00', 8, {
  sortOrder: 4,
  color: '#f97316',
});
export const NIGHT_8 = shift('st-n8', 'Night 8', 'N8', '23:00', 8, {
  isNight: true,
  sortOrder: 5,
  color: '#6366f1',
});
export const ON_CALL = shift('st-oc', 'On call', 'OC', '19:00', 12, {
  isOnCall: true,
  sortOrder: 6,
  color: '#94a3b8',
});

export const testShiftTypes: ShiftType[] = [DAY_12, NIGHT_12, DAY_8, EVENING_8, NIGHT_8, ON_CALL];

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export const CRED_BLS: Credential = {
  id: 'cred-bls',
  code: 'BLS',
  name: 'Basic Life Support',
  tracksExpiry: true,
};
export const CRED_ACLS: Credential = {
  id: 'cred-acls',
  code: 'ACLS',
  name: 'Advanced Cardiac Life Support',
  tracksExpiry: true,
};
export const CRED_PRECEPTOR: Credential = {
  id: 'cred-precept',
  code: 'PRECEPTOR',
  name: 'Preceptor certified',
  tracksExpiry: false,
};

export const testCredentials: Credential[] = [CRED_BLS, CRED_ACLS, CRED_PRECEPTOR];

// ---------------------------------------------------------------------------
// Acuity
// ---------------------------------------------------------------------------

export const TIER_ROUTINE: AcuityTier = {
  id: 'tier-1',
  unitId: UNIT_ID,
  name: 'Routine',
  level: 1,
  careHoursPerPatientDay: 4,
};
export const TIER_MODERATE: AcuityTier = {
  id: 'tier-2',
  unitId: UNIT_ID,
  name: 'Moderate',
  level: 2,
  careHoursPerPatientDay: 6,
};
export const TIER_HIGH: AcuityTier = {
  id: 'tier-3',
  unitId: UNIT_ID,
  name: 'High',
  level: 3,
  careHoursPerPatientDay: 9,
};

export const testAcuityTiers: AcuityTier[] = [TIER_ROUTINE, TIER_MODERATE, TIER_HIGH];

/** Example ratios in the shape of California Title 22 med-surg rules. Configuration, not law. */
export const testRatioRules: RatioRule[] = [
  {
    id: 'ratio-rn-routine',
    unitId: UNIT_ID,
    role: 'RN',
    acuityTierId: TIER_ROUTINE.id,
    maxPatientsPerNurse: 5,
    citation: 'Example: med-surg 1:5',
    active: true,
  },
  {
    id: 'ratio-rn-moderate',
    unitId: UNIT_ID,
    role: 'RN',
    acuityTierId: TIER_MODERATE.id,
    maxPatientsPerNurse: 4,
    active: true,
  },
  {
    id: 'ratio-rn-high',
    unitId: UNIT_ID,
    role: 'RN',
    acuityTierId: TIER_HIGH.id,
    maxPatientsPerNurse: 2,
    citation: 'Example: step-down 1:2',
    active: true,
  },
];

export const testHppdTarget: HppdTarget = { id: 'hppd-1', unitId: UNIT_ID, targetHours: 6.5 };

// ---------------------------------------------------------------------------
// Nurses
// ---------------------------------------------------------------------------

let nurseCounter = 0;

export function makeNurse(overrides: Partial<Nurse> = {}): Nurse {
  nurseCounter++;
  const id = overrides.id ?? `nurse-${nurseCounter}`;
  return {
    id,
    unitId: UNIT_ID,
    employeeId: `E${String(nurseCounter).padStart(4, '0')}`,
    firstName: `Nurse${nurseCounter}`,
    lastName: 'Test',
    role: 'RN',
    employmentType: 'full_time',
    fte: 1,
    contractedHoursPerPeriod: 72,
    seniorityDate: isoDate('2020-01-01'),
    isChargeEligible: false,
    isNovice: false,
    isFloatEligible: true,
    active: true,
    ...overrides,
  };
}

/** Reset the auto-incrementing nurse counter so ids are stable within a test file. */
export function resetFixtureCounters(): void {
  nurseCounter = 0;
}

// ---------------------------------------------------------------------------
// Scenario builder
// ---------------------------------------------------------------------------

export interface ScenarioOptions {
  startDate?: IsoDate;
  endDate?: IsoDate;
  nurses?: Nurse[];
  shiftTypes?: ShiftType[];
  assignments?: Assignment[];
  priorAssignments?: Assignment[];
  timeOff?: TimeOffRequest[];
  nurseCredentials?: NurseCredential[];
  shiftCredentialRequirements?: ShiftCredentialRequirement[];
  coverageRequirements?: CoverageRequirement[];
  censusForecasts?: CensusForecast[];
  holidays?: Holiday[];
  ratioRules?: RatioRule[];
  acuityTiers?: AcuityTier[];
  hppdTarget?: HppdTarget;
  unit?: Unit;
}

export interface Scenario {
  unit: Unit;
  period: SchedulePeriod;
  schedule: ScheduleView;
  ctx: RuleContext;
  ruleSet: RuleSet;
  nurses: Nurse[];
  shiftTypes: ShiftType[];
  dates: IsoDate[];
}

/** Assemble a complete, evaluable scenario from partial inputs. */
export function scenario(options: ScenarioOptions = {}): Scenario {
  const unit = options.unit ?? testUnit;
  const startDate = options.startDate ?? isoDate('2026-01-04');
  const endDate = options.endDate ?? isoDate('2026-01-17');
  const nurses = options.nurses ?? [makeNurse()];
  const shiftTypes = options.shiftTypes ?? testShiftTypes;
  const dates = datesInRange(startDate, endDate);

  const period: SchedulePeriod = {
    id: 'period-1',
    unitId: unit.id,
    name: 'Test period',
    startDate,
    endDate,
    status: 'draft',
    ruleSetId: 'ruleset-test',
    ruleSetVersion: 1,
  };

  const demandInputs: DemandInputs = {
    shiftTypes,
    acuityTiers: options.acuityTiers ?? testAcuityTiers,
    ratioRules: options.ratioRules ?? testRatioRules,
    coverageRequirements: options.coverageRequirements ?? [],
    censusForecasts: options.censusForecasts ?? [],
    ...(options.hppdTarget !== undefined ? { hppdTarget: options.hppdTarget } : {}),
  };

  // Demand must cover the lookback tail too, or prior assignments have nothing to sit against.
  const priorDates = (options.priorAssignments ?? []).map((a) => a.date);
  const allDates = [...new Set([...priorDates, ...dates])].sort() as IsoDate[];
  const demand = deriveDemand(allDates, demandInputs);

  const ctx = buildRuleContext({
    unit,
    demand,
    nurses,
    shiftTypes,
    timeOff: options.timeOff ?? [],
    credentials: testCredentials,
    nurseCredentials: options.nurseCredentials ?? [],
    shiftCredentialRequirements: options.shiftCredentialRequirements ?? [],
    holidays: options.holidays ?? [],
  });

  const schedule = new ScheduleView({
    period,
    assignments: options.assignments ?? [],
    ...(options.priorAssignments ? { priorAssignments: options.priorAssignments } : {}),
    nurses,
    shiftTypes,
  });

  return {
    unit,
    period,
    schedule,
    ctx,
    ruleSet: defaultRuleSet(unit.id),
    nurses,
    shiftTypes,
    dates,
  };
}

// ---------------------------------------------------------------------------
// Solver input
// ---------------------------------------------------------------------------

export interface SolveScenarioOptions extends ScenarioOptions {
  preferences?: Preference[];
  ledgerHistory?: FairnessLedgerEntry[];
  cost?: SolveCostInput;
  ruleSet?: RuleSet;
}

/**
 * The same scenario, packaged as the plain-data `SolveInput` the solver takes. Built on top of
 * `scenario()` so a solver test and a rule test describing the same unit agree on every row.
 */
export function solveInputFrom(options: SolveScenarioOptions = {}): SolveInput {
  const s = scenario(options);
  return {
    unit: s.unit,
    period: s.period,
    ruleSet: options.ruleSet ?? s.ruleSet,
    nurses: s.nurses,
    shiftTypes: s.shiftTypes,
    demand: s.ctx.demand.all(),
    assignments: options.assignments ?? [],
    priorAssignments: options.priorAssignments ?? [],
    timeOff: options.timeOff ?? [],
    credentials: testCredentials,
    nurseCredentials: options.nurseCredentials ?? [],
    shiftCredentialRequirements: options.shiftCredentialRequirements ?? [],
    holidays: options.holidays ?? [],
    preferences: options.preferences ?? [],
    ledgerHistory: options.ledgerHistory ?? [],
    ...(options.cost ? { cost: options.cost } : {}),
  };
}

// ---------------------------------------------------------------------------
// Small builders
// ---------------------------------------------------------------------------

let assignmentCounter = 0;

export function assign(
  nurseId: Id,
  shiftType: ShiftType,
  date: string,
  overrides: Partial<Assignment> = {},
): Assignment {
  assignmentCounter++;
  return {
    id: overrides.id ?? `a-${assignmentCounter}`,
    periodId: 'period-1',
    nurseId,
    shiftTypeId: shiftType.id,
    date: isoDate(date),
    source: 'manual',
    isLocked: false,
    isCharge: false,
    isOvertime: false,
    ...overrides,
  };
}

/** Assign one nurse to the same shift type across a run of dates. */
export function assignRun(
  nurseId: Id,
  shiftType: ShiftType,
  startDate: string,
  days: number,
  overrides: Partial<Assignment> = {},
): Assignment[] {
  const start = isoDate(startDate);
  const dates = datesInRange(start, addDaysLocal(start, days - 1));
  return dates.map((date) => assign(nurseId, shiftType, date, overrides));
}

function addDaysLocal(date: IsoDate, days: number): IsoDate {
  const ms = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10) as IsoDate;
}

export function timeOff(
  nurseId: Id,
  startDate: string,
  endDate: string,
  overrides: Partial<TimeOffRequest> = {},
): TimeOffRequest {
  return {
    id: overrides.id ?? `to-${nurseId}-${startDate}`,
    nurseId,
    startDate: isoDate(startDate),
    endDate: isoDate(endDate),
    type: 'pto',
    status: 'approved',
    enteredBy: 'manager',
    submittedAt: Date.parse('2025-11-01T00:00:00Z'),
    ...overrides,
  };
}

export function coverage(
  shiftType: ShiftType,
  role: NurseRole,
  minCount: number,
  targetCount: number,
  weekday: Weekday | null = null,
  date: IsoDate | null = null,
): CoverageRequirement {
  return {
    id: `cov-${shiftType.id}-${role}-${weekday ?? date ?? 'all'}`,
    unitId: UNIT_ID,
    shiftTypeId: shiftType.id,
    weekday,
    date,
    role,
    minCount,
    targetCount,
  };
}

/** Coverage floors for every weekday at once. */
export function coverageAllWeek(
  shiftType: ShiftType,
  role: NurseRole,
  minCount: number,
  targetCount = minCount,
): CoverageRequirement[] {
  return ([0, 1, 2, 3, 4, 5, 6] as Weekday[]).map((weekday) =>
    coverage(shiftType, role, minCount, targetCount, weekday),
  );
}

export function census(
  date: string,
  shiftType: ShiftType,
  acuityMix: Record<Id, number>,
  overrides: Partial<CensusForecast> = {},
): CensusForecast {
  const projectedCensus = Object.values(acuityMix).reduce((sum, n) => sum + n, 0);
  return {
    id: `census-${date}-${shiftType.id}`,
    unitId: UNIT_ID,
    date: isoDate(date),
    shiftTypeId: shiftType.id,
    projectedCensus,
    acuityMix,
    source: 'manual',
    ...overrides,
  };
}

export function nurseCredential(
  nurseId: Id,
  credential: Credential,
  overrides: Partial<NurseCredential> = {},
): NurseCredential {
  return {
    id: `nc-${nurseId}-${credential.id}`,
    nurseId,
    credentialId: credential.id,
    ...overrides,
  };
}

export function credentialRequirement(
  credential: Credential,
  minCount: number,
  options: { shiftType?: ShiftType; role?: NurseRole } = {},
): ShiftCredentialRequirement {
  return {
    id: `scr-${credential.id}-${options.shiftType?.id ?? 'all'}`,
    unitId: UNIT_ID,
    shiftTypeId: options.shiftType?.id ?? null,
    role: options.role ?? null,
    credentialId: credential.id,
    minCount,
  };
}
