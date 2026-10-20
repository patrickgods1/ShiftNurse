/**
 * The one mapping from a period's `SolveInput` to the `RuleContext` its rules read.
 *
 * Generate, the conflicts engine and the grid must judge a period from the same rows, or a
 * schedule Generate calls legal turns a cell red on screen. Each used to spell out this mapping
 * itself, and an input added to `SolveInput` reached only the copies someone remembered to edit
 * (float leave and credentials once drifted that way). Now an input forwarded here reaches all
 * three. The overrides are for callers that already hold sorted or indexed nurses and shift
 * types (the solver, the conflicts engine) or judge hypothetical requests.
 */

import { DemandTable } from '../acuity/demand.js';
import type { Nurse, ShiftType, TimeOffRequest } from '../domain/entities.js';
import { buildRuleContext } from '../rules/registry.js';
import type { RuleContext } from '../rules/types.js';
import type { SolveInput } from './types.js';

/** The rule context a period's SolveInput describes; the one mapping the grid, conflicts and
 *  the solver share. Overrides exist for callers that index nurses/shift types themselves. */
export function ruleContextForInput(
  input: SolveInput,
  overrides: {
    nurses?: readonly Nurse[];
    shiftTypes?: readonly ShiftType[];
    timeOff?: readonly TimeOffRequest[];
    demand?: DemandTable;
  } = {},
): RuleContext {
  return buildRuleContext({
    unit: input.unit,
    demand: overrides.demand ?? new DemandTable(input.demand),
    nurses: overrides.nurses ?? input.nurses,
    shiftTypes: overrides.shiftTypes ?? input.shiftTypes,
    timeOff: overrides.timeOff ?? input.timeOff,
    credentials: input.credentials,
    nurseCredentials: input.nurseCredentials,
    shiftCredentialRequirements: input.shiftCredentialRequirements,
    holidays: input.holidays,
    weekendDefinition: input.ruleSet.weekendDefinition,
    ...(input.paidSickCalls ? { paidSickCalls: input.paidSickCalls } : {}),
    ...(input.incompatibilityGroups ? { incompatibilityGroups: input.incompatibilityGroups } : {}),
    ...(input.holidayWork ? { holidayWork: input.holidayWork } : {}),
    ...(input.overtimeVolunteers ? { overtimeVolunteers: input.overtimeVolunteers } : {}),
    ...(input.preceptorships ? { preceptorships: input.preceptorships } : {}),
    ...(input.restWaivers ? { restWaivers: input.restWaivers } : {}),
    ...(input.availabilityBlocks ? { availabilityBlocks: input.availabilityBlocks } : {}),
    ...(input.historyFrom ? { historyFrom: input.historyFrom } : {}),
    ...(input.dstTransitions ? { dstTransitions: input.dstTransitions } : {}),
    preferences: input.preferences,
  });
}
