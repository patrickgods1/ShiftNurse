/**
 * First-run setup: the persisted setup state, the demo and "new unit" starts, and the
 * one-click presets the assisted guide offers.
 *
 * Every preset writes through the same audited create/upsert functions the Settings editors
 * use, so a preset row is indistinguishable from one the manager typed, and applying a preset
 * twice leaves the unit as it was after the first time: a manager who presses "Add US holidays"
 * again, or comes back to a step after quitting, must not get two Christmases. Presets only
 * ever add what is missing (coverage, the one exception, sets the floor it names, because
 * "4 RNs on every shift" is a statement of the floor rather than an addition to it).
 */

import {
  ACUITY_PRESETS,
  type AcuityPresetId,
  coverageQuickFill,
  DEFAULT_WEEKEND,
  defaultRuleSet,
  type Id,
  isoDate,
  isSetupStep,
  JURISDICTION_PRESETS,
  type JurisdictionChoices,
  type JurisdictionId,
  type NurseRole,
  planJurisdiction,
  SETUP_STEPS,
  type SetupMode,
  type SetupPreset,
  type SetupPresetResult,
  type SetupState,
  type SetupStepId,
  SHIFT_PATTERNS,
  type ShiftPatternId,
  type Unit,
  type UnitSetupMode,
  usFederalHolidays,
} from '@shiftnurse/core';
import { eq } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import type { DbLike, ShiftNurseTx } from '../client.js';
import { setupState } from '../schema.js';
import { type DemoId, isDemoId, seedDemoUnit } from '../seed/demo.js';
import { seedScenarioUnit } from '../seed/scenarios.js';
import {
  createAcuityTier,
  createRatioRule,
  getHppdTarget,
  listActiveRatioRulesForUnit,
  listAcuityTiersForUnit,
  updateRatioRule,
  upsertHppdTarget,
} from './acuity.js';
import {
  createShiftType,
  createUnit,
  getUnit,
  listCoverageRequirementsForUnit,
  listHolidaysForUnit,
  listShiftTypesForUnit,
  listUnits,
  updateUnit,
  upsertCoverageRequirement,
} from './config.js';
import { createHoliday } from './holidays.js';
import {
  createDifferential,
  createOvertimeRule,
  createPayRate,
  listActiveDifferentials,
  listOvertimeRulesForUnit,
  listPayRatesForUnit,
} from './pay.js';
import { getLatestRuleSet, saveRuleSet } from './rulesets.js';

const ROW_ID = 'app';
const ENTITY = 'setup_state';

