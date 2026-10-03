/**
 * A nurse's preference in the words a manager would use: "avoids Night 12 (strong)". The weight
 * is 1–5 in the data; on screen it is mild, moderate or strong, which is what the number means.
 */

import type { Id, Preference } from '@shiftnurse/core';

const WEEKDAYS = [
  'Sundays',
  'Mondays',
  'Tuesdays',
  'Wednesdays',
  'Thursdays',
  'Fridays',
  'Saturdays',
];

export function strengthLabel(weight: number): 'mild' | 'moderate' | 'strong' {
  if (weight >= 4) return 'strong';
  if (weight >= 3) return 'moderate';
  return 'mild';
}

export function describePreference(
  pref: Preference,
  shiftTypeNames: ReadonlyMap<Id, string>,
): string {
  const strength = ` (${strengthLabel(pref.weight)})`;
  switch (pref.kind) {
    case 'avoid_shift_type':
      return `avoids ${shiftTypeNames.get(pref.shiftTypeId) ?? 'that shift'}${strength}`;
    case 'prefer_shift_type':
      return `prefers ${shiftTypeNames.get(pref.shiftTypeId) ?? 'another shift'}${strength}`;
    case 'avoid_weekday':
      return `avoids ${WEEKDAYS[pref.weekday]}${strength}`;
    case 'prefer_weekday':
      return `prefers ${WEEKDAYS[pref.weekday]}${strength}`;
    case 'weekend_appetite':
      return `${pref.level < 0 ? 'wants no weekends' : pref.level > 0 ? 'wants weekends' : 'no weekend preference'}${strength}`;
    case 'preferred_block_length':
      return `prefers ${pref.shifts} shifts in a row${strength}`;
  }
}
