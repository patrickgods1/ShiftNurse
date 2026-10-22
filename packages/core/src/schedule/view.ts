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
 * calculations, but never receive violations of their own and are never named on one — they
 * are history, not something this schedule can fix.
 *
 * ## A nurse floated off a shift
 *
 * In a counting view (cost, alerts, fairness) a floated-off row (`Assignment.floatedTo`) is the
 * nurse's work and off this unit's floor: her timeline, her hours and her day keep it, but
 * `onShift`, `countOnShift` and `rosterAt` leave her out, since she was on another unit's floor.
 * A judging view never holds one in-period: the loader turns it into `floatedOff` busy time.
 */

import type {
  Assignment,
  Id,
  Nurse,
  NurseRole,
  SchedulePeriod,
  ShiftType,
} from '../domain/entities.js';
import { datesInRange, type IsoDate, type ShiftWindow } from '../domain/time.js';
import { isFloatedOff } from './elsewhere.js';
import { workedHours, workedWindow } from './holdover.js';

export interface AssignmentView {
  assignment: Assignment;
  nurse: Nurse;
  shiftType: ShiftType;
  /** The worked window: the shift's scheduled window, its end moved out by any holdover. */
  window: ShiftWindow;
  /**
   * Hours worked: the shift type's length plus any holdover. What hour caps, overtime and pay
   * count. On-call hours are tracked separately from worked hours for pay.
   */
  paidHours: number;
  /**
   * The shift type's declared length, holdover excluded. What comparing a schedule with a
   * contract counts: a nurse held over was not *scheduled* past their contract.
   */
  scheduledHours: number;
  /** False for the lookback tail carried in from previously published periods. */
  inPeriod: boolean;
}

export interface ScheduleViewInput {
  period: SchedulePeriod;
  assignments: readonly Assignment[];
  /**
   * Already-published assignments from before `period.startDate`, and busy time elsewhere (other
   * units, other periods of this unit) that may fall inside it, for cross-boundary rules.
   */
  priorAssignments?: readonly Assignment[];
  nurses: readonly Nurse[];
  shiftTypes: readonly ShiftType[];
}

function shiftKey(date: IsoDate, shiftTypeId: Id): string {
  return `${date}::${shiftTypeId}`;
}

/**
 * The solver builds a view per candidate check — millions per solve — almost always over the
 * same period, so the period's date list is shared (frozen: every view hands out the same one).
 */
const DATES_CACHE = new Map<string, readonly IsoDate[]>();
/** A long-running app sees a few periods; this only stops nonsense from growing forever. */
const PERIOD_DATES_LIMIT = 256;
function periodDates(start: IsoDate, end: IsoDate): readonly IsoDate[] {
  const key = `${start}|${end}`;
  let dates = DATES_CACHE.get(key);
  if (!dates) {
    dates = Object.freeze(datesInRange(start, end));
    if (DATES_CACHE.size >= PERIOD_DATES_LIMIT) DATES_CACHE.clear();
    DATES_CACHE.set(key, dates);
  }
  return dates;
}

/**
 * Set by `ScheduleView.derive` for the one constructor call it makes, so a derived view can
 * fill its readonly fields from its base without a second public constructor.
 */
let derivingFrom: ScheduleView | undefined;

export class ScheduleView {
  readonly period: SchedulePeriod;
  readonly nursesById: ReadonlyMap<Id, Nurse>;
  readonly shiftTypesById: ReadonlyMap<Id, ShiftType>;
  /** Every date in the period, in order. */
  readonly dates: readonly IsoDate[];

  /** In-period views in input order: what `derive` compares and what `allViews` is merged from. */
  private readonly inputViews: readonly AssignmentView[];
  private readonly timelineByNurse: ReadonlyMap<Id, readonly AssignmentView[]>;
  /** All views including the lookback tail, sorted by start. Eager when built, lazy when derived. */
  private allViewsCache?: readonly AssignmentView[];
  private priorViewsCache?: readonly AssignmentView[];
  private inputByNurseCache?: ReadonlyMap<Id, readonly AssignmentView[]>;
  // Built on first use. The solver's one-nurse and one-shift views are evaluated by rules that
  // each read one or two of these, and building all of them eagerly was a third of a view.
  private periodViewsCache?: readonly AssignmentView[];
  private byDateShiftCache?: ReadonlyMap<string, readonly AssignmentView[]>;
  private byDateShiftAllCache?: ReadonlyMap<string, readonly AssignmentView[]>;
  private byDateCache?: ReadonlyMap<IsoDate, readonly AssignmentView[]>;
  private byIdCache?: ReadonlyMap<Id, AssignmentView>;

