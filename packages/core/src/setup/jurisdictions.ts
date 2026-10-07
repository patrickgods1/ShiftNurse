/**
 * What a state's nurse staffing and overtime law asks of a unit, as settings a manager can apply
 * in one step. Each value cites the provision it comes from, checked against the text of the
 * statute or regulation (October 2026); the summaries say what is left to the hospital, because a
 * preset that overstated the law would be worse than none.
 *
 * Federal employers are the exception to "a state's law": the VA preset sets the Title 38 cap on
 * required hours and leaves ratios and pay to the manager, because HPPD and the § 7453 premiums
 * are not ratios or overtime rules the preset can state.
 *
 * A preset may also carry a leave policy: the FMLA regime, the leave year and the accrual rules
 * that project balances forward (`leave/accrual.ts`). It is proposed whole, and only to a unit
 * with none, because a preset never overwrites a policy a manager chose.
 *
 * Presets only tighten. A ratio arrives as a catch-all RN rule at the legal ceiling, which
 * `bindingRatio` combines with any stricter tier rule the unit already has; overtime rules are
 * added if missing; a rule is switched on, never off, and a cap parameter only lowers. Applying
 * one twice changes nothing.
 *
 * Not legal advice, and not complete: a unit's contract usually goes further, and some of each
 * law (Oregon's staffing-plan deviations, the hours caps in ORS 441.166 and c.111 § 226) is
 * stated in the summary rather than enforced (as are the VA's § 7456 24-hour weekend-plan cap and
 * its pay premiums).
 */

import {
  DEFAULT_LEAVE_POLICY,
  type LeavePolicy,
  type NurseRole,
  type OvertimeRule,
  type RatioRule,
  type RatioStaffing,
  type Unit,
} from '../domain/entities.js';
import { resolveConfigs } from '../rules/registry.js';
import type { RuleConfig, RuleSet } from '../rules/types.js';
import { type AcuityPresetId, acuityPresetForUnitType } from './presets.js';

export type JurisdictionId = 'CA' | 'OR' | 'NY' | 'WA' | 'MA' | 'US-VA' | 'other';

export interface JurisdictionRatio {
  role: NurseRole;
  /** The legal ceiling: patients per nurse, at all times. */
  maxPatientsPerNurse: number;
  citation: string;
}

export interface JurisdictionPreset {
  label: string;
  /** What applying it does and what it leaves to the hospital, for the manager to read first. */
  summary: string;
  ratioStaffing?: RatioStaffing;
  /** Ceilings by the unit types the acuity presets know; other unit types get none. */
  ratios: Partial<Record<AcuityPresetId, JurisdictionRatio>>;
  overtimeRules: readonly Pick<OvertimeRule, 'basis' | 'thresholdHours' | 'multiplier'>[];
  /**
   * Rule ids switched on (with these parameters, if any). A numeric parameter is a cap: it only
   * ever lowers one the unit has, and never adds one to an enabled rule that has none, because
   * an unset cap on no-mandatory-overtime is a total ban, stricter than any number.
   */
  enableRules: readonly { ruleId: string; params?: Record<string, unknown> }[];
  /** Proposed whole to a unit with no leave policy; never merged into one a manager set. */
  leavePolicy?: LeavePolicy;
}

const TITLE_22 = 'Cal. Code Regs. tit. 22 § 70217(a)';
const ORS_441_765 = 'ORS 441.765 (HB 2697, 2023)';

function rn(maxPatientsPerNurse: number, citation: string): JurisdictionRatio {
  return { role: 'RN', maxPatientsPerNurse, citation };
}

const VA_HANDBOOK = 'VA Handbook 5011 pt. III ch. 2 (38 U.S.C. § 7421)';
const TITLE_5_ANNUAL = '5 U.S.C. §§ 6303(a), 6304(a)';

const NO_MANDATORY_OVERTIME = { ruleId: 'no-mandatory-overtime' } as const;

