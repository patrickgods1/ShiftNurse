/**
 * `SolveInput` → a CP-SAT model, as plain data. Pure: no process, no I/O — the desktop main
 * process sends the model to the OR-Tools runner and hands the answer to `decode.ts`.
 *
 * ## Decisions
 *
 * One Boolean per (active nurse, staffable shift), created only where the annealer's eligibility
 * filter would also allow it: not on approved leave (nor, when the time-off rule is hard, the
 * night that runs into it), and not on a day the nurse already holds a locked shift. A nurse starts
 * at most one shift per day, as in the annealer. Locked shifts and the published lookback tail
 * are constants that every rule still sees.
 *
 * ## Rules
 *
 * Every enabled hard rule must have an entry in `CPSAT_ENCODERS` — a function that adds its
 * constraints (nurse scope) or its price (shift scope), or `'by-construction'` when the variables
 * already respect it. A rule with no entry makes `encodeCpsat` throw naming the rule: silently
 * solving without it would hand the manager a schedule the grid then marks illegal.
 */

import type { Assignment } from '../../domain/entities.js';
import {
  approvedLeaveOn,
  overlappingLeaveDate,
  type TimeOffParams,
} from '../../rules/availability-rules.js';
import { ALL_RULES, resolveConfigs } from '../../rules/registry.js';
import type { RuleConfig } from '../../rules/types.js';
import { SolverModel } from '../model.js';
import { DEFAULT_OBJECTIVE_WEIGHTS, type ObjectiveWeights, type SolveInput } from '../types.js';
import { CpBuilder } from './builder.js';
import {
  type EncodeContext,
  OBJECTIVE_SCALE,
  type ShiftVar,
  type TimelineEntry,
  timelineEntry,
} from './context.js';
import { encodeObjective } from './objective.js';
import type { CpModel } from './proto.js';
import { encodeConsecutive } from './rules/consecutive.js';
import { encodeCoverage, encodeRatio } from './rules/coverage.js';
import { encodeContractCap, encodeWeeklyHours } from './rules/hours.js';
import { encodeOverlap, encodeRest } from './rules/rest.js';

export type { ShiftVar } from './context.js';

export type Encoder = (ctx: EncodeContext, params: Record<string, unknown>) => void;

export const CPSAT_ENCODERS: Readonly<Record<string, Encoder | 'by-construction'>> = {
  'approved-time-off-is-absolute': 'by-construction',
  'no-overlapping-assignments': encodeOverlap,
  'patient-ratio-compliance': encodeRatio,
  'coverage-minimums': encodeCoverage,
  'min-rest-between-shifts': encodeRest,
  'max-consecutive-shifts': encodeConsecutive,
  'max-hours-per-week': encodeWeeklyHours,
  'fte-target-hours': encodeContractCap,
};

export interface EncodeOptions {
  weights?: Partial<ObjectiveWeights>;
  /** A schedule to start the search from, e.g. the greedy seed. */
  hint?: readonly Assignment[];
  /** Injectable for tests; defaults to `CPSAT_ENCODERS`. */
  encoders?: Readonly<Record<string, Encoder | 'by-construction'>>;
}

export interface CpsatEncoding {
  model: CpModel;
  builder: CpBuilder;
  /** The annealer's model with the locked shifts placed: the tables the encoding read. */
  solverModel: SolverModel;
  shiftVars: readonly ShiftVar[];
  weights: ObjectiveWeights;
  objectiveScale: number;
}

