/**
 * The contract between the renderer and the main process.
 *
 * This is the one file both sides of the IPC boundary import. It is deliberately shaped like
 * a small HTTP API — nouns, then verbs, plain-data arguments and results — because that is
 * what it becomes when nurses get a web/mobile client: the renderer keeps calling
 * `api.timeOff.list(...)` and only the transport underneath changes.
 *
 * Only `import type` from `@shiftnurse/core` here. The renderer bundles this file, and a
 * value import would drag the domain engine into a web context that has no business
 * running it.
 */

import type {
  AcuityTier,
  Assignment,
  AutoResolvePolicy,
  BacktestResult,
  BalanceCheck,
  Budget,
  BudgetVariance,
  CallAttempt,
  CallOff,
  CallOutcome,
  CancellationTier,
  CensusForecast,
  CensusProposal,
  ComplianceAlert,
  ConflictReport,
  CoverageRequirement,
  Credential,
  DayOfPay,
  Differential,
  EvaluationResult,
  ExchangeEvaluation,
  ExchangeProposal,
  FairnessLedgerEntry,
  FairnessReport,
  FmlaEntitlementBasis,
  FmlaRegime,
  ForecastOptions,
  HistoricalCsvError,
  HistoricalShiftRow,
  Holiday,
  HolidayYearPlan,
  HppdReport,
  HppdTarget,
  Id,
  IncompatibilityGroup,
  IsoDate,
  JurisdictionId,
  LeaveAward,
  LeaveBalanceType,
  LeaveBid,
  LeaveBidChoice,
  LeaveBidRound,
  LeaveDenial,
  LeavePolicy,
  Nurse,
  NurseCredential,
  NurseRole,
  OvertimeRule,
  OvertimeVolunteer,
  PayRate,
  PlannedHoliday,
  Preceptorship,
  Preference,
  RatioRole,
  RatioRule,
  ReplacementReport,
  RequestOrigin,
  Resolution,
  RosterCsvError,
  RosterCsvRow,
  RuleSet,
  ScheduleChange,
  ScheduleCost,
  ScheduleDiff,
  ScheduleDigest,
  SchedulePeriod,
  ScheduleVersion,
  SetupPhase,
  SetupPreset,
  SetupPresetResult,
  SetupState,
  SetupStepId,
  ShiftDemand,
  ShiftStaffingCheck,
  ShiftSwap,
  ShiftSwapStatus,
  ShiftType,
  SolveProgress,
  SolverId,
  SolverSettings,
  TimeOffImpact,
  TimeOffRequest,
  TimeOffStatus,
  TimeOffType,
  Unit,
  UnitSetupMode,
} from '@shiftnurse/core';

/** Which screen a launch opens, and the persisted setup record behind the decision. */
export interface SetupStatus {
  phase: SetupPhase;
  /** Absent on a brand-new install, and on one that predates first-run setup. */
  state: SetupState | undefined;
  /** Whether the welcome screen may offer the test-scenario database (development only). */
  scenariosAvailable: boolean;
}

/** One realistic demo unit the welcome screen offers (`db/seed/demo.ts`). */
export interface DemoSummary {
  id: string;
  name: string;
  /** Where a unit like this is found. */
  setting: string;
  summary: string;
  /** What makes this unit's rules and operations different, one line each. */
  highlights: string[];
}

export type UnitInput = Omit<Unit, 'id'>;
/** A unit's name, type and ratio staffing. Its pay-period calendar is fixed once hours have been counted in it. */
export type UnitPatch = Partial<Pick<Unit, 'name' | 'unitType' | 'ratioStaffing'>> & {
  /** `null` clears the notice rule. */
  postingLeadDays?: number | null;
  /** `null` clears the policy: FMLA and balances revert to the pre-policy reading. */
  leavePolicy?: LeavePolicy | null;
};

export interface AppInfo {
  version: string;
  /** `process.platform` as a plain string, so this file needs no Node types in the renderer. */
  platform: string;
  /** Absolute path of the SQLite file, shown in the About panel so support can find it. */
  databasePath: string;
}

/** A published release newer than the running app (see `main/updates.ts`). */
export interface UpdateInfo {
  version: string;
  /** The release's GitHub page, where the installers are. */
  url: string;
}

/** One shift that approving a request would free, and who could take it, best first. */
export interface LeaveCoverOption {
  assignment: Assignment;
  /** Nurse-slots the shift is short of its minimum without the requester. */
  shortfall: number;
  candidates: { nurseId: Id; label: string; payTier: string; overtime: boolean }[];
}

/** The manager's pick for one freed shift. */
export interface LeaveCover {
  assignmentId: Id;
  nurseId: Id;
}

export interface ExpiringCredentialView {
  nurse: Nurse;
  credential: Credential;
  nurseCredential: NurseCredential;
}

export interface OnShiftView {
  shiftType: ShiftType;
  nurses: Nurse[];
}

export interface DashboardSummary {
  unit: Unit;
  today: IsoDate;
  activeNurses: number;
  currentDraft: SchedulePeriod | undefined;
  /** Shifts on the current draft: none means it still needs generating. */
  draftShifts: number;
  /** The last day to post the current draft under the unit's notice rule; absent without one. */
  postBy?: IsoDate;
  latestPublished: SchedulePeriod | undefined;
  pendingTimeOff: number;
  openCallOffs: number;
  /** Credentials expiring from today through the next 90 days, soonest first. */
  expiringCredentials: ExpiringCredentialView[];
  /** Credentials already past their expiry (within the last year) with no valid renewal. */
  lapsedCredentials: ExpiringCredentialView[];
  /** Who is on each shift today, from the published schedule. */
  todayOnShift: OnShiftView[];
}

export type NurseInput = Omit<Nurse, 'id'>;

/** A group's members, cap and dates. The reason travels separately, as for every audited change. */
export type IncompatibilityGroupInput = Omit<IncompatibilityGroup, 'id' | 'reason'>;

/** Optional dates take `null` to clear them. The unit never changes. */
export interface IncompatibilityGroupPatch {
  name?: string;
  nurseIds?: Id[];
  maxTogether?: number;
  startsOn?: IsoDate | null;
  endsOn?: IsoDate | null;
}

/** A standing offer to work overtime. The unit and nurse are fixed once recorded. */
export type OvertimeVolunteerInput = Omit<OvertimeVolunteer, 'id'>;

/** `note: null` clears the note; an omitted key is left untouched. */
export interface OvertimeVolunteerPatch {
  startDate?: IsoDate;
  endDate?: IsoDate;
  note?: string | null;
}

/** Where a bidding round stands; it only moves forward. */
export type LeaveBidRoundStatus = 'open' | 'closed' | 'awarded';

/** A bidding round as the manager manages it: core's judging fields plus the window and status. */
export interface LeaveBidRoundRecord extends LeaveBidRound {
  /** The announced bidding window. Informational: the status decides whether a bid is taken. */
  opensOn: IsoDate;
  closesOn: IsoDate;
  status: LeaveBidRoundStatus;
  /** When the award ran (epoch millis); absent until it has. */
  awardedAt?: number;
}

/** A nurse's bid with when it was last entered. */
export interface LeaveBidRecord extends LeaveBid {
  submittedAt: number;
  /** 'manager' in v1; 'nurse' once self-service ships. */
  enteredBy: RequestOrigin;
}

export type LeaveBidRoundInput = Omit<LeaveBidRoundRecord, 'id' | 'status' | 'awardedAt'>;