export const JURISDICTION_PRESETS: Record<JurisdictionId, JurisdictionPreset> = {
  CA: {
    label: 'California',
    summary:
      'Title 22 ratios at all times, with the charge nurse counted only while caring for ' +
      'patients and relieving for breaks (§ 70217(a)); an hour of breaks per nurse on a 12-hour ' +
      'shift (a 30-minute meal and three 10-minute rests). Labor Code § 510 overtime: past 8 ' +
      'hours a workday at 1.5×, past 12 at 2×, past 40 a week at 1.5×, and the seventh day in a ' +
      'row. A unit on a health-care alternative workweek (IWC Order 5 § 3(B)(8)) should remove ' +
      'the 8-hour daily rule. Ratios here count RNs only; Title 22 lets LVNs fill up to half. ' +
      'Sick leave accrues at 1 hour per 30 worked, up to 80 (Lab. Code § 246(b)): the statutory ' +
      'minimum, which a hospital PTO plan that meets it can replace.',
    ratioStaffing: {
      chargeNurseTakesPatients: false,
      breakMinutesPerNurse: 60,
      chargeCoversBreaks: true,
    },
    ratios: {
      'med-surg': rn(5, `${TITLE_22}(11): medical/surgical 1:5`),
      telemetry: rn(4, `${TITLE_22}(10): telemetry 1:4`),
      'step-down': rn(3, `${TITLE_22}(9): step-down 1:3`),
      icu: rn(2, `${TITLE_22}(1): critical care 1:2`),
    },
    overtimeRules: [
      { basis: 'daily', thresholdHours: 8, multiplier: 1.5 },
      { basis: 'daily', thresholdHours: 12, multiplier: 2 },
      { basis: 'weekly', thresholdHours: 40, multiplier: 1.5 },
      { basis: 'seventh_day', thresholdHours: 0, multiplier: 1.5 },
      { basis: 'seventh_day', thresholdHours: 8, multiplier: 2 },
    ],
    enableRules: [],
    leavePolicy: {
      fmla: DEFAULT_LEAVE_POLICY.fmla,
      leaveYearStart: 'calendar',
      accrual: [
        {
          balanceType: 'sick',
          tiers: [{ fromYearsOfService: 0, hoursPerAccruedHour: 30 }],
          balanceCapHours: 80,
          citation: 'Lab. Code § 246(b) (SB 616, 2023): 1 h per 30 worked, cap 80 h',
        },
      ],
    },
  },
  OR: {
    label: 'Oregon',
    summary:
      'ORS 441.765 direct-care RN ratios (medical-surgical 1:4 from 1 July 2026, telemetry 1:4, ' +
      'ICU 1:2), with the charge nurse free of patients outside units of 10 beds or fewer; no ' +
      'mandatory overtime past the agreed shift (ORS 441.166). A unit of 10 beds or fewer, whose ' +
      'charge nurse may take patients, should tick that back on under Settings › Unit. The staffing ' +
      'plan, its permitted deviations and the 12-hour and 48-hour caps of ORS 441.166 are not ' +
      'enforced here.',
    ratioStaffing: {
      chargeNurseTakesPatients: false,
      breakMinutesPerNurse: 0,
      chargeCoversBreaks: false,
    },
    ratios: {
      'med-surg': rn(4, `${ORS_441_765}: medical-surgical 1:4 from 2026-07-01`),
      telemetry: rn(4, `${ORS_441_765}: cardiac telemetry 1:4`),
      icu: rn(2, `${ORS_441_765}: intensive care 1:2`),
    },
    overtimeRules: [],
    enableRules: [NO_MANDATORY_OVERTIME],
  },
  NY: {
    label: 'New York',
    summary:
      'No mandatory overtime for RNs and LPNs beyond regularly scheduled hours (Labor Law § 167), ' +
      'outside a declared emergency, a patient-care emergency after voluntary cover was tried, or ' +
      'an ongoing procedure. Record those on the shift as "Emergency: …".',
    ratios: {},
    overtimeRules: [],
    enableRules: [NO_MANDATORY_OVERTIME],
  },
  WA: {
    label: 'Washington',
    summary:
      'No mandatory overtime in health care facilities (RCW 49.28.140), outside an unforeseeable ' +
      'emergency, prescheduled on-call time, documented efforts to staff, or a procedure in ' +
      'progress. Record those on the shift as "Emergency: …".',
    ratios: {},
    overtimeRules: [],
    enableRules: [NO_MANDATORY_OVERTIME],
  },
  MA: {
    label: 'Massachusetts',
    summary:
      'ICU nurses at 1:1 or 1:2 by the hospital’s acuity tool (M.G.L. c.111 § 231): 1:2 is set ' +
      'as the ceiling, and 1:1 patients belong in an acuity tier with a 1:1 ratio. No mandatory ' +
      'overtime outside an emergency (§ 226); its 16-hour cap is not enforced here.',
    ratios: {
      icu: rn(2, 'M.G.L. c.111 § 231: intensive care 1:2, or 1:1 by acuity'),
    },
    overtimeRules: [],
    enableRules: [NO_MANDATORY_OVERTIME],
  },
  'US-VA': {
    label: 'Federal — VA (Title 38)',
    summary:
      'VA nursing staff are federal employees, so state staffing, overtime, meal-break and leave ' +
      'laws (California’s Title 22 ratios, Labor Code daily overtime and CFRA, for example) do ' +
      'not bind them: the Supremacy Clause and intergovernmental immunity put the VA beyond ' +
      'state regulation. The VHA staffs to nursing hours per patient day set by expert panels ' +
      '(VHA Directive 1351), not fixed ratios, so no ratio is set. 38 U.S.C. § 7459 forbids ' +
      'requiring more than 40 hours in an administrative workweek (24 on the § 7456 weekend ' +
      'plan: lower the cap under Settings › Rules for such nurses); volunteers and emergencies ' +
      'recorded on the shift as "Emergency: …" are outside it. Pay premiums are set under ' +
      'Settings › Pay, not by this preset: 38 U.S.C. § 7453 gives a 10% night differential for ' +
      'the whole tour when at least 4 hours fall between 6 pm and 6 am, a 25% weekend premium ' +
      'for any tour touching Saturday or Sunday, double pay on holidays, and overtime past 40 ' +
      'hours a week or 8 consecutive hours (or past the scheduled tour on a compressed ' +
      'schedule). Contract terms such as 11 hours between tours or weekends off belong to the ' +
      'local agreement, not the preset. Contract nurses employed by an agency may still be ' +
      'covered by state law. The preset also sets the unit’s leave policy: Title 5 FMLA, a leave ' +
      'year from the first full pay period, RN annual leave at 8 hours a pay period (685-hour ' +
      'carryover; 1 per 10 in pay status, 240, for part-time), sick leave at 4 hours a pay ' +
      'period (1 per 20 for part-time). VA LVNs and nursing assistants (hybrid Title 38) earn ' +
      'Title 5 leave, and the 6-hour tier’s extra 10 hours in the leave year’s last pay period ' +
      'is not added.',
    ratios: {},
    overtimeRules: [],
    enableRules: [{ ruleId: 'no-mandatory-overtime', params: { maxMandatedWeeklyHours: 40 } }],
    leavePolicy: {
      fmla: { regime: 'title5', yearMethod: 'rolling_forward' },
      leaveYearStart: 'first_full_pay_period',
      accrual: [
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
          citation: TITLE_5_ANNUAL,
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
          citation: TITLE_5_ANNUAL,
        },
        {
          balanceType: 'sick',
          employmentTypes: ['full_time'],
          tiers: [{ fromYearsOfService: 0, hoursPerPayPeriod: 4 }],
          citation: '5 U.S.C. § 6307(a)',
        },
        {
          balanceType: 'sick',
          employmentTypes: ['part_time'],
          tiers: [{ fromYearsOfService: 0, hoursPerAccruedHour: 20 }],
          citation: '5 U.S.C. § 6307(b)',
        },
      ],
    },
  },
  other: {
    label: 'Another state',
    summary: 'No state preset: set ratios, overtime and rules from your contract.',
    ratios: {},
    overtimeRules: [],
    enableRules: [],
  },
};

