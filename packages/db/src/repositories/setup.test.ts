/**
 * Repository tests for first-run setup.
 *
 * What is easy to get quietly wrong here: seeding the demo over a real unit, a preset pressed
 * twice doubling the rows it wrote (two Christmases, two Day 12s), a quick-fill that stacks new
 * floors beside the ones already there instead of setting them, and a setup change that leaves
 * no audit trail.
 */

import { isoDate, type SetupPreset } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import { auditLog } from '../schema.js';
import {
  createRatioRule,
  getHppdTarget,
  listActiveRatioRulesForUnit,
  listAcuityTiersForUnit,
} from './acuity.js';
import {
  createUnit,
  getUnit,
  listCoverageRequirementsForUnit,
  listHolidaysForUnit,
  listShiftTypesForUnit,
  listUnits,
} from './config.js';
import { listActiveDifferentials, listOvertimeRulesForUnit, listPayRatesForUnit } from './pay.js';
import { getLatestRuleSet, getRuleSet } from './rulesets.js';
import {
  advanceSetup,
  applyJurisdiction,
  applySetupPreset,
  completeSetup,
  createSetupUnit,
  getSetupState,
  loadDemo,
  loadScenarios,
} from './setup.js';

// Several tests seed a whole demo unit (six months of history), about a second locally and
// several on a slow Windows CI runner: past vitest's 5 s default.
vi.setConfig({ testTimeout: 30_000 });

const ACTOR = 'manager';
let handle: OpenedDatabase;

beforeEach(() => {
  handle = openTestDatabase();
});

afterEach(() => handle.close());

const newUnit = (mode: 'manual' | 'assisted' = 'assisted') =>
  transact(handle.db, (tx) =>
    createSetupUnit(
      tx,
      {
        name: ' 5 East ',
        unitType: 'Medical-Surgical',
        payPeriodDays: 14,
        payPeriodAnchor: isoDate('2026-09-20'),
      },
      mode,
      ACTOR,
    ),
  );

const apply = (unitId: string, preset: SetupPreset) =>
  transact(handle.db, (tx) => applySetupPreset(tx, unitId, preset, ACTOR));

describe('starting setup', () => {
  it('has no setup record on a brand-new install', () => {
    expect(getSetupState(handle.db)).toBeUndefined();
  });

  it('loads the demo unit once and marks setup done', () => {
    const unit = transact(handle.db, (tx) => loadDemo(tx, ACTOR));
    expect(unit.name).toBe('5 North Medical-Surgical');
    expect(getSetupState(handle.db)).toMatchObject({ mode: 'demo', status: 'complete' });
  });

  it('loads the VA ward when that demo is picked', () => {
    const unit = transact(handle.db, (tx) => loadDemo(tx, ACTOR, 'va-sf-med-surg'));
    expect(unit.name).toBe('4A Medicine-Surgery (VA San Francisco sample)');
  });

  it('refuses a demo that does not exist, and writes nothing', () => {
    expect(() => transact(handle.db, (tx) => loadDemo(tx, ACTOR, 'mars-base' as 'ca-icu'))).toThrow(
      /Unknown demo unit/,
    );
    expect(listUnits(handle.db)).toEqual([]);
  });

  it('loads the test-scenario unit, not the demo, when a developer asks for it', () => {
    const unit = transact(handle.db, (tx) => loadScenarios(tx, ACTOR));
    expect(unit.name).toBe('Test scenarios: 4 West Med-Surg');
    expect(getSetupState(handle.db)).toMatchObject({ mode: 'scenarios', status: 'complete' });
    expect(() => transact(handle.db, (tx) => loadDemo(tx, ACTOR))).toThrow(/already has a unit/);
  });

  it('refuses to load the demo over a unit the manager already set up', () => {
    newUnit('manual');
    expect(() => transact(handle.db, (tx) => loadDemo(tx, ACTOR))).toThrow(/already has a unit/);
    expect(listUnits(handle.db)).toHaveLength(1);
  });

  it('finishes a manual setup the moment the unit exists, with nothing else configured', () => {
    const unit = newUnit('manual');
    expect(unit.name).toBe('5 East');
    expect(getSetupState(handle.db)).toMatchObject({ mode: 'manual', status: 'complete' });
    expect(listShiftTypesForUnit(handle.db, unit.id)).toEqual([]);
  });

  it('opens the assisted guide at shift types', () => {
    newUnit('assisted');
    expect(getSetupState(handle.db)).toMatchObject({
      mode: 'assisted',
      status: 'in_progress',
      currentStep: 'shift-types',
      completedAt: null,
    });
  });

  it('refuses a unit with no name', () => {
    expect(() =>
      transact(handle.db, (tx) =>
        createSetupUnit(
          tx,
          {
            name: '  ',
            unitType: 'ICU',
            payPeriodDays: 14,
            payPeriodAnchor: isoDate('2026-09-20'),
          },
          'manual',
          ACTOR,
        ),
      ),
    ).toThrow(/needs a name/);
  });
});