/** The unit never changes; `maxAwardsPerNurse: null` removes the limit. */
export interface LeaveBidRoundPatch {
  name?: string;
  coversStart?: IsoDate;
  coversEnd?: IsoDate;
  opensOn?: IsoDate;
  closesOn?: IsoDate;
  offPerDay?: Partial<Record<NurseRole, number>>;
  maxAwardsPerNurse?: number | null;
}

/** One award: the week, the nurse's name and the approved request it became. */
export interface LeaveAwardView extends LeaveAward {
  nurseName: string;
  requestId: Id;
  /** Draft shifts the approval took off the grid. */
  liftedShifts: number;
  /** Published-period shifts left in place, now a conflict to resolve. */
  stillRostered: number;
}

export interface LeaveDenialView extends LeaveDenial {
  nurseName: string;
}

/** What an award did, in the order nurses were served and with every denial's reason. */
export interface LeaveBidAwardResult {
  round: LeaveBidRoundRecord;
  order: { nurseId: Id; nurseName: string }[];
  awards: LeaveAwardView[];
  denials: LeaveDenialView[];
}

/** A nurse's leave balance as entered from payroll, true on `asOf`. */
export interface LeaveBalanceRecord {
  id: Id;
  nurseId: Id;
  type: LeaveBalanceType;
  balanceHours: number;
  asOf: IsoDate;
}

/** An FMLA certification; the dates are inclusive. */
export interface FmlaCertificationRecord {
  id: Id;
  nurseId: Id;
  startDate: IsoDate;
  endDate: IsoDate;
  intermittent: boolean;
  note?: string;
}

export type FmlaCertificationInput = Omit<FmlaCertificationRecord, 'id'>;

/** The nurse is fixed once recorded. `note: null` clears the note. */
export interface FmlaCertificationPatch {
  startDate?: IsoDate;
  endDate?: IsoDate;
  intermittent?: boolean;
  note?: string | null;
}

/** What the request dialogs show about a nurse's leave before a request is saved or decided. */
export interface LeaveRequestCheck {
  /**
   * A request drawn on a balance (PTO, annual, sick, comp): payroll's figure carried forward to the
   * request's first day, and the paid hours measured against that.
   */
  balance?: {
    type: LeaveBalanceType;
    /** Payroll's figure, true on `asOf`. */
    balanceHours: number;
    asOf: IsoDate;
    /** What the nurse will have on the request's first day: payroll's figure plus the parts below. */
    projectedHours: number;
    accruedHours: number;
    /** Approved leave of this type taken since `asOf`. */
    usedHours: number;
    /** Lost to the carryover cap at a leave-year turnover since `asOf`. */
    forfeitedHours: number;
    check: BalanceCheck;
  };
  /** A balance-type request for a nurse with no balance entered: nothing to check against. */
  noBalanceFor?: LeaveBalanceType;
  /** FMLA requests: the entitlement under the unit's regime and the eligibility tests. */
  fmla?: {
    /** Which FMLA the unit's employer is under. */
    regime: FmlaRegime;
    /** The hours of leave the nurse has in a 12-month year. */
    entitlementHours: number;
    /** How the entitlement was worked out. */
    basis: FmlaEntitlementBasis;
    /** The 12 months this request is counted in, inclusive. */
    period: { from: IsoDate; to: IsoDate };
    /** The nurse's usual hours a week, from their contract. */
    weeklyHours: number;
    /** Hours this request uses: its days at the usual week's pace. */
    requestHours: number;
    /** Left of the 12 work weeks before this request, in the year back from its first day. */
    remainingHours: number;
    eligibility: { eligible: true } | { eligible: false; reason: string };
    /** A certification on file covers the request's first day. */
    certified: boolean;
  };
}

/**
 * An orientation: one orientee and the preceptor(s) who oversee them over the same dates. One
 * record is stored per preceptor; an orientee may work any shift one of them is on.
 */
export interface PreceptorshipInput {
  unitId: Id;
  orienteeId: Id;
  preceptorIds: Id[];
  startDate: IsoDate;
  endDate: IsoDate;
}

/** The unit and the pair are fixed once recorded; only the dates change. */
export interface PreceptorshipPatch {
  startDate?: IsoDate;
  endDate?: IsoDate;
}

/**
 * A nurse who also works on a unit other than their home unit. Dates are inclusive and open on
 * a side that is absent; `competency` is what the nurse may be asked to do there.
 */
export interface NurseUnit {
  id: Id;
  nurseId: Id;
  unitId: Id;
  competency?: string;
  startDate?: IsoDate;
  endDate?: IsoDate;
}

export interface NurseUnitInput {
  nurseId: Id;
  unitId: Id;
  competency?: string;
  startDate?: IsoDate;
  endDate?: IsoDate;
}

/** The nurse and the unit are fixed once recorded; `null` clears a field. */
export interface NurseUnitPatch {
  competency?: string | null;
  startDate?: IsoDate | null;
  endDate?: IsoDate | null;
}

/** Optional-and-clearable fields take `null` to clear; an omitted key is left untouched. */
export type NursePatch = Partial<
  Omit<Nurse, 'id' | 'unitId' | 'phone' | 'email' | 'notes' | 'hireDate'>
> & {
  hireDate?: IsoDate | null;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
};

/** A new shift type; standalone unless `withinShiftTypeId` names the shift it runs inside. */
export type ShiftTypeInput = Omit<ShiftType, 'id' | 'withinShiftTypeId'> &
  Partial<Pick<ShiftType, 'withinShiftTypeId'>>;
export type ShiftTypePatch = Partial<Omit<ShiftType, 'id' | 'unitId'>>;

/** A preference as the editor submits it: identity is assigned on save. */
export type PreferenceInput = Preference extends infer P
  ? P extends Preference
    ? Omit<P, 'id' | 'nurseId'>
    : never
  : never;

export type CoverageRequirementInput = Omit<CoverageRequirement, 'id'> & { id?: Id };

/** A new holiday; unpaired unless `pairedHolidayId` names the major holiday it goes with. */
export type HolidayInput = Omit<Holiday, 'id' | 'pairedHolidayId'> &
  Partial<Pick<Holiday, 'pairedHolidayId'>>;
export type HolidayPatch = Partial<Pick<Holiday, 'name' | 'isMajor' | 'pairedHolidayId'>>;

/** A year of holidays as the manager approved it: `HolidayYearPlan`'s rows, edited. */
export interface HolidayYearInput {
  holidays: Pick<PlannedHoliday, 'key' | 'date' | 'name' | 'isMajor' | 'pairWith'>[];
  repairs: HolidayYearPlan['repairs'];
}

export interface HolidayWorkSummary {
  holidayId: Id;
  /** True when the list was recorded by hand rather than read from published schedules. */
  recorded: boolean;
  /** Who the holiday rotation counts as having worked it. */
  nurseIds: Id[];
  /** What published schedules say, for comparison. */
  fromSchedules: Id[];
}

export type AcuityTierInput = Omit<AcuityTier, 'id'>;
export type AcuityTierPatch = Partial<Omit<AcuityTier, 'id' | 'unitId'>>;
export type RatioRuleInput = Omit<RatioRule, 'id'>;
export type RatioRulePatch = Partial<
  Omit<RatioRule, 'id' | 'unitId' | 'citation' | 'minRnShare'>
> & {
  citation?: string | null;
  minRnShare?: number | null;
};

export interface CensusForecastInput {
  unitId: Id;
  date: IsoDate;
  shiftTypeId: Id;
  projectedCensus: number;
  acuityMix: Record<Id, number>;
  source: CensusForecast['source'];
}

/** A shift the manager places by hand. `source` is not an input: main stamps every IPC
 * create as `'manual'`, so a solver or call-out row can only come from the code that makes one. */
