/**
 * The assisted guide's step titles and the summary's "done / left for later" status, kept out
 * of the components so they can be tested under plain Node.
 */

import { addDays, type IsoDate, type SetupStepId, weekdayOf } from '@shiftnurse/core';

export const STEP_TITLES: Record<SetupStepId, string> = {
  'shift-types': 'Shift types',
  coverage: 'Staffing floors',
  acuity: 'Acuity and ratios',
  holidays: 'Holidays',
  rules: 'Contract rules',
  pay: 'Pay',
  roster: 'Roster',
  finish: 'Summary',
};

/** Where each step's editor lives afterwards, for the summary's "finish later" hint. */
export const STEP_HOME: Record<Exclude<SetupStepId, 'finish'>, string> = {
  'shift-types': 'Settings › Shift types',
  coverage: 'Settings › Coverage floors',
  acuity: 'Settings › Acuity',
  holidays: 'Settings › Holidays',
  rules: 'Settings › Rules',
  pay: 'Settings › Pay',
  roster: 'Roster',
};

/** Pay periods start on the most recent Sunday unless the manager says otherwise. */
export function defaultPayPeriodAnchor(today: IsoDate): IsoDate {
  return addDays(today, -weekdayOf(today));
}

export interface SetupCounts {
  shiftTypes: number;
  coverage: number;
  acuityTiers: number;
  ratioRules: number;
  holidays: number;
  /** Role base rates (not per-nurse overrides). */
  roleRates: number;
  nurses: number;
}

export type StepStatus = 'done' | 'skipped' | 'empty';

export function stepStatus(
  step: Exclude<SetupStepId, 'finish'>,
  counts: SetupCounts,
  skipped: readonly SetupStepId[],
): StepStatus {
  const done = {
    'shift-types': counts.shiftTypes > 0,
    coverage: counts.coverage > 0,
    acuity: counts.acuityTiers > 0 && counts.ratioRules > 0,
    holidays: counts.holidays > 0,
    // A unit with no saved rule set is judged by the defaults, so the rules are in force
    // unless the manager explicitly left them for later.
    rules: !skipped.includes('rules'),
    pay: counts.roleRates > 0,
    roster: counts.nurses > 0,
  }[step];
  if (done) return 'done';
  return skipped.includes(step) ? 'skipped' : 'empty';
}