describe('moving through the guide', () => {
  it('remembers a skipped step until the manager comes back and finishes it', () => {
    newUnit();
    advanceSetup(handle.db, { from: 'shift-types', to: 'coverage', skipped: true }, ACTOR);
    advanceSetup(handle.db, { from: 'coverage', to: 'acuity', skipped: true }, ACTOR);
    expect(getSetupState(handle.db)?.skippedSteps).toEqual(['shift-types', 'coverage']);
    // Back to shift types, then continue properly this time.
    advanceSetup(handle.db, { from: 'acuity', to: 'shift-types', skipped: false }, ACTOR);
    advanceSetup(handle.db, { from: 'shift-types', to: 'coverage', skipped: false }, ACTOR);
    expect(getSetupState(handle.db)).toMatchObject({
      currentStep: 'coverage',
      skippedSteps: ['coverage'],
    });
  });

  it('closes the guide on finish and will not advance a finished guide', () => {
    newUnit();
    const done = completeSetup(handle.db, ACTOR);
    expect(done).toMatchObject({ status: 'complete', currentStep: null });
    expect(done.completedAt).not.toBeNull();
    expect(() =>
      advanceSetup(handle.db, { from: 'coverage', to: 'acuity', skipped: false }, ACTOR),
    ).toThrow(/not in progress/);
  });

  it('writes every setup change to the audit log', () => {
    newUnit();
    advanceSetup(handle.db, { from: 'shift-types', to: 'coverage', skipped: true }, ACTOR);
    completeSetup(handle.db, ACTOR);
    // Newest first.
    const history = auditHistoryFor(handle.db, 'setup_state', 'app');
    expect(history.map((e) => e.action)).toEqual(['update', 'update', 'create']);
    expect(history[0]?.before).toMatchObject({ status: 'in_progress' });
    expect(history[0]?.after).toMatchObject({ status: 'complete' });
  });
});