export interface CreateAssignmentInput {
  periodId: Id;
  nurseId: Id;
  shiftTypeId: Id;
  date: IsoDate;
  isLocked?: boolean;
  isCharge?: boolean;
  isOvertime?: boolean;
  notes?: string;
}

/** An in-place edit. Changing date, shift or nurse is a move (`moveAssignment`), which refuses a
 * locked shift; locking is `setLocked`. */
export type AssignmentPatch = Partial<
  Pick<CreateAssignmentInput, 'isCharge' | 'isOvertime' | 'notes'>
>;

/** Move a shift from one nurse/date/type to another. Assignment identity (`nurseId`) is
 * immutable, so a move is a delete-and-recreate, done in one transaction so the grid never
 * observes a half-moved shift. */
export interface MoveAssignmentInput {
  assignmentId: Id;
  nurseId: Id;
  shiftTypeId: Id;
  date: IsoDate;
}

export interface ScheduleValidation {
  ruleSet: RuleSet;
  result: EvaluationResult;
  /** Assignment id → the preferences that shift goes against (only shifts with any). */
  againstPreference: Record<Id, Preference[]>;
}

export interface RosterImportPreview {
  /** Absolute path of the file the manager picked, for the confirmation screen. */
  path: string;
  rows: RosterCsvRow[];
  errors: RosterCsvError[];
  /** Employee ids in the file that already exist on the unit — these will be updated. */
  existingEmployeeIds: string[];
}

export interface RosterImportSummary {
  created: number;
  updated: number;
  credentialsCreated: string[];
  credentialsGranted: number;
  credentialsUpdated: number;
}

/** One ledger period's scores, for the trend chart: what each nurse's score *was* back then. */
export interface FairnessTrendPoint {
  periodId: Id;
  periodStart: IsoDate;
  /** nurseId → 0–100 composite at that period, judged against the history before it. */
  scores: Record<Id, number>;
  /** Unit-level Gini of the scores at that period. */
  gini: number;
}

export interface HistoryImportPeriodPreview {
  periodId: Id;
  start: IsoDate;
  end: IsoDate;
  shifts: number;
  nurses: number;
  /** True when the ledger already holds rows for this period — the import will replace them. */
  replacesExisting: boolean;
}

export interface HistoryImportPreview {
  path: string;
  rows: HistoricalShiftRow[];
  errors: HistoricalCsvError[];
  periods: HistoryImportPeriodPreview[];
}

export interface HistoryImportSummary {
  periodsImported: number;
  entriesWritten: number;
  entriesReplaced: number;
}

export type PayRateInput = Omit<PayRate, 'id'>;
/** Scope (nurse or role) is fixed once created; re-scoping is a delete and a create. */
export type PayRatePatch = Partial<Pick<PayRate, 'hourlyRate' | 'effectiveFrom'>>;
export type DifferentialInput = Omit<Differential, 'id'>;
/** `window: null` clears the clock window. */
export type DifferentialPatch = Partial<
  Pick<Differential, 'kind' | 'mode' | 'amount' | 'active'>
> & {
  window?: Differential['window'] | null;
};
export type OvertimeRuleInput = Omit<OvertimeRule, 'id'>;
export type OvertimeRulePatch = Partial<
  Pick<OvertimeRule, 'basis' | 'thresholdHours' | 'multiplier' | 'active'>
>;

/** A period priced under its own rule-set snapshot, against its budget if one is set. */
export interface PeriodCostReport {
  period: SchedulePeriod;
  cost: ScheduleCost;
  budget: Budget | undefined;
  variance: BudgetVariance | undefined;
  /**
   * What the period's day-of events cost (missed breaks, send-homes, call-backs), priced beside
   * the schedule and never added into `cost`: a schedule's price is the same before and after
   * the day. `unpriced` counts events for nurses with no pay rate, which are not $0.
   */
  dayOf: DayOfPay;
}

/** Pay settings that are not rates, differentials or overtime rules. */
export interface PaySettings {
  /** The fewest hours a call-back pays, from the contract. 0 pays the hours worked. */
  callBackMinimumHours: number;
}

/** A day-of event as recorded: paid outside the schedule, priced beside its cost. */
export interface DayOfPayRecord {
  id: Id;
  unitId: Id;
  nurseId: Id;
  kind: 'missed_break' | 'sent_home' | 'call_back';
  date: IsoDate;
  shiftTypeId?: Id;
  break?: 'meal' | 'rest';
  scheduledHours?: number;
  hoursWorked?: number;
  note?: string;
  enteredBy: 'manager' | 'nurse';
  createdAt: number;
}

/** What the day-of console records; hours are the ones the kind needs. */
export type DayOfPayEntry =
  | {
      kind: 'missed_break';
      unitId: Id;
      nurseId: Id;
      date: IsoDate;
      shiftTypeId?: Id;
      break: 'meal' | 'rest';
      note?: string;
    }
  | {
      kind: 'sent_home';
      unitId: Id;
      nurseId: Id;
      date: IsoDate;
      shiftTypeId?: Id;
      scheduledHours: number;
      hoursWorked?: number;
      note?: string;
    }
  | {
      kind: 'call_back';
      unitId: Id;
      nurseId: Id;
      date: IsoDate;
      shiftTypeId?: Id;
      hoursWorked: number;
      note?: string;
    };

/** What can be filled in afterwards: a send-home's or call-back's real hours, and the note. */
export interface DayOfPayPatch {
  hoursWorked?: number;
  note?: string | null;
}

export interface CreateTimeOffInput {
  nurseId: Id;
  startDate: IsoDate;
  endDate: IsoDate;
  type: TimeOffType;
  reason?: string;
  /** Paid leave hours: the shifts the nurse would have worked. Counts toward their contract. */
  paidHours?: number;
}

export interface TimeOffApproval {
  request: TimeOffRequest;
  lifted: Assignment[];
  stillRostered: Assignment[];
}

/** What one auto-resolve pass did: the resolutions it applied, then the period re-analysed. */
export interface AutoResolveResult {
  applied: Resolution[];
  report: ConflictReport;
}

/**
 * What publishing now would send to staff, shown before the manager commits: the diff
 * against the last version (everything is `added` on a first publish), the reasoned edits
 * since then, the compliance alerts, and how many hard violations the rule engine still sees.
 */
export interface PublishPreview {
  period: SchedulePeriod;
  latestVersion: ScheduleVersion | undefined;
  diff: ScheduleDiff;
  pendingChanges: ScheduleChange[];
  alerts: ComplianceAlert[];
  hardViolations: number;
  softViolations: number;
  /** True when a republish would carry nothing — the button should say so. */
  nothingToPublish: boolean;
}

export interface PublishOutcome {
  period: SchedulePeriod;
  version: ScheduleVersion;
  diff: ScheduleDiff;
  ledgerEntries: number;
  /** The backup written on publish, if the file system allowed one. */
  backup: BackupInfo | undefined;
}

export type NurseRecordFormat = 'csv' | 'pdf';

export type OutputFormat = 'pdf-grid' | 'pdf-nurses' | 'csv-grid' | 'csv-long' | 'xlsx';

export interface BackupInfo {
  fileName: string;
  path: string;
  /** `publish`, `daily`, `manual`, `pre-restore` or `pre-reset`, from the file name. */
  kind: string;
  createdAt: number;
  bytes: number;
}

/** A backup deleted from the list, held in the trash until `purgeAt`. */
export interface DeletedBackupInfo extends BackupInfo {
  deletedAt: number;
  purgeAt: number;
}

