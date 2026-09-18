/**
 * The read model rules and scoring evaluate against.
 *
 * Every rule needs the same joins — assignment → nurse → shift type → time window — and
 * needs them indexed several different ways. Doing that once here keeps each rule short and
 * keeps the joins consistent.
 *
 * ## Why prior assignments are included
 *
 * The first day of a scheduling period is not a clean slate. A nurse who worked the last
 * night shift of the previous period cannot legally start a day shift on the first morning
 * of this one. A view therefore carries a lookback tail of already-published assignments,
 * flagged `inPeriod: false`. They participate fully in rest, consecutive-shift and hours
 * calculations, but never receive violations of their own — they are history, not something
 * this schedule can fix.
 */

import type {
  Assignment,
  Id,
  Nurse,
  NurseRole,
  SchedulePeriod,
  ShiftType,
} from '../domain/entities.js';
import {
  datesInRange,
  dayNumber,
  type IsoDate,
  type ShiftWindow,
  shiftWindow,
} from '../domain/time.js';

export interface AssignmentView {
  assignment: Assignment;
  nurse: Nurse;
  shiftType: ShiftType;
  window: ShiftWindow;
  /** Scheduled hours. On-call hours are tracked separately from worked hours for pay. */
  paidHours: number;
  /** False for the lookback tail carried in from previously published periods. */
  inPeriod: boolean;
}

export interface ScheduleViewInput {
  period: SchedulePeriod;
  assignments: readonly Assignment[];
  /** Already-published assignments from before `period.startDate`, for cross-boundary rules. */
  priorAssignments?: readonly Assignment[];
  nurses: readonly Nurse[];
  shiftTypes: readonly ShiftType[];
}

function shiftKey(date: IsoDate, shiftTypeId: Id): string {
  return `${date}::${shiftTypeId}`;
}

export class ScheduleView {
  readonly period: SchedulePeriod;
  readonly nursesById: ReadonlyMap<Id, Nurse>;
  readonly shiftTypesById: ReadonlyMap<Id, ShiftType>;
  /** Every date in the period, in order. */
  readonly dates: readonly IsoDate[];

  /** All views including the lookback tail, sorted by start. */
  private readonly allViews: readonly AssignmentView[];
  private readonly periodViews: readonly AssignmentView[];
  private readonly timelineByNurse: ReadonlyMap<Id, readonly AssignmentView[]>;
  private readonly byDateShift: ReadonlyMap<string, readonly AssignmentView[]>;
  private readonly byDate: ReadonlyMap<IsoDate, readonly AssignmentView[]>;
  private readonly byId: ReadonlyMap<Id, AssignmentView>;

  constructor(input: ScheduleViewInput) {
    this.period = input.period;
    this.nursesById = new Map(input.nurses.map((n) => [n.id, n]));
    this.shiftTypesById = new Map(input.shiftTypes.map((s) => [s.id, s]));
    this.dates = datesInRange(input.period.startDate, input.period.endDate);

    const views: AssignmentView[] = [];
    const build = (assignment: Assignment, inPeriod: boolean): void => {
      const nurse = this.nursesById.get(assignment.nurseId);
      const shiftType = this.shiftTypesById.get(assignment.shiftTypeId);
      // Silently dropping would hide data corruption; scheduling errors must be loud.
      if (!nurse) {
        throw new Error(
          `Assignment ${assignment.id} references unknown nurse ${assignment.nurseId}`,
        );
      }
      if (!shiftType) {
        throw new Error(
          `Assignment ${assignment.id} references unknown shift type ${assignment.shiftTypeId}`,
        );
      }
      views.push({
        assignment,
        nurse,
        shiftType,
        window: shiftWindow(assignment.date, shiftType),
        paidHours: shiftType.durationHours,
        inPeriod,
      });
    };

    for (const a of input.priorAssignments ?? []) build(a, false);
    for (const a of input.assignments) build(a, true);
    views.sort((a, b) => a.window.startMinute - b.window.startMinute);

    const timeline = new Map<Id, AssignmentView[]>();
    const dateShift = new Map<string, AssignmentView[]>();
    const date = new Map<IsoDate, AssignmentView[]>();
    const byId = new Map<Id, AssignmentView>();

    for (const view of views) {
      push(timeline, view.assignment.nurseId, view);
      byId.set(view.assignment.id, view);
      if (!view.inPeriod) continue;
      push(dateShift, shiftKey(view.assignment.date, view.assignment.shiftTypeId), view);
      push(date, view.assignment.date, view);
    }

    this.allViews = views;
    this.periodViews = views.filter((v) => v.inPeriod);
    this.timelineByNurse = timeline;
    this.byDateShift = dateShift;
    this.byDate = date;
    this.byId = byId;
  }

  /** In-period assignments only — what this schedule is responsible for. */
  assignments(): readonly AssignmentView[] {
    return this.periodViews;
  }

  /** In-period assignments plus the lookback tail. */
  assignmentsWithHistory(): readonly AssignmentView[] {
    return this.allViews;
  }

  get(assignmentId: Id): AssignmentView | undefined {
    return this.byId.get(assignmentId);
  }

  /**
   * One nurse's complete chronological timeline, including the lookback tail. This is what
   * rest-period and consecutive-shift rules walk.
   */
  timelineFor(nurseId: Id): readonly AssignmentView[] {
    return this.timelineByNurse.get(nurseId) ?? EMPTY;
  }

  /** One nurse's in-period assignments only. */
  assignmentsFor(nurseId: Id): readonly AssignmentView[] {
    return this.timelineFor(nurseId).filter((v) => v.inPeriod);
  }

  onDate(date: IsoDate): readonly AssignmentView[] {
    return this.byDate.get(date) ?? EMPTY;
  }

  onShift(date: IsoDate, shiftTypeId: Id): readonly AssignmentView[] {
    return this.byDateShift.get(shiftKey(date, shiftTypeId)) ?? EMPTY;
  }

  /** Staffed count for one role on one shift, excluding on-call standby. */
  countOnShift(date: IsoDate, shiftTypeId: Id, role: NurseRole): number {
    let count = 0;
    for (const view of this.onShift(date, shiftTypeId)) {
      if (view.nurse.role === role) count++;
    }
    return count;
  }

  /** True when this nurse already has any assignment on this date. */
  isAssignedOn(nurseId: Id, date: IsoDate): boolean {
    return this.timelineFor(nurseId).some((v) => v.assignment.date === date);
  }

  /** Total scheduled hours for a nurse within an inclusive date window. */
  hoursBetween(nurseId: Id, start: IsoDate, end: IsoDate): number {
    const from = dayNumber(start);
    const to = dayNumber(end);
    let hours = 0;
    for (const view of this.timelineFor(nurseId)) {
      const n = dayNumber(view.assignment.date);
      if (n >= from && n <= to) hours += view.paidHours;
    }
    return hours;
  }

  /** A shallow copy of the in-period assignments, for producing a modified schedule. */
  toAssignments(): Assignment[] {
    return this.periodViews.map((v) => v.assignment);
  }
}

const EMPTY: readonly AssignmentView[] = Object.freeze([]);

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}
