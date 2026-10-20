# Changelog

What changed for people running ShiftNurse, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the `vX.Y.Z` release
tags. Each release's notes link here.

## [Unreleased]

### Before you upgrade

- **Seniority ties break by employee number, compared as numbers (E9 before E10), everywhere.**
  Holiday, request, float and cancellation orders can come out differently from before wherever
  two nurses tie. Look at the next order before you rely on it.
- **A charge nurse must be an RN, and two charge nurses on a shift are flagged.** If your unit
  lets an LPN/LVN take charge, turn off "Charge nurse must be an RN" in Settings › Rules ›
  Coverage minimums before you publish.
- **California sick-leave caps and Oregon's emergency department ceiling changed in the presets.**
  A unit that applied them earlier keeps its stored caps (40 and 80 hours, 1:4); to take the new
  figures, re-apply the preset and review what it asks about, or edit them in Settings › Leave
  and Settings › Rules.
- **Fairness compares each nurse's share per day she was available, and older history counts for
  less.** Scores and the order of who is next for nights, weekends and holidays move. Check the
  Fairness page before you generate the first schedule.
- **Overtime pay is priced differently.** It no longer depends on the order of shifts, a night
  that crosses the week's edge is split by the clock (a setting in Settings › Pay › Stacking),
  and daily overtime no longer also counts toward the weekly or 80-hour thresholds by default.
  Cost totals will differ from before; published schedules keep the cost they went out with.
- **Floating a nurse out keeps her shift on the grid, locked and marked.** Floats made before this
  release were deleted and are not restored: record them again if you still need them.
- **A second coverage floor or pay rate for the same day was tidied on upgrade**, keeping the one
  in use. The activity log lists what was removed; check it against your records.

### Added

#### Federal VA units

- **VA (Title 38) preset** in Settings › Unit, which applies no state law: the cap on required
  overtime (40 hours a week, 8 in a row, or 12 on a compressed tour), 11 hours of rest, two
  weekends off in four, and the VA's leave policy. Its values come from the VA–NNU national
  agreement, so a unit under a different local should check them against its own.
- **Night and evening pay by clock time**: a differential is earned by the hours worked inside its
  window, so a tour that mostly falls in the evening is paid for what it covers.
- **72/80 and Baylor nurses**: mark a nurse on the roster form and the preset follows her plan,
  with overtime by plan, Baylor tours paid without premiums, Baylor's 24-hour cap on required
  overtime, and leave charged 10 hours for 9 on 72/80. Her hourly rate is worked out from the
  plan's hours in a year.
- **VA pay by statute** (Settings › Pay): premiums add up on basic pay, holiday pay replaces
  overtime on holiday hours, the weekend premium covers any tour that touches the weekend, on-call
  pays 15%, and a call-back is paid at least two hours.
- The VA San Francisco demo now follows VA practice: the VA preset, clock-time night pay, seeded
  FMLA, volunteers, preceptors, floats, plan nurses, a bid round and volunteered holdovers.

#### More states and contract rules

- **Eleven more state presets**: Illinois, Connecticut, Minnesota, New Jersey, Maine,
  Pennsylvania, New Hampshire, Rhode Island, West Virginia, Alaska and Texas, sixteen states in
  all beside the VA. Each cites its statute, switches on the ban on mandatory overtime as that
  law has it, and limits long stretches and the rest owed after them.
- **Full ratio tables**: California's by unit type, and Oregon's (ORS 441.765). Critical-care unit
  names (CCU, MICU, SICU, CVICU, neuro, trauma, PICU) get California's 1:2.
- **Long stretches**: a rule capping consecutive hours worked and the rest owed after (Massachusetts
  16 then 8, West Virginia, Pennsylvania, Alaska), with the limits even an emergency does not lift
  (Illinois 4 hours past the shift, Rhode Island 12 in a row). Off until a preset or you turn it on.
- **Contract rules**: tour rotation limits (Settings › Rules), rest waivers, overtime offered by
  roster, float rotation, per-diem commitments checked before publishing, holiday priority
  advice on Requests, consent before a posted shift changes, and hard accommodations.