export interface SolveBatchOptions {
  /** How many variations to generate, 1–10; one when absent. */
  count?: number;
  /**
   * Carry on after this batch's variations — numbering and seeds — so the new batch tries seeds
   * not yet tried. Absent: start at variation 1, which on unchanged inputs repeats the first batch.
   */
  continueAfter?: Id;
  /** Defaults to a stable hash of the period id, so regenerating unchanged inputs repeats itself. */
  seed?: number;
  /** Defaults to the unit's saved budget, then the job default. */
  maxIterations?: number;
  /** A one-off override of the unit's saved solver. */
  solver?: SolverId;
  /** CP-SAT's search budget in deterministic time units; its default when absent. */
  deterministicTime?: number;
}

/** Whether a backend can run on this install, and if not, why not. */
export interface SolverAvailability {
  id: SolverId;
  available: boolean;
  reason?: string;
}

/**
 * A run waits `queued` until a slot frees up, then runs. A stopped run is `cancelled` and its
 * best-so-far is not kept as a candidate — the manager said stop.
 */
export type SolveRunState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** One role on one shift a run left below its hard minimum. */
export interface UnfilledShift {
  date: IsoDate;
  shiftTypeId: Id;
  /** A role, or `licensed` for a short RN + LPN pool. */
  role: RatioRole;
  shortfall: number;
}

/** A finished run's headline numbers, from its solve report. */
export interface SolveRunSummary {
  objective: number;
  /** The schedule in a manager's terms (core's `ScheduleDigest`). */
  digest: ScheduleDigest;
  /** Total cost and overtime hours, when the unit has pay rates. */
  costTotal?: number;
  overtimeHours?: number;
  /** Nurse-slots still below a hard minimum, summed over every short shift. */
  floorsShort: number;
  /** Shifts (and roles) with any shortfall. */
  unfilledSlots: number;
  /** The first 50 of them (main caps it, so a hopeless run ships no hundreds of rows), so the manager is told which shifts rather than a count. */
  unfilled: UnfilledShift[];
  hardViolations: number;
  softViolations: number;
  elapsedMs: number;
  /** CP-SAT's relative optimality gap, when it proved a bound. */
  gap?: number;
  /** Hybrid only: CP-SAT windows attempted, and how many improved the schedule. */
  windows?: { tried: number; improved: number };
}

export interface SolveRunStatus {
  index: number;
  seed: number;
  /** The backend that ran (or will run) this variation, after any fallback. */
  solver: SolverId;
  fellBackFrom?: { solver: SolverId; reason: string };
  state: SolveRunState;
  startedAt?: number;
  finishedAt?: number;
  progress?: SolveProgress;
  summary?: SolveRunSummary;
  error?: string;
}

/**
 * One Generate: N variations of a period, held in main as candidates until one is saved to the
 * draft. `running` while any run is queued or running.
 */
export interface SolveBatchStatus {
  id: Id;
  periodId: Id;
  /** The backend the batch asked for, after any up-front fallback. */
  solver: SolverId;
  fellBackFrom?: { solver: SolverId; reason: string };
  state: 'running' | 'done';
  cancelled: boolean;
  count: number;
  /**
   * Variations generated before this batch in the period's sequence: run k is variation
   * `offset + k + 1`, seeded `seed + offset + k`.
   */
  offset: number;
  /** How many runs execute at once. */
  concurrency: number;
  startedAt: number;
  finishedAt?: number;
  runs: SolveRunStatus[];
  /** The finished run with the lowest objective. */
  best?: number;
  /**
   * The schedule on the grid now, scored the way every variation is; absent when the grid is
   * empty. When it is no higher than `best`'s, keeping the grid is the best choice.
   */
  draftObjective?: number;
  /** The run most recently saved to the draft. */
  saved?: number;
  /** Set once anything the solver read has changed: the candidates are gone and none can be saved. */
  stale?: string;
}

export interface SolveEstimate {
  solver: SolverId;
  count: number;
  perRunMs: number;
  concurrency: number;
  waves: number;
  totalMs: number;
  /** `observed` from the last run of this solver on this unit; `rough` before there is one. */
  basis: 'observed' | 'rough';
}

/** A candidate as the grid would judge it, for previewing it in place of the draft. */
export interface CandidatePreview {
  batchId: Id;
  index: number;
  assignments: Assignment[];
  validation: ScheduleValidation;
  cost: PeriodCostReport;
  /** The compliance alerts the publish dialog would show for this variation. */
  alerts: ComplianceAlert[];
  /** Shifts the candidate adds or changes against the draft, keyed `nurseId|date|shiftTypeId`. */
  changedKeys: string[];
  diff: { added: number; removed: number; changed: number };
}

/** One column of the comparison: the current draft or one candidate, scored the same way. */
export interface ComparisonColumn {
  /** Absent for the current draft. */
  index?: number;
  seed?: number;
  solver?: SolverId;
  fellBackFrom?: { solver: SolverId; reason: string };
  elapsedMs?: number;
  /** Nurse-slots below a hard minimum. */
  floorsShort: number;
  hardViolations: number;
  softViolations: number;
  /** Mean of the per-nurse fairness scores (0–100, higher is fairer). */
  fairnessMean: number;
  /** Gini over the per-nurse fairness scores (0 is perfectly even). */
  fairnessGini: number;
  /** The nurse this schedule treats worst. */
  worstNurse?: { nurseId: Id; score: number };
  /** Objective points given up to unmet preferences (lower is better). */
  preferencePoints: number;
  /** The whole objective (lower is better); the one number the solver minimises. */
  objective: number;
  overtimeHours?: number;
  costTotal?: number;
  unpricedAssignments?: number;
  budgetVariance?: BudgetVariance;
  /** Shifts added, removed or changed against the current draft; 0 for the draft itself. */
  shiftsChanged: number;
  /** The schedule in a manager's terms (core's `ScheduleDigest`). */
  digest: ScheduleDigest;
}

export interface CandidateComparison {
  batchId: Id;
  draft: ComparisonColumn;
  candidates: ComparisonColumn[];
}

/**
 * Every operation the renderer can perform, grouped by resource. Implementations in the
 * main process are synchronous (better-sqlite3 is synchronous); the renderer sees the
 * `Promise`-returning shape in {@link RendererApi} because IPC is asynchronous.
 */
// ---------------------------------------------------------------------------
// Day-of console (M13)
// ---------------------------------------------------------------------------

/** One nurse on one shift, with the open call-off against it when there is one. */
export interface RosterEntryView {
  assignment: Assignment;
  nurse: Nurse;
  callOff?: CallOff;
}

/**
 * A role with more nurses on a shift than its requirement, computed in main from the staffing
 * check: the census dropped (or was never as high as forecast) and the unit may send someone home.
 */
export interface OverstaffedRole {
  /** The period whose assignments these are; the cancellation calls take it back. */
  periodId: Id;
  role: NurseRole;
  required: number;
  staffed: number;
  /** `staffed − required`, always above zero. */
  excess: number;
}

/** A shift as the Today screen shows it: who is on it, and whether it is staffed. */
export interface TodayShiftView {
  date: IsoDate;
  shiftType: ShiftType;
  /** The census row for this slot, if one exists (projected and, once entered, actual). */
  census?: CensusForecast;
  staffing: ShiftStaffingCheck;
  /** Roles over their requirement; empty when the shift is staffed to need or short. */
  overstaffed: OverstaffedRole[];
  roster: RosterEntryView[];
  /** `current` when the wall clock is inside its window, `next` for the one starting soonest. */
  status: 'current' | 'next' | 'other';
}

