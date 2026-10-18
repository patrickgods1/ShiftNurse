/**
 * Main's only reads of the host clock for "what time is it now". These are event readings
 * (like `today()`), never schedule geometry; keeping them in one file means a test fakes one
 * thing and a reviewer can see every place the wall clock leaks in.
 */

import { dayNumber, MINUTES_PER_DAY, today } from '@shiftnurse/core';

/** Host wall-clock minute of the day (0–1439). An event reading, never schedule geometry. */
export function hostMinuteOfDay(): number {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

/** Now, on the schedule's continuous wall-clock timeline (time.ts): today's day × 1440 + minute. */
export function hostWallMinute(): number {
  return dayNumber(today()) * MINUTES_PER_DAY + hostMinuteOfDay();
}
