/**
 * Next year's holidays, proposed from this year's: the same names, the same major/minor split,
 * the same pairings, on next year's dates.
 *
 * Each year's holidays are their own rows, so without this a manager re-types the list every
 * year — and every re-typing is a chance to break what the rotation depends on: "Xmas" instead
 * of last year's "Christmas Day" (the rotation matches by name, see `previousOccurrence`), a
 * minor holiday left unpaired, Memorial Day on the wrong Monday. Rolling forward keeps names
 * exact and pairings intact; the manager reviews and edits the proposal before anything is saved.
 *
 * Dates: a holiday named like a US federal one takes that holiday's date in the new year (the
 * floating ones move: Thanksgiving is a Thursday, not the 26th); anything else keeps its month
 * and day, with 29 February becoming the 28th. A unit's own floating holiday (Easter, a
 * "second Friday" picnic) cannot be inferred from one date, which is why the proposal is
 * editable. With no year before to copy, the proposal is the federal list.
 *
 * Pairings: a copied minor holiday pairs with the new occurrence of its partner — in the plan,
 * or already on the list. A pair across the year end (New Year's Eve with the next day's New
 * Year's Day) can only be completed once that next year exists, so the plan also re-pairs last
 * year's minors whose partner is being added now, and says which new pairs must wait.
 */

import type { Holiday, Id } from '../domain/entities.js';
import { compareDates, type IsoDate, isoDate } from '../domain/time.js';
import { holidayNameKey, previousOccurrence } from '../rules/holiday-rotation.js';
import { usFederalHolidays } from './holidays.js';

/** The major holiday a minor one pairs with: one already on the list, or one in the plan. */
export type PairTarget = { holidayId: Id } | { key: string };

export interface PlannedHoliday {
  /** Identifies the row within the plan, so pairings can point at rows not saved yet. */
  key: string;
  date: IsoDate;
  name: string;
  isMajor: boolean;
  pairWith: PairTarget | null;
  /** Last year's holiday it continues, or the federal list. */
  from: { holidayId: Id } | 'federal';
}

export interface HolidayYearPlan {
  year: number;
  holidays: PlannedHoliday[];
  /** Minor holidays already on the list that can now pair with a holiday being added. */
  repairs: { minorId: Id; pairWith: PairTarget }[];
  /** Last year's holidays not proposed, and why. */
  skipped: { name: string; reason: string }[];
  /** New minor holidays whose partner is in a year not on the list yet. */
  unpaired: { name: string; partner: string; year: number }[];
}

function yearOf(date: IsoDate): number {
  return Number(date.slice(0, 4));
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** The same month and day in `year`; 29 February becomes the 28th in a common year. */
function sameDayIn(date: IsoDate, year: number): IsoDate {
  const monthDay = date.slice(5);
  const safe = monthDay === '02-29' && !isLeapYear(year) ? '02-28' : monthDay;
  return isoDate(`${String(year).padStart(4, '0')}-${safe}`);
}

/**
 * Who a minor holiday pairs with, as a name and a year offset: its own pairing, or — when it
 * has none because its partner was in a year not yet added — the pairing of last year's
 * occurrence, but only a pair that reached into the next year. A minor holiday the manager left
 * unpaired within its own year stays unpaired.
 */
function pairingTemplate(
  minor: Holiday,
  byId: ReadonlyMap<Id, Holiday>,
  holidays: readonly Holiday[],
): { name: string; offset: number } | undefined {
  const own = minor.pairedHolidayId === null ? undefined : byId.get(minor.pairedHolidayId);
  if (own) return { name: own.name, offset: yearOf(own.date) - yearOf(minor.date) };
  const previous = previousOccurrence(minor, holidays);
  const partner =
    previous?.pairedHolidayId == null ? undefined : byId.get(previous.pairedHolidayId);
  if (!previous || !partner) return undefined;
  const offset = yearOf(partner.date) - yearOf(previous.date);
  return offset > 0 ? { name: partner.name, offset } : undefined;
}

export function planHolidayYear(holidays: readonly Holiday[], year: number): HolidayYearPlan {
  const byId = new Map(holidays.map((h) => [h.id, h]));
  const inYear = (y: number) => holidays.filter((h) => yearOf(h.date) === y);
  const target = inYear(year);
  const takenDates = new Set(target.map((h) => h.date));
  const takenNames = new Map(target.map((h) => [holidayNameKey(h.name), h]));
  const federal = new Map(usFederalHolidays(year).map((f) => [holidayNameKey(f.name), f]));
  const source = inYear(year - 1).sort((a, b) => compareDates(a.date, b.date));

  const plan: HolidayYearPlan = { year, holidays: [], repairs: [], skipped: [], unpaired: [] };
  const plannedByName = new Map<string, PlannedHoliday>();

  const propose = (
    name: string,
    date: IsoDate,
    isMajor: boolean,
    from: PlannedHoliday['from'],
  ): PlannedHoliday | undefined => {
    const key = holidayNameKey(name);
    if (takenNames.has(key)) {
      plan.skipped.push({ name, reason: `${year} already has it` });
      return undefined;
    }
    if (takenDates.has(date)) {
      plan.skipped.push({ name, reason: `another holiday is already on ${date}` });
      return undefined;
    }
    const row: PlannedHoliday = { key: `new:${key}`, date, name, isMajor, pairWith: null, from };
    takenDates.add(date);
    plannedByName.set(key, row);
    plan.holidays.push(row);
    return row;
  };

  if (source.length === 0) {
    for (const f of usFederalHolidays(year)) propose(f.name, f.date, f.isMajor, 'federal');
  } else {
    const copies: [Holiday, PlannedHoliday][] = [];
    for (const s of source) {
      const date = federal.get(holidayNameKey(s.name))?.date ?? sameDayIn(s.date, year);
      const row = propose(s.name, date, s.isMajor, { holidayId: s.id });
      if (row) copies.push([s, row]);
    }
    // Pair each copied minor with its partner's new occurrence, wherever that is.
    for (const [s, row] of copies) {
      if (row.isMajor) continue;
      const template = pairingTemplate(s, byId, holidays);
      if (!template) continue;
      const partnerYear = year + template.offset;
      const partnerKey = holidayNameKey(template.name);
      const inPlan = partnerYear === year ? plannedByName.get(partnerKey) : undefined;
      const onList = inYear(partnerYear).find(
        (h) => h.isMajor && holidayNameKey(h.name) === partnerKey,
      );
      if (inPlan?.isMajor) row.pairWith = { key: inPlan.key };
      else if (onList) row.pairWith = { holidayId: onList.id };
      else plan.unpaired.push({ name: row.name, partner: template.name, year: partnerYear });
    }
  }

  // Minors already on the list whose partner is only now being added (New Year's Eve).
  for (const minor of holidays) {
    if (minor.isMajor || minor.pairedHolidayId !== null) continue;
    const template = pairingTemplate(minor, byId, holidays);
    if (!template || yearOf(minor.date) + template.offset !== year) continue;
    const partner = plannedByName.get(holidayNameKey(template.name));
    if (partner?.isMajor) plan.repairs.push({ minorId: minor.id, pairWith: { key: partner.key } });
  }

  plan.holidays.sort((a, b) => compareDates(a.date, b.date));
  return plan;
}
