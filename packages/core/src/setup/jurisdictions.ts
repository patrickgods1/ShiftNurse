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
 * Most state overtime laws restrict only hours a nurse is *required* to work: Oregon's 48-a-week
 * and 12-in-24 limits, Connecticut's, Rhode Island's. Those ride on `no-mandatory-overtime`, which
 * refuses required overtime outright outside an emergency, so a cap on required hours below the
 * ban would add nothing. The few limits on *all* hours (Massachusetts' 16 consecutive, West
 * Virginia's 16 in 24, Alaska's 14 straight) and the rest owed after a long stretch go to
 * `long-stretch` and `max-hours-in-24`. A state whose law is only a right to refuse (Minnesota)
 * switches nothing on: encoding a ban it does not have would overstate it.
 *
 * Ratios are read by unit kind, which is wider than the acuity presets: Title 22 and ORS 441.765
 * name emergency, pediatric, psychiatric, oncology, recovery, operating-room and neonatal units.
 * Labor and delivery and postpartum are left out, because their ceiling turns on the patient
 * (in active labor or not, mother and baby counted apart) rather than the unit; a unit-wide
 * catch-all at the strictest figure would overstate the law for every other patient.
 *
 * Not legal advice, and not complete: a unit's contract usually goes further, and some of each
 * law (Oregon's staffing-plan deviations, its CNA limits, emergency-only exceptions) is stated in
 * the summary rather than enforced (as are the VA's § 7456 24-hour weekend-plan cap and its pay
 * premiums).
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

export type JurisdictionId =
  | 'CA'
  | 'OR'
  | 'NY'
  | 'WA'
  | 'MA'
  | 'IL'
  | 'CT'
  | 'MN'
  | 'NJ'
  | 'ME'
  | 'PA'
  | 'NH'
  | 'RI'
  | 'WV'
  | 'AK'
  | 'TX'
  | 'US-VA'
  | 'other';

/**
 * The kinds of unit a staffing law names. The acuity presets' four, plus the units Title 22 and
 * ORS 441.765 give their own ceilings that the acuity presets have no tiers for.
 */
export type JurisdictionUnitKind =
  | AcuityPresetId
  | 'emergency'
  | 'pediatrics'
  | 'psychiatric'
  | 'oncology'
  | 'pacu'
  | 'operating-room'
  | 'burn'
  | 'nicu';

/** Names a manager types for the kinds the acuity presets do not know, matched whole. */
const UNIT_KIND_ALIASES: Partial<Record<JurisdictionUnitKind, readonly string[]>> = {
  // Oregon's statute calls step-down an intermediate care unit.
  'step-down': ['intermediate care', 'intermediate care unit', 'imc', 'imcu'],
  emergency: ['emergency', 'emergency department', 'emergency room', 'ed', 'er'],
  pediatrics: ['pediatrics', 'pediatric', 'paediatrics', 'paediatric', 'peds'],
  psychiatric: [
    'psychiatric',
    'psychiatry',
    'psych',
    'behavioral health',
    'behavioural health',
    'mental health',
  ],
  oncology: ['oncology', 'onc', 'specialty care'],
  pacu: [
    'pacu',
    'post-anesthesia care',
    'post-anesthesia care unit',
    'post-anesthesia recovery',
    'post anesthesia care',
    'recovery room',
  ],
  'operating-room': ['operating room', 'or', 'operating theatre'],
  burn: ['burn', 'burn unit', 'burn center', 'burn centre'],
  nicu: ['nicu', 'neonatal intensive care', 'neonatal icu', 'intensive care nursery'],
};

/** The kind of unit a free-text unit type names, or `undefined` when no law's table names it. */
export function unitKindForUnitType(unitType: string): JurisdictionUnitKind | undefined {
  const preset = acuityPresetForUnitType(unitType);
  if (preset !== undefined) return preset;
  const key = unitType.trim().toLowerCase();
  for (const [kind, aliases] of Object.entries(UNIT_KIND_ALIASES)) {
    if (aliases.includes(key)) return kind as JurisdictionUnitKind;
  }
  return undefined;
}

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
  /** Ceilings by the unit kinds the law names; other unit types get none. */
  ratios: Partial<Record<JurisdictionUnitKind, JurisdictionRatio>>;
  overtimeRules: readonly Pick<OvertimeRule, 'basis' | 'thresholdHours' | 'multiplier'>[];
  /** Rule ids switched on (with these parameters, if any): see {@link PresetRule}. */
  enableRules: readonly PresetRule[];
  /** Proposed whole to a unit with no leave policy; never merged into one a manager set. */
  leavePolicy?: LeavePolicy;
}

