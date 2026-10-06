/**
 * The domain entities. These are plain data — no methods, no persistence concerns — so the
 * same shapes serialise cleanly across the Electron IPC boundary today and over HTTP when
 * this becomes a web app.
 */

import type { JurisdictionId } from '../setup/jurisdictions.js';
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
  /** How the unit keeps its ratios at all times. Absent: the charge nurse counts, no breaks. */
  ratioStaffing?: RatioStaffing;
  /**
   * Days before a period starts by which its schedule must be posted (many contracts say two to
   * four weeks). Absent: no notice rule, and publishing is never flagged as late.
   */
  postingLeadDays?: number;
  /** The state preset last applied (Settings › Unit); absent until one is. Not read by any rule. */
  jurisdiction?: JurisdictionId;
  /**
   * How the unit's employer runs FMLA, its leave year and leave accrual. Absent: private-sector
   * FMLA counted back a year from each use, a calendar leave year, and no accrual — balances are
   * whatever payroll last said.
   */
  leavePolicy?: LeavePolicy;
  /**
   * How day-of ranks staff nurses within the overtime tier. `'cost'` (absent = this): volunteers,
   * then cheapest, then least burdened. `'roster'`: the contract's overtime rosters — volunteers
   * in turn (longest since their last overtime, then seniority), then the mandated roster in
   * reverse seniority (VA–NNU Art. 14).
   */
  overtimeOrder?: OvertimeOrder;
  /** Absent = no commitment checked. */
  perDiemCommitment?: PerDiemCommitment;
  /**
   * When true, a manager's change to a posted (published) schedule must record the affected
   * nurse's consent (VA, UC and Oregon contracts). Absent/false: a reason is enough.
   */
  requireConsentForPostedChanges?: boolean;
}

export type OvertimeOrder = 'cost' | 'roster';

export interface PerDiemCommitment {
  /** Weekend shifts each per-diem nurse commits to per four weeks (WSNA contracts: 2). */
  weekendShiftsPer4Weeks: number;
  /** Holiday shifts each per-diem nurse commits to per calendar year (commonly 1). */
  holidayShiftsPerYear: number;
}

/** A nurse's tour: the part of the day their shifts fall in. Classified from a shift's start time. */
export type Tour = 'day' | 'evening' | 'night';
export const TOURS: readonly Tour[] = ['day', 'evening', 'night'];

/**
 * How a unit keeps a ratio "at all times" (Title 22 § 70217(a); ORS 441.765). Read by
 * `deriveDemand`, so every consumer of a shift's ratio requirement follows it.
 */
