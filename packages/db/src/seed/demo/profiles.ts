/**
 * The demo units offered on the welcome screen. Each is one real kind of unit, and differs from
 * the others in what real units differ in: shift pattern, skill mix, whether ratios are law,
 * how nights and weekends are paid, which holidays count, and the contract limits on stretches.
 *
 * Figures are typical of their setting in 2026 and rounded; they are there to make the demo
 * behave like the real thing, not to quote any one employer's pay table.
 */

import { DEFAULT_WEEKEND, isoDate, MINUTES_PER_DAY } from '@shiftnurse/core';
import type { DemoProfile, DemoRosterRow } from './engine.js';

const FULL_12 = { employmentType: 'full_time', fte: 0.9, contractedHoursPerPeriod: 72 } as const;
const PART_12 = { employmentType: 'part_time', fte: 0.6, contractedHoursPerPeriod: 48 } as const;
const PER_DIEM = { employmentType: 'per_diem', fte: 0, contractedHoursPerPeriod: 0 } as const;
const TRAVEL = { employmentType: 'agency', fte: 0.9, contractedHoursPerPeriod: 72 } as const;

// ---------------------------------------------------------------------------
// Community hospital medical-surgical
// ---------------------------------------------------------------------------

/**
 * A 28-bed adult med-surg unit in a community hospital: 12-hour days and nights, RNs and CNAs
 * (most acute-care hospitals no longer staff LPNs on med-surg), ratios of 1:5/1:4/1:3 by acuity
 * (1:5 is California's legal minimum for med-surg), a seniority step scale and travelers.
 *
 * Contracted RN day shifts come to about 47 a week against a floor of about 44; nights 37
 * against 40, with per-diem making up the difference. CNAs: 25 day shifts against 21, 14 nights
 * against 14. The per-diem pool is sized as real units size it: to cover vacations and
 * call-offs, which paid leave no longer lets the vacationer "make up" elsewhere in the period.
 */
const communityRoster: DemoRosterRow[] = [
  { role: 'RN', ...FULL_12, position: 'D12', count: 12, newGrads: 2 },
  { role: 'RN', ...FULL_12, position: 'N12', count: 10, newGrads: 1 },
  { role: 'RN', ...PART_12, position: 'D12', count: 4 },
  { role: 'RN', ...PART_12, position: 'N12', count: 2 },
  { role: 'RN', ...PER_DIEM, position: 'flex', count: 6 },
  { role: 'RN', ...TRAVEL, position: 'D12', count: 1 },
  { role: 'RN', ...TRAVEL, position: 'N12', count: 1 },
  { role: 'CNA', ...FULL_12, position: 'D12', count: 7 },
  { role: 'CNA', ...FULL_12, position: 'N12', count: 4 },
  { role: 'CNA', ...PART_12, position: 'D12', count: 2 },
  { role: 'CNA', ...PART_12, position: 'N12', count: 1 },
  { role: 'CNA', ...PER_DIEM, position: 'flex', count: 2 },
];