- Applying a preset can ask about the VA's compressed tour or California's alternative
  workweek, and asks for a reason before you loosen a ratio or a rule the preset switched on.
- A VA unit can choose to follow its own contract instead of the preset's values.

#### Pay

- **California and UC overtime**: no pyramiding of overtime, double time on days beyond the
  scheduled ones, premiums that add up, and a minimum overtime increment. The California ICU demo
  pays hours past 12 at double.
- **Consecutive-shift differential**: a premium for shifts worked back to back (Settings › Pay).
- The overtime alert is priced by the unit's own overtime rules, not a fixed multiplier.

#### Leave

- **Leave policy** (Settings › Leave): leave types by employer (VA and state), a hire date apart
  from seniority, FMLA by regime and leave year, and accrual with carryover caps, projected from
  payroll's balance to the day of the request.
- **California sick leave**: use caps, front-loading, and pregnancy disability leave.

#### Holdovers and long stretches

- **Holdovers**: record on Today time a nurse worked past her shift's end, required or
  volunteered. It counts for rest, hour caps, overtime and pay, but not against contracted hours.
- **Most hours in any 24**: a rule (off by default) capping hours in any 24, and, for required
  overtime, the VA's consecutive-hours limit.
- **California alternative workweek**: no nurse required past 12 hours in any 24, 16 in a declared
  emergency, and 8 hours off after 24 straight.

#### Weekends and requests

- **Weekends off**: two weekends off in four, an alert for weekends off per year, and **two days
  off together**.
- **Competing requests**: advice on who gets a contested day off, and a **holiday appetite**
  preference that feeds holiday priority.

#### Setup guide and schedule grid

- **The guide has twelve steps**, starting with state law and adding unit policies, leave, and
  requests. Each step opens at its top, and the state list is sorted with each summary written as
  sentences.
- **The grid keeps its date rows in view** while you scroll, names the month, and spotlights the
  cell an alert is about.
- The roster CSV takes scheduled days per week.

#### Since the code review

- Move a holiday to another date (a reason is asked for when a published schedule covers it).
- A draft shows when newer rules exist and can switch to them.
- Settings › Unit › Paper size for printouts: Letter or A4 (follows this computer's region until
  chosen).
- If the window crashes or stops responding, ShiftNurse offers to reload it; after an internal
  error it offers to restart.
- The nurse record shows how each change to a published shift was made (grid edit, call-off
  backfill, low-census cancellation…).
- ShiftNurse now warns when its data folder is on a network drive, where the schedule database
  could be damaged, and tells you to ask IT to keep it on this computer.
- New README section for hospital IT: silent install, allowlisting, roaming profiles and how to
  turn off the update check.
- README explains what personal and HR information ShiftNurse keeps, and how to protect it.

### Changed

#### Schedules and Generate

- Generate never makes a rule break that locked shifts already carry any worse: it will not
  lengthen a locked run, join two, or trade one breach for another.
- A CP-SAT answer that breaks the rules the app itself checks stops the run with a message to
  report it, instead of being saved. When CP-SAT reports that it cannot build a schedule,
  Generate falls back to SA + LNS, which still gives a schedule, and the reason shown says that is
  a fault in CP-SAT's rules, not in your locked shifts, and lists the locked breaches only as
  context.
- Generate prices a short shift by how short it already is, each further slot costing more than the
  last, so it spreads shortages over shifts instead of piling them on one, and it can move a nurse
  to a different shift type on the same day to do it.
- Editing a shift type's hours after a schedule using it was published now offers a duplicate
  instead; old schedules keep the hours they were built with.
- Floating a nurse out keeps her shift on the schedule, locked and marked with where she went.
  Her hours still count for rest, overtime and pay, but no longer for this unit's staffing, Today,
  census or the grid headcount. Floats made before this release were deleted and are not restored.

#### Contract and state-law rules

- Applying a state preset now also tightens on/off settings of a rule that was already on (for
  example Massachusetts' 16-hour limit now counts volunteered hours and ignores emergency notes,
  as the law says).
- Loosening a setting a state preset set, such as raising Massachusetts' 16-hour limit, now asks
  for a reason, as switching the rule off already did.
