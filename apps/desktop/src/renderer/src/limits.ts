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
  'In-lieu-of holidays (federal, 5 U.S.C. § 6103(b)): when a nurse’s regular day off falls on a holiday, their in-lieu day is not marked and work on it is not paid at the holiday premium here; holiday pay applies only to the calendar holiday.',
  'Compensatory time earned instead of overtime pay: the app prices overtime and holds a comp-leave balance, but does not convert overtime worked into comp time earned; add earned comp time to the nurse’s balance under Leave on their Roster page.',
  'California’s shortened alternative-workweek day (Wage Order 5 § 3(B)(2)): when you require a 12-hour nurse to work fewer hours than scheduled, that day’s overtime is past 8 hours at 1.5× and past 12 at 2×; the app prices the day by the unit’s usual rules.',
  'UC–CNA Art. 14 § O.1’s premium of 1.5× for a work period not preceded by six hours off is not priced; the minimum-rest rule can refuse the turnaround instead.',
  'UC–CNA values cite the 2022–2025 agreement; a 2025–2030 agreement was ratified on 22 November 2025 and its articles were not yet published when this was written, so check Article 14’s numbers against it.',
  'Title 22 § 70217(c)–(d): the written staffing plan with required versus actual staffing by shift and its one-year retention is not produced here; the Demand page and published schedules hold the figures.',
];

export const PRESETS_DISCLAIMER =
  'The state presets are a starting point, not legal advice: check them against your contract and your state’s law.';
