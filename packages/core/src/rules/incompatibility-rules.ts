/**
 * Nurses who should not work together — judged by the hours they share on the floor.
 *
 * A manager keeps some people apart: a personality clash, an open HR investigation, a former
 * couple. The problem is often a group, not a pair, so each `IncompatibilityGroup` says how many
 * of its members may overlap at once (`maxTogether`). Two rules read the groups:
 *
 * - **Together** (soft): more members on the floor at once than the group allows. Soft because
 *   a manager short of staff may knowingly accept it; the solver prices it and avoids it.
 * - **Unbuffered** (hard): whenever two or more members of a group do overlap, at least
 *   `minOutsideStaff` people from outside the group must be on the floor too, so incompatible
 *   nurses are never left to run the unit between them. It is not gated by the solver — taking
 *   an outside nurse away can break it, just as it can break a coverage floor — but priced like
 *   a staffing shortfall and reported if anything is left short.
 *
 * "On the floor together" is by the hour (`schedule/overlap.ts`), and a group applies to the
 * shifts dated inside its `startsOn`–`endsOn`, as leave does. Both rules are shift scope: their
 * verdict for a shift reads that shift's roster and the rosters overlapping its hours. On a
 * partial view they judge only the hours of the view's dates and `ctx.shiftTypes`, so a
 * simulation that hands them one shift plus everyone overlapping it gets that shift's answer.
 *
 * The group's reason is never written into a violation: violation text appears on the grid, in
 * exports and in grievances, and the reason is HR's business.
 */

import type { Id, IncompatibilityGroup } from '../domain/entities.js';
import {
  compareDates,
  formatTimeOfDay,
  fromDayNumber,
  type IsoDate,
  MINUTES_PER_DAY,
  MINUTES_PER_HOUR,
  type ShiftWindow,
  shiftWindow,
} from '../domain/time.js';
import { type FloorSegment, floorSegments } from '../schedule/overlap.js';
import type { AssignmentView, ScheduleView } from '../schedule/view.js';
import { type Rule, type RuleContext, type Violation, violation } from './types.js';

/** Whether a group applies to a shift dated `date`. */
export function groupInForce(group: IncompatibilityGroup, date: IsoDate): boolean {
  if (group.startsOn !== undefined && compareDates(date, group.startsOn) < 0) return false;
  if (group.endsOn !== undefined && compareDates(date, group.endsOn) > 0) return false;
  return true;
}

/** Whether a group applies to any shift dated in `[start, end]`. */
export function groupInForceDuring(
  group: IncompatibilityGroup,
  start: IsoDate,
  end: IsoDate,
): boolean {
  return (
    (group.startsOn === undefined || compareDates(group.startsOn, end) <= 0) &&
    (group.endsOn === undefined || compareDates(group.endsOn, start) >= 0)
  );
}

/** One person's shift on the floor, as the verdict needs it. */
export interface OnFloor {
  nurseId: Id;
  /** The shift's date, which decides whether a group applies to it. */
  date: IsoDate;
}

/** A group's standing over one stretch of the floor, when something is wrong with it. */
export interface GroupVerdict {
  group: IncompatibilityGroup;
  /** Indexes into the floor of the members the group applies to. */
  members: number[];
  /** Members beyond `maxTogether`. */
  excess: number;
  /** People on the floor from outside the group. */
  outside: number;
  /** Outside staff missing while two or more members overlap. */
  shortfall: number;
}

/**
 * The one verdict every consumer shares — the rules, `SolverModel` and, term for term, the
 * CP-SAT objective. Counts shifts, not distinct people: a nurse booked on two overlapping shifts
 * is already a hard violation of its own. Groups with nothing wrong are left out.
 */