- Loosening, re-citing or deactivating a patient ratio asks for a reason.
- The Oregon preset sets the emergency department ceiling at the statute's 5 patients at any time.
  Units that already applied it keep their 1:4.
- California sick leave is capped at the greater of 40 hours or 5 of the unit's usual shifts used a
  year, and 80 hours or 10 shifts held: 60 and 120 hours on 12-hour shifts, where it was 40 and
  80. A leave policy can now give a cap in days. A unit that applied the California preset
  before keeps its stored 40- and 80-hour caps; add the day caps under Settings › Leave.
- The "both 12- and 8-hour" shift pattern now runs the 8-hour day and night inside the 12-hour
  shifts, so they need no charge nurse of their own.
- Contracted hours are now checked for a pay period that a schedule starts in the middle of,
  counting the shifts already published for it. If the earlier part of the pay period was never
  published, only hours over the contract are checked.
- A recorded holdover no longer counts as authorising a whole week of overtime: it covers only the
  time it adds.
- The VA weekly limit on required hours no longer counts overtime the nurse volunteered for.
- A shift with two nurses marked charge is now flagged, and by default only an RN may be marked
  charge. Units that let an LPN/LVN take charge can turn off "Charge nurse must be an RN" in
  Settings › Rules › Coverage minimums.
- A career nurse exempt from rotation is no longer flagged for working a tour she asked for (a
  preferred shift type).
- Overtime a manager has authorised no longer counts against a nurse's FTE hours ceiling in
  Generate or in suggested fixes; it is still counted as overtime.
- Saved rule versions, published versions, the change log and pay snapshots can no longer be
  edited or deleted in the database file itself.

#### Requests, leave and bidding

- An approved request can only be withdrawn (with a reason), not denied or cancelled.
- Seniority ties break by employee number, compared as numbers, in every order that uses
  seniority.
- A bid round must be closed before it is awarded; closing early, or editing after bids are in,
  asks for a reason, and a bid outside the window is refused.
- A leave accrual tier changes from the pay period after the anniversary, and the last pay period
  of the federal leave year accrues 10 hours.
- A suggested fix never makes a rule break worse than it is now, for the nurse or the shift. The
  leave preview says "Worse than now" when approving would deepen a shortfall, and competing leave
  sees the pooled RN + LVN ratio.
- Fixes can move a shift to another day of the same work week, and over-hours findings offer
  taking the nurse off a shift. A fix whose pay is unknown shows "up to $X" at the unit's highest
  rate and is never applied automatically.

#### Today

- When a nurse calls off, the on-call nurse is first on the replacement list, and a card shows
  "… takes charge" when someone already on the shift must take charge instead. Exchange cards say
  the same.
- Low-census cancellation and floating never take off the only experienced RN, credential holder or
  preceptor on a shift; they are listed with why, so the next safe nurse comes first.
- Low-census cancellation sends nurses floated in home before the unit's own staff (new tier
  "Nurses floated in from other units", after agency; saved orders are updated).
- A shift with a recorded holdover cannot be moved, exchanged or covered; clear the holdover on
  Today first. Removing one offers no undo.

#### Roster, staffing needs, fairness and cost

- Fairness now compares each nurse's share of nights, weekends and holidays as a rate per day
  they were available, with older history counting for less (half every 180 days, within a year).
  New hires and staff back from leave (FMLA included) are no longer pushed to the front of the
  line, and per-diem staff are compared by their usual hours.
- "Overtime hours" on the Fairness page is now "Hours over contract".
- The fairness trend scores each past schedule under the rules it was published with.
- Roster import changes only what the file holds: a column the file lacks leaves that detail
  alone, and the preview lists the details each nurse would have changed or cleared. A departed
  nurse in the file stays inactive unless the manager ticks Reactivate.
- Overtime cost no longer depends on the order of the shifts: the premium is figured on the week's
  weighted regular rate, including night and evening pay.
- A night shift that crosses the end of a work week or pay period is split by the clock for weekly
  and 80-hour overtime; Settings › Pay › Stacking can count the whole shift in the week it starts.
- Daily overtime no longer also counts toward the weekly or 80-hour thresholds twice by default;
  the overtime form says so and lets a rule choose to stack.