  constructor(input: ScheduleViewInput) {
    const base = derivingFrom;
    derivingFrom = undefined;
    this.period = input.period;
    if (base) {
      this.nursesById = base.nursesById;
      this.shiftTypesById = base.shiftTypesById;
      this.dates = base.dates;
      const derived = ScheduleView.derivedParts(base, input.assignments);
      this.inputViews = derived.inputViews;
      this.timelineByNurse = derived.timeline;
      this.priorViewsCache = base.priorViews;
      return;
    }
    this.nursesById = new Map(input.nurses.map((n) => [n.id, n]));
    this.shiftTypesById = new Map(input.shiftTypes.map((s) => [s.id, s]));
    this.dates = periodDates(input.period.startDate, input.period.endDate);

    const views: AssignmentView[] = [];
    for (const a of input.priorAssignments ?? []) views.push(this.build(a, false));
    const priorCount = views.length;
    for (const a of input.assignments) views.push(this.build(a, true));
    this.inputViews = views.slice(priorCount);
    views.sort(byStart);

    const timeline = new Map<Id, AssignmentView[]>();
    for (const view of views) push(timeline, view.assignment.nurseId, view);

    this.allViewsCache = views;
    this.timelineByNurse = timeline;
  }

  /**
   * The same period, roster, shift types and lookback tail as `base`, with `assignments` as the
   * in-period rows — answering every question exactly as a view built from scratch would. The
   * conflicts engine simulates hundreds of fixes that each change a nurse or two; rebuilding and
   * re-sorting the whole period, tail included, for each was most of an analysis. So the tail
   * and every nurse whose rows are the very same objects in the same order are shared with the
   * base, and only the nurses a fix touched are rebuilt.
   */
  static derive(base: ScheduleView, assignments: readonly Assignment[]): ScheduleView {
    derivingFrom = base;
    return new ScheduleView({ period: base.period, assignments, nurses: [], shiftTypes: [] });
  }

  private static derivedParts(
    base: ScheduleView,
    assignments: readonly Assignment[],
  ): { inputViews: AssignmentView[]; timeline: Map<Id, readonly AssignmentView[]> } {
    const byNurse = new Map<Id, Assignment[]>();
    for (const a of assignments) push(byNurse, a.nurseId, a);
    const baseByNurse = base.inputByNurse;

    // A nurse is shared only when her rows are the base's rows, one for one: same objects, same
    // order. Anything else — a row added, dropped, replaced or reordered — rebuilds her.
    const shared = new Map<Id, { views: readonly AssignmentView[]; next: number }>();
    for (const [nurseId, rows] of byNurse) {
      const old = baseByNurse.get(nurseId);
      if (old && old.length === rows.length && old.every((v, i) => v.assignment === rows[i])) {
        shared.set(nurseId, { views: old, next: 0 });
      }
    }

    // Built in input order so the first bad row throws exactly as the constructor would.
    const inputViews: AssignmentView[] = [];
    const rebuilt = new Map<Id, AssignmentView[]>();
    for (const a of assignments) {
      const reuse = shared.get(a.nurseId);
      if (reuse) {
        inputViews.push(reuse.views[reuse.next++]!);
        continue;
      }
      const view = base.build(a, true);
      inputViews.push(view);
      push(rebuilt, a.nurseId, view);
    }

    const timeline = new Map<Id, readonly AssignmentView[]>(base.timelineByNurse);
    const rebuild = (nurseId: Id, rows: readonly AssignmentView[]): void => {
      const tail = (base.timelineByNurse.get(nurseId) ?? EMPTY).filter((v) => !v.inPeriod);
      const merged = mergeByStart(tail, rows.slice().sort(byStart));
      if (merged.length > 0) timeline.set(nurseId, merged);
      else timeline.delete(nurseId);
    };
    for (const [nurseId, rows] of rebuilt) rebuild(nurseId, rows);
    // A nurse whose every row went is rebuilt too: her timeline is now the tail alone.
    for (const nurseId of baseByNurse.keys()) {
      if (!byNurse.has(nurseId)) rebuild(nurseId, EMPTY);
    }
    return { inputViews, timeline };
  }

