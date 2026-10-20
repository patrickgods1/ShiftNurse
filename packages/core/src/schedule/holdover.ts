/**
 * Holdovers — time a nurse works past the scheduled end of a shift.
 *
 * ## Why this module exists
 *
 * A shift's hours were its shift type's `durationHours`, and nothing else. Real shifts run
 * over: report runs late, a patient crashes at 18:55, the relief calls off and someone is held
 * until cover arrives. Those minutes are worked time — they push a week into overtime, shorten
 * the rest before the next shift, and are exactly what the hour caps in nurse staffing laws are
 * about (38 U.S.C. §7459(a)'s "eight consecutive hours", a 16-in-24 limit, overtime "in excess
 * of the scheduled tour"). Without them none of those can be judged or priced.
 *
 * A holdover is recorded day-of on a published shift (`Assignment.holdoverMinutes`), and is
 * either required by the hospital (`holdoverMandated`) or volunteered. The scheduled shift is
 * unchanged — it is still dated, named and covered as the shift type — but its *worked* window
 * ends later and its worked hours are longer. This module is the one definition of both, so the
 * rule engine, the cost engine and the solvers' lookback all read the same numbers.
 *
 * Durations still come from declared lengths, never from subtracting timestamps: worked hours
 * are `durationHours` plus the recorded minutes, on the wall-clock timeline of `time.ts`.
 */

import type { Assignment } from '../domain/entities.js';
import {
  type IsoDate,
  MINUTES_PER_HOUR,
  type ShiftTiming,
  type ShiftWindow,
  shiftWindow,
} from '../domain/time.js';
import { type DstTransition, realMinutesIn } from './real-minutes.js';

type HoldoverFields = Pick<Assignment, 'holdoverMinutes'>;

/** Hours worked past the shift's scheduled end; 0 when none is recorded. */
export function holdoverHours(assignment: Partial<HoldoverFields>): number {
  return (assignment.holdoverMinutes ?? 0) / MINUTES_PER_HOUR;
}

/** Hours worked on the shift: its declared length plus any holdover. */
export function workedHours(assignment: Partial<HoldoverFields>, timing: ShiftTiming): number {
  return timing.durationHours + holdoverHours(assignment);
}

/** The shift's window with its end moved out by the holdover: the time actually on the floor. */
export function workedWindow(
  date: IsoDate,
  timing: ShiftTiming,
  assignment: Partial<HoldoverFields>,
): ShiftWindow {
  const window = shiftWindow(date, timing);
  const extra = assignment.holdoverMinutes ?? 0;
  return extra > 0
    ? { startMinute: window.startMinute, endMinute: window.endMinute + extra }
    : window;
}

/** The fields of a timeline entry a stretch needs. `AssignmentView` satisfies it. */
export interface StretchItem {
  shiftType: { isOnCall: boolean };
  window: ShiftWindow;
}

/** Shifts worked as one run, and the hours worked from first to last, breaks left out. */
export interface WorkedStretch<T extends StretchItem> {
  views: T[];
  window: ShiftWindow;
  hours: number;
  /** Minutes of the gaps the stretch bridged; 0 when its shifts touch or overlap. */
  breakMinutes: number;
}

export interface StretchOptions {
  /**
   * The longest gap between shifts that does not end a stretch (default 0: any gap ends it).
   * Massachusetts counts "consecutive hours worked", and a meal break between two shifts does not
   * reset that count; without a bridge 07:00–15:00 then 15:30–00:30 would read as 8 and 9.
   */
  bridgeMinutes?: number;
  /**
   * The host's clock changes (D19). Given, `hours` counts real elapsed minutes, so a fall-back
   * night is 13 hours worked: the span's real minutes less the breaks' real minutes, no longer
   * (wall span − `breakMinutes`) / 60, so a repeated hour inside a bridged break is not worked.
   * The window and `breakMinutes` stay on the wall clock. Absent: none.
   */
  transitions?: readonly DstTransition[];
}

/**
 * A nurse's worked shifts grouped into continuous stretches: a shift that starts at or before
 * the previous one's worked end, or at most `bridgeMinutes` after it, joins it (half-open windows,
 * so 15:00 to 15:00 joins). Hours are the time worked: the stretch's span on the clock less the
 * bridged breaks, so an overlap from a holdover is counted once and a break not at all; with
 * `transitions`, in real minutes (D19), so a statutory cap sees the fall-back night's 13. On-call
 * standby is not worked and never joins, starts or fills the gap in a stretch. `timeline` must be
 * sorted by start, as `ScheduleView.timelineFor` is.
 */
export function workedStretches<T extends StretchItem>(
  timeline: readonly T[],
  options: StretchOptions = {},
): WorkedStretch<T>[] {
  const bridge = options.bridgeMinutes ?? 0;
  const tz = options.transitions ?? [];
  const out: WorkedStretch<T>[] = [];
  let current:
    | {
        views: T[];
        startMinute: number;
        endMinute: number;
        breakMinutes: number;
        /** Real minutes of the bridged breaks: a repeated hour inside a break is not worked. */
        realBreakMinutes: number;
      }
    | undefined;
  const close = () => {
    if (!current) return;
    const window = { startMinute: current.startMinute, endMinute: current.endMinute };
    out.push({
      views: current.views,
      window,
      hours: (realMinutesIn(window, tz) - current.realBreakMinutes) / MINUTES_PER_HOUR,
      breakMinutes: current.breakMinutes,
    });
  };
  for (const view of timeline) {
    if (view.shiftType.isOnCall) continue;
    if (current && view.window.startMinute <= current.endMinute + bridge) {
      current.views.push(view);
      if (view.window.startMinute > current.endMinute) {
        const gap = { startMinute: current.endMinute, endMinute: view.window.startMinute };
        current.breakMinutes += gap.endMinute - gap.startMinute;
        current.realBreakMinutes += realMinutesIn(gap, tz);
      }
      current.endMinute = Math.max(current.endMinute, view.window.endMinute);
      continue;
    }
    close();
    current = {
      views: [view],
      startMinute: view.window.startMinute,
      endMinute: view.window.endMinute,
      breakMinutes: 0,
      realBreakMinutes: 0,
    };
  }
  close();
  return out;
}