- On the two nights the clocks change, pay and the legal hour caps count the hours actually
  worked: 13 on the fall-back night, 11 on the spring-forward night.
- Settings › Unit sets which day a night shift's holiday belongs to (the day it starts, the day
  most of it falls on, or each hour by the clock), and holiday premiums, rotation and the ledger
  all follow it.
- Hours and money are whole minutes and exact cents, so totals add up to the cent.
- The forecast's seasonal index counts each season once, shows the samples behind it, and the
  weekend alert looks at a real 52 weeks.

#### Publishing, backups and the app

- Start over asks you to type the unit's name.

### Fixed

#### Schedules and Generate

- Four nights in a row are now caught when a day shift sits next to them, and Generate no longer
  builds that pattern.
- A shift nested inside another no longer hides a double booking or a short rest after it.
- A "weekends in a row" finding now marks every weekend of the run on the grid, not only the last.
- A schedule laid over a published one now sees the shifts already posted on those days.
- A schedule or a leave request that ends before it starts is refused.
- Pressing Stop while CP-SAT is starting now stops it.
- Deactivating a nurse takes her draft shifts off from today, and is refused, in words, while she
  holds a shift on a published schedule; the dialog lists them. A nurse who left but still holds
  shifts keeps a row marked Inactive on the grid and the printout.
- The Staffing row counts the pooled RN + LPN ratio without counting a missing RN twice.
- The shift popover's pay-period hours include the published week before the schedule and paid
  leave.

#### Contract and state-law rules

- An evening tour that earns night pay is no longer treated as a night for rest and days off after
  nights.
- Kept-apart staff are no longer flagged, or "covered", by colleagues working on another unit.
- Two days off together now count a day worked on another unit, and no longer credit a Saturday
  from the previous pay period.
- Massachusetts: a break of up to an hour between shifts no longer resets the 16-consecutive-hour
  limit.
- A holdover that runs into the nurse's own next shift is refused with the number of minutes that
  would fit.
- With both a consecutive-hours and a 24-hour limit on required overtime, a required call-back in
  a short stretch is now checked against the 24-hour limit too.
- Rule settings the scheduler cannot use (a blank saved as nothing, a word in a number field) are
  refused when saved and reported in words when a schedule is checked, instead of silently
  switching a rule off.
- A floated-in nurse's accommodations, own pay rate, rest waivers, sick pay and expiring
  credentials now count on the unit she floats to.
- A multiplier below 1 on a differential is refused instead of cutting base pay, and a second
  active differential of the same kind is refused.

#### Requests, leave and bidding

- When the contract counts the night before leave, approving the leave takes the nurse off that
  night too.
- Leave eligibility counts published shifts on any unit, never drafts. California pregnancy
  disability leave is counted per pregnancy, by its certification.
- Approving leave that spans a published and a draft schedule takes the nurse off every posted
  shift in both, asks for a reason for the published one, and logs each in its own schedule.
- Requests no longer calls a draft "Covered" before anything is built, and Approve waits until
  the dialog knows which shifts the leave frees.
- A half-typed date no longer clears the saved one; Escape puts the saved date back. The request
  close date is saved once, when you leave the field, and an unchanged date writes nothing.
- New request no longer crashes Requests when its date is cleared.
- Applying a conflict fix re-checks it against the schedule as it is now; a fix that no longer
  applies is refused instead of written. Auto-resolve keeps the fixes it made when a later one is
  refused, and says where it stopped.
- Covering several freed shifts at once can no longer give one nurse two of them on the same day.
- A shift swap is checked when it is entered.
- Schedule, Requests, Fairness and Staffing needs share one chosen schedule period.
- Editing, backfilling or approving leave against the demo's past schedules no longer fails with
  "never been published".
- Own leave no longer counts against a nurse's bid or is paid twice, and a departed or moved nurse
  is denied in words.

#### Today

- Today no longer fails when a floated nurse starts the next day, and marks no shift as running
  when you look at another day.
- Today refreshes every minute and judges last night's shift against the schedule it was worked
  in; a call-off has no pre-selected outcome and never reads "0 slots short".
- Reporting-time pay for a nurse sent home on low census is booked only when the cancellation came
  too late (default: under 2 hours before the shift, configurable under Pay › Call-back).
