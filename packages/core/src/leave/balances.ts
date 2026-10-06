/**
 * Leave balances: whether a nurse has the paid hours a request asks for.
 *
 * A request approved against a balance that cannot pay it becomes unpaid leave the nurse did not
 * agree to, or a payroll correction weeks later. These are the sums; the balances themselves are
 * records the database keeps. FMLA lives in `fmla.ts`.
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
