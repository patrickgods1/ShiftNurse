/**
 * The domain entities. These are plain data — no methods, no persistence concerns — so the
 * same shapes serialise cleanly across the Electron IPC boundary today and over HTTP when
 * this becomes a web app.
 */

import type { IsoDate, Weekday } from './time.js';

export type Id = string;

/** Epoch milliseconds. Used for real events (audit entries, call-offs), never schedule geometry. */
export type Timestamp = number;

// ---------------------------------------------------------------------------
// Unit & shift types
// ---------------------------------------------------------------------------

export interface Unit {
  id: Id;
  name: string;
  /** Free text, e.g. "Medical-Surgical", "ICU". Drives which example ratio rules apply. */
  unitType: string;
  /** Pay-period length in days; FTE hour targets are checked against this window. */
  payPeriodDays: number;
  /** Anchor date so pay-period boundaries are unambiguous across the year. */
  payPeriodAnchor: IsoDate;
}

export interface ShiftType {
  id: Id;
  unitId: Id;
  name: string;
  /** Short form for the schedule grid, e.g. "D12", "N8", "OC". */
  abbreviation: string;
  /** Local clock start, `HH:MM`. */
  startTime: string;
  /** Scheduled/paid length. The unit runs mixed 8h and 12h shifts, so this varies per type. */
  durationHours: number;
  isNight: boolean;
  /** On-call/standby: occupies the nurse's availability but is paid and counted differently. */
  isOnCall: boolean;
  /** Hex colour for the grid. */
  color: string;
  /** Display/solve ordering. */
  sortOrder: number;
  active: boolean;
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

export type NurseRole = 'RN' | 'LPN' | 'CNA';

export type EmploymentType = 'full_time' | 'part_time' | 'per_diem' | 'agency';

export interface Nurse {
  id: Id;
  unitId: Id;
  employeeId: string;
  firstName: string;
  lastName: string;
  role: NurseRole;
  employmentType: EmploymentType;
  /** 1.0 = full time. Drives the contracted-hours target. */
  fte: number;
  /** Target hours per pay period. Derived from FTE by default, overridable per contract. */
  contractedHoursPerPeriod: number;
  /** Drives seniority ranking. Earlier = more senior. */
  seniorityDate: IsoDate;
  isChargeEligible: boolean;
  /** New graduates / recent hires. Used by the no-all-novice coverage guard. */
  isNovice: boolean;
  isFloatEligible: boolean;
  /** Contact for the day-of call list. */
  phone?: string;
  email?: string;
  active: boolean;
  notes?: string;
}

export interface Credential {
  id: Id;
  /** e.g. "ACLS", "BLS", "PALS", "PRECEPTOR", "CHARGE". */
  code: string;
  name: string;
  /** Whether an expiry date is meaningful for this credential. */
  tracksExpiry: boolean;
}

export interface NurseCredential {
  id: Id;
  nurseId: Id;
  credentialId: Id;
  issuedOn?: IsoDate;
  /** Absent means "never expires". A past date makes the nurse ineligible for shifts requiring it. */
  expiresOn?: IsoDate;
}

/**
 * "Every night shift needs at least one ACLS-certified RN." Nulls widen the scope: a null
 * `shiftTypeId` applies to every shift, a null `role` to any role.
 */
export interface ShiftCredentialRequirement {
  id: Id;
  unitId: Id;
  shiftTypeId: Id | null;
  role: NurseRole | null;
  credentialId: Id;
  minCount: number;
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

/**
 * Preferences are a discriminated union so each kind carries exactly the payload it needs.
 * `weight` is 1–5, the nurse's own strength of feeling; seniority scales it at scoring time.
 */
export type Preference =
  | {
      id: Id;
      nurseId: Id;
      kind: 'prefer_shift_type' | 'avoid_shift_type';
      shiftTypeId: Id;
      weight: number;
    }
  | {
      id: Id;
      nurseId: Id;
      kind: 'prefer_weekday' | 'avoid_weekday';
      weekday: Weekday;
      weight: number;
    }
  | {
      id: Id;
      nurseId: Id;
      kind: 'weekend_appetite';
      /** -1 = wants no weekends, 0 = neutral, +1 = actively wants weekends. */
      level: number;
      weight: number;
    }
  | {
      id: Id;
      nurseId: Id;
      kind: 'preferred_block_length';
      /** Preferred number of consecutive shifts before days off. */
      shifts: number;
      weight: number;
    };

export type PreferenceKind = Preference['kind'];

// ---------------------------------------------------------------------------
// Time off
// ---------------------------------------------------------------------------

export type TimeOffType = 'pto' | 'unpaid' | 'fmla' | 'education' | 'bereavement';

export type TimeOffStatus = 'pending' | 'approved' | 'denied' | 'cancelled';

/**
 * Who put a request into the system.
 *
 * v1 is manager-only, so this is always `'manager'` — the manager records requests nurses
 * make verbally, on paper or by email. It exists now, rather than being added later, because
 * every request type is modelled as *a request with a submitter and a decider*. When nurse
 * self-service ships, it sets `'nurse'` and reuses the identical table, approval workflow and
 * validation. Adding the column now costs nothing; adding it later would cost a migration on
 * live scheduling data.
 */
export type RequestOrigin = 'manager' | 'nurse';

export interface TimeOffRequest {
  id: Id;
  nurseId: Id;
  /** Inclusive on both ends. */
  startDate: IsoDate;
  endDate: IsoDate;
  type: TimeOffType;
  status: TimeOffStatus;
  /** Always `'manager'` in v1. See {@link RequestOrigin}. */
  enteredBy: RequestOrigin;
  submittedAt: Timestamp;
  decidedAt?: Timestamp;
  decidedBy?: string;
  /** The nurse's stated reason, if given. */
  reason?: string;
  /** Required on denial — this is the text that gets quoted in a grievance. */
  decisionReason?: string;
}

// ---------------------------------------------------------------------------
// Acuity & demand
// ---------------------------------------------------------------------------

export interface AcuityTier {
  id: Id;
  unitId: Id;
  name: string;
  /** 1 = lowest acuity. Higher tiers need more nursing hours per patient. */
  level: number;
  /** Nursing care hours per patient per day at this tier. Feeds the HPPD calculation. */
  careHoursPerPatientDay: number;
}

export interface CensusForecast {
  id: Id;
  unitId: Id;
  date: IsoDate;
  shiftTypeId: Id;
  projectedCensus: number;
  /** acuityTierId → patient count. Should sum to `projectedCensus`; validated on save. */
  acuityMix: Record<Id, number>;
  /** Filled in after the fact, enabling forecast-vs-actual back-testing. */
  actualCensus?: number;
  actualAcuityMix?: Record<Id, number>;
  source: 'manual' | 'forecast';
}

/**
 * A hard ceiling on patients per nurse. `acuityTierId: null` means the rule applies to all
 * tiers. The most restrictive applicable rule wins.
 */
export interface RatioRule {
  id: Id;
  unitId: Id;
  role: NurseRole;
  acuityTierId: Id | null;
  maxPatientsPerNurse: number;
  /** Where this came from, e.g. "CA Title 22 §70217" or "Local 1199 Art. 12". */
  citation?: string;
  active: boolean;
}

export interface HppdTarget {
  id: Id;
  unitId: Id;
  /** Target nursing hours per patient day. A soft budget goal, not a hard constraint. */
  targetHours: number;
}

/**
 * The contractual/safety staffing floor, independent of census. Acuity-derived demand can
 * only push required staffing *up* from here, never below it.
 */
export interface CoverageRequirement {
  id: Id;
  unitId: Id;
  shiftTypeId: Id;
  /** Applies to this weekday; `null` with a `date` set makes it a one-off override. */
  weekday: Weekday | null;
  /** A specific date override, which takes precedence over the weekday rule. */
  date: IsoDate | null;
  role: NurseRole;
  minCount: number;
  targetCount: number;
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

export type PeriodStatus = 'draft' | 'published' | 'archived';

export interface SchedulePeriod {
  id: Id;
  unitId: Id;
  name: string;
  startDate: IsoDate;
  endDate: IsoDate;
  status: PeriodStatus;
  publishedAt?: Timestamp;
  /** Snapshot of the rules in force, so a published schedule stays explainable forever. */
  ruleSetId: Id;
  ruleSetVersion: number;
}

export type AssignmentSource = 'solver' | 'manual' | 'resolution' | 'callout';

export interface Assignment {
  id: Id;
  periodId: Id;
  nurseId: Id;
  shiftTypeId: Id;
  /** The date the shift *starts*. Night shifts run into the following day. */
  date: IsoDate;
  source: AssignmentSource;
  /** Pinned by the manager: the solver must preserve it when regenerating. */
  isLocked: boolean;
  isCharge: boolean;
  /** Authorised overtime. Unauthorised OT is a hard-rule violation, not a flag. */
  isOvertime: boolean;
  notes?: string;
}

/**
 * One publication of a period. A period is published once and then republished after every
 * batch of post-publish edits; each publication snapshots the assignments as they went out,
 * so "what did the nurses actually receive on the 3rd" is answerable without replaying the
 * audit log. `version` counts from 1 per period.
 */
export interface ScheduleVersion {
  id: Id;
  periodId: Id;
  version: number;
  publishedAt: Timestamp;
  publishedBy: string;
  /** Why this version went out — required on a republish, optional on the first. */
  reason?: string;
  /** The assignments exactly as published. */
  assignments: Assignment[];
  /** How this version differs from the one before it (all `added` for version 1). */
  added: number;
  removed: number;
  changed: number;
}

export type ScheduleChangeKind = 'added' | 'removed' | 'changed';

/** What produced a post-publish edit; the change log groups and explains by this. */
export type ScheduleChangeSource = 'manual' | 'exchange' | 'time_off' | 'resolution' | 'backfill';

/**
 * One edit to a published schedule, with the manager's reason. A published schedule is a
 * promise to the unit, so every change after it is a record in its own right — not just an
 * audit row — carrying who was affected, what they had before and what they have now, and
 * why. `version` is the publication the edit was made against; the next republish folds
 * these into a new `ScheduleVersion`.
 */
export interface ScheduleChange {
  id: Id;
  periodId: Id;
  version: number;
  kind: ScheduleChangeKind;
  source: ScheduleChangeSource;
  nurseId: Id;
  date: IsoDate;
  shiftTypeId: Id;
  /** The assignment id involved. No foreign key: a removal's row is gone. */
  assignmentId: Id;
  before?: Assignment;
  after?: Assignment;
  reason: string;
  actor: string;
  at: Timestamp;
}

// ---------------------------------------------------------------------------
// Day-of operations
// ---------------------------------------------------------------------------

export type CallOffStatus = 'open' | 'covered' | 'uncovered' | 'cancelled';

/**
 * A nurse reporting they cannot work a shift they hold. The shift is copied onto the row
 * (`periodId`, `nurseId`, `shiftTypeId`, `date`) because a backfill *replaces* the absent
 * nurse's assignment — the row `assignmentId` names is gone once someone covers it — and the
 * call-off, with its call log, must still say whose shift it was and when. Same reason
 * `ScheduleChange` carries the shift beside its assignment id.
 */
export interface CallOff {
  id: Id;
  /** The assignment as it stood when reported. No foreign key: a backfill deletes that row. */
  assignmentId: Id;
  periodId: Id;
  nurseId: Id;
  shiftTypeId: Id;
  date: IsoDate;
  reportedAt: Timestamp;
  reason?: string;
  status: CallOffStatus;
  /** The backfill assignment, once someone accepts. */
  replacementAssignmentId?: Id;
}

export type CallOutcome = 'accepted' | 'declined' | 'no_answer' | 'left_message' | 'ineligible';

export interface CallAttempt {
  id: Id;
  callOffId: Id;
  nurseId: Id;
  attemptedAt: Timestamp;
  outcome: CallOutcome;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

export interface PayRate {
  id: Id;
  /** Per-nurse rate; falls back to the role default when absent. */
  nurseId: Id | null;
  role: NurseRole | null;
  hourlyRate: number;
  effectiveFrom: IsoDate;
}

export type DifferentialKind =
  | 'night'
  | 'weekend'
  | 'holiday'
  | 'charge'
  | 'on_call'
  | 'call_back'
  | 'agency';

export interface Differential {
  id: Id;
  unitId: Id;
  kind: DifferentialKind;
  /** `multiplier` scales the base rate; `flat` adds dollars per hour. */
  mode: 'multiplier' | 'flat';
  amount: number;
  active: boolean;
}

export interface OvertimeRule {
  id: Id;
  unitId: Id;
  /** 'daily' compares against hours in one shift; 'weekly' against a rolling 7-day window. */
  basis: 'daily' | 'weekly';
  thresholdHours: number;
  multiplier: number;
  active: boolean;
}

export interface Budget {
  id: Id;
  unitId: Id;
  periodId: Id;
  targetDollars: number;
}

// ---------------------------------------------------------------------------
// Fairness history
// ---------------------------------------------------------------------------

/**
 * One row per nurse per period: the accumulated burden that fairness scoring balances
 * across the team. Historical seeding writes these directly so scoring is meaningful from
 * day one rather than starting from a blank slate.
 */
export interface FairnessLedgerEntry {
  id: Id;
  nurseId: Id;
  periodId: Id;
  periodStart: IsoDate;
  nightShifts: number;
  weekendsWorked: number;
  holidaysWorked: number;
  onCallShifts: number;
  /** Shifts the nurse had an explicit `avoid_*` preference against. */
  undesirableShifts: number;
  requestsApproved: number;
  requestsDenied: number;
  /** Times this nurse picked up a call-off backfill. */
  callOutsCovered: number;
  totalHours: number;
  overtimeHours: number;
  /** 0–1: share of this nurse's preferences the schedule honoured. */
  preferenceHitRate: number;
}

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------

export interface Holiday {
  id: Id;
  unitId: Id;
  date: IsoDate;
  name: string;
  /** Contracts often treat a subset as "major" holidays with stricter rotation equity. */
  isMajor: boolean;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'approve'
  | 'deny'
  | 'generate'
  | 'publish'
  | 'resolve'
  | 'auto_resolve'
  | 'call_off'
  | 'backfill'
  | 'import'
  | 'backup'
  | 'restore';

export interface AuditLogEntry {
  id: Id;
  entityType: string;
  entityId: Id;
  action: AuditAction;
  actor: string;
  at: Timestamp;
  /** Serialised before/after snapshots. Append-only; never rewritten. */
  before?: unknown;
  after?: unknown;
  /** The manager's stated justification, quoted verbatim if this is ever grieved. */
  reason?: string;
}
