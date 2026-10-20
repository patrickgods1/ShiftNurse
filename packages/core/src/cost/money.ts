/**
 * Money at the cent — the one place dollar amounts are rounded.
 *
 * Payroll pays every line in whole cents. Floating-point products leave amounts like
 * 158.48999999999998 and sums like 0.30000000000000004, so without rounding at the line the
 * app's totals drift from the payslip's by a cent here and there, and float dust such as
 * $1.8e-13 shows up as an "overtime line" nobody will be paid. Lines are rounded once, here,
 * and totals add whole cents, so a total is always exactly the sum of its lines.
 */

/** Dollars rounded to the cent, half up. The toFixed(6) step absorbs binary error first, so
 *  1.005 rounds to 1.01 rather than to the 1.00 that Math.round(100.49999…) would give. */
export function roundCents(dollars: number): number {
  return Math.round(Number((dollars * 100).toFixed(6))) / 100;
}

/** The sum of amounts already in cents, exact to the cent. */
export function sumCents(amounts: readonly number[]): number {
  let cents = 0;
  for (const amount of amounts) cents += Math.round(amount * 100);
  return cents / 100;
}