export interface DayOfSummary {
  date: IsoDate;
  /** Host wall-clock minute of `date`, read in main; the renderer never touches the clock. */
  minuteOfDay: number;
  /** The period whose assignments these are (published preferred over draft), if any covers `date`. */
  period: SchedulePeriod | undefined;
  /** Current and next slots first, then the rest of `date`'s shifts in sort order. */
  shifts: TodayShiftView[];
  /** Every open call-off on this unit, whatever the date, soonest shift first. */
  openCallOffs: CallOffView[];
}

/** One place in the cancellation order, with the name the console prints. */
export interface CancellationPlaceView {
  nurseId: Id;
  assignmentId: Id;
  name: string;
  tier: CancellationTier;
  /** The order's own words for why this nurse holds this place, shown verbatim. */
  reason: string;
}

/** Who goes home first on a shift that has more nurses than it needs. */
export interface CancellationOrderView {
  periodId: Id;
  date: IsoDate;
  shiftTypeId: Id;
  role: NurseRole;
  required: number;
  staffed: number;
  /** How many more than needed; zero means nobody should be cancelled. */
  excess: number;
  order: CancellationPlaceView[];
  /** On the shift but never cancelled (the charge nurse), with why. */
  excluded: { nurseId: Id; name: string; reason: string }[];
}

/** A nurse sent home for low census. The shift itself is gone from the schedule. */
export interface ShiftCancellationRecord {
  id: Id;
  periodId: Id;
  nurseId: Id;
  shiftTypeId: Id;
  date: IsoDate;
  reason: string;
  cancelledAt: number;
  enteredBy: 'manager' | 'nurse';
}

/** A call-off with everything the console needs to act on it, joined in main. */
export interface CallOffView {
  callOff: CallOff;
  /** The absent nurse's row while it still exists; a backfill replaces it, so covered call-offs have none. */
  assignment?: Assignment;
  nurse: Nurse;
  shiftType: ShiftType;
  period: SchedulePeriod;
  /** Newest first. */
  attempts: CallAttempt[];
  /** Present once covered. */
  replacement?: { assignment: Assignment; nurse: Nurse };
}

export interface BackfillResult {
  callOff: CallOff;
  /** The `accepted` attempt that closed the search. */
  attempt: CallAttempt;
  /** The `source: 'callout'` row now on the schedule. */
  assignment: Assignment;
}

