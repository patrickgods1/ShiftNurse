/**
 * Starting points offered by the assisted first-run setup.
 *
 * A new unit with no shift types, ratios or floors cannot be scheduled at all, and a manager
 * facing six empty editors on day one has no idea what "reasonable" looks like. These are the
 * common shapes — 12-hour days and nights, the familiar ratio for each unit type, a flat floor
 * per shift — offered as one-click choices the manager then edits in the ordinary Settings
 * editors. They are data only: `db/repositories/setup.ts` writes them through the same audited
 * create functions the editors use, so nothing here is a second definition of a shift type.
 *
 * Ratios are *suggestions*, labelled as such in their citation. A patient ratio is a legal or
 * contractual ceiling and the one in force is whatever the manager's state and contract say.
 */

import type { CoverageRequirement, NurseRole, ShiftType } from '../domain/entities.js';
import type { Weekday } from '../domain/time.js';

export type ShiftTypePreset = Pick<
  ShiftType,
  'name' | 'abbreviation' | 'startTime' | 'durationHours' | 'isNight' | 'isOnCall' | 'color'
>;

export type ShiftPatternId = '12h' | '8h' | 'both';

export interface ShiftPattern {
  label: string;
  description: string;
  shiftTypes: readonly ShiftTypePreset[];
}

const D12: ShiftTypePreset = {
  name: 'Day 12',
  abbreviation: 'D12',
  startTime: '07:00',
  durationHours: 12,
  isNight: false,
  isOnCall: false,
  color: '#f59e0b',
};
const N12: ShiftTypePreset = {
  name: 'Night 12',
  abbreviation: 'N12',
  startTime: '19:00',
  durationHours: 12,
  isNight: true,
  isOnCall: false,
  color: '#4f46e5',
};
const D8: ShiftTypePreset = {
  name: 'Day 8',
  abbreviation: 'D8',
  startTime: '07:00',
  durationHours: 8,
  isNight: false,
  isOnCall: false,
  color: '#10b981',
};
const E8: ShiftTypePreset = {
  name: 'Evening 8',
  abbreviation: 'E8',
  startTime: '15:00',
  durationHours: 8,
  isNight: false,
  isOnCall: false,
  color: '#f97316',
};
const N8: ShiftTypePreset = {
  name: 'Night 8',
  abbreviation: 'N8',
  startTime: '23:00',
  durationHours: 8,
  isNight: true,
  isOnCall: false,
  color: '#6366f1',
};

export const SHIFT_PATTERNS: Record<ShiftPatternId, ShiftPattern> = {
  '12h': {
    label: '12-hour days and nights',
    description: '07:00–19:00 and 19:00–07:00.',
    shiftTypes: [D12, N12],
  },
  '8h': {
    label: '8-hour days, evenings and nights',
    description: '07:00–15:00, 15:00–23:00 and 23:00–07:00.',
    shiftTypes: [D8, E8, N8],
  },
  both: {
    label: 'Both 12- and 8-hour shifts',
    description: 'The 12-hour pair plus the three 8-hour shifts.',
    shiftTypes: [D12, N12, D8, E8, N8],
  },
};

export type AcuityPresetId = 'med-surg' | 'telemetry' | 'step-down' | 'icu';

export interface AcuityPreset {
  /** What is stored as the unit's `unitType` when this is chosen. */
  unitType: string;
  tiers: readonly { name: string; level: number; careHoursPerPatientDay: number }[];
  /** `tierLevel` refers to `tiers[].level`; ids do not exist until the tiers are written. */
  ratios: readonly {
    role: NurseRole;
    tierLevel: number;
    maxPatientsPerNurse: number;
    citation: string;
  }[];
  hppdTarget: number;
}

const SUGGESTED = 'Suggested starting point: check your state law and contract';

function tiers(routine: number, moderate: number, high: number): AcuityPreset['tiers'] {
  return [
    { name: 'Routine', level: 1, careHoursPerPatientDay: routine },
    { name: 'Moderate', level: 2, careHoursPerPatientDay: moderate },
    { name: 'High', level: 3, careHoursPerPatientDay: high },
  ];
}

function rnRatios(routine: number, moderate: number, high: number): AcuityPreset['ratios'] {
  return [
    { role: 'RN', tierLevel: 1, maxPatientsPerNurse: routine, citation: SUGGESTED },
    { role: 'RN', tierLevel: 2, maxPatientsPerNurse: moderate, citation: SUGGESTED },
    { role: 'RN', tierLevel: 3, maxPatientsPerNurse: high, citation: SUGGESTED },
  ];
}

export const ACUITY_PRESETS: Record<AcuityPresetId, AcuityPreset> = {
  'med-surg': {
    unitType: 'Medical-Surgical',
    tiers: tiers(4, 6, 9),
    ratios: rnRatios(5, 4, 3),
    hppdTarget: 6.5,
  },
  telemetry: {
    unitType: 'Telemetry',
    tiers: tiers(6, 8, 10),
    ratios: rnRatios(4, 4, 3),
    hppdTarget: 7.5,
  },
  'step-down': {
    unitType: 'Step-down',
    tiers: tiers(8, 10, 12),
    ratios: rnRatios(3, 3, 2),
    hppdTarget: 9,
  },
  icu: {
    unitType: 'ICU',
    tiers: tiers(12, 16, 24),
    ratios: rnRatios(2, 2, 1),
    hppdTarget: 16,
  },
};

const UNIT_TYPE_ALIASES: Record<AcuityPresetId, readonly string[]> = {
  'med-surg': ['medical-surgical', 'medical surgical', 'med-surg', 'med surg', 'medsurg'],
  telemetry: ['telemetry', 'tele'],
  'step-down': ['step-down', 'step down', 'stepdown', 'pcu', 'progressive care'],
  icu: ['icu', 'intensive care', 'critical care'],
};

/** The preset matching a free-text unit type, or `undefined` when none does. */
export function acuityPresetForUnitType(unitType: string): AcuityPresetId | undefined {
  const key = unitType.trim().toLowerCase();
  for (const [id, aliases] of Object.entries(UNIT_TYPE_ALIASES)) {
    if (aliases.includes(key)) return id as AcuityPresetId;
  }
  return undefined;
}

export type CoverageQuickFillRow = Omit<CoverageRequirement, 'id' | 'unitId'>;

const WEEKDAYS: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6];

/**
 * The same floor on every weekday of every worked shift. On-call shifts are skipped: how
 * many nurses stand by is a separate decision from how many work the floor, and a quick-fill
 * of "4 RNs" should not quietly put four people on call every night.
 */
export function coverageQuickFill(
  shiftTypes: readonly Pick<ShiftType, 'id' | 'isOnCall'>[],
  counts: Partial<Record<NurseRole, number>>,
): CoverageQuickFillRow[] {
  const rows: CoverageQuickFillRow[] = [];
  for (const shiftType of shiftTypes) {
    if (shiftType.isOnCall) continue;
    for (const weekday of WEEKDAYS) {
      for (const role of ['RN', 'LPN', 'CNA'] as const) {
        const count = counts[role] ?? 0;
        if (count <= 0) continue;
        rows.push({
          shiftTypeId: shiftType.id,
          weekday,
          date: null,
          role,
          minCount: count,
          targetCount: count,
        });
      }
    }
  }
  return rows;
}
