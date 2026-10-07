import { describe, expect, it } from 'vitest';
import { describePreference, strengthLabel } from './preferences.js';

const names = new Map([['n12', 'Night 12']]);

describe('preferences in words', () => {
  it('reads weight 5 as strong and 1 as mild', () => {
    expect(strengthLabel(5)).toBe('strong');
    expect(strengthLabel(3)).toBe('moderate');
    expect(strengthLabel(1)).toBe('mild');
  });

  it('says what each kind of preference asks for', () => {
    const base = { id: 'p', nurseId: 'n', weight: 5 };
    expect(
      describePreference({ ...base, kind: 'avoid_shift_type', shiftTypeId: 'n12' }, names),
    ).toBe('avoids Night 12 (strong)');
    expect(describePreference({ ...base, kind: 'avoid_weekday', weekday: 1 }, names)).toBe(
      'avoids Mondays (strong)',
    );
    expect(describePreference({ ...base, kind: 'weekend_appetite', level: -1 }, names)).toBe(
      'wants no weekends (strong)',
    );
    expect(
      describePreference(
        { ...base, kind: 'holiday_appetite', holidayId: 'h-xmas', weight: 3 },
        names,
        new Map([['h-xmas', 'Christmas Day']]),
      ),
    ).toBe('wants to work Christmas Day (moderate)');
  });
});
