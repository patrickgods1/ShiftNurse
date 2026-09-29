/**
 * The Holidays tab's small judgements, kept out of the component so they are tested: the order
 * major holidays are offered in when pairing a minor one, and what each kind of holiday pays,
 * stated the way the cost engine will price it.
 */

import type {
  Differential,
  Holiday,
  HolidayRotationParams,
  HolidayYearPlan,
  IsoDate,
  RuleSet,
} from '@shiftnurse/core';
import {
  daysBetween,
  holidayRotationRule,
  previousOccurrence,
  resolveConfigs,
} from '@shiftnurse/core';
import type { HolidayYearInput } from '../../../../../shared/api.js';
import { formatDollars } from '../../../money.js';

/**
 * Every major holiday a minor one may pair with, nearest first: any pairing is the manager's
 * to choose (Memorial Day with Thanksgiving splits a year), but the nearest is usually meant.
 */
export function pairCandidates(minor: Holiday, holidays: readonly Holiday[]): Holiday[] {
  return holidays
    .filter((h) => h.isMajor)
    .sort(
      (a, b) =>
        Math.abs(daysBetween(minor.date, a.date)) - Math.abs(daysBetween(minor.date, b.date)) ||
        a.date.localeCompare(b.date),
    );
}

function describeAmount(d: Differential): string {
  return d.mode === 'flat' ? `+${formatDollars(d.amount, { cents: true })}/h` : `×${d.amount}`;
}

/** What a major and a minor holiday shift earn, as the cost engine applies it. */
export function describeHolidayPay(differentials: readonly Differential[]): {
  major: string;
  minor: string;
} {
  const holiday = differentials.find((d) => d.kind === 'holiday' && d.active);
  const major = differentials.find((d) => d.kind === 'major_holiday' && d.active);
  const minor = holiday ? `${describeAmount(holiday)} (holiday premium)` : 'no premium';
  return {
    major: major
      ? `${describeAmount(major)} (major holiday premium)`
      : holiday
        ? `${describeAmount(holiday)}, the holiday premium (no major premium set)`
        : 'no premium',
    minor,
  };
}

/** The rule set's holiday rotation, or undefined when the rule is off. */
export function rotationSettings(ruleSet: RuleSet): HolidayRotationParams | undefined {
  const config = resolveConfigs(ruleSet).find((c) => c.ruleId === holidayRotationRule.id);
  if (!config?.enabled) return undefined;
  return config.params as unknown as HolidayRotationParams;
}

/** What the manager changed about one proposed holiday. */
export interface PlanEdit {
  include?: boolean;
  date?: IsoDate;
  name?: string;
  isMajor?: boolean;
}

/**
 * The plan as the manager left it. A minor holiday pairs only with a major one being added (or
 * already on the list): leaving its partner out, or making the partner minor, unpairs it here
 * rather than letting the save fail on a pairing that points at nothing.
 */
export function applyPlanEdits(
  plan: HolidayYearPlan,
  edits: Readonly<Record<string, PlanEdit>>,
  repairsKept: (minorId: string) => boolean = () => true,
): HolidayYearInput {
  const rows = plan.holidays
    .filter((p) => edits[p.key]?.include !== false)
    .map((p) => ({
      key: p.key,
      date: edits[p.key]?.date ?? p.date,
      name: edits[p.key]?.name ?? p.name,
      isMajor: edits[p.key]?.isMajor ?? p.isMajor,
      pairWith: p.pairWith,
    }));
  const majorKeys = new Set(rows.filter((r) => r.isMajor).map((r) => r.key));
  const valid = (target: HolidayYearInput['holidays'][number]['pairWith']) =>
    target !== null && ('holidayId' in target || majorKeys.has(target.key));
  return {
    holidays: rows.map((r) => ({
      ...r,
      pairWith: !r.isMajor && valid(r.pairWith) ? r.pairWith : null,
    })),
    repairs: plan.repairs.filter((r) => repairsKept(r.minorId) && valid(r.pairWith)),
  };
}

export type LastYearStatus =
  | { kind: 'continues'; previous: Holiday }
  | { kind: 'no-match' }
  | { kind: 'first-year' };

/**
 * Which of last year's holidays this one continues, for the rotation. "No match" only when the
 * year before has holidays at all — the first year the unit has holidays has nothing to continue.
 */
export function lastYearStatus(holiday: Holiday, all: readonly Holiday[]): LastYearStatus {
  const previous = previousOccurrence(holiday, all);
  if (previous) return { kind: 'continues', previous };
  // Last year's list exists when the calendar year before has any holiday. A distance test
  // would call January of the same year "last year" for a holiday in November.
  const previousYear = String(Number(holiday.date.slice(0, 4)) - 1);
  const lastYearOnList = all.some((h) => h.date.startsWith(previousYear));
  return lastYearOnList ? { kind: 'no-match' } : { kind: 'first-year' };
}