export const COMMUNITY_MED_SURG: DemoProfile = {
  id: 'community-med-surg',
  unit: { name: '5 North Medical-Surgical', unitType: 'Medical-Surgical' },
  scheduleWeeks: 6,
  shifts: [
    {
      code: 'D12',
      name: 'Day 12',
      startTime: '07:00',
      durationHours: 12,
      isNight: false,
      color: '#f59e0b',
      censusDelta: 0,
    },
    {
      code: 'N12',
      name: 'Night 12',
      startTime: '19:00',
      durationHours: 12,
      isNight: true,
      color: '#4f46e5',
      censusDelta: -1,
    },
  ],
  roster: communityRoster,
  // About a third of the RNs, so a charge nurse's vacation never leaves a shift without one.
  chargeNurses: { D12: 8, N12: 6 },
  floors: {
    // Days: five RNs with patients plus a charge nurse. Ratios push this higher on busy days.
    D12: { RN: { min: 6, target: 7 }, CNA: { min: 3, target: 4 } },
    N12: { RN: { min: 5, target: 6 }, CNA: { min: 2, target: 2 } },
  },
  census: {
    beds: 28,
    minimum: 14,
    // Elective surgical admissions fill the middle of the week.
    weekday: [22, 24, 26, 26, 25, 24, 22],
    // The winter respiratory season, the summer lull.
    seasonal: [2, 2, 1, 0, 0, -1, -2, -1, 0, 0, 1, 1],
  },
  tiers: [
    { name: 'Routine', careHoursPerPatientDay: 4, share: 0 },
    { name: 'Moderate', careHoursPerPatientDay: 6, share: 0.28 },
    { name: 'High', careHoursPerPatientDay: 9, share: 0.08 },
  ],
  ratios: [
    {
      role: 'RN',
      tierLevel: 1,
      max: 5,
      citation: 'Unit staffing plan, approved by the staffing committee',
    },
    {
      role: 'RN',
      tierLevel: 2,
      max: 4,
      citation: 'Unit staffing plan, approved by the staffing committee',
    },
    {
      role: 'RN',
      tierLevel: 3,
      max: 3,
      citation: 'Unit staffing plan, approved by the staffing committee',
    },
  ],
  // RN and CNA hours together; med-surg benchmarks run 7.5 to 9.
  hppdTarget: 8.2,
  credentials: { aclsPerShift: 1, aclsForAllRNs: false },
  pay: {
    roleDefault: { RN: 42, CNA: 19.5 },
    // RN $42/h new graduate plus $1.10 a year to year 20; CNA $19.50 plus $0.40 a year; a
    // per-diem premium in place of benefits; a travel agency bill rate.
    rate: ({ role, employmentType, years }) => {
      if (employmentType === 'agency') return 96;
      const rn = role === 'RN';
      const step = rn ? 42 + 1.1 * Math.min(years, 20) : 19.5 + 0.4 * Math.min(years, 15);
      return step + (employmentType === 'per_diem' ? (rn ? 6 : 2.5) : 0);
    },
    raise: { month: 7, percent: 3 },
  },
  differentials: [
    { kind: 'night', mode: 'flat', amount: 5 },
    { kind: 'weekend', mode: 'flat', amount: 2.5 },
    { kind: 'holiday', mode: 'multiplier', amount: 1.5 },
    { kind: 'charge', mode: 'flat', amount: 2 },
  ],
  overtime: [{ basis: 'weekly', thresholdHours: 40, multiplier: 1.5 }],
  holidays: 'hospital-six',
  rules: { weekend: DEFAULT_WEEKEND },
};

// ---------------------------------------------------------------------------
// VA San Francisco medical-surgical
// ---------------------------------------------------------------------------

/** Six 12s and one 8 a pay period: 80 hours, 44 one week and 36 the next. */
const FULL_80 = { employmentType: 'full_time', fte: 1, contractedHoursPerPeriod: 80 } as const;
const EIGHT_A_PAY_PERIOD = { shortShift: { code: 'D8', perPayPeriod: 1 } } as const;
/** Four 12s a pay period. */
const PART_48 = { employmentType: 'part_time', fte: 0.6, contractedHoursPerPeriod: 48 } as const;
/** VA "intermittent" staff: no fixed tour, no hours commitment, the per-diem equivalent. */
const INTERMITTENT = { employmentType: 'per_diem', fte: 0, contractedHoursPerPeriod: 0 } as const;