  private build(assignment: Assignment, inPeriod: boolean): AssignmentView {
    const nurse = this.nursesById.get(assignment.nurseId);
    const shiftType = this.shiftTypesById.get(assignment.shiftTypeId);
    // Silently dropping would hide data corruption; scheduling errors must be loud.
    if (!nurse) {
      throw new Error(`Assignment ${assignment.id} references unknown nurse ${assignment.nurseId}`);
    }
    if (!shiftType) {
      throw new Error(
        `Assignment ${assignment.id} references unknown shift type ${assignment.shiftTypeId}`,
      );
    }
    return {
      assignment,
      nurse,
      shiftType,
      window: workedWindow(assignment.date, shiftType, assignment),
      paidHours: workedHours(assignment, shiftType),
      scheduledHours: shiftType.durationHours,
      inPeriod,
    };
  }

  /**
   * Merging the sorted tail with the sorted in-period rows, tail first on a tie, is the stable
   * sort of tail-then-rows the constructor does.
   */
  private get allViews(): readonly AssignmentView[] {
    this.allViewsCache ??= mergeByStart(this.priorViews, this.periodViews);
    return this.allViewsCache;
  }

  private get priorViews(): readonly AssignmentView[] {
    this.priorViewsCache ??= this.allViews.filter((v) => !v.inPeriod);
    return this.priorViewsCache;
  }

  private get inputByNurse(): ReadonlyMap<Id, readonly AssignmentView[]> {
    if (!this.inputByNurseCache) {
      const byNurse = new Map<Id, AssignmentView[]>();
      for (const view of this.inputViews) push(byNurse, view.assignment.nurseId, view);
      this.inputByNurseCache = byNurse;
    }
    return this.inputByNurseCache;
  }

  private get periodViews(): readonly AssignmentView[] {
    // A derived view sorts its own rows rather than build the merged list to filter it.
    this.periodViewsCache ??= this.allViewsCache
      ? this.allViewsCache.filter((v) => v.inPeriod)
      : this.inputViews.slice().sort(byStart);
    return this.periodViewsCache;
  }

  private get byId(): ReadonlyMap<Id, AssignmentView> {
    if (!this.byIdCache) {
      const byId = new Map<Id, AssignmentView>();
      for (const view of this.allViews) byId.set(view.assignment.id, view);
      this.byIdCache = byId;
    }
    return this.byIdCache;
  }

  private get byDateShift(): ReadonlyMap<string, readonly AssignmentView[]> {
    if (!this.byDateShiftCache) {
      const dateShift = new Map<string, AssignmentView[]>();
      for (const view of this.periodViews) {
        if (isFloatedOff(view.assignment)) continue;
        push(dateShift, shiftKey(view.assignment.date, view.assignment.shiftTypeId), view);
      }
      this.byDateShiftCache = dateShift;
    }
    return this.byDateShiftCache;
  }

  private get byDate(): ReadonlyMap<IsoDate, readonly AssignmentView[]> {
    if (!this.byDateCache) {
      const date = new Map<IsoDate, AssignmentView[]>();
      for (const view of this.periodViews) push(date, view.assignment.date, view);
      this.byDateCache = date;
    }
    return this.byDateCache;
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

  /**
   * Everyone on a shift, the lookback tail included: the cover a shift early on the first day
   * gets from the night that began the day before the period.
   */
  rosterAt(date: IsoDate, shiftTypeId: Id): readonly AssignmentView[] {
    if (!this.byDateShiftAllCache) {
      const all = new Map<string, AssignmentView[]>();
      for (const view of this.allViews) {
        if (isFloatedOff(view.assignment)) continue;
        push(all, shiftKey(view.assignment.date, view.assignment.shiftTypeId), view);
      }
      this.byDateShiftAllCache = all;
    }
    return this.byDateShiftAllCache.get(shiftKey(date, shiftTypeId)) ?? EMPTY;
  }

  /**
   * Staffed count for one role on one shift. Standby is not filtered here: callers pass a worked
   * shift type.
   */
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

  /** A shallow copy of the in-period assignments, for producing a modified schedule. */
  toAssignments(): Assignment[] {
    return this.periodViews.map((v) => v.assignment);
  }
}

const EMPTY: readonly AssignmentView[] = Object.freeze([]);

function byStart(a: AssignmentView, b: AssignmentView): number {
  return a.window.startMinute - b.window.startMinute;
}

/** Two lists each sorted by start, merged; `first` wins ties, as a stable sort of first-then-second. */
function mergeByStart(
  first: readonly AssignmentView[],
  second: readonly AssignmentView[],
): AssignmentView[] {
  const out: AssignmentView[] = [];
  let i = 0;
  let j = 0;
  while (i < first.length && j < second.length) {
    if (second[j]!.window.startMinute < first[i]!.window.startMinute) out.push(second[j++]!);
    else out.push(first[i++]!);
  }
  while (i < first.length) out.push(first[i++]!);
  while (j < second.length) out.push(second[j++]!);
  return out;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}