/** What the unit has now, for planning what a preset would change. */
export interface JurisdictionPlanInput {
  unitType: string;
  ratioRules: readonly RatioRule[];
  overtimeRules: readonly OvertimeRule[];
  ruleSet: RuleSet;
  ratioStaffing?: Unit['ratioStaffing'];
  /** The unit's own leave policy, if it has set one. */
  leavePolicy?: LeavePolicy;
}

/** The changes a preset makes, each list empty and each field absent when there is nothing to do. */
export interface JurisdictionPlan {
  /** Catch-all RN rules at the legal ceiling, for a unit without one as strict. */
  addRatioRules: Omit<RatioRule, 'id' | 'unitId'>[];
  /** Catch-all rules looser than the ceiling, lowered to it. */
  tightenRatioRules: { id: string; maxPatientsPerNurse: number }[];
  addOvertimeRules: Omit<OvertimeRule, 'id' | 'unitId'>[];
  /** The unit's ratio staffing after the preset, when it changes. */
  ratioStaffing?: RatioStaffing;
  /** The whole rule set's configs with the preset's rules on, when any was off: a new version. */
  ruleConfigs?: RuleConfig[];
  /** The preset's leave policy, only for a unit that has none. */
  leavePolicy?: LeavePolicy;
}

/** The reading before a unit set anything: the charge nurse at the bedside, no break cover. */
const UNSET_STAFFING: RatioStaffing = {
  chargeNurseTakesPatients: true,
  breakMinutesPerNurse: 0,
  chargeCoversBreaks: false,
};