/**
 * An acute medical-surgical ward modelled on VA practice at a large urban medical center such as
 * San Francisco's (Fort Miley). What sets it apart:
 *
 * - **A compressed biweekly schedule.** Full-time staff work six 12-hour tours and one 8-hour
 *   tour each pay period: 80 hours, the long week 44 and the short week 36. That is a compressed
 *   schedule — 80 hours in fewer than ten workdays, as 5 U.S.C. §6121 defines one — so overtime
 *   is counted over the pay period rather than the week: past 80 hours in the pay period, or any
 *   time worked beyond the scheduled tour (a holdover: an 8 held over is overtime from its 9th
 *   hour). Part-time staff work four 12s. The history holds three volunteered holdovers.
 * - **The 8 has its own floor and runs inside the day 12.** It works 07:00–15:00, adding hands
 *   for the morning's care and discharges, and is covered as a real ward covers it: by the day
 *   12's charge nurse and ACLS nurse, and a new grad on it works beside the day 12's
 *   experienced RNs.
 * - **Federal staff mix.** RNs, LVNs (California's LPNs; the VA employs many) and nursing
 *   assistants in team nursing. No agency travelers.
 * - **No legislated ratios.** California's ratio law does not bind a federal facility; VHA
 *   staffs to nursing hours per patient day set by its expert-panel staffing methodology
 *   (VHA Directive 1351), so demand here is the floors and the NHPPD target, not a ratio.
 * - **Title 38 law, not California's.** The unit's preset is `US-VA`: 38 U.S.C. §7459(a) forbids
 *   requiring more than 40 hours in an administrative workweek, so unvolunteered overtime past
 *   that is a violation. The staff offer overtime (about a third of them, standing offers), and
 *   the history never requires it of anyone else.
 * - **Title 38 premium pay** (38 U.S.C. §7453), by the clock: a 10% night differential on a
 *   tour with at least four hours between 6 pm and 6 am pays the whole tour. The night 12 earns
 *   it; the day 12 has one hour in that window (6 pm to its 7 pm end), paid on the base rate
 *   only; the 8 has none. A 25% premium for any tour touching Saturday or Sunday, and double
 *   time on holidays.
 * - **Union and contract terms.** San Francisco VA nurses are represented by the National
 *   Federation of Federal Employees, Local 1 (not NNU or AFGE). Eleven hours between tours and
 *   two weekends off in every four are typical VA nurse contract terms (the VA-NNU 2023 Master
 *   Agreement, Art. 13 §2, has both), applied here as typical VA practice and not quoted from
 *   NFFE's agreement.
 * - **All eleven federal holidays**, Veterans Day included.
 * - **The federal biweekly pay calendar** and four-week schedules.
 * - **Staff kept apart.** Three separations of the kind a VA nurse manager carries: an RN pair
 *   with an unresolved conflict, one on days and one on nights; three nursing assistants who
 *   are parties to an open EEO complaint and do not share a tour until it closes; and five LVNs
 *   who work well in pairs but, together, freeze newer staff out, so no more than two of them
 *   are on the floor at once while a unit-culture review runs. A ward separates people by tour —
 *   two full-timers each working seven day tours a pay period cannot be kept apart by splitting
 *   fourteen days — so each group spans days, nights and the intermittent pool, and a group of
 *   five is staffable only with a cap above one.
 * - **Leave, certifications, floats and bidding**, which a federal ward carries and a community
 *   unit's demo does not. Annual leave and sick balances follow 5 U.S.C. ch. 63 accrual (RNs
 *   8 hours of annual leave a pay period, LVNs and nursing assistants 4, 6 or 8 by service of
 *   under 3, 3 to 15 and over 15 years; 4 hours of sick leave; part-time staff pro rata), with
 *   annual leave carried over at no more than 240 hours and sick leave uncapped. Three FMLA
 *   certifications (an intermittent one, a block that has ended and a current one), two new-grad
 *   RNs in their 12 weeks of orientation with a named preceptor (one running into the draft),
 *   five staff with float memberships on the telemetry unit down the hall, and the leave-year
 *   bid in September: about half the staff rank up to five one-week choices for the coming
 *   leave year, which the manager awards.
 *
 * Pay is on the VA Nurse Locality Pay System for RNs (Nurse I–III by experience, San Francisco
 * rates among the highest in the VA) and the General Schedule with the San Francisco locality
 * for LVNs and nursing assistants. The figures are rounded approximations.
 *
 * Floors (24 beds, about 20 patients): day 12 4 RN, 2 LVN, 2 NA; night 12 3 RN, 1 LVN, 1 NA; the
 * 8 one RN — 164 nursing hours a day, 8.2 per patient day. Targets, which a manager schedules to
 * when staff are available, add one on most shifts. Contracted RN 12s come to about 116 a pay
 * period against a floor of 98, and eighteen 8s against fourteen.
 */
