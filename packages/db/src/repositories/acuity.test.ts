import { isoDate, nursesRequiredForMix } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase } from '../client.js';
import {
  createAcuityTier,
  createRatioRule,
  deactivateRatioRule,
  deleteAcuityTier,
  listActiveRatioRulesForUnit,
  listRatioRulesForUnit,
} from './acuity.js';
import { listCensusForecastsInRange, recordActualCensus, upsertCensusForecast } from './census.js';
import { createShiftType, createUnit } from './config.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let unitId: string;
let shiftTypeId: string;
let lowId: string;
let highId: string;

beforeEach(() => {
  handle = openTestDatabase();
  unitId = createUnit(
    handle.db,
    {
      name: '4 West',
      unitType: 'Medical-Surgical',
      payPeriodDays: 14,
      payPeriodAnchor: isoDate('2026-01-04'),
    },
    ACTOR,
  ).id;
  shiftTypeId = createShiftType(
    handle.db,
    {
      unitId,
      name: 'Day 12',
      abbreviation: 'D12',
      startTime: '07:00',
      durationHours: 12,
      isNight: false,
      isOnCall: false,
      color: '#000',
      sortOrder: 1,
      active: true,
    },
    ACTOR,
  ).id;
  lowId = createAcuityTier(
    handle.db,
    { unitId, name: 'Low', level: 1, careHoursPerPatientDay: 4 },
    ACTOR,
  ).id;
  highId = createAcuityTier(
    handle.db,
    { unitId, name: 'High acuity', level: 3, careHoursPerPatientDay: 10 },
    ACTOR,
  ).id;
});
afterEach(() => handle.close());

function addRule(role: 'RN' | 'licensed', max: number) {
  return createRatioRule(
    handle.db,
    { unitId, role, acuityTierId: highId, maxPatientsPerNurse: max, active: true },
    ACTOR,
  );
}

function addCensus(date: string, mix: Record<string, number>) {
  const projectedCensus = Object.values(mix).reduce((a, b) => a + b, 0);
  return upsertCensusForecast(
    handle.db,
    { unitId, date: isoDate(date), shiftTypeId, projectedCensus, acuityMix: mix, source: 'manual' },
    ACTOR,
  );
}

const highActions = () => auditHistoryFor(handle.db, 'acuity_tier', highId).map((a) => a.action);

describe('deleting an acuity tier', () => {
  it('refuses to delete a tier a ratio rule cites, and keeps the rule', () => {
    addRule('RN', 3);
    expect(() => deleteAcuityTier(handle.db, highId, ACTOR)).toThrow(
      '"High acuity" is cited by 1 ratio rule (deactivated ones included). Rename it instead; deleting it would drop that rule.',
    );
    expect(listRatioRulesForUnit(handle.db, unitId)).toHaveLength(1);
    expect(highActions()).toEqual(['create']);
  });

  it('refuses while only a deactivated rule cites it, because past periods were judged by that rule', () => {
    const rule = addRule('RN', 3);
    deactivateRatioRule(handle.db, rule.id, ACTOR);
    expect(() => deleteAcuityTier(handle.db, highId, ACTOR)).toThrow(
      '"High acuity" is cited by 1 ratio rule (deactivated ones included). Rename it instead; deleting it would drop that rule.',
    );
    expect(listRatioRulesForUnit(handle.db, unitId)).toHaveLength(1);
  });

  it('refuses while a census day still counts patients at that tier', () => {
    addCensus('2026-01-16', { [highId]: 6 });
    expect(() => deleteAcuityTier(handle.db, highId, ACTOR)).toThrow(
      '"High acuity" is cited by 1 census day. Rename it instead; deleting it would leave those patients counted against no ratio.',
    );
    const rows = listCensusForecastsInRange(
      handle.db,
      unitId,
      isoDate('2026-01-01'),
      isoDate('2026-01-31'),
    );
    expect(rows[0]!.acuityMix).toEqual({ [highId]: 6 });
  });

  it('counts a census day by its recorded actual mix too', () => {
    const day = addCensus('2026-01-16', { [lowId]: 6 });
    recordActualCensus(handle.db, day.id, 6, { [highId]: 2, [lowId]: 4 }, ACTOR);
    expect(() => deleteAcuityTier(handle.db, highId, ACTOR)).toThrow(
      '"High acuity" is cited by 1 census day.',
    );
  });

  it('names both kinds of citation together', () => {
    addRule('RN', 3);
    addRule('licensed', 4);
    addCensus('2026-01-16', { [highId]: 6 });
    addCensus('2026-01-17', { [highId]: 5 });
    expect(() => deleteAcuityTier(handle.db, highId, ACTOR)).toThrow(
      '"High acuity" is cited by 2 ratio rules (deactivated ones included) and 2 census days. Rename it instead; deleting it would drop those rules and leave those patients counted against no ratio.',
    );
  });

  it('deletes a tier nothing cites, on the record', () => {
    addCensus('2026-01-16', { [highId]: 0, [lowId]: 6 });
    deleteAcuityTier(handle.db, highId, ACTOR);
    expect(highActions()).toEqual(['delete', 'create']);
  });

  it('keeps the staffing count when the delete is refused', () => {
    addRule('RN', 3);
    const day = addCensus('2026-01-16', { [highId]: 6 });
    expect(() => deleteAcuityTier(handle.db, highId, ACTOR)).toThrow(/Rename it instead/);
    // 6 patients at 1:3 is 2 RNs; the delete used to cascade the rule away and make this 0.
    expect(
      nursesRequiredForMix(day.acuityMix, 'RN', listActiveRatioRulesForUnit(handle.db, unitId)),
    ).toBe(2);
  });
});
