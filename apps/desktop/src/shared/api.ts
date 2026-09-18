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
  AssignmentSource,
  BacktestResult,
  CensusForecast,
  CensusProposal,
  CoverageRequirement,
  Credential,
  EvaluationResult,
  ForecastOptions,
  Holiday,
  HppdTarget,
  Id,
  IsoDate,
  Nurse,
  NurseCredential,
  Preference,
  RatioRule,
  RosterCsvError,
  RosterCsvRow,
  RuleSet,
  SchedulePeriod,
  ShiftDemand,
  ShiftType,
  TimeOffRequest,
  TimeOffStatus,
  Unit,
} from '@shiftnurse/core';

export interface AppInfo {
  version: string;
  /** `process.platform` as a plain string, so this file needs no Node types in the renderer. */
  platform: string;
  /** Absolute path of the SQLite file, shown in the About panel so support can find it. */
  databasePath: string;
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
  latestPublished: SchedulePeriod | undefined;
  pendingTimeOff: number;
  openCallOffs: number;
  /** Credentials lapsing in the next 90 days, soonest first. */
  expiringCredentials: ExpiringCredentialView[];
  /** Who is on each shift today, from the published schedule. */
  todayOnShift: OnShiftView[];
}

export type NurseInput = Omit<Nurse, 'id'>;

/** Optional-and-clearable fields take `null` to clear; an omitted key is left untouched. */
export type NursePatch = Partial<Omit<Nurse, 'id' | 'unitId' | 'phone' | 'email' | 'notes'>> & {
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
};

export type ShiftTypeInput = Omit<ShiftType, 'id'>;
export type ShiftTypePatch = Partial<Omit<ShiftType, 'id' | 'unitId'>>;

/** A preference as the editor submits it: identity is assigned on save. */
export type PreferenceInput = Preference extends infer P
  ? P extends Preference
    ? Omit<P, 'id' | 'nurseId'>
    : never
  : never;

export type CoverageRequirementInput = Omit<CoverageRequirement, 'id'> & { id?: Id };

export type AcuityTierInput = Omit<AcuityTier, 'id'>;
export type AcuityTierPatch = Partial<Omit<AcuityTier, 'id' | 'unitId'>>;
export type RatioRuleInput = Omit<RatioRule, 'id'>;
export type RatioRulePatch = Partial<Omit<RatioRule, 'id' | 'unitId' | 'citation'>> & {
  citation?: string | null;
};

export interface CensusForecastInput {
  unitId: Id;
  date: IsoDate;
  shiftTypeId: Id;
  projectedCensus: number;
  acuityMix: Record<Id, number>;
  source: CensusForecast['source'];
}

export interface CreateAssignmentInput {
  periodId: Id;
  nurseId: Id;
  shiftTypeId: Id;
  date: IsoDate;
  source?: AssignmentSource;
  isLocked?: boolean;
  isCharge?: boolean;
  isOvertime?: boolean;
  notes?: string;
}

export type AssignmentPatch = Partial<
  Pick<CreateAssignmentInput, 'shiftTypeId' | 'date' | 'isCharge' | 'isOvertime' | 'notes'>
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

/**
 * Every operation the renderer can perform, grouped by resource. Implementations in the
 * main process are synchronous (better-sqlite3 is synchronous); the renderer sees the
 * `Promise`-returning shape in {@link RendererApi} because IPC is asynchronous.
 */
export interface ShiftNurseApi {
  app: {
    info(): AppInfo;
  };
  units: {
    list(): Unit[];
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
    create(input: Omit<Holiday, 'id'>): Holiday;
    delete(id: Id): void;
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
  };
  roster: {
    /** Opens a native file picker, parses the file, returns what an import would do. */
    pickImportFile(unitId: Id): RosterImportPreview | undefined;
    /** Applies previously previewed rows atomically. */
    importRows(unitId: Id, rows: RosterCsvRow[]): RosterImportSummary;
    /** Opens a native save dialog and writes the roster CSV. Returns the path written. */
    exportToFile(unitId: Id): string | undefined;
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
    }): SchedulePeriod;
  };
  schedule: {
    /** Every hard/soft violation for the period's current assignments, under its rule set. */
    validate(periodId: Id): ScheduleValidation;
    createAssignment(input: CreateAssignmentInput): Assignment;
    moveAssignment(input: MoveAssignmentInput): Assignment;
    updateAssignment(assignmentId: Id, patch: AssignmentPatch): Assignment;
    deleteAssignment(assignmentId: Id): void;
    setLocked(assignmentId: Id, locked: boolean): Assignment;
  };
  rules: {
    getLatest(unitId: Id): RuleSet;
    /** Always inserts a new, immutable version; never rewrites one a published period cites. */
    save(
      unitId: Id,
      name: string,
      configs: RuleSet['configs'],
      weekendDefinition: RuleSet['weekendDefinition'],
    ): RuleSet;
  };
  timeOff: {
    list(unitId: Id, status?: TimeOffStatus): TimeOffRequest[];
  };
}

type Promisify<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<R> : never;
};

/** What `window.shiftnurse` looks like from the renderer. */
export type RendererApi = { [R in keyof ShiftNurseApi]: Promisify<ShiftNurseApi[R]> };

/**
 * The flat list of channels, derived once so that main, preload and renderer cannot drift:
 * main registers a handler per entry, preload exposes a caller per entry, and the type
 * system refuses an entry that is not a method on {@link ShiftNurseApi}.
 */
export const API_CHANNELS = {
  app: ['info'],
  units: ['list'],
  dashboard: ['summary'],
  nurses: ['list', 'get', 'create', 'update', 'deactivate'],
  credentials: ['list', 'create', 'forNurse', 'grant', 'updateExpiry', 'revoke'],
  preferences: ['forNurse', 'replace'],
  shiftTypes: ['list', 'create', 'update', 'deactivate'],
  coverage: ['list', 'upsert', 'delete'],
  holidays: ['list', 'create', 'delete'],
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
  ],
  roster: ['pickImportFile', 'importRows', 'exportToFile', 'exportCsv'],
  periods: ['list', 'assignments', 'create'],
  schedule: [
    'validate',
    'createAssignment',
    'moveAssignment',
    'updateAssignment',
    'deleteAssignment',
    'setLocked',
  ],
  rules: ['getLatest', 'save'],
  timeOff: ['list'],
} as const satisfies { [R in keyof ShiftNurseApi]: readonly (keyof ShiftNurseApi[R])[] };

export type ApiResource = keyof ShiftNurseApi;

export function channelName(resource: string, method: string): string {
  return `shiftnurse:${resource}.${method}`;
}
