/**
 * The assisted guide's step titles and the summary's "done / left for later" status, kept out
 * of the components so they can be tested under plain Node.
 */

import { addDays, type IsoDate, type SetupStepId, weekdayOf } from '@shiftnurse/core';

export const STEP_TITLES: Record<SetupStepId, string> = {
  state: 'State and contract law',
  'shift-types': 'Shift types',
  coverage: 'Staffing floors',
  acuity: 'Acuity and ratios',
  holidays: 'Holidays',
  rules: 'Contract rules',
  pay: 'Pay',
  unit: 'Unit policies',
  leave: 'Leave',
  requests: 'Requests and generation',
  roster: 'Roster',
  finish: 'Summary',
};

/**
 * Where each step's editor lives afterwards, for the summary's "finish later" hint. Keys are in
 * step order: the summary lists them in this order.
 */
export const STEP_HOME: Record<Exclude<SetupStepId, 'finish'>, string> = {
  state: 'Settings › Unit',
  'shift-types': 'Settings › Shift types',
  coverage: 'Settings › Coverage floors',
  acuity: 'Settings › Acuity',
  holidays: 'Settings › Holidays',
  rules: 'Settings › Rules',
  pay: 'Settings › Pay',
  unit: 'Settings › Unit',
  leave: 'Settings › Leave',
  requests: 'Settings › Requests (the schedule builder is in Settings › Schedule builder)',
  roster: 'Roster',
};

/** Pay periods start on the most recent Sunday unless the manager says otherwise. */
export function defaultPayPeriodAnchor(today: IsoDate): IsoDate {
  return addDays(today, -weekdayOf(today));
}

export interface SetupCounts {
  /** A state preset has been applied, including "no preset applies". */
  hasJurisdiction: boolean;
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
    state: counts.hasJurisdiction,
    'shift-types': counts.shiftTypes > 0,
    coverage: counts.coverage > 0,
    acuity: counts.acuityTiers > 0 && counts.ratioRules > 0,
    holidays: counts.holidays > 0,
    // A unit with no saved rule set is judged by the defaults, so the rules are in force
    // unless the manager explicitly left them for later.
    rules: !skipped.includes('rules'),
    pay: counts.roleRates > 0,
    // Unit policies, leave and requests all start from working defaults and have no preset of
    // their own, so like the rules they are done unless left for later; otherwise Continue on a
    // reviewed default would record it as skipped.
    unit: !skipped.includes('unit'),
    leave: !skipped.includes('leave'),
    requests: !skipped.includes('requests'),
    roster: counts.nurses > 0,
  }[step];
  if (done) return 'done';
  return skipped.includes(step) ? 'skipped' : 'empty';
}