const vaRoster: DemoRosterRow[] = [
  { role: 'RN', ...FULL_80, ...EIGHT_A_PAY_PERIOD, position: 'D12', count: 10, newGrads: 2 },
  { role: 'RN', ...FULL_80, ...EIGHT_A_PAY_PERIOD, position: 'N12', count: 8 },
  { role: 'RN', ...PART_48, position: 'D12', count: 1 },
  { role: 'RN', ...PART_48, position: 'N12', count: 1 },
  { role: 'RN', ...INTERMITTENT, position: 'flex', count: 3 },
  { role: 'LPN', ...FULL_80, ...EIGHT_A_PAY_PERIOD, position: 'D12', count: 4 },
  { role: 'LPN', ...FULL_80, ...EIGHT_A_PAY_PERIOD, position: 'N12', count: 3 },
  { role: 'LPN', ...PART_48, position: 'D12', count: 1 },
  { role: 'LPN', ...PART_48, position: 'N12', count: 1 },
  { role: 'LPN', ...INTERMITTENT, position: 'flex', count: 2 },
  { role: 'CNA', ...FULL_80, ...EIGHT_A_PAY_PERIOD, position: 'D12', count: 4 },
  { role: 'CNA', ...FULL_80, ...EIGHT_A_PAY_PERIOD, position: 'N12', count: 3 },
  { role: 'CNA', ...PART_48, position: 'D12', count: 1 },
  { role: 'CNA', ...PART_48, position: 'N12', count: 1 },
  { role: 'CNA', ...INTERMITTENT, position: 'flex', count: 2 },
];

