/**
 * Leave balances: whether a nurse has the paid hours a request asks for.
 *
 * A request approved against a balance that cannot pay it becomes unpaid leave the nurse did not
 * agree to, or a payroll correction weeks later. These are the sums; the balances themselves are
 * records the database keeps. FMLA lives in `fmla.ts`.
 *
 * A balance can be large enough and the request still be past the law: California lets an
 * employer cap sick leave *used* in a year at 40 hours (Lab. Code § 246(b)(1), (d)) however much
 * has accrued, so the cap is checked on its own, against what was used since the leave year began.
 */

export type BalanceCheck =
  | { ok: true; remainingHours: number }
  | { ok: false; shortHours: number; message: string };

export function checkLeaveBalance(input: {
  balanceHours: number;
  requestHours: number;
}): BalanceCheck {
  const left = input.balanceHours - input.requestHours;
  if (left >= 0) return { ok: true, remainingHours: left };
  return {
    ok: false,
    shortHours: -left,
    message: `This request pays ${input.requestHours} hours; the balance is ${input.balanceHours}, ${-left} short.`,
  };
}

/** Whether this request keeps the leave year's use within the cap, and by how many hours it does not. */
export function checkUseCap(input: {
  usedThisYearHours: number;
  requestHours: number;
  useCapHoursPerYear: number;
}): { ok: boolean; overBy: number } {
  const overBy = Math.max(
    0,
    input.usedThisYearHours + input.requestHours - input.useCapHoursPerYear,
  );
  return { ok: overBy === 0, overBy };
}
