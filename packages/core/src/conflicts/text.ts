/**
 * Wording helpers for conflict and resolution text.
 *
 * These sentences are read aloud in staffing huddles and quoted in audit entries, so they name
 * the weekday, the nurse and the numbers the way a unit talks ("Sat Jan 10 N12 RN"), and they
 * never depend on the host locale — two machines must print the same conflict identically.
 * Date parts are split from the ISO string; the weekday comes from core's `weekdayOf`, never
 * from a local-timezone `Date`.
 */

import type { Nurse, TimeOffType } from '../domain/entities.js';
import { describeDate, type IsoDate } from '../domain/time.js';
import { nurseName } from '../rules/types.js';

/** "Sat Jan 10" — the one date style rule messages, alerts and conflicts share. */
export function dayLabel(date: IsoDate): string {
  return describeDate(date);
}

/** "$1,234" — rounded to the dollar, sign kept, no locale involved. */
export function dollars(amount: number): string {
  const rounded = Math.round(Math.abs(amount));
  const digits = String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${amount < 0 ? '-' : ''}$${digits}`;
}

/** "+2.5" / "-0.4" / "0", one decimal. */
export function signed(value: number, decimals = 1): string {
  const fixed = value.toFixed(decimals);
  if (Number(fixed) === 0) return '0';
  return value > 0 ? `+${fixed}` : fixed;
}

export function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : pluralNoun}`;
}

/** "Priya Nair, Ana Cruz and Tom Reed". */
export function nameList(nurses: readonly Nurse[]): string {
  const names = nurses.map(nurseName);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function leaveLabel(type: TimeOffType): string {
  switch (type) {
    case 'pto':
      return 'PTO';
    case 'sick':
      return 'sick leave';
    case 'fmla':
      return 'FMLA leave';
    case 'unpaid':
      return 'unpaid leave';
    case 'education':
      return 'education leave';
    case 'bereavement':
      return 'bereavement leave';
    case 'annual':
      return 'annual leave';
    case 'court':
      return 'court leave';
    case 'military':
      return 'military leave';
    case 'parental':
      return 'paid parental leave';
    case 'lwop':
      return 'leave without pay';
    case 'comp':
      return 'comp time';
    case 'state_family':
      return 'state family leave';
    case 'pregnancy_disability':
      return 'pregnancy disability leave';
  }
}

export { nurseName };