/**
 * A rule a preset switches on. A numeric parameter is a cap: it only ever lowers one the unit
 * has, and is never added to an enabled rule that has none, because an unset cap on
 * no-mandatory-overtime is a total ban, stricter than any number. Two exceptions say otherwise
 * where the law's number works the other way:
 */
export interface PresetRule {
  ruleId: string;
  params?: Record<string, unknown>;
  /**
   * Numeric parameters where more is stricter (hours of rest): they only ever rise, and on a
   * switched-off rule take the preset's value, since a stored value there was never in force.
   */
  raise?: readonly string[];
  /**
   * The rule reads an absent cap as no limit at all (`long-stretch`), so adding one to an enabled
   * rule that has none tightens it.
   */
  absentCapIsUnlimited?: boolean;
}

const TITLE_22 = 'Cal. Code Regs. tit. 22 § 70217(a)';
const ORS_441_765 = 'ORS 441.765 (HB 2697, 2023)';

function rn(maxPatientsPerNurse: number, citation: string): JurisdictionRatio {
  return { role: 'RN', maxPatientsPerNurse, citation };
}

const VA_HANDBOOK = 'VA Handbook 5011 pt. III ch. 2 (38 U.S.C. § 7421)';
const TITLE_5_ANNUAL = '5 U.S.C. §§ 6303(a), 6304(a)';

const NO_MANDATORY_OVERTIME = { ruleId: 'no-mandatory-overtime' } as const;

/** `long-stretch` with a state's numbers; any cap the law does not give stays unset. */
function longStretch(params: Record<string, unknown>): PresetRule {
  return { ruleId: 'long-stretch', params, raise: ['restHours'], absentCapIsUnlimited: true };
}

