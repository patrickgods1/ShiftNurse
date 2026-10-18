# packages/db

> Loaded automatically when Claude works on files under this folder. Cross-cutting rules live in the root `CLAUDE.md`. Demo and scenario data: `src/seed/CLAUDE.md`.

## What is here

- `packages/db` (M2, complete): 49-table Drizzle schema, generated migrations, `client.ts`
  (WAL, foreign keys ON, `transact`), `audit.ts`, `mappers.ts`, and repositories under
  `repositories/` — `roster`, `config` (unit, shift types, coverage, holidays, credential
  requirements), `acuity` (tiers, ratios, HPPD), `rulesets`, `schedule`, `timeoff`, `calloffs`,
  `pay` (rates, differentials, overtime, budget), `ledger`, `incompatibility` (groups of nurses
  kept apart, migration 0011), shared `patch` (`patchOf`) and `bulk`
  (`insertRows`), `publish` (M12:
  `publishSchedule` writes a `schedule_version` + status + ledger; `requireChangeReason` /
  `recordScheduleChange` are the post-publish change log; M15: `solver` (the per-unit
  `solver_settings`) and `solve-input` (`loadPeriodInput`, the one definition of a period's
  `SolveInput`, shared by Generate, conflicts, cost, grid validation and the solver benchmark)).

## Conventions

- **`PublishInput.hardViolations` is the caller's in-transaction count of hard rule breaks.** Above zero `publishSchedule` refuses without a reason and records `{ count, codes }` in the strict `schedule_version` audit; omitted (seeds, repo callers) records nothing new.
- **Pay settings carry `holidayPayCoversOvertime` (migration 0036, nullable, null reads false)
  and `reportingPayNoticeHours` (migration 0037, nullable, null reads 2; saves refuse outside 0–24).**
  `paySettingsSaved` says whether a unit has a row at all: `applyJurisdiction` offers the preset's
  pay settings (and a wider weekend) only to a unit that saved none, since a saved row may follow a
  contract the preset cannot see.

- **Write the change, then its audit row; check a required reason first.** Audit-first only under
  `ShiftNurseTx`, where the whole call rolls back together (`audit.ts` header).
- **`better-sqlite3` is synchronous.** No `async`/`await`/`Promise` in `packages/db`.
- **Repository patches go through `patchOf` with a `PatchKeys<Patch>` allow-list**
  (`db/src/repositories/patch.ts`). IPC payloads are typed, not checked, so spreading a patch
  into a row once let `{ unitId }` move a nurse between units and `{ date }` move a locked
  shift. An unknown key throws. An assignment's date, shift and nurse change only by a move;
  `AssignmentPatch` carries flags and notes, and IPC creates are always `source: 'manual'`.
- **Moving a shift is delete + create in one `transact`.** `nurseId` is immutable on an
  assignment; the move carries `isCharge`/`isOvertime`/`notes` across and refuses locked rows
  and a shift with a recorded holdover (the minutes belong to that nurse and day; `approveSwap`
  refuses the same way).
  Every create (and so every move, cover, backfill, resolution and Generate save) refuses a date
  outside the period, a non-date, or another unit's shift type.
- **`call_off` carries the shift (period/nurse/shift type/date) and no FK on `assignmentId`.** A
  backfill deletes the absent nurse's row and writes a `source: 'callout'` one, so the call-off and
  its call log must outlive the id they point at — the same reason `shift_swap` has no assignment
  FK. Migration 0005 rebuilds `call_attempt` before dropping `call_off`: the drizzle migrator runs a
  file inside one transaction, where `PRAGMA foreign_keys=OFF` is a no-op and a parent drop
  cascades into its children.
- **The ledger's `periodId` has no foreign key on purpose:** imported history uses synthetic
  `import:<start>` ids for pay periods that predate the app. A historical re-import's audit row
  holds the replaced and written rows in full.
- **Hours worked are `workedShiftsForNurseInRange`** (`repositories/worked-hours.ts`): published
  or archived periods' shifts on any unit, at each shift type's own `durationHours`, standby
  excluded. A draft is a proposal, not work. `listAssignmentsForNurseInRange` returns drafts too,
  for approve-and-lift; never sum hours worked from it.
- **The lookback tail is published and archived periods only** (`PRIOR_ASSIGNMENT_LOOKBACK_DAYS`).
  `historyFromFor` says how far that tail is complete; the contracted-hours rule judges a pay
  period that began before the period only from there.
- **`periodTailFor` is the one loader of a period's tail**, for `loadPeriodInput` and main's
  `scheduleViewFor` alike: the unit's own earlier shifts (real types), its published or archived
  shifts of another period dated inside this one, and other units' shifts (any status), the last
  two as core's `busyElsewhere` locked rows on inactive `elsewhere:` types. The unit's own earlier
  shifts that were floated off are swapped in place for core's `floatedOff` copies on inactive
  `floated:` types. Same-unit drafts stay out; nothing it returns is added to the period's own
  `assignments`.
