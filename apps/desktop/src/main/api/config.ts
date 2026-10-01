/**
 * The unit's configuration: the unit itself, shift types, coverage floors, holidays, acuity
 * (tiers, ratios, HPPD), the versioned rule set and the solver settings. Every write runs in one
 * transaction with its audit row; a rule set in particular is a header, its rule configs and the
 * audit entry, and a header saved without its configs would be a "latest" rule set with no rules.
 */

import { planHolidayYear } from '@shiftnurse/core';
import {
  addHolidayYear,
  clearHolidayWork,
  createAcuityTier,
  createHoliday,
  createRatioRule,
  createShiftType,
  deactivateRatioRule,
  deactivateShiftType,
  deleteAcuityTier,
  deleteCoverageRequirement,
  deleteHoliday,
  getHppdTarget,
  getSolverSettings,
  holidayWorkSummary,
  listAcuityTiersForUnit,
  listCoverageRequirementsForUnit,
  listHolidaysForUnit,
  listRatioRulesForUnit,
  listShiftTypesForUnit,
  listUnits,
  recordHolidayWork,
  type ShiftNurseDb,
  saveRuleSet,
  saveSolverSettings,
  transact,
  updateAcuityTier,
  updateHoliday,
  updateRatioRule,
  updateShiftType,
  updateUnit,
  upsertCoverageRequirement,
  upsertHppdTarget,
} from '@shiftnurse/db';
import type { ShiftNurseApi } from '../../shared/api.js';
import { ACTOR, latestRuleSetOrDefault } from './context.js';

export function configApi(
  db: ShiftNurseDb,
): Pick<
  ShiftNurseApi,
  'units' | 'shiftTypes' | 'coverage' | 'holidays' | 'acuity' | 'rules' | 'solverSettings'
> {
  return {
    units: {
      list: () => listUnits(db),
      update: (id, patch) => transact(db, (tx) => updateUnit(tx, id, patch, ACTOR)),
    },
    shiftTypes: {
      list: (unitId) => listShiftTypesForUnit(db, unitId),
      create: (input) => transact(db, (tx) => createShiftType(tx, input, ACTOR)),
      update: (id, patch) => transact(db, (tx) => updateShiftType(tx, id, patch, ACTOR)),
      deactivate: (id) => transact(db, (tx) => deactivateShiftType(tx, id, ACTOR)),
    },
    coverage: {
      list: (unitId) => listCoverageRequirementsForUnit(db, unitId),
      upsert: (input) => transact(db, (tx) => upsertCoverageRequirement(tx, input, ACTOR)),
      delete: (id) => transact(db, (tx) => deleteCoverageRequirement(tx, id, ACTOR)),
    },
    holidays: {
      list: (unitId) => listHolidaysForUnit(db, unitId),
      create: (input) => transact(db, (tx) => createHoliday(tx, input, ACTOR)),
      update: (id, patch) => transact(db, (tx) => updateHoliday(tx, id, patch, ACTOR)),
      delete: (id) => transact(db, (tx) => deleteHoliday(tx, id, ACTOR)),
      work: (holidayId) => holidayWorkSummary(db, holidayId),
      recordWork: (holidayId, nurseIds) =>
        transact(db, (tx) => recordHolidayWork(tx, holidayId, nurseIds, ACTOR)),
      clearWork: (holidayId) => transact(db, (tx) => clearHolidayWork(tx, holidayId, ACTOR)),
      planYear: (unitId, year) => planHolidayYear(listHolidaysForUnit(db, unitId), year),
      addYear: (unitId, input) => transact(db, (tx) => addHolidayYear(tx, unitId, input, ACTOR)),
    },
    acuity: {
      tiers: (unitId) => listAcuityTiersForUnit(db, unitId),
      createTier: (input) => transact(db, (tx) => createAcuityTier(tx, input, ACTOR)),
      updateTier: (id, patch) => transact(db, (tx) => updateAcuityTier(tx, id, patch, ACTOR)),
      deleteTier: (id) => transact(db, (tx) => deleteAcuityTier(tx, id, ACTOR)),
      ratioRules: (unitId) => listRatioRulesForUnit(db, unitId),
      createRatioRule: (input) => transact(db, (tx) => createRatioRule(tx, input, ACTOR)),
      updateRatioRule: (id, patch) => transact(db, (tx) => updateRatioRule(tx, id, patch, ACTOR)),
      deactivateRatioRule: (id) => transact(db, (tx) => deactivateRatioRule(tx, id, ACTOR)),
      hppd: (unitId) => getHppdTarget(db, unitId),
      setHppd: (unitId, targetHours) =>
        transact(db, (tx) => upsertHppdTarget(tx, unitId, targetHours, ACTOR)),
    },
    rules: {
      getLatest: (unitId) => latestRuleSetOrDefault(db, unitId),
      save: (unitId, name, configs, weekendDefinition, fairnessWeights) =>
        transact(db, (tx) =>
          saveRuleSet(
            tx,
            {
              ...latestRuleSetOrDefault(tx, unitId),
              name,
              configs,
              weekendDefinition,
              fairnessWeights,
            },
            ACTOR,
          ),
        ),
    },
    solverSettings: {
      get: (unitId) => getSolverSettings(db, unitId),
      save: (unitId, settings) => {
        const { id: _id, ...saved } = transact(db, (tx) =>
          saveSolverSettings(tx, unitId, settings, ACTOR),
        );
        return saved;
      },
    },
  };
}
