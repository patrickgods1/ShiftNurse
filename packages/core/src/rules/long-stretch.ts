/**
 * Long stretches of work: a cap on hours worked in a row, and rest owed after a long one.
 *
 * State nurse-overtime laws are not all `max-hours-in-24` or `no-mandatory-overtime`. Massachusetts
 * (M.G.L. c.111 § 226(f)) says a nurse "shall not be allowed to exceed 16 consecutive hours worked
 * in a 24 hour period" and must then get 8 consecutive hours off. Pennsylvania (Act 102 of 2008
 * § 3(d)) gives 10 hours off after more than 12 consecutive hours, mandated or volunteered, which
 * the employee may waive. Illinois (210 ILCS 85/10.9), Maine (26 M.R.S. § 603(5)) and New Hampshire
 * (RSA 275:67) require rest only after *mandated* long stretches. Alaska (AS 18.20.400(c)) limits
 * voluntary overtime to 14 consecutive hours. A 24-hour window cannot say "stretch", and the
 * overtime rule's consecutive limit only judges a required holdover against §7459(a)'s numbers, so
 * without this rule a nurse held to 17 hours, or sent home for seven hours of rest where the state
 * owes eight, reads as compliant on the grid and surfaces as a complaint to the state.
 *
 * A stretch is `workedStretches`' unit: shifts worked with no break between them, holdovers
 * included, on-call standby excluded; its hours are the span on the clock. Two optional limits
 * judge it, and neither has a default number (a preset supplies them; a default would add a limit
 * some states do not have, so a newly enabled rule judges nothing until one is set):
 *
 * - the cap on consecutive hours, which a recorded emergency may excuse (`emergencyLiftsCap`);
 * - the rest owed after a stretch reaching `restAfterHours` (or passing it, `restOnlyPastThreshold`)
 *   before the next one starts. An emergency never excuses the rest — the statutes owe it
 *   precisely after emergency mandated work — but a nurse's written waiver may, where the law
 *   lets the employee waive (`honorsRestWaiver`), keyed on the date of the later stretch's first
 *   shift exactly as the minimum-rest rule keys it.
 *
 * `requiredOnly` restricts both checks to stretches holding a required item: a mandated holdover,
 * or overtime nobody volunteered for. That is how the "mandated" statutes read; the others judge
 * every stretch. Generate cannot breach the required kinds (no holdover or overtime row is ever
 * written), so the solvers meet them only through the all-hours reading.
 *
 * Not monotone under removal: taking the middle shift out of a stretch can leave a long first part
 * followed too soon by the last. `SolverModel.isLegal` re-checks every enabled nurse-scope hard
 * rule for a nurse who lost a shift, this one included, so a removal that creates such a breach is
 * refused. History is never flagged: a cap breach is reported only if a shift in the stretch is in
 * the period, a rest breach only if one in either stretch is.
 */

import {
  describeDate,
  formatTimeOfDay,
  fromDayNumber,
  MINUTES_PER_DAY,
  MINUTES_PER_HOUR,
} from '../domain/time.js';
import { type WorkedStretch, workedStretches } from '../schedule/holdover.js';
import type { AssignmentView } from '../schedule/view.js';
import { isEmergency, volunteeredOn } from './mandatory-overtime.js';
import { restWaivedOn } from './rest-rules.js';
import { nurseName, type Rule, type RuleContext, type Violation, violation } from './types.js';

export interface LongStretchParams {
  /** Judge only stretches holding a required holdover or unvolunteered overtime. */
  requiredOnly: boolean;
  /** The most hours in one stretch. Absent: no cap. */
  maxConsecutiveHours?: number;
  /** Whether a recorded emergency on a shift in the stretch excuses the cap. */
  emergencyLiftsCap: boolean;
  /** Hours of stretch that earn rest. Absent: no rest is owed. */
  restAfterHours?: number;
  /** Rest is owed only after a stretch longer than `restAfterHours`, not one of exactly that. */
  restOnlyPastThreshold: boolean;
  /** Hours off owed between the end of a long stretch and the next shift. */
  restHours: number;
  /** Whether a nurse's recorded rest waiver excuses the rest. */
  honorsRestWaiver: boolean;
}

/** "Mon Jan 5 07:00": a minute on the wall-clock timeline, for rule messages. */
function describeMinute(minute: number): string {
  return `${describeDate(fromDayNumber(Math.floor(minute / MINUTES_PER_DAY)))} ${formatTimeOfDay(minute)}`;
}

function hoursText(hours: number): string {
  return `${Math.round(hours * 10) / 10}h`;
}

function isRequired(view: AssignmentView, ctx: RuleContext): boolean {
  const a = view.assignment;
  if ((a.holdoverMinutes ?? 0) > 0 && a.holdoverMandated === true) return true;
  return a.isOvertime && !volunteeredOn(ctx, a.nurseId, a.date);
}

