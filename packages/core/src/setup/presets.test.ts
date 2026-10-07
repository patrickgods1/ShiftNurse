import { describe, expect, it } from 'vitest';
import { unitKindForUnitType } from './jurisdictions.js';
import {
  ACUITY_PRESETS,
  acuityPresetForUnitType,
  coverageQuickFill,
  SHIFT_PATTERNS,
} from './presets.js';

describe('shift patterns', () => {
  it('offers the classic 12-hour day and night pair', () => {
    expect(
      SHIFT_PATTERNS['12h'].shiftTypes.map((s) => [s.abbreviation, s.startTime, s.durationHours]),
    ).toEqual([
      ['D12', '07:00', 12],
      ['N12', '19:00', 12],
    ]);
  });

  it('offers days, evenings and nights for an 8-hour unit, with only the night flagged', () => {
    const eight = SHIFT_PATTERNS['8h'].shiftTypes;
    expect(eight.map((s) => [s.abbreviation, s.startTime, s.durationHours, s.isNight])).toEqual([
      ['D8', '07:00', 8, false],
      ['E8', '15:00', 8, false],
      ['N8', '23:00', 8, true],
    ]);
  });

  it('gives a unit running both lengths five distinct grid codes', () => {
    const codes = SHIFT_PATTERNS.both.shiftTypes.map((s) => s.abbreviation);
    expect(codes).toEqual(['D12', 'N12', 'D8', 'E8', 'N8']);
  });
});

describe('acuity presets', () => {
  it('starts a med-surg unit at one RN to five routine patients', () => {
    const preset = ACUITY_PRESETS['med-surg'];
    const routine = preset.ratios.find((r) => r.tierLevel === 1);
    expect(routine).toMatchObject({ role: 'RN', maxPatientsPerNurse: 5 });
  });

  it('never lets an ICU nurse carry more than two patients', () => {
    const worst = Math.max(...ACUITY_PRESETS.icu.ratios.map((r) => r.maxPatientsPerNurse));
    expect(worst).toBe(2);
  });

  it('only references tiers the preset defines', () => {
    for (const preset of Object.values(ACUITY_PRESETS)) {
      const levels = new Set(preset.tiers.map((t) => t.level));
      for (const ratio of preset.ratios) expect(levels.has(ratio.tierLevel)).toBe(true);
    }
  });

  it('recognises the unit type a manager typed, whatever the case or wording', () => {
    expect(acuityPresetForUnitType('Medical-Surgical')).toBe('med-surg');
    expect(acuityPresetForUnitType('icu')).toBe('icu');
    expect(acuityPresetForUnitType('Step-down')).toBe('step-down');
    expect(acuityPresetForUnitType('Telemetry')).toBe('telemetry');
    expect(acuityPresetForUnitType('Labor & Delivery')).toBeUndefined();
  });
});

describe('critical care unit names', () => {
  it('treats a CCU, MICU, neuro ICU or PICU as critical care, but a pediatric unit as pediatrics', () => {
    for (const name of ['CCU', 'MICU', 'Neuro ICU', 'PICU']) {
      expect(unitKindForUnitType(name)).toBe('icu');
    }
    expect(unitKindForUnitType('Pediatrics')).toBe('pediatrics');
  });
});

describe('coverageQuickFill', () => {
  const day = { id: 'd12', isOnCall: false };
  const night = { id: 'n12', isOnCall: false };
  const onCall = { id: 'oc', isOnCall: true };

  it('asks for 4 RNs and 1 CNA on every day and night of the week', () => {
    const rows = coverageQuickFill([day, night], { RN: 4, CNA: 1 });
    // 2 shifts × 7 weekdays × 2 roles
    expect(rows).toHaveLength(28);
    const mondayDayRn = rows.find(
      (r) => r.shiftTypeId === 'd12' && r.weekday === 1 && r.role === 'RN',
    );
    expect(mondayDayRn).toEqual({
      shiftTypeId: 'd12',
      weekday: 1,
      date: null,
      role: 'RN',
      minCount: 4,
      targetCount: 4,
    });
  });

  it('leaves on-call shifts and roles with no count alone', () => {
    const rows = coverageQuickFill([day, onCall], { RN: 3, LPN: 0 });
    expect(rows.every((r) => r.shiftTypeId === 'd12' && r.role === 'RN')).toBe(true);
    expect(rows).toHaveLength(7);
  });
});
