/**
 * What ShiftNurse does not enforce yet, each with what the manager does by hand. The same list
 * is in README.md; a manager who assumes the app covers one of these finds out from a grievance,
 * so it is stated where they will look.
 */

export const NOT_ENFORCED: readonly string[] = [
  'Seniority-ordered leave bidding: decide who gets contested days off by seniority yourself, then enter the approved leave.',
  'Low-census cancellation order: choose by hand who is cancelled first when the census drops, as your contract orders it.',
  'Float pool and staff who work on several units: a nurse is on one unit here, so check a floated nurse’s hours and rest across units yourself.',
  'Leave balances and FMLA: track accrued hours and FMLA eligibility outside the app; it records leave but never checks it against a balance.',
  'Ratios that pool RNs and LVNs: Title 22 lets LVNs be up to half of licensed staff, but ShiftNurse counts RNs only, which is stricter, so relax it by hand where your unit uses LVNs.',
  'Meal- and rest-break premium pay: add the premium for a missed break to payroll yourself; costing prices hours worked only.',
  'Preceptor pairing for orientees: pair each orientee with their preceptor on the grid yourself; the app only requires an experienced RN on the shift.',
  'Hour caps on overtime in Oregon (ORS 441.166) and Massachusetts (16 hours): watch the total hours in a row for nurses on overtime yourself.',
  'Oregon’s staffing-plan deviations: record and justify any departure from the unit’s staffing plan yourself.',
];

export const PRESETS_DISCLAIMER =
  'The state presets are a starting point, not legal advice: check them against your contract and your state’s law.';
