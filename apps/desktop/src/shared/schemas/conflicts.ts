/** Argument schemas for `conflicts`. */

import type { Violation } from '@shiftnurse/core';
import { z } from 'zod';
import { id, isoDate, money, object, type ResourceSchemas, text } from './primitives.js';

const policy = object({
  enabled: z.boolean(),
  maxCostDelta: money,
  maxFairnessDrop: z.number().min(0),
});

const action = z.discriminatedUnion('type', [
  object({
    type: z.literal('create_assignment'),
    nurseId: id,
    shiftTypeId: id,
    date: isoDate,
    isCharge: z.boolean(),
    isOvertime: z.boolean(),
  }),
  object({
    type: z.literal('move_assignment'),
    assignmentId: id,
    toDate: isoDate,
    toShiftTypeId: id,
  }),
  object({ type: z.literal('delete_assignment'), assignmentId: id }),
  object({ type: z.literal('deny_time_off'), timeOffId: id }),
  object({ type: z.literal('accept_shortfall'), conflictId: z.string() }),
]);

// Violations are produced by the rule engine and only round-trip through the card; their
// identity and shape-of-list are checked, their free-form `details` are not.
const violation = z.custom<Violation>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { ruleId?: unknown }).ruleId === 'string' &&
    typeof (value as { message?: unknown }).message === 'string',
  'must be a rule violation',
);

const impact = object({
  coverage: object({
    hardShortfallBefore: z.number(),
    hardShortfallAfter: z.number(),
    delta: z.number(),
  }),
  fairness: object({
    unitScoreBefore: z.number(),
    unitScoreAfter: z.number(),
    delta: z.number(),
    affected: z.array(object({ nurseId: id, before: z.number(), after: z.number() })),
  }),
  cost: object({
    dollarsBefore: z.number(),
    dollarsAfter: z.number(),
    delta: z.number(),
    unpriced: z.boolean(),
  }),
  softViolationsIntroduced: z.array(violation),
  softViolationsCleared: z.array(violation),
});

const resolution = object({
  id: z.string().min(1),
  conflictId: z.string().min(1),
  kind: z.enum([
    'assign_available',
    'authorize_overtime',
    'move_assignment',
    'deny_time_off',
    'remove_assignment',
    'accept_shortfall',
  ]),
  title: text,
  description: text,
  actions: z.array(action),
  impact,
  score: z.number(),
  nurseIds: z.array(id),
  closesConflict: z.boolean().optional(),
});

export const conflictsSchemas = {
  analyse: z.tuple([id]),
  policy: z.tuple([id]),
  savePolicy: z.tuple([id, policy]),
  resolve: z.tuple([id, resolution, text]),
  autoResolve: z.tuple([id]),
} satisfies ResourceSchemas<'conflicts'>;