export function judgeFloor(
  floor: readonly OnFloor[],
  groups: readonly IncompatibilityGroup[],
  minOutsideStaff: number,
): GroupVerdict[] {
  const out: GroupVerdict[] = [];
  for (const group of groups) {
    const members: number[] = [];
    for (const [i, entry] of floor.entries()) {
      if (group.nurseIds.includes(entry.nurseId) && groupInForce(group, entry.date)) {
        members.push(i);
      }
    }
    if (members.length < 2) continue;
    const excess = Math.max(0, members.length - group.maxTogether);
    const outside = floor.length - members.length;
    const shortfall = Math.max(0, minOutsideStaff - outside);
    if (excess > 0 || shortfall > 0) out.push({ group, members, excess, outside, shortfall });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

export interface IncompatibleBufferParams {
  /** People from outside the group who must be on the floor while members overlap. */
  minOutsideStaff: number;
}

export const incompatibleTogetherRule: Rule<Record<string, never>> = {
  id: 'incompatible-staff-cap',
  name: 'Incompatible staff kept apart',
  description:
    'Nurses the manager has grouped as not to work together are not on the floor at the same ' +
    'time, beyond the number the group allows. Judged by the hours they share, so a mid shift ' +
    'overlapping a day shift counts. Groups and their dates are kept on the Roster page.',
  severity: 'soft',
  category: 'safety',
  scope: 'shift',
  defaultParams: {},
  paramDocs: {},

  evaluate(schedule, _params, ctx): Violation[] {
    return findings(schedule, ctx, 0)
      .filter((f) => f.excess > 0)
      .map((f) =>
        violation(
          incompatibleTogetherRule,
          'soft',
          'incompatible_staff_together',
          `${names(f.members)} are on the floor together ${span(f.startMinute, f.endMinute)}; ` +
            `at most ${f.group.maxTogether} of this group should work at once.`,
          {
            ...parts(f),
            details: {
              ...common(f),
              onTogether: f.members.length,
              maxTogether: f.group.maxTogether,
              excess: f.excess,
            },
          },
        ),
      );
  },
};

export const incompatibleBufferRule: Rule<IncompatibleBufferParams> = {
  id: 'incompatible-staff-buffer',
  name: 'Outside staff with incompatible nurses',
  description:
    'Whenever nurses grouped as not to work together do overlap, enough staff from outside the ' +
    'group are on the floor with them for every shared hour, so they never run the unit between ' +
    'them.',
  severity: 'hard',
  category: 'safety',
  scope: 'shift',
  defaultParams: { minOutsideStaff: 2 },
  paramDocs: {
    minOutsideStaff: {
      label: 'Others on the floor with them',
      hint: 'People from outside the group who must be on the floor whenever members overlap.',
      why:
        'Two means they are never the only ones running the unit together. Raise it for a ' +
        'tense situation; lower it if the unit is small and the pair rarely overlaps anyway.',
    },
  },

  evaluate(schedule, params, ctx): Violation[] {
    return findings(schedule, ctx, params.minOutsideStaff)
      .filter((f) => f.shortfall > 0)
      .map((f) =>
        violation(
          incompatibleBufferRule,
          'hard',
          'incompatible_staff_unbuffered',
          `${names(f.members)} overlap ${span(f.startMinute, f.endMinute)} with ${f.outside} ` +
            `other staff on the floor; ${params.minOutsideStaff} required.`,
          {
            ...parts(f),
            details: {
              ...common(f),
              outside: f.outside,
              required: params.minOutsideStaff,
              shortfall: f.shortfall,
            },
          },
        ),
      );
  },
};

// ---------------------------------------------------------------------------
// Findings: verdicts per stretch, merged into what a manager would call one problem
// ---------------------------------------------------------------------------

interface Finding {
  group: IncompatibilityGroup;
  startMinute: number;
  endMinute: number;
  members: AssignmentView[];
  excess: number;
  outside: number;
  shortfall: number;
}

/**
 * Every group's verdict over the hours the view judges, with neighbouring stretches merged when
 * the same members are on and the numbers are the same: a shared day 12 is one problem, even
 * though an evening 8 starting at 15:00 cuts it in two. Stretches whose members are all in the
 * lookback tail are history and are left out.
 */
function findings(schedule: ScheduleView, ctx: RuleContext, minOutsideStaff: number): Finding[] {
  if (ctx.incompatibilityGroups.length === 0) return [];
  const out: Finding[] = [];
  const open = new Map<Id, Finding>();
  for (const segment of segmentsFor(schedule, ctx)) {
    const verdicts = judgeFloor(
      segment.on.map((v) => ({ nurseId: v.nurse.id, date: v.assignment.date })),
      ctx.incompatibilityGroups,
      minOutsideStaff,
    );
    const seen = new Set<Id>();
    for (const verdict of verdicts) {
      const members = verdict.members.map((i) => segment.on[i]!);
      if (!members.some((v) => v.inPeriod)) continue;
      seen.add(verdict.group.id);
      const run = open.get(verdict.group.id);
      if (
        run &&
        run.endMinute === segment.startMinute &&
        run.excess === verdict.excess &&
        run.outside === verdict.outside &&
        run.shortfall === verdict.shortfall &&
        sameAssignments(run.members, members)
      ) {
        run.endMinute = segment.endMinute;
        continue;
      }
      if (run) out.push(run);
      open.set(verdict.group.id, {
        group: verdict.group,
        startMinute: segment.startMinute,
        endMinute: segment.endMinute,
        members,
        excess: verdict.excess,
        outside: verdict.outside,
        shortfall: verdict.shortfall,
      });
    }
    for (const [id, run] of open) {
      if (seen.has(id)) continue;
      out.push(run);
      open.delete(id);
    }
  }
  out.push(...open.values());
  return out.sort((a, b) => a.startMinute - b.startMinute || a.group.id.localeCompare(b.group.id));
}

/** Both rules walk the same stretches; built once per view and rule context. */
const SEGMENTS = new WeakMap<ScheduleView, WeakMap<RuleContext, FloorSegment<AssignmentView>[]>>();

function segmentsFor(schedule: ScheduleView, ctx: RuleContext): FloorSegment<AssignmentView>[] {
  let byCtx = SEGMENTS.get(schedule);
  if (!byCtx) {
    byCtx = new WeakMap();
    SEGMENTS.set(schedule, byCtx);
  }
  let segments = byCtx.get(ctx);
  if (!segments) {
    const within: ShiftWindow[] = [];
    for (const date of schedule.dates) {
      for (const shiftType of ctx.shiftTypes) {
        if (!shiftType.isOnCall) within.push(shiftWindow(date, shiftType));
      }
    }
    const floor = schedule.assignmentsWithHistory().filter((v) => !v.shiftType.isOnCall);
    segments = floorSegments(floor, within);
    byCtx.set(ctx, segments);
  }
  return segments;
}

function sameAssignments(a: readonly AssignmentView[], b: readonly AssignmentView[]): boolean {
  return a.length === b.length && a.every((v, i) => v.assignment.id === b[i]!.assignment.id);
}

function parts(f: Finding): { nurseIds: Id[]; dates: IsoDate[]; assignmentIds: Id[] } {
  const inPeriod = f.members.filter((v) => v.inPeriod);
  return {
    nurseIds: [...new Set(f.members.map((v) => v.nurse.id))],
    dates: [...new Set(inPeriod.map((v) => v.assignment.date))].sort(),
    assignmentIds: inPeriod.map((v) => v.assignment.id),
  };
}

function common(f: Finding): Record<string, unknown> {
  return {
    groupId: f.group.id,
    startMinute: f.startMinute,
    endMinute: f.endMinute,
    hours: (f.endMinute - f.startMinute) / MINUTES_PER_HOUR,
  };
}

function names(members: readonly AssignmentView[]): string {
  const list = [...new Set(members.map((v) => `${v.nurse.firstName} ${v.nurse.lastName}`))];
  if (list.length <= 2) return list.join(' and ');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** "from 11:00 to 19:00 on 2026-01-07", or both dates when the stretch crosses midnight. */
function span(startMinute: number, endMinute: number): string {
  const startDay = Math.floor(startMinute / MINUTES_PER_DAY);
  const endDay = Math.floor((endMinute - 1) / MINUTES_PER_DAY);
  const from = formatTimeOfDay(startMinute);
  const to = formatTimeOfDay(endMinute);
  if (startDay === endDay) return `from ${from} to ${to} on ${fromDayNumber(startDay)}`;
  return `from ${from} on ${fromDayNumber(startDay)} to ${to} on ${fromDayNumber(endDay)}`;
}

/** Groups that apply to any shift dated inside a period — what a period's solve needs. */
export function groupsForPeriod(
  groups: readonly IncompatibilityGroup[],
  start: IsoDate,
  end: IsoDate,
): IncompatibilityGroup[] {
  return groups.filter((g) => g.nurseIds.length >= 2 && groupInForceDuring(g, start, end));
}