export interface ShiftNurseApi {
  app: {
    info(): AppInfo;
    /** A newer release, once the launch check has found one; null otherwise. */
    update(): UpdateInfo | null;
    /** Show the folder holding the main-process log in the file manager. */
    openLogs(): void;
  };
  units: {
    list(): Unit[];
    update(id: Id, patch: UnitPatch): Unit;
  };
  setup: {
    status(): SetupStatus;
    /** The realistic demo units on offer, the default first. */
    demos(): DemoSummary[];
    /** Seeds the named demo unit. Refused once any unit exists. */
    loadDemo(demoId: string): Unit;
    /** Seeds the test-scenario unit. Development only; refused once any unit exists. */
    loadScenarios(): Unit;
    /** The unit a manual or assisted setup starts from. Refused once any unit exists. */
    createUnit(input: UnitInput, mode: UnitSetupMode): Unit;
    advance(move: { from: SetupStepId; to: SetupStepId; skipped: boolean }): SetupState;
    complete(): SetupState;
    /** Reopens the assisted guide on the existing unit, from Settings. */
    resume(): SetupState;
    applyPreset(unitId: Id, preset: SetupPreset): SetupPresetResult;
    /**
     * Applies a state's ratio ceilings, overtime rules and rule switches to the unit, only ever
     * tightening, and remembers the choice on the unit. Pressing it twice changes nothing.
     */
    applyJurisdiction(unitId: Id, jurisdiction: JurisdictionId): SetupPresetResult;
    /**
     * Saves the live database as a `pre-reset` backup, deletes it and relaunches into the
     * welcome screen. The call returns before the relaunch.
     */
    startOver(): Promise<BackupInfo>;
  };
  dashboard: {
    summary(unitId: Id): DashboardSummary;
  };
  nurses: {
    list(unitId: Id): Nurse[];
    get(id: Id): Nurse | undefined;
    create(input: NurseInput): Nurse;
    update(id: Id, patch: NursePatch): Nurse;
    deactivate(id: Id): Nurse;
  };
  /** A nurse's record for a grievance: their audit entries and published-shift changes. */
  nurseRecord: {
    /**
     * Writes the record for the inclusive date range through a native save dialog; resolves to
     * the path, or undefined when the manager cancels. Kept-apart entries are never included.
     */
    exportToFile(
      nurseId: Id,
      start: IsoDate,
      end: IsoDate,
      format: NurseRecordFormat,
    ): Promise<string | undefined>;
  };
  /** The float pool: units a nurse works on besides their home unit. */
  nurseUnits: {
    forNurse(nurseId: Id): NurseUnit[];
    /** Nurses from other units who may work on this one, for the grid's rows and names. */
    floatingIn(unitId: Id): Nurse[];
    /** Who a period's schedule may hold: the home roster, then floats whose dates touch it. */
    roster(periodId: Id): Nurse[];
    create(input: NurseUnitInput): NurseUnit;
    update(id: Id, patch: NurseUnitPatch): NurseUnit;
    remove(id: Id): void;
  };
  credentials: {
    /** The catalogue of credential types (ACLS, BLS…). */
    list(): Credential[];
    create(input: Omit<Credential, 'id'>): Credential;
    forNurse(nurseId: Id): NurseCredential[];
    grant(input: Omit<NurseCredential, 'id'>): NurseCredential;
    updateExpiry(id: Id, expiresOn: IsoDate | undefined): NurseCredential;
    revoke(id: Id): void;
  };
  preferences: {
    forNurse(nurseId: Id): Preference[];
    replace(nurseId: Id, preferences: PreferenceInput[]): Preference[];
  };
  /** Nurses kept off the floor together. Every change needs a reason, which is audited. */
  incompatibility: {
    list(unitId: Id): IncompatibilityGroup[];
    create(input: IncompatibilityGroupInput, reason: string): IncompatibilityGroup;
    update(id: Id, patch: IncompatibilityGroupPatch, reason: string): IncompatibilityGroup;
    remove(id: Id, reason: string): void;
  };
  /** Nurses' recorded offers to work overtime, which make an overtime shift voluntary. */
  overtimeVolunteers: {
    list(unitId: Id): OvertimeVolunteer[];
    create(input: OvertimeVolunteerInput): OvertimeVolunteer;
    update(id: Id, patch: OvertimeVolunteerPatch): OvertimeVolunteer;
    remove(id: Id): void;
  };
  /** Seniority leave bidding: rounds, the bids in them, and the one-time award in seniority order. */
  leaveBidding: {
    rounds(unitId: Id): LeaveBidRoundRecord[];
    createRound(input: LeaveBidRoundInput): LeaveBidRoundRecord;
    updateRound(id: Id, patch: LeaveBidRoundPatch): LeaveBidRoundRecord;
    closeRound(id: Id): LeaveBidRoundRecord;
    bids(roundId: Id): LeaveBidRecord[];
    /** Enter or replace a nurse's ranked choices; v1 is the manager entering them. */
    submitBid(roundId: Id, nurseId: Id, choices: LeaveBidChoice[]): LeaveBidRecord;
    /** Approves each award as PTO and lifts draft shifts; once only. */
    award(roundId: Id): LeaveBidAwardResult;
  };
  /** Leave balances and FMLA certifications, and the check a request is shown against them. */
  leaveBalances: {
    forNurse(nurseId: Id): {
      balances: LeaveBalanceRecord[];
      certifications: FmlaCertificationRecord[];
    };
    /** Replaces the nurse's balance of that type; the previous figure is kept in the audit log. */
    setBalance(
      nurseId: Id,
      type: LeaveBalanceType,
      balanceHours: number,
      asOf: IsoDate,
    ): LeaveBalanceRecord;
    addCertification(input: FmlaCertificationInput): FmlaCertificationRecord;
    updateCertification(id: Id, patch: FmlaCertificationPatch): FmlaCertificationRecord;
    removeCertification(id: Id): void;
    /** Warnings only: a short balance or an ineligible nurse never blocks the request. */
    checkRequest(
      nurseId: Id,
      type: TimeOffType,
      startDate: IsoDate,
      endDate: IsoDate,
      paidHours: number,
    ): LeaveRequestCheck;
  };
  /** Who is oriented by whom, which keeps an orientee on shifts a preceptor works. */
  preceptorships: {
    list(unitId: Id): Preceptorship[];
    /** One record per preceptor, all or none. */
    create(input: PreceptorshipInput): Preceptorship[];
    update(id: Id, patch: PreceptorshipPatch): Preceptorship;
    remove(id: Id): void;
  };
  shiftTypes: {
    list(unitId: Id): ShiftType[];
    create(input: ShiftTypeInput): ShiftType;
    update(id: Id, patch: ShiftTypePatch): ShiftType;
    deactivate(id: Id): ShiftType;
  };
  coverage: {
    list(unitId: Id): CoverageRequirement[];
    upsert(input: CoverageRequirementInput): CoverageRequirement;
    delete(id: Id): void;
  };
  holidays: {
    list(unitId: Id): Holiday[];
    create(input: HolidayInput): Holiday;
    /** Rename, move between major and minor, or pair a minor holiday with a major one. */
    update(id: Id, patch: HolidayPatch): Holiday;
    delete(id: Id): void;
    /** Who the holiday rotation counts as having worked a holiday, and where that comes from. */
    work(holidayId: Id): HolidayWorkSummary;
    /** Record who worked a holiday by hand; it then stands in for the schedules. */
    recordWork(holidayId: Id, nurseIds: Id[]): HolidayWorkSummary;
    /** Go back to what published schedules say. */
    clearWork(holidayId: Id): HolidayWorkSummary;
    /** Propose a year of holidays from the year before (or the federal list): nothing is saved. */
    planYear(unitId: Id, year: number): HolidayYearPlan;
    /** Save a proposal as the manager approved it, all or nothing. */
    addYear(unitId: Id, input: HolidayYearInput): Holiday[];
  };
  acuity: {
    tiers(unitId: Id): AcuityTier[];
    createTier(input: AcuityTierInput): AcuityTier;
    updateTier(id: Id, patch: AcuityTierPatch): AcuityTier;
    deleteTier(id: Id): void;
    ratioRules(unitId: Id): RatioRule[];
    createRatioRule(input: RatioRuleInput): RatioRule;
    updateRatioRule(id: Id, patch: RatioRulePatch): RatioRule;
    deactivateRatioRule(id: Id): RatioRule;
    hppd(unitId: Id): HppdTarget | undefined;
    setHppd(unitId: Id, targetHours: number): HppdTarget;
  };
  census: {
    list(unitId: Id, start: IsoDate, end: IsoDate): CensusForecast[];
    upsert(input: CensusForecastInput): CensusForecast;
    /** Accept a batch of proposals atomically. */
    upsertMany(inputs: CensusForecastInput[]): CensusForecast[];
    recordActual(id: Id, actualCensus: number, actualAcuityMix: Record<Id, number>): CensusForecast;
    delete(id: Id): void;
    /** Forecaster proposals for every active shift on every date in the range. */
    propose(unitId: Id, start: IsoDate, end: IsoDate, options?: ForecastOptions): CensusProposal[];
    backtest(unitId: Id, options?: ForecastOptions): BacktestResult;
    /** Derived staffing demand with the binding constraint per role. */
    demand(unitId: Id, start: IsoDate, end: IsoDate): ShiftDemand[];
    /** Scheduled nursing hours per patient day for a period, against the HPPD target. */
    hppd(periodId: Id): HppdReport;
  };
  roster: {
    /** Opens a native file picker, parses the file, returns what an import would do. */
    pickImportFile(unitId: Id): Promise<RosterImportPreview | undefined>;
    /** Applies previously previewed rows atomically. */
    importRows(unitId: Id, rows: RosterCsvRow[]): RosterImportSummary;
    /** Opens a native save dialog and writes the roster CSV. Returns the path written. */
    exportToFile(unitId: Id): Promise<string | undefined>;
    /** The CSV text itself, for the clipboard or tests. */
    exportCsv(unitId: Id): string;
  };
  periods: {
    list(unitId: Id): SchedulePeriod[];
    assignments(periodId: Id): Assignment[];
    create(input: {
      unitId: Id;
      name: string;
      startDate: IsoDate;
      endDate: IsoDate;
      /** Last day time-off requests are on time; later ones are flagged as late. */
      requestsCloseOn?: IsoDate;
    }): SchedulePeriod;
    /** Set or clear when time-off requests close for this period (advisory). */
    setRequestsCloseOn(periodId: Id, date: IsoDate | null): SchedulePeriod;
  };
  schedule: {
    /** Every hard/soft violation for the period's current assignments, under its rule set. */
    validate(periodId: Id): ScheduleValidation;
    /**
     * On a published period every one of these needs `reason` and writes the change log;
     * on a draft the reason is ignored. Refused on an archived period.
     */
    createAssignment(input: CreateAssignmentInput, reason?: string): Assignment;
    moveAssignment(input: MoveAssignmentInput, reason?: string): Assignment;
    /**
     * Two nurses trade shifts in one step. Returns the first nurse's new shift, then the second's.
     * Refused, and nothing changed, when either is locked.
     */
    swapAssignments(firstId: Id, secondId: Id, reason?: string): [Assignment, Assignment];
    updateAssignment(assignmentId: Id, patch: AssignmentPatch, reason?: string): Assignment;
    deleteAssignment(assignmentId: Id, reason?: string): void;
    /** A lock is the manager's pin, invisible to staff: no reason, no change-log entry. */
    setLocked(assignmentId: Id, locked: boolean): Assignment;
  };
  publish: {
    preview(periodId: Id): PublishPreview;
    /**
     * Freezes a version, flips the period to published, books the fairness ledger and writes
     * a backup — the first three in one transaction. A republish requires `reason`.
     */
    publish(periodId: Id, reason?: string): Promise<PublishOutcome>;
    versions(periodId: Id): ScheduleVersion[];
    /** The post-publish change log, newest first. */
    changes(periodId: Id): ScheduleChange[];
    alerts(periodId: Id): ComplianceAlert[];
  };
  output: {
    /** Opens a native save dialog and writes the period in `format`. Returns the path written. */
    exportToFile(periodId: Id, format: OutputFormat): Promise<string | undefined>;
    /** The CSV text itself, for the clipboard or tests. */
    renderCsv(periodId: Id, format: 'csv-grid' | 'csv-long'): string;
  };
  backups: {
    list(): BackupInfo[];
    create(): Promise<BackupInfo>;
    /**
     * Replaces the live database with the named backup (after saving the live one as a
     * `pre-restore` backup) and relaunches the app. The call returns before the relaunch.
     */
    restore(fileName: string): Promise<BackupInfo>;
    /** Backups in the trash, restorable until their `purgeAt`. */
    listDeleted(): DeletedBackupInfo[];
    /**
     * Moves a backup to the trash for 30 days; `permanent` deletes the file now instead.
     */
    remove(fileName: string, options?: { permanent?: boolean }): void;
    /** Puts a trashed backup back on the list. */
    undelete(fileName: string): BackupInfo;
    /** Deletes a trashed backup now rather than when its retention runs out. */
    purge(fileName: string): void;
  };
  solver: {
    /**
     * Starts a batch of variations for a draft period in worker threads and returns at once.
     * Replaces the period's previous batch; nothing reaches the draft until `save`.
     */
    start(periodId: Id, options?: SolveBatchOptions): SolveBatchStatus;
    status(batchId: Id): SolveBatchStatus | undefined;
    /** Asks every running variation to stop at its next check and drops the queued ones. */
    cancel(batchId: Id): SolveBatchStatus | undefined;
    /** The period's batch, re-checked against today's inputs; undefined when there is none. */
    current(periodId: Id): SolveBatchStatus | undefined;
    discard(batchId: Id): void;
    /** How long a batch would take with these options on this machine. */
    estimate(periodId: Id, options?: SolveBatchOptions): SolveEstimate;
    /** One finished variation, judged by the same validation and costing as the grid. */
    candidate(batchId: Id, index: number): CandidatePreview;
    /** The current draft and every finished variation, scored side by side. */
    compare(batchId: Id): CandidateComparison;
    /** Writes one variation to the draft (unlocked rows replaced, locked kept, audited). */
    save(batchId: Id, index: number): { created: number; preservedLocked: number };
    /** Which backends can run on this install (CP-SAT and hybrid need the OR-Tools runner). */
    available(): SolverAvailability[];
  };
  solverSettings: {
    /** The unit's saved solver; the default (hybrid) when it never saved one. */
    get(unitId: Id): SolverSettings;
    save(unitId: Id, settings: SolverSettings): SolverSettings;
  };
  rules: {
    getLatest(unitId: Id): RuleSet;
    /** Always inserts a new, immutable version; never rewrites one a published period cites. */
    save(
      unitId: Id,
      name: string,
      configs: RuleSet['configs'],
      weekendDefinition: RuleSet['weekendDefinition'],
      fairnessWeights: RuleSet['fairnessWeights'],
    ): RuleSet;
  };
  fairness: {
    /** Per-nurse 0–100 scores with breakdown, plus unit distribution, for a period's draft. */
    report(periodId: Id): FairnessReport;
    /** Ledger rows for the unit's recent periods, oldest first. */
    history(unitId: Id): FairnessLedgerEntry[];
    /** Score snapshots per ledger period, oldest first. */
    trend(unitId: Id): FairnessTrendPoint[];
    /** Opens a native file picker for a historical schedule CSV and previews the import. */
    pickHistoryImportFile(unitId: Id): Promise<HistoryImportPreview | undefined>;
    /** Derives ledger rows from previously previewed shifts and writes them atomically. */
    importHistory(unitId: Id, rows: HistoricalShiftRow[]): HistoryImportSummary;
  };
  cost: {
    payRates(unitId: Id): PayRate[];
    createPayRate(input: PayRateInput): PayRate;
    updatePayRate(id: Id, patch: PayRatePatch): PayRate;
    deletePayRate(id: Id): void;
    /** Every differential, active or not, so the editor can show paused ones. */
    differentials(unitId: Id): Differential[];
    createDifferential(input: DifferentialInput): Differential;
    updateDifferential(id: Id, patch: DifferentialPatch): Differential;
    deleteDifferential(id: Id): void;
    overtimeRules(unitId: Id): OvertimeRule[];
    createOvertimeRule(input: OvertimeRuleInput): OvertimeRule;
    updateOvertimeRule(id: Id, patch: OvertimeRulePatch): OvertimeRule;
    deleteOvertimeRule(id: Id): void;
    /** Prices every assignment in the period and compares the total to its budget. */
    report(periodId: Id): PeriodCostReport;
    setBudget(periodId: Id, targetDollars: number): Budget;
    paySettings(unitId: Id): PaySettings;
    savePaySettings(unitId: Id, settings: PaySettings): PaySettings;
  };
  /** Events paid outside the schedule, recorded from the Today screen. */
  dayOfPay: {
    /** Events dated in the inclusive range, oldest first. */
    list(unitId: Id, start: IsoDate, end: IsoDate): DayOfPayRecord[];
    record(entry: DayOfPayEntry): DayOfPayRecord;
    update(id: Id, patch: DayOfPayPatch): DayOfPayRecord;
    remove(id: Id): void;
  };
  timeOff: {
    list(unitId: Id, status?: TimeOffStatus): TimeOffRequest[];
    /** Every request touching the inclusive range, whatever its status — the heatmap's feed. */
    listInRange(unitId: Id, start: IsoDate, end: IsoDate): TimeOffRequest[];
    create(input: CreateTimeOffInput): TimeOffRequest;
    /**
     * Approves and, in the same transaction, lifts the nurse's assignments inside the range
     * from every draft period. Shifts on a published period are left alone and returned as
     * `stillRostered`; they surface as a `scheduled_on_leave` conflict.
     */
    approve(id: Id, reason?: string): TimeOffApproval;
    /** A denial without a reason is refused by the database, not just the form. */
    deny(id: Id, reason: string): TimeOffRequest;
    cancel(id: Id, reason?: string): TimeOffRequest;
    withdrawApproval(id: Id, reason: string): TimeOffRequest;
    /** What approving or denying this request would do to the given period, before deciding. */
    impact(periodId: Id, requestId: Id, decision: 'approved' | 'denied'): TimeOffImpact;
    /** For each shift approving would free in this period: the nurses who could take it. */
    coverOptions(periodId: Id, requestId: Id): LeaveCoverOption[];
    /**
     * Approve and, in one transaction, take the nurse's shifts in this period off the schedule
     * (published ones too, under `reason`) and give each chosen one to its cover.
     */
    approveAndCover(
      periodId: Id,
      requestId: Id,
      reason: string | undefined,
      covers: LeaveCover[],
    ): void;
  };
  conflicts: {
    /** Read-only: works on a published period too. */
    analyse(periodId: Id): ConflictReport;
    policy(unitId: Id): AutoResolvePolicy;
    savePolicy(unitId: Id, policy: AutoResolvePolicy): AutoResolvePolicy;
    /** Applies one resolution's actions atomically; the reason is required and audited. */
    resolve(periodId: Id, resolution: Resolution, reason: string): Resolution;
    /** Applies every resolution the unit's policy admits, each audited as `auto_resolve`. */
    autoResolve(periodId: Id): AutoResolveResult;
  };
  exchange: {
    list(unitId: Id, status?: ShiftSwapStatus): ShiftSwap[];
    listForPeriod(periodId: Id, status?: ShiftSwapStatus): ShiftSwap[];
    /** Judges the proposal against the period's own rule-set snapshot, live — never trust a
     * renderer-computed verdict; this is what `approve` re-runs before writing anything. */
    evaluate(periodId: Id, proposal: ExchangeProposal): ExchangeEvaluation;
    propose(periodId: Id, proposal: ExchangeProposal, reason?: string): ShiftSwap;
    /**
     * Re-evaluates from the stored swap: `blocked` throws (the blockers, joined); `warn`
     * requires `reason` and records the approval as an override; `ok` approves plainly.
     */
    approve(id: Id, reason?: string): ShiftSwap;
    /** A denial without a reason is refused by the database, not just the form. */
    deny(id: Id, reason: string): ShiftSwap;
    cancel(id: Id, reason?: string): ShiftSwap;
  };
  dayOf: {
    /** The console's one read: shifts around now, their staffing, and the open call-offs. */
    today(unitId: Id, date?: IsoDate): DayOfSummary;
    /** Call-offs whose shift falls in the inclusive range, any status, soonest first. */
    callOffs(unitId: Id, start: IsoDate, end: IsoDate): CallOffView[];
    /** Records the call-off; the assignment stays on the grid until a backfill replaces it. */
    /** `paidSickHours`: hours paid from sick leave, credited toward contract once backfilled. */
    reportCallOff(assignmentId: Id, reason?: string, paidSickHours?: number): CallOff;
    /** Ranked, eligible-only replacements, simulated on the period's own rule-set snapshot. */
    replacements(callOffId: Id): ReplacementReport;
    /** Log a call that did not end the search. `accepted` goes through `backfill` instead. */
    logCall(
      callOffId: Id,
      nurseId: Id,
      outcome: Exclude<CallOutcome, 'accepted'>,
      notes?: string,
    ): CallAttempt;
    /**
     * The nurse said yes: logs the `accepted` attempt, replaces the absent assignment with a
     * `source: 'callout'` row for `nurseId` (re-checked against the rule engine in main, never
     * trusting the renderer's list), marks the call-off covered — one transaction. On a
     * published period each shift touched is written to the change log as `source: 'backfill'`.
     */
    backfill(callOffId: Id, nurseId: Id, notes?: string): BackfillResult;
    /** Nobody found before the shift started; the shift ran short. Reason required. */
    markUncovered(callOffId: Id, reason: string): CallOff;
    /** The nurse turned up after all, or it was logged in error. Reason required. */
    cancelCallOff(callOffId: Id, reason: string): CallOff;
    callLog(callOffId: Id): CallAttempt[];
    /** The unit's low-census order, first tier first; the contract's usual order until changed. */
    cancellationPolicy(unitId: Id): CancellationTier[];
    saveCancellationPolicy(unitId: Id, tiers: CancellationTier[]): CancellationTier[];
    /**
     * Who goes home first on a shift over its requirement for `role`. `volunteers` are the nurses
     * who offered to go, in the order they offered; the rotation's history is read in main.
     */
    cancellationOrder(
      periodId: Id,
      date: IsoDate,
      shiftTypeId: Id,
      role: NurseRole,
      volunteers: Id[],
    ): CancellationOrderView;
    /**
     * Sends `nurseId` home: re-ranks in main and refuses anyone but the next in the order (or any
     * nurse once the shift is no longer over), records the cancellation, removes the shift
     * through the change log under the order's reason, and audits — one transaction.
     */
    cancelForCensus(
      periodId: Id,
      date: IsoDate,
      shiftTypeId: Id,
      role: NurseRole,
      volunteers: Id[],
      nurseId: Id,
    ): ShiftCancellationRecord;
  };
}