- **A published period is editable, with a reason.** Only `archived` is read-only. Every
  schedule mutation takes an optional `reason`; `requireChangeReason` throws on a published
  period without one and `editSchedule` in main writes each touched shift to `schedule_change`.
  A republish needs a reason and refuses an unchanged schedule. The diff is keyed on
  nurse/date/shift, never row ids, so a regenerate that lands the same shifts is "no change".
  Status changes only through `publishSchedule` and `archivePeriod` (published → archived, strict
  reason). There is no other publish path; the seeds publish history through `publishSchedule`,
  so every published period has a version.
  A publish that books a ledger books it whole: rows for nurses no longer on the period are
  deleted, audited with `before` (an omitted `ledger` touches nothing).
- **A nurse's record leaves the app without HR or medical matters.** The grievance export
  (`repositories/nurse-record.ts`, Roster › nurse › Export record…) carries every audit entry
  about a nurse — time, action, actor, reason, never the before/after snapshots — and their
  published-shift changes (entries are found by `nurseId`, `requestingNurseId`,
  `counterpartyNurseId`, `orienteeId`, `preceptorId` or a `nurseIds` array, so a snapshot about a
  nurse must carry one of them), but `RECORD_EXCLUDED_ENTITIES` keeps kept-apart groups, FMLA
  certifications and accommodations (`availability_block`) out, and every record's footer says so whether or not the nurse has either.
  Two tripwires guard this: `nurse-record.completeness.test.ts` fails when a new audited entity type is unclassified or when a new column points at a nurse under a key the record does not look for, and `nurse-record.entries.test.ts` fails when a nurse-scoped type's entry, written by its real repository function, does not reach the record.
- **Saved cancellation orders gain `"float"` after `"agency"`** (migration 0038, data only;
  after `"volunteer"` where there is no agency tier, else first). A float on the unit that day can
  be recorded as sent home: `recordShiftCancellation` checks `requireWorksOnUnit`.
- **`perNurseRecordsFor` is the one source of person-scoped records** (credentials, preferences,
  leave, sick pay, rest waivers, accommodations, per-nurse pay rates) for `loadPeriodInput`,
  `costContext` and alerts: each list is this unit's rows in today's order, then what the roster
  brings from other units appended, so a unit nobody floats to reads exactly as before. The
  `satisfies Record<keyof SolveInput, Scope>` test in `solve-input.test.ts` makes a new
  `SolveInput` field a compile error until it is classified person, recorded-here, unit or roster.
- **One membership predicate.** `nurseWorksOnUnit`/`requireWorksOnUnit` (`nurse-units.ts`): home
  unit, or a float membership covering the dates. Every validator that asks 'does this nurse work
  here' uses it. Accommodations stay on the home unit and apply everywhere.
- **A floated shift stays (migration 0039, `assignment.floated_to`).** `markFloatedOff` locks and
  marks it, `updateAssignment` refuses to unlock it, and loaders turn it into busy time for
  judging (`splitFloatedOff`, `periodTailFor`): it never reaches `SolveInput.assignments`, and
  Generate keeps it as a locked row. Floats deleted before this change are not reconstructed.
- **The home unit is `unit.is_home`** (migration 0040; backfilled from the first-inserted unit; a
  partial unique index allows one). `getHomeUnit` is what the app opens; `listUnits` stays
  alphabetical for pickers.
- **A holdover is recorded on a published shift, never a draft.** `recordHoldover`
  (`repositories/holdovers.ts`, migration 0029: `assignment.holdover_minutes`, default 0, and
  `holdover_mandated`) refuses drafts and standby, takes whole minutes 0–720 (0 clears, and a clear
  is never "required"), refuses minutes that run into the nurse's own next worked shift on any unit
  (a holdover there is double-counted time), and audits with `before`; a required one goes through
  `recordAuditStrict`. Audited with the shift's `nurseId`, `date` and `shiftTypeId` so the nurse's
  record finds it.
  `toAssignment` emits the fields only when minutes > 0, so an untouched row maps as before. Only a
  draft is generated, so the solvers never write over one. The grid offers no Undo for removing a
  held-over shift.
- **A time-off request moves only along `TIME_OFF_TRANSITIONS`** (approve from pending or denied;
  deny and cancel from pending; withdraw from approved, strict reason); every writer checks it first.
- **Approve-and-lift reads from the day before the leave** and lifts (draft) or reports (published)
  the night dated then only if that period's own rule set has the time-off rule on with
  `nightShiftEndingOnLeaveCounts`, judged by core's `overlappingLeaveDate` (window, not `isNight`).
