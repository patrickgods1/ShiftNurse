import { describe, expect, it } from 'vitest';
import { DEFAULT_LEAVE_POLICY, type OvertimeRule, type RatioRule } from '../domain/entities.js';
import { defaultRuleSet } from '../rules/registry.js';
import type { RuleSet } from '../rules/types.js';
import {
  JURISDICTION_PRESETS,
  type JurisdictionPlanInput,
  planJurisdiction,
} from './jurisdictions.js';

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

  describe('the federal VA preset', () => {
    const NMO = 'no-mandatory-overtime';

    /** The default rule set with no-mandatory-overtime switched as given. */
    function withNmo(enabled: boolean, params?: Record<string, unknown>): RuleSet {
      const base = defaultRuleSet(UNIT);
      return {
        ...base,
        configs: base.configs.map((c) =>
          c.ruleId === NMO ? { ...c, enabled, params: { ...c.params, ...(params ?? {}) } } : c,
        ),
      };
    }

    function nmoOf(plan: ReturnType<typeof planJurisdiction>) {
      return plan.ruleConfigs?.find((c) => c.ruleId === NMO);
    }

    it('gives a VA unit the federal cap on required hours, not California’s ratios', () => {
      const plan = planJurisdiction('US-VA', input());
      expect(plan.addRatioRules).toEqual([]);
      expect(plan.tightenRatioRules).toEqual([]);
      expect(plan.addOvertimeRules).toEqual([]);
      expect(plan.ratioStaffing).toBeUndefined();
      expect(nmoOf(plan)).toMatchObject({ enabled: true, params: { maxMandatedWeeklyHours: 40 } });
    });

    it('keeps a 24-hour weekend-plan cap the unit already set', () => {
      const plan = planJurisdiction(
        'US-VA',
        input({ ruleSet: withNmo(true, { maxMandatedWeeklyHours: 24 }) }),
      );
      expect(plan.ruleConfigs).toBeUndefined();
    });

    it('lowers a looser cap of 48 hours to the federal 40', () => {
      const plan = planJurisdiction(
        'US-VA',
        input({ ruleSet: withNmo(true, { maxMandatedWeeklyHours: 48 }) }),
      );
      expect(nmoOf(plan)?.params.maxMandatedWeeklyHours).toBe(40);
    });

    it('does not add a cap to a unit that already bans mandated overtime outright', () => {
      const plan = planJurisdiction('US-VA', input({ ruleSet: withNmo(true) }));
      expect(plan.ruleConfigs).toBeUndefined();
    });

    it('switches on a VA unit’s switched-off rule and keeps its 24-hour weekend-plan cap', () => {
      const plan = planJurisdiction(
        'US-VA',
        input({ ruleSet: withNmo(false, { maxMandatedWeeklyHours: 24 }) }),
      );
      expect(nmoOf(plan)).toMatchObject({ enabled: true, params: { maxMandatedWeeklyHours: 24 } });
    });

    it('switches on a VA unit’s switched-off rule and lowers a stored 48 to the federal 40', () => {
      const plan = planJurisdiction(
        'US-VA',
        input({ ruleSet: withNmo(false, { maxMandatedWeeklyHours: 48 }) }),
      );
      expect(nmoOf(plan)).toMatchObject({ enabled: true, params: { maxMandatedWeeklyHours: 40 } });
    });

    it('changes nothing the second time', () => {
      const first = planJurisdiction('US-VA', input());
      const second = planJurisdiction(
        'US-VA',
        input({ ruleSet: { ...defaultRuleSet(UNIT), configs: first.ruleConfigs ?? [] } }),
      );
      expect(second.ruleConfigs).toBeUndefined();
    });
  });
});

