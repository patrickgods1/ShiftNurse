/**
 * Call-backs on a nurse's timeline: time she was called in from standby and worked.
 *
 * ORS 441.770(3) starts the 12-in-24 count at "a shift or call response", so a call-back is worked
 * time for `max-hours-in-24`, `long-stretch` and the weekly cap — and for rest where a unit says so
 * (`callBackCountsForRest`). It is not a shift: it is recorded day-of against the standby it
 * interrupted, never scheduled, moved or rostered, so it has no assignment and is never in the
 * period. Rules read it from `RuleContext.callBacksByNurse` beside the nurse's timeline: it adds
 * hours, and a finding still names only the in-period shifts that make it.
 *
 * Without this module the 02:00 call-back before a 07:00 day shift was invisible to every cap, so
 * a nurse who worked 15 of 24 hours read as working 12.
 */

import type { CallBack } from '../domain/entities.js';
import {
  hoursToMinutes,
  type IsoDate,
  type ShiftTiming,
  type ShiftWindow,
  shiftWindow,
} from '../domain/time.js';

/**
 * A call-back's window: `startMinute` minutes into the standby dated `standbyDate`, for the hours
 * worked. Placed from the standby's own window, never from timestamps, so a call-back on a DST
 * night sits where the shifts around it do.
 */
export function callBackWindow(
  standbyDate: IsoDate,
  standby: ShiftTiming,
  startMinute: number,
  hoursWorked: number,
): ShiftWindow {
  const start = shiftWindow(standbyDate, standby).startMinute + startMinute;
  return { startMinute: start, endMinute: start + hoursToMinutes(hoursWorked) };
}

/** A call-back as a stretch item (`workedStretches`): worked, and never an assignment. */
export interface CallBackItem {
  kind: 'call_back';
  shiftType: { isOnCall: false };
  window: ShiftWindow;
}

/** Whether a timeline item is a call-back rather than a shift; guard every assignment read. */
export function isCallBackItem(item: object): item is CallBackItem {
  return 'kind' in item && item.kind === 'call_back';
}

/**
 * A start-sorted timeline with the nurse's call-backs merged in by start; a shift and a call-back
 * starting together keep the shift first. With no call-backs the timeline itself comes back.
 */
export function withCallBacks<T extends { window: ShiftWindow }>(
  timeline: readonly T[],
  callBacks: readonly CallBack[],
): readonly (T | CallBackItem)[] {
  if (callBacks.length === 0) return timeline;
  const out: (T | CallBackItem)[] = [];
  let j = 0;
  for (const item of timeline) {
    while (j < callBacks.length && callBacks[j]!.window.startMinute < item.window.startMinute) {
      out.push(callBackItem(callBacks[j]!));
      j++;
    }
    out.push(item);
  }
  for (; j < callBacks.length; j++) out.push(callBackItem(callBacks[j]!));
  return out;
}

function callBackItem(cb: CallBack): CallBackItem {
  return { kind: 'call_back', shiftType: { isOnCall: false }, window: cb.window };
}
