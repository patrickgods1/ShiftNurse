import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LEAVE_POLICY,
  type Differential,
  type OvertimeRule,
  type RatioRule,
} from '../domain/entities.js';
import { defaultRuleSet } from '../rules/registry.js';
import type { RuleSet } from '../rules/types.js';
import {
  JURISDICTION_PRESETS,
  type JurisdictionChoices,
  type JurisdictionId,
  type JurisdictionPlanInput,
  planJurisdiction,
  protectedRuleChanges,
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
    differentials: [],
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
      addDifferentials: [],
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
      expect(plan.ratioStaffing).toBeUndefined();
      expect(nmoOf(plan)).toMatchObject({
        enabled: true,
        params: {
          maxMandatedWeeklyHours: 40,
          maxRequiredConsecutiveHours: 8,
          compressedTourConsecutiveHours: 12,
        },
      });
    });

    it('lowers a looser consecutive-hours limit to the federal 8, and 12 on a compressed tour', () => {
      const plan = planJurisdiction(
        'US-VA',
        input({
          ruleSet: withNmo(true, {
            maxMandatedWeeklyHours: 40,
            maxRequiredConsecutiveHours: 10,
            compressedTourConsecutiveHours: 16,
          }),
        }),
      );
      expect(nmoOf(plan)?.params).toMatchObject({
        maxRequiredConsecutiveHours: 8,
        compressedTourConsecutiveHours: 12,
      });
    });

    it('keeps a stricter consecutive-hours limit the unit already set', () => {
      const ruleSet = withNmo(true, {
        maxMandatedWeeklyHours: 40,
        maxRequiredConsecutiveHours: 6,
        compressedTourConsecutiveHours: 10,
      });
      const plan = planJurisdiction('US-VA', input({ ruleSet }));
      expect(nmoOf(plan)).toEqual(ruleSet.configs.find((c) => c.ruleId === NMO));
    });

    it('keeps a 24-hour weekend-plan cap the unit already set', () => {
      const ruleSet = withNmo(true, { maxMandatedWeeklyHours: 24 });
      const plan = planJurisdiction('US-VA', input({ ruleSet }));
      expect(nmoOf(plan)).toEqual(ruleSet.configs.find((c) => c.ruleId === NMO));
    });

    it('lowers a looser cap of 48 hours to the federal 40', () => {
      const plan = planJurisdiction(
        'US-VA',
        input({ ruleSet: withNmo(true, { maxMandatedWeeklyHours: 48 }) }),
      );
      expect(nmoOf(plan)?.params.maxMandatedWeeklyHours).toBe(40);
    });

    it('does not add a cap to a unit that already bans mandated overtime outright', () => {
      const ruleSet = withNmo(true);
      const plan = planJurisdiction('US-VA', input({ ruleSet }));
      expect(nmoOf(plan)).toEqual(ruleSet.configs.find((c) => c.ruleId === NMO));
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

describe('the full ratio tables', () => {
  function ceilingFor(id: 'CA' | 'OR', unitType: string) {
    const plan = planJurisdiction(id, input({ unitType }));
    return plan.addRatioRules[0];
  }

  it.each([
    ['Emergency Department', 4, '(8)'],
    ['Pediatrics', 4, '(6)'],
    ['PACU', 2, '(7)'],
    ['Psychiatric', 6, '(13)'],
    ['Oncology', 4, '(12)'],
    ['Burn unit', 2, '(1)'],
    ['NICU', 2, '(1)'],
    ['Operating room', 1, '(2)'],
  ])('gives a California %s unit 1:%i under § 70217(a)%s', (unitType, max, paragraph) => {
    const rule = ceilingFor('CA', unitType);
    expect(rule).toMatchObject({ role: 'RN', maxPatientsPerNurse: max, acuityTierId: null });
    expect(rule!.citation).toContain(`70217(a)${paragraph}`);
  });

  it.each([
    ['ED', 4],
    ['Intermediate care', 3],
    ['Oncology', 4],
    ['Pediatrics', 4],
    ['PACU', 2],
    ['Operating room', 1],
  ])('gives an Oregon %s unit the ORS 441.765 ceiling of 1:%i', (unitType, max) => {
    const rule = ceilingFor('OR', unitType);
    expect(rule).toMatchObject({ role: 'RN', maxPatientsPerNurse: max });
    expect(rule!.citation).toContain('ORS 441.765');
  });

  it('sets no Oregon ratio for a psychiatric unit, whose plan its committee adopts', () => {
    expect(ceilingFor('OR', 'Psychiatric')).toBeUndefined();
  });

  it('sets no ratio for labor and delivery, where the ceiling turns on whether she is in labor', () => {
    expect(ceilingFor('CA', 'Labor and delivery')).toBeUndefined();
    expect(ceilingFor('OR', 'Labor and delivery')).toBeUndefined();
  });

  it('still reads a step-down unit by its usual names in both states', () => {
    expect(ceilingFor('CA', 'PCU')).toMatchObject({ maxPatientsPerNurse: 3 });
    expect(ceilingFor('OR', 'Step-down')).toMatchObject({ maxPatientsPerNurse: 3 });
  });
});

/** Every preset with no answers, and again with every question it asks answered yes. */
function everyPresetAndAnswer(): [JurisdictionId, JurisdictionChoices][] {
  return (Object.keys(JURISDICTION_PRESETS) as JurisdictionId[]).flatMap((id) => {
    const yes = Object.fromEntries(
      (JURISDICTION_PRESETS[id].options ?? []).map((o) => [o.id, true]),
    );
    return [
      [id, {}],
      [id, yes],
    ] as [JurisdictionId, JurisdictionChoices][];
  });
}

describe('the state mandatory-overtime presets', () => {
  const NMO = 'no-mandatory-overtime';
  const LONG = 'long-stretch';

  function configOf(id: Parameters<typeof planJurisdiction>[0], ruleId: string, ruleSet?: RuleSet) {
    const plan = planJurisdiction(id, input(ruleSet ? { ruleSet } : {}));
    return plan.ruleConfigs?.find((c) => c.ruleId === ruleId);
  }

  function withRule(ruleId: string, enabled: boolean, params: Record<string, unknown>): RuleSet {
    const base = defaultRuleSet(UNIT);
    return {
      ...base,
      configs: base.configs.map((c) =>
        c.ruleId === ruleId ? { ...c, enabled, params: { ...c.params, ...params } } : c,
      ),
    };
  }

  it('bans required overtime in Illinois and caps even an emergency at 4 hours past the shift', () => {
    expect(configOf('IL', NMO)).toMatchObject({
      enabled: true,
      params: { emergencyMaxHoursPastShift: 4 },
    });
    expect(configOf('IL', LONG)).toMatchObject({
      enabled: true,
      params: { requiredOnly: true, restAfterHours: 12, restHours: 8 },
    });
  });

  it('bans required overtime in Connecticut, New Jersey and Texas without a numeric cap', () => {
    for (const id of ['CT', 'NJ', 'TX'] as const) {
      const nmo = configOf(id, NMO);
      expect(nmo?.enabled).toBe(true);
      expect(nmo?.params.maxMandatedWeeklyHours).toBeUndefined();
      expect(configOf(id, LONG)?.enabled).toBe(false);
    }
  });

  it('switches nothing on in Minnesota, whose law only protects a nurse who declines', () => {
    const plan = planJurisdiction('MN', input());
    expect(plan.ruleConfigs).toBeUndefined();
    expect(JURISDICTION_PRESETS.MN.summary).toContain('181.275');
  });

  it('lets Maine and New Hampshire mandate, but not past 12 straight hours, then wants rest', () => {
    expect(configOf('ME', NMO)?.enabled).toBe(false);
    expect(configOf('NH', NMO)?.enabled).toBe(false);
    expect(configOf('ME', LONG)?.params).toMatchObject({
      requiredOnly: true,
      maxConsecutiveHours: 12,
      emergencyLiftsCap: true,
      restAfterHours: 12,
      restOnlyPastThreshold: true,
      restHours: 10,
    });
    expect(configOf('NH', LONG)?.params).toMatchObject({
      requiredOnly: true,
      maxConsecutiveHours: 12,
      restAfterHours: 12,
      restOnlyPastThreshold: true,
      restHours: 8,
    });
  });

  it('gives Pennsylvania 10 hours off after more than 12 straight, volunteered or not, and waivable', () => {
    expect(configOf('PA', NMO)?.enabled).toBe(true);
    expect(configOf('PA', LONG)?.params).toMatchObject({
      requiredOnly: false,
      restAfterHours: 12,
      restOnlyPastThreshold: true,
      restHours: 10,
      honorsRestWaiver: true,
    });
    expect(configOf('PA', LONG)?.params.maxConsecutiveHours).toBeUndefined();
  });

  it('caps a required Rhode Island stretch at 12 hours even in an emergency', () => {
    expect(configOf('RI', NMO)?.params).toMatchObject({ emergencyMaxConsecutiveHours: 12 });
  });

  it('holds West Virginia nurses to 16 hours in 24 and 8 off after 12 or more', () => {
    expect(configOf('WV', 'max-hours-in-24')).toMatchObject({
      enabled: true,
      params: { maxHours: 16 },
    });
    expect(configOf('WV', LONG)?.params).toMatchObject({
      requiredOnly: false,
      restAfterHours: 12,
      restOnlyPastThreshold: false,
      restHours: 8,
    });
  });

  it('limits Alaska nurses to 14 straight hours, volunteered or not', () => {
    expect(configOf('AK', NMO)?.enabled).toBe(true);
    expect(configOf('AK', LONG)?.params).toMatchObject({
      requiredOnly: false,
      maxConsecutiveHours: 14,
      emergencyLiftsCap: true,
    });
  });

  it('raises a shorter minimum rest to the 10 hours Alaska gives after a shift', () => {
    const plan = planJurisdiction(
      'AK',
      input({ ruleSet: withRule('min-rest-between-shifts', true, { minRestHours: 8 }) }),
    );
    const rest = plan.ruleConfigs?.find((c) => c.ruleId === 'min-rest-between-shifts');
    expect(rest?.params.minRestHours).toBe(10);
  });

  it('never lets a Massachusetts nurse pass 16 straight hours, then gives 8 off', () => {
    expect(configOf('MA', LONG)?.params).toMatchObject({
      requiredOnly: false,
      maxConsecutiveHours: 16,
      emergencyLiftsCap: false,
      restAfterHours: 16,
      restHours: 8,
    });
  });

  it('adds a cap to a long-stretch rule the unit has on without one', () => {
    const params = configOf(
      'MA',
      LONG,
      withRule(LONG, true, { restAfterHours: 16, restHours: 8 }),
    )?.params;
    expect(params?.maxConsecutiveHours).toBe(16);
  });

  it('raises a shorter rest after a long stretch, and keeps a longer one', () => {
    const shorter = configOf(
      'PA',
      LONG,
      withRule(LONG, true, { restAfterHours: 12, restOnlyPastThreshold: true, restHours: 8 }),
    );
    expect(shorter?.params.restHours).toBe(10);
    const longer = configOf(
      'PA',
      LONG,
      withRule(LONG, true, { restAfterHours: 12, restOnlyPastThreshold: true, restHours: 11 }),
    );
    expect(longer?.params.restHours).toBe(11);
  });

  it('changes nothing the second time, for every preset and every answer', () => {
    for (const [id, choices] of everyPresetAndAnswer()) {
      const first = planJurisdiction(id, input(), choices);
      const second = planJurisdiction(
        id,
        input({
          ruleSet: {
            ...defaultRuleSet(UNIT),
            configs: first.ruleConfigs ?? defaultRuleSet(UNIT).configs,
          },
          ratioRules: first.addRatioRules.map((r, i) => ({ ...r, id: `r${i}`, unitId: UNIT })),
          overtimeRules: first.addOvertimeRules.map((r, i) => ({
            ...r,
            id: `ot${i}`,
            unitId: UNIT,
          })),
          ...(first.ratioStaffing ? { ratioStaffing: first.ratioStaffing } : {}),
          differentials: first.addDifferentials.map((d, i) => ({
            ...d,
            id: `d${i}`,
            unitId: UNIT,
          })),
          ...first.unit,
        }),
        choices,
      );
      expect(second.ruleConfigs, id).toBeUndefined();
      expect(second.addRatioRules, id).toEqual([]);
      expect(second.addOvertimeRules, id).toEqual([]);
      expect(second.addDifferentials, id).toEqual([]);
      expect(second.unit, id).toBeUndefined();
    }
  });

  it('only switches rules on, for every preset and every answer', () => {
    for (const [id, choices] of everyPresetAndAnswer()) {
      const plan = planJurisdiction(id, input(), choices);
      const before = defaultRuleSet(UNIT).configs;
      for (const c of plan.ruleConfigs ?? []) {
        const was = before.find((b) => b.ruleId === c.ruleId);
        if (was?.enabled) expect(c.enabled, `${id} ${c.ruleId}`).toBe(true);
      }
    }
  });
});

describe('what the VA preset brings from Title 38 and the national contract', () => {
  const brief = (r: { basis: string; thresholdHours: number; multiplier: number }) =>
    `${r.basis} ${r.thresholdHours} ${r.multiplier}`;
  const configOf = (plan: ReturnType<typeof planJurisdiction>, ruleId: string) =>
    plan.ruleConfigs?.find((c) => c.ruleId === ruleId);

  function differential(kind: Differential['kind'], amount: number): Differential {
    return { id: `d-${kind}`, unitId: UNIT, kind, mode: 'flat', amount, active: true };
  }

  it('pays overtime past 40 a week and 8 straight hours, but not under 15 minutes', () => {
    const plan = planJurisdiction('US-VA', input());
    expect(plan.addOvertimeRules.filter((r) => !r.scheduleKinds)).toEqual([
      { basis: 'weekly', thresholdHours: 40, multiplier: 1.5, minimumMinutes: 15, active: true },
      {
        basis: 'consecutive',
        thresholdHours: 8,
        multiplier: 1.5,
        minimumMinutes: 15,
        active: true,
      },
    ]);
  });

  it('adds the 72/80 and Baylor plans’ own overtime for nurses marked with those kinds', () => {
    const scoped = planJurisdiction('US-VA', input()).addOvertimeRules.filter(
      (r) => r.scheduleKinds,
    );
    expect(scoped).toEqual([
      {
        basis: 'weekly',
        thresholdHours: 36,
        multiplier: 1.5,
        minimumMinutes: 15,
        scheduleKinds: ['va_72_80'],
        active: true,
      },
      {
        basis: 'daily',
        thresholdHours: 12,
        tourDays: 'only',
        multiplier: 1.5,
        minimumMinutes: 15,
        scheduleKinds: ['va_72_80'],
        active: true,
      },
      {
        basis: 'daily',
        thresholdHours: 8,
        tourDays: 'except',
        multiplier: 1.5,
        minimumMinutes: 15,
        scheduleKinds: ['va_72_80'],
        active: true,
      },
      {
        basis: 'weekly',
        thresholdHours: 40,
        multiplier: 1.5,
        minimumMinutes: 15,
        scheduleKinds: ['va_baylor'],
        active: true,
      },
      {
        basis: 'beyond_scheduled_tour',
        thresholdHours: 0,
        multiplier: 1.5,
        minimumMinutes: 15,
        scheduleKinds: ['va_baylor'],
        active: true,
      },
    ]);
  });

  it('still gives the Baylor plan its weekly 40 when the unit already pays an unscoped one', () => {
    const plan = planJurisdiction('US-VA', input({ overtimeRules: [overtime('weekly', 40, 1.5)] }));
    expect(plan.addOvertimeRules.map((r) => `${brief(r)} ${r.scheduleKinds ?? ''}`)).toContain(
      'weekly 40 1.5 va_baylor',
    );
    expect(plan.addOvertimeRules.filter((r) => r.basis === 'weekly' && !r.scheduleKinds)).toEqual(
      [],
    );
  });

  it('counts a rule scoped to the same kinds in another order as already there', () => {
    const preset = JURISDICTION_PRESETS['US-VA'];
    const original = preset.overtimeRules;
    (preset as { overtimeRules: unknown }).overtimeRules = [
      {
        basis: 'weekly',
        thresholdHours: 50,
        multiplier: 1.5,
        scheduleKinds: ['va_72_80', 'va_baylor'],
      },
    ];
    try {
      const existing = {
        ...overtime('weekly', 50, 1.5),
        scheduleKinds: ['va_baylor', 'va_72_80'] as ('va_baylor' | 'va_72_80')[],
      };
      expect(
        planJurisdiction('US-VA', input({ overtimeRules: [existing] })).addOvertimeRules,
      ).toEqual([]);
    } finally {
      (preset as { overtimeRules: unknown }).overtimeRules = original;
    }
  });

  it('does not count a rule scoped to standard nurses as the unscoped weekly 40', () => {
    const existing = { ...overtime('weekly', 40, 1.5), scheduleKinds: ['standard' as const] };
    const added = planJurisdiction('US-VA', input({ overtimeRules: [existing] })).addOvertimeRules;
    expect(
      added.some((r) => r.basis === 'weekly' && r.thresholdHours === 40 && !r.scheduleKinds),
    ).toBe(true);
  });

  it('does not count a daily 12 on every day as the daily 12 on tour days only', () => {
    const added = planJurisdiction(
      'US-VA',
      input({ overtimeRules: [overtime('daily', 12, 1.5)] }),
    ).addOvertimeRules;
    expect(added.some((r) => r.basis === 'daily' && r.tourDays === 'only')).toBe(true);
  });

  it('sets the Baylor plan’s 24-hour cap on required hours', () => {
    const plan = planJurisdiction('US-VA', input());
    expect(configOf(plan, 'no-mandatory-overtime')?.params).toMatchObject({
      baylorMaxMandatedWeeklyHours: 24,
    });
  });

  it('adds the night, weekend and holiday premiums of § 7453', () => {
    const plan = planJurisdiction('US-VA', input());
    expect(plan.addDifferentials).toEqual([
      {
        kind: 'night',
        mode: 'multiplier',
        amount: 1.1,
        active: true,
        window: { startTime: '18:00', endTime: '06:00', wholeShiftAtHours: 4 },
      },
      { kind: 'weekend', mode: 'multiplier', amount: 1.25, active: true },
      { kind: 'holiday', mode: 'multiplier', amount: 2, active: true },
    ]);
  });

  it('posts four weeks ahead and calls overtime from the rosters', () => {
    expect(planJurisdiction('US-VA', input()).unit).toEqual({
      postingLeadDays: 28,
      overtimeOrder: 'roster',
    });
  });

  it('gives 11 hours between tours and switches on the weekend, tour and stretch limits', () => {
    const plan = planJurisdiction('US-VA', input());
    expect(configOf(plan, 'min-rest-between-shifts')).toMatchObject({
      enabled: true,
      params: { minRestHours: 11 },
    });
    expect(configOf(plan, 'weekend-pattern')?.enabled).toBe(true);
    expect(configOf(plan, 'tour-rotation')).toMatchObject({
      enabled: true,
      params: { maxToursPerPeriod: 2 },
    });
    expect(configOf(plan, 'max-consecutive-shifts')).toMatchObject({
      enabled: true,
      params: { maxConsecutiveShifts: 5 },
    });
  });

  it('pays a compressed tour overtime past the scheduled tour and past 80 in the pay period', () => {
    const plan = planJurisdiction('US-VA', input(), { compressedTour: true });
    expect(plan.addOvertimeRules.filter((r) => !r.scheduleKinds).map(brief)).toEqual([
      'beyond_scheduled_tour 0 1.5',
      'pay_period 80 1.5',
    ]);
    expect(plan.addOvertimeRules.every((r) => r.minimumMinutes === 15)).toBe(true);
  });

  it('adds only the weekend and holiday premiums to a unit that already pays a night one', () => {
    const plan = planJurisdiction('US-VA', input({ differentials: [differential('night', 3)] }));
    expect(plan.addDifferentials.map((d) => d.kind)).toEqual(['weekend', 'holiday']);
  });

  it('keeps a longer posting notice and a cost-first overtime order the unit already chose', () => {
    expect(planJurisdiction('US-VA', input({ postingLeadDays: 30 })).unit).toEqual({
      overtimeOrder: 'roster',
    });
    expect(planJurisdiction('US-VA', input({ overtimeOrder: 'cost' })).unit).toEqual({
      postingLeadDays: 28,
    });
  });

  it('raises a two-week posting notice to four', () => {
    expect(
      planJurisdiction('US-VA', input({ postingLeadDays: 14, overtimeOrder: 'roster' })).unit,
    ).toEqual({ postingLeadDays: 28 });
  });
});

describe('the California alternative workweek', () => {
  const brief = (r: { basis: string; thresholdHours: number; multiplier: number }) =>
    `${r.basis} ${r.thresholdHours} ${r.multiplier}`;

  it('drops daily overtime past 8 and pays double past 8 on an extra day', () => {
    const plan = planJurisdiction('CA', input(), { alternativeWorkweek: true });
    expect(plan.addOvertimeRules.map(brief)).toEqual([
      'beyond_scheduled_days 8 2',
      'daily 12 2',
      'weekly 40 1.5',
      'seventh_day 0 1.5',
      'seventh_day 8 2',
    ]);
  });

  it('does not count hours paid at a daily premium again toward the weekly 40', () => {
    const plan = planJurisdiction('CA', input(), { alternativeWorkweek: true });
    expect(plan.addOvertimeRules.find((r) => r.basis === 'weekly')?.pyramiding).toBe('none');
  });

  it('caps required hours at 12 in 24, and 13 when the relief nurse does not come', () => {
    const plan = planJurisdiction('CA', input(), { alternativeWorkweek: true });
    expect(plan.ruleConfigs?.find((c) => c.ruleId === 'no-mandatory-overtime')).toMatchObject({
      enabled: true,
      params: { maxRequiredConsecutiveHours: 12, emergencyMaxHoursPastShift: 1 },
    });
  });

  it('keeps daily overtime past 8 and switches no rule on for an ordinary workweek', () => {
    const plan = planJurisdiction('CA', input());
    expect(plan.addOvertimeRules.map(brief)).toContain('daily 8 1.5');
    expect(plan.addOvertimeRules.map(brief)).not.toContain('beyond_scheduled_days 8 2');
    expect(plan.addOvertimeRules.find((r) => r.basis === 'weekly')).toMatchObject({
      thresholdHours: 40,
      multiplier: 1.5,
      pyramiding: 'none',
    });
    expect(plan.ruleConfigs).toBeUndefined();
  });

  it('leaves a weekly overtime rule the unit already pays as it is, without adding a second', () => {
    const plan = planJurisdiction('CA', input({ overtimeRules: [overtime('weekly', 40, 1.5)] }));
    expect(plan.addOvertimeRules.filter((r) => r.basis === 'weekly')).toEqual([]);
  });
});

describe('protecting what the law put in force', () => {
  const RATIO = 'patient-ratio-compliance';

  function configs(change: (c: RuleSet['configs'][number]) => RuleSet['configs'][number]) {
    return defaultRuleSet(UNIT).configs.map(change);
  }
  const enable = (ids: string[]) =>
    configs((c) => (ids.includes(c.ruleId) ? { ...c, enabled: true } : c));

  it('names the ban on mandatory overtime when a VA unit switches it off', () => {
    const before = enable(['no-mandatory-overtime']);
    const after = before.map((c) =>
      c.ruleId === 'no-mandatory-overtime' ? { ...c, enabled: false } : c,
    );
    expect(protectedRuleChanges(before, after, 'US-VA')).toEqual([
      { ruleId: 'no-mandatory-overtime', change: 'disabled' },
    ]);
  });

  it('names the ratio rule made advisory, whatever the state', () => {
    const before = configs((c) => c);
    const after = before.map((c) =>
      c.ruleId === RATIO ? { ...c, severityOverride: 'soft' as const } : c,
    );
    expect(protectedRuleChanges(before, after, undefined)).toEqual([
      { ruleId: RATIO, change: 'softened' },
    ]);
  });

  it('lets a manager switch off a rule the preset never switched on', () => {
    const before = enable(['long-stretch']);
    const after = before.map((c) => (c.ruleId === 'long-stretch' ? { ...c, enabled: false } : c));
    expect(protectedRuleChanges(before, after, 'US-VA')).toEqual([]);
  });

  it('does not count a rule that was already advisory as softened', () => {
    const before = enable(['weekend-pattern']);
    const after = before.map((c) =>
      c.ruleId === 'weekend-pattern' ? { ...c, severityOverride: 'soft' as const } : c,
    );
    expect(protectedRuleChanges(before, after, 'US-VA')).toEqual([]);
  });
});