- Overtime offers, orientations, rest waivers, missed-break pay, float records and low-census
  cancellations can be recorded for a nurse floated in, on the days her float membership covers.
  The missed-break premium is paid once a day, even across two units.
- A call-off that was cancelled because the nurse came in no longer counts as paid sick hours.

#### Roster, staffing needs, fairness and cost

- A second coverage floor or pay rate for the same day is refused ("change that one instead");
  before, which one applied depended on the order they were entered, and a same-day pay correction
  was silently ignored. Existing duplicates were tidied on upgrade, keeping the one in use, and
  listed in the activity log.
- Pay rates, differentials, overtime rules and budgets refuse negative or impossible numbers
  wherever they come from, and saving a pay rate with no changes no longer shows an error.
- Census forecasts only accept this unit's acuity tiers and shifts, and an older payroll balance
  can no longer overwrite a newer one.
- Republishing a schedule no longer leaves a nurse's old nights or weekends in the fairness
  history after their shifts moved to someone else.
- A nurse's exported record now includes required holdovers, orientation pairings, hand-recorded
  holiday work and history re-imports that concern her.
- Deleting an acuity tier that ratio rules or census days use is refused (it used to remove those
  rules silently); rename it instead.
- A holiday whose "who worked" list was recorded by hand can no longer be deleted until that list
  is cleared, and only nurses on the unit can be recorded as having worked it.
- A unit with no acuity tiers can record a census; census messages name tiers, not ids.
- A unit with no HPPD target can set one.
- A period budget can be removed. Loading no longer reads as "not set up", "no nurses scored" or
  as ids; failed checks and file imports say what failed.
- Staffing needs ranges are capped at 120 days and commit when you finish typing; the census
  editor can be cleared and keeps what you typed when the data refreshes.
- Typing in the coverage grid is no longer lost, and tabbing through it no longer fills the
  activity log; "Same all week" asks before it overwrites.
- Switching nurses in the open Roster drawer no longer carries one nurse's unsaved balance or
  open form into the next nurse's record.
- Preferences that fail to load show the error instead of an empty list whose Save would erase
  them; a row missing its shift type or holiday says which row, and prefer-and-avoid the same
  shift is refused.
- Granting a new credential type creates and grants it in one step, so a failed grant no longer
  leaves an orphan type that blocks the retry. Revoking a credential asks first and can record why,
  and clearing an expiry date asks first.
- Recording why an accommodation or kept-apart group changed no longer overwrites the reason the
  accommodation or group exists.
- Only an experienced RN, or an experienced nurse of the orientee's own role, can be named a
  preceptor.
