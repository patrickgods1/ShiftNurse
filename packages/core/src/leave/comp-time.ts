/**
 * How much comp time an hour of overtime earns, and how much overtime is still paid in cash.
 *
 * Comp time in place of overtime pay is lawful only for public employers (29 U.S.C. § 207(o):
 * 1.5 hours per overtime hour, by prior agreement, capped at 240 hours for most work). VA Title 38
 * nurses get it only when "voluntarily requested in writing by the nurse" (38 U.S.C. § 7453(e)(3)),
 * and UC–CNA 2025–2030 Art. 14 § L.3 grants it by the nurse's election, capped at 240 hours. Whether
 * a nurse has elected it is the caller's business; this is only the arithmetic.
 *
 * Hours past the cap cannot be banked, so they are paid as overtime in cash — without
 * `paidOvertimeHours` those hours would be credited past the cap or vanish from payroll.
 */

export function compTimeCredit(input: {
  /** Overtime worked inside the nurse's election this period. */
  overtimeHours: number;
  /** Comp hours banked per overtime hour, e.g. 1.5. */
  hoursPerOvertimeHour: number;
  /** The most comp time a nurse may hold; null for no cap. */
  capHours: number | null;
  /** The nurse's comp balance projected to the period's last day. */
  projectedBalanceHours: number;
}): { creditedHours: number; paidOvertimeHours: number } {
  const { overtimeHours, hoursPerOvertimeHour: rate, capHours, projectedBalanceHours } = input;
  if (!(rate > 0)) throw new Error('The comp time rate must be more than zero.');
  if (overtimeHours < 0) throw new Error('Overtime hours cannot be negative.');
  // A balance already past the cap leaves no room, never negative room.
  const room =
    capHours === null ? Number.POSITIVE_INFINITY : Math.max(0, capHours - projectedBalanceHours);
  const creditedHours = Math.min(overtimeHours * rate, room);
  return { creditedHours, paidOvertimeHours: overtimeHours - creditedHours / rate };
}
