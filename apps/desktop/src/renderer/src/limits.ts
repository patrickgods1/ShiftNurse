/**
 * What ShiftNurse does not enforce yet, each with what the manager does by hand. The same list
 * is in README.md; a manager who assumes the app covers one of these finds out from a grievance,
 * so it is stated where they will look.
 */

export const NOT_ENFORCED: readonly string[] = [
  'Some state limits stay with you: Oregon’s CNA cap limits each aide’s own patients; ShiftNurse checks it only when your CNAs together take every patient (Settings › Unit › State law); labor and delivery and postpartum ratios, which turn on the patient (set them as acuity-tier ratios); and the emergencies that lift West Virginia’s 16 hours in 24, which here holds until you switch “Most hours in any 24” off.',
  'Oregon’s staffing-plan deviations: record and justify any departure from the unit’s staffing plan yourself.',
  'Leave accrual is projected from the last payroll figure under Settings › Leave: part-time accrual counts hours worked, not other paid hours, so re-enter payroll’s figures now and then.',
  'Military leave (120 hours a fiscal year), court leave and paid parental leave are leave types without entitlements of their own: check the hours available with HR.',
  'FMLA leave already taken is counted at the nurse’s current contract: if their FTE changed during the year, check the hours used with HR.',
  'Pregnancy disability leave is counted per pregnancy through the certification you record. Without one it is counted over the last 12 months.',
  'Most hours in any 24 and long stretches of work are checked on the grid, but Generate does not steer away from them while they are soft: make them hard to have Generate keep to them.',
  'Leave bids and other requests are entered by the manager: nurses do not submit them in the app yet.',
  'In-lieu-of holidays (federal, 5 U.S.C. § 6103(b)): ShiftNurse names each full-time nurse’s in-lieu day when you turn it on in Settings › Unit, but does not pay work on that day at the holiday premium; holiday pay applies only to the calendar holiday.',
  'California’s shortened alternative-workweek day (Wage Order 5 § 3(B)(2)): when you require a 12-hour nurse to work fewer hours than scheduled, that day’s overtime is past 8 hours at 1.5× and past 12 at 2×; the app prices the day by the unit’s usual rules.',
  'Patient-by-patient assignment records (22 CCR § 70217(d)) are not kept here.',
];

export const PRESETS_DISCLAIMER =
  'The state presets are a starting point, not legal advice: check them against your contract and your state’s law.';