export const longStretchRule: Rule<LongStretchParams> = {
  id: 'long-stretch',
  name: 'Long stretches of work',
  description:
    'Caps the hours a nurse may work in a row, holdovers included and on-call standby not, and ' +
    'requires time off after a long stretch before the next shift. State laws differ: ' +
    'Massachusetts caps 16 hours and wants 8 off, Pennsylvania wants 10 off after more than 12, ' +
    'and others only count hours the nurse was required to work. Set the numbers your law gives.',
  severity: 'hard',
  category: 'hours',
  scope: 'nurse',
  enabledByDefault: false,
  defaultParams: {
    requiredOnly: false,
    emergencyLiftsCap: true,
    restOnlyPastThreshold: false,
    restHours: 10,
    honorsRestWaiver: false,
  },
  paramDocs: {
    requiredOnly: {
      label: 'Only judge hours the nurse was required to work',
      hint: 'A stretch counts only if it holds a required holdover or overtime the nurse did not volunteer for.',
      why:
        'Some states (Illinois, Maine, New Hampshire) limit only mandated work; others (Massachusetts, ' +
        'Pennsylvania) limit every hour. Leave this off unless your law speaks of required hours only.',
    },
    maxConsecutiveHours: {
      label: 'Most consecutive hours',
      hint: 'Leave blank for no cap on a stretch.',
      why:
        'Massachusetts says 16 consecutive hours, Alaska 14 for voluntary overtime. The stretch is ' +
        'every shift worked with no break between, holdovers included, not on-call standby.',
      optional: true,
      min: 1,
    },
    emergencyLiftsCap: {
      label: 'A recorded emergency excuses the cap',
      hint: 'A shift in the stretch whose notes begin "Emergency:" lets it pass the cap.',
      why:
        'Most statutes leave out an emergency such as a declared disaster. Turn this off if yours ' +
        'allows none. It never excuses the rest owed afterwards.',
    },
    restAfterHours: {
      label: 'Rest is owed after a stretch of',
      hint: 'Hours worked in a row that earn time off. Leave blank for no rest rule.',
      why:
        'Massachusetts owes 8 hours off after 16 worked; Pennsylvania 10 off after more than 12. ' +
        'The rest comes from the end of the stretch, holdover included, to the next shift.',
      optional: true,
      min: 1,
    },
    restOnlyPastThreshold: {
      label: 'Only after more than that many hours',
      hint: 'Off: a stretch of exactly that long earns the rest. On: it must run longer.',
      why: 'Pennsylvania says "more than 12", so a plain 12-hour shift owes nothing.',
    },
    restHours: {
      label: 'Hours off owed',
      hint: 'The least time between the end of the long stretch and the next shift.',
      why: 'The number your law gives: 8 in Massachusetts, 10 in Pennsylvania.',
      min: 1,
    },
    honorsRestWaiver: {
      label: 'A rest waiver excuses the rest',
      hint: 'A written waiver (Roster › Rest waivers) dated on the next shift lets it start early.',
      why:
        'Pennsylvania lets the employee waive the rest. Leave this off where the law does not, ' +
        'or a waiver would excuse what the manager cannot.',
    },
  },

  evaluate(schedule, params, ctx): Violation[] {
    const violations: Violation[] = [];
    const cap = params.maxConsecutiveHours;
    const threshold = params.restAfterHours;
    if (cap === undefined && threshold === undefined) return violations;

    for (const nurse of ctx.nurses) {
      const stretches: WorkedStretch<AssignmentView>[] = workedStretches(
        schedule.timelineFor(nurse.id),
      );
      for (let i = 0; i < stretches.length; i++) {
        const stretch = stretches[i]!;
        if (params.requiredOnly && !stretch.views.some((v) => isRequired(v, ctx))) continue;
        const inPeriod = stretch.views.some((v) => v.inPeriod);
        const span = `${describeMinute(stretch.window.startMinute)} to ${describeMinute(stretch.window.endMinute)}`;
        const parts = {
          nurseIds: [nurse.id],
          dates: stretch.views.map((v) => v.assignment.date),
          assignmentIds: stretch.views.map((v) => v.assignment.id),
        };

        if (
          cap !== undefined &&
          inPeriod &&
          stretch.hours > cap &&
          !(params.emergencyLiftsCap && stretch.views.some((v) => isEmergency(v.assignment)))
        ) {
          violations.push(
            violation(
              longStretchRule,
              'hard',
              'long_stretch',
              `${nurseName(nurse)} would work ${hoursText(stretch.hours)} straight, ${span} — more ` +
                `than ${hoursText(cap)} in a row.`,
              { ...parts, details: { stretchHours: stretch.hours, maxConsecutiveHours: cap } },
            ),
          );
        }

        const next = stretches[i + 1];
        const earnsRest =
          threshold !== undefined &&
          (params.restOnlyPastThreshold ? stretch.hours > threshold : stretch.hours >= threshold);
        if (!earnsRest || !next) continue;
        const offMinutes = next.window.startMinute - stretch.window.endMinute;
        if (offMinutes >= params.restHours * MINUTES_PER_HOUR) continue;
        if (!inPeriod && !next.views.some((v) => v.inPeriod)) continue;
        const later = next.views[0]!.assignment;
        if (params.honorsRestWaiver && restWaivedOn(ctx, nurse.id, later.date)) continue;
        const hoursOff = offMinutes / MINUTES_PER_HOUR;
        violations.push(
          violation(
            longStretchRule,
            'hard',
            'rest_after_long_stretch',
            `${nurseName(nurse)} has only ${hoursText(hoursOff)} off after ${hoursText(stretch.hours)} ` +
              `straight (${span}) before the shift starting ${describeMinute(next.window.startMinute)}. ` +
              `${hoursText(params.restHours)} required.`,
            {
              ...parts,
              dates: [...parts.dates, later.date],
              assignmentIds: [...parts.assignmentIds, later.id],
              details: { stretchHours: stretch.hours, restHours: params.restHours, hoursOff },
            },
          ),
        );
      }
    }
    return violations;
  },
};