export const VA_SF_MED_SURG: DemoProfile = {
  id: 'va-sf-med-surg',
  unit: { name: '4A Medicine-Surgery (VA San Francisco sample)', unitType: 'Medical-Surgical' },
  jurisdiction: 'US-VA',
  bridgedService: true,
  scheduleWeeks: 4,
  // Federal pay period 1 of 2025 began Sunday 12 January; every pay period since is 14 days on.
  payPeriodCycle: isoDate('2025-01-12'),
  shifts: [
    {
      code: 'D12',
      name: 'Day 12',
      startTime: '07:00',
      durationHours: 12,
      isNight: false,
      color: '#f59e0b',
      censusDelta: 0,
    },
    {
      code: 'N12',
      name: 'Night 12',
      startTime: '19:00',
      durationHours: 12,
      isNight: true,
      color: '#4f46e5',
      censusDelta: -1,
    },
    // Inside the day 12, which covers it: its charge nurse, ACLS nurse and experienced RNs.
    {
      code: 'D8',
      name: 'Day 8',
      startTime: '07:00',
      durationHours: 8,
      isNight: false,
      color: '#14b8a6',
      censusDelta: 0,
      within: 'D12',
    },
  ],
  roster: vaRoster,
  chargeNurses: { D12: 5, N12: 5 },
  floors: {
    D12: { RN: { min: 4, target: 5 }, LPN: { min: 2, target: 3 }, CNA: { min: 2, target: 3 } },
    N12: { RN: { min: 3, target: 4 }, LPN: { min: 1, target: 2 }, CNA: { min: 1, target: 2 } },
    D8: { RN: { min: 1, target: 2 }, LPN: { min: 0, target: 1 }, CNA: { min: 0, target: 1 } },
  },
  census: {
    beds: 24,
    minimum: 14,
    // Veterans' admissions come through the emergency department all week, with fewer
    // elective surgeries than a community hospital: a flatter week.
    weekday: [19, 20, 21, 21, 21, 20, 19],
    seasonal: [1, 1, 1, 0, 0, 0, -1, -1, 0, 0, 0, 1],
  },
  // An older, sicker population: more moderate and high-acuity patients than a community unit.
  tiers: [
    { name: 'Routine', careHoursPerPatientDay: 5, share: 0 },
    { name: 'Moderate', careHoursPerPatientDay: 7, share: 0.33 },
    { name: 'High', careHoursPerPatientDay: 10, share: 0.12 },
  ],
  ratios: [],
  hppdTarget: 8,
  credentials: { aclsPerShift: 1, aclsForAllRNs: false },
  pay: {
    roleDefault: { RN: 60, LPN: 36, CNA: 29 },
    rate: ({ role, years }) => {
      if (role === 'RN') {
        // Nurse I (entry), Nurse II (two years on), Nurse III (eight years on).
        if (years < 2) return 60 + 2 * years;
        if (years < 8) return 72 + 1.5 * (years - 2);
        return 86 + 0.8 * Math.min(years - 8, 15);
      }
      // General Schedule steps with the San Francisco locality.
      return role === 'LPN' ? 36 + 0.5 * Math.min(years, 15) : 29 + 0.4 * Math.min(years, 15);
    },
    // The federal pay adjustment takes effect with the first pay period of January.
    raise: { month: 1, percent: 2 },
  },
  differentials: [
    // 38 U.S.C. §7453(b): the whole tour at 4 or more hours between 6 pm and 6 am.
    {
      kind: 'night',
      mode: 'multiplier',
      amount: 1.1,
      window: { startTime: '18:00', endTime: '06:00', wholeShiftAtHours: 4 },
    },
    { kind: 'weekend', mode: 'multiplier', amount: 1.25 },
    { kind: 'holiday', mode: 'multiplier', amount: 2 },
  ],
  // Overtime is work beyond the scheduled tour (VA-NNU Master Agreement Art. 14; 38 U.S.C.
  // §7453(e)) or past 80 hours a pay period. An 8-hour tour held over is overtime from its 9th
  // hour, which a flat `daily 12` never caught: that was the demo-review issue deferred to holdovers.
  overtime: [
    { basis: 'beyond_scheduled_tour', thresholdHours: 0, multiplier: 1.5 },
    { basis: 'pay_period', thresholdHours: 80, multiplier: 1.5 },
  ],
  holidays: 'federal',
  rules: {
    // Title 38 weekend premium: any tour touching midnight Friday to midnight Sunday.
    weekend: {
      startWeekday: 6,
      startMinute: 0,
      durationMinutes: 2 * MINUTES_PER_DAY,
      mode: 'overlaps',
    },
    enable: ['weekend-pattern'],
    params: {
      // 44 hours one week and 36 the next is 80 for the pay period, not four hours of overtime.
      'max-hours-per-week': { overtimeByPayPeriod: true, payPeriodOvertimeThresholdHours: 80 },
      'min-rest-between-shifts': { minRestHours: 11 },
      // Two weekends off in every four: at most two worked in a four-week schedule.
      'weekend-pattern': { maxConsecutiveWeekends: 2, maxWeekendsPerPeriod: 2 },
    },
  },
  leaveBalances: {
    // 5 U.S.C. §6303: 4 hours of annual leave a pay period under 3 years of service, 6 from 3
    // to 15 and 8 beyond; Title 38 RNs earn 8 from the start. Sick leave is 4 hours.
    vacationType: 'annual',
    // VA Handbook 5011 pt. III ch. 2: Title 38 full-time nurses carry up to 685 hours; LVNs and
    // nursing assistants are Title 5, whose ceiling is 240 (5 U.S.C. § 6304(a)).
    carryoverCapHours: (role) => (role === 'RN' ? 685 : 240),
    accrual: ({ role, years }) => ({
      annual: role === 'RN' ? 8 : years < 3 ? 4 : years <= 15 ? 6 : 8,
      sick: 4,
    }),
  },
  fmla: [
    {
      note: "Intermittent — parent's chemotherapy appointments; 12-month certification, supervisor notified a day ahead.",
      intermittent: true,
      startsIn: -120,
      endsIn: -120 + 364,
    },
    {
      note: 'Surgery and recovery — one block, returned to full duty.',
      intermittent: false,
      startsIn: -150,
      endsIn: -80,
    },
    {
      note: 'Caring for spouse after hip replacement — one block of up to 12 weeks, certification on file.',
      intermittent: false,
      startsIn: -28,
      endsIn: 55,
    },
  ],
  // One orientation that began in the history and runs into the draft schedule, and one that
  // began a week before the history and ended about 15 weeks before the draft, inside the
  // history (hired earlier, that orientee is not missing from the history's staffing). Both are
  // new grads on days, with a day-tour preceptor each.
  preceptorships: [
    { position: 'D12', hiredIn: -49, weeks: 12 },
    { position: 'D12', hiredIn: -190, weeks: 12 },
  ],
  floatUnit: {
    name: '4B Telemetry (VA San Francisco sample)',
    unitType: 'Telemetry',
    shifts: ['D12', 'N12'],
    competency: 'Telemetry monitoring; no titratable drips',
    rns: 4,
    lpns: 1,
  },
  // The leave-year bid runs each September; the manager awards it, results due 15 October.
  annualLeaveBid: {
    opens: '09-01',
    closes: '09-30',
    offPerDay: { RN: 2, LPN: 1, CNA: 1 },
    maxAwardsPerNurse: 5,
    share: 0.5,
    maxChoices: 5,
  },
  // Volunteered, as most holdovers are: report ran late, a patient needed a hand. None is required.
  holdovers: [
    { shift: 'D8', minutes: 45 },
    { shift: 'D12', minutes: 90 },
    { shift: 'N12', minutes: 30 },
  ],
  keptApart: [
    {
      name: 'RN tour separation',
      reason:
        'Unresolved conflict between the two nurses; kept on separate tours while mediation ' +
        'through the Employee Assistance Program continues.',
      maxTogether: 1,
      members: [
        { role: 'RN', position: 'D12' },
        { role: 'RN', position: 'N12' },
      ],
      startsIn: -84,
    },
    {
      name: 'Nursing assistants — pending investigation',
      reason:
        'Parties to an open EEO complaint; not to share a tour until the investigation closes.',
      maxTogether: 1,
      members: [
        { role: 'CNA', position: 'D12' },
        { role: 'CNA', position: 'N12' },
        { role: 'CNA', position: 'flex' },
      ],
      startsIn: -42,
      // Expected to close about a month after this schedule.
      endsIn: 56,
    },
    {
      name: 'LVN team — unit-culture review',
      reason:
        'Newer staff report being shut out when these five LVNs work together; no more than ' +
        'two of them on the floor at once while the unit-culture review is open.',
      maxTogether: 2,
      members: [
        { role: 'LPN', position: 'D12' },
        { role: 'LPN', position: 'D12' },
        { role: 'LPN', position: 'N12' },
        { role: 'LPN', position: 'N12' },
        { role: 'LPN', position: 'flex' },
      ],
      startsIn: -56,
      // Reviewed at the end of the quarter.
      endsIn: 84,
    },
  ],
};