export interface RatioStaffing {
  /**
   * False where the charge nurse counts toward the ratio only while caring for patients and is
   * usually kept free of them (California, Oregon): a standalone shift then needs one RN more.
   */
  chargeNurseTakesPatients: boolean;
  /** Break minutes each bedside nurse takes per shift (e.g. a 30-minute meal and two 15s). */
  breakMinutesPerNurse: number;
  /** A charge nurse without patients relieves for breaks (Title 22 allows it): one relief fewer. */
  chargeCoversBreaks: boolean;
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
  /**
   * The shift this one runs inside, or null for a standalone shift. A mid or short shift (an 8
   * from 07:00 inside the day 12) is covered by whoever is on the unit during its hours: it has
   * no charge nurse of its own, and the containing shift's staff count toward its credential
   * requirements and toward the experienced RNs a new grad on it works beside. Its window must
   * sit inside that shift's (`schedule/cover.ts`).
   */
  withinShiftTypeId: Id | null;
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

export type NurseRole = 'RN' | 'LPN' | 'CNA';

export type EmploymentType = 'full_time' | 'part_time' | 'per_diem' | 'agency';

/** Every employment type, in the order forms list them. */
export const EMPLOYMENT_TYPES: readonly EmploymentType[] = [
  'full_time',
  'part_time',
  'per_diem',
  'agency',
];

export const EMPLOYMENT_TYPE_LABELS: Readonly<Record<EmploymentType, string>> = {
  full_time: 'Full time',
  part_time: 'Part time',
  per_diem: 'Per diem',
  agency: 'Agency',
};

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
  /**
   * The day employment began, where it differs from the bargained seniority date (a nurse who
   * kept seniority across a merger, or bridged service). FMLA's 12-month test and accrual by
   * years of service read this. Absent: the seniority date stands in.
   */
  hireDate?: IsoDate;
  /**
   * A nurse hired onto (or awarded) a permanent tour, who must not be rotated off it
   * (VA–NNU Master Agreement Art. 13). Absent: rotates.
   */
  permanentTour?: Tour;
  /**
   * The workdays a week this nurse is regularly scheduled for (3 for a three-twelve line). A
   * `beyond_scheduled_days` overtime rule reads it: under IWC Wage Order 5 § 3(B)(8), on a
   * health-care alternative workweek the hours past 8 on a day beyond the regularly scheduled
   * workdays are double time. Absent: the rule prices nothing for this nurse.
   */
  scheduledDaysPerWeek?: number;
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
// Incompatible staff
// ---------------------------------------------------------------------------

/**
 * Nurses the manager has decided should not be on the floor together: a personality clash, an
 * open HR investigation, a former couple. A group rather than a pair, because the problem is
 * often three or more people. `maxTogether` is how many of them may overlap at once — 1 means
 * no two ever, 2 means pairs are fine but not the whole clique.
 *
 * `reason` is HR-sensitive. It is kept for the audit trail and the roster screen, and is never
 * written into a violation message, which appears on the grid, in exports and in grievances.
 */
export interface IncompatibilityGroup {
  id: Id;
  unitId: Id;
  name: string;
  /** Two or more distinct nurses of the unit. */
  nurseIds: Id[];
  /** At least 1, fewer than the number of members. */
  maxTogether: number;
  reason: string;
  /** First shift date the group applies to; absent means "from the start". */
  startsOn?: IsoDate;
  /** Last shift date the group applies to; absent means "until removed". */
  endsOn?: IsoDate;
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

/**
 * `pto` is the private-sector catch-all; federal and union units name leave by what pays it:
 * `annual` (5 U.S.C. § 6303; Title 38 nurses under 38 U.S.C. § 7421), `court` (jury or witness
 * duty, § 6322), `military` (§ 6323 / USERRA), `parental` (paid parental leave, § 6382(d)),
 * `lwop` (leave without pay, approved in advance), `comp` (compensatory time taken in place of
 * overtime pay) and `state_family` (a state's family-leave law beside FMLA, e.g. CFRA).
 */
export type TimeOffType =
  | 'pto'
  | 'sick'
  | 'unpaid'
  | 'fmla'
  | 'education'
  | 'bereavement'
  | 'annual'
  | 'court'
  | 'military'
  | 'parental'
  | 'lwop'
  | 'comp'
  | 'state_family';

/** Every time-off type, in the order forms list them. */
export const TIME_OFF_TYPES: readonly TimeOffType[] = [
  'pto',
  'annual',
  'sick',
  'fmla',
  'state_family',
  'parental',
  'bereavement',
  'education',
  'court',
  'military',
  'comp',
  'unpaid',
  'lwop',
];

export const TIME_OFF_TYPE_LABELS: Readonly<Record<TimeOffType, string>> = {
  pto: 'PTO',
  annual: 'Annual leave',
  sick: 'Sick',
  fmla: 'FMLA',
  state_family: 'State family leave',
  parental: 'Paid parental leave',
  bereavement: 'Bereavement',
  education: 'Education',
  court: 'Court leave',
  military: 'Military leave',
  comp: 'Comp time',
  unpaid: 'Unpaid',
  lwop: 'Leave without pay',
};

/** Leave that payroll keeps a balance for: a request of the same type draws on it. */
export type LeaveBalanceType = 'pto' | 'sick' | 'annual' | 'comp';

export const LEAVE_BALANCE_TYPES: readonly LeaveBalanceType[] = ['pto', 'annual', 'sick', 'comp'];

// ---------------------------------------------------------------------------
// Leave policy: FMLA regime, leave year, accrual
// ---------------------------------------------------------------------------

/**
 * Which FMLA a unit's employer is under. `title1` is 29 U.S.C. § 2611 ff. (private and state
 * employers: 12 months employed and 1,250 hours, 12 of the nurse's work weeks). `title5` is
 * 5 U.S.C. § 6381 ff. for federal staff, VA nurses included (5 C.F.R. § 630.1201 ff.): 12 months
 * of service and no hours test, 12 administrative workweeks (6 × the biweekly tour hours), and a
 * 12-month period that always starts on the first day of leave.
 */
export type FmlaRegime = 'title1' | 'title5';

/**
 * The four ways an employer may measure FMLA's 12 months (29 C.F.R. § 825.200(b)): the calendar
 * year, a fixed year from `FmlaPolicy.fixedYearStart`, forward from the first day of leave, or
 * back a year from each day of leave. Title 5 is always `rolling_forward`.
 */
export type FmlaYearMethod = 'calendar' | 'fixed' | 'rolling_forward' | 'rolling_backward';

export interface FmlaPolicy {
  regime: FmlaRegime;
  yearMethod: FmlaYearMethod;
  /** `MM-DD` the fixed year starts on (a fiscal year: `10-01`). Only read for `fixed`. */
  fixedYearStart?: string;
}

/**
 * When a leave year turns over, which is when a carryover cap forfeits the excess. Federal leave
 * years start on the first day of the first full pay period of the calendar year (5 U.S.C.
 * § 6302(a)); most other employers use 1 January.
 */
export type LeaveYearStart = 'calendar' | 'first_full_pay_period';

/** One rate of earning: from this many whole years of service until the next tier's start. */
export interface AccrualTier {
  fromYearsOfService: number;
  /** Hours earned for each full pay period (full-time federal leave: 4, 6 or 8). */
  hoursPerPayPeriod?: number;
  /** Or one hour earned for this many hours worked or in pay status (part-time: 1 per 10). */
  hoursPerAccruedHour?: number;
}

/**
 * How one balance grows, for the nurses it covers. The first rule in `LeavePolicy.accrual`
 * matching a nurse's balance type, role and employment type is theirs; a nurse no rule matches
 * accrues nothing.
 */
export interface AccrualRule {
  balanceType: LeaveBalanceType;
  /** Absent: every role. */
  roles?: readonly NurseRole[];
  /** Absent: every employment type. */
  employmentTypes?: readonly EmploymentType[];
  /** Ordered by `fromYearsOfService`; the last tier the nurse has reached applies. */
  tiers: readonly AccrualTier[];
  /** The most the balance may ever hold; accrual stops there (California sick leave: 80). */
  balanceCapHours?: number;
  /** The most carried into a new leave year; the rest is forfeited (federal annual: 240). */
  carryoverCapHours?: number;
  /** The provision the rule comes from, shown beside it. */
  citation?: string;
}

export interface LeavePolicy {
  fmla: FmlaPolicy;
  leaveYearStart: LeaveYearStart;
  accrual: readonly AccrualRule[];
}

/** The policy a unit without one is read as: today's behaviour before leave policies existed. */
export const DEFAULT_LEAVE_POLICY: LeavePolicy = {
  fmla: { regime: 'title1', yearMethod: 'rolling_backward' },
  leaveYearStart: 'calendar',
  accrual: [],
};

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
  /**
   * Hours of paid leave charged for this absence, once approved: the shifts the nurse would
   * have worked, not every calendar day. They count toward contracted hours (see
   * `rules/paid-leave.ts`). Absent or 0 for unpaid leave.
   */
  paidHours?: number;
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
/**
 * Who a ratio counts: one role, or `licensed` — RNs and LPN/LVNs together, as California's Title
 * 22 counts "licensed nurses" (LVNs up to half of them).
 */
export type RatioRole = NurseRole | 'licensed';

export interface RatioRule {
  id: Id;
  unitId: Id;
  role: RatioRole;
  acuityTierId: Id | null;
  maxPatientsPerNurse: number;
  /** Where this came from, e.g. "CA Title 22 §70217" or "Local 1199 Art. 12". */
  citation?: string;
  /**
   * For a `licensed` rule: the least share of the licensed nurses that must be RNs (0.5 where
   * LVNs may be up to half). Absent: none.
   */
  minRnShare?: number;
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
  /**
   * The last day time-off requests for this period are on time. Units close requests a few
   * weeks before building the schedule; later ones are decided first-come, with a cover plan.
   */
  requestsCloseOn?: IsoDate;
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
  /**
   * Minutes worked past the shift's scheduled end — a holdover, recorded day-of on a published
   * shift. Absent or 0: the shift ended on time. `schedule/holdover.ts` is the one definition of
   * what it does to worked hours and the worked window.
   */
  holdoverMinutes?: number;
  /**
   * Whether the hospital required the holdover (true) or the nurse volunteered for it (false).
   * Only meaningful with `holdoverMinutes`; mandatory-overtime laws judge only required time.
   */
  holdoverMandated?: boolean;
}

/**
 * An orientee working under a named preceptor over some dates: a new hire, or a nurse floated in
 * to learn the unit, who may only work when that preceptor is on the floor with them. Dates are
 * inclusive and compare with the shift's start date. An orientee may have more than one
 * preceptor in force; any one of them on the shift is enough.
 */
export interface Preceptorship {
  id: Id;
  unitId: Id;
  orienteeId: Id;
  preceptorId: Id;
  startDate: IsoDate;
  endDate: IsoDate;
}

/**
 * A nurse's standing offer to work overtime over some dates. New York (Labor Law § 167),
 * Washington (RCW 49.28.140), Oregon (ORS 441.770) and Massachusetts (c.111 § 226) forbid
 * *requiring* a nurse to work overtime outside an emergency; this record is what makes an
 * overtime shift voluntary rather than mandatory. Dates are inclusive and compare with the shift's
 * start date.
 */
export interface OvertimeVolunteer {
  id: Id;
  unitId: Id;
  nurseId: Id;
  startDate: IsoDate;
  endDate: IsoDate;
  /** How the offer was made — "texted 3 Oct, any nights that week" — quoted if it is disputed. */
  note?: string;
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
export type ScheduleChangeSource =
  | 'manual'
  | 'exchange'
  | 'time_off'
  | 'resolution'
  | 'backfill'
  /** A nurse sent home when the census dropped, in the unit's cancellation order. */
  | 'census'
  /** A nurse floated to another unit for the shift, in the unit's float order. */
  | 'float';

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
  /** How the affected nurse agreed ("agreed by phone 6 Oct 14:10"), when the unit requires consent. */
  consent?: string;
  actor: string;
  at: Timestamp;
}

/**
 * A nurse's written waiver of the minimum rest before one shift (VA–NNU Art. 13 §2 lets a
 * nurse waive the 11 hours). It lets an insufficient-rest finding stand for the shift that
 * STARTS on `date`, and only that one. `reason` is required and quoted if it is challenged.
 */
export interface RestWaiver {
  id: Id;
  unitId: Id;
  nurseId: Id;
  date: IsoDate;
  reason: string;
  createdAt: Timestamp;
}

/**
 * A recurring window a nurse cannot work: a disability or religious accommodation (ADA, Title
 * VII), a pregnancy accommodation (PWFA), a lactation schedule (PUMP Act). Hard, unlike a
 * preference. `reason` is HR/medical-sensitive: audited and shown on the roster, never written
 * into a violation message (those reach the grid, exports and grievances).
 * Times are local wall clock `HH:MM`; an `endTime` at or before `startTime` runs past midnight
 * into the next day. `startsOn`/`endsOn` are inclusive and compare with the block's own date.
 */
export interface AvailabilityBlock {
  id: Id;
  unitId: Id;
  nurseId: Id;
  weekdays: Weekday[];
  startTime: string;
  endTime: string;
  startsOn?: IsoDate;
  endsOn?: IsoDate;
  reason: string;
}

/**
 * One nurse floated off the unit for one shift: who, which shift, where to, and whether they
 * volunteered. The float rotation reads this history (volunteers first, then the mandated
 * turn in reverse seniority, VA–NNU Art. 12). `objection` is the nurse's own recorded
 * objection (not competent on the receiving unit, say) — kept, never a bar to the float.
 * No foreign key on the assignment: floating removes the home shift.
 */
export interface FloatRecord {
  id: Id;
  unitId: Id;
  nurseId: Id;
  date: IsoDate;
  shiftTypeId: Id;
  toUnit: string;
  volunteered: boolean;
  objection?: string;
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
  /**
   * Hours paid from the nurse's sick leave for the missed shift. Once the shift is off the
   * schedule they count toward contracted hours, as paid leave does.
   */
  paidSickHours?: number;
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
  /** Only ever earned through a clock `window`; without one it applies to nothing. */
  | 'evening'
  | 'weekend'
  | 'holiday'
  /** A major holiday's premium. Absent, a major holiday earns the `holiday` premium. */
  | 'major_holiday'
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
  /**
   * Earned by clock time instead of the shift type's flag: the hours of the shift falling in the
   * daily window [startTime, endTime) (HH:MM; end ≤ start wraps past midnight). With
   * `wholeShiftAtHours`, a shift with at least that many hours in the window earns it on every
   * paid hour; otherwise only the in-window hours earn it. Only night and evening use it.
   */
  window?: { startTime: string; endTime: string; wholeShiftAtHours: number | null };
}

export interface OvertimeRule {
  id: Id;
  unitId: Id;
  /**
   * 'daily' compares against hours in one workday (the shifts that start on a date); 'weekly'
   * against the contract's work week; 'pay_period' against the unit's pay period (a 14-day
   * overtime period, as under 8/80); 'seventh_day' against hours on the seventh consecutive day
   * worked in one work week (California Labor Code § 510: threshold 0 at 1.5×, 8 at 2×).
   * 'beyond_scheduled_tour' makes a shift's holdover overtime from `thresholdHours` past its
   * scheduled end (VA–NNU Art. 14: overtime is work beyond the scheduled tour); 'consecutive'
   * makes hours overtime past `thresholdHours` worked without a break (38 U.S.C. §7453(e)(1):
   * "in excess of eight consecutive hours"). 'beyond_scheduled_days' makes a workday's hours past
   * `thresholdHours` overtime on each date worked in a work week beyond the nurse's
   * `scheduledDaysPerWeek` (IWC Wage Order 5 § 3(B)(8): past 8 on an extra day is double time).
   */
  basis:
    | 'daily'
    | 'weekly'
    | 'pay_period'
    | 'seventh_day'
    | 'beyond_scheduled_tour'
    | 'consecutive'
    | 'beyond_scheduled_days';
  thresholdHours: number;
  multiplier: number;
  active: boolean;
  /**
   * Whether hours another rule already pays as overtime still count toward this one's threshold.
   * Honoured only by 'weekly' and 'pay_period'. Under 'none' a shift adds only its straight hours
   * (those before any other basis's overtime starts): Cal. Lab. Code § 510 as the DLSE reads it
   * does not count hours paid at a daily premium toward the weekly 40, and UC–CNA Art. 14 §M
   * credits daily overtime toward the 80. Absent: 'stack', every worked hour counts.
   */
  pyramiding?: 'stack' | 'none';
  /**
   * Overtime under this rule shorter than this many minutes on one shift is not paid (VA: overtime
   * under 15 minutes is not paid); the shift is straight time under this rule. Judged per rule per
   * shift, not per workday. Absent: 0, every minute counts.
   */
  minimumMinutes?: number;
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
  /**
   * For a minor holiday: the major holiday the manager paired it with — Christmas Eve with
   * Christmas Day, or Memorial Day with Thanksgiving, any distance apart. When the rule set pairs
   * minor holidays with majors, whoever works one of the two is kept off the other. Null for a
   * major holiday or an unpaired minor one.
   */
  pairedHolidayId: Id | null;
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
