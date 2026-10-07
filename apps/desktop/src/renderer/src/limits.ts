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
  'VA 72/80 and Baylor schedules (38 U.S.C. § 7456A and § 7456): the app cannot pay six 12-hour tours in 14 days as 80 hours, nor two 12-hour weekend tours as 40, because contracted hours and overtime are judged on the hours worked; a unit on one of these plans should set contracted hours to the hours actually scheduled and handle the pay difference in payroll.',
  'In-lieu-of holidays (federal, 5 U.S.C. § 6103(b)): when a nurse’s regular day off falls on a holiday, their in-lieu day is not marked and work on it is not paid at the holiday premium here; holiday pay applies only to the calendar holiday.',
  'Compensatory time earned instead of overtime pay: the app prices overtime and holds a comp-leave balance, but does not convert overtime worked into comp time earned; add earned comp time to the nurse’s balance under Leave on their Roster page.',
  'UC–CNA’s consecutive-shift premium (Art. 14 § I.3: a 12-hour nurse working more than four full shifts in four days is paid 1.5× until a day off): the “Consecutive shift limits” rule’s “Most days in a row” can be set to 4 and the rule made soft in Settings › Rules so the grid flags it, but nothing prices it; add the premium in payroll.',
  'California sick leave (Lab. Code § 246) use cap and front-loading, and Pregnancy Disability Leave: the app accrues sick leave and caps the balance, but does not cap use at 40 hours a year or front-load; PDL has no leave type of its own, so book it as “State family leave”.',
  'UC–CNA’s exemption of career nurses with ten or more years from forced rotation (Art. 14 § P): set those nurses’ permanent tour by hand; the app has no seniority-based exemption.',
];

export const PRESETS_DISCLAIMER =
  'The state presets are a starting point, not legal advice: check them against your contract and your state’s law.';
