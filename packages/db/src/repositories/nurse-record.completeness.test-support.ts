/**
 * The hand-written list both record tripwires share: written by hand so it cannot agree with the
 * code under test by construction.
 */

/** Every audited kind of entry that names a nurse; `nurse-record.entries.test.ts` has a case for each. */
export const NURSE_SCOPED = [
  'assignment',
  'call_attempt',
  'call_off',
  'conflict',
  'day_of_pay_event',
  'fairness_ledger',
  'float_record',
  'holiday_work',
  'leave_balance',
  'leave_bid',
  'nurse',
  'nurse_credential',
  'nurse_unit',
  'overtime_volunteer',
  'pay_rate',
  'preceptorship',
  'preference',
  'rest_waiver',
  'schedule_change',
  'shift_cancellation',
  'shift_swap',
  'time_off_request',
] as const;

export type NurseScoped = (typeof NURSE_SCOPED)[number];
