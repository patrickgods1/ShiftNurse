/**
 * The shift length a day of paid leave is worth when the manager has not said otherwise: what
 * most of the unit's worked shift types run. A 12-hour unit's PTO day is 12 hours, a VA tour 8.
 */

export function typicalShiftHours(
  shiftTypes: readonly { durationHours: number; active: boolean; isOnCall: boolean }[],
): number {
  const counts = new Map<number, number>();
  for (const s of shiftTypes) {
    if (!s.active || s.isOnCall) continue;
    counts.set(s.durationHours, (counts.get(s.durationHours) ?? 0) + 1);
  }
  let best: [number, number] | undefined;
  for (const [hours, n] of counts) {
    if (!best || n > best[1] || (n === best[1] && hours > best[0])) best = [hours, n];
  }
  return best?.[0] ?? 8;
}