// ---------------------------------------------------------------------------
// California community hospital ICU
// ---------------------------------------------------------------------------

/**
 * A 12-bed mixed medical-surgical ICU in a California community hospital:
 *
 * - **Ratios are law.** Title 22 §70217 caps ICU assignments at two patients per RN, and a
 *   critically unstable patient (a fresh post-op, CRRT, a proning) gets a nurse to themself.
 * - **All-RN care** with one ICU technician per shift; every RN carries ACLS, and at least four
 *   ACLS nurses must be on every shift. About half hold the CCRN specialty certification.
 * - **California's 12-hour alternative workweek**: overtime after 12 hours in a day or 40 in a
 *   week, rather than after 8.
 * - Higher critical-care pay, travelers at a critical-care bill rate.
 *
 * About 11 patients, two of them one-to-one: 7 RNs a shift, roughly 98 RN shifts a week against
 * 93 contracted plus per-diem.
 */
const icuRoster: DemoRosterRow[] = [
  { role: 'RN', ...FULL_12, position: 'D12', count: 14, newGrads: 1 },
  { role: 'RN', ...FULL_12, position: 'N12', count: 13 },
  { role: 'RN', ...PART_12, position: 'D12', count: 3 },
  { role: 'RN', ...PART_12, position: 'N12', count: 3 },
  { role: 'RN', ...PER_DIEM, position: 'flex', count: 6 },
  { role: 'RN', ...TRAVEL, position: 'D12', count: 1 },
  { role: 'RN', ...TRAVEL, position: 'N12', count: 1 },
  { role: 'CNA', ...FULL_12, position: 'D12', count: 2 },
  { role: 'CNA', ...FULL_12, position: 'N12', count: 2 },
  { role: 'CNA', ...PART_12, position: 'N12', count: 1 },
  { role: 'CNA', ...PER_DIEM, position: 'flex', count: 1 },
];

