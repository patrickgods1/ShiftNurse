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
 * against 14.
 */
const communityRoster: DemoRosterRow[] = [
  { role: 'RN', ...FULL_12, position: 'D12', count: 12, newGrads: 2 },
  { role: 'RN', ...FULL_12, position: 'N12', count: 10, newGrads: 1 },
  { role: 'RN', ...PART_12, position: 'D12', count: 4 },
  { role: 'RN', ...PART_12, position: 'N12', count: 2 },
  { role: 'RN', ...PER_DIEM, position: 'flex', count: 4 },
  { role: 'RN', ...TRAVEL, position: 'D12', count: 1 },
  { role: 'RN', ...TRAVEL, position: 'N12', count: 1 },
  { role: 'CNA', ...FULL_12, position: 'D12', count: 7 },
  { role: 'CNA', ...FULL_12, position: 'N12', count: 4 },
  { role: 'CNA', ...PART_12, position: 'D12', count: 2 },
  { role: 'CNA', ...PART_12, position: 'N12', count: 1 },
  { role: 'CNA', ...PER_DIEM, position: 'flex', count: 1 },
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

const FULL_8 = { employmentType: 'full_time', fte: 1, contractedHoursPerPeriod: 80 } as const;
const PART_8 = { employmentType: 'part_time', fte: 0.6, contractedHoursPerPeriod: 48 } as const;
/** VA "intermittent" staff: no fixed tour, no hours commitment, the per-diem equivalent. */
const INTERMITTENT = { employmentType: 'per_diem', fte: 0, contractedHoursPerPeriod: 0 } as const;

/**
 * An acute medical-surgical ward modelled on VA practice at a large urban medical center such as
 * San Francisco's (Fort Miley). What sets it apart:
 *
 * - **Tours, not shifts.** Traditional 8-hour day, evening and night tours (07:30, 15:30, 23:30)
 *   worked five a week; full-time is 80 hours a pay period.
 * - **Federal staff mix.** RNs, LVNs (California's LPNs; the VA employs many) and nursing
 *   assistants in team nursing. No agency travelers.
 * - **No legislated ratios.** California's ratio law does not bind a federal facility; VHA
 *   staffs to nursing hours per patient day set by its expert-panel staffing methodology
 *   (VHA Directive 1351), so demand here is the floors and the NHPPD target, not a ratio.
 * - **Title 38 premium pay** (38 U.S.C. §7453): a 10% night differential on any tour with at
 *   least four hours between 6 pm and 6 am — the whole evening and night tours, which is why the
 *   evening tour is flagged as an off-tour here — a 25% premium for any tour touching Saturday
 *   or Sunday, double time on holidays, and overtime after 8 hours in a day or 40 in a week.
 * - **All eleven federal holidays**, Veterans Day included.
 * - **The federal biweekly pay calendar** and four-week schedules.
 * - **Permanent off-tours.** Evening and night staff work five tours in a row, so the rule set
 *   allows five consecutive off-tours where a community unit allows three 12-hour nights.
 *
 * Pay is on the VA Nurse Locality Pay System for RNs (Nurse I–III by experience, San Francisco
 * rates among the highest in the VA) and the General Schedule with the San Francisco locality
 * for LVNs and nursing assistants. The figures are rounded approximations.
 *
 * Floors (24 beds, about 20 patients): days 4 RN, 2 LVN, 2 NA; evenings 4 RN, 1 LVN, 2 NA;
 * nights 3 RN, 1 LVN, 1 NA — 160 nursing hours a day, 8.0 per patient day. Targets, which a
 * manager schedules to when staff are available, add one on most tours.
 */
const vaRoster: DemoRosterRow[] = [
  { role: 'RN', ...FULL_8, position: 'D8', count: 6, newGrads: 2 },
  { role: 'RN', ...FULL_8, position: 'E8', count: 6 },
  { role: 'RN', ...FULL_8, position: 'N8', count: 4 },
  { role: 'RN', ...PART_8, position: 'D8', count: 1 },
  { role: 'RN', ...PART_8, position: 'E8', count: 1 },
  { role: 'RN', ...PART_8, position: 'N8', count: 1 },
  { role: 'RN', ...INTERMITTENT, position: 'flex', count: 2 },
  { role: 'LPN', ...FULL_8, position: 'D8', count: 3 },
  { role: 'LPN', ...FULL_8, position: 'E8', count: 1 },
  { role: 'LPN', ...PART_8, position: 'E8', count: 1 },
  { role: 'LPN', ...FULL_8, position: 'N8', count: 1 },
  { role: 'LPN', ...PART_8, position: 'N8', count: 1 },
  { role: 'LPN', ...INTERMITTENT, position: 'flex', count: 1 },
  { role: 'CNA', ...FULL_8, position: 'D8', count: 3 },
  { role: 'CNA', ...FULL_8, position: 'E8', count: 3 },
  { role: 'CNA', ...PART_8, position: 'E8', count: 1 },
  { role: 'CNA', ...FULL_8, position: 'N8', count: 2 },
  { role: 'CNA', ...PART_8, position: 'N8', count: 1 },
  { role: 'CNA', ...INTERMITTENT, position: 'flex', count: 1 },
];

export const VA_SF_MED_SURG: DemoProfile = {
  id: 'va-sf-med-surg',
  unit: { name: '4A Medicine-Surgery (VA San Francisco sample)', unitType: 'Medical-Surgical' },
  scheduleWeeks: 4,
  // Federal pay period 1 of 2025 began Sunday 12 January; every pay period since is 14 days on.
  payPeriodCycle: isoDate('2025-01-12'),
  shifts: [
    {
      code: 'D8',
      name: 'Day tour',
      startTime: '07:30',
      durationHours: 8,
      isNight: false,
      color: '#f59e0b',
      censusDelta: 0,
    },
    // An off-tour: Title 38 night differential applies to the whole tour.
    {
      code: 'E8',
      name: 'Evening tour',
      startTime: '15:30',
      durationHours: 8,
      isNight: true,
      color: '#f97316',
      censusDelta: 0,
    },
    {
      code: 'N8',
      name: 'Night tour',
      startTime: '23:30',
      durationHours: 8,
      isNight: true,
      color: '#4f46e5',
      censusDelta: -1,
    },
  ],
  roster: vaRoster,
  chargeNurses: { D8: 4, E8: 4, N8: 4 },
  floors: {
    D8: { RN: { min: 4, target: 5 }, LPN: { min: 2, target: 3 }, CNA: { min: 2, target: 3 } },
    E8: { RN: { min: 4, target: 5 }, LPN: { min: 1, target: 2 }, CNA: { min: 2, target: 3 } },
    N8: { RN: { min: 3, target: 4 }, LPN: { min: 1, target: 2 }, CNA: { min: 1, target: 2 } },
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
    { kind: 'night', mode: 'multiplier', amount: 1.1 },
    { kind: 'weekend', mode: 'multiplier', amount: 1.25 },
    { kind: 'holiday', mode: 'multiplier', amount: 2 },
  ],
  overtime: [
    { basis: 'daily', thresholdHours: 8, multiplier: 1.5 },
    { basis: 'weekly', thresholdHours: 40, multiplier: 1.5 },
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
    params: {
      // Five tours on, two off; a permanent evening or night tour is five in a row.
      'max-consecutive-shifts': { maxConsecutiveShifts: 5, maxConsecutiveNights: 5 },
    },
  },
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
  { role: 'RN', ...PER_DIEM, position: 'flex', count: 4 },
  { role: 'RN', ...TRAVEL, position: 'D12', count: 1 },
  { role: 'RN', ...TRAVEL, position: 'N12', count: 1 },
  { role: 'CNA', ...FULL_12, position: 'D12', count: 2 },
  { role: 'CNA', ...FULL_12, position: 'N12', count: 2 },
  { role: 'CNA', ...PART_12, position: 'N12', count: 1 },
  { role: 'CNA', ...PER_DIEM, position: 'flex', count: 1 },
];

export const CA_ICU: DemoProfile = {
  id: 'ca-icu',
  unit: { name: '3 West Medical-Surgical ICU', unitType: 'ICU' },
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
