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
  updateRatioRule,
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
    deactivateRatioRule(handle.db, rule.id, ACTOR, 'Unit closed its high-acuity beds');
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
      nursesRequiredForMix(
        day.acuityMix,
        'RN',
        listActiveRatioRulesForUnit(handle.db, unitId),
        'day', // the 07:00 shift type above
      ),
    ).toBe(2);
  });
});

describe('editing a ratio ceiling', () => {
  function citedRule() {
    return createRatioRule(
      handle.db,
      {
        unitId,
        role: 'RN',
        acuityTierId: highId,
        maxPatientsPerNurse: 4,
        citation: 'CA Title 22 §70217',
        active: true,
      },
      ACTOR,
    );
  }
  const ruleAudits = (id: string) => auditHistoryFor(handle.db, 'ratio_rule', id);
  const readRule = (id: string) =>
    listRatioRulesForUnit(handle.db, unitId).find((r) => r.id === id)!;

  it('refuses to raise a ceiling without a reason, and writes nothing', () => {
    const rule = citedRule();
    expect(() => updateRatioRule(handle.db, rule.id, { maxPatientsPerNurse: 6 }, ACTOR)).toThrow(
      'Changing the RN ratio on High acuity (ceiling 1:4 → 1:6) needs a reason: a looser, re-cited or retired patient ratio is what gets quoted if staffing is challenged.',
    );
    expect(readRule(rule.id).maxPatientsPerNurse).toBe(4);
    expect(ruleAudits(rule.id)).toHaveLength(1);
  });

  it('raises a ceiling with a reason and keeps the old one in the audit log', () => {
    const rule = citedRule();
    updateRatioRule(
      handle.db,
      rule.id,
      { maxPatientsPerNurse: 6 },
      ACTOR,
      'Census below 20 per union MOU 2026-3',
    );
    const newest = ruleAudits(rule.id)[0]!;
    expect(newest.action).toBe('update');
    expect((newest.before as { maxPatientsPerNurse: number }).maxPatientsPerNurse).toBe(4);
    expect((newest.after as { maxPatientsPerNurse: number }).maxPatientsPerNurse).toBe(6);
    expect(newest.reason).toBe('Census below 20 per union MOU 2026-3');
  });

  it('tightens a ceiling without asking why', () => {
    const rule = citedRule();
    expect(updateRatioRule(handle.db, rule.id, { maxPatientsPerNurse: 3 }, ACTOR)).toMatchObject({
      maxPatientsPerNurse: 3,
    });
    expect(ruleAudits(rule.id)).toHaveLength(2);
  });

  it('refuses to clear the citation without a reason', () => {
    const rule = citedRule();
    expect(() => updateRatioRule(handle.db, rule.id, { citation: null }, ACTOR)).toThrow(
      'Changing the RN ratio on High acuity (citation removed) needs a reason',
    );
    expect(readRule(rule.id).citation).toBe('CA Title 22 §70217');
  });

  it('refuses to deactivate a ceiling without a reason', () => {
    const rule = citedRule();
    expect(() => deactivateRatioRule(handle.db, rule.id, ACTOR, '  ')).toThrow(
      'Deactivating the RN ratio on High acuity (1:4) needs a reason: a retired patient ratio is what gets quoted if staffing is challenged.',
    );
    expect(readRule(rule.id).active).toBe(true);
    expect(ruleAudits(rule.id)).toHaveLength(1);
  });

  it('deactivates with a reason, on the record', () => {
    const rule = citedRule();
    expect(
      deactivateRatioRule(handle.db, rule.id, ACTOR, 'High-acuity beds moved to 5 East').active,
    ).toBe(false);
    const newest = ruleAudits(rule.id)[0]!;
    expect(newest.action).toBe('delete');
    expect(newest.reason).toBe('High-acuity beds moved to 5 East');
    expect(() => deactivateRatioRule(handle.db, rule.id, ACTOR, 'Again')).toThrow(
      'That ratio rule is already inactive.',
    );
  });

  it('refuses deactivation slipped in as an update', () => {
    const rule = citedRule();
    expect(() => updateRatioRule(handle.db, rule.id, { active: false }, ACTOR)).toThrow(
      /needs a reason/,
    );
    expect(readRule(rule.id).active).toBe(true);
  });

  it('names a rule for every tier that way', () => {
    const rule = createRatioRule(
      handle.db,
      { unitId, role: 'licensed', acuityTierId: null, maxPatientsPerNurse: 5, active: true },
      ACTOR,
    );
    expect(() => deactivateRatioRule(handle.db, rule.id, ACTOR, '')).toThrow(
      'Deactivating the licensed-nurse ratio on every tier (1:5) needs a reason',
    );
  });
});

describe('a ratio that binds one shift', () => {
  const nightCna = () =>
    createRatioRule(
      handle.db,
      {
        unitId,
        role: 'CNA',
        acuityTierId: null,
        maxPatientsPerNurse: 11,
        citation: 'ORS 441.768',
        tour: 'night',
        active: true,
      },
      ACTOR,
    );
  const readRule = (id: string) =>
    listRatioRulesForUnit(handle.db, unitId).find((r) => r.id === id)!;

  it('keeps a night-only aide cap night-only when read back', () => {
    const rule = nightCna();
    expect(readRule(rule.id).tour).toBe('night');
    expect(auditHistoryFor(handle.db, 'ratio_rule', rule.id)[0]!.after).toMatchObject({
      tour: 'night',
    });
  });

  it('reads a rule with no shift as binding every shift', () => {
    const rule = createRatioRule(
      handle.db,
      { unitId, role: 'RN', acuityTierId: null, maxPatientsPerNurse: 5, active: true },
      ACTOR,
    );
    expect(readRule(rule.id)).not.toHaveProperty('tour');
  });

  it('refuses to move a cap to another shift without a reason', () => {
    const rule = nightCna();
    expect(() => updateRatioRule(handle.db, rule.id, { tour: 'day' }, ACTOR)).toThrow(
      /needs a reason/,
    );
    expect(readRule(rule.id).tour).toBe('night');
  });

  it('moves a cap to another shift with a reason and audits both shifts', () => {
    const rule = nightCna();
    updateRatioRule(handle.db, rule.id, { tour: 'day' }, ACTOR, 'Aides cover days only');
    expect(readRule(rule.id).tour).toBe('day');
    const newest = auditHistoryFor(handle.db, 'ratio_rule', rule.id)[0]!;
    expect((newest.before as { tour?: string }).tour).toBe('night');
    expect((newest.after as { tour?: string }).tour).toBe('day');
  });

  it('lets a cap be cleared back to every shift with a reason', () => {
    const rule = nightCna();
    updateRatioRule(handle.db, rule.id, { tour: null }, ACTOR, 'Aides cover every shift');
    expect(readRule(rule.id)).not.toHaveProperty('tour');
  });

  it('refuses a shift that is not day, evening or night', () => {
    const bad = { tour: 'graveyard' } as unknown as { tour: 'night' };
    expect(() =>
      createRatioRule(
        handle.db,
        { unitId, role: 'CNA', acuityTierId: null, maxPatientsPerNurse: 7, active: true, ...bad },
        ACTOR,
      ),
    ).toThrow("A ratio's tour must be day, evening or night");
    const rule = nightCna();
    expect(() => updateRatioRule(handle.db, rule.id, bad, ACTOR, 'why')).toThrow(
      "A ratio's tour must be day, evening or night",
    );
  });
});