export const JURISDICTION_PRESETS: Record<JurisdictionId, JurisdictionPreset> = {
  CA: {
    label: 'California',
    summary:
      'Title 22 ratios at all times, with the charge nurse counted only while caring for ' +
      'patients and relieving for breaks (§ 70217(a)): critical care, burn and the newborn ICU ' +
      '1:2, operating room one RN circulating per room, pediatrics 1:4, recovery 1:2, emergency ' +
      '1:4 (critical patients 1:2 and trauma 1:1, set as acuity tiers), step-down 1:3, telemetry ' +
      '1:4, medical/surgical 1:5, specialty care such as oncology 1:4, psychiatric 1:6. Labor ' +
      'and delivery (1:2 in active labor, 1:4 antepartum) and postpartum (4 couplets, 6 mothers) ' +
      'turn on the patient, so set those as acuity-tier ratios. An hour of breaks per nurse on a 12-hour ' +
      'shift (a 30-minute meal and three 10-minute rests). Labor Code § 510 overtime: past 8 ' +
      'hours a workday at 1.5×, past 12 at 2×, past 40 a week at 1.5×, and the seventh day in a ' +
      'row. A unit on a health-care alternative workweek (IWC Order 5 § 3(B)(8)) should remove ' +
      'the 8-hour daily rule. Ratios here count RNs only; Title 22 lets LVNs (and psychiatric ' +
      'technicians on a psychiatric unit) fill up to half. ' +
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
      burn: rn(2, `${TITLE_22}(1): critical care, burn center 1:2`),
      nicu: rn(2, `${TITLE_22}(1): intensive care newborn nursery, 1 RN:2, RNs only`),
      'operating-room': rn(1, `${TITLE_22}(2): one RN circulating per occupied room`),
      pediatrics: rn(4, `${TITLE_22}(6): pediatric service 1:4`),
      pacu: rn(2, `${TITLE_22}(7): post-anesthesia recovery 1:2`),
      emergency: rn(4, `${TITLE_22}(8): emergency department 1:4 while treating`),
      oncology: rn(4, `${TITLE_22}(12): specialty care, oncology among it, 1:4`),
      psychiatric: rn(6, `${TITLE_22}(13): psychiatric 1:6`),
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
      'ORS 441.765 direct-care RN ratios: emergency 1:4 averaged over a 12-hour shift (never ' +
      'more than 5 at once; trauma 1:1), ICU 1:2, operating room 1:1, oncology 1:4, recovery ' +
      '1:2, intermediate care (step-down) 1:3, medical-surgical 1:4 from 1 July 2026, cardiac ' +
      'telemetry 1:4, pediatrics 1:4. Labor and delivery (1:2, or 1:1 in active labor), ' +
      'postpartum, antepartum and well-baby (6, mother and baby counted apart) and mother-baby ' +
      '(8) turn on the patient: set them as acuity-tier ratios. Psychiatric units have no ' +
      'statutory ratio; their committee adopts the plan (ORS 441.767). The charge nurse takes ' +
      'no patients on a unit of 11 beds or more without the staffing committee’s approval ' +
      '(§ 441.765(8)): a unit of 10 or fewer should tick that back on under Settings › Unit. A ' +
      'certified nursing assistant may have no more than 7 patients on a day or evening shift ' +
      'and 11 at night (ORS 441.768); that limits one aide’s assignment rather than requiring ' +
      'aides, so it is not set as a ratio. No mandatory overtime (ORS 441.770): a hospital may ' +
      'not require work beyond the agreed shift, past 48 hours in its work week or 12 in 24, or ' +
      'in the 10 hours after the 12th; all four limit required hours only, which the ban ' +
      'already refuses. Record an emergency, or the one extra hour § 441.770(4) allows when the ' +
      'next shift has a vacancy, on the shift as "Emergency: …". The staffing plan and its ' +
      'permitted deviations are not enforced here.',
    ratioStaffing: {
      chargeNurseTakesPatients: false,
      breakMinutesPerNurse: 0,
      chargeCoversBreaks: false,
    },
    ratios: {
      'med-surg': rn(4, `${ORS_441_765}(2)(j): medical-surgical 1:4 from 2026-07-01`),
      telemetry: rn(4, `${ORS_441_765}(2)(k): cardiac telemetry 1:4`),
      icu: rn(2, `${ORS_441_765}(2)(b): intensive care 1:2`),
      'step-down': rn(3, `${ORS_441_765}(2)(i): intermediate care 1:3`),
      emergency: rn(4, `${ORS_441_765}(2)(a): emergency 1:4 averaged over 12 hours, 5 at most`),
      'operating-room': rn(1, `${ORS_441_765}(2)(f): operating room 1:1`),
      oncology: rn(4, `${ORS_441_765}(2)(g): oncology 1:4`),
      pacu: rn(2, `${ORS_441_765}(2)(h): post-anesthesia care 1:2`),
      pediatrics: rn(4, `${ORS_441_765}(2)(L): pediatric 1:4`),
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
      'overtime outside an emergency with no reasonable alternative (§ 226(b)); record those on ' +
      'the shift as "Emergency: …". And whether required or volunteered, a nurse may not work ' +
      'more than 16 consecutive hours, and after 16 must have 8 hours off (§ 226(f)); no ' +
      'emergency lifts that.',
    ratios: {
      icu: rn(2, 'M.G.L. c.111 § 231: intensive care 1:2, or 1:1 by acuity'),
    },
    overtimeRules: [],
    enableRules: [
      NO_MANDATORY_OVERTIME,
      // § 226(f): "A nurse shall not be allowed to exceed 16 consecutive hours worked in a 24 hour
      // period. In the event a nurse works 16 consecutive hours, that nurse must be given at least
      // 8 consecutive hours of off-duty time immediately after the worked overtime."
      longStretch({
        requiredOnly: false,
        maxConsecutiveHours: 16,
        emergencyLiftsCap: false,
        restAfterHours: 16,
        restOnlyPastThreshold: false,
        restHours: 8,
      }),
    ],
  },
  IL: {
    label: 'Illinois',
    summary:
      'No nurse (RN, LPN or APRN paid hourly) may be required to work past an agreed, ' +
      'predetermined shift except in an unforeseen emergent circumstance — a declared disaster ' +
      'or the hospital’s disaster plan, or a procedure that needs the nurse’s skills to finish — ' +
      'as a last resort; ordinary short staffing is not one (210 ILCS 85/10.9). Record those on ' +
      'the shift as "Emergency: …". Even then a required holdover may not run more than 4 hours ' +
      'past the shift, and a nurse required to work up to 12 consecutive hours must then have 8 ' +
      'hours off. On-call time in specialized units does not count. The rules judge every role, ' +
      'though the statute does not cover nursing assistants.',
    ratios: {},
    overtimeRules: [],
    enableRules: [
      { ...NO_MANDATORY_OVERTIME, params: { emergencyMaxHoursPastShift: 4 } },
      longStretch({
        requiredOnly: true,
        restAfterHours: 12,
        restOnlyPastThreshold: false,
        restHours: 8,
      }),
    ],
  },
  CT: {
    label: 'Connecticut',
    summary:
      'No hospital may require a nurse (RN, LPN or registered nurse’s aide) to work overtime ' +
      '(Conn. Gen. Stat. § 19a-490l): past a shift posted at least 48 hours ahead, more than 12 ' +
      'hours in 24, or more than 48 in the hospital’s work week. A nurse may volunteer for any ' +
      'of it. A schedule that puts a nurse past 12 in 24 or 48 in a week is overtime under the ' +
      'statute, so mark those shifts as overtime and record the nurse’s offer. Exceptions, only ' +
      'when patient safety requires and there is no reasonable alternative: a surgery in ' +
      'progress, a critical care nurse until relieved by the next shift, and public health or ' +
      'institutional emergencies; record those on the shift as "Emergency: …". A collective ' +
      'bargaining agreement in effect before 1 October 2023 that addresses mandatory overtime ' +
      'governs until it expires.',
    ratios: {},
    overtimeRules: [],
    enableRules: [NO_MANDATORY_OVERTIME],
  },
  MN: {
    label: 'Minnesota',
    summary:
      'Minnesota does not ban mandatory overtime. Minn. Stat. § 181.275 protects a nurse (RN, ' +
      'LPN or APRN) who declines hours past a normal work period of 12 or fewer consecutive ' +
      'hours because, in their judgment, working them may jeopardize patient safety; outside ' +
      'an emergency the hospital may not act against them for it. No rule is switched on, ' +
      'because the app cannot know the nurse’s judgment: record a refusal in the shift’s notes. ' +
      'Nursing facilities are not covered.',
    ratios: {},
    overtimeRules: [],
    enableRules: [],
  },
  NJ: {
    label: 'New Jersey',
    summary:
      'No health care facility may require an hourly direct-care employee (RNs, LPNs and ' +
      'aides among them) to work past an agreed, predetermined and regularly scheduled daily ' +
      'shift of up to 40 hours a week; anything more is voluntary (N.J.S.A. 34:11-56a34). The ' +
      'exception is an unforeseeable emergent circumstance, as a last resort and not to fill ' +
      'chronic vacancies, after asking volunteers, per diem and agency staff; record those on ' +
      'the shift as "Emergency: …". On-call time may not stand in for mandatory overtime ' +
      '(§ 56a36).',
    ratios: {},
    overtimeRules: [],
    enableRules: [NO_MANDATORY_OVERTIME],
  },
  ME: {
    label: 'Maine',
    summary:
      'Maine allows mandated overtime, but a nurse may not be disciplined for refusing more ' +
      'than 12 consecutive hours except in an unforeseen emergent circumstance, as a last ' +
      'resort for patient safety, and a nurse mandated past 12 consecutive hours must then ' +
      'have 10 hours off (26 M.R.S. § 603(5)). So a required holdover that runs a stretch past ' +
      '12 hours is refused unless the shift records "Emergency: …", and the 10 hours of rest ' +
      'apply even then. The general limit of 80 hours of required overtime in two weeks ' +
      '(§ 603(1)) is not enforced here.',
    ratios: {},
    overtimeRules: [],
    enableRules: [
      longStretch({
        requiredOnly: true,
        maxConsecutiveHours: 12,
        emergencyLiftsCap: true,
        restAfterHours: 12,
        restOnlyPastThreshold: true,
        restHours: 10,
      }),
    ],
  },
  PA: {
    label: 'Pennsylvania',
    summary:
      'No health care facility may require a direct-care employee (RNs, LPNs and aides among ' +
      'them) to work past an agreed, predetermined and regularly scheduled daily shift ' +
      '(Prohibition of Excessive Overtime in Health Care Act, 43 P.S. § 932.3, Act 102 of ' +
      '2008). Exceptions: an unforeseeable emergent circumstance as a last resort (not chronic ' +
      'short staffing) and a procedure in progress; record those on the shift as "Emergency: ' +
      '…". On-call time may not stand in for mandatory overtime. After more than 12 ' +
      'consecutive hours, required or volunteered, an employee gets 10 hours off, which they ' +
      'may waive: record a waiver under the nurse’s rest waivers.',
    ratios: {},
    overtimeRules: [],
    enableRules: [
      NO_MANDATORY_OVERTIME,
      longStretch({
        requiredOnly: false,
        restAfterHours: 12,
        restOnlyPastThreshold: true,
        restHours: 10,
        honorsRestWaiver: true,
      }),
    ],
  },
  NH: {
    label: 'New Hampshire',
    summary:
      'A nurse (RN, LPN or licensed nursing assistant) may not be disciplined for refusing more ' +
      'than 12 consecutive hours (RSA 275:67), so a required holdover that runs a stretch past ' +
      '12 hours is refused unless the shift records "Emergency: …" — the exceptions are a ' +
      'surgery in progress, a critical care unit until the next scheduled nurse arrives, home ' +
      'health until relieved, a public health emergency, and a collective bargaining agreement ' +
      'that addresses mandatory overtime. A nurse mandated past 12 consecutive hours must then ' +
      'have 8 hours off. A written agreement filed with the labor commissioner (RSA 275:68) ' +
      'exempts the employer; switch the rule off for such a nurse’s unit if one is filed.',
    ratios: {},
    overtimeRules: [],
    enableRules: [
      longStretch({
        requiredOnly: true,
        maxConsecutiveHours: 12,
        emergencyLiftsCap: true,
        restAfterHours: 12,
        restOnlyPastThreshold: true,
        restHours: 8,
      }),
    ],
  },
  RI: {
    label: 'Rhode Island',
    summary:
      'No hospital may require an hourly nurse or nursing assistant to work past an agreed, ' +
      'predetermined shift of 8, 10 or 12 hours except in an unforeseeable emergent ' +
      'circumstance — a power outage, a public health emergency, an irregular rise in census ' +
      'or in staff not reporting — as a last resort after seeking volunteers and per diem staff ' +
      '(R.I. Gen. Laws § 23-17.20-3); record those on the shift as "Emergency: …". In no case ' +
      'may a nurse be required to work more than 12 consecutive hours, emergency or not. ' +
      'Voluntary overtime is not limited.',
    ratios: {},
    overtimeRules: [],
    enableRules: [{ ...NO_MANDATORY_OVERTIME, params: { emergencyMaxConsecutiveHours: 12 } }],
  },
  WV: {
    label: 'West Virginia',
    summary:
      'A hospital may not mandate overtime past a nurse’s regularly scheduled shift (W. Va. ' +
      'Code § 21-5F-3), outside an unforeseen emergency (terrorism, an outbreak, a disaster — ' +
      'not known staffing gaps), prescheduled on-call time or a procedure in progress; record ' +
      'those on the shift as "Emergency: …". Required or volunteered, a nurse who works 12 or ' +
      'more consecutive hours must then have 8 hours off, and may not work more than 16 hours ' +
      'in 24 (§ 21-5F-3(g)). The statute lifts the 16-hour limit in those same emergencies; ' +
      'here it holds, so switch it off for an emergency. Hospitals run by the state or federal ' +
      'government are not covered.',
    ratios: {},
    overtimeRules: [],
    enableRules: [
      NO_MANDATORY_OVERTIME,
      { ruleId: 'max-hours-in-24', params: { maxHours: 16 } },
      longStretch({
        requiredOnly: false,
        restAfterHours: 12,
        restOnlyPastThreshold: false,
        restHours: 8,
      }),
    ],
  },
  AK: {
    label: 'Alaska',
    summary:
      'A nurse (RN or LPN) may not be required to work beyond a predetermined and regularly ' +
      'scheduled shift (AS 18.20.400), and after a scheduled shift is allowed 10 consecutive ' +
      'hours off. Voluntary overtime is lawful only up to 14 consecutive hours (§ 18.20.400(c)). ' +
      'Exceptions: a procedure in progress, an unforeseen emergency (not foreseeable volume or ' +
      'staffing), weather that keeps the relief nurse away, a rural facility’s declared ' +
      'staffing emergency (§ 18.20.410), and prearranged on-call; record those on the shift ' +
      'as "Emergency: …". The 14-hour limit and the rest after a shift are enforced; the ' +
      '80-hours-in-14-days condition on voluntary work is not.',
    ratios: {},
    overtimeRules: [],
    enableRules: [
      NO_MANDATORY_OVERTIME,
      { ruleId: 'min-rest-between-shifts', params: { minRestHours: 10 }, raise: ['minRestHours'] },
      longStretch({ requiredOnly: false, maxConsecutiveHours: 14, emergencyLiftsCap: true }),
    ],
  },
  TX: {
    label: 'Texas',
    summary:
      'A hospital may not require a nurse (RN or LVN) to work mandatory overtime — hours or days ' +
      'beyond those scheduled, however long the shift — and a nurse may refuse (Tex. Health & ' +
      'Safety Code § 258.003). Time just before or after a shift to document or hand over ' +
      'patients does not count, and on-call time may not stand in for mandatory overtime. ' +
      'Exceptions (§ 258.004): a health care disaster or declared emergency in or next to the ' +
      'county, an unforeseen event after good-faith efforts to find volunteers, and a procedure ' +
      'in progress; record those on the shift as "Emergency: …". There are no hour caps.',
    ratios: {},
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
      'plan: lower the cap under Settings › Rules for such nurses) or more than 8 consecutive ' +
      'hours (12 on a compressed tour, § 7456 or § 7456A), so a holdover recorded as required ' +
      'that runs a tour past those hours is refused; volunteers and emergencies recorded on the ' +
      'shift as "Emergency: …" are outside it. Pay premiums are set under ' +
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
    enableRules: [
      {
        ruleId: 'no-mandatory-overtime',
        // 38 U.S.C. § 7459(a): the Secretary "may not require nursing staff to work ... more than
        // 40 hours in an administrative workweek" (24 on the § 7456 plan), nor "more than eight
        // consecutive hours (or 12 hours if such staff is covered under section 7456 or 7456A)".
        params: {
          maxMandatedWeeklyHours: 40,
          maxRequiredConsecutiveHours: 8,
          compressedTourConsecutiveHours: 12,
        },
      },
    ],
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
 * Every preset id, derived from the record so a new preset cannot be missing from it: the record
 * is typed `Record<JurisdictionId, …>`, so the compiler already refuses an id without an entry.
 * The IPC schema enumerates this rather than a hand-kept list.
 */
export const JURISDICTION_IDS = Object.keys(JURISDICTION_PRESETS) as [
  JurisdictionId,
  ...JurisdictionId[],
];

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

  const kind = unitKindForUnitType(current.unitType);
  const ceiling = kind === undefined ? undefined : preset.ratios[kind];
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
        } else if (wanted.raise?.includes(key)) {
          if (!c.enabled ? have !== value : typeof have !== 'number' || value > have) {
            params[key] = value;
            touched = true;
          }
        } else if (typeof have === 'number') {
          if (value < have) {
            params[key] = value;
            touched = true;
          }
        } else if (!c.enabled || wanted.absentCapIsUnlimited) {
          params[key] = value;
          touched = true;
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
