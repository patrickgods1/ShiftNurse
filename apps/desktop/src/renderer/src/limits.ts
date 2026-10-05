/**
 * What ShiftNurse does not enforce yet, each with what the manager does by hand. The same list
 * is in README.md; a manager who assumes the app covers one of these finds out from a grievance,
 * so it is stated where they will look.
 */

export const NOT_ENFORCED: readonly string[] = [
  'Hour caps on overtime in Oregon (ORS 441.166) and Massachusetts (16 hours): watch the total hours in a row for nurses on overtime yourself.',
  'Oregon’s staffing-plan deviations: record and justify any departure from the unit’s staffing plan yourself.',
  'Leave accrual: balances are entered from payroll; the app checks requests against them but does not accrue leave from hours worked, so update them each pay period.',
  'FMLA eligibility uses the seniority date as the hire date: check a nurse whose bargained seniority predates their hire against HR’s records.',
  'FMLA leave already taken is counted at the nurse’s current contract: if their FTE changed during the year, check the hours used with HR.',
  'Break premiums are priced at the base rate: California pays them at the regular rate, which includes differentials, so add the difference in payroll.',
  'Float staff: other units’ shifts count as busy time, but who floats is not rotated fairly across the team, and Generate may offer a float nurse on any day of the period, not only the dates of their membership; keep the turn and check the dates yourself.',
  'Leave bids and other requests are entered by the manager: nurses do not submit them in the app yet.',
];

export const PRESETS_DISCLAIMER =
  'The state presets are a starting point, not legal advice: check them against your contract and your state’s law.';
