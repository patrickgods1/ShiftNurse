/**
 * Most hours worked in any 24 hours.
 *
 * Continuous-hours caps are common in nurse staffing law and contracts, usually as a 16-in-24
 * limit: Massachusetts (M.G.L. c.111 §226) and Washington (RCW 49.28.140) both speak of hours
 * worked in a 24-hour period, and union agreements such as the VA–NNU contract carry their own.
 * This rule applies no statute by itself — which limit binds, if any, is configured per unit
 * (`maxHours`), and it ships off. The limit is about fatigue, so it counts every worked minute,
 * including a holdover recorded day-of (the view's window already ends where the nurse left),
 * and ignores on-call standby. Minimum rest and the weekly cap cannot see it: a day 8 then an
 * evening 8 leave no rest to break and fit any weekly cap, yet a holdover on the evening puts
 * 17 hours in 24, and the schedule looks fine on the grid until it becomes a grievance.
 *
 * The hours in a window `[t, t + 1440)` are a piecewise-linear function of t whose slope only
 * drops when a shift's start enters the window or its end leaves it, so its maximum is attained
 * at t = some shift's start or t = some shift's end − 1440. Those anchors are checked exactly.
 * Overlapping worked windows (a holdover into the next shift) are summed as the overlap rule
 * would flag them anyway, which keeps this the same linear sum the CP-SAT encoder writes.
 *
 * Monotone under removal: dropping a shift can only lower every window's hours, which is what
 * `SolverModel.isLegal` relies on when it re-checks a removal. History is never flagged: a
 * breach is reported only if some shift in it is in the period.
 */

import {
  describeDate,
  formatTimeOfDay,
  fromDayNumber,
  MINUTES_PER_DAY,
  MINUTES_PER_HOUR,
} from '../domain/time.js';
import type { AssignmentView } from '../schedule/view.js';
import { isWorked, nurseName, type Rule, type Violation, violation } from './types.js';

export interface MaxHoursIn24Params {
  /** Most hours a nurse may work in any 24-hour window, holdovers included. */
  maxHours: number;
}

/** "Mon Jan 5 07:00": a minute on the wall-clock timeline, for rule messages. */
function describeMinute(minute: number): string {
  return `${describeDate(fromDayNumber(Math.floor(minute / MINUTES_PER_DAY)))} ${formatTimeOfDay(minute)}`;
}

function hoursText(hours: number): string {
  return `${Math.round(hours * 10) / 10}h`;
}

/** Minutes of a worked window inside `[from, from + 1440)`. */
function overlapMinutes(view: AssignmentView, from: number): number {
  const lo = Math.max(view.window.startMinute, from);
  const hi = Math.min(view.window.endMinute, from + MINUTES_PER_DAY);
  return Math.max(0, hi - lo);
}

export const maxHoursIn24Rule: Rule<MaxHoursIn24Params> = {
  id: 'max-hours-in-24',
  name: 'Most hours in any 24',
  description:
    'Caps the hours a nurse may work in any 24-hour stretch, holdovers included and on-call ' +
    'standby not. Fatigue limits of this kind (often 16 in 24) come from state law and union ' +
    'contracts, so which one applies is set per unit.',
  severity: 'hard',
  category: 'hours',
  scope: 'nurse',
  enabledByDefault: false,
  defaultParams: { maxHours: 16 },
  paramDocs: {
    maxHours: {
      label: 'Most hours in any 24',
      min: 1,
      hint: 'The most hours one nurse may work in any 24 hours in a row, holdovers included.',
      why:
        'A fatigue limit, commonly 16, written into some state laws and union contracts. It ' +
        'counts every worked minute, including time held over past the scheduled end, and not ' +
        'on-call standby. Use the number your law or contract gives; turn the rule off if none applies.',
    },
  },

  evaluate(schedule, params, ctx): Violation[] {
    const violations: Violation[] = [];
    const limit = params.maxHours * MINUTES_PER_HOUR;

    for (const nurse of ctx.nurses) {
      const worked = schedule.timelineFor(nurse.id).filter(isWorked);
      if (worked.length === 0) continue;

      const anchors = new Set<number>();
      for (const v of worked) {
        anchors.add(v.window.startMinute);
        anchors.add(v.window.endMinute - MINUTES_PER_DAY);
      }

      // One finding per distinct set of shifts, at that set's worst window.
      const worst = new Map<string, { minutes: number; from: number; views: AssignmentView[] }>();
      for (const from of anchors) {
        let minutes = 0;
        const touching: AssignmentView[] = [];
        for (const v of worked) {
          if (v.window.startMinute >= from + MINUTES_PER_DAY) break;
          const m = overlapMinutes(v, from);
          if (m === 0) continue;
          minutes += m;
          touching.push(v);
        }
        if (minutes <= limit) continue;
        const inPeriod = touching.filter((v) => v.inPeriod);
        if (inPeriod.length === 0) continue;

        const key = inPeriod
          .map((v) => v.assignment.id)
          .sort()
          .join('|');
        const seen = worst.get(key);
        if (!seen || minutes > seen.minutes) worst.set(key, { minutes, from, views: inPeriod });
      }

      for (const { minutes, from, views } of worst.values()) {
        const hours = minutes / MINUTES_PER_HOUR;
        violations.push(
          violation(
            maxHoursIn24Rule,
            'hard',
            'hours_in_24_exceeded',
            `${nurseName(nurse)} would work ${hoursText(hours)} between ${describeMinute(from)} ` +
              `and ${describeMinute(from + MINUTES_PER_DAY)} — more than ` +
              `${hoursText(params.maxHours)} in 24 hours.`,
            {
              nurseIds: [nurse.id],
              dates: views.map((v) => v.assignment.date),
              assignmentIds: views.map((v) => v.assignment.id),
              details: { hours, maxHours: params.maxHours },
            },
          ),
        );
      }
    }
    return violations;
  },
};
