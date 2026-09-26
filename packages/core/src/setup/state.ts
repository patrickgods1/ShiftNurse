/**
 * First-run setup: which of the welcome screen, the assisted guide or the app a launch opens.
 *
 * The decision is persisted rather than inferred from "is there any data yet", because a
 * manager part-way through the assisted guide already has a unit and some shift types, and
 * inferring would drop them into a half-configured app the next time they launched. An
 * install that predates setup has units and no setup row at all; it must open straight into
 * the app, never the welcome screen.
 */

import type { NurseRole, Timestamp } from '../domain/entities.js';
import type { AcuityPresetId, ShiftPatternId } from './presets.js';

/** `scenarios` is the developer-only test database (see `db/seed/scenarios.ts`). */
export type SetupMode = 'demo' | 'scenarios' | 'manual' | 'assisted';

/** The modes that start from a unit the manager names, rather than a seeded one. */
export type UnitSetupMode = 'manual' | 'assisted';

/** The assisted guide's steps, in order. The unit itself is created before the first one. */
export const SETUP_STEPS = [
  'shift-types',
  'coverage',
  'acuity',
  'holidays',
  'rules',
  'pay',
  'roster',
  'finish',
] as const;

export type SetupStepId = (typeof SETUP_STEPS)[number];

export function isSetupStep(value: string): value is SetupStepId {
  return (SETUP_STEPS as readonly string[]).includes(value);
}

export interface SetupState {
  mode: SetupMode;
  status: 'in_progress' | 'complete';
  /** Where the assisted guide resumes; `null` once setup is complete or for demo/manual. */
  currentStep: SetupStepId | null;
  /** Steps the manager chose to leave for later, shown on the summary as still to do. */
  skippedSteps: SetupStepId[];
  startedAt: Timestamp;
  completedAt: Timestamp | null;
}

export type SetupPhase = 'welcome' | 'assisted' | 'ready';

export function setupPhase(state: SetupState | undefined, hasUnit: boolean): SetupPhase {
  if (!hasUnit) return 'welcome';
  return state?.status === 'in_progress' ? 'assisted' : 'ready';
}

export function nextSetupStep(step: SetupStepId): SetupStepId | undefined {
  return SETUP_STEPS[SETUP_STEPS.indexOf(step) + 1];
}

export function previousSetupStep(step: SetupStepId): SetupStepId | undefined {
  const index = SETUP_STEPS.indexOf(step);
  return index > 0 ? SETUP_STEPS[index - 1] : undefined;
}

/** A one-click starting point from the guide, applied through the ordinary audited writes. */
export type SetupPreset =
  | { kind: 'shift-pattern'; pattern: ShiftPatternId }
  | { kind: 'acuity'; preset: AcuityPresetId }
  | { kind: 'coverage'; shiftTypeIds: string[]; counts: Partial<Record<NurseRole, number>> }
  | { kind: 'holidays'; years: number[] }
  | { kind: 'rules' }
  | { kind: 'base-rates'; rates: Partial<Record<NurseRole, number>> };

/** What a preset did: rows written fresh, rows changed in place, rows already there. */
export interface SetupPresetResult {
  created: number;
  updated: number;
  unchanged: number;
}