describe('presets', () => {
  it('adds the 12-hour pair once, however often the button is pressed', () => {
    const unit = newUnit();
    expect(apply(unit.id, { kind: 'shift-pattern', pattern: '12h' })).toEqual({
      created: 2,
      updated: 0,
      unchanged: 0,
    });
    expect(apply(unit.id, { kind: 'shift-pattern', pattern: 'both' })).toEqual({
      created: 3,
      updated: 0,
      unchanged: 2,
    });
    const codes = listShiftTypesForUnit(handle.db, unit.id).map((s) => s.abbreviation);
    expect(codes).toEqual(['D12', 'N12', 'D8', 'E8', 'N8']);
  });

  it('sets a flat staffing floor, and changing the numbers updates it rather than stacking', () => {
    const unit = newUnit();
    apply(unit.id, { kind: 'shift-pattern', pattern: '12h' });
    const ids = listShiftTypesForUnit(handle.db, unit.id).map((s) => s.id);
    apply(unit.id, { kind: 'coverage', shiftTypeIds: ids, counts: { RN: 4, CNA: 1 } });
    const second = apply(unit.id, {
      kind: 'coverage',
      shiftTypeIds: ids,
      counts: { RN: 5, CNA: 1 },
    });
    // 2 shifts × 7 days: the RN floors change, the CNA floors are already right.
    expect(second).toEqual({ created: 0, updated: 14, unchanged: 14 });
    const floors = listCoverageRequirementsForUnit(handle.db, unit.id);
    expect(floors).toHaveLength(28);
    expect(floors.filter((f) => f.role === 'RN').every((f) => f.minCount === 5)).toBe(true);
  });

  it('refuses a floor on a shift type from another unit', () => {
    const unit = newUnit();
    expect(() =>
      apply(unit.id, { kind: 'coverage', shiftTypeIds: ['st_elsewhere'], counts: { RN: 1 } }),
    ).toThrow(/not on this unit/);
  });

  it('gives a med-surg unit three tiers, a 1:5 routine ratio and an HPPD target, once', () => {
    const unit = newUnit();
    apply(unit.id, { kind: 'acuity', preset: 'med-surg' });
    const again = apply(unit.id, { kind: 'acuity', preset: 'med-surg' });
    expect(again.created).toBe(0);
    const tiers = listAcuityTiersForUnit(handle.db, unit.id);
    expect(tiers.map((t) => t.name)).toEqual(['Routine', 'Moderate', 'High']);
    const routine = listActiveRatioRulesForUnit(handle.db, unit.id).find(
      (r) => r.acuityTierId === tiers[0]!.id,
    );
    expect(routine?.maxPatientsPerNurse).toBe(5);
    expect(getHppdTarget(handle.db, unit.id)?.targetHours).toBe(6.5);
  });

  it('adds US holidays for two years without duplicating a date already on the calendar', () => {
    const unit = newUnit();
    apply(unit.id, { kind: 'holidays', years: [2026] });
    const result = apply(unit.id, { kind: 'holidays', years: [2026, 2027] });
    expect(result).toEqual({ created: 11, updated: 0, unchanged: 11 });
    expect(listHolidaysForUnit(handle.db, unit.id)).toHaveLength(22);
  });

  it('saves the recommended rules as version 1 and leaves an existing rule set alone', () => {
    const unit = newUnit();
    expect(apply(unit.id, { kind: 'rules' }).created).toBe(1);
    expect(apply(unit.id, { kind: 'rules' }).created).toBe(0);
    expect(getLatestRuleSet(handle.db, unit.id)?.version).toBe(1);
  });

  it('sets role base rates from the pay-period anchor and keeps a rate already set', () => {
    const unit = newUnit();
    apply(unit.id, { kind: 'base-rates', rates: { RN: 52 } });
    const result = apply(unit.id, { kind: 'base-rates', rates: { RN: 60, CNA: 24 } });
    expect(result).toEqual({ created: 1, updated: 0, unchanged: 1 });
    const rn = listPayRatesForUnit(handle.db, unit.id).filter((r) => r.role === 'RN');
    expect(rn).toEqual([expect.objectContaining({ hourlyRate: 52, effectiveFrom: '2026-09-20' })]);
  });

  it('refuses a zero pay rate', () => {
    const unit = newUnit();
    expect(() => apply(unit.id, { kind: 'base-rates', rates: { RN: 0 } })).toThrow(
      /more than zero/,
    );
  });

  it('writes nothing for a preset on an unknown unit', () => {
    createUnit(
      handle.db,
      {
        name: 'Other',
        unitType: 'ICU',
        payPeriodDays: 14,
        payPeriodAnchor: isoDate('2026-09-20'),
      },
      ACTOR,
    );
    expect(() => apply('unit_missing', { kind: 'rules' })).toThrow(/not found/);
  });
});