export function encodeCpsat(input: SolveInput, options: EncodeOptions = {}): CpsatEncoding {
  const encoders = options.encoders ?? CPSAT_ENCODERS;
  const weights = { ...DEFAULT_OBJECTIVE_WEIGHTS, ...options.weights };
  const model = new SolverModel(input, weights);
  const b = new CpBuilder();

  const hard = new Map<string, RuleConfig>();
  for (const config of resolveConfigs(input.ruleSet)) {
    const rule = ALL_RULES.find((r) => r.id === config.ruleId);
    if (!config.enabled || !rule) continue;
    if ((config.severityOverride ?? rule.severity) !== 'hard') continue;
    if (encoders[rule.id] === undefined) {
      throw new Error(
        `CP-SAT cannot enforce the rule "${rule.name}" yet; generate with SA + LNS instead.`,
      );
    }
    hard.set(rule.id, config);
  }

  // --- Decisions ---------------------------------------------------------------------
  const nurseCount = model.nurses.length;
  const byNurse: ShiftVar[][] = Array.from({ length: nurseCount }, () => []);
  const byShift: ShiftVar[][] = model.shifts.map(() => []);
  const lockedByNurse: Assignment[][] = Array.from({ length: nurseCount }, (_, n) =>
    model.timeline(n).filter((a) => a.isLocked),
  );
  const lockedByShift: Assignment[][] = model.shifts.map((s) => [...model.roster(s)]);
  const timeOff = hard.get('approved-time-off-is-absolute')?.params as TimeOffParams | undefined;
  const shiftVars: ShiftVar[] = [];

  for (const n of model.candidates) {
    const nurse = model.nurses[n]!;
    const lockedDays = new Set(lockedByNurse[n]!.map((a) => model.shiftOf(a).dateIdx));
    const approved = model.ctx.approvedTimeOffByNurse.get(nurse.id) ?? [];
    for (const shift of model.solvableShifts) {
      if (lockedDays.has(shift.dateIdx)) continue;
      if (approvedLeaveOn(model.ctx, nurse.id, shift.date)) continue;
      if (
        timeOff &&
        approved.some((r) => overlappingLeaveDate(shift.date, shift.shiftType, r, timeOff))
      ) {
        continue;
      }
      const variable = b.decision(
        `${shift.shiftType.abbreviation} ${shift.date} ${nurse.firstName} ${nurse.lastName}`,
      );
      const sv: ShiftVar = { variable, n, nurseId: nurse.id, shift };
      shiftVars.push(sv);
      byNurse[n]!.push(sv);
      byShift[shift.idx]!.push(sv);
    }
    // One shift start per day, as the annealer's eligibility filter has it.
    const byDay = new Map<number, number[]>();
    for (const sv of byNurse[n]!)
      byDay.set(sv.shift.dateIdx, [...(byDay.get(sv.shift.dateIdx) ?? []), sv.variable]);
    for (const [dateIdx, vars] of byDay) {
      if (vars.length > 1)
        b.atMostOne(
          vars,
          `one shift a day: ${nurse.firstName} ${nurse.lastName} ${model.dates[dateIdx]}`,
        );
    }
  }

  const timelines = new Map<number, TimelineEntry[]>();
  const typeById = new Map(model.shiftTypes.map((t) => [t.id, t]));
  const ctx: EncodeContext = {
    input,
    b,
    model,
    weights,
    hard,
    shiftVars,
    byNurse,
    byShift,
    lockedByNurse,
    lockedByShift,
    name: (n) => `${model.nurses[n]!.firstName} ${model.nurses[n]!.lastName}`,
    timeline(n) {
      const cached = timelines.get(n);
      if (cached) return cached;
      const entries: TimelineEntry[] = [];
      for (const a of model.prior[n]!) {
        const type = typeById.get(a.shiftTypeId);
        if (!type)
          throw new Error(`Prior assignment ${a.id} has unknown shift type ${a.shiftTypeId}`);
        entries.push(timelineEntry(null, false, a.date, type, a, null));
      }
      for (const a of lockedByNurse[n]!) {
        const shift = model.shiftOf(a);
        entries.push(timelineEntry(null, true, a.date, shift.shiftType, a, shift));
      }
      for (const sv of byNurse[n]!) {
        entries.push(
          timelineEntry(sv.variable, true, sv.shift.date, sv.shift.shiftType, null, sv.shift),
        );
      }
      entries.sort(
        (x, y) =>
          x.window.startMinute - y.window.startMinute ||
          x.shiftType.sortOrder - y.shiftType.sortOrder,
      );
      timelines.set(n, entries);
      return entries;
    },
  };

  // --- Rules, then the objective --------------------------------------------------------
  for (const [ruleId, config] of hard) {
    const encoder = encoders[ruleId]!;
    if (encoder !== 'by-construction') encoder(ctx, config.params as Record<string, unknown>);
  }
  encodeObjective(ctx);

  const cp = b.build(OBJECTIVE_SCALE);
  if (options.hint) {
    // A complete hint — every auxiliary at the value the evaluator derives — so CP-SAT starts
    // from the hinted schedule's true cost. Hinting only the decisions left it to complete the
    // auxiliaries itself, and its first completion carried thousands of points of slack.
    const { values } = b.evaluate(decisionsFor({ shiftVars }, options.hint), OBJECTIVE_SCALE);
    cp.solution_hint = { vars: values.map((_, v) => v), values };
  }
  return {
    model: cp,
    builder: b,
    solverModel: model,
    shiftVars,
    weights,
    objectiveScale: OBJECTIVE_SCALE,
  };
}

/**
 * The decision values that describe a schedule: 1 for each unlocked assignment's variable.
 * Locked assignments are constants and skipped. An unlocked assignment with no variable (on
 * leave, on a locked day, outside the staffable shifts) throws — it is not a schedule this
 * model can represent.
 */
export function decisionsFor(
  encoding: Pick<CpsatEncoding, 'shiftVars'>,
  assignments: readonly Assignment[],
): Map<number, number> {
  const index = new Map(
    encoding.shiftVars.map((sv) => [
      `${sv.nurseId}|${sv.shift.date}|${sv.shift.shiftType.id}`,
      sv.variable,
    ]),
  );
  const out = new Map<number, number>();
  for (const a of assignments) {
    if (a.isLocked) continue;
    const variable = index.get(`${a.nurseId}|${a.date}|${a.shiftTypeId}`);
    if (variable === undefined) {
      throw new Error(`No CP-SAT variable for ${a.nurseId} on ${a.date} (${a.shiftTypeId})`);
    }
    out.set(variable, 1);
  }
  return out;
}
