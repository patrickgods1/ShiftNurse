/**
 * Number and time wording shared by rule messages.
 *
 * Seven rules each carried their own copy of "48h" and "10 hours", and two carried the same
 * date-and-time printer; a message that must read the same wherever it appears (the grid, the
 * conflict list, an exported report) drifts the moment one copy is edited alone.
 */

import { describeDate, formatTimeOfDay, fromDayNumber, MINUTES_PER_DAY } from '../domain/time.js';

/** Hours to one decimal place, with no trailing `.0`: "48h", "6.5h". */
export function hoursText(hours: number): string {
  return `${Math.round(hours * 10) / 10}h`;
}

/** Hours spelled out, singular at exactly one: "10 hours", "1 hour". */
export function hoursWords(hours: number): string {
  const rounded = Math.round(hours * 10) / 10;
  return `${rounded} hour${rounded === 1 ? '' : 's'}`;
}

/** "Mon Jan 5 07:00": a minute on the wall-clock timeline, for rule messages. */
export function describeMinute(minute: number): string {
  return `${describeDate(fromDayNumber(Math.floor(minute / MINUTES_PER_DAY)))} ${formatTimeOfDay(minute)}`;
}
