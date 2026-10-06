# Changelog

What changed for people running ShiftNurse, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the `vX.Y.Z` release
tags. Each release's notes link here.

## [Unreleased]

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