type Promisify<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

/** What `window.shiftnurse` looks like from the renderer. */
export type RendererApi = { [R in keyof ShiftNurseApi]: Promisify<ShiftNurseApi[R]> };

/**
 * The flat list of channels, derived once so that main, preload and renderer cannot drift:
 * main registers a handler per entry, preload exposes a caller per entry, and the type
 * system refuses an entry that is not a method on {@link ShiftNurseApi}.
 */
export const API_CHANNELS = {
  app: ['info', 'update', 'openLogs'],
  units: ['list', 'update'],
  setup: [
    'status',
    'demos',
    'loadDemo',
    'loadScenarios',
    'createUnit',
    'advance',
    'complete',
    'resume',
    'applyPreset',
    'applyJurisdiction',
    'startOver',
  ],
  dashboard: ['summary'],
  nurses: ['list', 'get', 'create', 'update', 'deactivate'],
  nurseRecord: ['exportToFile'],
  nurseUnits: ['forNurse', 'floatingIn', 'roster', 'create', 'update', 'remove'],
  credentials: ['list', 'create', 'forNurse', 'grant', 'updateExpiry', 'revoke'],
  preferences: ['forNurse', 'replace'],
  incompatibility: ['list', 'create', 'update', 'remove'],
  overtimeVolunteers: ['list', 'create', 'update', 'remove'],
  preceptorships: ['list', 'create', 'update', 'remove'],
  leaveBalances: [
    'forNurse',
    'setBalance',
    'addCertification',
    'updateCertification',
    'removeCertification',
    'checkRequest',
  ],
  leaveBidding: [
    'rounds',
    'createRound',
    'updateRound',
    'closeRound',
    'bids',
    'submitBid',
    'award',
  ],
  shiftTypes: ['list', 'create', 'update', 'deactivate'],
  coverage: ['list', 'upsert', 'delete'],
  holidays: [
    'list',
    'create',
    'update',
    'delete',
    'work',
    'recordWork',
    'clearWork',
    'planYear',
    'addYear',
  ],
  acuity: [
    'tiers',
    'createTier',
    'updateTier',
    'deleteTier',
    'ratioRules',
    'createRatioRule',
    'updateRatioRule',
    'deactivateRatioRule',
    'hppd',
    'setHppd',
  ],
  census: [
    'list',
    'upsert',
    'upsertMany',
    'recordActual',
    'delete',
    'propose',
    'backtest',
    'demand',
    'hppd',
  ],
  roster: ['pickImportFile', 'importRows', 'exportToFile', 'exportCsv'],
  periods: ['list', 'assignments', 'create', 'setRequestsCloseOn'],
  schedule: [
    'validate',
    'createAssignment',
    'moveAssignment',
    'swapAssignments',
    'updateAssignment',
    'deleteAssignment',
    'setLocked',
  ],
  publish: ['preview', 'publish', 'versions', 'changes', 'alerts'],
  output: ['exportToFile', 'renderCsv'],
  backups: ['list', 'create', 'restore', 'listDeleted', 'remove', 'undelete', 'purge'],
  solver: [
    'start',
    'status',
    'cancel',
    'current',
    'discard',
    'estimate',
    'candidate',
    'compare',
    'save',
    'available',
  ],
  solverSettings: ['get', 'save'],
  rules: ['getLatest', 'save'],
  fairness: ['report', 'history', 'trend', 'pickHistoryImportFile', 'importHistory'],
  cost: [
    'payRates',
    'createPayRate',
    'updatePayRate',
    'deletePayRate',
    'differentials',
    'createDifferential',
    'updateDifferential',
    'deleteDifferential',
    'overtimeRules',
    'createOvertimeRule',
    'updateOvertimeRule',
    'deleteOvertimeRule',
    'report',
    'setBudget',
    'paySettings',
    'savePaySettings',
  ],
  dayOfPay: ['list', 'record', 'update', 'remove'],
  timeOff: [
    'list',
    'listInRange',
    'create',
    'coverOptions',
    'approveAndCover',
    'approve',
    'deny',
    'cancel',
    'withdrawApproval',
    'impact',
  ],
  conflicts: ['analyse', 'policy', 'savePolicy', 'resolve', 'autoResolve'],
  exchange: ['list', 'listForPeriod', 'evaluate', 'propose', 'approve', 'deny', 'cancel'],
  dayOf: [
    'today',
    'callOffs',
    'reportCallOff',
    'replacements',
    'logCall',
    'backfill',
    'markUncovered',
    'cancelCallOff',
    'callLog',
    'cancellationPolicy',
    'saveCancellationPolicy',
    'cancellationOrder',
    'cancelForCensus',
  ],
} as const satisfies { [R in keyof ShiftNurseApi]: readonly (keyof ShiftNurseApi[R])[] };

export type ApiResource = keyof ShiftNurseApi;

export function channelName(resource: string, method: string): string {
  return `shiftnurse:${resource}.${method}`;
}
