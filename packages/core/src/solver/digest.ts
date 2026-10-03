/**
 * A schedule in the handful of numbers a nurse manager compares two schedules by.
 *
 * The objective is one number in points, which is what the solver minimises and nothing a
 * manager can weigh: "score 64,051" against "64,315" says nothing about who works the nights.
 * Choosing between variations, a manager asks how unevenly nights and weekends fall, whether
 * anyone flips straight from nights to days, who is left short of their hours and how many
 * shifts go against what people asked for. The digest answers those, read from the same
 * counters and violations as the Fairness page and the grid, so the Generate summary never
 * disagrees with them.
 */

import type { Id, Nurse } from '../domain/entities.js';
import { type BurdenCounters, EMPTY_COUNTERS } from '../fairness/types.js';
import type { Violation } from '../rules/types.js';

export interface CountRange {
  min: number;
  max: number;
}

export interface ScheduleDigest {
  /** Night shifts per contracted nurse who works any, fewest to most. */
  nights: CountRange;
  /** Weekends worked per nurse with contracted hours, fewest to most. */
  weekends: CountRange;
  /** Day or evening shifts worked too soon after nights. */
  quickFlips: number;
  /** Nurses scheduled under their contracted hours in at least one pay period. */
  nursesUnderContract: number;
  /** Shifts that go against a nurse's stated preference. */
  againstPreference: number;
  /** Shifts inside a time-off request still waiting for a decision. */
  onDaysAskedOff: number;
}

export interface DigestInput {
  nurses: readonly Nurse[];
  /** This period's counters (`deriveCounters`); a missing nurse worked nothing. */
  counters: ReadonlyMap<Id, BurdenCounters>;
  violations: readonly Violation[];
}

function range(values: readonly number[]): CountRange {
  if (values.length === 0) return { min: 0, max: 0 };
  return { min: Math.min(...values), max: Math.max(...values) };
}

export function digestSchedule(input: DigestInput): ScheduleDigest {
  // Per-diem and agency staff have no share to be unfair about: their zero nights is a choice.
  const contracted = input.nurses.filter((n) => n.active && n.contractedHoursPerPeriod > 0);
  const countersOf = (n: Nurse) => input.counters.get(n.id) ?? EMPTY_COUNTERS;
  let againstPreference = 0;
  for (const nurse of input.nurses) againstPreference += countersOf(nurse).undesirableShifts;
  const under = new Set<Id>();
  let quickFlips = 0;
  let onDaysAskedOff = 0;
  for (const v of input.violations) {
    if (v.code === 'short_recovery_after_nights') quickFlips++;
    if (v.code === 'works_during_pending_time_off') onDaysAskedOff++;
    if (v.code === 'under_contracted_hours') for (const id of v.nurseIds) under.add(id);
  }
  return {
    // Among nurses who work nights at all: a unit with day-only and night-only staff would
    // otherwise always read "0–18", which says nothing about whether nights are shared fairly.
    nights: range(contracted.map((n) => countersOf(n).nightShifts).filter((count) => count > 0)),
    weekends: range(contracted.map((n) => countersOf(n).weekendsWorked)),
    quickFlips,
    nursesUnderContract: under.size,
    againstPreference,
    onDaysAskedOff,
  };
}