/**
 * What applying `id` would change. Only ever tightens: a ratio ceiling lowers a looser catch-all
 * rule or adds one, never loosens; break minutes only grow; a charge nurse kept free of patients
 * stays free; the charge nurse covering breaks (which lowers the relief count) is taken from the
 * preset only by a unit that has never set break minutes. Missing overtime rules are added and
 * rules are switched on. Running the plan's result through it again plans nothing.
 */
export function planJurisdiction(
  id: JurisdictionId,
  current: JurisdictionPlanInput,
): JurisdictionPlan {
  const preset = JURISDICTION_PRESETS[id];
  const plan: JurisdictionPlan = { addRatioRules: [], tightenRatioRules: [], addOvertimeRules: [] };

  const unitPreset = acuityPresetForUnitType(current.unitType);
  const ceiling = unitPreset === undefined ? undefined : preset.ratios[unitPreset];
  if (ceiling) {
    const catchAll = current.ratioRules.filter(
      (r) => r.active && r.role === ceiling.role && r.acuityTierId === null,
    );
    for (const r of catchAll) {
      if (r.maxPatientsPerNurse > ceiling.maxPatientsPerNurse) {
        plan.tightenRatioRules.push({ id: r.id, maxPatientsPerNurse: ceiling.maxPatientsPerNurse });
      }
    }
    if (catchAll.length === 0) {
      plan.addRatioRules.push({
        role: ceiling.role,
        acuityTierId: null,
        maxPatientsPerNurse: ceiling.maxPatientsPerNurse,
        citation: ceiling.citation,
        active: true,
      });
    }
  }

  for (const rule of preset.overtimeRules) {
    const present = current.overtimeRules.some(
      (r) =>
        r.active &&
        r.basis === rule.basis &&
        r.thresholdHours === rule.thresholdHours &&
        r.multiplier >= rule.multiplier,
    );
    if (!present) plan.addOvertimeRules.push({ ...rule, active: true });
  }

  if (preset.ratioStaffing) {
    const base = current.ratioStaffing ?? UNSET_STAFFING;
    const next: RatioStaffing = {
      chargeNurseTakesPatients:
        base.chargeNurseTakesPatients && preset.ratioStaffing.chargeNurseTakesPatients,
      breakMinutesPerNurse: Math.max(
        base.breakMinutesPerNurse,
        preset.ratioStaffing.breakMinutesPerNurse,
      ),
      chargeCoversBreaks:
        base.breakMinutesPerNurse > 0
          ? base.chargeCoversBreaks
          : preset.ratioStaffing.chargeCoversBreaks,
    };
    const changed =
      next.chargeNurseTakesPatients !== base.chargeNurseTakesPatients ||
      next.breakMinutesPerNurse !== base.breakMinutesPerNurse ||
      next.chargeCoversBreaks !== base.chargeCoversBreaks;
    if (changed) plan.ratioStaffing = next;
  }

  if (preset.enableRules.length > 0) {
    const configs = resolveConfigs(current.ruleSet);
    let changed = false;
    const next = configs.map((c) => {
      const wanted = preset.enableRules.find((e) => e.ruleId === c.ruleId);
      if (!wanted) return c;
      const params = { ...c.params };
      let touched = !c.enabled;
      for (const [key, value] of Object.entries(wanted.params ?? {})) {
        const have = params[key];
        if (typeof value !== 'number') {
          if (!c.enabled) params[key] = value;
        } else if (typeof have === 'number') {
          if (value < have) {
            params[key] = value;
            touched = true;
          }
        } else if (!c.enabled) {
          params[key] = value;
        }
      }
      if (!touched) return c;
      changed = true;
      return { ...c, enabled: true, params };
    });
    if (changed) plan.ruleConfigs = next;
  }

  if (preset.leavePolicy && current.leavePolicy === undefined)
    plan.leavePolicy = preset.leavePolicy;

  return plan;
}