describe('applying a state preset', () => {
  const applyState = (unitId: string, id: Parameters<typeof applyJurisdiction>[2]) =>
    transact(handle.db, (tx) => applyJurisdiction(tx, unitId, id, ACTOR));
  const auditRows = () => handle.db.select().from(auditLog).all().length;

  it('gives a California med-surg unit its 1:5 ceiling, the overtime law and charge nurse off the bedside', () => {
    const unit = newUnit();
    const result = applyState(unit.id, 'CA');

    expect(listActiveRatioRulesForUnit(handle.db, unit.id)).toEqual([
      expect.objectContaining({ role: 'RN', acuityTierId: null, maxPatientsPerNurse: 5 }),
    ]);
    expect(listOvertimeRulesForUnit(handle.db, unit.id)).toHaveLength(5);
    expect(getUnit(handle.db, unit.id)).toMatchObject({
      jurisdiction: 'CA',
      ratioStaffing: {
        chargeNurseTakesPatients: false,
        breakMinutesPerNurse: 60,
        chargeCoversBreaks: true,
      },
    });
    // Not asked about an alternative workweek: 1 ratio rule + 5 overtime rules (daily 8, daily
    // 12, weekly 40, both seventh-day) created, and no rule set, since the 12-in-24 cap applies
    // only on that workweek; ratio staffing, the leave policy (California sick leave) and the
    // stored choice updated.
    expect(result).toEqual({ created: 6, updated: 3, unchanged: 0 });
  });

  it('gives a VA unit its Title 5 leave policy once, and leaves it alone on a second Apply', () => {
    const unit = newUnit();
    expect(getUnit(handle.db, unit.id)?.leavePolicy).toBeUndefined();
    applyState(unit.id, 'US-VA');
    const stored = getUnit(handle.db, unit.id)!.leavePolicy!;
    expect(stored.fmla).toEqual({ regime: 'title5', yearMethod: 'rolling_forward' });
    expect(stored.leaveYearStart).toBe('first_full_pay_period');
    expect(stored.accrual.length).toBeGreaterThan(0);

    const before = auditRows();
    const again = applyState(unit.id, 'US-VA');
    expect(again).toEqual({ created: 0, updated: 0, unchanged: 1 });
    expect(auditRows()).toBe(before);
    expect(getUnit(handle.db, unit.id)?.leavePolicy).toEqual(stored);
  });

  it('gives a VA unit the Title 38 premiums, four weeks’ posting and the overtime rosters once', () => {
    const unit = newUnit();
    const first = applyState(unit.id, 'US-VA');
    expect(listActiveDifferentials(handle.db, unit.id).map((d) => `${d.kind} ${d.amount}`)).toEqual(
      ['night 1.1', 'weekend 1.25', 'holiday 2'],
    );
    expect(getUnit(handle.db, unit.id)).toMatchObject({
      postingLeadDays: 28,
      overtimeOrder: 'roster',
    });
    // Created: 7 overtime rules (weekly 40, consecutive 8 and the five scoped to the 72/80 and
    // Baylor plans), 3 differentials and 1 rule set; updated: the posting notice and overtime
    // order, the leave policy and the stored choice.
    expect(first).toEqual({ created: 11, updated: 3, unchanged: 0 });
    const baylor = listOvertimeRulesForUnit(handle.db, unit.id).filter((r) =>
      r.scheduleKinds?.includes('va_baylor'),
    );
    expect(baylor.map((r) => `${r.basis} ${r.thresholdHours}`).sort()).toEqual([
      'beyond_scheduled_tour 0',
      'weekly 40',
    ]);
    expect(baylor.every((r) => r.scheduleKinds?.length === 1)).toBe(true);
    expect(
      listOvertimeRulesForUnit(handle.db, unit.id).find((r) => r.tourDays === 'only'),
    ).toMatchObject({ basis: 'daily', thresholdHours: 12, scheduleKinds: ['va_72_80'] });

    const before = auditRows();
    expect(applyState(unit.id, 'US-VA')).toEqual({ created: 0, updated: 0, unchanged: 1 });
    expect(auditRows()).toBe(before);
    expect(listActiveDifferentials(handle.db, unit.id)).toHaveLength(3);
  });

  it('writes nothing the second time a manager presses Apply', () => {
    const unit = newUnit();
    applyState(unit.id, 'CA');
    const before = auditRows();
    const result = applyState(unit.id, 'CA');
    expect(result).toEqual({ created: 0, updated: 0, unchanged: 1 });
    expect(auditRows()).toBe(before);
  });

  it('lowers a looser catch-all ratio instead of adding a second one', () => {
    const unit = newUnit();
    transact(handle.db, (tx) =>
      createRatioRule(
        tx,
        { unitId: unit.id, role: 'RN', acuityTierId: null, maxPatientsPerNurse: 8, active: true },
        ACTOR,
      ),
    );
    const result = applyState(unit.id, 'CA');
    expect(listActiveRatioRulesForUnit(handle.db, unit.id)).toEqual([
      expect.objectContaining({ maxPatientsPerNurse: 5 }),
    ]);
    expect(result.updated).toBeGreaterThanOrEqual(1);
  });

  it('switches on the ban on mandatory overtime in New York as a new rule-set version', () => {
    const unit = newUnit();
    apply(unit.id, { kind: 'rules' });
    const v1 = getLatestRuleSet(handle.db, unit.id)!;
    expect(v1.configs.find((c) => c.ruleId === 'no-mandatory-overtime')?.enabled ?? false).toBe(
      false,
    );

    applyState(unit.id, 'NY');

    const v2 = getLatestRuleSet(handle.db, unit.id)!;
    expect(v2.version).toBe(v1.version + 1);
    expect(v2.configs.find((c) => c.ruleId === 'no-mandatory-overtime')?.enabled).toBe(true);
    const untouched = getRuleSet(handle.db, v1.id)!;
    expect(
      untouched.configs.find((c) => c.ruleId === 'no-mandatory-overtime')?.enabled ?? false,
    ).toBe(false);
    expect(getUnit(handle.db, unit.id)?.jurisdiction).toBe('NY');
  });

  it('remembers the choice for a state with nothing to add', () => {
    const unit = newUnit();
    expect(applyState(unit.id, 'other')).toEqual({ created: 0, updated: 1, unchanged: 0 });
    expect(getUnit(handle.db, unit.id)?.jurisdiction).toBe('other');
  });

  it('refuses a state it has no preset for', () => {
    const unit = newUnit();
    expect(() => applyState(unit.id, 'ZZ' as never)).toThrow(/Unknown state preset/);
  });
});
