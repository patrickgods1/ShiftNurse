/**
 * What ShiftNurse does not enforce yet, each with what the manager does by hand. The same list
 * is in README.md; a manager who assumes the app covers one of these finds out from a grievance,
 * so it is stated where they will look.
 */

export const NOT_ENFORCED: readonly string[] = [
  'Some state limits stay with you: Oregon’s cap of 7 patients per nursing assistant on day and evening shifts and 11 at night (ORS 441.768); labor and delivery and postpartum ratios, which turn on the patient (set them as acuity-tier ratios); and the emergencies that lift West Virginia’s 16 hours in 24, which here holds until you switch “Most hours in any 24” off.',
  'Oregon’s staffing-plan deviations: record and justify any departure from the unit’s staffing plan yourself.',
  'Leave accrual is projected from the last payroll figure under Settings › Leave: part-time accrual counts hours worked, not other paid hours, and the federal 6-hour tier’s extra 10 hours in the leave year’s last pay period is not added, so re-enter payroll’s figures now and then.',
  'Military leave (120 hours a fiscal year), court leave and paid parental leave are leave types without entitlements of their own: check the hours available with HR.',
  'FMLA leave already taken is counted at the nurse’s current contract: if their FTE changed during the year, check the hours used with HR.',
  'Break premiums are priced at the base rate: California pays them at the regular rate, which includes differentials, so add the difference in payroll.',
  'Float staff: Generate may offer a float nurse on any day of the period, not only the dates of their membership; check the dates yourself.',
  'Tour rotation limits (Settings › Rules) are checked on the grid, but Generate does not steer away from them while the rule is soft: make it hard to have Generate keep to them.',
  'Leave bids and other requests are entered by the manager: nurses do not submit them in the app yet.',
];

export const PRESETS_DISCLAIMER =
  'The state presets are a starting point, not legal advice: check them against your contract and your state’s law.';
