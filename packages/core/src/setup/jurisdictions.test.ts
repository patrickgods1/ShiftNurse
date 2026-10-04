import { describe, expect, it } from 'vitest';
import type { OvertimeRule, RatioRule } from '../domain/entities.js';
import { defaultRuleSet } from '../rules/registry.js';
import { type JurisdictionPlanInput, planJurisdiction } from './jurisdictions.js';

const UNIT = 'unit-1';

function ratio(id: string, max: number, tier: string | null = null): RatioRule {
  return {
    id,
    unitId: UNIT,
    role: 'RN',
    acuityTierId: tier,
    maxPatientsPerNurse: max,
    active: true,
  };
}

function overtime(basis: OvertimeRule['basis'], thresholdHours: number, multiplier: number) {
  return {
    id: `ot-${basis}-${thresholdHours}`,
    unitId: UNIT,
    basis,
    thresholdHours,
    multiplier,
    active: true,
  };
}

function input(overrides: Partial<JurisdictionPlanInput> = {}): JurisdictionPlanInput {
  return {
    unitType: 'Medical-Surgical',
    ratioRules: [],
    overtimeRules: [],
    ruleSet: defaultRuleSet(UNIT),
    ...overrides,
  };
}

describe('applying a state preset', () => {
  it('gives a California med-surg unit a 1:5 ceiling and the Labor Code overtime', () => {
    const plan = planJurisdiction('CA', input());
    expect(plan.addRatioRules).toEqual([
      expect.objectContaining({ role: 'RN', acuityTierId: null, maxPatientsPerNurse: 5 }),
    ]);
    expect(plan.addRatioRules[0]!.citation).toContain('70217(a)(11)');
    expect(
      plan.addOvertimeRules.map((r) => `${r.basis} ${r.thresholdHours} ${r.multiplier}`),
    ).toEqual([
      'daily 8 1.5',
      'daily 12 2',
      'weekly 40 1.5',
      'seventh_day 0 1.5',
      'seventh_day 8 2',
    ]);
    expect(plan.ratioStaffing).toEqual({
      chargeNurseTakesPatients: false,
      breakMinutesPerNurse: 60,
      chargeCoversBreaks: true,
    });
  });

  it('lowers a looser catch-all ratio to the legal ceiling instead of adding a second', () => {
    const plan = planJurisdiction('CA', input({ ratioRules: [ratio('r1', 6)] }));
    expect(plan.addRatioRules).toEqual([]);
    expect(plan.tightenRatioRules).toEqual([{ id: 'r1', maxPatientsPerNurse: 5 }]);
  });

  it('leaves a stricter ratio and a stricter tier rule alone', () => {
    const plan = planJurisdiction(
      'CA',
      input({ ratioRules: [ratio('r1', 4), ratio('r2', 3, 'tier-high')] }),
    );
    expect(plan.addRatioRules).toEqual([]);
    expect(plan.tightenRatioRules).toEqual([]);
  });

  it('sets no ratio for a unit type the law does not name', () => {
    const plan = planJurisdiction('CA', input({ unitType: 'Oncology clinic' }));
    expect(plan.addRatioRules).toEqual([]);
  });

  it('gives an Oregon med-surg unit the 1:4 that applies from July 2026', () => {
    const plan = planJurisdiction('OR', input());
    expect(plan.addRatioRules[0]).toMatchObject({ maxPatientsPerNurse: 4 });
    expect(plan.addRatioRules[0]!.citation).toContain('ORS 441.765');
  });

  it('switches on the ban on mandatory overtime in New York, and only switches rules on', () => {
    const plan = planJurisdiction('NY', input());
    const config = plan.ruleConfigs?.find((c) => c.ruleId === 'no-mandatory-overtime');
    expect(config?.enabled).toBe(true);
    // Everything else is as it was.
    const others = (plan.ruleConfigs ?? []).filter((c) => c.ruleId !== 'no-mandatory-overtime');
    expect(others).toEqual(
      defaultRuleSet(UNIT).configs.filter((c) => c.ruleId !== 'no-mandatory-overtime'),
    );
  });

  it('keeps a stricter ratio setting the unit already has', () => {
    // Already free of patients, with more break time and no charge relief than the preset: the
    // preset has nothing to tighten.
    const plan = planJurisdiction(
      'CA',
      input({
        ratioStaffing: {
          chargeNurseTakesPatients: false,
          breakMinutesPerNurse: 75,
          chargeCoversBreaks: false,
        },
      }),
    );
    expect(plan.ratioStaffing).toBeUndefined();
  });

  it('changes nothing the second time', () => {
    const first = planJurisdiction('CA', input());
    const second = planJurisdiction(
      'CA',
      input({
        ratioRules: first.addRatioRules.map((r, i) => ({ ...r, id: `r${i}`, unitId: UNIT })),
        overtimeRules: first.addOvertimeRules.map((r) =>
          overtime(r.basis, r.thresholdHours, r.multiplier),
        ),
        ...(first.ratioStaffing ? { ratioStaffing: first.ratioStaffing } : {}),
      }),
    );
    expect(second.addRatioRules).toEqual([]);
    expect(second.tightenRatioRules).toEqual([]);
    expect(second.addOvertimeRules).toEqual([]);
    expect(second.ratioStaffing).toBeUndefined();
    expect(second.ruleConfigs).toBeUndefined();
  });

  it('asks nothing of a unit in another state', () => {
    expect(planJurisdiction('other', input())).toEqual({
      addRatioRules: [],
      tightenRatioRules: [],
      addOvertimeRules: [],
    });
  });
});