describe('proposing a leave policy', () => {
  it('proposes the VA policy whole to a unit that has none', () => {
    const plan = planJurisdiction('US-VA', input());
    expect(plan.leavePolicy).toBe(JURISDICTION_PRESETS['US-VA'].leavePolicy);
    expect(plan.leavePolicy?.fmla).toEqual({ regime: 'title5', yearMethod: 'rolling_forward' });
    expect(plan.leavePolicy?.leaveYearStart).toBe('first_full_pay_period');
  });

  it('gives full-time VA RNs 8 hours a pay period with a 685 hour ceiling, ahead of the LVN rule', () => {
    const rules = planJurisdiction('US-VA', input()).leavePolicy?.accrual ?? [];
    expect(rules[0]).toMatchObject({
      balanceType: 'annual',
      roles: ['RN'],
      employmentTypes: ['full_time'],
      tiers: [{ fromYearsOfService: 0, hoursPerPayPeriod: 8 }],
      carryoverCapHours: 685,
    });
    expect(rules[2]).toMatchObject({ roles: ['LPN', 'CNA'], carryoverCapHours: 240 });
  });

  it('proposes California’s sick leave, 1 hour per 30 worked up to 80, to a unit that has none', () => {
    const policy = planJurisdiction('CA', input()).leavePolicy;
    expect(policy?.leaveYearStart).toBe('calendar');
    expect(policy?.fmla).toEqual(DEFAULT_LEAVE_POLICY.fmla);
    expect(policy?.accrual).toEqual([
      expect.objectContaining({
        balanceType: 'sick',
        tiers: [{ fromYearsOfService: 0, hoursPerAccruedHour: 30 }],
        balanceCapHours: 80,
      }),
    ]);
  });

  it('leaves alone a policy the manager already set', () => {
    const own = { ...DEFAULT_LEAVE_POLICY, leaveYearStart: 'first_full_pay_period' as const };
    expect(planJurisdiction('US-VA', input({ leavePolicy: own })).leavePolicy).toBeUndefined();
    expect(planJurisdiction('CA', input({ leavePolicy: own })).leavePolicy).toBeUndefined();
  });

  it('proposes nothing the second time', () => {
    const first = planJurisdiction('US-VA', input());
    const second = planJurisdiction('US-VA', input({ leavePolicy: first.leavePolicy }));
    expect(second.leavePolicy).toBeUndefined();
  });

  it('proposes no policy for states whose preset has none', () => {
    expect(planJurisdiction('NY', input()).leavePolicy).toBeUndefined();
  });
});

describe('what the VA and California presets say about leave', () => {
  const sick = (hoursPerPayPeriod: number) => [{ fromYearsOfService: 0, hoursPerPayPeriod }];
  const VA_HANDBOOK = 'VA Handbook 5011 pt. III ch. 2 (38 U.S.C. § 7421)';

  it('lists all six VA accrual rules in order', () => {
    expect(JURISDICTION_PRESETS['US-VA'].leavePolicy?.accrual).toEqual([
      {
        balanceType: 'annual',
        roles: ['RN'],
        employmentTypes: ['full_time'],
        tiers: [{ fromYearsOfService: 0, hoursPerPayPeriod: 8 }],
        carryoverCapHours: 685,
        citation: `${VA_HANDBOOK}: 8 h a pay period, 685 h ceiling`,
      },
      {
        balanceType: 'annual',
        roles: ['RN'],
        employmentTypes: ['part_time'],
        tiers: [{ fromYearsOfService: 0, hoursPerAccruedHour: 10 }],
        carryoverCapHours: 240,
        citation: `${VA_HANDBOOK}: 1 h per 10 in pay status, 240 h ceiling`,
      },
      {
        balanceType: 'annual',
        roles: ['LPN', 'CNA'],
        employmentTypes: ['full_time'],
        tiers: [
          { fromYearsOfService: 0, hoursPerPayPeriod: 4 },
          { fromYearsOfService: 3, hoursPerPayPeriod: 6 },
          { fromYearsOfService: 15, hoursPerPayPeriod: 8 },
        ],
        carryoverCapHours: 240,
        citation: '5 U.S.C. §§ 6303(a), 6304(a)',
      },
      {
        balanceType: 'annual',
        roles: ['LPN', 'CNA'],
        employmentTypes: ['part_time'],
        tiers: [
          { fromYearsOfService: 0, hoursPerAccruedHour: 20 },
          { fromYearsOfService: 3, hoursPerAccruedHour: 13 },
          { fromYearsOfService: 15, hoursPerAccruedHour: 10 },
        ],
        carryoverCapHours: 240,
        citation: '5 U.S.C. §§ 6303(a), 6304(a)',
      },
      {
        balanceType: 'sick',
        employmentTypes: ['full_time'],
        tiers: sick(4),
        citation: '5 U.S.C. § 6307(a)',
      },
      {
        balanceType: 'sick',
        employmentTypes: ['part_time'],
        tiers: [{ fromYearsOfService: 0, hoursPerAccruedHour: 20 }],
        citation: '5 U.S.C. § 6307(b)',
      },
    ]);
  });

  it('lists California’s one sick-leave rule', () => {
    expect(JURISDICTION_PRESETS.CA.leavePolicy?.accrual).toEqual([
      {
        balanceType: 'sick',
        tiers: [{ fromYearsOfService: 0, hoursPerAccruedHour: 30 }],
        balanceCapHours: 80,
        citation: 'Lab. Code § 246(b) (SB 616, 2023): 1 h per 30 worked, cap 80 h',
      },
    ]);
  });

  it('cites a provision for every rule and says in its summary that it sets leave', () => {
    for (const id of ['US-VA', 'CA'] as const) {
      const preset = JURISDICTION_PRESETS[id];
      expect(preset.summary).toMatch(/leave/i);
      for (const rule of preset.leavePolicy?.accrual ?? []) {
        expect(rule.citation?.trim().length ?? 0).toBeGreaterThan(0);
      }
    }
  });
});
