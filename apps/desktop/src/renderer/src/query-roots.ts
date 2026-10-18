/**
 * The named first segments of every cache key the renderer builds.
 *
 * A key used to be spelled where it was used — `['cost', 'report']` in one hook,
 * `costKeys.report('').slice(0, 2)` in another — so nothing said which keys a write could
 * reach, and a read model whose key sat under no invalidated prefix (the cover options for a
 * request) never refreshed at all. Every key factory spreads one of these, and every
 * invalidation names one, so a root that no write mentions is visible in `period-cache.ts`.
 *
 * Imports nothing at runtime, so any hook module (and `period-cache.ts`) can import it without
 * an import cycle.
 */

export const queryRoots = {
  units: ['units'],
  dashboard: ['dashboard'],
  nurses: ['nurses'],
  nurse: ['nurse'],
  nurseDeactivation: ['nurse-deactivation'],
  shiftTypes: ['shiftTypes'],
  periods: ['periods'],
  assignments: ['assignments'],
  appInfo: ['appInfo'],
  update: ['update'],
  credentials: ['credentials'],
  nurseCredentials: ['nurseCredentials'],
  preferences: ['preferences'],
  incompatibility: ['incompatibility'],
  overtimeVolunteers: ['overtimeVolunteers'],
  preceptorships: ['preceptorships'],
  restWaivers: ['restWaivers'],
  availabilityBlocks: ['availabilityBlocks'],
  nurseUnits: ['nurseUnits'],
  timeOff: ['timeOff'],
  timeOffImpact: ['timeOff', 'impact'],
  holidayWorkPriority: ['timeOff', 'holidayWorkPriority'],
  conflicts: ['conflicts'],
  conflictPolicy: ['conflictPolicy'],
  coverOptions: ['coverOptions'],
  leaveBalances: ['leaveBalances'],
  leaveBidRounds: ['leaveBidRounds'],
  leaveBids: ['leaveBids'],
  coverage: ['coverage'],
  holidays: ['holidays'],
  holidayWork: ['holiday-work'],
  holidayYearPlan: ['holiday-year-plan'],
  acuityTiers: ['acuityTiers'],
  ratioRules: ['ratioRules'],
  // Not under `['hppd']`: a census save refreshes the scheduled HPPD but not the unit's target.
  hppdTarget: ['hppdTarget'],
  rules: ['rules'],
  census: ['census'],
  demand: ['demand'],
  backtest: ['backtest'],
  scheduledHppd: ['hppd'],
  validation: ['validation'],
  nurseHours: ['nurse-hours'],
  cost: ['cost'],
  costReport: ['cost', 'report'],
  fairness: ['fairness'],
  fairnessReport: ['fairness', 'report'],
  publish: ['publish'],
  publishPreview: ['publish', 'preview'],
  publishChanges: ['publish', 'changes'],
  publishAlerts: ['publish', 'alerts'],
  backups: ['backups'],
  solver: ['solver'],
  solverCurrent: ['solver', 'current'],
  solverDraft: ['solver', 'draft'],
  dayOf: ['dayOf'],
  dayOfPay: ['dayOfPay'],
  exchange: ['exchange'],
  floatOut: ['floatOut'],
  setup: ['setup'],
} as const;

export type QueryRoot = (typeof queryRoots)[keyof typeof queryRoots];
