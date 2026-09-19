/**
 * Drizzle schema — the persistent mirror of `@shiftnurse/core`'s domain entities.
 *
 * ## Conventions, and why
 *
 * - **Ids are text.** Application-generated, not autoincrement, so a record can be created
 *   in memory (by the solver, by an importer) and persisted later without a round trip.
 * - **`IsoDate` columns are text** in `YYYY-MM-DD` form. They sort and compare correctly as
 *   strings, which is the whole reason the domain uses that format.
 * - **`Timestamp` columns are integers** (epoch millis). These are real instants — when a
 *   call-off was phoned in, when a decision was made — and are deliberately a different type
 *   from schedule geometry, which lives on the wall-clock timeline and never touches a
 *   timestamp. Mixing the two is the bug this separation exists to prevent.
 * - **Booleans are integers** with Drizzle's boolean mode; SQLite has no boolean type.
 * - **JSON columns** are used only where the shape is genuinely open (acuity mixes keyed by
 *   tier id, rule parameters, audit snapshots). Anything queried or constrained gets a column.
 *
 * This file is the counterpart of `core/src/domain/entities.ts`. The two must move together:
 * a field added there needs a column and a migration here.
 */

import type {
  AssignmentSource,
  AuditAction,
  CallOffStatus,
  CallOutcome,
  DifferentialKind,
  EmploymentType,
  Id,
  IsoDate,
  NurseRole,
  PeriodStatus,
  PreferenceKind,
  RequestOrigin,
  ScheduleChangeKind,
  ScheduleChangeSource,
  ShiftSwapKind,
  ShiftSwapStatus,
  TimeOffStatus,
  TimeOffType,
} from '@shiftnurse/core';
import { DEFAULT_FAIRNESS_WEIGHTS } from '@shiftnurse/core';
import { relations, sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/** Epoch-millis column for real instants. */
const timestamp = (name: string) => integer(name);
/** `YYYY-MM-DD` calendar date. Text so lexical order is chronological order. */
const isoDate = (name: string) => text(name);
const bool = (name: string) => integer(name, { mode: 'boolean' });

// ---------------------------------------------------------------------------
// Unit & shift types
// ---------------------------------------------------------------------------

export const unit = sqliteTable('unit', {
  id: text('id').primaryKey().$type<Id>(),
  name: text('name').notNull(),
  unitType: text('unit_type').notNull(),
  payPeriodDays: integer('pay_period_days').notNull(),
  payPeriodAnchor: isoDate('pay_period_anchor').notNull(),
});

export const shiftType = sqliteTable(
  'shift_type',
  {
    id: text('id').primaryKey().$type<Id>(),
    unitId: text('unit_id')
      .notNull()
      .references(() => unit.id, { onDelete: 'cascade' })
      .$type<Id>(),
    name: text('name').notNull(),
    abbreviation: text('abbreviation').notNull(),
    startTime: text('start_time').notNull(),
    durationHours: real('duration_hours').notNull(),
    isNight: bool('is_night').notNull().default(false),
    isOnCall: bool('is_on_call').notNull().default(false),
    color: text('color').notNull().default('#64748b'),
    sortOrder: integer('sort_order').notNull().default(0),
    active: bool('active').notNull().default(true),
  },
  (t) => [index('shift_type_unit_idx').on(t.unitId)],
);

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

export const nurse = sqliteTable(
  'nurse',
  {
    id: text('id').primaryKey().$type<Id>(),
    unitId: text('unit_id')
      .notNull()
      .references(() => unit.id, { onDelete: 'cascade' })
      .$type<Id>(),
    employeeId: text('employee_id').notNull(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    role: text('role').notNull().$type<NurseRole>(),
    employmentType: text('employment_type').notNull().$type<EmploymentType>(),
    fte: real('fte').notNull(),
    contractedHoursPerPeriod: real('contracted_hours_per_period').notNull(),
    seniorityDate: isoDate('seniority_date').notNull(),
    isChargeEligible: bool('is_charge_eligible').notNull().default(false),
    isNovice: bool('is_novice').notNull().default(false),
    isFloatEligible: bool('is_float_eligible').notNull().default(true),
    phone: text('phone'),
    email: text('email'),
    active: bool('active').notNull().default(true),
    notes: text('notes'),
  },
  (t) => [
    uniqueIndex('nurse_employee_id_idx').on(t.unitId, t.employeeId),
    index('nurse_unit_active_idx').on(t.unitId, t.active),
    // Seniority ranking is read on every fairness calculation.
    index('nurse_seniority_idx').on(t.unitId, t.seniorityDate),
  ],
);

export const credential = sqliteTable('credential', {
  id: text('id').primaryKey().$type<Id>(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  tracksExpiry: bool('tracks_expiry').notNull().default(true),
});

export const nurseCredential = sqliteTable(
  'nurse_credential',
  {
    id: text('id').primaryKey().$type<Id>(),
    nurseId: text('nurse_id')
      .notNull()
      .references(() => nurse.id, { onDelete: 'cascade' })
      .$type<Id>(),
    credentialId: text('credential_id')
      .notNull()
      .references(() => credential.id, { onDelete: 'cascade' })
      .$type<Id>(),
    issuedOn: isoDate('issued_on'),
    expiresOn: isoDate('expires_on'),
  },
  (t) => [
    uniqueIndex('nurse_credential_unique_idx').on(t.nurseId, t.credentialId),
    // Drives the "expiring inside this period" compliance alert.
    index('nurse_credential_expiry_idx').on(t.expiresOn),
  ],
);

export const shiftCredentialRequirement = sqliteTable(
  'shift_credential_requirement',
  {
    id: text('id').primaryKey().$type<Id>(),
    unitId: text('unit_id')
      .notNull()
      .references(() => unit.id, { onDelete: 'cascade' })
      .$type<Id>(),
    // Null widens the scope: null shift type means every shift, null role means any role.
    shiftTypeId: text('shift_type_id')
      .references(() => shiftType.id, { onDelete: 'cascade' })
      .$type<Id>(),
    role: text('role').$type<NurseRole>(),
    credentialId: text('credential_id')
      .notNull()
      .references(() => credential.id, { onDelete: 'cascade' })
      .$type<Id>(),
    minCount: integer('min_count').notNull().default(1),
  },
  (t) => [index('shift_cred_req_unit_idx').on(t.unitId)],
);

/**
 * Preferences are a discriminated union in the domain. Rather than a JSON blob, each variant's
 * payload gets its own nullable column: the preferences editor filters by shift type and
 * weekday, and a blob would make that a table scan plus a parse.
 */
export const preference = sqliteTable(
  'preference',
  {
    id: text('id').primaryKey().$type<Id>(),
    nurseId: text('nurse_id')
      .notNull()
      .references(() => nurse.id, { onDelete: 'cascade' })
      .$type<Id>(),
    kind: text('kind').notNull().$type<PreferenceKind>(),
    weight: real('weight').notNull().default(1),
    /** `prefer_shift_type` / `avoid_shift_type` */
    shiftTypeId: text('shift_type_id')
      .references(() => shiftType.id, { onDelete: 'cascade' })
      .$type<Id>(),
    /** `prefer_weekday` / `avoid_weekday` — 0 = Sunday */
    weekday: integer('weekday'),
    /** `weekend_appetite` — -1 none, 0 neutral, +1 wants weekends */
    level: real('level'),
    /** `preferred_block_length` — consecutive shifts before days off */
    blockShifts: integer('block_shifts'),
  },
  (t) => [index('preference_nurse_idx').on(t.nurseId)],
);

// ---------------------------------------------------------------------------
// Time off
// ---------------------------------------------------------------------------

export const timeOffRequest = sqliteTable(
  'time_off_request',
  {
    id: text('id').primaryKey().$type<Id>(),
    nurseId: text('nurse_id')
      .notNull()
      .references(() => nurse.id, { onDelete: 'cascade' })
      .$type<Id>(),
    startDate: isoDate('start_date').notNull(),
    endDate: isoDate('end_date').notNull(),
    type: text('type').notNull().$type<TimeOffType>(),
    status: text('status').notNull().$type<TimeOffStatus>(),
    /** Always 'manager' in v1; the seam that lets nurse self-service reuse this table. */
    enteredBy: text('entered_by').notNull().default('manager').$type<RequestOrigin>(),
    submittedAt: timestamp('submitted_at').notNull(),
    decidedAt: timestamp('decided_at'),
    decidedBy: text('decided_by'),
    reason: text('reason'),
    /** Required on denial. This text gets quoted in grievances. */
    decisionReason: text('decision_reason'),
  },
  (t) => [
    index('time_off_nurse_idx').on(t.nurseId),
    // The overlapping-requests heatmap and the solver's availability matrix both scan by date.
    index('time_off_range_idx').on(t.startDate, t.endDate),
    index('time_off_status_idx').on(t.status),
  ],
);

// ---------------------------------------------------------------------------
// Acuity & demand
// ---------------------------------------------------------------------------

export const acuityTier = sqliteTable('acuity_tier', {
  id: text('id').primaryKey().$type<Id>(),
  unitId: text('unit_id')
    .notNull()
    .references(() => unit.id, { onDelete: 'cascade' })
    .$type<Id>(),
  name: text('name').notNull(),
  level: integer('level').notNull(),
  careHoursPerPatientDay: real('care_hours_per_patient_day').notNull(),
});

export const ratioRule = sqliteTable(
  'ratio_rule',
  {
    id: text('id').primaryKey().$type<Id>(),
    unitId: text('unit_id')
      .notNull()
      .references(() => unit.id, { onDelete: 'cascade' })
      .$type<Id>(),
    role: text('role').notNull().$type<NurseRole>(),
    /** Null applies the rule to every acuity tier. */
    acuityTierId: text('acuity_tier_id')
      .references(() => acuityTier.id, { onDelete: 'cascade' })
      .$type<Id>(),
    maxPatientsPerNurse: real('max_patients_per_nurse').notNull(),
    citation: text('citation'),
    active: bool('active').notNull().default(true),
  },
  (t) => [index('ratio_rule_unit_idx').on(t.unitId, t.active)],
);

export const hppdTarget = sqliteTable('hppd_target', {
  id: text('id').primaryKey().$type<Id>(),
  unitId: text('unit_id')
    .notNull()
    .references(() => unit.id, { onDelete: 'cascade' })
    .$type<Id>(),
  targetHours: real('target_hours').notNull(),
});

export const censusForecast = sqliteTable(
  'census_forecast',
  {
    id: text('id').primaryKey().$type<Id>(),
    unitId: text('unit_id')
      .notNull()
      .references(() => unit.id, { onDelete: 'cascade' })
      .$type<Id>(),
    date: isoDate('date').notNull(),
    shiftTypeId: text('shift_type_id')
      .notNull()
      .references(() => shiftType.id, { onDelete: 'cascade' })
      .$type<Id>(),
    projectedCensus: integer('projected_census').notNull(),
    /** tierId -> patient count. Open-ended by tier, so genuinely JSON. */
    acuityMix: text('acuity_mix', { mode: 'json' }).notNull().$type<Record<Id, number>>(),
    actualCensus: integer('actual_census'),
    actualAcuityMix: text('actual_acuity_mix', { mode: 'json' }).$type<Record<Id, number>>(),
    source: text('source').notNull().default('manual').$type<'manual' | 'forecast'>(),
  },
  (t) => [uniqueIndex('census_date_shift_idx').on(t.date, t.shiftTypeId)],
);

export const coverageRequirement = sqliteTable(
  'coverage_requirement',
  {
    id: text('id').primaryKey().$type<Id>(),
    unitId: text('unit_id')
      .notNull()
      .references(() => unit.id, { onDelete: 'cascade' })
      .$type<Id>(),
    shiftTypeId: text('shift_type_id')
      .notNull()
      .references(() => shiftType.id, { onDelete: 'cascade' })
      .$type<Id>(),
    /** A weekday rule, or a one-off `date` override which takes precedence. */
    weekday: integer('weekday'),
    date: isoDate('date'),
    role: text('role').notNull().$type<NurseRole>(),
    minCount: integer('min_count').notNull(),
    targetCount: integer('target_count').notNull(),
  },
  (t) => [index('coverage_lookup_idx').on(t.shiftTypeId, t.role, t.weekday)],
);

export const holiday = sqliteTable(
  'holiday',
  {
    id: text('id').primaryKey().$type<Id>(),
    unitId: text('unit_id')
      .notNull()
      .references(() => unit.id, { onDelete: 'cascade' })
      .$type<Id>(),
    date: isoDate('date').notNull(),
    name: text('name').notNull(),
    isMajor: bool('is_major').notNull().default(false),
  },
  (t) => [uniqueIndex('holiday_unit_date_idx').on(t.unitId, t.date)],
);

// ---------------------------------------------------------------------------
// Rule sets
// ---------------------------------------------------------------------------

export const ruleSet = sqliteTable(
  'rule_set',
  {
    id: text('id').primaryKey().$type<Id>(),
    unitId: text('unit_id')
      .notNull()
      .references(() => unit.id, { onDelete: 'cascade' })
      .$type<Id>(),
    name: text('name').notNull(),
    /** Bumped on every edit. A period snapshots the version it was solved under. */
    version: integer('version').notNull().default(1),
    weekendDefinition: text('weekend_definition', { mode: 'json' }).notNull(),
    /**
     * Soft weights for fairness scoring, versioned with the rules for the same reason: a
     * published period must stay explainable under the weights it was solved with. Defaulted
     * to the app's built-in weights so that existing databases migrate cleanly with no
     * backfill — rows written before this column existed silently read as "the default
     * weights were in force," which is true for every rule set saved before this column did.
     */
    fairnessWeights: text('fairness_weights', { mode: 'json' })
      .notNull()
      .default(DEFAULT_FAIRNESS_WEIGHTS),
    createdAt: timestamp('created_at').notNull(),
  },
  (t) => [uniqueIndex('rule_set_version_idx').on(t.unitId, t.version)],
);

export const ruleConfig = sqliteTable(
  'rule_config',
  {
    ruleSetId: text('rule_set_id')
      .notNull()
      .references(() => ruleSet.id, { onDelete: 'cascade' })
      .$type<Id>(),
    ruleId: text('rule_id').notNull(),
    enabled: bool('enabled').notNull().default(true),
    severityOverride: text('severity_override').$type<'hard' | 'soft'>(),
    /** Rule parameters. Shape varies per rule, so JSON is correct here. */
    params: text('params', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
  },
  (t) => [primaryKey({ columns: [t.ruleSetId, t.ruleId] })],
);

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

export const schedulePeriod = sqliteTable(
  'schedule_period',
  {
    id: text('id').primaryKey().$type<Id>(),
    unitId: text('unit_id')
      .notNull()
      .references(() => unit.id, { onDelete: 'cascade' })
      .$type<Id>(),
    name: text('name').notNull(),
    startDate: isoDate('start_date').notNull(),
    endDate: isoDate('end_date').notNull(),
    status: text('status').notNull().default('draft').$type<PeriodStatus>(),
    publishedAt: timestamp('published_at'),
    ruleSetId: text('rule_set_id')
      .notNull()
      .references(() => ruleSet.id)
      .$type<Id>(),
    ruleSetVersion: integer('rule_set_version').notNull(),
  },
  (t) => [index('period_unit_range_idx').on(t.unitId, t.startDate, t.endDate)],
);

export const assignment = sqliteTable(
  'assignment',
  {
    id: text('id').primaryKey().$type<Id>(),
    periodId: text('period_id')
      .notNull()
      .references(() => schedulePeriod.id, { onDelete: 'cascade' })
      .$type<Id>(),
    nurseId: text('nurse_id')
      .notNull()
      .references(() => nurse.id, { onDelete: 'cascade' })
      .$type<Id>(),
    shiftTypeId: text('shift_type_id')
      .notNull()
      .references(() => shiftType.id)
      .$type<Id>(),
    /** The date the shift STARTS. Night shifts run into the following day. */
    date: isoDate('date').notNull(),
    source: text('source').notNull().default('manual').$type<AssignmentSource>(),
    isLocked: bool('is_locked').notNull().default(false),
    isCharge: bool('is_charge').notNull().default(false),
    isOvertime: bool('is_overtime').notNull().default(false),
    notes: text('notes'),
  },
  (t) => [
    // The two hot paths: rendering a period's grid, and walking one nurse's timeline for
    // rest and consecutive-shift rules.
    index('assignment_period_date_idx').on(t.periodId, t.date),
    index('assignment_nurse_date_idx').on(t.nurseId, t.date),
    index('assignment_shift_idx').on(t.date, t.shiftTypeId),
    // A nurse cannot hold the same shift on the same day twice.
    uniqueIndex('assignment_unique_idx').on(t.nurseId, t.date, t.shiftTypeId),
  ],
);

/**
 * One row per publication of a period. The assignments are stored as JSON rather than
 * normalised: a version is a frozen document ("what went out"), never queried by nurse or
 * date, and normalising it would invite someone to join it back to live rows that have since
 * moved. `version` is 1-based per period.
 */
export const scheduleVersion = sqliteTable(
  'schedule_version',
  {
    id: text('id').primaryKey().$type<Id>(),
    periodId: text('period_id')
      .notNull()
      .references(() => schedulePeriod.id, { onDelete: 'cascade' })
      .$type<Id>(),
    version: integer('version').notNull(),
    publishedAt: timestamp('published_at').notNull(),
    publishedBy: text('published_by').notNull(),
    reason: text('reason'),
    assignments: text('assignments', { mode: 'json' }).notNull(),
    added: integer('added').notNull().default(0),
    removed: integer('removed').notNull().default(0),
    changed: integer('changed').notNull().default(0),
  },
  (t) => [uniqueIndex('schedule_version_period_idx').on(t.periodId, t.version)],
);

/**
 * The post-publish change log. `assignment_id` carries no foreign key on purpose: a removal
 * deletes the row it points at, and the log must keep pointing at the historical id.
 */
export const scheduleChange = sqliteTable(
  'schedule_change',
  {
    id: text('id').primaryKey().$type<Id>(),
    periodId: text('period_id')
      .notNull()
      .references(() => schedulePeriod.id, { onDelete: 'cascade' })
      .$type<Id>(),
    version: integer('version').notNull(),
    kind: text('kind').notNull().$type<ScheduleChangeKind>(),
    source: text('source').notNull().default('manual').$type<ScheduleChangeSource>(),
    nurseId: text('nurse_id')
      .notNull()
      .references(() => nurse.id, { onDelete: 'cascade' })
      .$type<Id>(),
    date: isoDate('date').notNull(),
    shiftTypeId: text('shift_type_id').notNull().$type<Id>(),
    assignmentId: text('assignment_id').notNull().$type<Id>(),
    before: text('before', { mode: 'json' }),
    after: text('after', { mode: 'json' }),
    reason: text('reason').notNull(),
    actor: text('actor').notNull(),
    at: timestamp('at').notNull(),
  },
  (t) => [index('schedule_change_period_at_idx').on(t.periodId, t.at)],
);

// ---------------------------------------------------------------------------
// Day-of operations
// ---------------------------------------------------------------------------

export const callOff = sqliteTable(
  'call_off',
  {
    id: text('id').primaryKey().$type<Id>(),
    /**
     * No foreign key, for the same reason `shift_swap` carries none: a backfill replaces the
     * absent nurse's row with the replacement's, and the call-off — with its call log — must
     * keep pointing at the historical id rather than cascade away with it.
     */
    assignmentId: text('assignment_id').notNull().$type<Id>(),
    periodId: text('period_id')
      .notNull()
      .references(() => schedulePeriod.id, { onDelete: 'cascade' })
      .$type<Id>(),
    nurseId: text('nurse_id')
      .notNull()
      .references(() => nurse.id, { onDelete: 'cascade' })
      .$type<Id>(),
    shiftTypeId: text('shift_type_id')
      .notNull()
      .references(() => shiftType.id)
      .$type<Id>(),
    date: text('date').notNull().$type<IsoDate>(),
    reportedAt: timestamp('reported_at').notNull(),
    reason: text('reason'),
    status: text('status').notNull().default('open').$type<CallOffStatus>(),
    replacementAssignmentId: text('replacement_assignment_id').$type<Id>(),
  },
  (t) => [
    index('call_off_status_idx').on(t.status),
    index('call_off_assignment_idx').on(t.assignmentId),
    index('call_off_period_date_idx').on(t.periodId, t.date),
  ],
);

export const callAttempt = sqliteTable(
  'call_attempt',
  {
    id: text('id').primaryKey().$type<Id>(),
    callOffId: text('call_off_id')
      .notNull()
      .references(() => callOff.id, { onDelete: 'cascade' })
      .$type<Id>(),
    nurseId: text('nurse_id')
      .notNull()
      .references(() => nurse.id, { onDelete: 'cascade' })
      .$type<Id>(),
    attemptedAt: timestamp('attempted_at').notNull(),
    outcome: text('outcome').notNull().$type<CallOutcome>(),
    notes: text('notes'),
  },
  (t) => [
    index('call_attempt_calloff_idx').on(t.callOffId),
    // "Who have we been leaning on?" — ordering candidates by recency of last call.
    index('call_attempt_nurse_idx').on(t.nurseId, t.attemptedAt),
  ],
);

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

export const payRate = sqliteTable(
  'pay_rate',
  {
    id: text('id').primaryKey().$type<Id>(),
    /** Per-nurse rate, else the role default. Exactly one of these is set. */
    nurseId: text('nurse_id')
      .references(() => nurse.id, { onDelete: 'cascade' })
      .$type<Id>(),
    role: text('role').$type<NurseRole>(),
    hourlyRate: real('hourly_rate').notNull(),
    effectiveFrom: isoDate('effective_from').notNull(),
  },
  (t) => [index('pay_rate_lookup_idx').on(t.nurseId, t.effectiveFrom)],
);

export const differential = sqliteTable('differential', {
  id: text('id').primaryKey().$type<Id>(),
  unitId: text('unit_id')
    .notNull()
    .references(() => unit.id, { onDelete: 'cascade' })
    .$type<Id>(),
  kind: text('kind').notNull().$type<DifferentialKind>(),
  mode: text('mode').notNull().$type<'multiplier' | 'flat'>(),
  amount: real('amount').notNull(),
  active: bool('active').notNull().default(true),
});

export const overtimeRule = sqliteTable('overtime_rule', {
  id: text('id').primaryKey().$type<Id>(),
  unitId: text('unit_id')
    .notNull()
    .references(() => unit.id, { onDelete: 'cascade' })
    .$type<Id>(),
  basis: text('basis').notNull().$type<'daily' | 'weekly'>(),
  thresholdHours: real('threshold_hours').notNull(),
  multiplier: real('multiplier').notNull(),
  active: bool('active').notNull().default(true),
});

export const budget = sqliteTable('budget', {
  id: text('id').primaryKey().$type<Id>(),
  unitId: text('unit_id')
    .notNull()
    .references(() => unit.id, { onDelete: 'cascade' })
    .$type<Id>(),
  periodId: text('period_id')
    .notNull()
    .references(() => schedulePeriod.id, { onDelete: 'cascade' })
    .$type<Id>(),
  targetDollars: real('target_dollars').notNull(),
});

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

/**
 * The unit's auto-resolve policy. One row per unit, absent until the manager first saves it —
 * the repository returns core's `DEFAULT_AUTO_RESOLVE_POLICY` (off) for a missing row, so a
 * unit can never auto-apply a change nobody opted into.
 */
export const conflictPolicy = sqliteTable('conflict_policy', {
  id: text('id').primaryKey().$type<Id>(),
  unitId: text('unit_id')
    .notNull()
    .unique()
    .references(() => unit.id, { onDelete: 'cascade' })
    .$type<Id>(),
  enabled: bool('enabled').notNull().default(false),
  maxCostDelta: real('max_cost_delta').notNull().default(0),
  maxFairnessDrop: real('max_fairness_drop').notNull().default(1),
});

// ---------------------------------------------------------------------------
// Shift exchange
// ---------------------------------------------------------------------------

export const shiftSwap = sqliteTable(
  'shift_swap',
  {
    id: text('id').primaryKey().$type<Id>(),
    periodId: text('period_id')
      .notNull()
      .references(() => schedulePeriod.id, { onDelete: 'cascade' })
      .$type<Id>(),
    kind: text('kind').notNull().$type<ShiftSwapKind>(),
    requestingNurseId: text('requesting_nurse_id')
      .notNull()
      .references(() => nurse.id, { onDelete: 'cascade' })
      .$type<Id>(),
    counterpartyNurseId: text('counterparty_nurse_id')
      .notNull()
      .references(() => nurse.id, { onDelete: 'cascade' })
      .$type<Id>(),
    // No FK: an approved swap deletes the original assignment rows (delete + create, same as
    // a grid move), and the swap record must keep pointing at those historical ids so the
    // audit trail and the decided swap can still say exactly which shift moved. A foreign key
    // here would either cascade-null the very evidence the record exists to preserve, or block
    // the approval's own delete.
    offeredAssignmentId: text('offered_assignment_id').notNull().$type<Id>(),
    /** Present for a trade, absent for a giveaway. Also no FK, for the same reason. */
    requestedAssignmentId: text('requested_assignment_id').$type<Id>(),
    status: text('status').notNull().default('proposed').$type<ShiftSwapStatus>(),
    /** Always 'manager' in v1; the seam that lets nurse self-service reuse this table. */
    enteredBy: text('entered_by').notNull().default('manager').$type<RequestOrigin>(),
    submittedAt: timestamp('submitted_at').notNull(),
    decidedAt: timestamp('decided_at'),
    decidedBy: text('decided_by'),
    reason: text('reason'),
    /** Required on denial, and on an approval that overrides a warning. */
    decisionReason: text('decision_reason'),
    /** True when the approval went ahead despite warnings; `decisionReason` says why. */
    overrode: bool('overrode').notNull().default(false),
  },
  (t) => [
    index('shift_swap_period_status_idx').on(t.periodId, t.status),
    index('shift_swap_requesting_nurse_idx').on(t.requestingNurseId),
    index('shift_swap_counterparty_nurse_idx').on(t.counterpartyNurseId),
  ],
);

// ---------------------------------------------------------------------------
// Fairness history
// ---------------------------------------------------------------------------

export const fairnessLedger = sqliteTable(
  'fairness_ledger',
  {
    id: text('id').primaryKey().$type<Id>(),
    nurseId: text('nurse_id')
      .notNull()
      .references(() => nurse.id, { onDelete: 'cascade' })
      .$type<Id>(),
    periodId: text('period_id').notNull().$type<Id>(),
    periodStart: isoDate('period_start').notNull(),
    nightShifts: integer('night_shifts').notNull().default(0),
    weekendsWorked: integer('weekends_worked').notNull().default(0),
    holidaysWorked: integer('holidays_worked').notNull().default(0),
    onCallShifts: integer('on_call_shifts').notNull().default(0),
    undesirableShifts: integer('undesirable_shifts').notNull().default(0),
    requestsApproved: integer('requests_approved').notNull().default(0),
    requestsDenied: integer('requests_denied').notNull().default(0),
    callOutsCovered: integer('call_outs_covered').notNull().default(0),
    totalHours: real('total_hours').notNull().default(0),
    overtimeHours: real('overtime_hours').notNull().default(0),
    preferenceHitRate: real('preference_hit_rate').notNull().default(0),
  },
  (t) => [
    uniqueIndex('fairness_nurse_period_idx').on(t.nurseId, t.periodId),
    // Fairness scoring reads a rolling window ordered by period start.
    index('fairness_window_idx').on(t.nurseId, t.periodStart),
  ],
);

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * Append-only. Never updated, never deleted.
 *
 * This is the table that answers "why does the schedule say that?" months later, in front of
 * a union representative. Every mutation writes here, and denials and overrides carry the
 * manager's stated reason verbatim.
 */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey().$type<Id>(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull().$type<Id>(),
    action: text('action').notNull().$type<AuditAction>(),
    actor: text('actor').notNull(),
    at: timestamp('at').notNull().default(sql`(unixepoch() * 1000)`),
    before: text('before', { mode: 'json' }),
    after: text('after', { mode: 'json' }),
    reason: text('reason'),
  },
  (t) => [index('audit_entity_idx').on(t.entityType, t.entityId), index('audit_at_idx').on(t.at)],
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const unitRelations = relations(unit, ({ many }) => ({
  nurses: many(nurse),
  shiftTypes: many(shiftType),
  periods: many(schedulePeriod),
}));

export const nurseRelations = relations(nurse, ({ one, many }) => ({
  unit: one(unit, { fields: [nurse.unitId], references: [unit.id] }),
  credentials: many(nurseCredential),
  preferences: many(preference),
  timeOff: many(timeOffRequest),
  assignments: many(assignment),
}));

export const schedulePeriodRelations = relations(schedulePeriod, ({ one, many }) => ({
  unit: one(unit, { fields: [schedulePeriod.unitId], references: [unit.id] }),
  ruleSet: one(ruleSet, { fields: [schedulePeriod.ruleSetId], references: [ruleSet.id] }),
  assignments: many(assignment),
}));

export const assignmentRelations = relations(assignment, ({ one }) => ({
  period: one(schedulePeriod, {
    fields: [assignment.periodId],
    references: [schedulePeriod.id],
  }),
  nurse: one(nurse, { fields: [assignment.nurseId], references: [nurse.id] }),
  shiftType: one(shiftType, { fields: [assignment.shiftTypeId], references: [shiftType.id] }),
}));

export const ruleSetRelations = relations(ruleSet, ({ many }) => ({
  configs: many(ruleConfig),
}));

export const ruleConfigRelations = relations(ruleConfig, ({ one }) => ({
  ruleSet: one(ruleSet, { fields: [ruleConfig.ruleSetId], references: [ruleSet.id] }),
}));
