/**
 * What every rule encoder works from: the builder, the annealer's `SolverModel` (for the tables
 * both solvers must agree on), the decision variables, and each nurse's timeline with the
 * constants — locked shifts and the published lookback tail — merged in.
 */

import type { Assignment, Id, ShiftType } from '../../domain/entities.js';
import { dayNumber, type IsoDate, type ShiftWindow, shiftWindow } from '../../domain/time.js';
import type { RuleConfig } from '../../rules/types.js';
import type { Shift, SolverModel } from '../model.js';
import type { ObjectiveWeights, SolveInput } from '../types.js';
import { type CpBuilder, type Expr, expr } from './builder.js';

/** Hours are encoded in hundredths so 7.5- and 12.25-hour shifts stay integral. */
export const HOURS = 100;
/** Objective coefficients are points × 10 000 before rounding (equal to the fair-share scale, so fairness coefficients stay exact); `scaling_factor` undoes it. */
export const OBJECTIVE_SCALE = 10_000;

/** One decision: this nurse works this shift. */
export interface ShiftVar {
  variable: number;
  n: number;
  nurseId: Id;
  shift: Shift;
}

/** An entry on a nurse's timeline: a decision variable or a constant. */
export interface TimelineEntry {
  /** The variable, or null for a locked shift or one in the lookback tail. */
  literal: number | null;
  /** False only for the lookback tail, which is judged but never itself flagged. */
  inPeriod: boolean;
  date: IsoDate;
  day: number;
  shiftType: ShiftType;
  window: ShiftWindow;
  /** The constant's assignment (null for a variable). */
  assignment: Assignment | null;
  /** The period cell, for in-period entries; null for the lookback tail. */
  shift: Shift | null;
}

export interface EncodeContext {
  input: SolveInput;
  b: CpBuilder;
  model: SolverModel;
  weights: ObjectiveWeights;
  /** Enabled rules whose effective severity is hard, by id. */
  hard: ReadonlyMap<string, RuleConfig>;
  shiftVars: readonly ShiftVar[];
  byNurse: readonly ShiftVar[][];
  byShift: readonly ShiftVar[][];
  /** In-period locked assignments, by nurse and by shift index. */
  lockedByNurse: readonly Assignment[][];
  lockedByShift: readonly Assignment[][];
  timeline(n: number): readonly TimelineEntry[];
  name(n: number): string;
}

export function hoursOf(shiftType: ShiftType, label: string): number {
  const scaled = shiftType.durationHours * HOURS;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
    throw new Error(
      `CP-SAT encoding: ${shiftType.name} lasts ${shiftType.durationHours}h (${label})`,
    );
  }
  return Math.round(scaled);
}

/** Σ hours (×HOURS) over timeline entries: variables as terms, constants folded in. */
export function hoursExpr(entries: readonly TimelineEntry[]): Expr {
  const e = expr();
  for (const entry of entries) {
    const h = hoursOf(entry.shiftType, entry.date);
    if (entry.literal === null) e.constant += h;
    else e.terms.push([entry.literal, h]);
  }
  return e;
}

/** A count of entries (1 each): variables as terms, constants folded in. */
export function countExpr(entries: readonly TimelineEntry[]): Expr {
  const e = expr();
  for (const entry of entries) {
    if (entry.literal === null) e.constant += 1;
    else e.terms.push([entry.literal, 1]);
  }
  return e;
}

/**
 * The rule engine's pairwise verdict as a constraint: these two may not both be worked. Two
 * constants are left alone — history, or a violation the manager pinned — and a constant against
 * a variable forbids the variable.
 */
export function forbidPair(ctx: EncodeContext, a: TimelineEntry, b: TimelineEntry, label: string) {
  if (a.literal === null && b.literal === null) return;
  if (a.literal === null) ctx.b.linear(expr([[b.literal!, 1]]), 0, 0, label);
  else if (b.literal === null) ctx.b.linear(expr([[a.literal, 1]]), 0, 0, label);
  else ctx.b.atMostOne([a.literal, b.literal], label);
}

export function describe(entry: TimelineEntry): string {
  return `${entry.shiftType.abbreviation} ${entry.date}`;
}

export function timelineEntry(
  literal: number | null,
  inPeriod: boolean,
  date: IsoDate,
  shiftType: ShiftType,
  assignment: Assignment | null,
  shift: Shift | null,
): TimelineEntry {
  return {
    shift,
    literal,
    inPeriod,
    date,
    day: dayNumber(date),
    shiftType,
    window: shiftWindow(date, shiftType),
    assignment,
  };
}
