/** Argument schemas for `rules`. */

import { z } from 'zod';
import { count, id, object, type ResourceSchemas, text } from './primitives.js';

/** Parameters differ per rule and are documented on the rule itself (`Rule.paramDocs`), so only
 * the envelope is checked here; the rule engine reads what it knows from `params`. */
const ruleConfig = object({
  ruleId: id,
  enabled: z.boolean(),
  severityOverride: z.enum(['hard', 'soft']).optional(),
  params: z.record(z.string(), z.unknown()),
});

const weekday = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
]);

const weekendDefinition = object({
  startWeekday: weekday,
  startMinute: count,
  durationMinutes: count,
  mode: z.enum(['starts_within', 'overlaps']),
});

const weight = z.number().min(0, 'must be zero or more');
const fairnessWeights = object({
  nights: weight,
  weekends: weight,
  holidays: weight,
  onCall: weight,
  undesirable: weight,
  overtime: weight,
  preferences: weight,
  timeOff: weight,
});

export const rulesSchemas = {
  getLatest: z.tuple([id]),
  save: z.tuple([
    id,
    text,
    z.array(ruleConfig),
    weekendDefinition,
    fairnessWeights,
    text.optional(),
  ]),
} satisfies ResourceSchemas<'rules'>;