- A roster sheet with a VA plan or scheduled days (including ShiftNurse's own export of a VA unit)
  now imports instead of being refused whole. Contracted hours must be a real number that fits in
  a pay period, and employee ids differing only in case count as duplicates.
- Changing a differential, overtime rule, pay setting or holiday no longer changes the cost of
  schedules already published. Each published schedule keeps the pay settings it went out under;
  the cost detail says which, and "Reprice with today's settings" asks for a reason.
- Demo units: the fairness history now counts denied requests and covered call-outs, and the
  VA Baylor nurse's weekends are exempt, as the app records them.
- Demo and test data: past call-offs, calls and leave decisions are dated when they happened,
  not when the data was loaded, so replacement suggestions spread calls correctly.
- California demo units: nursing-assistant pay meets the state health-care minimum wage; RN pay
  scales are marked illustrative; the welcome screen says the community unit is in California.
- Demo units no longer phone a nurse back onto a shift the day she called off sick, approve two
  vacations over the same days, or roster a nurse inside a block of FMLA leave.

#### Publishing, backups and the app

- On macOS, quitting after closing the window no longer does nothing when generated schedules are
  unsaved; ShiftNurse asks, and quits when you say so.
- A restore or start over that cannot replace the database now restarts ShiftNurse on the database
  you had, instead of leaving it unable to load anything.
- Long nurse records export to PDF, and a PDF that cannot be produced says so in plain words.
- Someone on a release candidate is told when the final release is out.
- Daily backups no longer leave journal files beside them in the backups folder; existing ones are
  tidied at the next launch.
- Daily backups removed after 14 days are now listed in the activity log.
- Publishing a schedule that still breaks hard rules asks for a reason, recorded with the number
  of breaks reviewed.
- Over-long text, ranges and numbers sent to the app's back end are refused with a clear message,
  and error messages name nurses and dates instead of internal ids.
- The setup guide asks before Back, Skip, Continue or "Set it up now" throws away unsaved edits,
  and a cleared staffing count no longer sets a floor of zero.
- Keyboard focus returns to what opened a dialog when it closes, and buttons are readable in dark
  mode.
- Renaming the unit no longer switches you to another unit.

### Security

- The installed app can no longer be run as a plain Node.js runtime, and checks its own files for
  tampering.

## [0.1.0] - 2026-10-05

First release: unsigned installers for macOS (Apple silicon and Intel) and Windows 10/11, each
built and self-tested on its own platform on GitHub Actions. ShiftNurse runs entirely on your
computer and keeps its data in one file; nurses do not log in yet, so the manager enters every
request.

### Schedules and Generate
- A schedule grid with live rule checks: drag shifts between days and nurses, swap two shifts in
  one edit, lock shifts, mark the charge nurse and overtime. Every edit can be undone from its
  toast or with Cmd/Ctrl-Z (up to 20 steps); on a published schedule the undo goes into the
  change log with its reason. The grid works from the keyboard too.
- A hard rule break shows as a solid border with an octagon, a soft one as a dashed border with a
  triangle, so they never differ by colour alone. A ♡ marks a shift that goes against a nurse's
  preference.
- One sticky **Staffing** row shows ✓ or "N short" for each day, with the per-shift breakdown
  behind a toggle.
- **Generate** builds a full schedule with one of three solvers: Hybrid (the default), SA + LNS,
  or CP-SAT (Google OR-Tools). It offers up to ten options at once, with an estimate of how long
  they will take on your computer. Preview any option on the grid with its changes outlined,
  compare options with the schedule already there (staffing, rule breaks, how nights and
  weekends are spread, quick turnarounds, preferences, overtime, cost), and save the one you
  want. Nothing on the grid changes until you save. **Generate more** carries on with new
  options and says so when none beats the schedule you have.
- An option that leaves floors short names the shifts ("Sat, Oct 10, Night 12: short 1 RN") and
  links to the ranked fixes.
- Regenerating records which shifts it replaced in the audit log.

### Contract and state-law rules
- Rest between shifts, days off after nights, consecutive-shift and weekly-hour limits,
  contracted hours by FTE, credentials and skill mix, coverage floors and patient ratios. Each
  rule can be hard (never broken) or soft (advice the manager can accept), and every setting
  explains what it does and why you would change it.
- Overtime by the day, the week, or the **pay period** (80 hours over a fortnight). **California
  overtime** is paid by the hour at the highest multiplier any rule gives it, including the
  seventh day in a row of a work week.
- **Ratios hold at all times**: the charge nurse counts toward the ratio only while caring for
  patients (CA and OR), and break relief is added to the count. Staffing needs shows how each
  count is made up. **Licensed (RN + LVN) ratios** can be pooled with a minimum RN share.
- **New grads and orientees**: a new grad works with an experienced RN on the shift (an LVN or
  nursing assistant does not count), and an orientee works only alongside their preceptor
  (Roster › Orientation).
- **Shifts that run inside another** (a mid or short shift, like an 8 inside a day 12) are covered
  by it, hour by hour, and work under its charge nurse.
- **No mandatory overtime** (NY, WA, OR, MA): Roster › Overtime volunteers records offers, and an
  optional rule refuses an overtime shift without one or an `Emergency:` note.
- **Weekend pattern**: every other weekend, with an optional cap per schedule.
- **Holidays**: major and minor holidays with their own premiums, a fair rotation (whoever worked
  a holiday last year is steered off it this year, and a minor holiday can be paired with a major
  one so nobody works both), and **Add a year of holidays** to roll the list forward.
- **Kept apart**: Roster › Kept apart groups nurses who should not work the same hours (a clash,
  an HR investigation), with how many may be on at once and a minimum of other staff whenever
  they overlap. The reason is audited and never appears on the schedule or in exports.
- **State law presets** for CA, OR, NY, WA and MA, each value citing the provision behind it.
  Applying one only tightens settings. Settings › About and the README list what 1.0 does not
  enforce yet.
- **Posting lead time**: publishing later than "N days ahead" warns, and the Dashboard says when
  the next schedule is due.
- **Credentials**: expiries are checked at publish with a 30-day look-ahead, and lapsed ones show
  on the Dashboard.

### Requests, leave and bidding
- Time-off and shift-exchange requests, judged by whether the unit can spare the nurse on those
  days. **Approve and cover** ranks nurses who can legally take each freed shift and does the
  approval, the removal and the cover in one step.
- Requests have an optional **deadline**: late requests get a "Late" badge but are never refused.
  Generate avoids days with pending requests.
- Conflicts get ranked resolution options, with policy-driven auto-resolve and a reason on every
  decision.
- **Seniority leave bidding** (Requests › Bid rounds): awards go in seniority order, one per nurse
  per pass, and become approved paid leave. Every denial carries a quotable reason.
- **Leave balances and FMLA**: requests warn when they exceed the balance and show FMLA hours left
  in the rolling year. Warnings never block a request.
- Paid leave counts toward contracted hours in whole shifts, so a week off no longer leaves a
  nurse "short".

### Today (the day-of console)
- **Someone called off** is the first action: pick the nurse, report, and see ranked replacements,
  with overtime volunteers called first.
- **Low census**: "Census dropped — N more than needed" with the unit's cancellation order
  (volunteers, agency, overtime, per diem, then a rotation). The charge nurse is never sent home.
- Record missed meal and rest breaks, call-backs and nurses sent home; the Dashboard shows
  "Day-of pay" beside the schedule's cost.

### Roster, staffing needs, fairness and cost
- Roster with CSV import and export, credentials, preferences, seniority and FTE. **Float pool**
  members can be scheduled here, and their shifts on other units count for rest and hours.
- **Export record…** on a nurse gives a CSV or PDF for a grievance. HR and medical (FMLA) entries
  never leave the app this way.
- **Staffing needs**: coverage floors, acuity tiers and ratios, HPPD and a census forecast, with
  the acuity-based staff per shift shown beside HPPD.
- **Fairness** scores nights, weekends, holidays, on-call and denied requests per nurse, and lists
  the actual shifts behind each score. **Show on schedule** jumps to that nurse's row.
- **Cost**: pay rates, differentials, overtime and budget against actual, with a running cost
  strip while you edit.

### Publishing, backups and the app
- Versioned publishing with a change log, compliance alerts, and PDF, CSV and xlsx exports.
  Publish says plainly that ShiftNurse does not send the schedule to anyone.
- **Backups**: daily and on publish, written safely and integrity-checked. Restore refuses a
  damaged backup or one from a newer version before touching anything. Deleted backups wait 30
  days in a trash. An upgrade backs up the database before changing it.
- A guided setup, three demo units to explore (including a VA unit with six 12s and an 8 per pay
  period), and a Dashboard listing what is still missing.
- Settings are grouped as My unit, Contract & pay, Scheduling and Data, and warn before you leave
  unsaved changes. Navigation follows the day: Dashboard, Today, Requests, Schedule, Roster,
  Fairness, Staffing needs, Settings.
- Fits small and scaled screens: the window can shrink to 840×440, and short windows hide
  explanations, never actions or data.
- A notice when a newer release is on GitHub (one request to api.github.com per launch), logs
  under Settings › About › Open logs folder, and plain-language errors instead of silent
  failures.

### Security
- Every request from the window to the app's data is checked against a strict schema, and only
  the app's own page can make one. Dropping a file on the window cannot load it inside the app.
- The audit log is append-only in the database file itself.
- Spreadsheet exports cannot carry formulas (CSV injection).
- drizzle-orm 0.45.3 (GHSA-gpj5-g38j-94v9).

[Unreleased]: https://github.com/patrickgods1/ShiftNurse/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/patrickgods1/ShiftNurse/releases/tag/v0.1.0