export const CA_ICU: DemoProfile = {
  id: 'ca-icu',
  unit: {
    name: '3 West Medical-Surgical ICU',
    unitType: 'ICU',
    // Title 22 counts a charge nurse toward the ratio only while caring for patients, and an ICU
    // charge nurse is kept free of them. Breaks are left at zero: the roster is sized to the floors.
    ratioStaffing: {
      chargeNurseTakesPatients: false,
      breakMinutesPerNurse: 0,
      chargeCoversBreaks: false,
    },
  },
  scheduleWeeks: 6,
  shifts: [
    {
      code: 'D12',
      name: 'Day 12',
      startTime: '07:00',
      durationHours: 12,
      isNight: false,
      color: '#f59e0b',
      censusDelta: 0,
    },
    {
      code: 'N12',
      name: 'Night 12',
      startTime: '19:00',
      durationHours: 12,
      isNight: true,
      color: '#4f46e5',
      censusDelta: 0,
    },
  ],
  roster: icuRoster,
  chargeNurses: { D12: 7, N12: 6 },
  floors: {
    D12: { RN: { min: 6, target: 7 }, CNA: { min: 1, target: 1 } },
    N12: { RN: { min: 6, target: 7 }, CNA: { min: 1, target: 1 } },
  },
  census: {
    beds: 12,
    minimum: 7,
    weekday: [10, 10, 11, 11, 11, 11, 10],
    seasonal: [1, 1, 0, 0, 0, 0, -1, -1, 0, 0, 0, 1],
  },
  tiers: [
    { name: 'ICU (1:2)', careHoursPerPatientDay: 14, share: 0 },
    { name: 'Critical (1:1)', careHoursPerPatientDay: 24, share: 0.18 },
  ],
  ratios: [
    {
      role: 'RN',
      tierLevel: 1,
      max: 2,
      citation: 'Cal. Code Regs. tit. 22, §70217(a)(4): ICU 1:2 or fewer',
    },
    {
      role: 'RN',
      tierLevel: 2,
      max: 1,
      citation: 'Cal. Code Regs. tit. 22, §70217(a)(4): 1:1 when the patient requires it',
    },
  ],
  hppdTarget: 17,
  credentials: {
    aclsPerShift: 4,
    aclsForAllRNs: true,
    specialty: { code: 'CCRN', name: 'Critical Care Registered Nurse', share: 0.5 },
  },
  pay: {
    roleDefault: { RN: 50, CNA: 23 },
    rate: ({ role, employmentType, years }) => {
      if (employmentType === 'agency') return 118;
      const rn = role === 'RN';
      const step = rn ? 50 + 1.3 * Math.min(years, 20) : 23 + 0.45 * Math.min(years, 15);
      return step + (employmentType === 'per_diem' ? (rn ? 8 : 3) : 0);
    },
    raise: { month: 7, percent: 3 },
  },
  differentials: [
    { kind: 'night', mode: 'flat', amount: 6 },
    { kind: 'weekend', mode: 'flat', amount: 3 },
    { kind: 'holiday', mode: 'multiplier', amount: 1.5 },
    { kind: 'charge', mode: 'flat', amount: 3 },
  ],
  overtime: [
    { basis: 'daily', thresholdHours: 12, multiplier: 1.5 },
    { basis: 'weekly', thresholdHours: 40, multiplier: 1.5 },
  ],
  holidays: 'hospital-six',
  rules: { weekend: DEFAULT_WEEKEND },
};

export const DEMO_PROFILES = [COMMUNITY_MED_SURG, VA_SF_MED_SURG, CA_ICU] as const;
