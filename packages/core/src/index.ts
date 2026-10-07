// The public API: exactly what packages/db, the desktop app and the web client consume.
// Everything else stays exported from its own module for core's internal use.

export type { BindingConstraint, RatioStaffing, RoleDemand, ShiftDemand } from './acuity/demand.js';
// Census and ratios to the staffing each shift needs
export { deriveDemand, NURSE_ROLES, nursesRequiredForMix } from './acuity/demand.js';
export type {
  BacktestResult,
  CensusProposal,
  ErrorSummary,
  ForecastOptions,
} from './acuity/forecast.js';
// Census forecasting and its back-test
export { backtest, proposeCensus, validateAcuityMix } from './acuity/forecast.js';
export type { HppdReport } from './acuity/hppd.js';
// Scheduled hours per patient day against the target
export { scheduledHppd } from './acuity/hppd.js';
export type {
  AutoResolvePolicy,
  CapacityVerdict,
  Conflict,
  ConflictInput,
  ConflictReport,
  DayCapacity,
  Resolution,
  ResolutionImpact,
  TimeOffImpact,
} from './conflicts/index.js';
// Time-off, coverage and overlap conflicts with ranked resolutions
export {
  analyseConflicts,
  DEFAULT_AUTO_RESOLVE_POLICY,
  independentFixes,
  selectAutoResolutions,
  timeOffImpact,
} from './conflicts/index.js';
// Pricing a schedule, marginal cost and budget comparison
export { compareToBudget, costSchedule } from './cost/cost.js';
export type { DayOfPay, DayOfPayEvent, DayOfPayLine, DayOfPayPolicy } from './cost/events.js';
// Pay for what happened on the day: missed breaks, reporting-time pay, call-backs
export { priceDayOfEvents } from './cost/events.js';
// The pay rate in force for a nurse on a date
export { resolvePayRate } from './cost/rates.js';
export type { BudgetVariance, CostContext, ScheduleCost } from './cost/types.js';
// Pay model contract types
export { COST_LINE_LABELS, DIFFERENTIAL_ORDER } from './cost/types.js';
export type {
  CancellationHistory,
  CancellationInput,
  CancellationOrder,
  CancellationPlace,
  CancellationTier,
} from './dayof/cancellation.js';
// Low-census cancellation order: who goes home first, each with the reason
export { cancellationOrder, DEFAULT_CANCELLATION_TIERS } from './dayof/cancellation.js';
export type { FloatOrder, FloatOrderInput, FloatPlace } from './dayof/float-order.js';
// Float rotation: volunteers first, then the rotation, most junior among equals
export { floatOrder } from './dayof/float-order.js';
export type {
  PayTier,
  ReplacementCandidate,
  ReplacementReport,
  RoleStaffing,
  ShiftStaffingCheck,
} from './dayof/index.js';
// Call-off replacement finder and live staffing check
export { checkStaffing, findReplacements, shiftsAround } from './dayof/index.js';
export type {
  AccrualRule,
  AccrualTier,
  AcuityTier,
  Assignment,
  AssignmentSource,
  AuditAction,
  AuditLogEntry,
  AvailabilityBlock,
  Budget,
  CallAttempt,
  CallOff,
  CallOffStatus,
  CallOutcome,
  CensusForecast,
  CoverageRequirement,
  Credential,
  Differential,
  DifferentialKind,
  EmploymentType,
  FairnessLedgerEntry,
  FloatRecord,
  FmlaPolicy,
  FmlaRegime,
  FmlaYearMethod,
  Holiday,
  HppdTarget,
  Id,
  IncompatibilityGroup,
  LeaveBalanceType,
  LeavePolicy,
  LeaveYearStart,
  Nurse,
  NurseCredential,
  NurseRole,
  OvertimeOrder,
  OvertimeRule,
  OvertimeVolunteer,
  PayRate,
  PerDiemCommitment,
  PeriodStatus,
  Preceptorship,
  Preference,
  PreferenceKind,
  RatioRole,
  RatioRule,
  RequestOrigin,
  RestWaiver,
  ScheduleChange,
  ScheduleChangeKind,
  ScheduleChangeSource,
  SchedulePeriod,
  ScheduleVersion,
  ShiftCredentialRequirement,
  ShiftType,
  TimeOffRequest,
  TimeOffStatus,
  TimeOffType,
  Tour,
  Unit,
} from './domain/entities.js';
// Plain-data entities and their enums
export {
  DEFAULT_LEAVE_POLICY,
  EMPLOYMENT_TYPE_LABELS,
  EMPLOYMENT_TYPES,
  LEAVE_BALANCE_TYPES,
  TIME_OFF_TYPE_LABELS,
  TIME_OFF_TYPES,
  TOURS,
} from './domain/entities.js';
export type { IsoDate, Weekday, WeekendDefinition } from './domain/time.js';
// The wall-clock time model: every date and minute calculation goes through here
export {
  addDays,
  compareDates,
  DEFAULT_WEEKEND,
  dateInRange,
  datesInRange,
  dayNumber,
  daysBetween,
  formatTimeOfDay,
  hoursToMinutes,
  isIsoDate,
  isoDate,
  isWeekendDate,
  MINUTES_PER_DAY,
  MS_PER_DAY,
  minutesToHours,
  parseTimeOfDay,
  rangesOverlap,
  restMinutesBetween,
  shiftWindow,
  today,
  WEEKDAY_NAMES,
  weekdayOf,
  weekendKey,
  windowEndDate,
  windowsOverlap,
} from './domain/time.js';
export type {
  ExchangeApplication,
  ExchangeEvaluation,
  ExchangeProposal,
  ShiftSwap,
  ShiftSwapKind,
  ShiftSwapStatus,
} from './exchange/index.js';
// Shift trade and giveaway verdicts
export { evaluateExchange, planExchange } from './exchange/index.js';
// Unit-wide spread of burdens
export { gini } from './fairness/distribution.js';
// Importing prior burden history from CSV
export { groupIntoPayPeriods, parseHistoricalScheduleCsv } from './fairness/history-csv.js';
// Per-nurse burden counts and broken preferences
export { deriveCounters, deriveOccurrences, preferencesBroken } from './fairness/ledger.js';
// The fairness score and per-nurse breakdown
export { scoreFairness } from './fairness/score.js';
export type {
  BurdenCounters,
  ComponentScore,
  CounterContext,
  FairnessComponent,
  FairnessReport,
  FairnessWeights,
  HistoricalCsvError,
  HistoricalShiftRow,
  NurseFairnessScore,
} from './fairness/types.js';
// Fairness contract types
export {
  DEFAULT_FAIRNESS_WEIGHTS,
  FAIRNESS_COMPONENT_LABELS,
  FAIRNESS_COMPONENTS,
} from './fairness/types.js';
export type { BalanceProjection } from './leave/accrual.js';
export {
  accrualRuleFor,
  leaveYearStarts,
  projectBalance,
  yearsOfService,
} from './leave/accrual.js';
export type { BalanceCheck } from './leave/balances.js';
// Leave balances and FMLA: accrual, balance checks, the rolling-year entitlement
export { checkLeaveBalance } from './leave/balances.js';
export type {
  BidResult,
  LeaveAward,
  LeaveBid,
  LeaveBidChoice,
  LeaveBidRound,
  LeaveDenial,
} from './leave/bidding.js';
// Seniority leave bidding: awards in seniority order, every denial reasoned
export { awardBids, seniorityOrder } from './leave/bidding.js';
export type { FmlaEntitlementBasis, FmlaPeriod } from './leave/fmla.js';
export {
  fmlaEligibility,
  fmlaEntitlementHours,
  fmlaPeriod,
  fmlaStanding,
} from './leave/fmla.js';
export type {
  HolidayClaim,
  HolidayClaimant,
  HolidayPriorityInput,
} from './leave/holiday-priority.js';
// Contested holiday requests ranked by the contract's order
export { holidayRequestPriority } from './leave/holiday-priority.js';
export { validateLeavePolicy } from './leave/policy.js';
export type { RequestClaimant, RequestPriorityInput } from './leave/request-priority.js';
// Competing time-off requests ranked by equity (advice, never applied)
export { competingRequestPriority } from './leave/request-priority.js';
export type {
  ComplianceAlert,
  ComplianceAlertKind,
  GridSheet,
  NurseSheet,
  ScheduleDiff,
} from './publish/index.js';
// Publish diff, compliance alerts and printable projections
export {
  buildGridSheet,
  buildNurseSheets,
  complianceAlerts,
  diffAssignments,
  formatAssignmentsCsv,
  formatGridCsv,
} from './publish/index.js';
export type { RosterCsvError, RosterCsvRow } from './roster/csv.js';
// The one roster CSV parser and formatter
export { formatRosterCsv, parseRosterCsv, ROSTER_COLUMNS, serializeCsv } from './roster/csv.js';
export {
  accommodationBlocksRule,
  type BlockOccurrence,
  blockedAt,
  blockOccurrencesOverlapping,
} from './rules/availability-blocks.js';
export { credentialLapsedOn } from './rules/coverage-rules.js';
// Two days off together for a nurse who works every weekend of a pay period
export { daysOffTogetherRule, payPeriodWeekends } from './rules/days-off-together.js';
export type { HolidayRotationParams } from './rules/holiday-rotation.js';
// Holiday rotation facts
export { holidayRotationRule, previousOccurrence } from './rules/holiday-rotation.js';
export type { MaxHoursIn24Params } from './rules/hours-in-24.js';
// Hours in any 24: the fatigue cap, holdovers included
export { maxHoursIn24Rule } from './rules/hours-in-24.js';
export type { ContractedHoursParams, MaxHoursParams } from './rules/hours-rules.js';
// Overtime and hours rule parameters
export {
  contractedHoursRule,
  maxHoursRule,
  payPeriodIndex,
  payPeriodWindow,
} from './rules/hours-rules.js';
// Kept-apart group rule helpers
export { groupInForce, groupsForPeriod } from './rules/incompatibility-rules.js';
export type { LongStretchParams } from './rules/long-stretch.js';
// Long stretches: a cap on hours in a row and rest owed after one
export { longStretchRule } from './rules/long-stretch.js';
// No mandatory overtime: the note prefix that records an emergency, and the rule itself
export {
  EMERGENCY_NOTE_PREFIX,
  mandatoryOvertimeRule,
  volunteeredOn,
} from './rules/mandatory-overtime.js';
export type { PaidLeaveCredit, PaidSickCall } from './rules/paid-leave.js';
// Paid leave credits as dated whole shifts
export {
  paidLeaveCredits,
  suggestedPaidLeaveHours,
  typicalShiftHours,
} from './rules/paid-leave.js';
// Orientees work with their preceptor
export { preceptorRule, preceptorsOn } from './rules/preceptor.js';
// The rule registry the solver, grid and compliance report share
export {
  ALL_RULES,
  buildRuleContext,
  defaultRuleSet,
  evaluateSchedule,
  resolveConfigs,
  violationsByAssignment,
  violationsByDate,
  violationsByNurse,
} from './rules/registry.js';
export { restWaivedOn } from './rules/rest-rules.js';
// Tour rotation limits and the tour a shift belongs to
export { tourOf, tourRotationRule } from './rules/tour-rotation.js';
// Rule engine contract types
export type {
  EvaluationResult,
  HolidayWorkRecord,
  ParamDoc,
  Rule,
  RuleConfig,
  RuleSet,
  RuleSeverity,
  Violation,
} from './rules/types.js';
// Which dated shift covers which
export { containingDate, coveringShift, withinShiftProblem } from './schedule/cover.js';
export type { BusyElsewhere } from './schedule/elsewhere.js';
// Another unit's shifts as busy time on this one (float and multi-unit staff)
export { busyElsewhere } from './schedule/elsewhere.js';
// The schedule read model
export { ScheduleView } from './schedule/view.js';
export type {
  AcuityPresetId,
  HolidayYearPlan,
  JurisdictionChoices,
  JurisdictionId,
  JurisdictionOption,
  JurisdictionPlan,
  JurisdictionPlanInput,
  JurisdictionPreset,
  PairTarget,
  PlannedHoliday,
  PresetCondition,
  PresetDifferential,
  PresetOvertimeRule,
  ProtectedRuleChange,
  SetupMode,
  SetupPhase,
  SetupPreset,
  SetupPresetResult,
  SetupState,
  SetupStepId,
  ShiftPatternId,
  UnitSetupMode,
} from './setup/index.js';
// First-run setup presets and holiday helpers
export {
  ACUITY_PRESETS,
  acuityPresetForUnitType,
  coverageQuickFill,
  isSetupStep,
  JURISDICTION_IDS,
  JURISDICTION_PRESETS,
  nextSetupStep,
  planHolidayYear,
  planJurisdiction,
  previousSetupStep,
  protectedRuleChanges,
  SETUP_STEPS,
  SHIFT_PATTERNS,
  setupPhase,
  usFederalHolidays,
} from './setup/index.js';
// CP-SAT preparation and finishing (pure halves)
export {
  DEFAULT_DETERMINISTIC_TIME,
  decisionsFor,
  finishCpsat,
  prepareCpsat,
  SEARCH_WORKERS,
} from './solver/cpsat/index.js';
// The manager-facing digest of a solve
export type { CountRange, ScheduleDigest } from './solver/digest.js';
// Chunked annealing plus CP-SAT windows
export { LocalSearch } from './solver/hybrid.js';
export type { ResolvedSolver, SolverSettings } from './solver/registry.js';
// Which solver backends exist and their fallback order
export {
  DEFAULT_SOLVER_SETTINGS,
  FALLBACK_ORDER,
  isSolverId,
  PURE_SOLVERS,
  requiresOrTools,
  resolveSolverId,
  SOLVER_IDS,
} from './solver/registry.js';
export type { ScheduleScore } from './solver/report.js';
// Scoring an arbitrary set of assignments
export { scoreAssignments } from './solver/report.js';
// The seeded RNG shared with the seeder
export { Rng } from './solver/rng.js';
// Solver entry point
export { solve } from './solver/solver.js';
// Solver contract types
export type {
  SolveInput,
  SolveOptions,
  SolveProgress,
  SolveReport,
  SolverId,
} from './solver/types.js';