function toState(row: typeof setupState.$inferSelect): SetupState {
  return {
    mode: row.mode,
    status: row.status,
    currentStep: row.currentStep,
    skippedSteps: row.skippedSteps,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

export function getSetupState(db: DbLike): SetupState | undefined {
  const row = db.select().from(setupState).where(eq(setupState.id, ROW_ID)).get();
  return row ? toState(row) : undefined;
}

function writeState(db: DbLike, next: SetupState, actor: string): SetupState {
  const before = getSetupState(db);
  const values = { id: ROW_ID, ...next };
  if (before) {
    db.update(setupState).set(values).where(eq(setupState.id, ROW_ID)).run();
  } else {
    db.insert(setupState).values(values).run();
  }
  recordAudit(db, {
    entityType: ENTITY,
    entityId: ROW_ID,
    action: before ? 'update' : 'create',
    actor,
    before,
    after: next,
  });
  return next;
}

/**
 * Start (or restart, from Settings) setup in `mode`. Every mode but assisted is finished the
 * moment it starts; assisted opens at its first step.
 */
export function startSetup(db: DbLike, mode: SetupMode, actor: string): SetupState {
  const now = Date.now();
  const assisted = mode === 'assisted';
  return writeState(
    db,
    {
      mode,
      status: assisted ? 'in_progress' : 'complete',
      currentStep: assisted ? SETUP_STEPS[0] : null,
      skippedSteps: [],
      startedAt: now,
      completedAt: assisted ? null : now,
    },
    actor,
  );
}

function requireInProgress(db: DbLike): SetupState {
  const state = getSetupState(db);
  if (state?.status !== 'in_progress') {
    throw new Error('The setup guide is not in progress');
  }
  return state;
}

/**
 * Move the guide from `from` to `to`. A skipped step is remembered for the summary; finishing
 * a step later (by coming back to it) clears the mark.
 */
export function advanceSetup(
  db: DbLike,
  move: { from: SetupStepId; to: SetupStepId; skipped: boolean },
  actor: string,
): SetupState {
  if (!isSetupStep(move.from) || !isSetupStep(move.to)) {
    throw new Error(`Unknown setup step "${move.from}" or "${move.to}"`);
  }
  const state = requireInProgress(db);
  const others = state.skippedSteps.filter((s) => s !== move.from);
  const skippedSteps = move.skipped ? [...others, move.from] : others;
  return writeState(
    db,
    {
      ...state,
      currentStep: move.to,
      skippedSteps: SETUP_STEPS.filter((s) => skippedSteps.includes(s)),
    },
    actor,
  );
}

export function completeSetup(db: DbLike, actor: string): SetupState {
  const state = requireInProgress(db);
  return writeState(
    db,
    { ...state, status: 'complete', currentStep: null, completedAt: Date.now() },
    actor,
  );
}

function refuseIfConfigured(db: DbLike): void {
  if (listUnits(db).length > 0) {
    throw new Error('This database already has a unit; setup only runs on an empty install');
  }
}

/**
 * Seed one of the realistic demo units (the community med-surg unit unless another is named)
 * and mark setup done. Only on an empty install: never seed twice.
 */
export function loadDemo(tx: ShiftNurseTx, actor: string, demo?: DemoId): Unit {
  if (demo !== undefined && !isDemoId(demo)) throw new Error(`Unknown demo unit "${demo}"`);
  return loadSeeded(tx, 'demo', () => seedDemoUnit(tx, { demo }).unitId, actor);
}

/**
 * Seed the test-scenario unit, the dataset the automated tests are built on, for trying a change
 * by hand against the same planted problems. Developer-only: the caller decides who may.
 */
export function loadScenarios(tx: ShiftNurseTx, actor: string): Unit {
  return loadSeeded(tx, 'scenarios', () => seedScenarioUnit(tx).unitId, actor);
}

function loadSeeded(
  tx: ShiftNurseTx,
  mode: 'demo' | 'scenarios',
  seed: () => Id,
  actor: string,
): Unit {
  refuseIfConfigured(tx);
  const unitId = seed();
  startSetup(tx, mode, actor);
  const unit = getUnit(tx, unitId);
  if (!unit) throw new Error(`Seeded unit ${unitId} not found`);
  return unit;
}

/** Create the unit a manual or assisted setup starts from. */
export function createSetupUnit(
  tx: ShiftNurseTx,
  input: Omit<Unit, 'id'>,
  mode: UnitSetupMode,
  actor: string,
): Unit {
  refuseIfConfigured(tx);
  if (input.name.trim() === '') throw new Error('The unit needs a name');
  if (!Number.isInteger(input.payPeriodDays) || input.payPeriodDays <= 0) {
    throw new Error('The pay period must be a whole number of days');
  }
  isoDate(input.payPeriodAnchor);
  const unit = createUnit(tx, { ...input, name: input.name.trim() }, actor);
  startSetup(tx, mode, actor);
  return unit;
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

function applyShiftPattern(
  db: DbLike,
  unitId: Id,
  pattern: ShiftPatternId,
  actor: string,
): SetupPresetResult {
  const preset = SHIFT_PATTERNS[pattern];
  if (!preset) throw new Error(`Unknown shift pattern "${pattern}"`);
  const existing = listShiftTypesForUnit(db, unitId);
  const codes = new Set(existing.map((s) => s.abbreviation.toUpperCase()));
  let sortOrder = Math.max(0, ...existing.map((s) => s.sortOrder));
  const result = { created: 0, updated: 0, unchanged: 0 };
  for (const shift of preset.shiftTypes) {
    if (codes.has(shift.abbreviation.toUpperCase())) {
      result.unchanged++;
      continue;
    }
    sortOrder += 1;
    createShiftType(db, { ...shift, unitId, sortOrder, active: true }, actor);
    result.created++;
  }
  return result;
}

function applyAcuityPreset(
  db: DbLike,
  unitId: Id,
  presetId: AcuityPresetId,
  actor: string,
): SetupPresetResult {
  const preset = ACUITY_PRESETS[presetId];
  if (!preset) throw new Error(`Unknown acuity preset "${presetId}"`);
  const result = { created: 0, updated: 0, unchanged: 0 };
  const tierByLevel = new Map(listAcuityTiersForUnit(db, unitId).map((t) => [t.level, t.id]));
  for (const tier of preset.tiers) {
    if (tierByLevel.has(tier.level)) {
      result.unchanged++;
      continue;
    }
    tierByLevel.set(tier.level, createAcuityTier(db, { ...tier, unitId }, actor).id);
    result.created++;
  }
  const active = listActiveRatioRulesForUnit(db, unitId);
  for (const ratio of preset.ratios) {
    const acuityTierId = tierByLevel.get(ratio.tierLevel)!;
    if (active.some((r) => r.role === ratio.role && r.acuityTierId === acuityTierId)) {
      result.unchanged++;
      continue;
    }
    createRatioRule(
      db,
      {
        unitId,
        role: ratio.role,
        acuityTierId,
        maxPatientsPerNurse: ratio.maxPatientsPerNurse,
        citation: ratio.citation,
        active: true,
      },
      actor,
    );
    result.created++;
  }
  if (getHppdTarget(db, unitId) === undefined) {
    upsertHppdTarget(db, unitId, preset.hppdTarget, actor);
    result.created++;
  } else {
    result.unchanged++;
  }
  return result;
}

function applyCoverage(
  db: DbLike,
  unitId: Id,
  shiftTypeIds: readonly Id[],
  counts: Partial<Record<NurseRole, number>>,
  actor: string,
): SetupPresetResult {
  for (const [role, count] of Object.entries(counts)) {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`The ${role} floor must be a whole number of nurses`);
    }
  }
  const byId = new Map(listShiftTypesForUnit(db, unitId).map((s) => [s.id, s]));
  const shiftTypes = shiftTypeIds.map((id) => {
    const shiftType = byId.get(id);
    if (!shiftType) throw new Error(`Shift type ${id} is not on this unit`);
    return shiftType;
  });
  const existing = new Map(
    listCoverageRequirementsForUnit(db, unitId)
      .filter((r) => r.date === null)
      .map((r) => [`${r.shiftTypeId}|${r.weekday}|${r.role}`, r]),
  );
  const result = { created: 0, updated: 0, unchanged: 0 };
  for (const row of coverageQuickFill(shiftTypes, counts)) {
    const current = existing.get(`${row.shiftTypeId}|${row.weekday}|${row.role}`);
    if (current && current.minCount === row.minCount && current.targetCount === row.targetCount) {
      result.unchanged++;
      continue;
    }
    upsertCoverageRequirement(db, { ...row, unitId, id: current?.id }, actor);
    if (current) result.updated++;
    else result.created++;
  }
  return result;
}

function applyHolidays(
  db: DbLike,
  unitId: Id,
  years: readonly number[],
  actor: string,
): SetupPresetResult {
  const taken = new Set<string>(listHolidaysForUnit(db, unitId).map((h) => h.date));
  const result = { created: 0, updated: 0, unchanged: 0 };
  for (const year of years) {
    if (!Number.isInteger(year) || year < 1971 || year > 9999) {
      throw new Error(`Cannot list holidays for year ${year}`);
    }
    for (const holiday of usFederalHolidays(year)) {
      if (taken.has(holiday.date)) {
        result.unchanged++;
        continue;
      }
      createHoliday(db, { ...holiday, unitId }, actor);
      taken.add(holiday.date);
      result.created++;
    }
  }
  return result;
}

/** Save the default rules as version 1, unless the unit already has a rule set. */
function applyDefaultRules(db: ShiftNurseTx, unitId: Id, actor: string): SetupPresetResult {
  if (getLatestRuleSet(db, unitId) !== undefined) return { created: 0, updated: 0, unchanged: 1 };
  const base = defaultRuleSet(unitId);
  saveRuleSet(
    db,
    {
      unitId,
      name: base.name,
      configs: base.configs,
      weekendDefinition: DEFAULT_WEEKEND,
      fairnessWeights: base.fairnessWeights,
    },
    actor,
  );
  return { created: 1, updated: 0, unchanged: 0 };
}

/**
 * Role base rates, effective from the unit's pay-period anchor. A role that already has a base
 * rate keeps it: a rate change is dated, and belongs in Settings › Pay where the date is asked.
 */
function applyBaseRates(
  db: DbLike,
  unit: Unit,
  rates: Partial<Record<NurseRole, number>>,
  actor: string,
): SetupPresetResult {
  const withRate = new Set(
    listPayRatesForUnit(db, unit.id)
      .filter((r) => r.nurseId === null)
      .map((r) => r.role),
  );
  const result = { created: 0, updated: 0, unchanged: 0 };
  for (const [role, hourlyRate] of Object.entries(rates) as [NurseRole, number][]) {
    if (!Number.isFinite(hourlyRate) || hourlyRate <= 0) {
      throw new Error(`The ${role} hourly rate must be more than zero`);
    }
    if (withRate.has(role)) {
      result.unchanged++;
      continue;
    }
    createPayRate(
      db,
      { nurseId: null, role, hourlyRate, effectiveFrom: unit.payPeriodAnchor },
      actor,
    );
    result.created++;
  }
  return result;
}

/** Apply one of the guide's one-click starting points to `unitId`. Call inside `transact`. */
export function applySetupPreset(
  tx: ShiftNurseTx,
  unitId: Id,
  preset: SetupPreset,
  actor: string,
): SetupPresetResult {
  const unit = getUnit(tx, unitId);
  if (!unit) throw new Error(`Unit ${unitId} not found`);
  switch (preset.kind) {
    case 'shift-pattern':
      return applyShiftPattern(tx, unitId, preset.pattern, actor);
    case 'acuity':
      return applyAcuityPreset(tx, unitId, preset.preset, actor);
    case 'coverage':
      return applyCoverage(tx, unitId, preset.shiftTypeIds, preset.counts, actor);
    case 'holidays':
      return applyHolidays(tx, unitId, preset.years, actor);
    case 'rules':
      return applyDefaultRules(tx, unitId, actor);
    case 'base-rates':
      return applyBaseRates(tx, unit, preset.rates, actor);
    default: {
      const unknown: never = preset;
      throw new Error(`Unknown setup preset ${JSON.stringify(unknown)}`);
    }
  }
}

/**
 * Apply a state's staffing and overtime preset to `unitId`: core plans what to add or tighten,
 * and each change goes through the same audited create/update the Settings editors use. The
 * choice is remembered on the unit even when nothing else changed, so Settings › Unit can show
 * it; rules a preset switches on arrive as a new rule-set version, never an edit to the old one.
 * `choices` answers the preset's apply-time questions; they decide the plan and are stored on the
 * unit, since `ownContract` goes on deciding which rules `saveRuleSet` protects.
 */
export function applyJurisdiction(
  tx: ShiftNurseTx,
  unitId: Id,
  id: JurisdictionId,
  actor: string,
  choices: JurisdictionChoices = {},
): SetupPresetResult {
  if (!Object.hasOwn(JURISDICTION_PRESETS, id)) throw new Error(`Unknown state preset "${id}"`);
  const unit = getUnit(tx, unitId);
  if (!unit) throw new Error(`Unit ${unitId} not found`);
  // A unit that never saved rules runs the defaults, so those are what the preset switches on.
  const latest = getLatestRuleSet(tx, unitId);
  const plan = planJurisdiction(
    id,
    {
      unitType: unit.unitType,
      ratioRules: listActiveRatioRulesForUnit(tx, unitId),
      overtimeRules: listOvertimeRulesForUnit(tx, unitId),
      ruleSet: latest ?? defaultRuleSet(unitId),
      ratioStaffing: unit.ratioStaffing,
      leavePolicy: unit.leavePolicy,
      differentials: listActiveDifferentials(tx, unitId),
      postingLeadDays: unit.postingLeadDays,
      overtimeOrder: unit.overtimeOrder,
    },
    choices,
  );

  const result = { created: 0, updated: 0, unchanged: 0 };
  for (const rule of plan.addRatioRules) {
    createRatioRule(tx, { ...rule, unitId }, actor);
    result.created++;
  }
  for (const rule of plan.tightenRatioRules) {
    updateRatioRule(tx, rule.id, { maxPatientsPerNurse: rule.maxPatientsPerNurse }, actor);
    result.updated++;
  }
  for (const rule of plan.addOvertimeRules) {
    createOvertimeRule(tx, { ...rule, unitId }, actor);
    result.created++;
  }
  for (const d of plan.addDifferentials) {
    createDifferential(tx, { ...d, unitId, active: true }, actor);
    result.created++;
  }
  if (plan.unit) {
    updateUnit(tx, unitId, plan.unit, actor);
    result.updated++;
  }
  if (plan.ratioStaffing) {
    updateUnit(tx, unitId, { ratioStaffing: plan.ratioStaffing }, actor);
    result.updated++;
  }
  if (plan.leavePolicy) {
    updateUnit(tx, unitId, { leavePolicy: plan.leavePolicy }, actor);
    result.updated++;
  }
  if (plan.ruleConfigs) {
    const base = latest ?? defaultRuleSet(unitId);
    saveRuleSet(
      tx,
      {
        unitId,
        name: base.name,
        configs: plan.ruleConfigs,
        weekendDefinition: latest?.weekendDefinition ?? DEFAULT_WEEKEND,
        fairnessWeights: base.fairnessWeights,
      },
      actor,
    );
    result.created++;
  }
  if (unit.jurisdiction !== id) {
    updateUnit(tx, unitId, { jurisdiction: id }, actor);
    result.updated++;
  }
  // Only the yeses are kept: an unanswered question reads as no, so `{}`, `{ x: false }` and no
  // stored answers are the same and re-applying with them changes nothing.
  const answered = yesAnswers(choices);
  if (JSON.stringify(answered) !== JSON.stringify(yesAnswers(unit.jurisdictionChoices ?? {}))) {
    updateUnit(
      tx,
      unitId,
      { jurisdictionChoices: Object.keys(answered).length > 0 ? answered : null },
      actor,
    );
    result.updated++;
  }
  if (result.created + result.updated === 0) result.unchanged = 1;
  return result;
}

/** The questions answered yes, in key order, so two equal sets of answers serialise alike. */
function yesAnswers(choices: JurisdictionChoices): JurisdictionChoices {
  return Object.fromEntries(
    Object.entries(choices)
      .filter(([, yes]) => yes)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}
